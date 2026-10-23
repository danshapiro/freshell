//! Name-reliability Task 3: behavior tests for legacy-name imports after the
//! one-time consolidation, and for import-owned labels in bind collisions.
//!
//! Every test drives the REAL `SessionNames` store on a temp data dir through
//! its public transaction methods; the migration is completed through
//! `complete_legacy_migration`, exactly as the boot consolidation runner
//! completes it. The on-disk document is read back to prove what was (not)
//! written.

use std::path::Path;
use std::sync::Arc;

use freshell_freshagent::naming::{BindNameInput, PendingNameInput, SessionNaming};
use freshell_protocol::native_location::{
    NativeAcquisition, NativeEvidenceKind, NativeLocation, NativePersistence,
};
use freshell_protocol::session_names::{
    LegacyCandidateScope, LegacyEvidenceEnvelope, LegacyNameCandidate, LegacyNameImport,
    LegacyNameTarget, LegacyProtectionEvidence, NameSource, NamedProvider, SessionNameRef,
    SessionNameUpdate,
};
use serde_json::json;

use crate::session_name_generation::IndexedNameInput;
use crate::session_names::{
    name_ref_key, test_store_transaction_count, SessionNames, StoredDocument, DOCUMENT_FILE_NAME,
    NAME_MIGRATION_BOOT_IMPORT_ID, NAME_MIGRATION_DIR_NAME, NAME_MIGRATION_IMPORTS_DIR_NAME,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn open_store(dir: &Path) -> Arc<SessionNames> {
    SessionNames::open(dir.to_path_buf()).expect("store opens")
}

fn claude_session(id: &str) -> SessionNameRef {
    SessionNameRef::Session {
        provider: NamedProvider::Claude,
        session_id: id.to_string(),
    }
}

fn read_document(dir: &Path) -> StoredDocument {
    let bytes = std::fs::read(dir.join(DOCUMENT_FILE_NAME)).expect("document exists");
    serde_json::from_slice(&bytes).expect("document parses")
}

fn generation(dir: &Path) -> u64 {
    read_document(dir).document_generation
}

fn acknowledged_ids(dir: &Path) -> Vec<String> {
    read_document(dir).migration.acknowledged_candidate_ids
}

/// The number of per-import backup files the import path wrote.
fn import_backup_count(dir: &Path) -> usize {
    let imports = dir
        .join(NAME_MIGRATION_DIR_NAME)
        .join(NAME_MIGRATION_IMPORTS_DIR_NAME);
    std::fs::read_dir(imports)
        .map(|entries| entries.filter_map(Result::ok).count())
        .unwrap_or(0)
}

async fn record_of(names: &SessionNames, target: SessionNameRef) -> Option<SessionNameUpdate> {
    names
        .get(vec![target])
        .await
        .expect("get succeeds")
        .into_iter()
        .next()
}

/// A session record created by the normal flows: the sweep's index
/// hydration. `cwd` only → a `directory` record; a first message → a
/// `first_message` record.
async fn hydrate(
    names: &SessionNames,
    session_id: &str,
    cwd: Option<&str>,
    first_user_message: Option<&str>,
) -> SessionNameUpdate {
    names
        .hydrate_indexed(
            IndexedNameInput {
                provider: NamedProvider::Claude,
                session_id: session_id.to_string(),
                cwd: cwd.map(str::to_string),
                first_user_message: first_user_message.map(str::to_string),
                provider_title: None,
            },
            false,
        )
        .await
        .expect("hydrate succeeds")
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

/// An automatic `source_tab` label from one browser window's layout.
fn window_tab_label(id: &str, session_id: &str, name: &str, window: &str) -> LegacyNameCandidate {
    candidate(
        id,
        LegacyNameTarget::Canonical(claude_session(session_id)),
        name,
        NameSource::ProviderAi,
        LegacyCandidateScope::SourceTab,
        &format!("freshell.layout.v3.{window}#tab-1"),
        LegacyProtectionEvidence::None,
    )
}

/// A browser-shaped import (the untrusted HTTP lane) from one window.
fn browser_import(import_id: &str, candidates: Vec<LegacyNameCandidate>) -> LegacyNameImport {
    LegacyNameImport {
        version: 1,
        import_id: import_id.to_string(),
        evidence: vec![LegacyEvidenceEnvelope {
            storage_key: format!("freshell.layout.v3.window-{import_id}"),
            raw: json!({ "version": 4, "tabs": { "tabs": [] }, "panes": {} }).to_string(),
        }],
        candidates,
    }
}

fn verified_claude_acquisition() -> NativeAcquisition {
    NativeAcquisition {
        location: NativeLocation::Claude {
            config_root: "/w/homes/claude".to_string(),
            transcript_path: Some("/w/homes/claude/projects/R/x.jsonl".to_string()),
            project_directory_key: Some("R".to_string()),
            transcript_cwd: Some("/w/work".to_string()),
            effective_project_key_override: None,
        },
        evidence: NativeEvidenceKind::SelectedTranscript,
        persistence: NativePersistence::Verified,
    }
}

/// One import through the trusted boot lane (the consolidation runner's
/// reserved import id), before completion.
async fn boot_import(names: &SessionNames, candidates: Vec<LegacyNameCandidate>) {
    names
        .import_legacy(LegacyNameImport {
            version: 1,
            import_id: NAME_MIGRATION_BOOT_IMPORT_ID.to_string(),
            evidence: vec![],
            candidates,
        })
        .await
        .expect("boot import succeeds");
}

/// A boot-lane source-tab label for `session:claude:<session_id>`.
fn boot_session_label(
    id: &str,
    session_id: &str,
    name: &str,
    source: NameSource,
    protection: LegacyProtectionEvidence,
) -> LegacyNameCandidate {
    candidate(
        id,
        LegacyNameTarget::Canonical(claude_session(session_id)),
        name,
        source,
        LegacyCandidateScope::SourceTab,
        &format!("tabs-registry:device-1:claude:{session_id}:source-tab"),
        protection,
    )
}

/// Before completion, the trusted boot lane installs `name` on
/// `session:claude:<session_id>` (an import-owned record) with the source
/// the boot lane classifies `source` + `protection` as (`installed_as`),
/// then the consolidation completes.
async fn boot_install_as_then_complete(
    names: &SessionNames,
    session_id: &str,
    name: &str,
    (source, protection): (NameSource, LegacyProtectionEvidence),
    installed_as: NameSource,
) {
    boot_import(
        names,
        vec![boot_session_label(
            "boot-1", session_id, name, source, protection,
        )],
    )
    .await;
    let installed = record_of(names, claude_session(session_id))
        .await
        .expect("the boot import installed the record");
    assert_eq!(installed.record.name, name);
    assert_eq!(installed.record.source, installed_as);
    names
        .complete_legacy_migration()
        .await
        .expect("completion commits");
}

/// [`boot_install_as_then_complete`] for an automatic `provider_ai` label.
async fn boot_install_then_complete(names: &SessionNames, session_id: &str, name: &str) {
    boot_install_as_then_complete(
        names,
        session_id,
        name,
        (NameSource::ProviderAi, LegacyProtectionEvidence::None),
        NameSource::ProviderAi,
    )
    .await;
}

/// A live pending handle whose create-time name is the folder `work`
/// (`directory` rank), bound to `session:claude:<session_id>`.
async fn bind_work_pending_to(names: &SessionNames, handle: &str, session_id: &str) {
    let pending = names
        .ensure_pending(PendingNameInput {
            handle: handle.to_string(),
            provider: NamedProvider::Claude,
            cwd: Some("/w/work".to_string()),
        })
        .await
        .expect("ensure pending");
    assert_eq!(pending.record.name, "work");
    assert_eq!(pending.record.source, NameSource::Directory);
    names
        .bind_pending(BindNameInput {
            pending: SessionNameRef::Pending {
                id: handle.to_string(),
            },
            target: claude_session(session_id),
            acquisition: verified_claude_acquisition(),
        })
        .await
        .expect("bind succeeds");
}

fn collision_losers(dir: &Path) -> Vec<(String, String)> {
    read_document(dir)
        .recovery
        .values()
        .filter(|entry| entry.reason == "bind_collision_loser")
        .map(|entry| (entry.record.name.clone(), entry.reason.clone()))
        .collect()
}

// ---------------------------------------------------------------------------
// Post-completion imports: acknowledge, write nothing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn post_completion_import_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let existing = hydrate(&names, "existing", Some("/w/work"), None).await;
    assert_eq!(existing.record.name, "work");
    assert_eq!(existing.record.source, NameSource::Directory);
    names.complete_legacy_migration().await.unwrap();
    let generation_before = generation(dir.path());

    let derived_handle = json!([
        "legacy-pending",
        "freshell.layout.v3.layout-window-a",
        "layout-window-a",
        "pane-1",
        "req-1"
    ])
    .to_string();
    let candidates = vec![
        window_tab_label("c-existing", "existing", "Tab 4", "layout-window-a"),
        window_tab_label("c-new", "no-record", "Billing bug", "layout-window-a"),
        candidate(
            "c-pending",
            LegacyNameTarget::Canonical(SessionNameRef::Pending {
                id: "pending-canonical".into(),
            }),
            "Pending Label",
            NameSource::ProviderAi,
            LegacyCandidateScope::Pane,
            "freshell.layout.v3.layout-window-a#tab-1#pane-2",
            LegacyProtectionEvidence::None,
        ),
        candidate(
            "c-derived",
            LegacyNameTarget::Canonical(SessionNameRef::Pending {
                id: derived_handle.clone(),
            }),
            "Derived Pending Label",
            NameSource::ProviderAi,
            LegacyCandidateScope::Pane,
            "freshell.layout.v3.layout-window-a#tab-1#pane-1",
            LegacyProtectionEvidence::None,
        ),
    ];
    let result = names
        .import_legacy(browser_import("after-completion", candidates))
        .await
        .expect("a post-completion import is acknowledged");

    assert_eq!(
        result.acknowledged,
        vec!["c-existing", "c-new", "c-pending", "c-derived"],
        "every candidate id is acknowledged"
    );
    assert!(result.names.is_empty(), "no record was touched");
    let after = record_of(&names, claude_session("existing")).await.unwrap();
    assert_eq!(after.record.name, "work");
    assert_eq!(after.record.source, NameSource::Directory);
    assert_eq!(after.record.revision, existing.record.revision);
    assert!(
        record_of(&names, claude_session("no-record"))
            .await
            .is_none(),
        "no record is created for a session without one"
    );
    for id in ["pending-canonical".to_string(), derived_handle] {
        assert!(
            record_of(&names, SessionNameRef::Pending { id: id.clone() })
                .await
                .is_none(),
            "no orphan pending record is minted for {id}"
        );
    }
    assert_eq!(
        generation(dir.path()),
        generation_before,
        "the document generation does not move"
    );
    assert_eq!(import_backup_count(dir.path()), 0, "no backup file");
}

#[tokio::test]
async fn post_completion_reimport_stores_no_candidate_ids() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    // A pre-completion import leaves bookkeeping behind (older binaries'
    // idempotency gate), which must stay exactly as it is.
    names
        .import_legacy(browser_import(
            "before-completion",
            vec![window_tab_label("c-early", "early", "Early Label", "w0")],
        ))
        .await
        .unwrap();
    names.complete_legacy_migration().await.unwrap();
    let generation_before = generation(dir.path());
    let acknowledged_before = acknowledged_ids(dir.path());
    assert_eq!(acknowledged_before, vec!["c-early".to_string()]);

    let late = browser_import(
        "old-client-window",
        vec![
            window_tab_label("c-late-1", "early", "Tab 23", "w1"),
            window_tab_label("c-late-2", "other", "ms-people-summit", "w1"),
        ],
    );
    for round in 0..3 {
        let result = names.import_legacy(late.clone()).await.unwrap();
        assert_eq!(result.acknowledged, vec!["c-late-1", "c-late-2"]);
        assert_eq!(
            generation(dir.path()),
            generation_before,
            "round {round}: no document write"
        );
        assert_eq!(
            acknowledged_ids(dir.path()),
            acknowledged_before,
            "round {round}: no candidate id is stored"
        );
    }
    assert_eq!(
        import_backup_count(dir.path()),
        1,
        "only the pre-completion import wrote a backup"
    );
}

#[tokio::test]
async fn post_completion_import_never_raises_rank() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let existing = hydrate(
        &names,
        "s1",
        Some("/w/work"),
        Some("fix the login redirect"),
    )
    .await;
    assert_eq!(existing.record.source, NameSource::FirstMessage);
    names.complete_legacy_migration().await.unwrap();

    let result = names
        .import_legacy(browser_import(
            "flagged-late",
            vec![candidate(
                "c-flag",
                LegacyNameTarget::Canonical(claude_session("s1")),
                "Old Flagged Pane Label",
                NameSource::LegacyProtected,
                LegacyCandidateScope::Pane,
                "freshell.layout.v3.w1#tab-1#pane-1",
                LegacyProtectionEvidence::LegacyFlag,
            )],
        ))
        .await
        .unwrap();
    assert_eq!(result.acknowledged, vec!["c-flag"]);
    let after = record_of(&names, claude_session("s1")).await.unwrap();
    assert_eq!(after.record.name, existing.record.name);
    assert_eq!(after.record.source, NameSource::FirstMessage);
    assert_eq!(after.record.revision, existing.record.revision);
}

#[tokio::test]
async fn post_completion_import_logs_once_per_import_id() {
    let events = crate::test_trace_capture::captured_trace_events();
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    names.complete_legacy_migration().await.unwrap();
    let import_id = format!("log-once-{}", uuid::Uuid::new_v4());
    let other_id = format!("log-other-{}", uuid::Uuid::new_v4());

    let import = browser_import(
        &import_id,
        vec![
            window_tab_label("c-a", "s1", "Tab 4", "w1"),
            window_tab_label("c-b", "s2", "Tab 5", "w1"),
        ],
    );
    names.import_legacy(import.clone()).await.unwrap();
    names.import_legacy(import).await.unwrap();
    names
        .import_legacy(browser_import(
            &other_id,
            vec![window_tab_label("c-c", "s3", "Tab 6", "w2")],
        ))
        .await
        .unwrap();

    let ignored_for = |id: &str| {
        events
            .snapshot()
            .into_iter()
            .filter(|event| {
                event.level == tracing::Level::INFO
                    && event.message == "session_names.import_ignored_after_completion"
                    && event.fields.get("import_id").map(String::as_str) == Some(id)
            })
            .collect::<Vec<_>>()
    };
    let mine = ignored_for(&import_id);
    assert_eq!(mine.len(), 1, "one INFO line per import id: {mine:?}");
    assert_eq!(
        mine[0].fields.get("candidates").map(String::as_str),
        Some("2")
    );
    assert_eq!(
        ignored_for(&other_id).len(),
        1,
        "a different import id gets its own line"
    );
}

/// Old clients keep sending imports until they reload, each one against a
/// multi-megabyte document: once this store knows the consolidation is
/// complete (`completed` never reverts), it answers without taking the
/// document lock or re-reading the document. Envelope validation still
/// applies.
#[tokio::test]
async fn post_completion_import_takes_no_store_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    names.complete_legacy_migration().await.unwrap();
    let before = test_store_transaction_count(dir.path());

    let result = names
        .import_legacy(browser_import(
            "no-transaction",
            vec![window_tab_label("c-1", "s1", "Tab 4", "w1")],
        ))
        .await
        .unwrap();
    assert_eq!(result.acknowledged, vec!["c-1"]);
    let mut unsupported = browser_import("bad-version", vec![]);
    unsupported.version = 2;
    assert!(
        names.import_legacy(unsupported).await.is_err(),
        "an unsupported envelope is still refused"
    );
    let unnamed = browser_import(
        "blank-candidate-id",
        vec![window_tab_label(" ", "s1", "Tab 4", "w1")],
    );
    assert!(
        names.import_legacy(unnamed).await.is_err(),
        "a candidate without its stable id is still refused"
    );
    assert_eq!(
        test_store_transaction_count(dir.path()),
        before,
        "no store transaction ran"
    );
}

/// Pinning test: a store whose view predates the completion (another
/// process committed it) still writes nothing — the transaction re-reads
/// the document and the decision sees the receipt.
#[tokio::test]
async fn a_stale_view_still_writes_nothing_after_another_process_completed() {
    let dir = tempfile::tempdir().unwrap();
    let stale = open_store(dir.path());
    let completer = open_store(dir.path());
    completer.complete_legacy_migration().await.unwrap();
    assert!(
        !stale.migration_completed(),
        "the first store has not adopted the completion yet"
    );
    let generation_before = generation(dir.path());

    let result = stale
        .import_legacy(browser_import(
            "stale-view",
            vec![window_tab_label("c-1", "s1", "Tab 4", "w1")],
        ))
        .await
        .unwrap();
    assert_eq!(result.acknowledged, vec!["c-1"]);
    assert!(result.names.is_empty());
    assert!(record_of(&stale, claude_session("s1")).await.is_none());
    assert_eq!(generation(dir.path()), generation_before);
    assert!(acknowledged_ids(dir.path()).is_empty());
    assert_eq!(import_backup_count(dir.path()), 0);
}

// ---------------------------------------------------------------------------
// Bind collisions with import-owned records
// ---------------------------------------------------------------------------

#[tokio::test]
async fn import_owned_default_label_loses_a_bind_collision() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    boot_install_then_complete(&names, "X", "Tab 4").await;

    bind_work_pending_to(&names, "P", "X").await;

    let bound = record_of(&names, claude_session("X")).await.unwrap();
    assert_eq!(bound.record.name, "work", "the live pending name wins");
    assert_eq!(bound.record.source, NameSource::Directory);
    assert_eq!(
        collision_losers(dir.path()),
        vec![("Tab 4".to_string(), "bind_collision_loser".to_string())],
        "the import-owned default label is retained in recovery"
    );
}

/// Pinning test: an import-owned name that is not a recognizable default
/// label keeps today's rank rule (`provider_ai` outranks the pending
/// `directory` record).
#[tokio::test]
async fn import_owned_real_label_keeps_the_rank_rule() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    boot_install_then_complete(&names, "X", "ms-people-summit").await;

    bind_work_pending_to(&names, "P", "X").await;

    let bound = record_of(&names, claude_session("X")).await.unwrap();
    assert_eq!(bound.record.name, "ms-people-summit");
    assert_eq!(bound.record.source, NameSource::ProviderAi);
    assert_eq!(
        collision_losers(dir.path()),
        vec![("work".to_string(), "bind_collision_loser".to_string())],
    );
}

/// Pinning test: only an automatic import-owned label gives way. A
/// protected import-owned "Tab 4" — a legacy-flagged label, a proven
/// explicit rename, an accepted Freshell AI name — keeps the rank rule, so
/// a bind never demotes a name a person may have typed.
#[tokio::test]
async fn import_owned_protected_default_label_keeps_the_rank_rule() {
    for (evidence, installed_as) in [
        (
            (
                NameSource::LegacyProtected,
                LegacyProtectionEvidence::LegacyFlag,
            ),
            NameSource::LegacyProtected,
        ),
        (
            (NameSource::Manual, LegacyProtectionEvidence::ExplicitRename),
            NameSource::Manual,
        ),
        (
            (NameSource::FreshellAi, LegacyProtectionEvidence::None),
            NameSource::FreshellAi,
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let names = open_store(dir.path());
        boot_install_as_then_complete(&names, "X", "Tab 4", evidence, installed_as).await;

        bind_work_pending_to(&names, "P", "X").await;

        let bound = record_of(&names, claude_session("X")).await.unwrap();
        assert_eq!(
            bound.record.name, "Tab 4",
            "{installed_as:?}: the protected label stays"
        );
        assert_eq!(bound.record.source, installed_as);
        assert_eq!(
            collision_losers(dir.path()),
            vec![("work".to_string(), "bind_collision_loser".to_string())],
            "{installed_as:?}: the pending name is the retained loser"
        );
    }
}

/// Pinning test: the rule covers only a record still at the revision the
/// migration installed. The boot consolidation labels both a pane's pending
/// handle and its session "Tab 4"; the pane binds, so the session record
/// carries the pane's "Tab 4" at a revision past its install. A later
/// pending "work" bound to the same session meets the rank rule:
/// `provider_ai` outranks `directory`.
#[tokio::test]
async fn a_default_label_moved_past_its_install_keeps_the_rank_rule() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    boot_import(
        &names,
        vec![
            boot_session_label(
                "boot-session",
                "X",
                "Tab 4",
                NameSource::ProviderAi,
                LegacyProtectionEvidence::None,
            ),
            candidate(
                "boot-pane",
                LegacyNameTarget::Canonical(SessionNameRef::Pending { id: "P1".into() }),
                "Tab 4",
                NameSource::ProviderAi,
                LegacyCandidateScope::Pane,
                "tabs-registry:device-1:tab-1:pane-1",
                LegacyProtectionEvidence::None,
            ),
        ],
    )
    .await;
    names.complete_legacy_migration().await.unwrap();
    names
        .bind_pending(BindNameInput {
            pending: SessionNameRef::Pending { id: "P1".into() },
            target: claude_session("X"),
            acquisition: verified_claude_acquisition(),
        })
        .await
        .expect("the pane binds");

    let key = name_ref_key(&claude_session("X"));
    let document = read_document(dir.path());
    let moved = document.record_at(&key).expect("the session record exists");
    assert_eq!(moved.name, "Tab 4");
    assert_eq!(moved.source, NameSource::ProviderAi);
    let installed = document
        .migration
        .winning_evidence
        .get(&key)
        .expect("the migration's winning evidence is retained")
        .installed_revision;
    assert!(
        moved.revision > installed,
        "the record moved past its installed revision ({} vs {installed})",
        moved.revision
    );
    let work_lost = |dir: &Path| {
        collision_losers(dir)
            .iter()
            .filter(|(name, _)| name == "work")
            .count()
    };
    assert_eq!(work_lost(dir.path()), 0);

    bind_work_pending_to(&names, "P2", "X").await;

    let bound = record_of(&names, claude_session("X")).await.unwrap();
    assert_eq!(bound.record.name, "Tab 4", "the rank rule keeps the label");
    assert_eq!(bound.record.source, NameSource::ProviderAi);
    assert_eq!(
        work_lost(dir.path()),
        1,
        "the pending name is the retained loser"
    );
}

/// The import-owned label's loss is logged once the bind commits, as the
/// name-change event of the session's record (name-reliability Task 12): a
/// bind collision that healed a junk label, with the sources spelled the way
/// the stored document, the wire and the other naming logs do
/// (`provider_ai`, `directory`), so a log search for a source finds it.
#[tokio::test]
async fn bind_collision_log_spells_sources_as_the_wire_does() {
    let events = crate::test_trace_capture::captured_trace_events();
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let session_id = format!("log-{}", uuid::Uuid::new_v4());
    boot_install_then_complete(&names, &session_id, "Tab 4").await;

    bind_work_pending_to(&names, "P", &session_id).await;

    let key = name_ref_key(&claude_session(&session_id));
    let lines: Vec<_> = events
        .snapshot()
        .into_iter()
        .filter(|event| {
            event.message == "session_names.name_changed"
                && event.fields.get("name_ref") == Some(&key)
                && event.fields.get("cause").map(String::as_str) == Some("bind_collision")
        })
        .collect();
    assert_eq!(lines.len(), 1, "one bind-collision change: {lines:?}");
    let line = &lines[0];
    assert_eq!(line.level, tracing::Level::INFO);
    let field = |name: &str| line.fields.get(name).map(String::as_str);
    assert_eq!(field("old_name"), Some("Tab 4"));
    assert_eq!(field("old_source"), Some("provider_ai"));
    assert_eq!(field("new_name"), Some("work"));
    assert_eq!(field("new_source"), Some("directory"));
    assert_eq!(field("self_heal"), Some("true"));
    assert_eq!(
        field("from_ref"),
        Some(
            name_ref_key(&SessionNameRef::Pending {
                id: "P".to_string()
            })
            .as_str()
        )
    );
}

// ---------------------------------------------------------------------------
// Pre-completion tie-break: window ids never decide a name
// ---------------------------------------------------------------------------

/// Pinning test for the pre-completion path: an equal-rank, equal-scope
/// candidate from another window never replaces the installed record,
/// whichever window's spelling sorts first.
#[tokio::test]
async fn equal_rank_boot_candidates_keep_the_incumbent() {
    for (first, second) in [("pii4k2", "mn0x7"), ("mn0x7", "pii4k2")] {
        let dir = tempfile::tempdir().unwrap();
        let names = open_store(dir.path());
        names
            .import_legacy(browser_import(
                &format!("import-{first}"),
                vec![window_tab_label(
                    &format!("c-{first}"),
                    "s1",
                    &format!("Label from {first}"),
                    first,
                )],
            ))
            .await
            .unwrap();
        let incumbent = record_of(&names, claude_session("s1")).await.unwrap();
        assert_eq!(incumbent.record.name, format!("Label from {first}"));

        let result = names
            .import_legacy(browser_import(
                &format!("import-{second}"),
                vec![window_tab_label(
                    &format!("c-{second}"),
                    "s1",
                    &format!("Label from {second}"),
                    second,
                )],
            ))
            .await
            .unwrap();
        assert_eq!(result.acknowledged, vec![format!("c-{second}")]);
        let after = record_of(&names, claude_session("s1")).await.unwrap();
        assert_eq!(
            after.record.name,
            format!("Label from {first}"),
            "{first} installed first; {second} must not replace it"
        );
        assert_eq!(after.record.revision, incumbent.record.revision);
    }
}

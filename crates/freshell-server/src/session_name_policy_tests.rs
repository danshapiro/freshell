//! Name-reliability Task 4: the native-observation, automation-rename and
//! self-heal rules, driven through the REAL store on a temp data dir (every
//! decision runs the strict transaction path; nothing here is mocked).

use std::path::Path;
use std::sync::Arc;

use freshell_freshagent::naming::{NameActivityReason, NativeNameOrigin};
use freshell_protocol::native_location::{NativeEvidenceKind, NativePersistence};
use freshell_protocol::session_names::{
    NameIntent, NameSource, NamedProvider, RenameOutcome, RenameOutcomeReason,
};

use super::super::*;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn temp_dir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn open(dir: &Path) -> Arc<SessionNames> {
    SessionNames::open(dir.to_path_buf()).expect("open store")
}

fn session(provider: NamedProvider, id: &str) -> SessionNameRef {
    SessionNameRef::Session {
        provider,
        session_id: id.to_string(),
    }
}

fn raw_document(dir: &Path) -> StoredDocument {
    let bytes = std::fs::read(dir.join(DOCUMENT_FILE_NAME)).expect("raw document exists");
    parse_document(&bytes).expect("raw document parses")
}

fn generation(dir: &Path) -> u64 {
    raw_document(dir).document_generation
}

fn indexed(
    provider: NamedProvider,
    id: &str,
    cwd: Option<&str>,
    provider_title: Option<&str>,
    first_message: Option<&str>,
) -> IndexedNameInput {
    IndexedNameInput {
        provider,
        session_id: id.to_string(),
        cwd: cwd.map(str::to_string),
        first_user_message: first_message.map(str::to_string),
        provider_title: provider_title.map(str::to_string),
    }
}

/// Install a session record through the index hydration ladder (the same
/// path the sweep takes): a provider title installs at `provider_ai`, a
/// first message at `first_message`, otherwise the folder at `directory`.
/// `absorb` stores the first message's fingerprint at rest (Idle).
async fn seed(
    store: &Arc<SessionNames>,
    input: IndexedNameInput,
    absorb: bool,
) -> SessionNameUpdate {
    store
        .hydrate_indexed(input, absorb)
        .await
        .expect("seed through hydration")
}

async fn get_one(store: &Arc<SessionNames>, target: &SessionNameRef) -> SessionNameRecord {
    store
        .get(vec![target.clone()])
        .await
        .expect("get")
        .into_iter()
        .next()
        .expect("the record exists")
        .record
}

async fn observe(
    store: &Arc<SessionNames>,
    target: &SessionNameRef,
    title: &str,
    location_revision: NameRevision,
) -> SessionNameUpdate {
    store
        .observe_native(NativeNameObservation {
            target: target.clone(),
            title: title.to_string(),
            origin: NativeNameOrigin::Snapshot,
            location_revision,
            event_id: None,
        })
        .await
        .expect("observation folds")
}

async fn rename(
    store: &Arc<SessionNames>,
    target: &SessionNameRef,
    name: &str,
    intent: NameIntent,
    cwd: Option<&str>,
) -> SessionNameUpdate {
    store
        .rename(RenameNameInput {
            target: target.clone(),
            name: name.to_string(),
            intent,
            if_revision: None,
            cwd: cwd.map(str::to_string),
        })
        .await
        .expect("rename runs")
}

fn activity_input(
    target: &SessionNameRef,
    reason: NameActivityReason,
    message: Option<&str>,
    cwd: Option<&str>,
) -> NameActivity {
    NameActivity {
        target: target.clone(),
        mode: "claude".to_string(),
        event_id: "event-1".to_string(),
        reason,
        first_user_message: message.map(str::to_string),
        cwd: cwd.map(str::to_string),
    }
}

async fn activity(
    store: &Arc<SessionNames>,
    target: &SessionNameRef,
    reason: NameActivityReason,
    message: Option<&str>,
    cwd: Option<&str>,
) -> SessionNameUpdate {
    store
        .activity(activity_input(target, reason, message, cwd))
        .await
        .expect("activity folds")
}

/// A record protected at `source`, named `name`, on a fresh session.
async fn protected_record(
    store: &Arc<SessionNames>,
    id: &str,
    source: NameSource,
    name: &str,
) -> SessionNameRef {
    let target = session(NamedProvider::Claude, id);
    seed(
        store,
        indexed(NamedProvider::Claude, id, Some("/w/proj"), None, None),
        false,
    )
    .await;
    match source {
        NameSource::Manual => {
            rename(store, &target, name, NameIntent::User, None).await;
        }
        other => {
            store
                .offer(target.clone(), name.to_string(), other)
                .await
                .expect("seed the protected record");
        }
    }
    let record = get_one(store, &target).await;
    assert_eq!(record.source, source, "seeded {id} at {source:?}");
    assert_eq!(record.name, name);
    target
}

const SARDINE: &str = "Fix the sardine importer";

// ---------------------------------------------------------------------------
// Native observations
// ---------------------------------------------------------------------------

/// OpenCode's temporary "New session - <ISO>" title is never saved, and is
/// not a baseline either; the real title that follows raises the record.
#[tokio::test]
async fn opencode_placeholder_observation_is_never_stored() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Opencode, "ses_placeholder");
    let seeded = seed(
        &store,
        indexed(
            NamedProvider::Opencode,
            "ses_placeholder",
            Some("/w/proj"),
            None,
            None,
        ),
        false,
    )
    .await;
    assert_eq!(seeded.record.source, NameSource::Directory);
    let generation_before = generation(dir.path());
    let mut published = store.subscribe();

    let placeholder = observe(&store, &target, "New session - 2026-10-20T00:09:25.350Z", 0).await;
    assert!(!placeholder.changed, "a placeholder is never a name");
    assert_eq!(placeholder.record.name, "proj");
    assert_eq!(placeholder.record.revision, seeded.record.revision);
    assert_eq!(
        generation(dir.path()),
        generation_before,
        "no document write"
    );
    assert!(published.try_recv().is_err(), "nothing published");
    assert_eq!(
        store.staged_native_baseline(&target),
        None,
        "a placeholder is never a baseline either"
    );

    let real = observe(&store, &target, "Publishing blocked by token error", 0).await;
    assert!(real.changed);
    assert_eq!(real.record.name, "Publishing blocked by token error");
    assert_eq!(real.record.source, NameSource::ProviderAi);
}

/// Every existing record starts without a baseline: the first observation
/// only records it (staged in memory, no document write, no publish), one
/// sweep maintenance batch persists it, and the next CHANGED title replaces
/// the older provider-level name.
#[tokio::test]
async fn first_native_observation_sets_the_baseline_without_replacing() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-baseline");
    let seeded = seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-baseline",
            Some("/w/proj"),
            Some("Billing bug"),
            None,
        ),
        false,
    )
    .await;
    assert_eq!(seeded.record.source, NameSource::ProviderAi);
    let generation_before = generation(dir.path());
    let mut published = store.subscribe();

    let first = observe(&store, &target, "Older provider title", 0).await;
    assert!(
        !first.changed,
        "the first observation only records the baseline"
    );
    assert_eq!(first.record.name, "Billing bug");
    assert_eq!(first.record.revision, seeded.record.revision);
    assert_eq!(
        generation(dir.path()),
        generation_before,
        "no document write"
    );
    assert!(published.try_recv().is_err(), "nothing published");
    assert_eq!(
        store.staged_native_baseline(&target).as_deref(),
        Some("Older provider title")
    );

    // Decisions read the staged baseline as if it were persisted: the same
    // title again is an echo (still no write).
    let echo = observe(&store, &target, "Older provider title", 0).await;
    assert!(!echo.changed);
    assert_eq!(generation(dir.path()), generation_before);

    // One maintenance batch persists it.
    store
        .sweep_maintenance(Vec::new())
        .await
        .expect("the maintenance batch runs");
    let document = raw_document(dir.path());
    assert_eq!(document.document_generation, generation_before + 1);
    let key = name_ref_key(&target);
    assert_eq!(
        document
            .native_write
            .get(&key)
            .and_then(|state| state.last_native_title.as_deref()),
        Some("Older provider title"),
        "the batch persisted the staged baseline"
    );
    assert_eq!(
        store.staged_native_baseline(&target),
        None,
        "staging cleared"
    );
    assert!(!store.has_staged_native_baselines());

    let newer = observe(&store, &target, "Newer provider title", 0).await;
    assert!(
        newer.changed,
        "a changed native title replaces the older provider name"
    );
    assert_eq!(newer.record.name, "Newer provider title");
    assert_eq!(newer.record.source, NameSource::ProviderAi);
    assert!(newer.record.revision > seeded.record.revision);
}

/// With a baseline, a provider title that actually changed replaces the
/// older provider-level name; the same title again is an echo.
#[tokio::test]
async fn changed_native_title_replaces_older_provider_name() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-changed");
    seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-changed",
            Some("/w/proj"),
            None,
            None,
        ),
        false,
    )
    .await;
    // The raise from `directory` records the baseline with its own commit.
    let raised = observe(&store, &target, "Billing bug", 0).await;
    assert!(raised.changed);
    assert_eq!(raised.record.source, NameSource::ProviderAi);
    let key = name_ref_key(&target);
    assert_eq!(
        raw_document(dir.path())
            .native_write
            .get(&key)
            .and_then(|state| state.last_native_title.as_deref()),
        Some("Billing bug"),
        "the committing raise persisted its baseline"
    );

    let replaced = observe(&store, &target, "Real title", 0).await;
    assert!(replaced.changed);
    assert_eq!(replaced.record.name, "Real title");
    assert!(replaced.record.revision > raised.record.revision);

    let again = observe(&store, &target, "Real title", 0).await;
    assert!(!again.changed);
    assert_eq!(
        again.record.revision, replaced.record.revision,
        "no new revision"
    );
}

/// A junk saved name is replaced by the very first real native title (the
/// self-heal exception to the baseline rule).
#[tokio::test]
async fn first_native_observation_heals_a_default_label() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-tab23");
    seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-tab23",
            Some("/w/proj"),
            Some("Tab 23"),
            None,
        ),
        false,
    )
    .await;
    let healed = observe(&store, &target, "Real title", 0).await;
    assert!(
        healed.changed,
        "a default label gives way to the first real title"
    );
    assert_eq!(healed.record.name, "Real title");
    assert_eq!(healed.record.source, NameSource::ProviderAi);
}

/// An echo of the native title the provider already reported never undoes
/// an automation rename; a genuinely new native title still applies.
#[tokio::test]
async fn native_echo_never_undoes_an_automation_rename() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-echo");
    seed(
        &store,
        indexed(NamedProvider::Claude, "s-echo", Some("/w/proj"), None, None),
        false,
    )
    .await;
    assert!(observe(&store, &target, "A", 0).await.changed);
    let renamed = rename(&store, &target, "B", NameIntent::Automatic, Some("/w/proj")).await;
    assert_eq!(renamed.record.name, "B");
    assert_eq!(
        renamed.outcome,
        Some(RenameOutcome {
            applied: true,
            reason: None
        })
    );
    let echo = observe(&store, &target, "A", 0).await;
    assert!(!echo.changed);
    assert_eq!(echo.record.name, "B", "an echo never undoes the rename");
    let fresh = observe(&store, &target, "C", 0).await;
    assert!(fresh.changed);
    assert_eq!(fresh.record.name, "C");
}

/// Protected names (manual, migration-protected, Freshell AI — including a
/// manual "Tab 23") ignore every native title, changed or not.
#[tokio::test]
async fn native_observation_never_replaces_protected() {
    let dir = temp_dir();
    let store = open(dir.path());
    let cases = [
        ("s-manual", NameSource::Manual, "Chosen name"),
        ("s-manual-tab", NameSource::Manual, "Tab 23"),
        ("s-legacy", NameSource::LegacyProtected, "Legacy label"),
        ("s-ai", NameSource::FreshellAi, "Freshell AI title"),
    ];
    for (id, source, name) in cases {
        let target = protected_record(&store, id, source, name).await;
        let before = get_one(&store, &target).await;
        observe(&store, &target, "Changed native one", 0).await;
        observe(&store, &target, "Changed native two", 0).await;
        let after = get_one(&store, &target).await;
        assert_eq!(after.name, name, "{id}: a protected name stays");
        assert_eq!(after.source, source, "{id}");
        assert_eq!(after.revision, before.revision, "{id}: no new revision");
    }
}

/// Pinning: an old-location observation stays provenance only (no name, no
/// baseline).
#[tokio::test]
async fn stale_location_observation_stays_provenance_only() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-stale");
    seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-stale",
            Some("/w/proj"),
            None,
            None,
        ),
        false,
    )
    .await;
    store
        .record_acquisition(
            target.clone(),
            NativeAcquisition {
                location: NativeLocation::Claude {
                    config_root: "/h/.claude".into(),
                    transcript_path: Some("/h/.claude/projects/-p/s-stale.jsonl".into()),
                    project_directory_key: None,
                    transcript_cwd: None,
                    effective_project_key_override: None,
                },
                evidence: NativeEvidenceKind::SelectedTranscript,
                persistence: NativePersistence::Verified,
            },
        )
        .await
        .expect("verified location");
    let before = get_one(&store, &target).await;
    let stale = observe(&store, &target, "Stale location title", 0).await;
    assert!(!stale.changed);
    assert_eq!(stale.record.name, before.name);
    assert_eq!(store.staged_native_baseline(&target), None);
    let current = observe(&store, &target, "Current location title", 1).await;
    assert!(current.changed, "the current location still folds");
}

// ---------------------------------------------------------------------------
// Automation renames
// ---------------------------------------------------------------------------

#[tokio::test]
async fn automation_rename_reports_protected() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = protected_record(&store, "s-protected", NameSource::Manual, "LotL").await;
    let before = get_one(&store, &target).await;
    let update = rename(&store, &target, "Bot name", NameIntent::Automatic, None).await;
    assert!(!update.changed);
    assert_eq!(
        update.outcome,
        Some(RenameOutcome {
            applied: false,
            reason: Some(RenameOutcomeReason::ProtectedName)
        })
    );
    assert_eq!(update.record, before, "the protected record is unchanged");
}

#[tokio::test]
async fn automation_rename_replaces_equal_rank() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-equal");
    let seeded = seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-equal",
            Some("/w/proj"),
            Some("Billing bug"),
            None,
        ),
        false,
    )
    .await;
    let update = rename(
        &store,
        &target,
        "Better name",
        NameIntent::Automatic,
        Some("/w/proj"),
    )
    .await;
    assert!(update.changed);
    assert_eq!(update.record.name, "Better name");
    assert_eq!(update.record.source, NameSource::ProviderAi);
    assert!(update.record.revision > seeded.record.revision);
    assert_eq!(
        update.outcome,
        Some(RenameOutcome {
            applied: true,
            reason: None
        })
    );

    // The same text again: applied (the name is what was asked for), no change.
    let same = rename(&store, &target, "Better name", NameIntent::Automatic, None).await;
    assert!(!same.changed);
    assert_eq!(same.record.revision, update.record.revision);
    assert_eq!(
        same.outcome,
        Some(RenameOutcome {
            applied: true,
            reason: Some(RenameOutcomeReason::Unchanged)
        })
    );
}

#[tokio::test]
async fn automation_rename_refuses_default_label() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-default");
    let seeded = seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-default",
            Some("/w/proj"),
            Some("Billing bug"),
            None,
        ),
        false,
    )
    .await;
    for label in ["Tab 3", "Claude CLI", "OpenCode agent"] {
        let update = rename(&store, &target, label, NameIntent::Automatic, None).await;
        assert_eq!(
            update.outcome,
            Some(RenameOutcome {
                applied: false,
                reason: Some(RenameOutcomeReason::DefaultLabel)
            }),
            "{label}"
        );
        assert_eq!(update.record, seeded.record, "{label}: record unchanged");
    }
}

/// LB-B8: an automation rename to the session's own folder name is refused
/// at the terminal route (classified with the terminal row's cwd), and the
/// next sweep pass changes nothing.
#[tokio::test]
async fn automation_rename_to_the_folder_name_is_refused_and_stays_refused() {
    let home = temp_dir();
    let data_dir = home.path().join(".freshell");
    let store = open(&data_dir);
    let cwd = "/home/dan/code/freshell";
    let target = session(NamedProvider::Claude, "s-folder");
    let seeded = seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-folder",
            Some(cwd),
            Some("Billing bug"),
            Some(SARDINE),
        ),
        true,
    )
    .await;

    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    identity.set_session_naming(store.clone());
    identity.upsert(
        "term-folder",
        Some("claude"),
        Some("s-folder"),
        Some(cwd),
        1_000,
    );
    identity.set_name_binding("term-folder", Some(target.clone()), None);
    let router = crate::terminals::router(crate::terminals::TerminalsState {
        auth_token: Arc::new("tok".to_string()),
        settings: crate::settings_store::SettingsStore::load(
            Some(home.path()),
            vec!["claude".into()],
        ),
        registry: freshell_terminal::TerminalRegistry::new(),
        broadcast_tx: Arc::new(tx),
        terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        identity: identity.clone(),
    });
    let response = tower::util::ServiceExt::oneshot(
        router,
        axum::http::Request::builder()
            .method("PATCH")
            .uri("/api/terminals/term-folder")
            .header("x-auth-token", "tok")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(
                serde_json::json!({ "titleOverride": "freshell" }).to_string(),
            ))
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        body["sessionName"]["outcome"],
        serde_json::json!({ "applied": false, "reason": "default_label" }),
        "{body}"
    );
    assert_eq!(
        get_one(&store, &target).await,
        seeded.record,
        "record unchanged"
    );

    // The next sweep pass sees a settled, real-named record: no transaction.
    let (sweep, _sweep_rx) = sweep_state(home.path(), store.clone());
    sweep
        .index_hydrated
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let before = crate::session_names::test_store_transaction_count(&data_dir);
    crate::auto_title_sweep::run_auto_title_pass(
        &sweep,
        &[crate::auto_title_sweep::SweepSession {
            provider: "claude".into(),
            session_id: "s-folder".into(),
            cwd: Some(cwd.into()),
            title: None,
            first_user_message: Some(SARDINE.into()),
            title_source: None,
            git_branch: None,
        }],
    )
    .await;
    assert_eq!(
        crate::session_names::test_store_transaction_count(&data_dir),
        before,
        "the sweep has nothing to heal"
    );
    assert_eq!(get_one(&store, &target).await.name, "Billing bug");
}

/// Pinning (Residual 11): a rename to SOME OTHER folder's name applies — the
/// server only knows the target's own folder.
#[tokio::test]
async fn automation_rename_to_another_folders_name_applies() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-machines");
    seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-machines",
            Some("/home/dan/code/freshell"),
            Some("Billing bug"),
            None,
        ),
        false,
    )
    .await;
    let update = rename(
        &store,
        &target,
        "machines",
        NameIntent::Automatic,
        Some("/home/dan/code/freshell"),
    )
    .await;
    assert_eq!(update.outcome.map(|o| o.applied), Some(true));
    assert_eq!(update.record.name, "machines");
}

#[tokio::test]
async fn user_rename_is_never_filtered() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-user");
    seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-user",
            Some("/w/proj"),
            Some("Billing bug"),
            None,
        ),
        false,
    )
    .await;
    let update = rename(&store, &target, "Tab 3", NameIntent::User, Some("/w/proj")).await;
    assert_eq!(update.record.name, "Tab 3");
    assert_eq!(update.record.source, NameSource::Manual);
    assert_eq!(update.outcome.map(|o| o.applied), Some(true));
}

// ---------------------------------------------------------------------------
// Self-heal
// ---------------------------------------------------------------------------

/// The user-visible case: a provider-level "Tab 23" takes the first message
/// (today it is refused, because `provider_ai` outranks `first_message`).
#[tokio::test]
async fn self_heal_tab_n_provider_ai_takes_the_first_message() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-heal");
    seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-heal",
            Some("/w/proj"),
            Some("Tab 23"),
            None,
        ),
        false,
    )
    .await;
    let healed = activity(
        &store,
        &target,
        NameActivityReason::AcceptedUserMessage,
        Some(SARDINE),
        Some("/w/proj"),
    )
    .await;
    assert!(healed.changed);
    assert_eq!(healed.record.name, SARDINE);
    assert_eq!(healed.record.source, NameSource::FirstMessage);
}

/// Names a person chose (and other protected names) are never self-heal
/// records, even when they read "Tab 23"; neither pre-check reports work.
#[tokio::test]
async fn self_heal_never_touches_a_manual_tab_n() {
    let dir = temp_dir();
    let store = open(dir.path());
    for (id, source) in [
        ("s-m", NameSource::Manual),
        ("s-l", NameSource::LegacyProtected),
        ("s-f", NameSource::FreshellAi),
    ] {
        let target = protected_record(&store, id, source, "Tab 23").await;
        let before = get_one(&store, &target).await;
        let input = activity_input(
            &target,
            NameActivityReason::IndexUserMessage,
            Some(SARDINE),
            Some("/w/proj"),
        );
        assert!(!store.activity_pending(&input), "{id}: activity pre-check");
        let hydrate = indexed(
            NamedProvider::Claude,
            id,
            Some("/w/proj"),
            Some("Provider title"),
            Some(SARDINE),
        );
        assert!(
            !store.hydrate_indexed_pending(&hydrate),
            "{id}: hydrate pre-check"
        );
        store.activity(input).await.expect("activity");
        observe(&store, &target, "Real title", 0).await;
        store
            .hydrate_indexed(hydrate, false)
            .await
            .expect("hydrate");
        let after = get_one(&store, &target).await;
        assert_eq!(after, before, "{id}: unchanged, no new revision");
    }
}

/// The folder rule needs the folder: with the activity's cwd a folder-named
/// record heals; without one it is left alone (folder-free patterns only).
#[tokio::test]
async fn self_heal_uses_the_known_folder() {
    let dir = temp_dir();
    let store = open(dir.path());
    let with_cwd = session(NamedProvider::Claude, "s-cwd");
    let without_cwd = session(NamedProvider::Claude, "s-nocwd");
    for id in ["s-cwd", "s-nocwd"] {
        seed(
            &store,
            indexed(
                NamedProvider::Claude,
                id,
                Some("/home/dan/code/freshell"),
                Some("freshell"),
                None,
            ),
            false,
        )
        .await;
    }
    let healed = activity(
        &store,
        &with_cwd,
        NameActivityReason::AcceptedUserMessage,
        Some(SARDINE),
        Some("/home/dan/code/freshell"),
    )
    .await;
    assert_eq!(healed.record.name, SARDINE);
    assert_eq!(healed.record.source, NameSource::FirstMessage);

    let kept = activity(
        &store,
        &without_cwd,
        NameActivityReason::AcceptedUserMessage,
        Some(SARDINE),
        None,
    )
    .await;
    assert!(!kept.changed);
    assert_eq!(kept.record.name, "freshell", "no folder, no folder rule");
    assert_eq!(kept.record.source, NameSource::ProviderAi);
}

/// Hydration re-offers to a self-heal record (it used to return early for
/// any existing record): the provider title replaces "OpenCode agent", no
/// series is created, and the pre-check settles afterwards.
#[tokio::test]
async fn hydrate_reoffers_to_a_self_heal_record() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Opencode, "ses_agent");
    seed(
        &store,
        indexed(
            NamedProvider::Opencode,
            "ses_agent",
            Some("/w/proj"),
            Some("OpenCode agent"),
            None,
        ),
        false,
    )
    .await;
    let input = indexed(
        NamedProvider::Opencode,
        "ses_agent",
        Some("/w/proj"),
        Some("Publishing blocked by token error"),
        None,
    );
    assert!(store.hydrate_indexed_pending(&input));
    let healed = store
        .hydrate_indexed(input.clone(), true)
        .await
        .expect("hydrate");
    assert!(healed.changed);
    assert_eq!(healed.record.name, "Publishing blocked by token error");
    assert_eq!(healed.record.source, NameSource::ProviderAi);
    assert!(
        !raw_document(dir.path())
            .generation
            .contains_key(&name_ref_key(&target)),
        "the heal creates no generation series"
    );
    assert!(!store.hydrate_indexed_pending(&input), "settled afterwards");
}

/// C1: the planned fallback is applied as planned — not re-offered through
/// the strict raise, which refuses equal rank — and the pre-check settles.
#[tokio::test]
async fn planned_fallback_is_applied_without_the_strict_raise() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-c1");
    let seeded = seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-c1",
            Some("/w/proj"),
            None,
            Some("Claude CLI"),
        ),
        false,
    )
    .await;
    assert_eq!(seeded.record.source, NameSource::FirstMessage);
    assert_eq!(seeded.record.name, "Claude CLI");
    let input = activity_input(
        &target,
        NameActivityReason::AcceptedUserMessage,
        Some(SARDINE),
        Some("/w/proj"),
    );
    assert!(store.activity_pending(&input));
    let healed = store.activity(input.clone()).await.expect("activity");
    assert!(healed.changed);
    assert_eq!(healed.record.name, SARDINE);
    assert_eq!(healed.record.source, NameSource::FirstMessage);

    assert!(
        !store.activity_pending(&input),
        "the same activity is settled"
    );
    let before = test_store_transaction_count(dir.path());
    assert!(!store.activity_pending(&input));
    assert_eq!(test_store_transaction_count(dir.path()), before);
}

/// C2: hydration's last rung (the folder name) steps a junk provider-level
/// record down to `directory` ONCE; after that two default labels can never
/// alternate.
#[tokio::test]
async fn hydrate_default_rung_steps_down_once() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-c2");
    seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-c2",
            Some("/w/work"),
            Some("Tab 23"),
            None,
        ),
        false,
    )
    .await;
    let input = indexed(NamedProvider::Claude, "s-c2", Some("/w/work"), None, None);
    assert!(store.hydrate_indexed_pending(&input));
    let stepped = store
        .hydrate_indexed(input.clone(), false)
        .await
        .expect("hydrate");
    assert_eq!(stepped.record.name, "work");
    assert_eq!(stepped.record.source, NameSource::Directory);

    assert!(
        !store.hydrate_indexed_pending(&input),
        "the pre-check settles"
    );
    let generation_before = generation(dir.path());
    let again = store.hydrate_indexed(input, false).await.expect("hydrate");
    assert!(!again.changed);
    assert_eq!(
        again.record.revision, stepped.record.revision,
        "no new revision"
    );
    assert_eq!(generation(dir.path()), generation_before, "a Read");

    // Without a folder its rung would be the provider label: unchanged.
    let no_cwd = indexed(NamedProvider::Claude, "s-c2", None, None, None);
    assert!(!store.hydrate_indexed_pending(&no_cwd));
    let unchanged = store.hydrate_indexed(no_cwd, false).await.expect("hydrate");
    assert_eq!(unchanged.record.name, "work");
    assert_eq!(
        get_one(&store, &target).await.revision,
        stepped.record.revision
    );
}

#[tokio::test]
async fn activity_pre_check_reports_pending_for_a_self_heal_record() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-pre");
    // The message is absorbed at rest, so only the heal is pending work.
    seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-pre",
            Some("/w/proj"),
            Some("Tab 23"),
            Some(SARDINE),
        ),
        true,
    )
    .await;
    let input = activity_input(
        &target,
        NameActivityReason::IndexUserMessage,
        Some(SARDINE),
        Some("/w/proj"),
    );
    assert!(
        store.activity_pending(&input),
        "the junk name is pending work"
    );
    store.activity(input.clone()).await.expect("activity");
    assert_eq!(get_one(&store, &target).await.name, SARDINE);
    assert!(!store.activity_pending(&input), "settled after the heal");
}

/// C3: a stale adopted view only delays a heal. Another process (in
/// practice an older binary) writes "Tab 9" over a settled record; this
/// store's pre-check, on its old view, reports no work; after the next
/// adopted-view refresh it does, and the heal applies.
#[tokio::test]
async fn stale_view_delays_but_never_loses_a_heal() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-c3");
    seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-c3",
            Some("/w/proj"),
            Some("Settled name"),
            Some(SARDINE),
        ),
        true,
    )
    .await;
    let input = activity_input(
        &target,
        NameActivityReason::IndexUserMessage,
        Some(SARDINE),
        Some("/w/proj"),
    );
    assert!(!store.activity_pending(&input), "settled");

    // The foreign writer: the next generation, with the record relabelled.
    let mut foreign = raw_document(dir.path());
    let key = name_ref_key(&target);
    let mut record = foreign.records.get(&key).cloned().expect("record");
    record.name = "Tab 9".to_string();
    record.revision = foreign.next_revision;
    foreign.next_revision += 1;
    foreign.records.insert(key.clone(), record);
    foreign.document_generation += 1;
    let bytes = serialize_document(&foreign).expect("serialize");
    std::fs::write(dir.path().join(DOCUMENT_FILE_NAME), bytes).expect("foreign write");

    assert!(
        !store.activity_pending(&input),
        "the old view cannot see the foreign junk name yet (the safe direction: a delay)"
    );
    store
        .refresh_current()
        .await
        .expect("refresh adopts the foreign generation");
    assert!(
        store.activity_pending(&input),
        "after the refresh the heal is visible"
    );
    let healed = store.activity(input).await.expect("activity");
    assert_eq!(healed.record.name, SARDINE);
}

/// C4: a native echo never re-raises. "freshell" raised a record to
/// `provider_ai` (baseline "freshell"); the activity with the folder healed
/// it; the same native title again is provenance only, a new one applies.
#[tokio::test]
async fn native_echo_never_raises_over_a_healed_name() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-c4");
    seed(
        &store,
        indexed(NamedProvider::Claude, "s-c4", Some("/w/other"), None, None),
        false,
    )
    .await;
    let raised = observe(&store, &target, "freshell", 0).await;
    assert_eq!(raised.record.source, NameSource::ProviderAi);
    assert_eq!(raised.record.name, "freshell");

    let healed = activity(
        &store,
        &target,
        NameActivityReason::AcceptedUserMessage,
        Some(SARDINE),
        Some("/home/dan/code/freshell"),
    )
    .await;
    assert_eq!(healed.record.name, SARDINE);
    assert_eq!(healed.record.source, NameSource::FirstMessage);

    let echo = observe(&store, &target, "freshell", 0).await;
    assert!(
        !echo.changed,
        "an echo is provenance only, even when it would raise rank"
    );
    assert_eq!(echo.record.revision, healed.record.revision);

    let real = observe(&store, &target, "Real title", 0).await;
    assert!(real.changed);
    assert_eq!(real.record.name, "Real title");
    assert_eq!(real.record.source, NameSource::ProviderAi);
}

/// A healing activity arms (or does not arm) generation exactly as it would
/// for a real-named record with the same source and series state.
#[tokio::test]
async fn self_heal_changes_no_arming() {
    let dir = temp_dir();
    let store = open(dir.path());
    let junk = session(NamedProvider::Claude, "s-arm-junk");
    let real = session(NamedProvider::Claude, "s-arm-real");
    for (id, title) in [("s-arm-junk", "Tab 23"), ("s-arm-real", "Billing bug")] {
        seed(
            &store,
            indexed(
                NamedProvider::Claude,
                id,
                Some("/w/proj"),
                Some(title),
                Some("An older first message"),
            ),
            true,
        )
        .await;
    }
    for reason in [
        NameActivityReason::IndexUserMessage,
        NameActivityReason::AcceptedUserMessage,
    ] {
        for target in [&junk, &real] {
            activity(&store, target, reason, Some(SARDINE), Some("/w/proj")).await;
        }
        let document = raw_document(dir.path());
        let series = |target: &SessionNameRef| {
            let state = document
                .generation
                .get(&name_ref_key(target))
                .cloned()
                .expect("series");
            (
                state.status,
                state.input_fingerprint,
                state.excerpt,
                state.consumed,
                state.next_due,
            )
        };
        assert_eq!(
            series(&junk),
            series(&real),
            "{reason:?}: arming is the same"
        );
    }
    assert_eq!(
        get_one(&store, &junk).await.name,
        SARDINE,
        "the junk name healed"
    );
    assert_eq!(
        get_one(&store, &real).await.name,
        "Billing bug",
        "the real name stayed"
    );
}

// ---------------------------------------------------------------------------
// Sweep fixture (the route test above runs one pass)
// ---------------------------------------------------------------------------

fn sweep_state(
    home: &Path,
    names: Arc<SessionNames>,
) -> (
    crate::auto_title_sweep::AutoTitleSweepState,
    tokio::sync::broadcast::Receiver<String>,
) {
    let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = crate::auto_title_sweep::AutoTitleSweepState {
        settings: crate::settings_store::SettingsStore::load(Some(home), vec![]),
        identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        registry: freshell_terminal::TerminalRegistry::new(),
        broadcast_tx: Arc::new(tx),
        sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
        auth: crate::ai_title::GeminiSessionNameAuth::direct_for_test(
            crate::ai_title::AiKeyCell::init(None, None),
        ),
        gemini: Arc::new(NoGemini),
        pending_ai_titles: Default::default(),
        terminal_meta: Default::default(),
        git_meta_cache: Default::default(),
        names: Some(names),
        metadata: crate::session_metadata::SessionMetadataStore::new(home),
        index: None,
        index_hydrated: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    };
    (state, rx)
}

struct NoGemini;
impl crate::ai_title::GeminiTransport for NoGemini {
    fn generate_content(
        &self,
        _p: String,
        _m: u32,
    ) -> crate::ai_title::BoxFuture<Result<String, String>> {
        Box::pin(async { Err("no live Gemini in tests".to_string()) })
    }
}

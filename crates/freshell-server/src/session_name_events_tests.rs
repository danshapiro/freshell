//! Name-reliability Task 12: every accepted saved-name change logs exactly
//! one INFO `session_names.name_changed`, after the durable commit, and
//! nothing else does.
//!
//! Every test drives the REAL `SessionNames` store on a temp data dir
//! through its public transaction methods and reads the events back from
//! the test binary's process-wide trace capture. The store's transactions
//! run on blocking threads, so a thread-scoped capture would miss them;
//! instead every test names its records with ids no other test uses, and
//! counts only the events for those refs logged after its own mark.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use freshell_freshagent::naming::{
    BindNameInput, NameActivity, NameActivityReason, NameError, NativeNameObservation,
    NativeNameOrigin, PendingNameInput, RenameNameInput, SessionNaming,
};
use freshell_freshagent::terminal_name_binding::{
    follow_identity_name_ref, NamingBindOutcome, TerminalNameBinder,
};
use freshell_protocol::native_location::{
    NativeAcquisition, NativeEvidenceKind, NativeLocation, NativePersistence,
};
use freshell_protocol::session_names::{
    LegacyCandidateScope, LegacyEvidenceEnvelope, LegacyNameCandidate, LegacyNameImport,
    LegacyNameTarget, LegacyProtectionEvidence, NameIntent, NameSource, NamedProvider,
    SessionNameRecord, SessionNameRef, SessionNameUpdate,
};
use freshell_terminal::registry::HeadlessTerminal;
use freshell_terminal::TerminalRegistry;
use serde_json::json;

use super::{log_name_changes, NameChangeCause, NameChangeEvent};
use crate::session_name_generation::{GenerationOutcome, IndexedNameInput};
use crate::session_names::{
    clear_test_hooks, name_ref_key, set_test_hooks, SessionNames, StoredDocument,
    SweepMaintenanceItem, TestHook, NAME_MIGRATION_BOOT_IMPORT_ID,
};
use crate::test_trace_capture::captured_trace_events;

const NAME_CHANGED: &str = "session_names.name_changed";

// ---------------------------------------------------------------------------
// Reading the events back
// ---------------------------------------------------------------------------

/// One captured `session_names.name_changed` line, typed.
#[derive(Debug, Clone, PartialEq, Eq)]
struct NameChanged {
    cause: String,
    /// `(name, source, revision)` of the replaced record; `None` when the
    /// change created the record.
    old: Option<(String, String, u64)>,
    new: (String, String, u64),
    self_heal: bool,
    /// `from_ref`, `import_id`, `evidence_key` and `series`, when present.
    extra: BTreeMap<String, String>,
}

fn as_u64(value: Option<&String>, field: &str) -> u64 {
    value
        .unwrap_or_else(|| panic!("a name_changed event carries {field}"))
        .parse()
        .unwrap_or_else(|_| panic!("{field} is a number"))
}

/// The position after every event captured so far: later reads see only
/// what the test does from here on.
fn mark() -> usize {
    captured_trace_events().snapshot().len()
}

/// Every name-change event for `target` captured after `since`, in order.
fn name_changes_since(since: usize, target: &SessionNameRef) -> Vec<NameChanged> {
    let key = name_ref_key(target);
    captured_trace_events()
        .snapshot()
        .into_iter()
        .skip(since)
        .filter(|event| event.message == NAME_CHANGED)
        .filter(|event| event.fields.get("name_ref") == Some(&key))
        .map(|event| {
            assert_eq!(
                event.level,
                tracing::Level::INFO,
                "name changes log at INFO"
            );
            let fields = event.fields;
            let old = fields.get("old_name").map(|name| {
                (
                    name.clone(),
                    fields
                        .get("old_source")
                        .cloned()
                        .expect("an event with an old name carries its source"),
                    as_u64(fields.get("old_revision"), "old_revision"),
                )
            });
            let extra = ["from_ref", "import_id", "evidence_key", "series"]
                .into_iter()
                .filter_map(|name| {
                    fields
                        .get(name)
                        .map(|value| (name.to_string(), value.clone()))
                })
                .collect();
            NameChanged {
                cause: fields
                    .get("cause")
                    .cloned()
                    .expect("an event carries its cause"),
                old,
                new: (
                    fields.get("new_name").cloned().expect("new_name"),
                    fields.get("new_source").cloned().expect("new_source"),
                    as_u64(fields.get("new_revision"), "new_revision"),
                ),
                self_heal: fields.get("self_heal").map(String::as_str) == Some("true"),
                extra,
            }
        })
        .collect()
}

fn one_change(since: usize, target: &SessionNameRef) -> NameChanged {
    let changes = name_changes_since(since, target);
    assert_eq!(
        changes.len(),
        1,
        "exactly one name_changed event for {target:?}, got {changes:#?}"
    );
    changes.into_iter().next().unwrap()
}

fn assert_no_change(since: usize, target: &SessionNameRef, why: &str) {
    let changes = name_changes_since(since, target);
    assert!(changes.is_empty(), "{why}: {changes:#?}");
}

fn old_of(update: &SessionNameUpdate) -> Option<(String, String, u64)> {
    Some(new_of(update))
}

fn new_of(update: &SessionNameUpdate) -> (String, String, u64) {
    (
        update.record.name.clone(),
        wire(update.record.source),
        update.record.revision,
    )
}

fn wire(source: NameSource) -> String {
    serde_json::to_value(source)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string()
}

fn no_extra() -> BTreeMap<String, String> {
    BTreeMap::new()
}

fn extra(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

// ---------------------------------------------------------------------------
// Store fixtures
// ---------------------------------------------------------------------------

fn open_store(dir: &Path) -> Arc<SessionNames> {
    SessionNames::open(dir.to_path_buf()).expect("store opens")
}

fn pending(id: &str) -> SessionNameRef {
    SessionNameRef::Pending { id: id.to_string() }
}

fn claude(id: &str) -> SessionNameRef {
    SessionNameRef::Session {
        provider: NamedProvider::Claude,
        session_id: id.to_string(),
    }
}

async fn ensure(names: &SessionNames, handle: &str, cwd: &str) -> SessionNameUpdate {
    names
        .ensure_pending(PendingNameInput {
            handle: handle.to_string(),
            provider: NamedProvider::Claude,
            cwd: Some(cwd.to_string()),
        })
        .await
        .expect("ensure_pending succeeds")
}

async fn hydrate(
    names: &SessionNames,
    session_id: &str,
    first_user_message: Option<&str>,
    provider_title: Option<&str>,
) -> SessionNameUpdate {
    names
        .hydrate_indexed(
            IndexedNameInput {
                provider: NamedProvider::Claude,
                session_id: session_id.to_string(),
                cwd: Some(format!("/w/{session_id}")),
                first_user_message: first_user_message.map(str::to_string),
                provider_title: provider_title.map(str::to_string),
            },
            false,
        )
        .await
        .expect("hydrate succeeds")
}

async fn rename(
    names: &SessionNames,
    target: &SessionNameRef,
    name: &str,
    intent: NameIntent,
) -> Result<SessionNameUpdate, NameError> {
    names
        .rename(RenameNameInput {
            target: target.clone(),
            name: name.to_string(),
            intent,
            if_revision: None,
            cwd: None,
        })
        .await
}

async fn first_message(
    names: &SessionNames,
    target: &SessionNameRef,
    message: &str,
) -> SessionNameUpdate {
    names
        .activity(NameActivity {
            target: target.clone(),
            mode: "claude".to_string(),
            event_id: format!("evt-{message}"),
            reason: NameActivityReason::AcceptedUserMessage,
            first_user_message: Some(message.to_string()),
            cwd: None,
        })
        .await
        .expect("activity succeeds")
}

async fn observe(names: &SessionNames, target: &SessionNameRef, title: &str) -> SessionNameUpdate {
    names
        .observe_native(NativeNameObservation {
            target: target.clone(),
            title: title.to_string(),
            origin: NativeNameOrigin::Snapshot,
            location_revision: 0,
            event_id: None,
        })
        .await
        .expect("observation succeeds")
}

fn verified_claude() -> NativeAcquisition {
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

async fn bind(names: &SessionNames, handle: &str, target: &SessionNameRef) -> SessionNameUpdate {
    names
        .bind_pending(BindNameInput {
            pending: pending(handle),
            target: target.clone(),
            acquisition: verified_claude(),
        })
        .await
        .expect("bind succeeds")
}

fn label_candidate(
    id: &str,
    session_id: &str,
    name: &str,
    evidence_key: &str,
) -> LegacyNameCandidate {
    LegacyNameCandidate {
        id: id.to_string(),
        target: LegacyNameTarget::Canonical(claude(session_id)),
        name: name.to_string(),
        source: NameSource::ProviderAi,
        scope: LegacyCandidateScope::SourceTab,
        explicit_rename_at: None,
        evidence_key: evidence_key.to_string(),
        protection_evidence: LegacyProtectionEvidence::None,
    }
}

// ---------------------------------------------------------------------------
// One event per cause
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ensure_pending_logs_the_new_folder_name() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let target = pending("evt-ensure");
    let since = mark();

    let created = ensure(&names, "evt-ensure", "/w/evt-ensure-folder").await;

    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "ensure_pending".into(),
            old: None,
            new: new_of(&created),
            self_heal: false,
            extra: no_extra(),
        }
    );
    // Re-ensuring the same handle changes nothing and logs nothing.
    let again = mark();
    ensure(&names, "evt-ensure", "/w/evt-ensure-folder").await;
    assert_no_change(again, &target, "a repeated ensure is not a change");
}

#[tokio::test]
async fn native_observation_logs_the_provider_title_replacing_the_folder_name() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let target = pending("evt-native");
    let before = ensure(&names, "evt-native", "/w/evt-native").await;
    let since = mark();

    let after = observe(&names, &target, "Fix the login redirect").await;

    assert_eq!(after.record.source, NameSource::ProviderAi);
    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "native_observation".into(),
            old: old_of(&before),
            new: new_of(&after),
            self_heal: false,
            extra: no_extra(),
        }
    );
}

#[tokio::test]
async fn first_message_fallback_logs_the_first_message_name() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let target = pending("evt-first");
    let before = ensure(&names, "evt-first", "/w/evt-first").await;
    let since = mark();

    let after = first_message(&names, &target, "Repair the sardine factory line").await;

    assert_eq!(after.record.source, NameSource::FirstMessage);
    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "first_message_fallback".into(),
            old: old_of(&before),
            new: new_of(&after),
            self_heal: false,
            extra: no_extra(),
        }
    );
}

#[tokio::test]
async fn generation_logs_the_accepted_ai_name_with_its_series() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let target = pending("evt-generation");
    ensure(&names, "evt-generation", "/w/evt-generation").await;
    let before = first_message(&names, &target, "Export the billing ledger").await;
    let claim = names
        .claim_generation_start(target.clone(), "evt-generation-attempt".to_string())
        .await
        .expect("claim runs")
        .expect("the armed series is claimable");
    let since = mark();

    let after = names
        .fold_generation_outcome(
            target.clone(),
            claim.series_id.clone(),
            claim.input_fingerprint.clone(),
            GenerationOutcome::Answer("Billing ledger export".to_string()),
        )
        .await
        .expect("fold succeeds");

    assert_eq!(after.record.source, NameSource::FreshellAi);
    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "generation".into(),
            old: old_of(&before),
            new: new_of(&after),
            self_heal: false,
            extra: extra(&[("series", &claim.series_id)]),
        }
    );
}

#[tokio::test]
async fn manual_rename_logs_the_users_name() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let target = pending("evt-manual");
    let before = ensure(&names, "evt-manual", "/w/evt-manual").await;
    let since = mark();

    let after = rename(&names, &target, "Ship it", NameIntent::User)
        .await
        .unwrap();

    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "manual_rename".into(),
            old: old_of(&before),
            new: new_of(&after),
            self_heal: false,
            extra: no_extra(),
        }
    );
}

#[tokio::test]
async fn automation_rename_logs_the_agents_name() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let target = pending("evt-automation");
    let before = ensure(&names, "evt-automation", "/w/evt-automation").await;
    let since = mark();

    let after = rename(&names, &target, "Agent suggestion", NameIntent::Automatic)
        .await
        .unwrap();

    assert_eq!(after.record.source, NameSource::ProviderAi);
    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "automation_rename".into(),
            old: old_of(&before),
            new: new_of(&after),
            self_heal: false,
            extra: no_extra(),
        }
    );
}

#[tokio::test]
async fn bind_without_a_collision_logs_the_session_record_appearing() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let handle = "evt-bind-plain";
    let target = claude("evt-bind-plain-session");
    ensure(&names, handle, "/w/evt-bind-plain").await;
    let since = mark();

    let bound = bind(&names, handle, &target).await;

    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "bind".into(),
            old: None,
            new: new_of(&bound),
            self_heal: false,
            extra: extra(&[("from_ref", &name_ref_key(&pending(handle)))]),
        }
    );
}

#[tokio::test]
async fn bind_collision_logs_the_winning_pending_name_and_nothing_when_the_session_keeps_its_own() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());

    // The pane's user name outranks the session's first-message name.
    let won = claude("evt-collision-won");
    let session_before = hydrate(
        &names,
        "evt-collision-won",
        Some("Ship the billing report"),
        None,
    )
    .await;
    ensure(&names, "evt-collision-pane", "/w/evt-collision-pane").await;
    rename(
        &names,
        &pending("evt-collision-pane"),
        "My pane",
        NameIntent::User,
    )
    .await
    .unwrap();
    let since = mark();
    let bound = bind(&names, "evt-collision-pane", &won).await;
    assert_eq!(bound.record.name, "My pane");
    assert_eq!(
        one_change(since, &won),
        NameChanged {
            cause: "bind_collision".into(),
            old: old_of(&session_before),
            new: new_of(&bound),
            self_heal: false,
            extra: extra(&[("from_ref", &name_ref_key(&pending("evt-collision-pane")))]),
        }
    );

    // The session's first-message name outranks the pane's folder name: the
    // session's saved name does not change, so nothing is logged.
    let kept = claude("evt-collision-kept");
    hydrate(
        &names,
        "evt-collision-kept",
        Some("Keep this session name"),
        None,
    )
    .await;
    ensure(&names, "evt-collision-folder", "/w/evt-collision-folder").await;
    let since = mark();
    let bound = bind(&names, "evt-collision-folder", &kept).await;
    assert_eq!(bound.record.name, "Keep this session name");
    assert_no_change(since, &kept, "the session kept its saved name");
}

#[tokio::test]
async fn hydrate_logs_the_indexed_session_record_appearing() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let target = claude("evt-hydrate");
    let since = mark();

    let created = hydrate(&names, "evt-hydrate", Some("Audit the cache layer"), None).await;

    assert_eq!(created.record.source, NameSource::FirstMessage);
    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "hydrate".into(),
            old: None,
            new: new_of(&created),
            self_heal: false,
            extra: no_extra(),
        }
    );
}

#[tokio::test]
async fn adopted_external_logs_another_processes_change_once_and_never_the_boot_load() {
    let dir = tempfile::tempdir().unwrap();
    let writer = open_store(dir.path());
    let target = claude("evt-adopt");
    let before = hydrate(&writer, "evt-adopt", None, None).await;

    // Loading an existing document at open is not a change.
    let since_open = mark();
    let reader = open_store(dir.path());
    assert_no_change(since_open, &target, "opening a store adopts no change");

    let renamed = rename(&writer, &target, "Renamed elsewhere", NameIntent::User)
        .await
        .unwrap();
    let since = mark();
    reader.refresh_current().await.expect("the reader adopts");

    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "adopted_external".into(),
            old: old_of(&before),
            new: new_of(&renamed),
            self_heal: false,
            extra: no_extra(),
        }
    );
    // Adopting the same document again is not another change.
    let again = mark();
    reader.refresh_current().await.unwrap();
    assert_no_change(again, &target, "nothing new to adopt");
}

/// A store that commits its own change on top of a newer document from
/// another process adopts that document with the commit: the other
/// process's change is logged once, as `adopted_external`, beside the
/// store's own change.
#[tokio::test]
async fn adopted_external_logs_another_processes_change_once_when_a_commit_lands_over_it() {
    let dir = tempfile::tempdir().unwrap();
    let writer = open_store(dir.path());
    let theirs = claude("evt-adopt-commit");
    let before = hydrate(&writer, "evt-adopt-commit", None, None).await;
    let reader = open_store(dir.path());
    let renamed = rename(&writer, &theirs, "Renamed by the writer", NameIntent::User)
        .await
        .unwrap();
    let own = pending("evt-adopt-commit-own");
    let since = mark();

    // The reader writes a different record without adopting first.
    let created = ensure(&reader, "evt-adopt-commit-own", "/w/evt-adopt-commit-own").await;

    assert_eq!(
        one_change(since, &theirs),
        NameChanged {
            cause: "adopted_external".into(),
            old: old_of(&before),
            new: new_of(&renamed),
            self_heal: false,
            extra: no_extra(),
        }
    );
    assert_eq!(
        one_change(since, &own),
        NameChanged {
            cause: "ensure_pending".into(),
            old: None,
            new: new_of(&created),
            self_heal: false,
            extra: no_extra(),
        }
    );
    // The commit adopted the writer's document: the reader's next reads and
    // writes log neither change again.
    let again = mark();
    reader.refresh_current().await.unwrap();
    rename(&reader, &own, "Reader's own name", NameIntent::User)
        .await
        .unwrap();
    assert_no_change(again, &theirs, "the writer's change was already adopted");
    assert_eq!(
        name_changes_since(again, &own)
            .into_iter()
            .map(|change| change.cause)
            .collect::<Vec<_>>(),
        vec!["manual_rename".to_string()],
        "the reader's own record logs only its new rename"
    );
}

#[tokio::test]
async fn import_logs_a_boot_installed_label_with_its_import_and_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let target = claude("evt-import");
    let evidence_key = "tabs-registry:device-1:claude:evt-import:source-tab";
    let since = mark();

    let result = names
        .import_legacy(LegacyNameImport {
            version: 1,
            import_id: NAME_MIGRATION_BOOT_IMPORT_ID.to_string(),
            evidence: vec![],
            candidates: vec![label_candidate(
                "evt-import-candidate",
                "evt-import",
                "Imported label",
                evidence_key,
            )],
        })
        .await
        .expect("boot import succeeds");

    let installed = result
        .names
        .iter()
        .find(|update| update.record.name_ref == target)
        .expect("the import installed the record");
    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "import".into(),
            old: None,
            new: new_of(installed),
            self_heal: false,
            extra: extra(&[
                ("import_id", NAME_MIGRATION_BOOT_IMPORT_ID),
                ("evidence_key", evidence_key),
            ]),
        }
    );
}

/// Two candidates of one import that both win for the same session change
/// its record twice in one transaction: one event, measured from the record
/// before the import to the committed name, with the evidence that won.
#[tokio::test]
async fn import_logs_one_change_when_two_candidates_win_for_one_session() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let target = claude("evt-import-twice");
    let before = hydrate(
        &names,
        "evt-import-twice",
        Some("Sort the import backlog"),
        None,
    )
    .await;
    let (tab_key, session_key) = (
        "tabs-registry:device-1:claude:evt-import-twice:source-tab",
        "tabs-registry:device-1:claude:evt-import-twice:session",
    );
    // The tab label outranks the first-message name; the session-scoped
    // label then outranks the tab label on scope.
    let tab_label = label_candidate(
        "evt-import-twice-tab",
        "evt-import-twice",
        "Tab label",
        tab_key,
    );
    let session_label = LegacyNameCandidate {
        scope: LegacyCandidateScope::Session,
        ..label_candidate(
            "evt-import-twice-session",
            "evt-import-twice",
            "Session label",
            session_key,
        )
    };
    let since = mark();

    let result = names
        .import_legacy(LegacyNameImport {
            version: 1,
            import_id: NAME_MIGRATION_BOOT_IMPORT_ID.to_string(),
            evidence: vec![],
            candidates: vec![tab_label, session_label],
        })
        .await
        .expect("boot import succeeds");

    let installed = result
        .names
        .iter()
        .rev()
        .find(|update| update.record.name_ref == target)
        .expect("the import installed the record");
    assert_eq!(installed.record.name, "Session label");
    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "import".into(),
            old: old_of(&before),
            new: new_of(installed),
            self_heal: false,
            extra: extra(&[
                ("import_id", NAME_MIGRATION_BOOT_IMPORT_ID),
                ("evidence_key", session_key),
            ]),
        }
    );
}

// ---------------------------------------------------------------------------
// The self-heal flag
// ---------------------------------------------------------------------------

#[tokio::test]
async fn self_heal_flag_marks_a_healed_default_label() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());

    // A provider-level "Tab 23" is junk: the first message replaces it
    // only because of the self-heal rule.
    let junk = claude("evt-heal-junk");
    let junk_before = hydrate(&names, "evt-heal-junk", None, Some("Tab 23")).await;
    assert_eq!(
        (junk_before.record.name.as_str(), junk_before.record.source),
        ("Tab 23", NameSource::ProviderAi)
    );
    let since = mark();
    let healed = first_message(&names, &junk, "Fix the sardine importer").await;
    assert_eq!(
        one_change(since, &junk),
        NameChanged {
            cause: "first_message_fallback".into(),
            old: old_of(&junk_before),
            new: new_of(&healed),
            self_heal: true,
            extra: no_extra(),
        }
    );

    // A real-named directory record is simply outranked.
    let real = pending("evt-heal-real");
    let real_before = ensure(&names, "evt-heal-real", "/w/evt-heal-real-named").await;
    let since = mark();
    let raised = first_message(&names, &real, "Plan the offsite").await;
    assert_eq!(
        one_change(since, &real),
        NameChanged {
            cause: "first_message_fallback".into(),
            old: old_of(&real_before),
            new: new_of(&raised),
            self_heal: false,
            extra: no_extra(),
        }
    );
}

/// The flag depends on the before/after pair, not on which path made the
/// change: a folder name giving way to the first message is an ordinary
/// rank raise, so it is not a heal when the session index makes it (which
/// can replace an existing record only through the self-heal rule) nor when
/// the first-message fallback makes it.
#[tokio::test]
async fn self_heal_flag_is_the_same_for_a_rank_raise_from_either_path() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());

    let by_index = claude("evt-raise-index");
    let index_before = hydrate(&names, "evt-raise-index", None, None).await;
    assert_eq!(
        (
            index_before.record.name.as_str(),
            index_before.record.source
        ),
        ("evt-raise-index", NameSource::Directory)
    );
    let since = mark();
    let raised = hydrate(
        &names,
        "evt-raise-index",
        Some("Chart the index ledger"),
        None,
    )
    .await;
    assert_eq!(raised.record.source, NameSource::FirstMessage);
    assert_eq!(
        one_change(since, &by_index),
        NameChanged {
            cause: "hydrate".into(),
            old: old_of(&index_before),
            new: new_of(&raised),
            self_heal: false,
            extra: no_extra(),
        }
    );

    let by_message = claude("evt-raise-message");
    let message_before = hydrate(&names, "evt-raise-message", None, None).await;
    let since = mark();
    let raised = names
        .activity(NameActivity {
            target: by_message.clone(),
            mode: "claude".to_string(),
            event_id: "evt-raise-message-index".to_string(),
            reason: NameActivityReason::IndexUserMessage,
            first_user_message: Some("Chart the message ledger".to_string()),
            cwd: Some("/w/evt-raise-message".to_string()),
        })
        .await
        .expect("activity succeeds");
    assert_eq!(raised.record.source, NameSource::FirstMessage);
    assert_eq!(
        one_change(since, &by_message),
        NameChanged {
            cause: "first_message_fallback".into(),
            old: old_of(&message_before),
            new: new_of(&raised),
            self_heal: false,
            extra: no_extra(),
        }
    );
}

/// The sweep heals junk names in batches (one transaction for many
/// records): each healed record still logs its own change, marked as a heal.
#[tokio::test]
async fn sweep_maintenance_logs_each_healed_record_once_as_a_self_heal() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let (by_index, by_message) = (claude("evt-sweep-index"), claude("evt-sweep-message"));
    let index_before = hydrate(&names, "evt-sweep-index", None, Some("Tab 31")).await;
    let message_before = hydrate(&names, "evt-sweep-message", None, Some("Tab 32")).await;
    let since = mark();

    let report = names
        .sweep_maintenance(vec![
            SweepMaintenanceItem {
                hydrate: Some(IndexedNameInput {
                    provider: NamedProvider::Claude,
                    session_id: "evt-sweep-index".to_string(),
                    cwd: Some("/w/evt-sweep-index".to_string()),
                    first_user_message: Some("Audit the sweep importer".to_string()),
                    provider_title: None,
                }),
                activity: None,
            },
            SweepMaintenanceItem {
                hydrate: None,
                activity: Some(NameActivity {
                    target: by_message.clone(),
                    mode: "claude".to_string(),
                    event_id: "evt-sweep-message-index".to_string(),
                    reason: NameActivityReason::IndexUserMessage,
                    first_user_message: Some("Repair the sweep exporter".to_string()),
                    cwd: Some("/w/evt-sweep-message".to_string()),
                }),
            },
        ])
        .await
        .expect("the batch commits");

    assert_eq!(report.healed, 2);
    let healed_index = names.get(vec![by_index.clone()]).await.unwrap().remove(0);
    let healed_message = names.get(vec![by_message.clone()]).await.unwrap().remove(0);
    assert_eq!(
        one_change(since, &by_index),
        NameChanged {
            cause: "hydrate".into(),
            old: old_of(&index_before),
            new: new_of(&healed_index),
            self_heal: true,
            extra: no_extra(),
        }
    );
    assert_eq!(
        one_change(since, &by_message),
        NameChanged {
            cause: "first_message_fallback".into(),
            old: old_of(&message_before),
            new: new_of(&healed_message),
            self_heal: true,
            extra: no_extra(),
        }
    );
}

/// One sweep item can change one record twice: the index heals the junk
/// name to the folder name, then the first message raises the folder name.
/// That logs one change, from the junk name to the first message, and it
/// is a heal.
#[tokio::test]
async fn sweep_maintenance_logs_a_record_healed_by_index_then_message_once() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let target = claude("evt-sweep-both");
    let cwd = "/w/evt-sweep-both";
    let junk = hydrate(&names, "evt-sweep-both", None, Some("Tab 33")).await;
    assert_eq!(
        (junk.record.name.as_str(), junk.record.source),
        ("Tab 33", NameSource::ProviderAi)
    );
    let since = mark();

    let report = names
        .sweep_maintenance(vec![SweepMaintenanceItem {
            hydrate: Some(IndexedNameInput {
                provider: NamedProvider::Claude,
                session_id: "evt-sweep-both".to_string(),
                cwd: Some(cwd.to_string()),
                first_user_message: None,
                provider_title: None,
            }),
            activity: Some(NameActivity {
                target: target.clone(),
                mode: "claude".to_string(),
                event_id: "evt-sweep-both-index".to_string(),
                reason: NameActivityReason::IndexUserMessage,
                first_user_message: Some("Balance the sweep ledger".to_string()),
                cwd: Some(cwd.to_string()),
            }),
        }])
        .await
        .expect("the batch commits");

    assert_eq!(report.healed, 1);
    let healed = names.get(vec![target.clone()]).await.unwrap().remove(0);
    assert_eq!(
        (healed.record.name.as_str(), healed.record.source),
        ("Balance the sweep ledger", NameSource::FirstMessage)
    );
    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "first_message_fallback".into(),
            old: old_of(&junk),
            new: new_of(&healed),
            self_heal: true,
            extra: no_extra(),
        }
    );
}

/// The merge rule itself: when one transaction hands the logger several
/// changes of one record, the logged change runs from the first change's
/// prior record, and the self-heal flag is judged against that same prior
/// (here a junk "Tab 41" that the first message replaced only because of
/// the self-heal rule), never against an intermediate record.
#[test]
fn merged_changes_judge_the_self_heal_flag_from_the_first_prior() {
    let target = claude("evt-merge-rule");
    let key = name_ref_key(&target);
    let cwd = Some("/w/evt-merge-rule");
    let record = |name: &str, source: NameSource, revision: u64| SessionNameRecord {
        name_ref: target.clone(),
        name: name.to_string(),
        source,
        revision,
        manual_revision: None,
        renamed_at: None,
        legacy_origin: None,
    };
    let junk = record("Tab 41", NameSource::ProviderAi, 1);
    let folder = record("evt-merge-rule", NameSource::Directory, 2);
    let mut document = StoredDocument::initial();
    document.records.insert(
        key.clone(),
        record("Merge the rule ledger", NameSource::FirstMessage, 3),
    );
    let healed_to_folder = NameChangeEvent::new(NameChangeCause::Hydrate, Some(&junk), cwd);
    let raised_to_message =
        NameChangeEvent::new(NameChangeCause::FirstMessageFallback, Some(&folder), cwd);
    let since = mark();

    log_name_changes(
        &document,
        [
            (key.as_str(), &healed_to_folder),
            (key.as_str(), &raised_to_message),
        ],
    );

    assert_eq!(
        one_change(since, &target),
        NameChanged {
            cause: "first_message_fallback".into(),
            old: Some(("Tab 41".into(), "provider_ai".into(), 1)),
            new: ("Merge the rule ledger".into(), "first_message".into(), 3),
            self_heal: true,
            extra: no_extra(),
        }
    );
}

// ---------------------------------------------------------------------------
// Nothing else logs a change
// ---------------------------------------------------------------------------

#[tokio::test]
async fn no_event_for_unchanged_or_refused_offers() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());

    // The same manual name again.
    let manual = pending("evt-none-manual");
    ensure(&names, "evt-none-manual", "/w/evt-none-manual").await;
    rename(&names, &manual, "Pinned name", NameIntent::User)
        .await
        .unwrap();
    let since = mark();
    rename(&names, &manual, "Pinned name", NameIntent::User)
        .await
        .unwrap();
    // An automation rename over a manual name is refused.
    let refused = rename(&names, &manual, "Agent idea", NameIntent::Automatic)
        .await
        .unwrap();
    assert!(!refused.changed);
    assert_no_change(since, &manual, "an unchanged or refused rename");

    // An automation rename to a default label is refused.
    let automatic = pending("evt-none-label");
    ensure(&names, "evt-none-label", "/w/evt-none-label").await;
    let since = mark();
    let refused = rename(&names, &automatic, "Tab 3", NameIntent::Automatic)
        .await
        .unwrap();
    assert!(!refused.changed);
    // A first message that is itself a default label offers nothing.
    first_message(&names, &automatic, "Tab 5").await;
    assert_no_change(since, &automatic, "a default label is never a name");

    // The first native observation of a provider-level name only records
    // the provider's baseline.
    let baseline = pending("evt-none-baseline");
    ensure(&names, "evt-none-baseline", "/w/evt-none-baseline").await;
    rename(&names, &baseline, "Agent title", NameIntent::Automatic)
        .await
        .unwrap();
    let since = mark();
    let observed = observe(&names, &baseline, "Native title").await;
    assert_eq!(observed.record.name, "Agent title");
    assert_no_change(
        since,
        &baseline,
        "a first observation only records the baseline",
    );
}

#[tokio::test]
async fn no_event_for_post_completion_imports() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let target = claude("evt-post-import");
    hydrate(
        &names,
        "evt-post-import",
        Some("Draft the quarterly report"),
        None,
    )
    .await;
    names
        .complete_legacy_migration()
        .await
        .expect("the consolidation completes");
    let since = mark();

    let result = names
        .import_legacy(LegacyNameImport {
            version: 1,
            import_id: "evt-post-import-browser".to_string(),
            evidence: vec![LegacyEvidenceEnvelope {
                storage_key: "freshell.layout.v3.window-evt".to_string(),
                raw: json!({ "version": 4, "tabs": { "tabs": [] }, "panes": {} }).to_string(),
            }],
            candidates: vec![label_candidate(
                "evt-post-import-candidate",
                "evt-post-import",
                "Tab 6",
                "freshell.layout.v3.window-evt#tab-1",
            )],
        })
        .await
        .expect("the import is acknowledged");

    assert_eq!(
        result.acknowledged,
        vec!["evt-post-import-candidate".to_string()]
    );
    assert_no_change(
        since,
        &target,
        "a browser import after completion writes nothing",
    );
}

/// A door's identity table: one terminal, bound to whatever the test sets.
#[derive(Default)]
struct SwitchBinder {
    bound: Mutex<Option<SessionNameRef>>,
}

impl TerminalNameBinder for SwitchBinder {
    fn set_name_binding(
        &self,
        _terminal_id: &str,
        name_ref: &SessionNameRef,
        _naming_handle: Option<&str>,
    ) {
        *self.bound.lock().unwrap() = Some(name_ref.clone());
    }

    fn name_ref_of(&self, _terminal_id: &str) -> Option<SessionNameRef> {
        self.bound.lock().unwrap().clone()
    }

    fn naming_handle_of(&self, _terminal_id: &str) -> Option<String> {
        None
    }

    fn durable_session_of(&self, _terminal_id: &str) -> Option<(String, String)> {
        None
    }
}

#[tokio::test]
async fn no_event_for_a_conversation_switch() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let (a, b) = (claude("evt-switch-a"), claude("evt-switch-b"));
    hydrate(&names, "evt-switch-a", None, None).await;
    rename(&names, &a, "Alpha", NameIntent::User).await.unwrap();
    hydrate(&names, "evt-switch-b", None, None).await;
    rename(&names, &b, "Beta", NameIntent::User).await.unwrap();
    let registry = TerminalRegistry::new();
    registry.register_headless(HeadlessTerminal {
        terminal_id: "T-evt-switch".to_string(),
        stream_id: "S-evt-switch".to_string(),
        mode: "claude".to_string(),
        resume_session_id: None,
        create_request_id: None,
        created_at: Some(1_000),
    });
    registry.set_naming("T-evt-switch", Some(a.clone()), None);
    let binder = SwitchBinder::default();
    binder.set_name_binding("T-evt-switch", &b, None);
    let sink: Arc<dyn SessionNaming> = names.clone();
    let since = mark();

    // The conversation moved from A to B: the row adopts B's saved name.
    let outcome =
        follow_identity_name_ref(Some(&sink), &registry, &binder, "T-evt-switch", "Claude").await;

    assert!(
        matches!(&outcome, Some(NamingBindOutcome::Bound { record, .. }) if record.name == "Beta"),
        "{outcome:?}"
    );
    assert_no_change(since, &a, "a switch changes no saved name");
    assert_no_change(since, &b, "a switch changes no saved name");
}

#[tokio::test]
async fn no_event_when_commit_fails() {
    let dir = tempfile::tempdir().unwrap();
    let names = open_store(dir.path());
    let target = pending("evt-commit-fails");
    ensure(&names, "evt-commit-fails", "/w/evt-commit-fails").await;
    set_test_hooks(dir.path(), vec![TestHook::PreReplace]);
    let since = mark();

    let failed = rename(&names, &target, "Never saved", NameIntent::User).await;

    assert!(
        matches!(failed, Err(NameError::Persistence(_))),
        "{failed:?}"
    );
    assert_no_change(since, &target, "an uncommitted change is not logged");

    // The same rename, committed, is logged once.
    clear_test_hooks(dir.path());
    let since = mark();
    let saved = rename(&names, &target, "Never saved", NameIntent::User)
        .await
        .unwrap();
    assert_eq!(one_change(since, &target).new, new_of(&saved));
}

// A commit whose durable replace ends uncertain, logged once confirmed.
#[path = "session_name_events_uncertain_tests.rs"]
mod uncertain;

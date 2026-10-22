//! Name-reliability Task 4 (LB-B1): sweep maintenance — self-heal
//! replacements and staged native baselines — lands in ONE store transaction
//! per sweep pass covering at most [`SWEEP_MAINTENANCE_BATCH`] records, so a
//! post-deploy burst of heals never starves renames and binds.

use std::path::Path;
use std::sync::Arc;

use freshell_freshagent::naming::{NameActivityReason, NativeNameOrigin};
use freshell_protocol::session_names::{NameIntent, NameSource, NamedProvider};

use super::super::*;
use super::{SweepMaintenanceItem, SWEEP_MAINTENANCE_BATCH};

fn temp_dir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn open(dir: &Path) -> Arc<SessionNames> {
    SessionNames::open(dir.to_path_buf()).expect("open store")
}

fn session(id: &str) -> SessionNameRef {
    SessionNameRef::Session {
        provider: NamedProvider::Claude,
        session_id: id.to_string(),
    }
}

fn indexed(
    id: &str,
    provider_title: Option<&str>,
    first_message: Option<&str>,
) -> IndexedNameInput {
    IndexedNameInput {
        provider: NamedProvider::Claude,
        session_id: id.to_string(),
        cwd: Some("/w/proj".to_string()),
        first_user_message: first_message.map(str::to_string),
        provider_title: provider_title.map(str::to_string),
    }
}

fn heal_message(i: usize) -> String {
    format!("Fix the importer number {i}")
}

/// `count` claude sessions whose saved name is a junk provider-level
/// "Tab N" and whose first message is already absorbed at rest — exactly
/// the post-deploy shape: the only work each one has is the heal.
async fn seed_junk(store: &Arc<SessionNames>, count: usize) {
    for i in 0..count {
        store
            .hydrate_indexed(
                indexed(
                    &format!("s-junk-{i}"),
                    Some(&format!("Tab {i}")),
                    Some(&heal_message(i)),
                ),
                true,
            )
            .await
            .expect("seed junk record");
    }
}

async fn name_of(store: &Arc<SessionNames>, id: &str) -> Option<SessionNameRecord> {
    store
        .get(vec![session(id)])
        .await
        .expect("get")
        .into_iter()
        .next()
        .map(|update| update.record)
}

async fn healed_count(store: &Arc<SessionNames>, count: usize) -> usize {
    let mut healed = 0;
    for i in 0..count {
        let record = name_of(store, &format!("s-junk-{i}"))
            .await
            .expect("record");
        if record.name == heal_message(i) && record.source == NameSource::FirstMessage {
            healed += 1;
        }
    }
    healed
}

fn sweep_rows(count: usize) -> Vec<crate::auto_title_sweep::SweepSession> {
    (0..count)
        .map(|i| crate::auto_title_sweep::SweepSession {
            provider: "claude".into(),
            session_id: format!("s-junk-{i}"),
            cwd: Some("/w/proj".into()),
            title: None,
            first_user_message: Some(heal_message(i)),
            title_source: None,
            git_branch: None,
        })
        .collect()
}

fn sweep_state(
    home: &Path,
    names: Arc<SessionNames>,
) -> crate::auto_title_sweep::AutoTitleSweepState {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(256);
    crate::auto_title_sweep::AutoTitleSweepState {
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
        // A later (non-boot) pass: every indexed session feeds activity.
        index_hydrated: Arc::new(std::sync::atomic::AtomicBool::new(true)),
    }
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

/// 60 junk names heal in exactly three sweep passes with ONE maintenance
/// commit each (≤ ceil(60/25) = 3 in total), a user rename issued while
/// each batch runs succeeds, a settled fourth pass transacts zero times,
/// and a row whose work is an insert (and then an arm) still transacts on
/// its own.
#[tokio::test]
async fn sweep_maintenance_is_batched_and_leaves_room_for_renames() {
    let home = temp_dir();
    let data_dir = home.path().join(".freshell");
    let store = open(&data_dir);
    const JUNK: usize = 60;
    seed_junk(&store, JUNK).await;
    store
        .hydrate_indexed(indexed("s-user", None, None), false)
        .await
        .expect("seed the rename target");
    let sweep = sweep_state(home.path(), store.clone());
    let rows = sweep_rows(JUNK);

    let mut pass_transactions = Vec::new();
    for pass in 0..3 {
        let before = test_store_transaction_count(&data_dir);
        let rename = store.rename(RenameNameInput {
            target: session("s-user"),
            name: format!("Renamed during pass {pass}"),
            intent: NameIntent::User,
            if_revision: None,
            cwd: None,
        });
        let (_, renamed) = tokio::join!(
            crate::auto_title_sweep::run_auto_title_pass(&sweep, &rows),
            rename
        );
        let renamed = renamed.unwrap_or_else(|error| {
            panic!("pass {pass}: a rename during the batch must succeed: {error}")
        });
        assert_eq!(renamed.record.name, format!("Renamed during pass {pass}"));
        let after = test_store_transaction_count(&data_dir);
        // The rename is one transaction; the pass made the rest.
        pass_transactions.push(after - before - 1);
        let expected_healed = ((pass + 1) * SWEEP_MAINTENANCE_BATCH).min(JUNK);
        assert_eq!(
            healed_count(&store, JUNK).await,
            expected_healed,
            "pass {pass} healed at most one batch"
        );
    }
    assert_eq!(
        pass_transactions,
        vec![1, 1, 1],
        "each pass made exactly one maintenance commit"
    );

    // Settled: the fourth pass transacts zero times.
    let before = test_store_transaction_count(&data_dir);
    crate::auto_title_sweep::run_auto_title_pass(&sweep, &rows).await;
    assert_eq!(test_store_transaction_count(&data_dir), before, "settled");

    // A genuinely new session is an insert (and its first message an arm):
    // per-row transactions, never deferred to a batch.
    let mut with_new = sweep_rows(JUNK);
    with_new.push(crate::auto_title_sweep::SweepSession {
        provider: "claude".into(),
        session_id: "s-new".into(),
        cwd: Some("/w/proj".into()),
        title: None,
        first_user_message: Some("A brand new session".into()),
        title_source: None,
        git_branch: None,
    });
    let before = test_store_transaction_count(&data_dir);
    crate::auto_title_sweep::run_auto_title_pass(&sweep, &with_new).await;
    assert_eq!(
        test_store_transaction_count(&data_dir) - before,
        2,
        "the insert and the arm each transact on their own"
    );
    let inserted = name_of(&store, "s-new")
        .await
        .expect("the new record installed");
    assert_eq!(inserted.name, "A brand new session");
    assert!(
        store
            .generation_work_snapshot()
            .iter()
            .any(|item| item.target == session("s-new")),
        "the new session's message armed generation"
    );
}

/// The store caps one batch at the batch size: the rest waits.
#[tokio::test]
async fn maintenance_batch_caps_at_the_batch_size() {
    let dir = temp_dir();
    let store = open(dir.path());
    seed_junk(&store, 30).await;
    let items: Vec<SweepMaintenanceItem> = (0..30)
        .map(|i| SweepMaintenanceItem {
            hydrate: Some(indexed(
                &format!("s-junk-{i}"),
                None,
                Some(&heal_message(i)),
            )),
            activity: None,
        })
        .collect();
    let before = test_store_transaction_count(dir.path());
    let report = store.sweep_maintenance(items).await.expect("batch");
    assert_eq!(test_store_transaction_count(dir.path()) - before, 1);
    assert_eq!(report.healed, SWEEP_MAINTENANCE_BATCH);
    assert_eq!(report.deferred, 30 - SWEEP_MAINTENANCE_BATCH);
    assert_eq!(healed_count(&store, 30).await, SWEEP_MAINTENANCE_BATCH);
}

/// Staged native baselines fill whatever room the heals leave, and an
/// empty batch with nothing staged is not a transaction at all.
#[tokio::test]
async fn staged_baselines_fill_the_rest_of_the_batch() {
    let dir = temp_dir();
    let store = open(dir.path());
    // Three real provider-level names observed for the first time: each
    // observation stages its baseline without a write.
    for id in ["s-base-a", "s-base-b", "s-base-c"] {
        store
            .hydrate_indexed(indexed(id, Some("Billing bug"), None), false)
            .await
            .expect("seed");
        let generation = store.core.current_view().document.document_generation;
        store
            .observe_native(NativeNameObservation {
                target: session(id),
                title: format!("Provider title for {id}"),
                origin: NativeNameOrigin::Snapshot,
                location_revision: 0,
                event_id: None,
            })
            .await
            .expect("observe");
        assert_eq!(
            store.core.current_view().document.document_generation,
            generation,
            "{id}: staging is not a write"
        );
    }
    assert!(store.has_staged_native_baselines());

    // 24 heals + 3 baselines: one batch takes the 24 heals and ONE baseline.
    seed_junk(&store, 24).await;
    let items: Vec<SweepMaintenanceItem> = (0..24)
        .map(|i| SweepMaintenanceItem {
            hydrate: Some(indexed(
                &format!("s-junk-{i}"),
                None,
                Some(&heal_message(i)),
            )),
            activity: None,
        })
        .collect();
    let report = store.sweep_maintenance(items).await.expect("batch 1");
    assert_eq!(report.healed, 24);
    assert_eq!(report.baselines, 1);
    assert!(store.has_staged_native_baselines(), "two baselines wait");

    let report = store.sweep_maintenance(Vec::new()).await.expect("batch 2");
    assert_eq!(report.baselines, 2);
    assert!(!store.has_staged_native_baselines());
    let document = store.core.current_view().document.clone();
    for id in ["s-base-a", "s-base-b", "s-base-c"] {
        assert_eq!(
            document
                .native_write
                .get(&name_ref_key(&session(id)))
                .and_then(|state| state.last_native_title.clone()),
            Some(format!("Provider title for {id}")),
            "{id}: persisted"
        );
    }

    let before = test_store_transaction_count(dir.path());
    let report = store
        .sweep_maintenance(Vec::new())
        .await
        .expect("empty batch");
    assert_eq!(report.healed + report.baselines, 0);
    assert_eq!(
        test_store_transaction_count(dir.path()),
        before,
        "nothing to do is no transaction"
    );
}

/// An activity heal queued for the batch is re-planned on the freshly read
/// document: if the record moved meanwhile (a user rename), the batch
/// applies nothing to it.
#[tokio::test]
async fn a_batch_item_is_re_planned_on_the_fresh_document() {
    let dir = temp_dir();
    let store = open(dir.path());
    seed_junk(&store, 1).await;
    let target = session("s-junk-0");
    store
        .rename(RenameNameInput {
            target: target.clone(),
            name: "Chosen by a person".into(),
            intent: NameIntent::User,
            if_revision: None,
            cwd: None,
        })
        .await
        .expect("user rename");
    let report = store
        .sweep_maintenance(vec![SweepMaintenanceItem {
            hydrate: None,
            activity: Some(NameActivity {
                target: target.clone(),
                mode: "claude".into(),
                event_id: "e".into(),
                reason: NameActivityReason::IndexUserMessage,
                first_user_message: Some(heal_message(0)),
                cwd: Some("/w/proj".into()),
            }),
        }])
        .await
        .expect("batch");
    assert_eq!(report.healed, 0);
    let record = name_of(&store, "s-junk-0").await.expect("record");
    assert_eq!(record.name, "Chosen by a person");
    assert_eq!(record.source, NameSource::Manual);
}

async fn observe_title(store: &Arc<SessionNames>, id: &str, title: &str) -> SessionNameUpdate {
    store
        .observe_native(NativeNameObservation {
            target: session(id),
            title: title.to_string(),
            origin: NativeNameOrigin::Snapshot,
            location_revision: 0,
            event_id: None,
        })
        .await
        .expect("observe")
}

fn persisted_baseline(store: &Arc<SessionNames>, id: &str) -> Option<String> {
    store
        .core
        .current_view()
        .document
        .native_write
        .get(&name_ref_key(&session(id)))
        .and_then(|state| state.last_native_title.clone())
}

/// Two current-build processes share one data dir. Process A staged a
/// baseline it saw over an empty one; process B then persisted a NEWER
/// baseline, and an automation rename landed after it. Returns both
/// stores, A's staged baseline still waiting.
async fn superseded_staging(dir: &Path, id: &str) -> (Arc<SessionNames>, Arc<SessionNames>) {
    let a = open(dir);
    a.hydrate_indexed(indexed(id, Some("Billing bug"), None), false)
        .await
        .expect("seed");
    observe_title(&a, id, "Older provider title").await;
    assert_eq!(
        a.staged_native_baseline(&session(id)).as_deref(),
        Some("Older provider title"),
        "A staged its first observation"
    );
    let b = open(dir);
    observe_title(&b, id, "Newer provider title").await;
    b.sweep_maintenance(Vec::new())
        .await
        .expect("B persists its baseline");
    assert_eq!(
        persisted_baseline(&b, id).as_deref(),
        Some("Newer provider title")
    );
    let renamed = b
        .rename(RenameNameInput {
            target: session(id),
            name: "Chosen by automation".into(),
            intent: NameIntent::Automatic,
            if_revision: None,
            cwd: Some("/w/proj".into()),
        })
        .await
        .expect("automation rename");
    assert_eq!(renamed.record.name, "Chosen by automation");
    (a, b)
}

/// A's batch never writes its older staged baseline over B's newer
/// persisted one: the provider's next re-report of B's title stays an
/// echo and never undoes the automation rename.
#[tokio::test]
async fn a_staged_baseline_never_overwrites_a_newer_persisted_one() {
    let dir = temp_dir();
    let id = "s-two-writers-batch";
    let (a, b) = superseded_staging(dir.path(), id).await;

    let report = a.sweep_maintenance(Vec::new()).await.expect("A's batch");
    assert_eq!(
        persisted_baseline(&a, id).as_deref(),
        Some("Newer provider title"),
        "the newer persisted baseline survives A's batch"
    );
    assert_eq!(report.baselines, 0, "the superseded baseline is dropped");
    assert!(
        !a.has_staged_native_baselines(),
        "A no longer holds the superseded baseline"
    );

    let echo = observe_title(&b, id, "Newer provider title").await;
    assert!(!echo.changed, "the provider's re-report is an echo");
    assert_eq!(
        name_of(&a, id).await.expect("record").name,
        "Chosen by automation",
        "the automation rename stands"
    );
}

/// Before any batch runs, A's own decisions never read its superseded
/// staged baseline either: the provider's re-report, observed through A,
/// is compared with B's newer persisted baseline and stays an echo.
#[tokio::test]
async fn a_superseded_staged_baseline_is_never_read_as_the_baseline() {
    let dir = temp_dir();
    let id = "s-two-writers-observe";
    let (a, _b) = superseded_staging(dir.path(), id).await;

    let echo = observe_title(&a, id, "Newer provider title").await;
    assert_eq!(
        echo.record.name, "Chosen by automation",
        "a re-report of the newer persisted baseline never undoes the rename"
    );
    assert!(!echo.changed);
    assert!(
        !a.has_staged_native_baselines(),
        "A dropped the superseded baseline"
    );
}

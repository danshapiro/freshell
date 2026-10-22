//! Name-reliability Task 5 (D4, RC12): the first-message fallback is offered
//! on every activity that carries a first user message (an open or resumed
//! session, not only a newly accepted or indexed message), tool wrapper text
//! is never a first-message name and never generation input, a re-derived
//! first message rests instead of arming background naming, and the OpenCode
//! first-message lookup sees the session's folder. Driven through the REAL
//! store on a temp data dir; nothing here is mocked.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use freshell_freshagent::naming::NameActivityReason;
use freshell_protocol::native_location::{NativeEvidenceKind, NativePersistence};
use freshell_protocol::session_names::{NameIntent, NameSource, NamedProvider};

use super::*;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SARDINE: &str = "Fix the sardine importer";
const RECOMMENDED_PLUGINS: &str =
    "<recommended_plugins>\n- github: review pull requests\n</recommended_plugins>";

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

/// Rewrite the document on disk (under the sidecar lock, one generation
/// later — what another current-build process committing would leave) to set
/// up a state no public path produces directly (a series the old extraction
/// armed with wrapper text, an exhausted series). Callers reopen the store.
fn rewrite(dir: &Path, change: impl FnOnce(&mut StoredDocument)) {
    let mut document = raw_document(dir);
    change(&mut document);
    document.document_generation += 1;
    let bytes = serialize_document(&document).expect("serialize rewritten document");
    let lock = open_lock_file(&dir.join(LOCK_FILE_NAME)).expect("open lock");
    let deadline = Instant::now() + LOCK_RETRY_BUDGET;
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) => {
                assert!(Instant::now() < deadline, "lock stayed busy");
                std::thread::sleep(LOCK_POLL_INTERVAL);
            }
            Err(error) => panic!("lock for rewrite: {error}"),
        }
    }
    std::fs::write(dir.join(DOCUMENT_FILE_NAME), bytes).expect("write rewritten document");
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

/// A directory record named after `/w/work` ("work"), no series.
async fn directory_record(
    store: &Arc<SessionNames>,
    provider: NamedProvider,
    id: &str,
) -> SessionNameRef {
    let seeded = seed(
        store,
        indexed(provider, id, Some("/w/work"), None, None),
        false,
    )
    .await;
    assert_eq!(seeded.record.name, "work");
    assert_eq!(seeded.record.source, NameSource::Directory);
    session(provider, id)
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

fn activity_input(
    target: &SessionNameRef,
    reason: NameActivityReason,
    message: Option<&str>,
) -> NameActivity {
    NameActivity {
        target: target.clone(),
        mode: match target {
            SessionNameRef::Session { provider, .. } => provider.as_str().to_string(),
            SessionNameRef::Pending { .. } => "claude".to_string(),
        },
        event_id: "event-1".to_string(),
        reason,
        first_user_message: message.map(str::to_string),
        cwd: Some("/w/work".to_string()),
    }
}

async fn activity(
    store: &Arc<SessionNames>,
    target: &SessionNameRef,
    reason: NameActivityReason,
    message: Option<&str>,
) -> SessionNameUpdate {
    store
        .activity(activity_input(target, reason, message))
        .await
        .expect("activity folds")
}

fn series_of(dir: &Path, target: &SessionNameRef) -> Option<GenerationState> {
    raw_document(dir)
        .generation
        .get(&name_ref_key(target))
        .cloned()
}

fn armed(store: &Arc<SessionNames>, target: &SessionNameRef) -> bool {
    store
        .generation_work_snapshot()
        .iter()
        .any(|item| &item.target == target)
}

/// A series that stores `message` as its generation input, at `status`.
fn series_with_input(message: &str, status: GenerationStatus, consumed: u32) -> GenerationState {
    GenerationState {
        status,
        series_id: "series-wrapper".to_string(),
        input_fingerprint: Some(fingerprint_message(message)),
        excerpt: Some(excerpt_of(message)),
        attempt_ids: Vec::new(),
        attempt_starts: Vec::new(),
        consumed,
        next_due: None,
        exhausted_at: None,
    }
}

fn codex_acquisition() -> NativeAcquisition {
    NativeAcquisition {
        location: NativeLocation::Codex {
            codex_home: "/w/homes/codex".to_string(),
            native_thread_id: Some("thread_1".to_string()),
            rollout_path: Some("/w/homes/codex/rollout-1.jsonl".to_string()),
            persistence_evidence: Some("thread_started_notification".to_string()),
        },
        evidence: NativeEvidenceKind::InitializedRuntime,
        persistence: NativePersistence::Verified,
    }
}

// ---------------------------------------------------------------------------
// The fallback on every activity that carries a first message (D4)
// ---------------------------------------------------------------------------

/// An open session (the sweep's `Opened` edge for a live terminal) gets its
/// first-message name; before, only accepted/indexed messages offered it,
/// so a terminal pane kept its folder name whenever AI naming failed.
#[tokio::test]
async fn opened_activity_offers_first_message_fallback() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = directory_record(&store, NamedProvider::Claude, "s-opened").await;
    let message = "SMS isn't updating. Root cause why.";
    let update = activity(&store, &target, NameActivityReason::Opened, Some(message)).await;
    assert_eq!(update.record.name, message);
    assert_eq!(update.record.source, NameSource::FirstMessage);
    assert_eq!(get_one(&store, &target).await.name, message);
}

#[tokio::test]
async fn resumed_activity_offers_first_message_fallback() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = directory_record(&store, NamedProvider::Codex, "s-resumed").await;
    let message = "SMS isn't updating. Root cause why.";
    let update = activity(&store, &target, NameActivityReason::Resumed, Some(message)).await;
    assert_eq!(update.record.name, message);
    assert_eq!(update.record.source, NameSource::FirstMessage);
}

/// Pinning test: the fallback never lowers a real name's rank, whatever
/// the activity reason.
#[tokio::test]
async fn fallback_never_lowers_rank() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Claude, "s-ranked");
    seed(
        &store,
        indexed(
            NamedProvider::Claude,
            "s-ranked",
            Some("/w/work"),
            Some("Billing bug"),
            None,
        ),
        false,
    )
    .await;
    let before = get_one(&store, &target).await;
    assert_eq!(before.source, NameSource::ProviderAi);
    for reason in [
        NameActivityReason::Opened,
        NameActivityReason::Resumed,
        NameActivityReason::AcceptedUserMessage,
        NameActivityReason::IndexUserMessage,
    ] {
        activity(&store, &target, reason, Some(SARDINE)).await;
        let after = get_one(&store, &target).await;
        assert_eq!(after.name, "Billing bug", "{reason:?} kept the real name");
        assert_eq!(after.source, NameSource::ProviderAi);
        assert_eq!(
            after.revision, before.revision,
            "{reason:?} changed nothing visible"
        );
    }
}

/// The free fallback does not depend on AI naming: an exhausted series (AI
/// naming gave up) still lets an open session take its first message, and
/// the series stays exhausted.
#[tokio::test]
async fn fallback_is_independent_of_generation_exhaustion() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = directory_record(&store, NamedProvider::Claude, "s-exhausted").await;
    rewrite(dir.path(), |document| {
        let mut series =
            series_with_input(SARDINE, GenerationStatus::Exhausted, MAX_GENERATION_STARTS);
        series.excerpt = None;
        series.exhausted_at = Some(1);
        document.generation.insert(name_ref_key(&target), series);
    });
    let store = open(dir.path());
    let update = activity(&store, &target, NameActivityReason::Opened, Some(SARDINE)).await;
    assert_eq!(update.record.name, SARDINE);
    assert_eq!(update.record.source, NameSource::FirstMessage);
    let series = series_of(dir.path(), &target).expect("series kept");
    assert_eq!(series.status, GenerationStatus::Exhausted);
    assert_eq!(series.consumed, MAX_GENERATION_STARTS);
    assert!(!armed(&store, &target));
}

// ---------------------------------------------------------------------------
// Wrapper text is never a name (RC12)
// ---------------------------------------------------------------------------

/// A first message that is tool wrapper text is never offered as a name,
/// and never arms AI naming from it.
#[tokio::test]
async fn wrapper_first_message_is_never_a_fallback() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = directory_record(&store, NamedProvider::Codex, "s-wrapper").await;
    for reason in [
        NameActivityReason::AcceptedUserMessage,
        NameActivityReason::IndexUserMessage,
        NameActivityReason::Opened,
    ] {
        let update = activity(&store, &target, reason, Some(RECOMMENDED_PLUGINS)).await;
        assert_eq!(update.record.name, "work", "{reason:?}: no wrapper name");
        assert_eq!(update.record.source, NameSource::Directory);
    }
    assert!(
        !armed(&store, &target),
        "wrapper text is never generation input"
    );
}

/// Hydration (the sweep's insert of a new record) never installs wrapper
/// text as a first-message name, nor absorbs it as generation input: the
/// ladder falls through to the folder name.
#[tokio::test]
async fn hydrate_never_installs_or_absorbs_wrapper_text() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Codex, "s-hydrate-wrapper");
    let seeded = seed(
        &store,
        indexed(
            NamedProvider::Codex,
            "s-hydrate-wrapper",
            Some("/w/work"),
            None,
            Some(RECOMMENDED_PLUGINS),
        ),
        true,
    )
    .await;
    assert_eq!(seeded.record.name, "work");
    assert_eq!(seeded.record.source, NameSource::Directory);
    assert!(
        series_of(dir.path(), &target).is_none(),
        "no series stores wrapper text"
    );
}

/// A saved name that IS wrapper text (171 on the live copy) heals to the
/// real first message the re-derived index now offers — the same rank, so
/// only the self-heal rule lets it through. Like the live records, the
/// session's series absorbed the wrapper text at rest (Idle, never
/// attempted); the heal re-absorbs the real message without arming.
#[tokio::test]
async fn wrapper_first_message_record_heals_to_the_real_first_message() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Codex, "s-wrapper-name");
    seed(
        &store,
        indexed(
            NamedProvider::Codex,
            "s-wrapper-name",
            Some("/w/work"),
            None,
            Some("placeholder text"),
        ),
        false,
    )
    .await;
    let wrapper_name = first_message_title_of_old_rules();
    rewrite(dir.path(), |document| {
        let record = document
            .records
            .get_mut(&name_ref_key(&target))
            .expect("seeded record");
        record.name = wrapper_name.clone();
        record.source = NameSource::FirstMessage;
        document.generation.insert(
            name_ref_key(&target),
            series_with_input(RECOMMENDED_PLUGINS, GenerationStatus::Idle, 0),
        );
    });
    let store = open(dir.path());
    let update = activity(
        &store,
        &target,
        NameActivityReason::IndexUserMessage,
        Some(SARDINE),
    )
    .await;
    assert_eq!(update.record.name, SARDINE);
    assert_eq!(update.record.source, NameSource::FirstMessage);
    assert!(
        !armed(&store, &target),
        "healing a name arms no background naming"
    );
    let series = series_of(dir.path(), &target).expect("series kept");
    assert_eq!(series.status, GenerationStatus::Idle);
    assert_eq!(
        series.excerpt.as_deref(),
        Some(SARDINE),
        "the real message rests as input"
    );
}

/// The name the old extraction saved for a `<recommended_plugins>` first
/// record: the 50-character title of the raw wrapper text.
fn first_message_title_of_old_rules() -> String {
    freshell_sessions::text::extract_title_from_message(RECOMMENDED_PLUGINS, 50)
}

// ---------------------------------------------------------------------------
// Re-absorb at rest (V2 decision B)
// ---------------------------------------------------------------------------

/// A re-derived first message (the extraction rules changed; a real first
/// message never changes) refreshes the input of an Idle, never-attempted
/// series without arming it in the background; an explicit open then arms
/// it with the new excerpt.
#[tokio::test]
async fn changed_first_message_on_an_idle_series_reabsorbs_without_arming() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = session(NamedProvider::Codex, "s-reabsorb");
    seed(
        &store,
        indexed(
            NamedProvider::Codex,
            "s-reabsorb",
            Some("/w/work"),
            None,
            Some("An older first message"),
        ),
        true,
    )
    .await;
    let before = series_of(dir.path(), &target).expect("absorbed series");
    assert_eq!(before.status, GenerationStatus::Idle);

    activity(
        &store,
        &target,
        NameActivityReason::IndexUserMessage,
        Some(SARDINE),
    )
    .await;
    let rested = series_of(dir.path(), &target).expect("series kept");
    assert_eq!(
        rested.status,
        GenerationStatus::Idle,
        "rests, never armed in the background"
    );
    assert_eq!(rested.consumed, 0);
    assert_eq!(rested.series_id, before.series_id);
    assert_eq!(rested.input_fingerprint, Some(fingerprint_message(SARDINE)));
    assert_eq!(rested.excerpt.as_deref(), Some(SARDINE));
    assert!(!armed(&store, &target));
    let claim = store
        .claim_generation_start(target.clone(), "attempt-rest".to_string())
        .await
        .expect("claim runs");
    assert!(claim.is_none(), "a resting series is not claimable");
    assert_eq!(series_of(dir.path(), &target).expect("series").consumed, 0);

    activity(&store, &target, NameActivityReason::Opened, Some(SARDINE)).await;
    let opened = series_of(dir.path(), &target).expect("series");
    assert_eq!(
        opened.status,
        GenerationStatus::Eligible,
        "an explicit open arms it"
    );
    assert_eq!(opened.excerpt.as_deref(), Some(SARDINE));
    assert!(armed(&store, &target));
}

// ---------------------------------------------------------------------------
// The prompt-input guard (V2)
// ---------------------------------------------------------------------------

/// A series whose stored input is wrapper text (stored by the old
/// extraction) is never armed from it: an activity without a real first
/// message drops the stored input, a pending bind (the explicit-open hook)
/// leaves it Idle, and a claim forced on it consumes nothing.
#[tokio::test]
async fn wrapper_excerpt_is_never_armed() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = directory_record(&store, NamedProvider::Codex, "s-wrapper-input").await;
    let key = name_ref_key(&target);
    let plant = |dir: &Path, status: GenerationStatus| {
        rewrite(dir, |document| {
            document.generation.insert(
                key.clone(),
                series_with_input(RECOMMENDED_PLUGINS, status, 0),
            );
        });
    };

    // An Opened activity with no first message drops the stored input.
    plant(dir.path(), GenerationStatus::Idle);
    let store = open(dir.path());
    activity(&store, &target, NameActivityReason::Opened, None).await;
    let dropped = series_of(dir.path(), &target).expect("series kept");
    assert_eq!(dropped.status, GenerationStatus::Idle);
    assert_eq!(
        dropped.input_fingerprint, None,
        "the wrapper input is dropped"
    );
    assert_eq!(dropped.excerpt, None);
    assert_eq!(dropped.consumed, 0);
    assert!(!armed(&store, &target));

    // A pending bind to the session (an explicit open) leaves it Idle.
    plant(dir.path(), GenerationStatus::Idle);
    let store = open(dir.path());
    store
        .ensure_pending(PendingNameInput {
            handle: "h-wrapper-input".to_string(),
            provider: NamedProvider::Codex,
            cwd: Some("/w/work".to_string()),
        })
        .await
        .expect("ensure pending");
    store
        .bind_pending(BindNameInput {
            pending: SessionNameRef::Pending {
                id: "h-wrapper-input".to_string(),
            },
            target: target.clone(),
            acquisition: codex_acquisition(),
        })
        .await
        .expect("bind");
    let bound = series_of(dir.path(), &target).expect("series kept");
    assert_eq!(
        bound.status,
        GenerationStatus::Idle,
        "the bind never arms wrapper input"
    );
    assert_eq!(bound.excerpt, None, "the bind drops the wrapper input");
    assert!(!armed(&store, &target));

    // A claim forced on an Eligible wrapper series consumes nothing, and
    // the series stops being offered to the worker.
    plant(dir.path(), GenerationStatus::Eligible);
    let store = open(dir.path());
    assert!(
        armed(&store, &target),
        "sanity: the planted series is offered"
    );
    let claim = store
        .claim_generation_start(target.clone(), "attempt-wrapper".to_string())
        .await
        .expect("claim runs");
    assert!(claim.is_none(), "wrapper text is never sent to the model");
    let refused = series_of(dir.path(), &target).expect("series kept");
    assert_eq!(refused.consumed, 0, "the refusal consumed nothing");
    assert!(refused.attempt_ids.is_empty());
    assert!(
        !armed(&store, &target),
        "the refused series is no longer offered"
    );
}

/// Pinning the other side of the guard: an activity carrying a real first
/// message replaces the wrapper input and arms with it.
#[tokio::test]
async fn wrapper_excerpt_is_replaced_by_a_real_message() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = directory_record(&store, NamedProvider::Codex, "s-wrapper-replace").await;
    rewrite(dir.path(), |document| {
        document.generation.insert(
            name_ref_key(&target),
            series_with_input(RECOMMENDED_PLUGINS, GenerationStatus::Idle, 0),
        );
    });
    let store = open(dir.path());
    activity(&store, &target, NameActivityReason::Opened, Some(SARDINE)).await;
    let series = series_of(dir.path(), &target).expect("series");
    assert_eq!(series.status, GenerationStatus::Eligible);
    assert_eq!(series.excerpt.as_deref(), Some(SARDINE));
    assert_eq!(series.input_fingerprint, Some(fingerprint_message(SARDINE)));
    assert!(armed(&store, &target));
}

// ---------------------------------------------------------------------------
// The targeted first-message lookup sees the folder (C5)
// ---------------------------------------------------------------------------

/// Whether a session still needs its first message: no record, a record
/// below `first_message`, or a junk record under the row's folder. A real
/// first-message name, a provider name, a protected name, and a folder name
/// whose folder is unknown do not.
#[tokio::test]
async fn needs_first_message_input_follows_the_folder() {
    let dir = temp_dir();
    let store = open(dir.path());
    let folder = "/home/dan/code/freshell";

    assert!(store
        .needs_first_message_input(&session(NamedProvider::Opencode, "ses_none"), Some(folder)));

    let directory = directory_record(&store, NamedProvider::Opencode, "ses_dir").await;
    assert!(store.needs_first_message_input(&directory, Some("/w/work")));

    let named = session(NamedProvider::Opencode, "ses_first");
    seed(
        &store,
        indexed(
            NamedProvider::Opencode,
            "ses_first",
            Some(folder),
            None,
            Some(SARDINE),
        ),
        false,
    )
    .await;
    assert!(!store.needs_first_message_input(&named, Some(folder)));

    let provider = session(NamedProvider::Opencode, "ses_provider");
    seed(
        &store,
        indexed(
            NamedProvider::Opencode,
            "ses_provider",
            Some(folder),
            Some("Billing bug"),
            None,
        ),
        false,
    )
    .await;
    assert!(!store.needs_first_message_input(&provider, Some(folder)));

    let folder_named = session(NamedProvider::Opencode, "ses_folder_named");
    seed(
        &store,
        indexed(
            NamedProvider::Opencode,
            "ses_folder_named",
            Some(folder),
            Some("freshell"),
            None,
        ),
        false,
    )
    .await;
    assert_eq!(
        get_one(&store, &folder_named).await.source,
        NameSource::ProviderAi
    );
    assert!(store.needs_first_message_input(&folder_named, Some(folder)));
    assert!(
        !store.needs_first_message_input(&folder_named, None),
        "without the folder only folder-free labels are recognized"
    );

    let manual = session(NamedProvider::Opencode, "ses_manual");
    seed(
        &store,
        indexed(
            NamedProvider::Opencode,
            "ses_manual",
            Some(folder),
            None,
            None,
        ),
        false,
    )
    .await;
    store
        .rename(RenameNameInput {
            target: manual.clone(),
            name: "freshell".to_string(),
            intent: NameIntent::User,
            if_revision: None,
            cwd: None,
        })
        .await
        .expect("user rename");
    assert!(
        !store.needs_first_message_input(&manual, Some(folder)),
        "a name a person chose stays"
    );
}

// ---------------------------------------------------------------------------
// The sweep (one pass at a time, against the real store)
// ---------------------------------------------------------------------------

/// An index source whose only job is the targeted OpenCode first-message
/// lookup the sweep makes for rows whose listing carries no first message:
/// scripted answers, every read counted.
#[derive(Default)]
struct ScriptedFirstMessages {
    messages: std::sync::Mutex<std::collections::HashMap<String, String>>,
    lookups: std::sync::atomic::AtomicUsize,
}

impl ScriptedFirstMessages {
    fn answer(&self, session_id: &str, message: &str) {
        self.messages
            .lock()
            .unwrap()
            .insert(session_id.to_string(), message.to_string());
    }

    fn lookups(&self) -> usize {
        self.lookups.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// Forwarding wrapper so the test keeps a handle on the counters while the
/// index owns the source.
struct SharedScript(Arc<ScriptedFirstMessages>);

impl freshell_sessions::directory_index::SessionSource for SharedScript {
    fn discover(&self) -> Vec<freshell_sessions::directory_index::FileStat> {
        Vec::new()
    }

    fn parse(&self, _path: &Path) -> Option<freshell_sessions::directory_index::IndexedSession> {
        None
    }

    fn targeted_first_user_message(&self, session_id: &str) -> Option<String> {
        self.0
            .lookups
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.0.messages.lock().unwrap().get(session_id).cloned()
    }
}

fn scripted_index(
    script: &Arc<ScriptedFirstMessages>,
) -> Arc<freshell_sessions::directory_index::SessionIndex> {
    Arc::new(
        freshell_sessions::directory_index::SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(SharedScript(Arc::clone(script)))],
            std::time::Duration::from_millis(1_000),
            None,
        ),
    )
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

/// A LATER (non-boot) sweep pass's state over `names`.
fn sweep_state(
    home: &Path,
    names: Arc<SessionNames>,
    index: Option<Arc<freshell_sessions::directory_index::SessionIndex>>,
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
        index,
        index_hydrated: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        first_message_lookups: Default::default(),
    }
}

fn row(
    provider: &str,
    id: &str,
    cwd: &str,
    first: Option<&str>,
    last_activity_at: i64,
) -> crate::auto_title_sweep::SweepSession {
    crate::auto_title_sweep::SweepSession {
        provider: provider.into(),
        session_id: id.into(),
        cwd: Some(cwd.into()),
        title: None,
        first_user_message: first.map(str::to_string),
        title_source: None,
        git_branch: None,
        last_activity_at,
    }
}

/// D4 end to end in the sweep: a session open in a live terminal (the
/// sweep's `Opened` edge) whose index row carries a first user message gets
/// the first-message name in ONE pass, with AI naming unavailable. The
/// pane's folder name ("work", from the folder the pane was created in) is
/// not the transcript's folder ("/x/proj": the session moved, or the
/// provider recorded another spelling of the path), so only the activity's
/// fallback — not the hydration heal of a folder name — can name it.
#[tokio::test]
async fn sweep_names_open_terminal_session_from_first_message() {
    let dir = temp_dir();
    let names = open(dir.path());
    let target = directory_record(&names, NamedProvider::Claude, "s-live").await;
    let state = sweep_state(dir.path(), names.clone(), None);
    state.identity.upsert(
        "term-live",
        Some("claude"),
        Some("s-live"),
        Some("/x/proj"),
        1,
    );

    crate::auto_title_sweep::run_auto_title_pass(
        &state,
        &[row("claude", "s-live", "/x/proj", Some(SARDINE), 1_000)],
    )
    .await;

    let record = get_one(&names, &target).await;
    assert_eq!(record.name, SARDINE);
    assert_eq!(record.source, NameSource::FirstMessage);
}

/// An OpenCode session whose series already captured an input fingerprint
/// (so generation needs no more input) but whose record is still the
/// folder name gets the targeted lookup anyway: its first message names it
/// in one pass, and once named a later pass never reads again.
#[tokio::test]
async fn sweep_offers_fallback_for_opencode_with_existing_fingerprint() {
    let dir = temp_dir();
    let store = open(dir.path());
    let target = directory_record(&store, NamedProvider::Opencode, "ses_fingerprinted").await;
    rewrite(dir.path(), |document| {
        document.generation.insert(
            name_ref_key(&target),
            series_with_input(SARDINE, GenerationStatus::Eligible, 1),
        );
    });
    let names = open(dir.path());
    assert!(
        !names.needs_generation_input(&target),
        "sanity: generation has its input"
    );
    let script = Arc::new(ScriptedFirstMessages::default());
    script.answer("ses_fingerprinted", SARDINE);
    let state = sweep_state(dir.path(), names.clone(), Some(scripted_index(&script)));

    crate::auto_title_sweep::run_auto_title_pass(
        &state,
        &[row("opencode", "ses_fingerprinted", "/w/work", None, 1_000)],
    )
    .await;
    let record = get_one(&names, &target).await;
    assert_eq!(record.name, SARDINE);
    assert_eq!(record.source, NameSource::FirstMessage);
    assert_eq!(script.lookups(), 1);

    // Named now: even with newer index activity, nothing is read again.
    crate::auto_title_sweep::run_auto_title_pass(
        &state,
        &[row("opencode", "ses_fingerprinted", "/w/work", None, 2_000)],
    )
    .await;
    assert_eq!(script.lookups(), 1, "a named session is never read again");
}

/// C5: an OpenCode record stuck on its folder name ("freshell" in
/// /home/dan/code/freshell) with an exhausted series — generation needs no
/// input — still gets the targeted lookup, and the record heals to the
/// first message.
#[tokio::test]
async fn opencode_folder_named_record_gets_the_targeted_lookup() {
    let dir = temp_dir();
    let folder = "/home/dan/code/freshell";
    let store = open(dir.path());
    let target = session(NamedProvider::Opencode, "ses_folder");
    seed(
        &store,
        indexed(
            NamedProvider::Opencode,
            "ses_folder",
            Some(folder),
            Some("freshell"),
            None,
        ),
        false,
    )
    .await;
    rewrite(dir.path(), |document| {
        let mut series =
            series_with_input(SARDINE, GenerationStatus::Exhausted, MAX_GENERATION_STARTS);
        series.excerpt = None;
        series.exhausted_at = Some(1);
        document.generation.insert(name_ref_key(&target), series);
    });
    let names = open(dir.path());
    assert!(!names.needs_generation_input(&target), "sanity: exhausted");
    let script = Arc::new(ScriptedFirstMessages::default());
    script.answer("ses_folder", SARDINE);
    let state = sweep_state(dir.path(), names.clone(), Some(scripted_index(&script)));

    crate::auto_title_sweep::run_auto_title_pass(
        &state,
        &[row("opencode", "ses_folder", folder, None, 1_000)],
    )
    .await;
    assert_eq!(
        script.lookups(),
        1,
        "the folder-named record got the lookup"
    );
    let record = get_one(&names, &target).await;
    assert_eq!(record.name, SARDINE);
    assert_eq!(record.source, NameSource::FirstMessage);
}

/// C5: a session with no user message is read once over three passes (the
/// "no user message" answer is remembered across passes), and newer index
/// activity for it reads again.
#[tokio::test]
async fn no_user_message_memo_survives_later_passes() {
    let dir = temp_dir();
    let names = open(dir.path());
    directory_record(&names, NamedProvider::Opencode, "ses_silent").await;
    let script = Arc::new(ScriptedFirstMessages::default());
    let state = sweep_state(dir.path(), names.clone(), Some(scripted_index(&script)));
    let pass = |at: i64| [row("opencode", "ses_silent", "/w/work", None, at)];

    for _ in 0..3 {
        crate::auto_title_sweep::run_auto_title_pass(&state, &pass(1_000)).await;
    }
    assert_eq!(script.lookups(), 1, "read once over three passes");

    crate::auto_title_sweep::run_auto_title_pass(&state, &pass(2_000)).await;
    assert_eq!(script.lookups(), 2, "newer index activity reads again");
}

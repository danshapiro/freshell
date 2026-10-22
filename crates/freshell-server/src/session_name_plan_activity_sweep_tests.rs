//! Name-reliability Task 5 (D4, C5): the auto-title sweep, one pass at a
//! time against the REAL store — the first-message fallback for a session
//! open in a live terminal, and the targeted OpenCode first-message lookup
//! (who gets it, what is remembered across passes, and that a failed read
//! is retried rather than remembered). A child of `plan_activity_tests`,
//! whose helpers it shares.

use std::time::Duration;

use super::*;

/// An index source whose only job is the targeted OpenCode first-message
/// lookup the sweep makes for rows whose listing carries no first message:
/// scripted answers (or failed reads), every read counted.
#[derive(Default)]
struct ScriptedFirstMessages {
    messages: std::sync::Mutex<std::collections::HashMap<String, String>>,
    failing: std::sync::Mutex<std::collections::HashSet<String>>,
    lookups: std::sync::atomic::AtomicUsize,
}

impl ScriptedFirstMessages {
    fn answer(&self, session_id: &str, message: &str) {
        self.failing.lock().unwrap().remove(session_id);
        self.messages
            .lock()
            .unwrap()
            .insert(session_id.to_string(), message.to_string());
    }

    /// Every read of `session_id` fails (the database stays busy).
    fn fail(&self, session_id: &str) {
        self.failing.lock().unwrap().insert(session_id.to_string());
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

    fn targeted_first_user_message(
        &self,
        session_id: &str,
    ) -> Option<freshell_sessions::directory_index::FirstUserMessageRead> {
        self.0
            .lookups
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.0.failing.lock().unwrap().contains(session_id) {
            return Some(Err(freshell_sessions::parse::OpencodeByIdError {
                code: Some("SQLITE_BUSY".to_string()),
                message: "database is locked".to_string(),
            }));
        }
        Some(Ok(self.0.messages.lock().unwrap().get(session_id).cloned()))
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

/// Review of Task 5: a FAILED targeted read is not the "no user message"
/// answer. An OpenCode session still on its folder name whose read fails
/// (the database stayed busy) is read again on a pass after the retry
/// window — same index activity — and heals to its first message.
#[tokio::test]
async fn a_failed_opencode_lookup_is_retried_and_the_record_heals() {
    let dir = temp_dir();
    let names = open(dir.path());
    let target = directory_record(&names, NamedProvider::Opencode, "ses_flaky").await;
    let script = Arc::new(ScriptedFirstMessages::default());
    script.fail("ses_flaky");
    let mut state = sweep_state(dir.path(), names.clone(), Some(scripted_index(&script)));
    state.first_message_lookups =
        crate::auto_title_sweep::FirstMessageLookupMemo::with_failure_retry(Duration::ZERO);
    let pass = [row("opencode", "ses_flaky", "/w/work", None, 1_000)];

    crate::auto_title_sweep::run_auto_title_pass(&state, &pass).await;
    assert_eq!(script.lookups(), 1);
    assert_eq!(get_one(&names, &target).await.source, NameSource::Directory);

    // The database answers now; the row's activity has not moved.
    script.answer("ses_flaky", SARDINE);
    crate::auto_title_sweep::run_auto_title_pass(&state, &pass).await;
    assert_eq!(script.lookups(), 2, "the failed read is retried");
    let record = get_one(&names, &target).await;
    assert_eq!(record.name, SARDINE);
    assert_eq!(record.source, NameSource::FirstMessage);
}

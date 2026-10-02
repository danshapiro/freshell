//! Native writeback contract tests (plan Task 3): the finite cycle machine,
//! receipt/outcome folding, worker ownership, and the error classification
//! the adapters must preserve. Everything drives the REAL temp-file store
//! through the strict transaction path plus a deterministic scripted backend
//! whose late effects are applied by DETACHED tasks — an external write
//! continues after the client-side future already gave up, never a future
//! whose drop cancels the effect.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use freshell_freshagent::naming::{
    BindNameInput, NameError, NativeNameObservation, NativeNameOrigin, PendingNameInput,
    RenameNameInput, SessionNaming,
};
use freshell_protocol::native_location::{
    NativeAcquisition, NativeEvidenceKind, NativeLocation, NativePersistence,
};
use freshell_protocol::session_names::NameIntent;
use freshell_protocol::session_names::{
    NativeSyncProjection, NativeSyncStatus, SessionNameRef, SessionNameUpdate,
};
use serde_json::Value;

use super::{
    NativeCallResult, NativeNameBackend, NativeNameReadback, NativeNameTarget, NativeOutcomeFold,
    SessionNameWorker,
};
use crate::session_names::SessionNames;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn temp_data_dir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn open_store(dir: &std::path::Path) -> Arc<SessionNames> {
    SessionNames::open(dir.to_path_buf()).expect("open store")
}

fn pending(id: &str) -> SessionNameRef {
    SessionNameRef::Pending { id: id.to_string() }
}

fn session(provider: freshell_protocol::session_names::NamedProvider, id: &str) -> SessionNameRef {
    SessionNameRef::Session {
        provider,
        session_id: id.to_string(),
    }
}

fn claude_location(root: &str, session_id: &str) -> NativeLocation {
    NativeLocation::Claude {
        config_root: root.to_string(),
        transcript_path: Some(format!("{root}/projects/-p/{session_id}.jsonl")),
        project_directory_key: None,
        transcript_cwd: None,
        effective_project_key_override: None,
    }
}

fn verified_acquisition(location: NativeLocation) -> NativeAcquisition {
    NativeAcquisition {
        location,
        evidence: NativeEvidenceKind::SelectedTranscript,
        persistence: NativePersistence::Verified,
    }
}

async fn ensure_pending(
    store: &Arc<SessionNames>,
    handle: &str,
    cwd: Option<&str>,
) -> Result<SessionNameUpdate, NameError> {
    store
        .ensure_pending(PendingNameInput {
            handle: handle.to_string(),
            provider: freshell_protocol::session_names::NamedProvider::Claude,
            cwd: cwd.map(str::to_string),
        })
        .await
}

async fn rename_user(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    name: &str,
) -> Result<SessionNameUpdate, NameError> {
    store
        .rename(RenameNameInput {
            target,
            name: name.to_string(),
            intent: NameIntent::User,
            if_revision: None,
        })
        .await
}

async fn rename_automatic(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    name: &str,
) -> Result<SessionNameUpdate, NameError> {
    store
        .rename(RenameNameInput {
            target,
            name: name.to_string(),
            intent: NameIntent::Automatic,
            if_revision: None,
        })
        .await
}

async fn record_acquisition(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    acquisition: NativeAcquisition,
) -> Result<SessionNameUpdate, NameError> {
    store.record_acquisition(target, acquisition).await
}

async fn observe(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    title: &str,
    location_revision: u64,
) -> Result<SessionNameUpdate, NameError> {
    store
        .observe_native(NativeNameObservation {
            target,
            title: title.to_string(),
            origin: NativeNameOrigin::Snapshot,
            location_revision,
            event_id: None,
        })
        .await
}

async fn native_sync_of(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
) -> Option<NativeSyncProjection> {
    let updates = store.get(vec![target]).await.expect("get succeeds");
    updates.into_iter().next()?.native_sync
}

/// Read the durable document JSON (black-box: receipts/cycles live in the
/// internal sections; the file is the contract).
fn document_json(dir: &std::path::Path) -> Value {
    let bytes = std::fs::read(dir.join("session-names.json")).expect("document exists");
    serde_json::from_slice(&bytes).expect("document parses")
}

// ---------------------------------------------------------------------------
// The deterministic scripted backend
// ---------------------------------------------------------------------------

enum WriteStep {
    /// Confirmed write; the provider applies the attempted title.
    Confirm,
    /// Ambiguous answer, but a DETACHED task applies the attempted title
    /// after `delay_ms` — the external write continues after the client-side
    /// future already gave up.
    AmbiguousLateApply {
        delay_ms: u64,
    },
    /// Ambiguous answer; the write never lands.
    Undelivered,
    Unsupported,
}

/// A deterministic in-memory provider: reads answer the shared provider-side
/// title (so detached late-apply tasks are observable), writes follow the
/// scripted step list. Read/write counters pin the finite allowances.
struct ScriptedBackend {
    reads: AtomicU32,
    writes: AtomicU32,
    provider_title: Arc<Mutex<Option<String>>>,
    steps: Mutex<VecDeque<WriteStep>>,
    /// One-shot read gate: the FIRST read parks until the gate is notified
    /// (tests use this to mutate the store while a cycle is mid-flight —
    /// the worker holds the background guard, never the document lock).
    gate_armed: AtomicBool,
    gate_arrived: Arc<tokio::sync::Notify>,
    gate_open: Arc<tokio::sync::Notify>,
}

impl ScriptedBackend {
    fn new(steps: Vec<WriteStep>) -> Arc<Self> {
        Arc::new(Self {
            reads: AtomicU32::new(0),
            writes: AtomicU32::new(0),
            provider_title: Arc::new(Mutex::new(None)),
            steps: Mutex::new(steps.into_iter().collect()),
            gate_armed: AtomicBool::new(false),
            gate_arrived: Arc::new(tokio::sync::Notify::new()),
            gate_open: Arc::new(tokio::sync::Notify::new()),
        })
    }

    fn arm_read_gate(self: &Arc<Self>) -> Arc<Self> {
        self.gate_armed.store(true, Ordering::SeqCst);
        Arc::clone(self)
    }

    fn reads(&self) -> u32 {
        self.reads.load(Ordering::SeqCst)
    }

    fn writes(&self) -> u32 {
        self.writes.load(Ordering::SeqCst)
    }

    fn set_title(&self, title: Option<&str>) {
        *self.provider_title.lock().unwrap() = title.map(str::to_string);
    }
}

impl NativeNameBackend for ScriptedBackend {
    fn read(&self, _target: NativeNameTarget) -> super::NativeFuture<NativeNameReadback> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.gate_armed.swap(false, Ordering::SeqCst) {
            self.gate_arrived.notify_one();
            let open = Arc::clone(&self.gate_open);
            let provider_title = Arc::clone(&self.provider_title);
            return Box::pin(async move {
                open.notified().await;
                let title = provider_title.lock().unwrap().clone();
                NativeCallResult::Confirmed(NativeNameReadback { title })
            });
        }
        let title = self.provider_title.lock().unwrap().clone();
        Box::pin(async move { NativeCallResult::Confirmed(NativeNameReadback { title }) })
    }

    fn route_available(&self, _target: NativeNameTarget) -> super::NativeProbeFuture {
        Box::pin(async move { true })
    }

    fn write(&self, attempt: super::NativeNameAttempt) -> super::NativeFuture<()> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        let step = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(WriteStep::Confirm);
        let provider_title = Arc::clone(&self.provider_title);
        Box::pin(async move {
            match step {
                WriteStep::Confirm => {
                    *provider_title.lock().unwrap() = Some(attempt.title.clone());
                    NativeCallResult::Confirmed(())
                }
                WriteStep::AmbiguousLateApply { delay_ms } => {
                    // The provider applies the write LATE via a detached
                    // task: the effect survives even though this client-side
                    // future already answered ambiguous.
                    let title = attempt.title.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        *provider_title.lock().unwrap() = Some(title);
                    });
                    NativeCallResult::Ambiguous(
                        "scripted timeout; the write may still land".to_string(),
                    )
                }
                WriteStep::Undelivered => NativeCallResult::Undelivered(
                    "scripted connect refusal (provably never dispatched)".to_string(),
                ),
                WriteStep::Unsupported => NativeCallResult::Unsupported(
                    "scripted capability failure (archived)".to_string(),
                ),
            }
        })
    }
}

// ---------------------------------------------------------------------------
// A standard armed series: pending handle → manual rename → verified
// location recorded → the native series is armed.
// ---------------------------------------------------------------------------

/// Seed one pending record with a MANUAL name and a verified claude route at
/// `root`, returning the pending target.
async fn armed_pending(store: &Arc<SessionNames>, handle: &str, root: &str) -> SessionNameRef {
    let target = pending(handle);
    ensure_pending(store, handle, Some("/work/project"))
        .await
        .expect("ensure");
    rename_user(store, target.clone(), "Manual Title")
        .await
        .expect("manual rename");
    record_acquisition(
        store,
        target.clone(),
        verified_acquisition(claude_location(root, handle)),
    )
    .await
    .expect("acquire");
    target
}

// ---------------------------------------------------------------------------
// On-demand route discovery (the index-adopted flow)
// ---------------------------------------------------------------------------

// `locate_transcript_selected` reads process-global env (the ordered
// candidate roots). Both discovery tests below MUTATE `CLAUDE_HOME` /
// `CLAUDE_CONFIG_DIR` for their whole set…restore window, so they hold the
// crate-wide `CLAUDE_ENV_TEST_LOCK` — shared with every other same-binary
// mutator of those vars and with the `claude_home`-resolving readers (the
// final-suite gate's unreadable-projects deferral flake; see
// `crate::test_env_lock` for the full discipline).

/// Unified agent names (Task 8 acceptance): a session adopted ONLY through
/// the index (the auto-title sweep's hydration — the sidebar/history rename
/// flow) has NO runtime lane attaching a location. Without on-demand
/// discovery its armed native series pauses forever (the native smoke's
/// live-observed gap: `nativeSync: null` after a successful canonical
/// rename). The worker must resolve the transcript by session id and
/// attach the acquisition so the series runs to `synced`.
#[tokio::test]
async fn an_index_adopted_claude_series_discovers_its_route_on_demand() {
    let _guard = crate::test_env_lock::CLAUDE_ENV_TEST_LOCK.lock().await;
    let home = tempfile::tempdir().expect("claude home tempdir");
    let session_id = "4a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    let project_cwd = home.path().join("proj");
    std::fs::create_dir_all(&project_cwd).expect("project dir");
    let mangled = project_cwd
        .to_string_lossy()
        .replace(|c: char| !c.is_ascii_alphanumeric(), "-");
    let transcript_dir = home.path().join("projects").join(&mangled);
    std::fs::create_dir_all(&transcript_dir).expect("mangled project dir");
    std::fs::write(
        transcript_dir.join(format!("{session_id}.jsonl")),
        format!(
            concat!(
                r#"{{"parentUuid":null,"isSidechain":false,"type":"user","uuid":"m1","sessionId":"{session_id}","#,
                r#""timestamp":"2026-09-18T07:00:00.000Z","cwd":"{cwd}","message":{{"role":"user","content":"Probe the sardine factory"}}}}"#,
                "\n",
            ),
            cwd = project_cwd.to_string_lossy(),
            session_id = session_id,
        ),
    )
    .expect("transcript");

    let saved_home = std::env::var_os("CLAUDE_HOME");
    let saved_config = std::env::var_os("CLAUDE_CONFIG_DIR");
    std::env::set_var("CLAUDE_HOME", home.path());
    std::env::remove_var("CLAUDE_CONFIG_DIR");

    let result = async {
        let dir = temp_data_dir();
        let store = open_store(dir.path());
        let target = session(
            freshell_protocol::session_names::NamedProvider::Claude,
            session_id,
        );
        // The sweep's own hydration + a manual rename: the record + an
        // ARMED native series, and NO location anywhere.
        store
            .hydrate_indexed(
                crate::session_name_generation::IndexedNameInput {
                    provider: freshell_protocol::session_names::NamedProvider::Claude,
                    session_id: session_id.to_string(),
                    cwd: Some(project_cwd.to_string_lossy().to_string()),
                    first_user_message: Some("Probe the sardine factory".to_string()),
                    provider_title: None,
                },
                false,
            )
            .await
            .expect("hydrate");
        rename_user(&store, target.clone(), "Manual Title")
            .await
            .expect("manual rename");
        assert!(
            store.native_work_snapshot().is_empty(),
            "no route: the series pauses before consuming a cycle"
        );

        // The discovery attaches the acquisition from the on-disk
        // transcript, and the series becomes runnable work.
        assert!(
            super::discover_claude_route(&store, &target).await,
            "the discoverable transcript must attach the route"
        );
        let items = store.native_work_snapshot();
        assert_eq!(items.len(), 1, "the unpaused series holds ready work");
        assert_eq!(items[0].target, target);

        // The cycle synchronizes like any armed series (the scripted
        // backend answers a divergent pre-write read then confirms).
        let backend = ScriptedBackend::new(vec![WriteStep::Confirm]);
        backend.set_title(Some("Something Else"));
        super::run_cycle(
            &store,
            backend.as_ref() as &dyn NativeNameBackend,
            &items[0].target,
        )
        .await;
        let sync = native_sync_of(&store, target.clone())
            .await
            .expect("series");
        assert_eq!(sync.status, NativeSyncStatus::Synced);
    }
    .await;

    match saved_home {
        Some(value) => std::env::set_var("CLAUDE_HOME", value),
        None => std::env::remove_var("CLAUDE_HOME"),
    }
    match saved_config {
        Some(value) => std::env::set_var("CLAUDE_CONFIG_DIR", value),
        None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
    }
    result
}

/// Task-008 review M-3: a FAILED on-demand route discovery must back the
/// series off for the discovery window instead of re-walking the projects
/// tree on every 500ms worker poll, per series, for the process lifetime
/// (a transcript deleted after indexing, an off-machine session id). The
/// backoff is worker-local, keyed by the stable name-ref key (route
/// acquisition is revision-independent): an expired window attempts again,
/// and a successful discovery clears the entry and unpauses the series.
#[tokio::test]
async fn a_failed_route_discovery_backs_off_instead_of_rescanning_every_pass() {
    let _guard = crate::test_env_lock::CLAUDE_ENV_TEST_LOCK.lock().await;
    let home = tempfile::tempdir().expect("claude home tempdir");
    let session_id = "6c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
    let project_cwd = home.path().join("proj");
    std::fs::create_dir_all(&project_cwd).expect("project dir");
    // NOTE: no transcript on disk yet — every discovery attempt fails until
    // the file appears late in the test.
    let mangled = project_cwd
        .to_string_lossy()
        .replace(|c: char| !c.is_ascii_alphanumeric(), "-");
    let transcript_dir = home.path().join("projects").join(&mangled);
    std::fs::create_dir_all(&transcript_dir).expect("mangled project dir");

    let saved_home = std::env::var_os("CLAUDE_HOME");
    let saved_config = std::env::var_os("CLAUDE_CONFIG_DIR");
    std::env::set_var("CLAUDE_HOME", home.path());
    std::env::remove_var("CLAUDE_CONFIG_DIR");

    let result = async {
        let dir = temp_data_dir();
        let store = open_store(dir.path());
        let target = session(
            freshell_protocol::session_names::NamedProvider::Claude,
            session_id,
        );
        store
            .hydrate_indexed(
                crate::session_name_generation::IndexedNameInput {
                    provider: freshell_protocol::session_names::NamedProvider::Claude,
                    session_id: session_id.to_string(),
                    cwd: Some(project_cwd.to_string_lossy().to_string()),
                    first_user_message: Some("Probe the sardine factory".to_string()),
                    provider_title: None,
                },
                false,
            )
            .await
            .expect("hydrate");
        rename_user(&store, target.clone(), "Manual Title")
            .await
            .expect("manual rename");
        assert!(
            !store.paused_claude_series_without_route().is_empty(),
            "the routeless armed series is paused"
        );

        let mut backoff = std::collections::HashMap::new();
        // Pass 1: the missing transcript is attempted once and the failure
        // records a discovery window.
        let attempted = super::discover_paused_claude_routes(&store, &mut backoff).await;
        assert_eq!(attempted, 1, "the first pass attempts the series");
        assert_eq!(backoff.len(), 1, "the failed attempt records a window");
        // Pass 2, immediately: the window must suppress the rescan (the
        // per-poll filesystem walk is the defect this test pins).
        let attempted = super::discover_paused_claude_routes(&store, &mut backoff).await;
        assert_eq!(attempted, 0, "the backoff window suppresses the rescan");
        // An expired window attempts again (simulated with a past
        // deadline — no fake clocks around the real store).
        let key = crate::session_names::name_ref_key(&target);
        backoff.insert(
            key.clone(),
            tokio::time::Instant::now() - super::DISCOVERY_RETRY_WINDOW,
        );
        let attempted = super::discover_paused_claude_routes(&store, &mut backoff).await;
        assert_eq!(attempted, 1, "an expired window attempts discovery again");
        assert_eq!(backoff.len(), 1, "the retried failure re-arms the window");
        // The transcript appears late: the next expired window discovers
        // the route, clears the backoff entry, and unpauses the series.
        std::fs::write(
            transcript_dir.join(format!("{session_id}.jsonl")),
            format!(
                concat!(
                    r#"{{"parentUuid":null,"isSidechain":false,"type":"user","uuid":"m1","sessionId":"{session_id}","#,
                    r#""timestamp":"2026-09-18T07:00:00.000Z","cwd":"{cwd}","message":{{"role":"user","content":"Probe the sardine factory"}}}}"#,
                    "\n",
                ),
                cwd = project_cwd.to_string_lossy(),
                session_id = session_id,
            ),
        )
        .expect("transcript");
        backoff.insert(key, tokio::time::Instant::now() - super::DISCOVERY_RETRY_WINDOW);
        let attempted = super::discover_paused_claude_routes(&store, &mut backoff).await;
        assert_eq!(attempted, 1, "the expired window attempts the late transcript");
        assert!(
            backoff.is_empty(),
            "the successful discovery clears the window entry"
        );
        assert!(
            store.paused_claude_series_without_route().is_empty(),
            "the discovered series is no longer paused"
        );
    }
    .await;

    match saved_home {
        Some(value) => std::env::set_var("CLAUDE_HOME", value),
        None => std::env::remove_var("CLAUDE_HOME"),
    }
    match saved_config {
        Some(value) => std::env::set_var("CLAUDE_CONFIG_DIR", value),
        None => std::env::remove_var("CLAUDE_CONFIG_DIR"),
    }
    result
}

// ---------------------------------------------------------------------------
// The finite cycle machine
// ---------------------------------------------------------------------------

/// Ordinary confirmed success: one pre-write read (divergent), one write,
/// one confirming readback — the exact revision synchronizes and the unused
/// remaining cycles pause.
#[tokio::test]
async fn confirmed_write_and_readback_synchronizes_the_exact_revision() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-confirm", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![WriteStep::Confirm]);
    backend.set_title(Some("Something Else"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    assert_eq!(backend.reads(), 2, "pre-write read + confirming readback");
    assert_eq!(backend.writes(), 1, "at most one write per cycle");
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series projected");
    assert_eq!(sync.status, NativeSyncStatus::Synced);
    let record = store
        .get(vec![target.clone()])
        .await
        .unwrap()
        .remove(0)
        .record;
    assert_eq!(sync.desired_revision, record.revision, "the exact revision");
    assert_eq!(sync.location_revision, 1, "the verified location revision");
    assert_eq!(
        record.name, "Manual Title",
        "provider failure never rolls back the name"
    );
    // Synchronized series pause their unused cycles: no further work.
    assert!(
        store.native_work_snapshot().is_empty(),
        "synced series hold no ready work"
    );
}

/// The pre-write read already holding the desired value synchronizes without
/// a write (the native already projects the exact name).
#[tokio::test]
async fn matching_pre_write_read_synchronizes_without_a_write() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-match", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![]);
    backend.set_title(Some("Manual Title"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    assert_eq!(backend.reads(), 1);
    assert_eq!(backend.writes(), 0, "nothing to reconcile");
    let sync = native_sync_of(&store, target).await.expect("series");
    assert_eq!(sync.status, NativeSyncStatus::Synced);
}

/// Three cycles maximum; failures schedule the retry floors; exhaustion is
/// final across restarts, duplicate events, and location re-checks; and the
/// read allowance never exceeds six.
#[tokio::test]
async fn undelivered_failures_bound_at_three_cycles_six_reads_and_exhaust_permanently() {
    let dir = temp_data_dir();
    // Shrink the 5s/30s retry floors so the bounded-allowance math is
    // observable without wall-clock waits (the production floors are pinned
    // by their constants; this hook only accelerates eligibility).
    crate::session_names::set_test_hooks(
        dir.path(),
        vec![crate::session_names::TestHook::NativeRetryFloorMs(2_000)],
    );
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-exhaust", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![
        WriteStep::Undelivered,
        WriteStep::Undelivered,
        WriteStep::Undelivered,
    ]);
    backend.set_title(Some("Divergent"));

    // Cycle 1 runs immediately.
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    assert_eq!(backend.writes(), 1);
    assert_eq!(backend.reads(), 1);
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(sync.status, NativeSyncStatus::Unsynced);
    assert!(sync.reason.unwrap().contains("connect refusal"));

    // Cycle 2 is not ready until the retry floor elapses.
    assert!(
        store.native_work_snapshot().is_empty(),
        "cycle 2 waits for the retry floor"
    );
    assert!(
        store
            .claim_native_cycle(target.clone(), "r2".to_string())
            .await
            .unwrap()
            .is_none(),
        "not yet due consumes nothing"
    );
    // The 2s floor gives the not-yet-due asserts above real margin: a
    // parallel-workspace run can starve a single await well past a 60ms
    // floor (observed twice under full-suite load), which made the
    // "cycle 2 waits for the retry floor" assert fail on working code.
    tokio::time::sleep(Duration::from_millis(2_050)).await;

    // Exhaust cycles 2 and 3 through the real dispatch loop.
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    tokio::time::sleep(Duration::from_millis(2_050)).await;
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    assert_eq!(backend.writes(), 3, "at most three writes per revision");
    assert_eq!(backend.reads(), 3);

    // Cycle 4: exhaustion is final.
    assert!(
        store
            .claim_native_cycle(target.clone(), "r4".to_string())
            .await
            .unwrap()
            .is_none(),
        "exhaustion is final for the revision"
    );
    // No replenishment: duplicate observations, reconnect-style
    // re-acquisition of the SAME location, and repeated work scans never
    // restore consumed counts.
    observe(&store, target.clone(), "Manual Title", 1)
        .await
        .unwrap();
    record_acquisition(
        &store,
        target.clone(),
        verified_acquisition(claude_location("/h/.claude", "h-exhaust")),
    )
    .await
    .unwrap();
    assert!(
        store
            .claim_native_cycle(target.clone(), "r5".to_string())
            .await
            .unwrap()
            .is_none(),
        "no event replenishes the finite allowance"
    );

    // Restart: exhaustion and the attempted receipts survive; the allowance
    // is still spent.
    let store = open_store(dir.path());
    let target = pending("h-exhaust");
    assert!(
        store
            .claim_native_cycle(target.clone(), "r6".to_string())
            .await
            .unwrap()
            .is_none(),
        "exhaustion is final across restart"
    );
    let doc = document_json(dir.path());
    let native = doc["nativeWrite"]
        .as_object()
        .expect("nativeWrite section")
        .values()
        .next()
        .expect("one series");
    assert_eq!(native["cyclesConsumed"].as_u64(), Some(3));
    assert!(native["settled"].as_bool().unwrap());
    assert_eq!(
        native["attemptedReceipts"].as_array().map(Vec::len),
        Some(3)
    );
    assert_eq!(native["readsConsumed"].as_u64(), Some(3));
    crate::session_names::clear_test_hooks(dir.path());
}

/// A new manual rename mid-flight creates its OWN bounded allowance, and the
/// in-flight cycle's acknowledgement cannot synchronize the newer revision:
/// the document lock is free while the worker parks on the provider, so the
/// rename lands immediately (N+1 accepted while N executes).
#[tokio::test]
async fn rename_during_a_pending_write_gets_its_own_allowance_and_the_old_ack_cannot_sync_it() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-race", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![WriteStep::Confirm]).arm_read_gate();
    backend.set_title(Some("Divergent"));

    let store_for_cycle = Arc::clone(&store);
    let backend_for_cycle = Arc::clone(&backend);
    let target_for_cycle = target.clone();
    let worker = tokio::spawn(async move {
        super::run_cycle(
            &store_for_cycle,
            backend_for_cycle.as_ref() as &dyn NativeNameBackend,
            &target_for_cycle,
        )
        .await;
    });

    // Wait for the worker to park inside its first read, then rename through
    // the SAME store — the document lock is NOT held by the in-flight cycle.
    backend.gate_arrived.notified().await;
    let renamed = rename_user(&store, target.clone(), "Newer Decision")
        .await
        .expect("the rename lands immediately while N executes");
    assert_eq!(renamed.record.name, "Newer Decision");
    backend.gate_open.notify_one();
    worker.await.unwrap();

    // N's acknowledgement (a confirmed write + matching readback of the OLD
    // desired value) cannot synchronize N+1: the stale fold is provenance.
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_ne!(
        sync.status,
        NativeSyncStatus::Synced,
        "an old acknowledgement cannot sync a newer revision"
    );
    let record = store
        .get(vec![target.clone()])
        .await
        .unwrap()
        .remove(0)
        .record;
    assert_eq!(record.name, "Newer Decision");
    assert_eq!(
        sync.desired_revision, record.revision,
        "the series projects the new decision's revision"
    );
    // The new decision gets its OWN bounded allowance (fresh cycles), and the
    // new series is ready now.
    let claim = store
        .claim_native_cycle(target.clone(), "new-series-1".to_string())
        .await
        .unwrap()
        .expect("the new series has its own allowance");
    assert_eq!(claim.title, "Newer Decision");
}

/// Ambiguity: the write may still land (a detached task applies it late).
/// A later matching readback records `observedCurrent` but the status STAYS
/// unsynced with the uncertainty reason — never proof an older external
/// request cannot still write.
#[tokio::test]
async fn ambiguous_write_matching_readback_records_observed_current_but_stays_unsynced() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-amb", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![WriteStep::AmbiguousLateApply { delay_ms: 10 }]);
    backend.set_title(Some("Divergent"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(sync.status, NativeSyncStatus::Unsynced);
    assert!(sync.reason.unwrap().contains("timeout"));

    // The detached provider task applies the write after the fold; a later
    // cycle's matching readback observes the desired title.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        backend.provider_title.lock().unwrap().as_deref(),
        Some("Manual Title"),
        "the external write continued after the client gave up"
    );
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_ne!(sync.status, NativeSyncStatus::Synced);
    // Fold the matching readback (as the next cycle's read would).
    store
        .fold_native_outcome(
            target.clone(),
            1,
            current_series_epoch(dir.path()),
            NativeOutcomeFold::Read {
                observed: Some("Manual Title".to_string()),
                receipt: None,
            },
        )
        .await
        .unwrap();
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(
        sync.status,
        NativeSyncStatus::Unsynced,
        "a matching readback after ambiguity never establishes synced"
    );
    assert_eq!(sync.observed_current, Some(true));
    assert!(sync.reason.unwrap().contains("ambiguous"));
    // The series holds no ready work: ambiguity settled with the matching
    // readback recorded.
    assert!(store.native_work_snapshot().is_empty());
}

/// Undelivered vs ambiguous vs unsupported keep distinct classifications and
/// distinct unsynced reasons — never reduced to a generic timeout.
#[tokio::test]
async fn unsupported_marks_the_series_and_only_a_location_change_rearms_it() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-unsup", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![WriteStep::Unsupported]);
    backend.set_title(Some("Divergent"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(sync.status, NativeSyncStatus::Unsupported);
    assert!(sync.reason.unwrap().contains("capability failure"));
    assert!(
        store
            .claim_native_cycle(target.clone(), "r9".to_string())
            .await
            .unwrap()
            .is_none(),
        "unsupported consumes its cycle and holds no ready work"
    );
    assert_eq!(backend.writes(), 1);

    // A differing observation does NOT re-arm an unsupported series (only a
    // genuine capability/lifecycle change does).
    observe(&store, target.clone(), "Totally Different", 1)
        .await
        .unwrap();
    assert!(store
        .claim_native_cycle(target.clone(), "r10".to_string())
        .await
        .unwrap()
        .is_none());

    // A genuine verified-location reacquisition re-arms the REMAINING cycles
    // — without replenishing the consumed one.
    record_acquisition(
        &store,
        target.clone(),
        verified_acquisition(claude_location("/h/.claude-moved", "h-unsup")),
    )
    .await
    .unwrap();
    let claim = store
        .claim_native_cycle(target.clone(), "r11".to_string())
        .await
        .unwrap()
        .expect("remaining cycles re-arm on the new route");
    assert_eq!(claim.cycle, 2, "consumed counts are never replenished");
    assert_eq!(claim.location_revision, 2, "the reacquired route revision");
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(sync.status, NativeSyncStatus::Unsynced);
}

/// After confirmed synchronization, a DIFFERING current-location observation
/// re-arms the remaining cycles (the native moved away); a matching one never
/// schedules work; and exhaustion stays final.
#[tokio::test]
async fn divergent_observation_rearms_a_synced_series_without_replenishing() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-diverge", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![]);
    backend.set_title(Some("Manual Title"));
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    assert_eq!(
        native_sync_of(&store, target.clone()).await.unwrap().status,
        NativeSyncStatus::Synced
    );

    // Matching observation: no work.
    observe(&store, target.clone(), "Manual Title", 1)
        .await
        .unwrap();
    assert!(store.native_work_snapshot().is_empty());

    // Divergent observation: the remaining cycles re-arm at the same route.
    observe(&store, target.clone(), "Externally Retitled", 1)
        .await
        .unwrap();
    let items = store.native_work_snapshot();
    assert_eq!(items.len(), 1, "the differing observation scheduled work");
    assert_eq!(items[0].cycles_consumed, 1, "counts not replenished");

    // But the observation is still an automatic candidate: a manual record
    // is never overwritten by it.
    let record = store
        .get(vec![target.clone()])
        .await
        .unwrap()
        .remove(0)
        .record;
    assert_eq!(record.name, "Manual Title");
    assert_eq!(
        record.source,
        freshell_protocol::session_names::NameSource::Manual
    );
}

/// A pending series binds onto its durable identity mid-flight: consumed
/// cycles and remaining read allowance TRANSFER, the desired revision
/// rebases to the bound record, and the original attempted receipts are
/// retained.
#[tokio::test]
async fn binding_transfers_cycles_rebases_desired_revision_and_retains_receipts() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-bind", "/h/.claude").await;
    // Charge one cycle through the pre-write read + a confirmed write ack —
    // bind BEFORE the confirming readback lands.
    let claim = store
        .claim_native_cycle(target.clone(), "bind-receipt-1".to_string())
        .await
        .unwrap()
        .expect("claim");
    assert_eq!(claim.cycle, 1);
    assert!(
        store
            .charge_native_read(target.clone(), claim.series_epoch)
            .await
            .unwrap(),
        "the read allowance charges"
    );
    store
        .fold_native_outcome(
            target.clone(),
            claim.location_revision,
            claim.series_epoch,
            NativeOutcomeFold::WriteAcknowledged {
                receipt: claim.receipt_id.clone(),
            },
        )
        .await
        .unwrap();

    let durable = session(
        freshell_protocol::session_names::NamedProvider::Claude,
        "sess-bind",
    );
    store
        .bind_pending(BindNameInput {
            pending: target.clone(),
            target: durable.clone(),
            acquisition: verified_acquisition(claude_location("/h/.claude", "sess-bind")),
        })
        .await
        .expect("verified bind");

    // The bound record carries the transferred series: same consumed count,
    // the desired revision rebased to the NEW record revision.
    let record = store
        .get(vec![durable.clone()])
        .await
        .unwrap()
        .remove(0)
        .record;
    let sync = native_sync_of(&store, durable.clone())
        .await
        .expect("series");
    assert_eq!(sync.desired_revision, record.revision);
    let claim = store
        .claim_native_cycle(durable.clone(), "bind-cycle-2".to_string())
        .await
        .unwrap()
        .expect("the transferred allowance continues");
    assert_eq!(claim.cycle, 2, "consumed cycles transfer, not replenish");
    let doc = document_json(dir.path());
    let native = doc["nativeWrite"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap();
    let receipts = native["attemptedReceipts"].as_array().unwrap();
    assert!(
        receipts
            .iter()
            .any(|r| r.as_str() == Some("bind-receipt-1")),
        "original attempted receipts retained across the bind"
    );
}

/// A restart-discovered interrupted cycle is consumed exactly once: the claim
/// persisted before dispatch survives the reopen, and the next claim mints a
/// fresh unique receipt.
#[tokio::test]
async fn restart_with_an_outstanding_receipt_consumes_the_cycle_once() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-restart", "/h/.claude").await;
    let claim = store
        .claim_native_cycle(target.clone(), "receipt-outstanding".to_string())
        .await
        .unwrap()
        .expect("claim");
    assert_eq!(claim.cycle, 1);
    let location_revision = claim.location_revision;

    // Restart before any dispatch/fold.
    let store = open_store(dir.path());
    let target = pending("h-restart");
    let doc = document_json(dir.path());
    let native = doc["nativeWrite"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap();
    assert_eq!(native["cyclesConsumed"].as_u64(), Some(1));
    let receipts = native["attemptedReceipts"].as_array().unwrap();
    assert!(
        receipts
            .iter()
            .any(|r| r.as_str() == Some("receipt-outstanding")),
        "the outstanding receipt survives the restart as provenance"
    );

    // The interrupted cycle is consumed once: the next claim mints a NEW
    // receipt and charges cycle 2 — never a replay of the stale one.
    let claim2 = store
        .claim_native_cycle(target.clone(), "receipt-next".to_string())
        .await
        .unwrap()
        .expect("the next cycle continues the series");
    assert_eq!(claim2.cycle, 2);
    assert_ne!(claim2.receipt_id, "receipt-outstanding");
    assert_eq!(claim2.location_revision, location_revision);
}

/// Fallback sources never write back and project no native series: only
/// accepted manual and Freshell AI names arm one.
#[tokio::test]
async fn provider_fallbacks_never_arm_a_native_series() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-fallback");
    ensure_pending(&store, "h-fallback", Some("/work/project"))
        .await
        .unwrap();
    // Automatic (provider_ai-rank) suggestion on a directory record: no
    // series is created.
    rename_automatic(&store, target.clone(), "Agent Suggestion")
        .await
        .unwrap();
    assert!(
        store.native_work_snapshot().is_empty(),
        "provider fallbacks are not written back"
    );
    let sync = native_sync_of(&store, target.clone()).await;
    assert!(
        sync.is_none(),
        "no native series is projected for fallback names"
    );
}

/// The inert generation participant for native-only worker tests: no Gemini
/// key means generation capability is absent, so the shared loop's
/// generation half stays paused (consuming nothing) while native work runs.
fn inert_generation(
    dir: &std::path::Path,
) -> Arc<crate::session_name_generation::SessionNameGenerator> {
    struct NeverTransport;
    impl crate::ai_title::GeminiTransport for NeverTransport {
        fn generate_content(
            &self,
            _p: String,
            _m: u32,
        ) -> crate::ai_title::BoxFuture<Result<String, String>> {
            Box::pin(std::future::pending())
        }
    }
    Arc::new(crate::session_name_generation::SessionNameGenerator::new(
        crate::settings_store::SettingsStore::load(Some(dir), vec![]),
        crate::ai_title::GeminiSessionNameAuth::direct_for_test(crate::ai_title::AiKeyCell::init(
            None, None,
        )),
        Arc::new(NeverTransport),
    ))
}

/// The worker loop drives armed work end-to-end under the shared background
/// guard: a manual rename arms the series and the running worker converges
/// the provider to the exact desired name.
#[tokio::test]
async fn the_worker_loop_converges_an_armed_series() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-worker", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![WriteStep::Confirm]);
    backend.set_title(Some("Divergent"));

    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        backend.clone(),
        inert_generation(dir.path()),
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(sync) = native_sync_of(&store, target.clone()).await {
            if sync.status == NativeSyncStatus::Synced {
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the worker must converge the armed series"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    worker.abort();
    assert_eq!(backend.writes(), 1);
    assert_eq!(backend.reads(), 2);
}

/// The selector prefers ready manual-name projection, then the stable
/// name-reference key — the persisted fair-scheduling policy's native half —
/// and a live capability-reprobe window skips its refused series while an
/// expired one no longer does.
#[tokio::test]
async fn the_selector_prefers_manual_projection_then_the_stable_key() {
    let items =
        |source: freshell_protocol::session_names::NameSource, key: &str| super::NativeWorkItem {
            target: pending(key),
            location: claude_location("/h/.claude", key),
            location_revision: 1,
            desired_revision: 1,
            desired_name: "x".to_string(),
            desired_source: source,
            cycles_consumed: 0,
            next_due: None,
        };
    let a_freshell = items(
        freshell_protocol::session_names::NameSource::FreshellAi,
        "z-late",
    );
    let b_manual = items(
        freshell_protocol::session_names::NameSource::Manual,
        "a-early",
    );
    let c_freshell = items(
        freshell_protocol::session_names::NameSource::FreshellAi,
        "b-early",
    );
    let mut backoff = std::collections::HashMap::new();
    let picked = super::select_next(
        &[a_freshell.clone(), b_manual.clone(), c_freshell.clone()],
        &mut backoff,
    );
    assert_eq!(picked.unwrap().target, b_manual.target);
    let picked = super::select_next(&[a_freshell.clone(), c_freshell.clone()], &mut backoff);
    assert_eq!(picked.unwrap().target, c_freshell.target);

    // A live re-probe window rotates the refused series out: the selector
    // picks the next available armed series instead.
    backoff.insert(
        (
            freshell_freshagent::naming::name_ref_debug_key(&b_manual.target),
            b_manual.desired_revision,
        ),
        tokio::time::Instant::now() + super::CAPABILITY_REPROBE_DELAY,
    );
    let picked = super::select_next(
        &[a_freshell.clone(), b_manual.clone(), c_freshell.clone()],
        &mut backoff,
    );
    assert_eq!(
        picked.unwrap().target,
        c_freshell.target,
        "a live capability backoff skips the refused series"
    );

    // An EXPIRED window no longer skips (and is pruned): the manual head is
    // selected again.
    backoff.insert(
        (
            freshell_freshagent::naming::name_ref_debug_key(&b_manual.target),
            b_manual.desired_revision,
        ),
        tokio::time::Instant::now() - Duration::from_secs(1),
    );
    let picked = super::select_next(
        &[a_freshell.clone(), b_manual.clone(), c_freshell.clone()],
        &mut backoff,
    );
    assert_eq!(
        picked.unwrap().target,
        b_manual.target,
        "an expired capability backoff re-admits the series"
    );
    assert!(
        !backoff.contains_key(&(
            freshell_freshagent::naming::name_ref_debug_key(&b_manual.target),
            b_manual.desired_revision,
        )),
        "the expired entry is pruned"
    );

    // A fresh name decision (a new desired revision) is never penalized by
    // the superseded series' window: the backoff is keyed per series.
    backoff.insert(
        (
            freshell_freshagent::naming::name_ref_debug_key(&b_manual.target),
            b_manual.desired_revision,
        ),
        tokio::time::Instant::now() + super::CAPABILITY_REPROBE_DELAY,
    );
    let re_decided = super::NativeWorkItem {
        desired_revision: b_manual.desired_revision + 1,
        ..b_manual.clone()
    };
    let picked = super::select_next(std::slice::from_ref(&re_decided), &mut backoff);
    assert_eq!(
        picked.unwrap().target,
        re_decided.target,
        "a fresh armed revision is probed promptly despite the old series' window"
    );
}

/// Delta-review round 3, finding 4: among DUE items the selection order is
/// "manual first, then earliest nextDue, then the stable reference key" —
/// the plan's stated policy and the worker doc's own contract. The old code
/// ordered by the reference key (then cycles consumed) and never even
/// carried `next_due`, so a persistently early-keyed series was served
/// ahead of an earlier-due one.
#[tokio::test]
async fn the_selector_orders_due_work_by_earliest_next_due() {
    let items =
        |source: freshell_protocol::session_names::NameSource, key: &str| super::NativeWorkItem {
            target: pending(key),
            location: claude_location("/h/.claude", key),
            location_revision: 1,
            desired_revision: 1,
            desired_name: "x".to_string(),
            desired_source: source,
            cycles_consumed: 0,
            next_due: None,
        };
    let mut backoff = std::collections::HashMap::new();

    // An earlier-due series with a LATER reference key must be served before
    // a later-due series with an earlier key.
    let late_due_early_key = super::NativeWorkItem {
        next_due: Some(500_000),
        ..items(
            freshell_protocol::session_names::NameSource::FreshellAi,
            "a-early-key",
        )
    };
    let early_due_late_key = super::NativeWorkItem {
        next_due: Some(100_000),
        ..items(
            freshell_protocol::session_names::NameSource::FreshellAi,
            "z-late-key",
        )
    };
    let picked = super::select_next(
        &[late_due_early_key.clone(), early_due_late_key.clone()],
        &mut backoff,
    );
    assert_eq!(
        picked.unwrap().target,
        early_due_late_key.target,
        "earliest nextDue wins among due items, regardless of the reference key"
    );

    // Equal nextDue falls back to the stable reference key.
    let equal_due_later_key = super::NativeWorkItem {
        next_due: Some(100_000),
        ..items(
            freshell_protocol::session_names::NameSource::FreshellAi,
            "zz-equal-due",
        )
    };
    let picked = super::select_next(
        &[early_due_late_key.clone(), equal_due_later_key.clone()],
        &mut backoff,
    );
    assert_eq!(
        picked.unwrap().target,
        early_due_late_key.target,
        "equal nextDue falls back to the stable reference key"
    );

    // An unarmed (None) next_due is immediately ready — the select_generation
    // convention: it sorts as due-from-zero, i.e. at least as overdue as any
    // explicit due.
    let unarmed = items(
        freshell_protocol::session_names::NameSource::FreshellAi,
        "m-unarmed",
    );
    let picked = super::select_next(&[early_due_late_key.clone(), unarmed.clone()], &mut backoff);
    assert_eq!(
        picked.unwrap().target,
        unarmed.target,
        "a None (immediately ready) next_due sorts before an explicit later due"
    );

    // Manual-first still wins over an earlier due automatic series.
    let manual_late_due = super::NativeWorkItem {
        next_due: Some(900_000),
        ..items(
            freshell_protocol::session_names::NameSource::Manual,
            "y-manual",
        )
    };
    let picked = super::select_next(
        &[early_due_late_key.clone(), manual_late_due.clone()],
        &mut backoff,
    );
    assert_eq!(
        picked.unwrap().target,
        manual_late_due.target,
        "ready manual projection is served first, regardless of due order"
    );
}

/// Delta-review round 3, finding 7: `native_work_snapshot` must read the
/// same test-offset-aware decision clock (`effective_now_ms`) as its
/// sibling `generation_work_snapshot`. The real-clock `now_ms()` made the
/// due filter ignore the `ClockOffsetMs` hook, so a clock-controlled
/// native test could never advance virtual time through the snapshot's due
/// gate (the claim path already uses the effective clock via TxnMeta).
#[tokio::test]
async fn native_work_snapshot_reads_the_test_offset_aware_clock() {
    let dir = temp_data_dir();
    crate::session_names::set_test_hooks(
        dir.path(),
        vec![crate::session_names::TestHook::NativeRetryFloorMs(2_000)],
    );
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-clock", "/h/.claude").await;

    // Consume cycle 1 and fold an undelivered failure: the retry becomes due
    // 60ms after the fold (the effective decision clock stamps the fold).
    let claim = store
        .claim_native_cycle(target.clone(), "cycle-1".to_string())
        .await
        .unwrap()
        .expect("cycle 1 claims — an armed series is immediately ready");
    store
        .fold_native_outcome(
            target.clone(),
            claim.location_revision,
            claim.series_epoch,
            NativeOutcomeFold::Undelivered {
                reason: "connect refusal".to_string(),
            },
        )
        .await
        .expect("failure folds a record update");

    // Not yet due on the wall clock: the snapshot stays empty.
    assert!(
        store.native_work_snapshot().is_empty(),
        "cycle 2 waits for the retry floor"
    );

    // Advance virtual time past the floor: the offset-aware due filter must
    // admit the retry (the real wall clock has NOT moved 60s).
    crate::session_names::set_test_hooks(
        dir.path(),
        vec![
            crate::session_names::TestHook::NativeRetryFloorMs(2_000),
            crate::session_names::TestHook::ClockOffsetMs(60_000),
        ],
    );
    let items = store.native_work_snapshot();
    assert!(
        items.iter().any(|item| item.target == target),
        "the offset-aware clock admits the due native retry"
    );
}

// ---------------------------------------------------------------------------
// Task 3 fix round: the writeback contract's behavioral reds and pins.
// ---------------------------------------------------------------------------

/// The single nativeWrite series entry of a seeded one-series document
/// (black-box: the persisted document is the contract).
fn native_entry_of(doc: &Value) -> &Value {
    doc["nativeWrite"]
        .as_object()
        .expect("nativeWrite section")
        .values()
        .next()
        .expect("one series")
}

/// The nativeWrite series entry for ONE chosen target (black-box: the
/// persisted document is the contract) — the keyed lookup multi-series
/// documents need.
fn native_entry_for<'a>(doc: &'a Value, target: &SessionNameRef) -> &'a Value {
    let key = crate::session_names::name_ref_key(target);
    doc["nativeWrite"]
        .as_object()
        .expect("nativeWrite section")
        .get(&key)
        .unwrap_or_else(|| panic!("no native series for {key}"))
}

/// The current armed series' epoch (black-box: the persisted document is the
/// contract) — the stamp a hand-rolled fold "as the next cycle's read would"
/// carries.
fn current_series_epoch(dir: &std::path::Path) -> u64 {
    native_entry_of(&document_json(dir))["seriesEpoch"]
        .as_u64()
        .expect("the armed series stamps its epoch")
}

fn codex_location(home: &str, thread: &str) -> NativeLocation {
    NativeLocation::Codex {
        codex_home: home.to_string(),
        native_thread_id: Some(thread.to_string()),
        rollout_path: None,
        persistence_evidence: None,
    }
}

fn opencode_location(database: &str, session_id: &str, directory: &str) -> NativeLocation {
    NativeLocation::Opencode {
        database_path: database.to_string(),
        native_session_id: Some(session_id.to_string()),
        original_directory: Some(directory.to_string()),
        owned_local_endpoint: None,
    }
}

/// T3-C1: an existing native target that holds NO title yet is divergence,
/// not a missing target — the primary writeback case on every provider
/// (Claude sessions essentially never carry a customTitle until something
/// writes one; codex threads are unnamed until a TUI rename; opencode titles
/// can be null). The pre-write read answering `None` must DISPATCH the write
/// and the confirming readback must synchronize the series.
#[tokio::test]
async fn an_untitled_native_target_still_receives_the_writeback() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-untitled", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![WriteStep::Confirm]);
    backend.set_title(None);

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    assert_eq!(backend.writes(), 1, "an untitled target receives the write");
    assert_eq!(backend.reads(), 2, "pre-write read + confirming readback");
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series projected");
    assert_eq!(
        sync.status,
        NativeSyncStatus::Synced,
        "the confirming readback synchronizes the exact revision"
    );
}

/// T3-I1: an observed fallback-named record projects NO nativeSync at all —
/// the entry that retains the observation is provenance, never a series.
#[tokio::test]
async fn observed_fallback_records_never_project_a_native_series() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-obs-fallback");
    ensure_pending(&store, "h-obs-fallback", Some("/work/project"))
        .await
        .expect("ensure pending");

    // A live provider observation arrives for the fallback-named record and
    // is accepted (directory rank loses to provider_ai).
    observe(&store, target.clone(), "Externally Retitled", 0)
        .await
        .expect("the observation folds");
    let record = store
        .get(vec![target.clone()])
        .await
        .unwrap()
        .remove(0)
        .record;
    assert_eq!(
        record.source,
        freshell_protocol::session_names::NameSource::ProviderAi
    );

    let sync = native_sync_of(&store, target.clone()).await;
    assert!(
        sync.is_none(),
        "non-writable observed records project no native status"
    );
    assert!(
        store.native_work_snapshot().is_empty(),
        "no series is armed for fallback names"
    );
}

// ---------------------------------------------------------------------------
// T3-I2 / T3-M2: the codex adapter's classification fidelity and the
// metadata-read request bound, driven through a scripted app-server peer.
// ---------------------------------------------------------------------------

/// The codex adapter over a root-matched LIVE client on the in-memory
/// channel transport (the exact seam production main wires), paired with the
/// scriptable server end.
fn codex_adapter_with_peer(
    root: &str,
) -> (super::CodexNativeNameAdapter, freshell_codex::ChannelPeer) {
    let (transport, peer) = freshell_codex::new_channel_transport();
    let (client, notifs) = freshell_codex::app_server::CodexAppServerClient::connect(transport);
    // Keep the notification stream alive for the client's lifetime.
    std::mem::forget(notifs);
    let client = Arc::new(client);
    let matched_root = root.to_string();
    let resolver: super::CodexRootClientResolver = Arc::new(move |root: String| {
        let matched_root = matched_root.clone();
        let client = Arc::clone(&client);
        Box::pin(async move { (root == matched_root).then(|| Arc::clone(&client)) })
            as std::pin::Pin<
                Box<
                    dyn std::future::Future<
                            Output = Option<Arc<freshell_codex::app_server::CodexAppServerClient>>,
                        > + Send,
                >,
            >
    });
    (super::CodexNativeNameAdapter::new(resolver), peer)
}

/// Serve the initialize handshake on `peer` (initialize request + initialized
/// notification), returning once the client is ready for method calls.
async fn serve_codex_handshake(peer: &freshell_codex::ChannelPeer, root: &str) {
    let (id, method, _) = peer.expect_request().await;
    assert_eq!(method, "initialize");
    peer.respond(&id, serde_json::json!({ "codexHome": root }));
    let (method, _) = peer.expect_notification().await;
    assert_eq!(method, "initialized");
}

/// T3-I2: the classifier itself keeps the four-way contract faithful — a
/// mid-flight drop and an unparseable answer are AMBIGUOUS (the call may have
/// applied), an answered rejection is UNDELIVERED (known-no-effect, retryable)
/// unless it diagnoses the target as missing/unsupported, and a timeout stays
/// ambiguous. Never reduced to a generic timeout or a blanket unsupported.
#[test]
fn codex_error_classes_preserve_their_native_classification() {
    use freshell_codex::app_server::CodexAppServerError;
    use freshell_codex::protocol::RpcError;

    let classified =
        |error: CodexAppServerError| super::classify_codex_error(error, "thread/name/set");
    assert!(matches!(
        classified(CodexAppServerError::Timeout {
            method: "thread/name/set".into(),
            timeout_ms: 20_000,
        }),
        super::NativeClassified::Ambiguous(_)
    ));
    assert!(
        matches!(
            classified(CodexAppServerError::Closed {
                method: "thread/name/set".into()
            }),
            super::NativeClassified::Ambiguous(_)
        ),
        "a mid-flight drop may have applied — ambiguous, never unsupported"
    );
    assert!(
        matches!(
            classified(CodexAppServerError::InvalidResponse {
                method: "thread/name/set".into(),
                detail: "unparseable".into(),
            }),
            super::NativeClassified::Ambiguous(_)
        ),
        "an unparseable answer is not a diagnosed capability failure"
    );
    assert!(matches!(
        classified(CodexAppServerError::Transport {
            method: "thread/name/set".into(),
            message: "send refused".into(),
        }),
        super::NativeClassified::Undelivered(_)
    ));
    assert!(
        matches!(
            classified(CodexAppServerError::Rpc {
                method: "thread/name/set".into(),
                error: RpcError {
                    code: -32004,
                    message: "thread not found".into(),
                    data: None,
                },
            }),
            super::NativeClassified::Unsupported(_)
        ),
        "a diagnosed not-found is a capability failure"
    );
    assert!(
        matches!(
            classified(CodexAppServerError::Rpc {
                method: "thread/name/set".into(),
                error: RpcError {
                    code: -32603,
                    message: "internal error".into(),
                    data: None,
                },
            }),
            super::NativeClassified::Undelivered(_)
        ),
        "a generic answered rejection is known-no-effect retryable, never a settled capability failure"
    );
}

/// T3-I2: a connection closed while the metadata read is in flight must
/// classify AMBIGUOUS — settling `unsupported` on a possibly-applied call
/// ends repair until a location change.
#[tokio::test]
async fn a_mid_flight_connection_close_on_the_read_is_ambiguous() {
    let (adapter, peer) = codex_adapter_with_peer("/h/codex");
    let target = NativeNameTarget {
        name_ref: session(
            freshell_protocol::session_names::NamedProvider::Codex,
            "t-closed",
        ),
        location: codex_location("/h/codex", "t-closed"),
        location_revision: 1,
    };
    let read = tokio::spawn(adapter.read(target));
    serve_codex_handshake(&peer, "/h/codex").await;
    let (_id, method, _) = peer.expect_request().await;
    assert_eq!(method, "thread/read");
    peer.disconnect();
    match read.await.expect("read task") {
        NativeCallResult::Ambiguous(reason) => {
            assert!(reason.contains("closed"), "{reason}")
        }
        other => panic!("a mid-flight drop must classify ambiguous, got: {other:?}"),
    }
}

/// T3-I2: the same fidelity on the WRITE — the mutation-critical direction.
#[tokio::test]
async fn a_write_dropped_mid_flight_is_ambiguous() {
    let (adapter, peer) = codex_adapter_with_peer("/h/codex");
    let attempt = super::NativeNameAttempt {
        target: NativeNameTarget {
            name_ref: session(
                freshell_protocol::session_names::NamedProvider::Codex,
                "t-write-closed",
            ),
            location: codex_location("/h/codex", "t-write-closed"),
            location_revision: 1,
        },
        desired_revision: 7,
        title: "Manual Title".to_string(),
        source: freshell_protocol::session_names::NameSource::Manual,
        receipt_id: "receipt-write-closed".to_string(),
        cycle: 1,
    };
    let write = tokio::spawn(adapter.write(attempt));
    serve_codex_handshake(&peer, "/h/codex").await;
    let (_id, method, _) = peer.expect_request().await;
    assert_eq!(method, "thread/name/set");
    peer.disconnect();
    match write.await.expect("write task") {
        NativeCallResult::Ambiguous(reason) => {
            assert!(reason.contains("closed"), "{reason}")
        }
        other => panic!("a mid-flight write drop must classify ambiguous, got: {other:?}"),
    }
}

/// T3-I2: an ANSWERED JSON-RPC error is a definitive rejection —
/// known-no-effect retryable (`Undelivered`) for a generic failure, and a
/// diagnosed not-found settles as `Unsupported`.
#[tokio::test]
async fn answered_rpc_rejections_classify_by_diagnosis() {
    // A generic answered rejection: retryable known-no-effect.
    let (adapter, peer) = codex_adapter_with_peer("/h/codex");
    let target = NativeNameTarget {
        name_ref: session(
            freshell_protocol::session_names::NamedProvider::Codex,
            "t-rpc-generic",
        ),
        location: codex_location("/h/codex", "t-rpc-generic"),
        location_revision: 1,
    };
    let read = tokio::spawn(adapter.read(target));
    serve_codex_handshake(&peer, "/h/codex").await;
    let (id, method, _) = peer.expect_request().await;
    assert_eq!(method, "thread/read");
    peer.respond_error(&id, -32603, "internal error");
    match read.await.expect("read task") {
        NativeCallResult::Undelivered(reason) => {
            assert!(reason.contains("internal error"), "{reason}")
        }
        other => panic!("a generic answered rejection is undelivered retryable, got: {other:?}"),
    }

    // A diagnosed not-found: the target is missing — a settled capability
    // failure that only a location change re-arms.
    let (adapter, peer) = codex_adapter_with_peer("/h/codex");
    let target = NativeNameTarget {
        name_ref: session(
            freshell_protocol::session_names::NamedProvider::Codex,
            "t-rpc-missing",
        ),
        location: codex_location("/h/codex", "t-rpc-missing"),
        location_revision: 1,
    };
    let read = tokio::spawn(adapter.read(target));
    serve_codex_handshake(&peer, "/h/codex").await;
    let (id, method, _) = peer.expect_request().await;
    assert_eq!(method, "thread/read");
    peer.respond_error(&id, -32004, "thread not found");
    match read.await.expect("read task") {
        NativeCallResult::Unsupported(reason) => {
            assert!(reason.contains("not found"), "{reason}")
        }
        other => panic!("a diagnosed not-found is unsupported, got: {other:?}"),
    }
}

/// T3-M2: the native metadata read (`thread/read` with `includeTurns:false`)
/// is bounded to the plan's 20-second native request budget — NOT the 30s
/// snapshot budget a full-thread read rides. Virtual time: the handshake is
/// answered, the metadata request never is, and the read must resolve inside
/// a 25s guard.
#[tokio::test(start_paused = true)]
async fn the_codex_native_metadata_read_is_bounded_to_twenty_seconds() {
    let (adapter, peer) = codex_adapter_with_peer("/h/codex");
    let target = NativeNameTarget {
        name_ref: session(
            freshell_protocol::session_names::NamedProvider::Codex,
            "t-metadata-bound",
        ),
        location: codex_location("/h/codex", "t-metadata-bound"),
        location_revision: 1,
    };
    let read = tokio::spawn(adapter.read(target));
    // Handshake servant: answer initialize, observe the metadata request,
    // then HOLD the peer open without answering — the bound under test is
    // the client's own request timeout.
    tokio::spawn(async move {
        let (id, method, _) = peer.expect_request().await;
        assert_eq!(method, "initialize");
        peer.respond(&id, serde_json::json!({ "codexHome": "/h/codex" }));
        let (method, _) = peer.expect_notification().await;
        assert_eq!(method, "initialized");
        let (_id, method, _) = peer.expect_request().await;
        assert_eq!(method, "thread/read");
        // Keep the connection open and never answer the metadata read.
        std::future::pending::<()>().await;
    });
    tokio::select! {
        result = read => match result.expect("read task") {
            NativeCallResult::Ambiguous(reason) => {
                assert!(reason.contains("timed out"), "{reason}");
            }
            other => panic!("the bounded metadata read should time out ambiguous, got: {other:?}"),
        },
        _ = tokio::time::sleep(Duration::from_secs(25)) => {
            panic!("the codex native metadata read outlived the 20s native request bound (the 30s snapshot budget)");
        }
    }
}

// ---------------------------------------------------------------------------
// T3-M3 / T3-M4: the opencode adapter's HTTP classification and the read's
// effective-database context gate (the opencode crate's scripted-IO shapes).
// ---------------------------------------------------------------------------

use freshell_opencode::serve::{
    Endpoint, EventSink, EventSource, EventStreamHandle, HttpMethod, OpencodeServeManager,
    PortAllocator, ProcessSpawner, ServeConfig, ServeDeps, ServeHttp, ServeHttpError,
    ServeHttpRequest, ServeHttpResponse, ServeProcess, SpawnRequest,
};

/// Records every dispatched request and answers a fixed status with `{}` —
/// except the `/global/health` readiness probe, which always answers healthy
/// (the scripted status models the SESSION routes' answers, not the health
/// endpoint).
struct StatusHttp {
    status: u16,
    requests: Mutex<Vec<HttpMethod>>,
}

impl ServeHttp for StatusHttp {
    fn request<'a>(
        &'a self,
        req: ServeHttpRequest,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>> + Send + 'a,
        >,
    > {
        let is_health_probe = req.url.contains("/global/health");
        if !is_health_probe {
            // Only SESSION-route dispatches count as dispatches under test;
            // the readiness probe is infrastructure.
            self.requests.lock().unwrap().push(req.method);
        }
        let status = if is_health_probe { 200 } else { self.status };
        Box::pin(async move { Ok(ServeHttpResponse::new(status, b"{}".to_vec())) })
    }
}

struct FixedPort;
impl PortAllocator for FixedPort {
    fn allocate(&self) -> Result<Endpoint, String> {
        Ok(Endpoint {
            hostname: "127.0.0.1".into(),
            port: 1,
        })
    }
}

struct NeverExitsProcess;
impl ServeProcess for NeverExitsProcess {
    fn exited(&self) -> Option<i32> {
        None
    }
    fn take_fatal_startup_error(&self) -> Option<String> {
        None
    }
    fn kill(&self) {}
}

struct FakeSpawner;
impl ProcessSpawner for FakeSpawner {
    fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
        Ok(Box::new(NeverExitsProcess))
    }
}

struct NeverConnects;
impl EventSource for NeverConnects {
    fn connect(&self, _url: String, _sink: EventSink) -> Box<dyn EventStreamHandle> {
        struct Handle;
        impl EventStreamHandle for Handle {}
        Box::new(Handle)
    }
}

/// A started manager over the scripted fake. `env` layers the serve's spawn
/// environment (the OPENCODE_DB override evaluation reads the LAST entry).
async fn started_opencode_manager(
    env: Vec<(String, String)>,
    status: u16,
) -> (OpencodeServeManager, Arc<StatusHttp>) {
    let http = Arc::new(StatusHttp {
        status,
        requests: Mutex::new(Vec::new()),
    });
    let deps = ServeDeps {
        spawner: Arc::new(FakeSpawner),
        http: http.clone(),
        ports: Arc::new(FixedPort),
        events: Arc::new(NeverConnects),
    };
    let config = ServeConfig {
        env,
        health_timeout: Duration::from_millis(500),
        ..Default::default()
    };
    let manager = OpencodeServeManager::new(deps, config);
    manager.ensure_started().await.expect("fake serve starts");
    (manager, http)
}

/// Wrap one started manager in a SHARED cell holding `Some(manager)` — the
/// post-materialization state of the fresh-agent handle.
fn shared_opencode(manager: OpencodeServeManager) -> super::SharedOpencodeManager {
    Arc::new(tokio::sync::Mutex::new(Some(manager)))
}

/// Answers the session GET with no title until the first PATCH has been
/// seen, then with the desired title — the pre-write read diverges (the
/// write must dispatch) and the confirming readback synchronizes.
struct TitledHttp {
    requests: Mutex<Vec<HttpMethod>>,
}

impl ServeHttp for TitledHttp {
    fn request<'a>(
        &'a self,
        req: ServeHttpRequest,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>> + Send + 'a,
        >,
    > {
        let is_health_probe = req.url.contains("/global/health");
        if !is_health_probe {
            self.requests.lock().unwrap().push(req.method);
        }
        let patched = self.requests.lock().unwrap().contains(&HttpMethod::Patch);
        let body = if is_health_probe {
            b"{}".to_vec()
        } else if patched {
            br#"{"title":"Shared-Serve Opencode Name"}"#.to_vec()
        } else {
            b"{}".to_vec()
        };
        Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) })
    }
}

/// A started shared manager over the titled fake (the serve is pinned to the
/// database the location carries so the effective-database gate passes).
async fn started_shared_titled_manager(
    env: Vec<(String, String)>,
) -> (OpencodeServeManager, Arc<TitledHttp>) {
    let http = Arc::new(TitledHttp {
        requests: Mutex::new(Vec::new()),
    });
    let deps = ServeDeps {
        spawner: Arc::new(FakeSpawner),
        http: http.clone(),
        ports: Arc::new(FixedPort),
        events: Arc::new(NeverConnects),
    };
    let config = ServeConfig {
        env,
        health_timeout: Duration::from_millis(500),
        ..Default::default()
    };
    let manager = OpencodeServeManager::new(deps, config);
    manager.ensure_started().await.expect("fake serve starts");
    (manager, http)
}

/// Unified agent names (Task 8 acceptance): the shared opencode serve
/// manager is created LAZILY by the first freshopencode pane's lane
/// (`ensure_manager`), long after the native worker's dispatch was wired at
/// boot. The adapter must resolve the CURRENT shared manager per operation —
/// a boot-time snapshot of the lazy cell would freeze its `None` and pause
/// every opencode native series forever (the native smoke's live-observed
/// gap: renames arm, the pane materializes, and the series never consumes a
/// single cycle while claude and codex settle through the same worker).
#[tokio::test]
async fn an_opencode_native_series_resumes_when_the_shared_serve_arrives_after_boot() {
    struct NeverGemini;
    impl crate::ai_title::GeminiTransport for NeverGemini {
        fn generate_content(
            &self,
            _prompt: String,
            _max_output_tokens: u32,
        ) -> crate::ai_title::BoxFuture<Result<String, String>> {
            Box::pin(std::future::pending())
        }
    }
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = session(
        freshell_protocol::session_names::NamedProvider::Opencode,
        "ses_boot-late",
    );
    // The auto-title sweep's hydration shape: the indexed record exists
    // first (a bare session rename with no record 404s), the manual rename
    // arms the series, and the pane lane's acquisition attaches the
    // verified route.
    store
        .hydrate_indexed(
            crate::session_name_generation::IndexedNameInput {
                provider: freshell_protocol::session_names::NamedProvider::Opencode,
                session_id: "ses_boot-late".to_string(),
                cwd: Some("/work/proj".to_string()),
                first_user_message: Some("Materialize the shared serve".to_string()),
                provider_title: None,
            },
            false,
        )
        .await
        .expect("hydrate");
    rename_user(&store, target.clone(), "Shared-Serve Opencode Name")
        .await
        .expect("the manual rename arms the series");
    record_acquisition(
        &store,
        target.clone(),
        verified_acquisition(opencode_location(
            "/pinned/shared.db",
            "ses_boot-late",
            "/work/proj",
        )),
    )
    .await
    .expect("acquire");

    // The boot-time wiring: the shared cell is EMPTY — no pane has run yet.
    let shared: super::SharedOpencodeManager = Arc::new(tokio::sync::Mutex::new(None));
    let dispatch = Arc::new(super::NativeNameDispatch::new(
        None,
        None,
        Some(super::OpencodeNativeNameAdapter::new(shared.clone())),
    ));
    let generator = Arc::new(crate::session_name_generation::SessionNameGenerator::new(
        crate::settings_store::SettingsStore::load(Some(dir.path()), vec![]),
        crate::ai_title::GeminiSessionNameAuth::direct_for_test(crate::ai_title::AiKeyCell::init(
            None, None,
        )),
        Arc::new(NeverGemini) as Arc<dyn crate::ai_title::GeminiTransport>,
    ));
    let worker = super::SessionNameWorker::start(Arc::clone(&store), dispatch, generator);

    // While the shared serve is absent the series pauses: pending, with
    // NOTHING consumed (the capability probe burns no cycle).
    tokio::time::sleep(Duration::from_millis(700)).await;
    let paused = native_sync_of(&store, target.clone())
        .await
        .expect("the series projects");
    assert_eq!(
        paused.status,
        NativeSyncStatus::Pending,
        "the absent shared serve pauses the series"
    );
    let doc = document_json(dir.path());
    let native_write = doc["nativeWrite"].as_object().expect("nativeWrite section");
    assert_eq!(native_write.len(), 1, "exactly one armed series");
    let entry = native_write.values().next().expect("the series entry");
    assert_eq!(
        entry["cyclesConsumed"].as_u64(),
        Some(0),
        "the pause consumes nothing"
    );

    // The pane lane materializes the shared serve (the cell flips to Some).
    let (manager, http) = started_shared_titled_manager(vec![(
        "OPENCODE_DB".to_string(),
        "/pinned/shared.db".to_string(),
    )])
    .await;
    *shared.lock().await = Some(manager);

    // Within one capability re-probe window the series resumes and runs to
    // synced — WITHOUT re-wiring the worker.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let sync = native_sync_of(&store, target.clone())
            .await
            .expect("the series projects");
        if sync.status == NativeSyncStatus::Synced {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the series never resumed after the shared serve arrived: {sync:?}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    worker.abort();
    assert!(
        http.requests.lock().unwrap().contains(&HttpMethod::Patch),
        "the writeback PATCH dispatched through the shared serve"
    );
}

fn opencode_attempt(database: &str, session_id: &str) -> super::NativeNameAttempt {
    super::NativeNameAttempt {
        target: NativeNameTarget {
            name_ref: session(
                freshell_protocol::session_names::NamedProvider::Opencode,
                session_id,
            ),
            location: opencode_location(database, session_id, "/work/project"),
            location_revision: 1,
        },
        desired_revision: 7,
        title: "The Renamed Session".to_string(),
        source: freshell_protocol::session_names::NameSource::Manual,
        receipt_id: "receipt-opencode".to_string(),
        cycle: 1,
    }
}

/// T3-M3: an HTTP error AFTER dispatch is not provably effect-free — a 5xx
/// must classify AMBIGUOUS (the request was delivered and answered), while a
/// definitive 4xx rejection stays UNDELIVERED.
#[tokio::test]
async fn opencode_http_failures_after_dispatch_are_ambiguous() {
    // A matching database context (the serve is pinned to the database the
    // location carries), so the write dispatches.
    let (manager, http) = started_opencode_manager(
        vec![("OPENCODE_DB".to_string(), "/pinned/other.db".to_string())],
        500,
    )
    .await;
    let adapter = super::OpencodeNativeNameAdapter::new(shared_opencode(manager));
    match adapter
        .write(opencode_attempt("/pinned/other.db", "ses_5xx"))
        .await
    {
        NativeCallResult::Ambiguous(reason) => assert!(reason.contains("500"), "{reason}"),
        other => {
            panic!("a 5xx-after-dispatch is not provably effect-free — ambiguous, got: {other:?}")
        }
    }
    assert_eq!(
        http.requests.lock().unwrap().len(),
        1,
        "the PATCH did dispatch"
    );

    // A definitive 4xx rejection: the request never took effect.
    let (manager, http) = started_opencode_manager(
        vec![("OPENCODE_DB".to_string(), "/pinned/other.db".to_string())],
        400,
    )
    .await;
    let adapter = super::OpencodeNativeNameAdapter::new(shared_opencode(manager));
    match adapter
        .write(opencode_attempt("/pinned/other.db", "ses_4xx"))
        .await
    {
        NativeCallResult::Undelivered(reason) => assert!(reason.contains("400"), "{reason}"),
        other => panic!("a definitive 4xx rejection is undelivered, got: {other:?}"),
    }
    assert_eq!(http.requests.lock().unwrap().len(), 1);
}

/// T3-M4: the READ dispatches only past the same effective-database context
/// gate the write honors — a mismatched serve must never answer a read
/// (wrong-store observation or a burned cycle before the write's gate
/// rejects).
#[tokio::test]
async fn the_opencode_read_gates_on_the_effective_database_context() {
    let (manager, http) = started_opencode_manager(
        vec![("OPENCODE_DB".to_string(), "/pinned/other.db".to_string())],
        200,
    )
    .await;
    let adapter = super::OpencodeNativeNameAdapter::new(shared_opencode(manager));
    let target = NativeNameTarget {
        name_ref: session(
            freshell_protocol::session_names::NamedProvider::Opencode,
            "ses_mismatch",
        ),
        location: opencode_location(
            "/data/home/opencode/opencode.db",
            "ses_mismatch",
            "/work/project",
        ),
        location_revision: 1,
    };
    match adapter.read(target).await {
        NativeCallResult::Unsupported(reason) => assert!(reason.contains("mismatch"), "{reason}"),
        other => panic!(
            "a mismatched database context must refuse the READ as unsupported, got: {other:?}"
        ),
    }
    assert!(
        http.requests.lock().unwrap().is_empty(),
        "the refused read never dispatches"
    );
}

// ---------------------------------------------------------------------------
// T3-I3: the capability-pause rule — an absent route/capability pauses
// BEFORE consuming a cycle (the series stays pending, the allowance intact),
// and work proceeds once the capability arrives.
// ---------------------------------------------------------------------------

/// A dispatch-shaped backend whose wired adapter can swap mid-test: `None`
/// models the degraded boot (no adapter for the provider — every operation
/// answers the production `Unsupported`), `Some(scripted)` models the
/// capability arriving.
struct SwappableDispatch {
    live: Arc<std::sync::RwLock<Option<Arc<ScriptedBackend>>>>,
}

impl SwappableDispatch {
    fn unwired() -> Arc<Self> {
        Arc::new(Self {
            live: Arc::new(std::sync::RwLock::new(None)),
        })
    }

    fn wire(self: &Arc<Self>, backend: Arc<ScriptedBackend>) {
        *self.live.write().unwrap() = Some(backend);
    }
}

impl NativeNameBackend for SwappableDispatch {
    fn read(&self, target: NativeNameTarget) -> super::NativeFuture<NativeNameReadback> {
        let live = self.live.read().unwrap().clone();
        match live {
            Some(backend) => backend.read(target),
            None => Box::pin(async move {
                NativeCallResult::Unsupported(
                    "no native adapter is wired for this provider".to_string(),
                )
            }),
        }
    }

    fn write(&self, attempt: super::NativeNameAttempt) -> super::NativeFuture<()> {
        let live = self.live.read().unwrap().clone();
        match live {
            Some(backend) => backend.write(attempt),
            None => Box::pin(async move {
                NativeCallResult::Unsupported(
                    "no native adapter is wired for this provider".to_string(),
                )
            }),
        }
    }

    fn route_available(&self, _target: NativeNameTarget) -> super::NativeProbeFuture {
        let live = self.live.read().unwrap().is_some();
        Box::pin(async move { live })
    }
}

/// T3-I3: rename a session whose provider capability is ABSENT (a degraded
/// boot with no adapter wired): no cycle is consumed, the series stays
/// `pending` and discoverable, and the work proceeds once the capability
/// arrives — never a burned cycle and a misleading `unsupported` per
/// decision.
#[tokio::test]
async fn an_absent_native_capability_pauses_before_consuming_a_cycle() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-capability", "/h/.claude").await;
    let dispatch = SwappableDispatch::unwired();

    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        dispatch.clone(),
        inert_generation(dir.path()),
    );
    // Ample opportunity for the loop to (wrongly) claim while the capability
    // is absent — the worker polls every 500ms.
    tokio::time::sleep(Duration::from_millis(900)).await;

    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series projected");
    assert_eq!(
        sync.status,
        NativeSyncStatus::Pending,
        "capability-absent pauses as pending"
    );
    assert!(
        !store.native_work_snapshot().is_empty(),
        "the series stays discoverable work while paused"
    );
    let doc = document_json(dir.path());
    assert_eq!(
        native_entry_of(&doc)["cyclesConsumed"].as_u64(),
        Some(0),
        "no cycle is consumed while the capability is absent"
    );

    // The capability arrives: the SAME series proceeds and converges.
    let backend = ScriptedBackend::new(vec![WriteStep::Confirm]);
    backend.set_title(Some("Divergent"));
    dispatch.wire(backend.clone());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(sync) = native_sync_of(&store, target.clone()).await {
            if sync.status == NativeSyncStatus::Synced {
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the paused series must converge once the capability arrives"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    worker.abort();
    assert_eq!(backend.writes(), 1);
    assert_eq!(backend.reads(), 2);
}

/// A dispatch-shaped backend whose capability probe refuses a chosen set of
/// claude locations (keyed by config root) until they are wired: the
/// per-target capability shape the fairness guarantee needs — one paused
/// head, one ready series — over an ordinary scripted provider.
struct SelectiveCapabilityBackend {
    scripted: Arc<ScriptedBackend>,
    refused: Arc<Mutex<Vec<String>>>,
}

impl SelectiveCapabilityBackend {
    fn refusing(scripted: Arc<ScriptedBackend>, roots: &[&str]) -> Arc<Self> {
        Arc::new(Self {
            scripted,
            refused: Arc::new(Mutex::new(
                roots.iter().map(|root| root.to_string()).collect(),
            )),
        })
    }

    fn wire(&self, root: &str) {
        self.refused.lock().unwrap().retain(|r| r != root);
    }
}

impl NativeNameBackend for SelectiveCapabilityBackend {
    fn read(&self, target: NativeNameTarget) -> super::NativeFuture<NativeNameReadback> {
        self.scripted.read(target)
    }

    fn write(&self, attempt: super::NativeNameAttempt) -> super::NativeFuture<()> {
        self.scripted.write(attempt)
    }

    fn route_available(&self, target: NativeNameTarget) -> super::NativeProbeFuture {
        let refused = match &target.location {
            NativeLocation::Claude { config_root, .. } => self
                .refused
                .lock()
                .unwrap()
                .iter()
                .any(|r| r == config_root),
            _ => false,
        };
        Box::pin(async move { !refused })
    }
}

/// NEW-1: a capability-paused series at the HEAD of the selector must never
/// starve the armed series behind it. A probe refusal rotates the paused
/// head out of selection for a bounded window: the READY series converges,
/// the paused series itself stays pending, discoverable, and uncharged, and
/// once its capability arrives it converges within one bounded window —
/// the rotation is a re-probe backoff, never an eviction.
#[tokio::test]
async fn a_capability_paused_head_does_not_starve_the_ready_series_behind_it() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    // The paused head sorts FIRST under the selector's stable key order
    // (`["pending",a-head]` < `["pending",b-ready]`), so without rotation
    // it would hold the single-item selection forever.
    let paused = armed_pending(&store, "a-head", "/paused/.claude").await;
    let ready = armed_pending(&store, "b-ready", "/ready/.claude").await;
    rename_user(&store, paused.clone(), "Paused Name")
        .await
        .expect("rename the head");
    rename_user(&store, ready.clone(), "Ready Name")
        .await
        .expect("rename the ready series");

    let scripted = ScriptedBackend::new(vec![WriteStep::Confirm, WriteStep::Confirm]);
    scripted.set_title(Some("Divergent"));
    let dispatch = SelectiveCapabilityBackend::refusing(scripted.clone(), &["/paused/.claude"]);

    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        dispatch.clone(),
        inert_generation(dir.path()),
    );

    // THE fairness assertion: the ready series converges DESPITE the paused
    // head holding the front of the selector.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(sync) = native_sync_of(&store, ready.clone()).await {
            if sync.status == NativeSyncStatus::Synced {
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the ready series must converge despite the paused head"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // The paused head consumed nothing while refused: still pending, still
    // discoverable work, its whole allowance intact.
    let sync = native_sync_of(&store, paused.clone())
        .await
        .expect("series projected");
    assert_eq!(
        sync.status,
        NativeSyncStatus::Pending,
        "the refused head stays pending"
    );
    assert!(
        store
            .native_work_snapshot()
            .iter()
            .any(|item| item.target == paused),
        "the refused head stays discoverable work"
    );
    let doc = document_json(dir.path());
    assert_eq!(
        native_entry_for(&doc, &paused)["cyclesConsumed"].as_u64(),
        Some(0),
        "the refused head consumed no cycle"
    );

    // The capability arrives: the paused head converges too.
    dispatch.wire("/paused/.claude");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(sync) = native_sync_of(&store, paused.clone()).await {
            if sync.status == NativeSyncStatus::Synced {
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the paused head must converge once its capability arrives"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    worker.abort();
    // Both series converged through their own full cycles — one write and
    // two reads each — and nothing was double-dispatched while paused.
    assert_eq!(scripted.writes(), 2);
    assert_eq!(scripted.reads(), 4);
}

// ---------------------------------------------------------------------------
// T3-I4: the packaged desktop app's staged helper path derivation.
// ---------------------------------------------------------------------------

/// `from_env` reads process-global env — serialize every from_env probe and
/// restore the prior values (the repo's ENV_LOCK convention).
static FROM_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn probe_from_env(
    vars: &[(&str, Option<&str>)],
    probe: impl FnOnce(&super::ClaudeNativeNameAdapter),
) {
    let _guard = FROM_ENV_LOCK.lock().unwrap();
    let saved: Vec<(&str, Option<std::ffi::OsString>)> = vars
        .iter()
        .map(|(key, _)| (*key, std::env::var_os(key)))
        .collect();
    for (key, value) in vars {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }
    probe(&super::ClaudeNativeNameAdapter::from_env());
    for (key, value) in saved {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }
}

/// T3-I4: the packaged app spawns the server with `FRESHELL_CLAUDE_SIDECAR`
/// pointing at the STAGED sidecar entry — the session-names helper must be
/// derived from its sibling directory (the staging places them together),
/// or Claude native writeback silently fails in every packaged install.
#[test]
fn the_packaged_sidecar_override_derives_the_staged_helper_path() {
    // The sidecar override alone: the helper is the staged sibling.
    probe_from_env(
        &[
            ("FRESHELL_CLAUDE_SESSION_NAMES", None),
            (
                "FRESHELL_CLAUDE_SIDECAR",
                Some("/runtime/claude-sidecar/index.mjs"),
            ),
        ],
        |adapter| {
            assert_eq!(
                adapter.helper_path,
                std::path::PathBuf::from("/runtime/claude-sidecar/session-names.mjs"),
                "the staged helper sits beside the staged sidecar entry"
            );
        },
    );
    // The explicit helper override WINS over the sibling derivation.
    probe_from_env(
        &[
            (
                "FRESHELL_CLAUDE_SESSION_NAMES",
                Some("/explicit/session-names.mjs"),
            ),
            (
                "FRESHELL_CLAUDE_SIDECAR",
                Some("/runtime/claude-sidecar/index.mjs"),
            ),
        ],
        |adapter| {
            assert_eq!(
                adapter.helper_path,
                std::path::PathBuf::from("/explicit/session-names.mjs")
            );
        },
    );
    // Neither override: the build-tree default beside the sidecar source.
    probe_from_env(
        &[
            ("FRESHELL_CLAUDE_SESSION_NAMES", None),
            ("FRESHELL_CLAUDE_SIDECAR", None),
        ],
        |adapter| {
            assert_eq!(
                adapter.helper_path,
                std::path::PathBuf::from(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../freshell-claude-sidecar/session-names.mjs"
                ))
            );
        },
    );
}

/// T3-M1 (Rust side): the helper child's project-key env is a deliberate
/// SET-OR-REMOVE — a non-empty location override sets the key, an absent or
/// empty one REMOVES it, so an inactive ambient override can never hijack
/// the project key. (The end-to-end leak tripwire lives in the vitest
/// claude-sidecar suite's fake SDK.)
#[test]
fn the_helper_child_env_sets_or_removes_the_project_key() {
    assert_eq!(
        super::project_key_child_env(Some("custom-project-key")),
        (
            "CLAUDE_CODE_PROJECT_DIR_NAME",
            Some("custom-project-key".to_string())
        ),
        "a non-empty override sets the key"
    );
    assert_eq!(
        super::project_key_child_env(None),
        ("CLAUDE_CODE_PROJECT_DIR_NAME", None),
        "an absent override removes the key"
    );
    assert_eq!(
        super::project_key_child_env(Some("")),
        ("CLAUDE_CODE_PROJECT_DIR_NAME", None),
        "an empty override removes the key too"
    );
}

// ---------------------------------------------------------------------------
// T3-I5(a)/(b): the read allowance cap and the stale-location fold guard
// (pins for rules the machine already enforces; the fix round proves each
// detects its harm by mutation before trusting it).
// ---------------------------------------------------------------------------

/// The six-read allowance: six charges succeed, the seventh is refused, and a
/// cycle whose pre-read cannot charge folds the refusal as its own undelivered
/// reason WITHOUT dispatching the provider read.
#[tokio::test]
async fn native_reads_are_bounded_at_six_per_revision() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-reads", "/h/.claude").await;
    let claim = store
        .claim_native_cycle(target.clone(), "receipt-reads".to_string())
        .await
        .unwrap()
        .expect("claim");
    for i in 1..=6 {
        assert!(
            store
                .charge_native_read(target.clone(), claim.series_epoch)
                .await
                .unwrap(),
            "read {i} charges against the allowance"
        );
    }
    assert!(
        !store
            .charge_native_read(target.clone(), claim.series_epoch)
            .await
            .unwrap(),
        "the seventh read is refused"
    );

    // The worker's exhaustion fold: the refused charge must never dispatch.
    let backend = ScriptedBackend::new(vec![]);
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    assert_eq!(backend.reads(), 0, "the refused read never dispatches");
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(sync.status, NativeSyncStatus::Unsynced);
    assert!(
        sync.reason.unwrap().contains("read allowance exhausted"),
        "the exhaustion fold names the refused allowance"
    );
    let doc = document_json(dir.path());
    assert_eq!(
        native_entry_of(&doc)["readsConsumed"].as_u64(),
        Some(6),
        "the cap is persisted, never exceeded"
    );
}

/// A late outcome folded with a SUPERSEDED attempted location revision is
/// provenance only: it must never mark the RELOCATED target synchronized or
/// leave a confirmed receipt behind.
#[tokio::test]
async fn a_relocated_target_ignores_late_folds_from_the_old_location() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-reloc", "/h/.claude").await;
    let claim = store
        .claim_native_cycle(target.clone(), "receipt-old-location".to_string())
        .await
        .unwrap()
        .expect("claim");
    assert_eq!(claim.location_revision, 1);

    // The verified route MOVES (a genuine reacquisition at a new root).
    record_acquisition(
        &store,
        target.clone(),
        verified_acquisition(claude_location("/h/.claude-moved", "h-reloc")),
    )
    .await
    .unwrap();

    // The old cycle completes late at the OLD location revision.
    store
        .fold_native_outcome(
            target.clone(),
            claim.location_revision,
            claim.series_epoch,
            NativeOutcomeFold::Read {
                observed: Some("Manual Title".to_string()),
                receipt: Some(claim.receipt_id.clone()),
            },
        )
        .await
        .unwrap();

    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_ne!(
        sync.status,
        NativeSyncStatus::Synced,
        "an old-location acknowledgement cannot sync the relocated target"
    );
    let doc = document_json(dir.path());
    let native = native_entry_of(&doc);
    assert!(
        native.get("lastConfirmedReceipt").is_none(),
        "the stale fold left no confirmed receipt"
    );
    // The series proceeds at the NEW route.
    let next = store
        .claim_native_cycle(target.clone(), "receipt-new-location".to_string())
        .await
        .unwrap()
        .expect("the series continues at the new location");
    assert_eq!(next.location_revision, 2);
}

// ---------------------------------------------------------------------------
// T3-M5: a mid-flight DOUBLE rename supersedes the executing cycle's series;
// the superseded cycle's folds and charges are provenance only.
// ---------------------------------------------------------------------------

/// The traced harm: the superseded cycle's AMBIGUOUS outcome lands on the
/// successor series and its inherited marker keeps a genuinely-converged
/// series visibly unsynced.
#[tokio::test]
async fn a_superseded_cycles_ambiguous_marker_cannot_keep_a_converged_series_unsynced() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-epoch-amb", "/h/.claude").await;
    let backend =
        ScriptedBackend::new(vec![WriteStep::AmbiguousLateApply { delay_ms: 10 }]).arm_read_gate();
    backend.set_title(Some("Divergent"));

    let store_for_cycle = Arc::clone(&store);
    let backend_for_cycle = backend.clone();
    let target_for_cycle = target.clone();
    let worker = tokio::spawn(async move {
        super::run_cycle(
            &store_for_cycle,
            backend_for_cycle.as_ref() as &dyn NativeNameBackend,
            &target_for_cycle,
        )
        .await;
    });

    // While the cycle parks on its pre-write read, a DOUBLE rename supersedes
    // its series twice.
    backend.gate_arrived.notified().await;
    rename_user(&store, target.clone(), "Second Decision")
        .await
        .unwrap();
    rename_user(&store, target.clone(), "Third Decision")
        .await
        .unwrap();
    backend.gate_open.notify_one();
    worker.await.unwrap();

    // The superseded cycle's ambiguous outcome must be provenance ONLY: the
    // successor series is untouched — pending, no inherited marker.
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(
        sync.status,
        NativeSyncStatus::Pending,
        "a superseded dispatch must not mark the successor series"
    );
    assert!(sync.reason.is_none(), "no inherited unsynced reason");

    // The successor series converges on its own matching readback: the
    // inherited marker must not keep a genuinely-converged series unsynced.
    tokio::time::sleep(Duration::from_millis(50)).await;
    backend.set_title(Some("Third Decision"));
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    let sync = native_sync_of(&store, target).await.expect("series");
    assert_eq!(
        sync.status,
        NativeSyncStatus::Synced,
        "an inherited ambiguous marker must not survive a genuine convergence"
    );
}

/// The same guard on the charge side: the superseded cycle's confirming read
/// must not consume the successor series' read allowance.
#[tokio::test]
async fn a_superseded_cycle_charges_no_read_against_the_successor_series() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-epoch-charge", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![WriteStep::Confirm]).arm_read_gate();
    backend.set_title(Some("Divergent"));

    let store_for_cycle = Arc::clone(&store);
    let backend_for_cycle = backend.clone();
    let target_for_cycle = target.clone();
    let worker = tokio::spawn(async move {
        super::run_cycle(
            &store_for_cycle,
            backend_for_cycle.as_ref() as &dyn NativeNameBackend,
            &target_for_cycle,
        )
        .await;
    });
    backend.gate_arrived.notified().await;
    rename_user(&store, target.clone(), "Second Decision")
        .await
        .unwrap();
    rename_user(&store, target.clone(), "Third Decision")
        .await
        .unwrap();
    backend.gate_open.notify_one();
    worker.await.unwrap();

    let doc = document_json(dir.path());
    let native = native_entry_of(&doc);
    assert_eq!(
        native["readsConsumed"].as_u64(),
        Some(0),
        "the superseded cycle's confirming read charges nothing against the successor series"
    );
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(
        sync.status,
        NativeSyncStatus::Pending,
        "the superseded cycle's late readback folds nothing onto the successor series"
    );

    // The successor proceeds on its own full allowance.
    let claim = store
        .claim_native_cycle(target.clone(), "successor-cycle-1".to_string())
        .await
        .unwrap()
        .expect("the successor series has its own allowance");
    assert_eq!(claim.title, "Third Decision");
    assert_eq!(claim.cycle, 1);
}

// ---------------------------------------------------------------------------
// T3-M7: an invalid observation title never fails the transaction and skips
// only the offer/rearm — an external >200-scalar rename must not abort the
// whole transaction. Delta-review round 3, finding 5 re-contracted the
// provenance write: a no-op observation (nothing user-visible moved) no
// longer pays a durable document rewrite for `last_observation.at` — the
// timestamp rides the next real change — so this no-op leaves no durable
// lastObservation behind.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_invalid_observation_title_retains_provenance_without_offering_or_rearming() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-invalid-obs", "/h/.claude").await;

    // An external rename longer than the accepted-name cap arrives.
    let oversize = "x".repeat(201);
    let folded = observe(&store, target.clone(), &oversize, 1).await;
    let folded = folded.expect("an invalid observation title is not a failed transaction");
    assert_eq!(
        folded.record.name, "Manual Title",
        "an invalid title never renames"
    );
    assert_eq!(
        folded.record.source,
        freshell_protocol::session_names::NameSource::Manual
    );
    // The observation was a no-op (invalid title: no offer, no rearm), so it
    // wrote nothing durable — no bookkeeping-only generation, and no
    // lastObservation staged by this event (the next real change persists
    // the then-current observation instead).
    let doc = document_json(dir.path());
    assert!(
        native_entry_of(&doc).get("lastObservation").is_none(),
        "a no-op observation stages no durable provenance"
    );

    // No rearm: the armed series stays untouched by the invalid event.
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(sync.status, NativeSyncStatus::Pending);
    assert!(sync.reason.is_none());
}

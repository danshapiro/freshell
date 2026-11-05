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
    SessionNameWorker, WORKER_POLL_INTERVAL,
};
use crate::session_names::SessionNames;

const LIFECYCLE_BUSY_CALLS_PER_PHASE: usize = 1;

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
            cwd: None,
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
            cwd: None,
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

fn freeze_native_clock(dir: &std::path::Path, now: i64) {
    crate::session_names::set_test_hooks(
        dir,
        vec![crate::session_names::TestHook::FrozenClockMs(now)],
    );
}

fn native_entry_for_target(doc: &Value, target: &SessionNameRef) -> Value {
    let key = crate::session_names::name_ref_key(target);
    doc["nativeWrite"]
        .get(&key)
        .expect("target has native state")
        .clone()
}

/// How long a real-clock test waits for a worker cycle to converge. A cycle
/// is several durable transactions, so it takes as long as the disk does;
/// this bound only turns a series that never converges into a failure
/// instead of a hang.
const REAL_CLOCK_CONVERGENCE_BOUND: Duration = Duration::from_secs(30);

/// The paused-clock bound for a capability-test series to converge once its
/// capability is present (from its arrival, or from worker start for a
/// series that never lacked it) — the five seconds these tests have always
/// allowed. Blocking
/// document IO does not advance the paused clock, so this measures only the
/// worker's own polls and re-probe window, whatever the disk speed.
const CAPABILITY_ARRIVAL_CONVERGENCE_BOUND: Duration = Duration::from_secs(5);

/// Wait (at most `within`, on tokio's clock) for the store to PUBLISH
/// `target`'s native projection at `status` — the worker's own fold event —
/// on a receiver subscribed BEFORE the work that produces it could run, then
/// confirm the durable read agrees.
async fn await_published_native_status(
    store: &Arc<SessionNames>,
    published: &mut tokio::sync::broadcast::Receiver<SessionNameUpdate>,
    target: &SessionNameRef,
    status: NativeSyncStatus,
    within: Duration,
    failure: &str,
) {
    tokio::time::timeout(within, async {
        loop {
            let update = published
                .recv()
                .await
                .expect("the store keeps publishing name updates");
            if &update.record.name_ref == target
                && update
                    .native_sync
                    .as_ref()
                    .is_some_and(|sync| sync.status == status)
            {
                return;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{failure}"));
    let sync = native_sync_of(store, target.clone())
        .await
        .expect("series projected");
    assert_eq!(
        sync.status, status,
        "the durable projection agrees with the published one"
    );
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
    /// The supervisor refused the request before host/native dispatch.
    LifecycleBusy,
    /// The provider acknowledged the write but the subsequent read still
    /// reports the old title, exercising confirmation-only retry behavior.
    ConfirmWithoutApplying,
    Unsupported,
}

enum ReadStep {
    /// Read the scripted provider's current title.
    Current,
    /// The read timed out or lost its response. Reads do not mutate the
    /// provider, so this must not poison an acknowledged write receipt.
    Ambiguous,
    /// The supervisor refused the request before host/native dispatch.
    LifecycleBusy,
}

/// A deterministic in-memory provider: reads answer the shared provider-side
/// title (so detached late-apply tasks are observable), writes follow the
/// scripted step list. Read/write counters pin the finite allowances.
struct ScriptedBackend {
    reads: AtomicU32,
    writes: AtomicU32,
    confirmed_writes: Arc<AtomicU32>,
    provider_title: Arc<Mutex<Option<String>>>,
    steps: Mutex<VecDeque<WriteStep>>,
    read_steps: Mutex<VecDeque<ReadStep>>,
    write_titles: Mutex<Vec<String>>,
    write_locations: Mutex<Vec<NativeLocation>>,
    read_locations: Mutex<Vec<NativeLocation>>,
    probe_locations: Mutex<Vec<NativeLocation>>,
    /// One-shot read gate: the FIRST read parks until the gate is notified
    /// (tests use this to mutate the store while a cycle is mid-flight —
    /// the worker holds the background guard, never the document lock).
    gate_armed: AtomicBool,
    gate_arrived: Arc<tokio::sync::Notify>,
    gate_open: Arc<tokio::sync::Notify>,
    probe_gate_armed: AtomicBool,
    probe_gate_arrived: Arc<tokio::sync::Notify>,
    probe_gate_open: Arc<tokio::sync::Notify>,
}

impl ScriptedBackend {
    fn new(steps: Vec<WriteStep>) -> Arc<Self> {
        Self::new_with_reads(steps, Vec::new())
    }

    fn new_with_reads(steps: Vec<WriteStep>, read_steps: Vec<ReadStep>) -> Arc<Self> {
        Arc::new(Self {
            reads: AtomicU32::new(0),
            writes: AtomicU32::new(0),
            confirmed_writes: Arc::new(AtomicU32::new(0)),
            provider_title: Arc::new(Mutex::new(None)),
            steps: Mutex::new(steps.into_iter().collect()),
            read_steps: Mutex::new(read_steps.into_iter().collect()),
            write_titles: Mutex::new(Vec::new()),
            write_locations: Mutex::new(Vec::new()),
            read_locations: Mutex::new(Vec::new()),
            probe_locations: Mutex::new(Vec::new()),
            gate_armed: AtomicBool::new(false),
            gate_arrived: Arc::new(tokio::sync::Notify::new()),
            gate_open: Arc::new(tokio::sync::Notify::new()),
            probe_gate_armed: AtomicBool::new(false),
            probe_gate_arrived: Arc::new(tokio::sync::Notify::new()),
            probe_gate_open: Arc::new(tokio::sync::Notify::new()),
        })
    }

    fn arm_read_gate(self: &Arc<Self>) -> Arc<Self> {
        self.gate_armed.store(true, Ordering::SeqCst);
        Arc::clone(self)
    }

    fn arm_probe_gate(self: &Arc<Self>) -> Arc<Self> {
        self.probe_gate_armed.store(true, Ordering::SeqCst);
        Arc::clone(self)
    }

    fn reads(&self) -> u32 {
        self.reads.load(Ordering::SeqCst)
    }

    fn writes(&self) -> u32 {
        self.writes.load(Ordering::SeqCst)
    }

    fn confirmed_writes(&self) -> u32 {
        self.confirmed_writes.load(Ordering::SeqCst)
    }

    fn write_titles(&self) -> Vec<String> {
        self.write_titles.lock().unwrap().clone()
    }

    fn write_locations(&self) -> Vec<NativeLocation> {
        self.write_locations.lock().unwrap().clone()
    }

    fn read_locations(&self) -> Vec<NativeLocation> {
        self.read_locations.lock().unwrap().clone()
    }

    fn probe_locations(&self) -> Vec<NativeLocation> {
        self.probe_locations.lock().unwrap().clone()
    }

    fn set_title(&self, title: Option<&str>) {
        *self.provider_title.lock().unwrap() = title.map(str::to_string);
    }
}

impl NativeNameBackend for ScriptedBackend {
    fn read(&self, target: NativeNameTarget) -> super::NativeFuture<NativeNameReadback> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.read_locations.lock().unwrap().push(target.location);
        let step = self.read_steps.lock().unwrap().pop_front();
        if self.gate_armed.swap(false, Ordering::SeqCst) {
            self.gate_arrived.notify_one();
            let open = Arc::clone(&self.gate_open);
            let provider_title = Arc::clone(&self.provider_title);
            return Box::pin(async move {
                open.notified().await;
                match step {
                    Some(ReadStep::LifecycleBusy) => NativeCallResult::LifecycleBusy,
                    Some(ReadStep::Ambiguous) => {
                        NativeCallResult::Ambiguous("scripted read timeout".to_string())
                    }
                    Some(ReadStep::Current) | None => {
                        let title = provider_title.lock().unwrap().clone();
                        NativeCallResult::Confirmed(NativeNameReadback { title })
                    }
                }
            });
        }
        let title = self.provider_title.lock().unwrap().clone();
        Box::pin(async move {
            match step {
                Some(ReadStep::LifecycleBusy) => NativeCallResult::LifecycleBusy,
                Some(ReadStep::Ambiguous) => {
                    NativeCallResult::Ambiguous("scripted read timeout".to_string())
                }
                Some(ReadStep::Current) | None => {
                    NativeCallResult::Confirmed(NativeNameReadback { title })
                }
            }
        })
    }

    fn route_available(&self, target: NativeNameTarget) -> super::NativeProbeFuture {
        self.probe_locations.lock().unwrap().push(target.location);
        if self.probe_gate_armed.swap(false, Ordering::SeqCst) {
            self.probe_gate_arrived.notify_one();
            let open = Arc::clone(&self.probe_gate_open);
            Box::pin(async move {
                open.notified().await;
                super::NativeProbeResult::Available
            })
        } else {
            Box::pin(async move { super::NativeProbeResult::Available })
        }
    }

    fn write(&self, attempt: super::NativeNameAttempt) -> super::NativeFuture<()> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.write_titles
            .lock()
            .unwrap()
            .push(attempt.title.clone());
        self.write_locations
            .lock()
            .unwrap()
            .push(attempt.target.location.clone());
        let step = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(WriteStep::Confirm);
        let confirmed_writes = Arc::clone(&self.confirmed_writes);
        let provider_title = Arc::clone(&self.provider_title);
        Box::pin(async move {
            match step {
                WriteStep::Confirm => {
                    confirmed_writes.fetch_add(1, Ordering::SeqCst);
                    *provider_title.lock().unwrap() = Some(attempt.title.clone());
                    NativeCallResult::Confirmed(())
                }
                WriteStep::ConfirmWithoutApplying => {
                    confirmed_writes.fetch_add(1, Ordering::SeqCst);
                    NativeCallResult::Confirmed(())
                }
                WriteStep::LifecycleBusy => NativeCallResult::LifecycleBusy,
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

fn lifecycle_busy_read_steps() -> Vec<ReadStep> {
    vec![ReadStep::LifecycleBusy]
}

fn lifecycle_busy_write_steps() -> Vec<WriteStep> {
    vec![WriteStep::LifecycleBusy]
}

struct OneSeriesBusyBackend {
    busy_target: SessionNameRef,
    busy_reads: AtomicU32,
    other_write_started: Arc<tokio::sync::Notify>,
    delegate: Arc<ScriptedBackend>,
}

impl OneSeriesBusyBackend {
    fn new(busy_target: SessionNameRef) -> Arc<Self> {
        let delegate = ScriptedBackend::new(vec![WriteStep::Confirm]);
        delegate.set_title(Some("Different"));
        Arc::new(Self {
            busy_target,
            busy_reads: AtomicU32::new(0),
            other_write_started: Arc::new(tokio::sync::Notify::new()),
            delegate,
        })
    }
}

impl NativeNameBackend for OneSeriesBusyBackend {
    fn read(&self, target: NativeNameTarget) -> super::NativeFuture<NativeNameReadback> {
        if target.name_ref == self.busy_target {
            self.busy_reads.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { NativeCallResult::LifecycleBusy })
        } else {
            self.delegate.read(target)
        }
    }

    fn write(&self, attempt: super::NativeNameAttempt) -> super::NativeFuture<()> {
        self.other_write_started.notify_one();
        self.delegate.write(attempt)
    }

    fn route_available(&self, _target: NativeNameTarget) -> super::NativeProbeFuture {
        Box::pin(async { super::NativeProbeResult::Available })
    }
}

fn append_lifecycle_busy_read_steps(steps: &mut Vec<ReadStep>) {
    steps.extend(lifecycle_busy_read_steps());
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
// `CLAUDE_CONFIG_DIR` for their whole run, so they own the environment
// through the crate-wide `TestEnv` — the one lock every same-binary env
// mutator and env-resolving reader holds (the final-suite gate's
// unreadable-projects deferral flake; see `crate::test_env_lock` for the
// full discipline).

/// Unified agent names (Task 8 acceptance): a session adopted ONLY through
/// the index (the auto-title sweep's hydration — the sidebar/history rename
/// flow) has NO runtime lane attaching a location. Without on-demand
/// discovery its armed native series pauses forever (the native smoke's
/// live-observed gap: `nativeSync: null` after a successful canonical
/// rename). The worker must resolve the transcript by session id and
/// attach the acquisition so the series runs to `synced`.
#[tokio::test]
async fn an_index_adopted_claude_series_discovers_its_route_on_demand() {
    let mut env = crate::test_env_lock::TestEnv::lock().await;
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

    env.set("CLAUDE_HOME", home.path());
    env.remove("CLAUDE_CONFIG_DIR");

    async {
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
    let mut env = crate::test_env_lock::TestEnv::lock().await;
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

    env.set("CLAUDE_HOME", home.path());
    env.remove("CLAUDE_CONFIG_DIR");

    async {
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
}

// ---------------------------------------------------------------------------
// The finite cycle machine
// ---------------------------------------------------------------------------

struct LifecycleContentionBackend {
    actual: Arc<ScriptedBackend>,
    busy: [AtomicU32; 3],
    attempts: Mutex<Vec<(usize, tokio::time::Instant)>>,
    receipts: Mutex<Vec<String>>,
    gate_phase: AtomicU32,
    gate_arrived: Arc<tokio::sync::Notify>,
    gate_open: Arc<tokio::sync::Notify>,
}

impl LifecycleContentionBackend {
    fn new(busy: [u32; 3]) -> Arc<Self> {
        Arc::new(Self {
            actual: ScriptedBackend::new(vec![WriteStep::Confirm]),
            busy: busy.map(AtomicU32::new),
            attempts: Mutex::new(Vec::new()),
            receipts: Mutex::new(Vec::new()),
            gate_phase: AtomicU32::new(u32::MAX),
            gate_arrived: Arc::new(tokio::sync::Notify::new()),
            gate_open: Arc::new(tokio::sync::Notify::new()),
        })
    }

    fn refuses(&self, phase: usize) -> bool {
        self.attempts
            .lock()
            .unwrap()
            .push((phase, tokio::time::Instant::now()));
        self.busy[phase]
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
    }

    fn busy_reply<T: 'static>(&self, phase: usize) -> super::NativeFuture<T> {
        if self
            .gate_phase
            .compare_exchange(phase as u32, u32::MAX, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.gate_arrived.notify_one();
            let open = self.gate_open.clone();
            Box::pin(async move {
                open.notified().await;
                NativeCallResult::LifecycleBusy
            })
        } else {
            Box::pin(async { NativeCallResult::LifecycleBusy })
        }
    }
}

impl NativeNameBackend for LifecycleContentionBackend {
    fn read(&self, target: NativeNameTarget) -> super::NativeFuture<NativeNameReadback> {
        let phase = if self.actual.writes() == 0 { 0 } else { 2 };
        if self.refuses(phase) {
            self.busy_reply(phase)
        } else {
            self.actual.read(target)
        }
    }

    fn write(&self, attempt: super::NativeNameAttempt) -> super::NativeFuture<()> {
        self.receipts
            .lock()
            .unwrap()
            .push(attempt.receipt_id.clone());
        if self.refuses(1) {
            self.busy_reply(1)
        } else {
            self.actual.write(attempt)
        }
    }

    fn route_available(&self, _: NativeNameTarget) -> super::NativeProbeFuture {
        Box::pin(async { super::NativeProbeResult::Available })
    }
}

#[tokio::test(start_paused = true)]
async fn lifecycle_contention_defers_after_one_undispatched_phase_call() {
    for phase in 0..3 {
        let dir = temp_data_dir();
        let now = 1_700_000_000_000_i64;
        freeze_native_clock(dir.path(), now);
        let store = open_store(dir.path());
        let target = armed_pending(&store, "h-contention", "/h/.claude").await;
        let mut busy = [0; 3];
        busy[phase] = LIFECYCLE_BUSY_CALLS_PER_PHASE as u32;
        let backend = LifecycleContentionBackend::new(busy);
        super::run_cycle(&store, backend.as_ref(), &target).await;

        let sync = native_sync_of(&store, target.clone()).await.unwrap();
        assert_eq!(sync.status, NativeSyncStatus::Pending, "phase {phase}");
        let document = document_json(dir.path());
        let state = native_entry_of(&document);
        assert_eq!(state["cyclesConsumed"], u32::from(phase == 2));
        assert_eq!(state["readsConsumed"], u32::from(phase != 0));
        assert_eq!(backend.actual.reads(), u32::from(phase != 0));
        assert_eq!(backend.actual.writes(), u32::from(phase == 2));
        assert_eq!(state["nextDue"], now + 1_000);
        let attempts = backend.attempts.lock().unwrap();
        let refused: Vec<_> = attempts.iter().filter(|(step, _)| *step == phase).collect();
        assert_eq!(refused.len(), LIFECYCLE_BUSY_CALLS_PER_PHASE);
        assert_eq!(
            attempts.len(),
            phase + 1,
            "only the calls needed to reach this phase are issued"
        );
        assert_eq!(
            backend.receipts.lock().unwrap().len(),
            usize::from(phase != 0),
            "the write call is reached only after the pre-read"
        );
        assert!(store.native_work_snapshot().is_empty());
    }
}

#[tokio::test]
async fn lifecycle_contention_mid_bind_keeps_the_cycle_and_receipt() {
    for (phase, observed_target) in
        (0..3).flat_map(|phase| [false, true].map(|observed| (phase, observed)))
    {
        let dir = temp_data_dir();
        let start_ms = 1_700_000_000_050_i64;
        freeze_native_clock(dir.path(), start_ms);
        let store = open_store(dir.path());
        let target = armed_pending(&store, "h-mid-bind", "/h/.claude").await;
        let durable = session(
            freshell_protocol::session_names::NamedProvider::Claude,
            "h-mid-bind",
        );
        if observed_target {
            store.ensure_session(durable.clone(), None).await.unwrap();
            observe(&store, durable.clone(), "First native baseline", 0)
                .await
                .unwrap();
            observe(&store, durable.clone(), "A newer native title", 0)
                .await
                .unwrap();
            let document = document_json(dir.path());
            let state = native_entry_for(&document, &durable);
            assert!(
                state["seriesEpoch"].is_null(),
                "the durable record has observations but no armed native series"
            );
        }
        let mut busy = [0; 3];
        busy[phase] = 1;
        let backend = LifecycleContentionBackend::new(busy);
        backend.gate_phase.store(phase as u32, Ordering::SeqCst);
        let running_store = store.clone();
        let running_backend = backend.clone();
        let running_target = target.clone();
        let running = tokio::spawn(async move {
            super::run_cycle(&running_store, running_backend.as_ref(), &running_target).await;
        });
        tokio::time::timeout(
            REAL_CLOCK_CONVERGENCE_BOUND,
            backend.gate_arrived.notified(),
        )
        .await
        .expect("the worker reaches the held naming phase");
        let claimed = document_json(dir.path());
        let receipt = native_entry_for(&claimed, &target)["receiptId"].clone();
        let original_revision = store.get(vec![target.clone()]).await.unwrap()[0]
            .record
            .revision;
        let bound = store
            .bind_pending(BindNameInput {
                pending: target,
                target: durable.clone(),
                acquisition: verified_acquisition(claude_location("/h/.claude", "h-mid-bind")),
            })
            .await
            .unwrap();
        assert!(
            bound.record.revision > original_revision,
            "binding rebases the record revision"
        );
        backend.gate_open.notify_one();
        tokio::time::timeout(REAL_CLOCK_CONVERGENCE_BOUND, running)
            .await
            .expect("the bound cycle settles")
            .unwrap();
        let deferred_document = document_json(dir.path());
        let deferred = native_entry_of(&deferred_document);
        let next_due = deferred["nextDue"].as_i64().unwrap_or(start_ms);
        freeze_native_clock(dir.path(), next_due);
        super::run_cycle(&store, backend.as_ref(), &durable).await;
        assert_eq!(
            native_sync_of(&store, durable).await.unwrap().status,
            NativeSyncStatus::Synced,
            "phase {phase}, observed target {observed_target}: the bound series resumes after the refusal"
        );
        assert_eq!(backend.actual.reads(), if phase == 1 { 3 } else { 2 });
        assert_eq!(backend.actual.writes(), 1);
        let document = document_json(dir.path());
        let state = native_entry_of(&document);
        assert_eq!(
            state["cyclesConsumed"],
            if phase == 2 { 2 } else { 1 },
            "phase {phase}, observed target {observed_target}: {state:?}"
        );
        assert_eq!(state["readsConsumed"], if phase == 1 { 3 } else { 2 });
        assert_eq!(state["attemptedReceipts"].as_array().unwrap().len(), 1);
        assert_eq!(
            state["lastConfirmedReceipt"], state["attemptedReceipts"][0],
            "the current confirmation belongs to the receipt that was actually written"
        );
        if phase == 2 {
            assert_eq!(
                state["lastConfirmedReceipt"], receipt,
                "a refused confirmation must preserve its acknowledged write receipt"
            );
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn lifecycle_retry_preserves_claude_timeout_cleanup_before_guard_release() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let pending = armed_pending(&store, "h-timeout-cleanup", "/h/.claude").await;
    let target = session(
        freshell_protocol::session_names::NamedProvider::Claude,
        "h-timeout-cleanup",
    );
    let mut location = claude_location("/h/.claude", "h-timeout-cleanup");
    if let NativeLocation::Claude { transcript_cwd, .. } = &mut location {
        *transcript_cwd = Some("/work/project".into());
    }
    store
        .bind_pending(BindNameInput {
            pending,
            target: target.clone(),
            acquisition: verified_acquisition(location),
        })
        .await
        .unwrap();
    // The shell becomes sleep, so the adapter owns exactly one child. Its
    // PID lets us assert reaping rather than merely dropping the future.
    let helper = dir.path().join("hang.sh");
    let pid_path = dir.path().join("helper.pid");
    std::fs::write(
        &helper,
        format!(
            "printf '%s' \"$$\" > '{}'\nexec sleep 300\n",
            pid_path.display()
        ),
    )
    .unwrap();
    let adapter = super::ClaudeNativeNameAdapter {
        node: "/bin/sh".into(),
        helper_path: helper,
    };
    let guard = store.try_background_guard().unwrap().unwrap();
    let running_store = store.clone();
    let running_target = target.clone();
    let running_pid_path = pid_path.clone();
    let running = tokio::spawn(async move {
        let _guard = guard;
        super::run_cycle(&running_store, &adapter, &running_target).await;
        assert!(running_store.try_background_guard().unwrap().is_none());
        let pid: i32 = std::fs::read_to_string(running_pid_path)
            .unwrap()
            .parse()
            .unwrap();
        // SAFETY: this is the exact dedicated child PID recorded by our
        // helper; WNOHANG cannot block or affect any other process.
        let waited = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
        assert_eq!(
            waited, -1,
            "helper is already reaped while the worker guard is still held"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !pid_path.exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the helper starts before its deadline");
    assert!(
        store.try_background_guard().unwrap().is_none(),
        "the helper still owns the worker guard"
    );
    tokio::time::pause();
    tokio::time::advance(super::NATIVE_REQUEST_TIMEOUT + Duration::from_secs(1)).await;
    running.await.unwrap();
    let sync = native_sync_of(&store, target).await.unwrap();
    assert!(
        sync.reason
            .as_deref()
            .unwrap()
            .contains("helper exceeded the request bound"),
        "adapter-specific timeout classification survives: {sync:?}"
    );
    assert!(store.try_background_guard().unwrap().is_some());
}

#[tokio::test(start_paused = true)]
async fn lifecycle_contention_exhaustion_preserves_backoff_and_eventual_sync() {
    for phase in 0..3 {
        let dir = temp_data_dir();
        let now = 1_700_000_000_000_i64;
        freeze_native_clock(dir.path(), now);
        let store = open_store(dir.path());
        let target = armed_pending(&store, "h-exhaustion", "/h/.claude").await;
        let mut busy = [0; 3];
        busy[phase] = LIFECYCLE_BUSY_CALLS_PER_PHASE as u32;
        let backend = LifecycleContentionBackend::new(busy);
        super::run_cycle(&store, backend.as_ref(), &target).await;
        let document = document_json(dir.path());
        let state = native_entry_of(&document);
        assert_eq!(
            state["cyclesConsumed"],
            u32::from(phase == 2),
            "pre-dispatch busy results refund the cycle; an acknowledged write keeps it"
        );
        assert_eq!(state["readsConsumed"], u32::from(phase != 0));
        assert_eq!(backend.actual.reads(), u32::from(phase != 0));
        assert_eq!(backend.actual.writes(), u32::from(phase == 2));
        assert_eq!(state["nextDue"], now + 1_000);
        assert_eq!(
            state["attemptedReceipts"]
                .as_array()
                .map(Vec::len)
                .unwrap_or(0),
            usize::from(phase == 2),
            "a refused read or write never mints an attempted receipt"
        );
        assert_eq!(
            state["confirmationPendingReceipt"].is_string(),
            phase == 2,
            "a lifecycle refusal during confirmation preserves the acknowledged receipt"
        );
        assert!(state["receiptId"].is_null());
        assert!(
            state["lastConfirmedReceipt"].is_null(),
            "ACK alone never means synced"
        );
        assert_eq!(
            native_sync_of(&store, target.clone()).await.unwrap().status,
            NativeSyncStatus::Pending,
            "phase {phase} must remain pending until a readback confirms the native state"
        );
        assert!(store.native_work_snapshot().is_empty());
        {
            let attempts = backend.attempts.lock().unwrap();
            let refused: Vec<_> = attempts.iter().filter(|(step, _)| *step == phase).collect();
            assert_eq!(refused.len(), LIFECYCLE_BUSY_CALLS_PER_PHASE);
        }
        drop(store);
        let store = open_store(dir.path());
        // Matching or genuinely changed observations cannot replenish the
        // counters or bypass the existing retry floor across a restart.
        for title in ["Manual Title", "A different native title"] {
            observe(&store, target.clone(), title, 1).await.unwrap();
            assert!(store.native_work_snapshot().is_empty());
            assert_eq!(
                native_entry_of(&document_json(dir.path()))["cyclesConsumed"],
                u32::from(phase == 2)
            );
        }
        freeze_native_clock(dir.path(), now + 1_000);
        assert_eq!(store.native_work_snapshot().len(), 1);
        super::run_cycle(&store, backend.as_ref(), &target).await;
        assert_eq!(
            native_sync_of(&store, target.clone()).await.unwrap().status,
            NativeSyncStatus::Synced
        );
        assert_eq!(
            backend.actual.writes(),
            1,
            "an acknowledged write is reconciled by readback"
        );
        assert_eq!(
            native_entry_of(&document_json(dir.path()))["cyclesConsumed"],
            1 + u32::from(phase == 2)
        );
        observe(&store, target.clone(), "Manual Title", 1)
            .await
            .unwrap();
        assert!(
            store.native_work_snapshot().is_empty(),
            "a matching echo needs no repair"
        );
        backend
            .actual
            .set_title(Some("A new external native title"));
        observe(&store, target.clone(), "A new external native title", 1)
            .await
            .unwrap();
        assert_eq!(
            store.native_work_snapshot().len(),
            1,
            "a differing observation rearms the remaining budget"
        );
        super::run_cycle(&store, backend.as_ref(), &target).await;
        assert_eq!(
            native_sync_of(&store, target).await.unwrap().status,
            NativeSyncStatus::Synced
        );
        crate::session_names::clear_test_hooks(dir.path());
    }
}

#[tokio::test(start_paused = true)]
async fn lifecycle_contention_exhaustion_stays_bounded_across_restarts_and_binding() {
    let dir = temp_data_dir();
    let mut now = 1_700_000_000_000_i64;
    freeze_native_clock(dir.path(), now);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-bounded", "/h/.claude").await;
    let backend = LifecycleContentionBackend::new([u32::MAX, 0, 0]);
    for (deferral, delay) in [(1, 0), (2, 1_000), (3, 2_000)] {
        now += delay;
        freeze_native_clock(dir.path(), now);
        super::run_cycle(&store, backend.as_ref(), &target).await;
        let document = document_json(dir.path());
        let state = native_entry_of(&document);
        assert_eq!(state["cyclesConsumed"], 0);
        assert_eq!(state["readsConsumed"], 0);
        assert_eq!(state["lifecycleBusyDeferrals"], deferral);
        assert!(state["attemptedReceipts"]
            .as_array()
            .is_none_or(Vec::is_empty));
    }
    assert_eq!(
        backend.attempts.lock().unwrap().len(),
        3 * LIFECYCLE_BUSY_CALLS_PER_PHASE
    );
    assert_eq!(backend.actual.reads(), 0);
    assert_eq!(backend.actual.writes(), 0);
    drop(store);
    let store = open_store(dir.path());
    let durable = session(
        freshell_protocol::session_names::NamedProvider::Claude,
        "h-bounded",
    );
    store
        .bind_pending(BindNameInput {
            pending: target,
            target: durable.clone(),
            acquisition: verified_acquisition(claude_location("/h/.claude", "h-bounded")),
        })
        .await
        .unwrap();
    for title in ["Manual Title", "A changed external title"] {
        observe(&store, durable.clone(), title, 1).await.unwrap();
        assert!(
            store.native_work_snapshot().is_empty(),
            "observations and binds preserve the active lifecycle cooldown"
        );
    }
    rename_user(&store, durable.clone(), "A new name decision")
        .await
        .unwrap();
    super::run_cycle(&store, backend.actual.as_ref(), &durable).await;
    assert_eq!(
        native_sync_of(&store, durable).await.unwrap().status,
        NativeSyncStatus::Synced
    );
    crate::session_names::clear_test_hooks(dir.path());
}

#[tokio::test(start_paused = true)]
async fn lifecycle_contention_second_deferral_recovers_after_persisted_backoff() {
    let dir = temp_data_dir();
    let mut now = 1_700_000_000_000_i64;
    freeze_native_clock(dir.path(), now);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-third-cycle", "/h/.claude").await;
    let backend =
        LifecycleContentionBackend::new([2 * LIFECYCLE_BUSY_CALLS_PER_PHASE as u32, 0, 0]);
    for delay in [0, 1_000] {
        now += delay;
        freeze_native_clock(dir.path(), now);
        super::run_cycle(&store, backend.as_ref(), &target).await;
    }
    let due = now + 2_000;
    assert_eq!(native_entry_of(&document_json(dir.path()))["nextDue"], due);
    freeze_native_clock(dir.path(), due - 1);
    assert!(store.native_work_snapshot().is_empty());
    freeze_native_clock(dir.path(), due);
    assert_eq!(store.native_work_snapshot().len(), 1);
    super::run_cycle(&store, backend.as_ref(), &target).await;
    assert_eq!(
        native_sync_of(&store, target).await.unwrap().status,
        NativeSyncStatus::Synced
    );
    assert_eq!(backend.actual.reads(), 2);
    assert_eq!(backend.actual.writes(), 1);
    assert_eq!(
        native_entry_of(&document_json(dir.path()))["cyclesConsumed"],
        1
    );
    crate::session_names::clear_test_hooks(dir.path());
}

#[tokio::test(start_paused = true)]
async fn lifecycle_contention_changed_binding_source_preserves_budget_and_backoff() {
    let dir = temp_data_dir();
    let now = 1_700_000_000_000_i64;
    freeze_native_clock(dir.path(), now);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-changed-bind", "/h/.claude").await;
    let backend = LifecycleContentionBackend::new([LIFECYCLE_BUSY_CALLS_PER_PHASE as u32, 0, 0]);
    super::run_cycle(&store, backend.as_ref(), &target).await;
    let durable = session(
        freshell_protocol::session_names::NamedProvider::Claude,
        "h-changed-bind",
    );
    store
        .bind_pending(BindNameInput {
            pending: target,
            target: durable.clone(),
            acquisition: verified_acquisition(claude_location("/moved/.claude", "h-changed-bind")),
        })
        .await
        .unwrap();
    let current_source = store.location_revision_of(&durable);
    assert!(current_source > 1);
    observe(
        &store,
        durable.clone(),
        "Previous native title",
        current_source,
    )
    .await
    .unwrap();
    assert!(
        store.native_work_snapshot().is_empty(),
        "a changed binding still honors the failure backoff"
    );
    assert_eq!(
        native_entry_of(&document_json(dir.path()))["cyclesConsumed"],
        0
    );
    freeze_native_clock(dir.path(), now + 1_000);
    super::run_cycle(&store, backend.as_ref(), &durable).await;
    assert_eq!(
        native_sync_of(&store, durable).await.unwrap().status,
        NativeSyncStatus::Synced
    );
    assert_eq!(
        native_entry_of(&document_json(dir.path()))["cyclesConsumed"],
        1
    );
    crate::session_names::clear_test_hooks(dir.path());
}

#[tokio::test]
async fn lifecycle_contention_stale_name_or_route_cannot_retry_or_mutate_successor() {
    let events = crate::test_trace_capture::captured_trace_events();
    for (phase, change) in [
        (0, "name"),
        (1, "name"),
        (2, "name"),
        (0, "route"),
        (0, "prospective"),
    ] {
        let dir = temp_data_dir();
        let store = open_store(dir.path());
        let target = if change == "prospective" {
            let target = pending("h-stale");
            ensure_pending(&store, "h-stale", None).await.unwrap();
            rename_user(&store, target.clone(), "Manual Title")
                .await
                .unwrap();
            record_acquisition(
                &store,
                target.clone(),
                NativeAcquisition {
                    location: claude_location("/h/.claude", "h-stale"),
                    evidence: NativeEvidenceKind::InitializedRuntime,
                    persistence: NativePersistence::Prospective,
                },
            )
            .await
            .unwrap();
            target
        } else {
            armed_pending(&store, "h-stale", "/h/.claude").await
        };
        let mut busy = [0; 3];
        busy[phase] = 3;
        let backend = LifecycleContentionBackend::new(busy);
        backend.gate_phase.store(phase as u32, Ordering::SeqCst);
        let running_store = store.clone();
        let running_backend = backend.clone();
        let running_target = target.clone();
        let running = tokio::spawn(async move {
            super::run_cycle(&running_store, running_backend.as_ref(), &running_target).await;
        });
        backend.gate_arrived.notified().await;
        let claimed = document_json(dir.path());
        let receipt = native_entry_of(&claimed)["receiptId"].as_str().unwrap();
        let other = open_store(dir.path());
        if change == "name" {
            rename_user(&other, target.clone(), "New manual title")
                .await
                .unwrap();
        } else if change == "prospective" {
            record_acquisition(
                &other,
                target.clone(),
                NativeAcquisition {
                    location: claude_location("/moved/.claude", "h-stale"),
                    evidence: NativeEvidenceKind::InitializedRuntime,
                    persistence: NativePersistence::Prospective,
                },
            )
            .await
            .unwrap();
        } else {
            record_acquisition(
                &other,
                target.clone(),
                verified_acquisition(claude_location("/moved/.claude", "h-stale")),
            )
            .await
            .unwrap();
        }
        let current = document_json(dir.path());
        backend.gate_open.notify_one();
        running.await.unwrap();
        assert_eq!(
            native_entry_of(&document_json(dir.path())),
            native_entry_of(&current),
            "late refusal cannot change successor counters/receipts"
        );
        assert_eq!(
            backend
                .attempts
                .lock()
                .unwrap()
                .iter()
                .filter(|(step, _)| *step == phase)
                .count(),
            1,
            "no retry after a fresh transaction observes changed name/source"
        );
        assert_eq!(
            backend.actual.writes(),
            u32::from(phase == 2),
            "only a write acknowledged before the concurrent rename may have run"
        );
        assert!(
            events
                .snapshot()
                .iter()
                .any(|event| event.fields.get("event").map(String::as_str)
                    == Some("session_names.native_claim_superseded")
                    && event.fields.get("receipt_id").map(String::as_str) == Some(receipt)),
            "a genuinely superseded claim leaves a structured diagnostic"
        );
    }
}

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

/// A supervisor refusal before dispatch releases the cycle/read reservation
/// and becomes due after a short persisted backoff. A later fresh claim uses
/// the same current title and route and performs one successful write.
#[tokio::test]
async fn lifecycle_busy_pre_read_defers_without_spending_native_budgets() {
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_000_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-lifecycle-read", "/h/.claude").await;
    let backend =
        ScriptedBackend::new_with_reads(vec![WriteStep::Confirm], lifecycle_busy_read_steps());
    backend.set_title(Some("Different"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    let doc = document_json(dir.path());
    let state = native_entry_for_target(&doc, &target);
    assert_eq!(state["cyclesConsumed"].as_u64(), Some(0));
    assert_eq!(state["readsConsumed"].as_u64(), Some(0));
    assert_eq!(state["lifecycleBusyDeferrals"].as_u64(), Some(1));
    assert!(state.get("attemptedReceipts").is_none());
    let due = state["nextDue"].as_i64().expect("busy retry is scheduled");
    assert!(due > start_ms);
    assert!(
        store.native_work_snapshot().is_empty(),
        "the worker does not spin before the persisted busy backoff expires"
    );
    assert_eq!(
        backend.writes(),
        0,
        "a refused pre-read never dispatches a write"
    );

    set_offset(due - start_ms);
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    assert_eq!(
        backend.reads(),
        LIFECYCLE_BUSY_CALLS_PER_PHASE as u32 + 2,
        "bounded busy retries, fresh pre-read, confirmation"
    );
    assert_eq!(backend.writes(), 1);
    assert_eq!(backend.confirmed_writes(), 1);
    assert_eq!(backend.write_titles(), vec!["Manual Title"]);
    assert_eq!(
        native_sync_of(&store, target).await.unwrap().status,
        NativeSyncStatus::Synced
    );
    let state = native_entry_for_target(&document_json(dir.path()), &pending("h-lifecycle-read"));
    assert_eq!(state["cyclesConsumed"].as_u64(), Some(1));
    assert_eq!(state["readsConsumed"].as_u64(), Some(2));
    crate::session_names::clear_test_hooks(dir.path());
}

/// A busy write does not spend a cycle, while its successful pre-write read
/// remains charged. The next pass re-reads the current target and writes once.
#[tokio::test]
async fn lifecycle_busy_write_refunds_cycle_but_keeps_the_real_pre_read() {
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_100_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-lifecycle-write", "/h/.claude").await;
    let mut write_steps = lifecycle_busy_write_steps();
    write_steps.push(WriteStep::Confirm);
    let backend = ScriptedBackend::new(write_steps);
    backend.set_title(Some("Different"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    let state = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(state["cyclesConsumed"].as_u64(), Some(0));
    assert_eq!(state["readsConsumed"].as_u64(), Some(1));
    assert!(state.get("attemptedReceipts").is_none());
    let due = state["nextDue"].as_i64().expect("busy retry is scheduled");
    assert_eq!(backend.reads(), 1);
    assert_eq!(
        backend.writes(),
        LIFECYCLE_BUSY_CALLS_PER_PHASE as u32,
        "each write request is refused before provider dispatch"
    );
    assert_eq!(backend.confirmed_writes(), 0);

    set_offset(due - start_ms);
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    assert_eq!(backend.reads(), 3, "both pre-reads and one confirmation");
    assert_eq!(
        backend.writes(),
        LIFECYCLE_BUSY_CALLS_PER_PHASE as u32 + 1,
        "bounded refusals and one fresh write"
    );
    assert_eq!(backend.confirmed_writes(), 1, "only one write is applied");
    assert_eq!(
        backend.write_titles(),
        vec!["Manual Title".to_string(); LIFECYCLE_BUSY_CALLS_PER_PHASE + 1]
    );
    let state = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(state["cyclesConsumed"].as_u64(), Some(1));
    assert_eq!(state["readsConsumed"].as_u64(), Some(3));
    assert_eq!(state["attemptedReceipts"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        native_sync_of(&store, target).await.unwrap().status,
        NativeSyncStatus::Synced
    );
    crate::session_names::clear_test_hooks(dir.path());
}

/// Once a write was acknowledged, a busy confirming read can only be retried
/// as a read. It must never issue another write while the receipt is awaiting
/// current-location confirmation.
#[tokio::test]
async fn lifecycle_busy_after_write_ack_retries_confirmation_without_rewriting() {
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_200_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-lifecycle-confirm", "/h/.claude").await;
    let mut read_steps = vec![ReadStep::Current];
    append_lifecycle_busy_read_steps(&mut read_steps);
    let backend =
        ScriptedBackend::new_with_reads(vec![WriteStep::ConfirmWithoutApplying], read_steps);
    backend.set_title(Some("Different"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    let state = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(state["cyclesConsumed"].as_u64(), Some(1));
    assert_eq!(state["readsConsumed"].as_u64(), Some(1));
    assert!(state["confirmationPendingReceipt"].is_string());
    let due = state["nextDue"].as_i64().expect("busy retry is scheduled");
    assert_eq!(backend.confirmed_writes(), 1);

    set_offset(due - start_ms);
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    assert_eq!(
        backend.reads(),
        LIFECYCLE_BUSY_CALLS_PER_PHASE as u32 + 2,
        "pre-read, bounded refused confirmations, fresh confirmation"
    );
    assert_eq!(
        backend.writes(),
        1,
        "the acknowledged write is never repeated even when readback still differs"
    );
    assert_eq!(backend.confirmed_writes(), 1);
    let state = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(state["cyclesConsumed"].as_u64(), Some(2));
    assert_eq!(state["readsConsumed"].as_u64(), Some(2));
    assert!(state["confirmationPendingReceipt"].is_string());
    assert_eq!(
        native_sync_of(&store, target).await.unwrap().status,
        NativeSyncStatus::Unsynced,
        "a stale divergent read keeps the confirmed receipt read-only and pending"
    );
    crate::session_names::clear_test_hooks(dir.path());
}

/// A timeout or disconnect while reading after an acknowledged write cannot
/// mean the write itself is ambiguous. A later matching read must still
/// confirm the receipt and settle the native series.
#[tokio::test]
async fn ambiguous_confirmation_read_keeps_acknowledged_receipt_confirmable() {
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_212_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-ambiguous-confirm-read", "/h/.claude").await;
    let backend = ScriptedBackend::new_with_reads(
        vec![WriteStep::Confirm],
        vec![ReadStep::Current, ReadStep::Ambiguous, ReadStep::Current],
    );
    backend.set_title(Some("Different"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    let after_ack = native_entry_for_target(&document_json(dir.path()), &target);
    let receipt = after_ack["confirmationPendingReceipt"]
        .as_str()
        .expect("the acknowledged write waits for a confirmation read")
        .to_string();
    let due = after_ack["nextDue"]
        .as_i64()
        .expect("the failed read schedules a retry");
    assert_eq!(backend.writes(), 1);

    set_offset(due - start_ms);
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    assert_eq!(backend.reads(), 3);
    assert_eq!(
        backend.writes(),
        1,
        "a read-only retry never repeats the write"
    );
    let after_confirmation = native_entry_for_target(&document_json(dir.path()), &target);
    assert!(after_confirmation["confirmationPendingReceipt"].is_null());
    assert_eq!(
        after_confirmation["lastConfirmedReceipt"].as_str(),
        Some(receipt.as_str())
    );
    assert_eq!(
        native_sync_of(&store, target).await.unwrap().status,
        NativeSyncStatus::Synced
    );
    crate::session_names::clear_test_hooks(dir.path());
}

/// The acknowledged write receipt and read-only confirmation state survive a
/// durable store reopen. The new worker process must read again without
/// repeating the already-acknowledged write.
#[tokio::test]
async fn acknowledged_write_busy_confirmation_survives_reopen_without_rewrite() {
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_225_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-lifecycle-reopen", "/h/.claude").await;
    let mut read_steps = vec![ReadStep::Current];
    append_lifecycle_busy_read_steps(&mut read_steps);
    let backend =
        ScriptedBackend::new_with_reads(vec![WriteStep::ConfirmWithoutApplying], read_steps);
    backend.set_title(Some("Different"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    let first_state = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(first_state["cyclesConsumed"].as_u64(), Some(1));
    assert_eq!(first_state["readsConsumed"].as_u64(), Some(1));
    assert!(first_state["confirmationPendingReceipt"].is_string());
    let due = first_state["nextDue"]
        .as_i64()
        .expect("busy retry is scheduled");
    assert_eq!(backend.confirmed_writes(), 1);
    drop(store);

    set_offset(due - start_ms);
    let reopened = open_store(dir.path());
    let after_restart_backend = ScriptedBackend::new(vec![WriteStep::Confirm]);
    after_restart_backend.set_title(Some("Different"));

    super::run_cycle(
        &reopened,
        after_restart_backend.as_ref() as &dyn NativeNameBackend,
        &target,
    )
    .await;

    assert_eq!(after_restart_backend.reads(), 1);
    assert_eq!(after_restart_backend.writes(), 0);
    assert_eq!(after_restart_backend.confirmed_writes(), 0);
    let reopened_state = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(reopened_state["cyclesConsumed"].as_u64(), Some(2));
    assert_eq!(reopened_state["readsConsumed"].as_u64(), Some(2));
    assert!(reopened_state["confirmationPendingReceipt"].is_string());
    assert_eq!(
        native_sync_of(&reopened, target).await.unwrap().status,
        NativeSyncStatus::Unsynced
    );
    crate::session_names::clear_test_hooks(dir.path());
}

/// The cycle cap also admits one bounded read-only confirmation retry after
/// a third-cycle acknowledgement. A busy final confirmation cannot strand a
/// pending receipt, and the subsequent read cannot issue a fourth write.
#[tokio::test]
async fn final_cycle_busy_confirmation_gets_read_only_retry_without_extra_write() {
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_250_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-lifecycle-final-confirm", "/h/.claude").await;
    let mut read_steps = vec![ReadStep::Current, ReadStep::Current, ReadStep::Current];
    append_lifecycle_busy_read_steps(&mut read_steps);
    let backend = ScriptedBackend::new_with_reads(
        vec![
            WriteStep::Undelivered,
            WriteStep::Undelivered,
            WriteStep::ConfirmWithoutApplying,
        ],
        read_steps,
    );
    backend.set_title(Some("Different"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    let first_due = native_entry_for_target(&document_json(dir.path()), &target)["nextDue"]
        .as_i64()
        .unwrap();
    set_offset(first_due - start_ms);
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    let second_due = native_entry_for_target(&document_json(dir.path()), &target)["nextDue"]
        .as_i64()
        .unwrap();
    set_offset(second_due - start_ms);
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    let state = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(state["cyclesConsumed"].as_u64(), Some(3));
    assert_eq!(state["readsConsumed"].as_u64(), Some(3));
    assert!(state["confirmationPendingReceipt"].is_string());
    let confirmation_due = state["nextDue"].as_i64().unwrap();
    assert!(store.native_work_snapshot().is_empty());

    set_offset(confirmation_due - start_ms);
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    assert_eq!(backend.writes(), 3);
    assert_eq!(backend.confirmed_writes(), 1);
    assert_eq!(backend.reads(), LIFECYCLE_BUSY_CALLS_PER_PHASE as u32 + 4);
    let state = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(state["cyclesConsumed"].as_u64(), Some(3));
    assert_eq!(state["readsConsumed"].as_u64(), Some(4));
    assert!(state.get("confirmationPendingReceipt").is_none());
    assert!(state["settled"].as_bool().unwrap());
    assert_eq!(
        native_sync_of(&store, target).await.unwrap().status,
        NativeSyncStatus::Unsynced
    );
    crate::session_names::clear_test_hooks(dir.path());
}

/// Repeated pre-dispatch refusals are delayed and bounded independently from
/// provider writes. Exhausting the fast window schedules a durable cooldown
/// instead of permanently settling the series.
#[tokio::test]
async fn persistent_lifecycle_busy_deferrals_schedule_a_durable_cooldown() {
    const MAX_BUSY_DEFERRALS: u64 = 6;
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_300_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-lifecycle-always-busy", "/h/.claude").await;
    let read_steps = (0..MAX_BUSY_DEFERRALS)
        .flat_map(|_| lifecycle_busy_read_steps())
        .collect();
    let backend = ScriptedBackend::new_with_reads(vec![], read_steps);

    let expected_backoff_ms = [1_000_i64, 2_000, 4_000, 8_000, 8_000];
    let mut current_offset = 0_i64;
    for attempt in 0..MAX_BUSY_DEFERRALS {
        super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
        if attempt + 1 < MAX_BUSY_DEFERRALS {
            let state = native_entry_for_target(&document_json(dir.path()), &target);
            let due = state["nextDue"].as_i64().expect("busy retry is scheduled");
            let retry_in_ms = due - (start_ms + current_offset);
            assert_eq!(
                retry_in_ms, expected_backoff_ms[attempt as usize],
                "lifecycle retries use bounded exponential backoff"
            );
            current_offset = due - start_ms;
            set_offset(current_offset);
        }
    }

    assert_eq!(
        backend.reads(),
        MAX_BUSY_DEFERRALS as u32 * LIFECYCLE_BUSY_CALLS_PER_PHASE as u32
    );
    assert_eq!(backend.writes(), 0);
    assert_eq!(backend.confirmed_writes(), 0);
    let state = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(
        state["lifecycleBusyDeferrals"].as_u64(),
        Some(MAX_BUSY_DEFERRALS)
    );
    assert_eq!(state["cyclesConsumed"].as_u64(), Some(0));
    assert_eq!(state["readsConsumed"].as_u64(), Some(0));
    assert!(state.get("attemptedReceipts").is_none());
    assert!(!state["settled"].as_bool().unwrap());
    let due = state["nextDue"].as_i64().expect("cooldown is durable");
    assert_eq!(
        due - (start_ms + current_offset),
        crate::session_names::NATIVE_LIFECYCLE_BUSY_COOLDOWN_MS
    );
    let sync = native_sync_of(&store, target.clone()).await.unwrap();
    assert_eq!(sync.status, NativeSyncStatus::Unsynced);
    assert!(sync.reason.unwrap().contains("lifecycle lock contention"));
    assert!(store.native_work_snapshot().is_empty());
    crate::session_names::clear_test_hooks(dir.path());
}

/// A lifecycle refusal racing with a newer canonical rename cannot release
/// or delay the successor's fresh series, and the next operation dispatches
/// only the new desired title.
#[tokio::test]
async fn stale_busy_result_after_rename_cannot_defer_or_dispatch_the_old_title() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-lifecycle-rename", "/h/.claude").await;
    let backend =
        ScriptedBackend::new_with_reads(vec![WriteStep::Confirm], vec![ReadStep::LifecycleBusy])
            .arm_read_gate();
    backend.set_title(Some("Different"));

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

    backend.gate_arrived.notified().await;
    rename_user(&store, target.clone(), "Newer Title")
        .await
        .expect("the new canonical title commits while native read is pending");
    backend.gate_open.notify_one();
    worker.await.unwrap();

    let state = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(state["cyclesConsumed"].as_u64(), Some(0));
    assert_eq!(state["readsConsumed"].as_u64(), Some(0));
    assert_eq!(state["lifecycleBusyDeferrals"].as_u64(), Some(0));
    assert!(state.get("nextDue").is_none());

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    assert_eq!(backend.write_titles(), vec!["Newer Title"]);
    assert_eq!(backend.confirmed_writes(), 1);
    assert_eq!(
        native_sync_of(&store, target).await.unwrap().status,
        NativeSyncStatus::Synced
    );
}

/// A busy result captured at an old route cannot schedule stale-route work.
/// The next claim resolves the current route and any dispatched write targets
/// only that new location revision.
#[tokio::test]
async fn stale_busy_result_after_relocation_cannot_defer_the_old_route() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-lifecycle-route", "/h/.claude").await;
    let moved = claude_location("/h/.claude-moved", "h-lifecycle-route");
    let backend =
        ScriptedBackend::new_with_reads(vec![WriteStep::Confirm], vec![ReadStep::LifecycleBusy])
            .arm_read_gate();

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

    backend.gate_arrived.notified().await;
    record_acquisition(&store, target.clone(), verified_acquisition(moved.clone()))
        .await
        .expect("the new verified route commits while the old read is pending");
    backend.gate_open.notify_one();
    worker.await.unwrap();

    let state = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(state["lifecycleBusyDeferrals"].as_u64(), Some(0));
    assert_eq!(state["cyclesConsumed"].as_u64(), Some(1));
    assert_eq!(state["readsConsumed"].as_u64(), Some(1));
    assert!(state.get("nextDue").is_none());

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    assert_eq!(backend.write_locations(), vec![moved]);
    assert_eq!(backend.confirmed_writes(), 1);
    let sync = native_sync_of(&store, target).await.unwrap();
    assert_eq!(sync.status, NativeSyncStatus::Synced);
    assert_eq!(sync.location_revision, 2);
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
    // Freeze the decision clock, including timestamps captured before
    // fsync, so host pressure cannot make a retry eligible unexpectedly.
    let set_now = |now| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![crate::session_names::TestHook::FrozenClockMs(now)],
        );
    };
    let mut now = 1_700_000_000_000_i64;
    set_now(now);
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

    // Exercise the real 5s/30s floors at their exact boundaries. Neither a
    // snapshot nor a claim may admit a retry one millisecond early.
    for (cycle, delay_ms) in [(2_u32, 5_000_i64), (3, 30_000)] {
        let due = now + delay_ms;
        assert_eq!(
            native_entry_of(&document_json(dir.path()))["nextDue"].as_i64(),
            Some(due),
            "cycle {cycle} uses the production retry floor"
        );
        set_now(due - 1);
        assert!(
            store.native_work_snapshot().is_empty(),
            "cycle {cycle} is not ready before its retry floor"
        );
        assert!(
            store
                .claim_native_cycle(target.clone(), format!("too-early-{cycle}"))
                .await
                .unwrap()
                .is_none(),
            "a not-yet-due claim consumes nothing"
        );

        set_now(due);
        assert!(
            store
                .native_work_snapshot()
                .iter()
                .any(|item| item.target == target),
            "cycle {cycle} is ready at its retry floor"
        );
        super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
        assert_eq!(backend.writes(), cycle);
        assert_eq!(backend.reads(), cycle);
        now = due;
    }
    assert_eq!(backend.writes(), 3, "at most three writes per revision");
    assert_eq!(backend.reads(), 3);

    // Cycle 4: exhaustion is final even after advancing another day.
    set_now(now + 24 * 60 * 60 * 1_000);
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
    let start_ms = 1_700_000_000_475_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
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
    // Claim the next due cycle and fold its matching pre-read (as the worker
    // does). The strict fold API requires the exact claim identity.
    let retry_due = native_entry_for_target(&document_json(dir.path()), &target)["nextDue"]
        .as_i64()
        .expect("ambiguous outcome schedules a retry");
    set_offset(retry_due - start_ms);
    let claim = store
        .claim_native_cycle(target.clone(), "ambiguous-late-read".to_string())
        .await
        .unwrap()
        .expect("the next cycle is due");
    assert_eq!(claim.cycle, 2);
    assert!(store.charge_native_read(claim.clone()).await.unwrap());
    store
        .fold_native_outcome(
            claim,
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
    crate::session_names::clear_test_hooks(dir.path());
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
        store.charge_native_read(claim.clone()).await.unwrap(),
        "the read allowance charges"
    );
    store
        .fold_native_outcome(
            claim.clone(),
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

/// A pending write acknowledgement belongs to its exact native route. When
/// binding discovers a different route for the durable session, the worker
/// must write that route once, while retaining the old receipt as provenance.
#[tokio::test]
async fn binding_to_a_different_durable_route_writes_once_instead_of_confirming_old_receipt() {
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_425_i64;
    crate::session_names::set_test_hooks(
        dir.path(),
        vec![
            crate::session_names::TestHook::FrozenClockMs(start_ms),
            crate::session_names::TestHook::ClockOffsetMs(0),
        ],
    );
    let store = open_store(dir.path());
    let pending = armed_pending(&store, "h-bind-route", "/h/pending-route").await;
    let mut old_read_steps = vec![ReadStep::Current];
    append_lifecycle_busy_read_steps(&mut old_read_steps);
    let old_backend =
        ScriptedBackend::new_with_reads(vec![WriteStep::ConfirmWithoutApplying], old_read_steps);
    old_backend.set_title(Some("Different"));

    super::run_cycle(
        &store,
        old_backend.as_ref() as &dyn NativeNameBackend,
        &pending,
    )
    .await;

    let before_bind = native_entry_for_target(&document_json(dir.path()), &pending);
    let old_receipt = before_bind["confirmationPendingReceipt"]
        .as_str()
        .expect("the old route has an acknowledged write awaiting confirmation")
        .to_string();
    let retry_due = before_bind["nextDue"]
        .as_i64()
        .expect("busy retry scheduled");
    let durable = session(
        freshell_protocol::session_names::NamedProvider::Claude,
        "sess-bind-route",
    );
    store
        .ensure_session(durable.clone(), Some("/work/project".to_string()))
        .await
        .expect("durable session record");
    let new_location = claude_location("/h/durable-route", "sess-bind-route");
    record_acquisition(
        &store,
        durable.clone(),
        verified_acquisition(new_location.clone()),
    )
    .await
    .expect("the durable route is verified at revision one");
    store
        .bind_pending(BindNameInput {
            pending: pending.clone(),
            target: durable.clone(),
            acquisition: verified_acquisition(new_location.clone()),
        })
        .await
        .expect("verified pending-to-durable bind");

    let after_bind = native_entry_for_target(&document_json(dir.path()), &durable);
    assert_eq!(
        after_bind["attemptedLocationRevision"].as_u64(),
        Some(1),
        "the destination route deliberately shares the old route's numeric revision"
    );
    assert!(after_bind["attemptedReceipts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|receipt| receipt.as_str() == Some(&old_receipt)));

    crate::session_names::set_test_hooks(
        dir.path(),
        vec![
            crate::session_names::TestHook::FrozenClockMs(start_ms),
            crate::session_names::TestHook::ClockOffsetMs(retry_due - start_ms),
        ],
    );
    let new_backend = ScriptedBackend::new(vec![WriteStep::Confirm]);
    new_backend.set_title(Some("Different"));
    super::run_cycle(
        &store,
        new_backend.as_ref() as &dyn NativeNameBackend,
        &durable,
    )
    .await;

    assert_eq!(
        new_backend.writes(),
        1,
        "the new native route gets one write"
    );
    assert_eq!(new_backend.write_locations(), vec![new_location]);
    assert_eq!(new_backend.write_titles(), vec!["Manual Title"]);
    assert_eq!(
        native_sync_of(&store, durable.clone())
            .await
            .unwrap()
            .status,
        NativeSyncStatus::Synced
    );
    let after_write = native_entry_for_target(&document_json(dir.path()), &durable);
    let receipts = after_write["attemptedReceipts"].as_array().unwrap();
    assert!(receipts
        .iter()
        .any(|receipt| receipt.as_str() == Some(&old_receipt)));
    let confirmed_receipt = after_write["lastConfirmedReceipt"]
        .as_str()
        .expect("the new route write is confirmed");
    assert_ne!(confirmed_receipt, old_receipt);
    crate::session_names::clear_test_hooks(dir.path());
}

/// An acknowledged pending write can be merged into an already-synced
/// durable record. If the durable name wins, the pending receipt describes a
/// different title even at the same exact route; the surviving series must be
/// rearmed so it can observe and repair the provider title.
#[tokio::test]
async fn binding_pending_ack_into_synced_durable_winner_rearms_native_repair() {
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_525_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let pending = pending("h-bind-merge");
    ensure_pending(&store, "h-bind-merge", Some("/work/project"))
        .await
        .expect("pending record");
    rename_user(&store, pending.clone(), "Pending Title")
        .await
        .expect("pending manual title");

    let durable = session(
        freshell_protocol::session_names::NamedProvider::Claude,
        "sess-bind-merge",
    );
    store
        .ensure_session(durable.clone(), Some("/work/project".to_string()))
        .await
        .expect("durable record");
    let shared_route = claude_location("/h/bind-merge", "sess-bind-merge");
    record_acquisition(
        &store,
        pending.clone(),
        verified_acquisition(shared_route.clone()),
    )
    .await
    .expect("pending route revision one");
    record_acquisition(
        &store,
        durable.clone(),
        verified_acquisition(shared_route.clone()),
    )
    .await
    .expect("durable route revision one");
    rename_user(&store, durable.clone(), "Durable Title")
        .await
        .expect("later durable decision wins a manual/manual bind");

    let mut read_steps = vec![ReadStep::Current, ReadStep::Current];
    append_lifecycle_busy_read_steps(&mut read_steps);
    let backend =
        ScriptedBackend::new_with_reads(vec![WriteStep::Confirm, WriteStep::Confirm], read_steps);
    backend.set_title(Some("Durable Title"));
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &durable).await;
    assert_eq!(
        native_sync_of(&store, durable.clone())
            .await
            .unwrap()
            .status,
        NativeSyncStatus::Synced,
        "durable winner starts synced at the shared route"
    );

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &pending).await;
    assert_eq!(backend.writes(), 1);
    assert_eq!(backend.write_titles(), vec!["Pending Title"]);
    let pending_state = native_entry_for_target(&document_json(dir.path()), &pending);
    let pending_receipt = pending_state["confirmationPendingReceipt"]
        .as_str()
        .expect("the acknowledged pending write awaits confirmation")
        .to_string();
    let retry_due = pending_state["nextDue"]
        .as_i64()
        .expect("busy confirmation schedules a retry");

    store
        .bind_pending(BindNameInput {
            pending: pending.clone(),
            target: durable.clone(),
            acquisition: verified_acquisition(shared_route.clone()),
        })
        .await
        .expect("durable winner binds at the same route and revision");

    let after_bind = native_entry_for_target(&document_json(dir.path()), &durable);
    assert!(after_bind["attemptedReceipts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|receipt| receipt.as_str() == Some(&pending_receipt)));
    assert_ne!(
        native_sync_of(&store, durable.clone())
            .await
            .unwrap()
            .status,
        NativeSyncStatus::Synced,
        "a receipt for the losing pending title must not leave the winner falsely synced"
    );
    assert!(after_bind["confirmationPendingReceipt"].is_null());
    assert_eq!(
        after_bind["nextDue"].as_i64(),
        Some(retry_due),
        "the pending lifecycle backoff transfers with its consumed budget"
    );
    assert!(
        store.native_work_snapshot().is_empty(),
        "the durable winner must honor the pending lifecycle retry delay"
    );

    set_offset(retry_due - start_ms);
    assert!(
        !store.native_work_snapshot().is_empty(),
        "the durable winner becomes claimable for a read and repair when due"
    );
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &durable).await;
    assert_eq!(backend.writes(), 2, "the winning title is written once");
    assert_eq!(
        backend.write_titles(),
        vec!["Pending Title", "Durable Title"]
    );
    assert_eq!(
        backend.write_locations(),
        vec![shared_route.clone(), shared_route]
    );
    assert_eq!(
        native_sync_of(&store, durable).await.unwrap().status,
        NativeSyncStatus::Synced,
        "a matching confirmation read synchronizes the durable winner"
    );
    crate::session_names::clear_test_hooks(dir.path());
}

/// A verified route change during bind must rearm an existing synced durable
/// winner just as a standalone acquisition does, while carrying the pending
/// series' retry time and bounded budgets.
#[tokio::test]
async fn binding_pending_ack_to_a_new_route_rearms_synced_durable_winner() {
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_575_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let pending = pending("h-bind-new-route");
    ensure_pending(&store, "h-bind-new-route", Some("/work/project"))
        .await
        .expect("pending record");
    rename_user(&store, pending.clone(), "Pending Title")
        .await
        .expect("pending manual title");
    let pending_route = claude_location("/h/bind-new-route-pending", "sess-bind-new-route");
    record_acquisition(
        &store,
        pending.clone(),
        verified_acquisition(pending_route.clone()),
    )
    .await
    .expect("pending route revision one");

    let durable = session(
        freshell_protocol::session_names::NamedProvider::Claude,
        "sess-bind-new-route",
    );
    store
        .ensure_session(durable.clone(), Some("/work/project".to_string()))
        .await
        .expect("durable record");
    let old_durable_route = claude_location("/h/bind-new-route-old", "sess-bind-new-route");
    record_acquisition(
        &store,
        durable.clone(),
        verified_acquisition(old_durable_route),
    )
    .await
    .expect("durable route revision one");
    rename_user(&store, durable.clone(), "Durable Title")
        .await
        .expect("later durable decision wins the bind");

    let mut read_steps = vec![ReadStep::Current, ReadStep::Current];
    append_lifecycle_busy_read_steps(&mut read_steps);
    let backend =
        ScriptedBackend::new_with_reads(vec![WriteStep::Confirm, WriteStep::Confirm], read_steps);
    backend.set_title(Some("Durable Title"));
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &durable).await;
    assert_eq!(
        native_sync_of(&store, durable.clone())
            .await
            .unwrap()
            .status,
        NativeSyncStatus::Synced,
        "durable winner starts synced at its old route"
    );

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &pending).await;
    assert_eq!(backend.writes(), 1);
    assert_eq!(backend.write_titles(), vec!["Pending Title"]);
    assert_eq!(backend.write_locations(), vec![pending_route.clone()]);
    let pending_before_bind = native_entry_for_target(&document_json(dir.path()), &pending);
    let pending_receipt = pending_before_bind["confirmationPendingReceipt"]
        .as_str()
        .expect("pending route write awaits confirmation")
        .to_string();
    let retry_due = pending_before_bind["nextDue"]
        .as_i64()
        .expect("busy confirmation schedules a retry");
    let durable_before_bind = native_entry_for_target(&document_json(dir.path()), &durable);

    let new_route = claude_location("/h/bind-new-route-winner", "sess-bind-new-route");
    store
        .bind_pending(BindNameInput {
            pending: pending.clone(),
            target: durable.clone(),
            acquisition: verified_acquisition(new_route.clone()),
        })
        .await
        .expect("bind changes the durable route to the verified winner");

    let after_bind = native_entry_for_target(&document_json(dir.path()), &durable);
    assert!(after_bind["attemptedReceipts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|receipt| receipt.as_str() == Some(&pending_receipt)));
    assert!(after_bind["confirmationPendingReceipt"].is_null());
    assert_ne!(
        native_sync_of(&store, durable.clone())
            .await
            .unwrap()
            .status,
        NativeSyncStatus::Synced,
        "changing routes during bind must invalidate the old synced projection"
    );
    assert_eq!(
        after_bind["cyclesConsumed"].as_u64(),
        Some(
            (durable_before_bind["cyclesConsumed"].as_u64().unwrap()
                + pending_before_bind["cyclesConsumed"].as_u64().unwrap())
            .min(3)
        ),
        "bind carries, but does not replenish, the combined cycle budget"
    );
    assert_eq!(
        after_bind["readsConsumed"].as_u64(),
        Some(
            (durable_before_bind["readsConsumed"].as_u64().unwrap()
                + pending_before_bind["readsConsumed"].as_u64().unwrap())
            .min(6)
        ),
        "bind carries, but does not replenish, the combined read budget"
    );
    assert_eq!(after_bind["nextDue"].as_i64(), Some(retry_due));
    assert!(store.native_work_snapshot().is_empty());

    set_offset(retry_due - start_ms);
    assert!(!store.native_work_snapshot().is_empty());
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &durable).await;
    assert_eq!(backend.writes(), 2, "the new route is written once");
    assert_eq!(
        backend.write_titles(),
        vec!["Pending Title", "Durable Title"]
    );
    assert_eq!(backend.write_locations(), vec![pending_route, new_route]);
    assert_eq!(
        native_sync_of(&store, durable).await.unwrap().status,
        NativeSyncStatus::Synced,
        "the new route is confirmed after the durable winner is restored"
    );
    crate::session_names::clear_test_hooks(dir.path());
}

/// A pending acknowledgement remains usable when bind verifies the same
/// provider location for the durable record. Route revisions are allocated
/// per record key, so the durable key's revision can advance even though the
/// exact provider target is unchanged. The transferred receipt should be
/// confirmed by a read on the durable key without issuing another write.
#[tokio::test]
async fn binding_pending_ack_to_same_acquired_location_preserves_read_only_confirmation() {
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_625_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let pending = pending("h-bind-same-acquired-route");
    ensure_pending(&store, "h-bind-same-acquired-route", Some("/work/project"))
        .await
        .expect("pending record");
    rename_user(&store, pending.clone(), "Bound Title")
        .await
        .expect("pending manual title");

    let durable = session(
        freshell_protocol::session_names::NamedProvider::Claude,
        "sess-bind-same-acquired-route",
    );
    store
        .ensure_session(durable.clone(), Some("/work/project".to_string()))
        .await
        .expect("durable record");
    let acquired_route = claude_location(
        "/h/bind-same-acquired-route",
        "sess-bind-same-acquired-route",
    );
    record_acquisition(
        &store,
        pending.clone(),
        verified_acquisition(acquired_route.clone()),
    )
    .await
    .expect("pending route");
    record_acquisition(
        &store,
        durable.clone(),
        verified_acquisition(claude_location(
            "/h/bind-same-acquired-route-old",
            "sess-bind-same-acquired-route",
        )),
    )
    .await
    .expect("durable key starts at a different verified route");
    rename_user(&store, durable.clone(), "Bound Title")
        .await
        .expect("durable record wins the bind with the same title");

    let durable_backend = ScriptedBackend::new(vec![]);
    durable_backend.set_title(Some("Bound Title"));
    super::run_cycle(
        &store,
        durable_backend.as_ref() as &dyn NativeNameBackend,
        &durable,
    )
    .await;
    assert_eq!(
        native_sync_of(&store, durable.clone())
            .await
            .unwrap()
            .status,
        NativeSyncStatus::Synced,
        "the durable winner was synchronized at its old route before bind"
    );

    let mut read_steps = vec![ReadStep::Current];
    append_lifecycle_busy_read_steps(&mut read_steps);
    let backend =
        ScriptedBackend::new_with_reads(vec![WriteStep::ConfirmWithoutApplying], read_steps);
    backend.set_title(Some("Different"));
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &pending).await;
    assert_eq!(backend.writes(), 1);
    let pending_before_bind = native_entry_for_target(&document_json(dir.path()), &pending);
    let pending_receipt = pending_before_bind["confirmationPendingReceipt"]
        .as_str()
        .expect("acknowledged pending write awaits a confirmation read")
        .to_string();
    assert_eq!(
        pending_before_bind["attemptedLocationRevision"].as_u64(),
        Some(1)
    );
    let retry_due = pending_before_bind["nextDue"]
        .as_i64()
        .expect("busy confirmation has a retry deadline");

    store
        .bind_pending(BindNameInput {
            pending: pending.clone(),
            target: durable.clone(),
            acquisition: verified_acquisition(acquired_route.clone()),
        })
        .await
        .expect("bind verifies the pending route for the durable key");

    let after_bind = native_entry_for_target(&document_json(dir.path()), &durable);
    assert_eq!(
        after_bind["confirmationPendingReceipt"].as_str(),
        Some(pending_receipt.as_str())
    );
    assert_eq!(after_bind["nextDue"].as_i64(), Some(retry_due));

    set_offset(retry_due - start_ms);
    backend.set_title(Some("Bound Title"));
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &durable).await;

    assert_eq!(backend.writes(), 1, "bind confirmation is read-only");
    assert_eq!(
        backend.read_locations(),
        vec![acquired_route.clone(); LIFECYCLE_BUSY_CALLS_PER_PHASE + 2]
    );
    let after_confirmation = native_entry_for_target(&document_json(dir.path()), &durable);
    assert!(after_confirmation["confirmationPendingReceipt"].is_null());
    assert_eq!(
        after_confirmation["attemptedLocationRevision"].as_u64(),
        Some(2),
        "confirmation is restamped with the durable key's current route revision"
    );
    assert_eq!(after_confirmation["cyclesConsumed"].as_u64(), Some(3));
    assert_eq!(after_confirmation["readsConsumed"].as_u64(), Some(3));
    assert_eq!(
        after_confirmation["lastConfirmedReceipt"].as_str(),
        Some(pending_receipt.as_str())
    );
    assert_eq!(
        native_sync_of(&store, durable).await.unwrap().status,
        NativeSyncStatus::Synced
    );
    crate::session_names::clear_test_hooks(dir.path());
}

/// The verified bind route change itself rearms a synced durable winner even
/// when the pending series contributes no acknowledged receipt.
#[tokio::test]
async fn binding_verified_route_change_rearms_synced_durable_without_pending_receipt() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let pending = pending("h-bind-no-receipt");
    ensure_pending(&store, "h-bind-no-receipt", Some("/work/project"))
        .await
        .expect("pending record");
    rename_user(&store, pending.clone(), "Pending Title")
        .await
        .expect("pending manual title");
    record_acquisition(
        &store,
        pending.clone(),
        verified_acquisition(claude_location(
            "/h/bind-no-receipt-pending",
            "sess-bind-no-receipt",
        )),
    )
    .await
    .expect("pending route");

    let durable = session(
        freshell_protocol::session_names::NamedProvider::Claude,
        "sess-bind-no-receipt",
    );
    store
        .ensure_session(durable.clone(), Some("/work/project".to_string()))
        .await
        .expect("durable record");
    let old_route = claude_location("/h/bind-no-receipt-old", "sess-bind-no-receipt");
    record_acquisition(
        &store,
        durable.clone(),
        verified_acquisition(old_route.clone()),
    )
    .await
    .expect("old durable route");
    rename_user(&store, durable.clone(), "Durable Title")
        .await
        .expect("later durable decision wins the bind");

    let backend = ScriptedBackend::new_with_reads(vec![], vec![ReadStep::Current]);
    backend.set_title(Some("Durable Title"));
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &durable).await;
    assert_eq!(
        native_sync_of(&store, durable.clone())
            .await
            .unwrap()
            .status,
        NativeSyncStatus::Synced
    );
    let durable_before_bind = native_entry_for_target(&document_json(dir.path()), &durable);
    let pending_before_bind = native_entry_for_target(&document_json(dir.path()), &pending);
    assert!(pending_before_bind["confirmationPendingReceipt"].is_null());
    assert!(pending_before_bind["attemptedReceipts"]
        .as_array()
        .is_none_or(Vec::is_empty));

    let new_route = claude_location("/h/bind-no-receipt-winner", "sess-bind-no-receipt");
    store
        .bind_pending(BindNameInput {
            pending: pending.clone(),
            target: durable.clone(),
            acquisition: verified_acquisition(new_route.clone()),
        })
        .await
        .expect("bind verifies the new winner route");

    let after_bind = native_entry_for_target(&document_json(dir.path()), &durable);
    assert_ne!(
        native_sync_of(&store, durable.clone())
            .await
            .unwrap()
            .status,
        NativeSyncStatus::Synced,
        "route change alone invalidates a previously synced projection"
    );
    assert!(
        after_bind["observedCurrent"].is_null(),
        "a read of the old route cannot remain the current observation"
    );
    assert_eq!(
        after_bind["cyclesConsumed"].as_u64(),
        Some(
            (durable_before_bind["cyclesConsumed"].as_u64().unwrap()
                + pending_before_bind["cyclesConsumed"].as_u64().unwrap())
            .min(3)
        ),
        "route rearming does not replenish consumed cycles"
    );
    assert_eq!(
        after_bind["readsConsumed"].as_u64(),
        Some(
            (durable_before_bind["readsConsumed"].as_u64().unwrap()
                + pending_before_bind["readsConsumed"].as_u64().unwrap())
            .min(6)
        ),
        "route rearming does not replenish consumed reads"
    );
    assert_eq!(after_bind["nextDue"], durable_before_bind["nextDue"]);
    assert!(after_bind["confirmationPendingReceipt"].is_null());
    assert!(!store.native_work_snapshot().is_empty());
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &durable).await;
    assert_eq!(backend.reads(), 2, "the new route receives a fresh read");
    assert_eq!(
        backend.writes(),
        0,
        "matching title needs no provider write"
    );
    assert_eq!(backend.read_locations(), vec![old_route, new_route]);
    assert_eq!(
        native_sync_of(&store, durable).await.unwrap().status,
        NativeSyncStatus::Synced,
        "the writable manual winner synchronizes on its new route"
    );
}

/// A route change after synchronization on the final cycle invalidates the
/// old synced/observed projection even though no cycle remains to rearm.
#[tokio::test]
async fn route_change_after_last_synced_cycle_invalidates_old_projection_without_rearming() {
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_625_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-bind-last-cycle", "/h/bind-last-cycle-old").await;
    let old_route = claude_location("/h/bind-last-cycle-old", "h-bind-last-cycle");
    let backend = ScriptedBackend::new_with_reads(
        vec![
            WriteStep::Undelivered,
            WriteStep::Undelivered,
            WriteStep::Confirm,
        ],
        vec![
            ReadStep::Current,
            ReadStep::Current,
            ReadStep::Current,
            ReadStep::Current,
        ],
    );
    backend.set_title(Some("Old Title"));

    for cycle in 0..3 {
        super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
        if cycle < 2 {
            let state = native_entry_for_target(&document_json(dir.path()), &target);
            let due = state["nextDue"]
                .as_i64()
                .expect("failed cycle schedules the next attempt");
            set_offset(due - start_ms);
        }
    }

    let before_route_change = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(before_route_change["cyclesConsumed"].as_u64(), Some(3));
    assert_eq!(before_route_change["readsConsumed"].as_u64(), Some(4));
    assert_eq!(before_route_change["observedCurrent"].as_bool(), Some(true));
    assert_eq!(
        native_sync_of(&store, target.clone()).await.unwrap().status,
        NativeSyncStatus::Synced
    );
    assert_eq!(backend.read_locations(), vec![old_route.clone(); 4]);

    let new_route = claude_location("/h/bind-last-cycle-new", "h-bind-last-cycle");
    record_acquisition(&store, target.clone(), verified_acquisition(new_route))
        .await
        .expect("verified route changes after final-cycle synchronization");

    let after_route_change = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(
        native_sync_of(&store, target.clone()).await.unwrap().status,
        NativeSyncStatus::Unsynced,
        "the last readback applies only to the old route"
    );
    assert!(after_route_change["observedCurrent"].is_null());
    assert!(after_route_change["settled"].as_bool().unwrap());
    assert_eq!(
        after_route_change["cyclesConsumed"],
        before_route_change["cyclesConsumed"]
    );
    assert_eq!(
        after_route_change["readsConsumed"],
        before_route_change["readsConsumed"]
    );
    assert_eq!(
        after_route_change["nextDue"],
        before_route_change["nextDue"]
    );
    assert!(store.native_work_snapshot().is_empty());

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    assert_eq!(
        backend.reads(),
        4,
        "no read budget remains after route change"
    );
    assert_eq!(
        backend.writes(),
        3,
        "no write budget remains after route change"
    );
    crate::session_names::clear_test_hooks(dir.path());
}

/// A route move during the durable lifecycle-busy cooldown preserves its due
/// time. The cooldown's due claim then resets the per-window read allowance
/// and resumes on the new route without increasing the three-cycle cap.
#[tokio::test]
async fn route_change_preserves_busy_cooldown_until_due_before_rearming_on_new_route() {
    const MAX_BUSY_DEFERRALS: usize = 6;
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_675_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let target = armed_pending(
        &store,
        "h-bind-read-exhausted",
        "/h/bind-read-exhausted-old",
    )
    .await;
    let write_steps = (0..MAX_BUSY_DEFERRALS)
        .flat_map(|_| lifecycle_busy_write_steps())
        .collect();
    let backend = ScriptedBackend::new_with_reads(
        write_steps,
        vec![
            ReadStep::Current,
            ReadStep::Current,
            ReadStep::Current,
            ReadStep::Current,
            ReadStep::Current,
            ReadStep::Current,
        ],
    );
    backend.set_title(Some("Different"));

    for attempt in 0..MAX_BUSY_DEFERRALS {
        super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
        if attempt + 1 < MAX_BUSY_DEFERRALS {
            let state = native_entry_for_target(&document_json(dir.path()), &target);
            let due = state["nextDue"]
                .as_i64()
                .expect("busy retry schedules the next attempt");
            set_offset(due - start_ms);
        }
    }

    let before_route_change = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(before_route_change["cyclesConsumed"].as_u64(), Some(0));
    assert_eq!(before_route_change["readsConsumed"].as_u64(), Some(6));
    assert_eq!(
        before_route_change["lifecycleBusyDeferrals"].as_u64(),
        Some(6)
    );
    assert!(!before_route_change["settled"].as_bool().unwrap());
    assert_eq!(backend.reads(), MAX_BUSY_DEFERRALS as u32);
    assert_eq!(
        backend.writes(),
        MAX_BUSY_DEFERRALS as u32 * LIFECYCLE_BUSY_CALLS_PER_PHASE as u32
    );

    record_acquisition(
        &store,
        target.clone(),
        verified_acquisition(claude_location(
            "/h/bind-read-exhausted-new",
            "h-bind-read-exhausted",
        )),
    )
    .await
    .expect("verified route changes after bounded write deferrals");

    let after_route_change = native_entry_for_target(&document_json(dir.path()), &target);
    assert!(
        !after_route_change["settled"].as_bool().unwrap(),
        "the pending cooldown remains eligible after its deadline"
    );
    assert_eq!(
        after_route_change["cyclesConsumed"],
        before_route_change["cyclesConsumed"]
    );
    assert_eq!(
        after_route_change["readsConsumed"],
        before_route_change["readsConsumed"]
    );
    assert_eq!(
        after_route_change["lifecycleBusyDeferrals"],
        before_route_change["lifecycleBusyDeferrals"]
    );
    assert_eq!(
        after_route_change["nextDue"],
        before_route_change["nextDue"]
    );
    assert!(
        store.native_work_snapshot().is_empty(),
        "the persisted cooldown prevents early work on the new route"
    );

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    assert_eq!(backend.reads(), 6);
    assert_eq!(
        backend.writes(),
        MAX_BUSY_DEFERRALS as u32 * LIFECYCLE_BUSY_CALLS_PER_PHASE as u32
    );
    let after_idle_cycle = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(
        after_idle_cycle["cyclesConsumed"],
        before_route_change["cyclesConsumed"]
    );

    // The deferred deadline and exhausted read window survive a restart.
    // A due claim on the replacement route starts a new six-read window,
    // while only its actual write increments the permanent cycle allowance.
    drop(store);
    let cooldown_due = before_route_change["nextDue"]
        .as_i64()
        .expect("durable cooldown is recorded");
    set_offset(cooldown_due - start_ms);
    let reopened = open_store(dir.path());
    assert_eq!(reopened.native_work_snapshot().len(), 1);
    super::run_cycle(
        &reopened,
        backend.as_ref() as &dyn NativeNameBackend,
        &target,
    )
    .await;

    let resumed = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(resumed["cyclesConsumed"].as_u64(), Some(1));
    assert_eq!(resumed["readsConsumed"].as_u64(), Some(2));
    assert_eq!(resumed["lifecycleBusyDeferrals"].as_u64(), Some(0));
    assert!(resumed["confirmationPendingReceipt"].is_null());
    assert_eq!(
        resumed["attemptedReceipts"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(backend.reads(), 8, "one fresh pre-read and confirmation");
    assert_eq!(
        backend.writes(),
        MAX_BUSY_DEFERRALS as u32 * LIFECYCLE_BUSY_CALLS_PER_PHASE as u32 + 1,
        "only the deferred claim's write applies"
    );
    assert_eq!(backend.confirmed_writes(), 1);
    let moved_route = claude_location("/h/bind-read-exhausted-new", "h-bind-read-exhausted");
    assert_eq!(
        backend.read_locations()[6..],
        [moved_route.clone(), moved_route]
    );
    assert_eq!(
        native_sync_of(&reopened, target).await.unwrap().status,
        NativeSyncStatus::Synced
    );
    crate::session_names::clear_test_hooks(dir.path());
}

/// A successful read captured on a pending route must not synchronize a
/// durable target after bind, even when the two independent route counters
/// both happen to be one.
#[tokio::test]
async fn late_pre_bind_read_cannot_sync_durable_route_with_same_revision_number() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let durable = session(
        freshell_protocol::session_names::NamedProvider::Claude,
        "sess-bind-stale-read",
    );
    store
        .ensure_session(durable.clone(), Some("/work/project".to_string()))
        .await
        .expect("durable session record");
    let durable_location = claude_location("/h/durable-stale-read", "sess-bind-stale-read");
    record_acquisition(
        &store,
        durable.clone(),
        verified_acquisition(durable_location.clone()),
    )
    .await
    .expect("the durable route is verified at revision one");

    let pending = armed_pending(&store, "h-bind-stale-read", "/h/pending-stale-read").await;
    let backend = ScriptedBackend::new_with_reads(vec![], vec![ReadStep::Current]).arm_read_gate();
    backend.set_title(Some("Manual Title"));
    let store_for_worker = Arc::clone(&store);
    let backend_for_worker = Arc::clone(&backend);
    let pending_for_worker = pending.clone();
    let worker = tokio::spawn(async move {
        super::run_cycle(
            &store_for_worker,
            backend_for_worker.as_ref() as &dyn NativeNameBackend,
            &pending_for_worker,
        )
        .await;
    });

    backend.gate_arrived.notified().await;
    let old_series_epoch = current_series_epoch(dir.path());
    store
        .bind_pending(BindNameInput {
            pending: pending.clone(),
            target: durable.clone(),
            acquisition: verified_acquisition(durable_location),
        })
        .await
        .expect("the pending session binds while the old read is in flight");
    backend.gate_open.notify_one();
    worker.await.unwrap();

    let sync = native_sync_of(&store, durable.clone())
        .await
        .expect("the bound series remains projected");
    assert_eq!(sync.location_revision, 1);
    assert_ne!(
        sync.status,
        NativeSyncStatus::Synced,
        "the old claim's desired revision and route must not be rebased by bind"
    );
    assert_eq!(current_series_epoch(dir.path()), old_series_epoch);
}

/// A read charge from an old pending claim cannot spend the transferred
/// durable series' allowance after bind has rebased its desired revision and
/// route stamp.
#[tokio::test]
async fn bind_rejects_a_stale_pending_read_charge_after_route_rebase() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let durable = session(
        freshell_protocol::session_names::NamedProvider::Claude,
        "sess-bind-stale-read-charge",
    );
    store
        .ensure_session(durable.clone(), Some("/work/project".to_string()))
        .await
        .expect("durable session record");
    record_acquisition(
        &store,
        durable.clone(),
        verified_acquisition(claude_location(
            "/h/bind-read-charge-old",
            "sess-bind-stale-read-charge",
        )),
    )
    .await
    .expect("the durable record starts with another route");

    let pending = pending("h-bind-stale-read-charge");
    ensure_pending(&store, "h-bind-stale-read-charge", Some("/work/project"))
        .await
        .expect("pending record");
    rename_user(&store, pending.clone(), "Bound Title")
        .await
        .expect("pending manual title");
    let acquired_route = claude_location("/h/bind-read-charge", "sess-bind-stale-read-charge");
    record_acquisition(
        &store,
        pending.clone(),
        verified_acquisition(acquired_route.clone()),
    )
    .await
    .expect("pending route");

    let old_claim = store
        .claim_native_cycle(pending.clone(), "stale-read-charge".to_string())
        .await
        .unwrap()
        .expect("pending cycle claim");
    assert_eq!(old_claim.location_revision, 1);
    store
        .bind_pending(BindNameInput {
            pending: pending.clone(),
            target: durable.clone(),
            acquisition: verified_acquisition(acquired_route),
        })
        .await
        .expect("bind rebases the pending series onto the durable record");

    let before_charge = native_entry_for_target(&document_json(dir.path()), &durable);
    assert_eq!(before_charge["readsConsumed"].as_u64(), Some(0));
    assert!(
        !store.charge_native_read(old_claim.clone()).await.unwrap(),
        "the old pending claim is stale after bind"
    );
    let after_charge = native_entry_for_target(&document_json(dir.path()), &durable);
    assert_eq!(
        after_charge["readsConsumed"].as_u64(),
        Some(0),
        "a stale claim cannot consume the rebased series' read budget"
    );
}

async fn assert_divergent_pre_read_is_fenced_after_store_change(
    handle: &str,
    new_name: Option<&str>,
    new_location: Option<NativeLocation>,
    expected_title: &str,
    expected_location: NativeLocation,
) {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, handle, "/h/prewrite-original").await;
    let old_backend =
        ScriptedBackend::new_with_reads(vec![WriteStep::Confirm], vec![ReadStep::Current])
            .arm_read_gate();
    old_backend.set_title(Some("Different"));
    let store_for_worker = Arc::clone(&store);
    let backend_for_worker = Arc::clone(&old_backend);
    let target_for_worker = target.clone();
    let worker = tokio::spawn(async move {
        super::run_cycle(
            &store_for_worker,
            backend_for_worker.as_ref() as &dyn NativeNameBackend,
            &target_for_worker,
        )
        .await;
    });

    old_backend.gate_arrived.notified().await;
    if let Some(new_name) = new_name {
        rename_user(&store, target.clone(), new_name)
            .await
            .expect("the newer canonical title commits while the old read is pending");
    }
    if let Some(new_location) = new_location {
        record_acquisition(&store, target.clone(), verified_acquisition(new_location))
            .await
            .expect("the new verified route commits while the old read is pending");
    }
    old_backend.gate_open.notify_one();
    worker.await.unwrap();

    assert_eq!(
        old_backend.writes(),
        0,
        "the stale pre-read must not dispatch an old claim's write"
    );
    assert!(old_backend.write_locations().is_empty());

    let current_backend = ScriptedBackend::new(vec![WriteStep::Confirm]);
    current_backend.set_title(Some("Different"));
    super::run_cycle(
        &store,
        current_backend.as_ref() as &dyn NativeNameBackend,
        &target,
    )
    .await;
    assert_eq!(current_backend.writes(), 1);
    assert_eq!(current_backend.write_titles(), vec![expected_title]);
    assert_eq!(current_backend.write_locations(), vec![expected_location]);
    assert_eq!(
        native_sync_of(&store, target).await.unwrap().status,
        NativeSyncStatus::Synced
    );
}

/// A successful but divergent read that was captured before a user rename
/// cannot authorize writing the superseded canonical title.
#[tokio::test]
async fn stale_divergent_pre_read_after_rename_does_not_dispatch_old_title() {
    let original = claude_location("/h/prewrite-original", "h-prewrite-rename");
    assert_divergent_pre_read_is_fenced_after_store_change(
        "h-prewrite-rename",
        Some("Newer Title"),
        None,
        "Newer Title",
        original,
    )
    .await;
}

/// A successful but divergent read captured before relocation cannot
/// authorize writing to the superseded native route.
#[tokio::test]
async fn stale_divergent_pre_read_after_relocation_does_not_dispatch_old_route() {
    let moved = claude_location("/h/prewrite-moved", "h-prewrite-relocate");
    assert_divergent_pre_read_is_fenced_after_store_change(
        "h-prewrite-relocate",
        None,
        Some(moved.clone()),
        "Manual Title",
        moved,
    )
    .await;
}

/// Distinct prospective locations both have numeric revision zero, so a
/// stale successful read must compare the captured route itself before it can
/// confirm the replacement prospective route.
#[tokio::test]
async fn late_pre_read_after_prospective_route_change_is_fenced_by_location() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-prospective-fence");
    ensure_pending(&store, "h-prospective-fence", Some("/work/project"))
        .await
        .expect("pending record");
    rename_user(&store, target.clone(), "Manual Title")
        .await
        .expect("manual title");
    let original = claude_location("/h/prospective-original", "h-prospective-fence");
    let replacement = claude_location("/h/prospective-replacement", "h-prospective-fence");
    store
        .record_acquisition(
            target.clone(),
            NativeAcquisition {
                location: original.clone(),
                evidence: NativeEvidenceKind::InitializedRuntime,
                persistence: NativePersistence::Prospective,
            },
        )
        .await
        .expect("initial prospective route");

    let backend = ScriptedBackend::new_with_reads(vec![], vec![ReadStep::Current]).arm_read_gate();
    backend.set_title(Some("Manual Title"));
    let store_for_worker = Arc::clone(&store);
    let backend_for_worker = Arc::clone(&backend);
    let target_for_worker = target.clone();
    let worker = tokio::spawn(async move {
        super::run_cycle(
            &store_for_worker,
            backend_for_worker.as_ref() as &dyn NativeNameBackend,
            &target_for_worker,
        )
        .await;
    });

    backend.gate_arrived.notified().await;
    store
        .record_acquisition(
            target.clone(),
            NativeAcquisition {
                location: replacement.clone(),
                evidence: NativeEvidenceKind::InitializedRuntime,
                persistence: NativePersistence::Prospective,
            },
        )
        .await
        .expect("the prospective route changes while the old read is pending");
    backend.gate_open.notify_one();
    worker.await.unwrap();

    assert_eq!(backend.read_locations(), vec![original]);
    assert_ne!(
        native_sync_of(&store, target.clone()).await.unwrap().status,
        NativeSyncStatus::Synced,
        "equal zero revisions do not make distinct prospective locations equivalent"
    );

    let current_backend = ScriptedBackend::new(vec![WriteStep::Confirm]);
    current_backend.set_title(Some("Different"));
    super::run_cycle(
        &store,
        current_backend.as_ref() as &dyn NativeNameBackend,
        &target,
    )
    .await;
    assert_eq!(current_backend.writes(), 1);
    assert_eq!(current_backend.write_locations(), vec![replacement]);
    assert_eq!(
        native_sync_of(&store, target).await.unwrap().status,
        NativeSyncStatus::Synced
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
    impl crate::session_name_capability::SessionNameTransport for NeverTransport {
        fn generate_content(
            &self,
            _p: String,
            _m: u32,
        ) -> crate::ai_title::BoxFuture<Result<String, crate::gemini_failure::GeminiFailure>>
        {
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

    let mut published = store.subscribe();
    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        backend.clone(),
        inert_generation(dir.path()),
    );
    await_published_native_status(
        &store,
        &mut published,
        &target,
        NativeSyncStatus::Synced,
        REAL_CLOCK_CONVERGENCE_BOUND,
        "the worker must converge the armed series",
    )
    .await;
    worker.abort();
    assert_eq!(backend.writes(), 1);
    assert_eq!(backend.reads(), 2);
}

#[tokio::test]
async fn a_busy_native_series_does_not_stall_another_ready_series() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let busy_target = armed_pending(&store, "a-busy", "/h/a-busy").await;
    let _ready_target = armed_pending(&store, "z-ready", "/h/z-ready").await;
    let backend = OneSeriesBusyBackend::new(busy_target);
    let other_write_started = backend.other_write_started.notified();
    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        backend.clone(),
        inert_generation(dir.path()),
    );

    tokio::time::timeout(Duration::from_secs(2), other_write_started)
        .await
        .expect("the ready series reaches its write while the other series backs off");
    worker.abort();
    let _ = worker.await;

    assert_eq!(backend.busy_reads.load(Ordering::SeqCst), 1);
    assert_eq!(backend.delegate.writes(), 1);
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
            series_epoch: 1,
            lifecycle_busy_deferrals: 0,
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
            series_epoch: 1,
            lifecycle_busy_deferrals: 0,
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

/// `native_work_snapshot` and the transaction claim must use the same
/// offset-aware decision clock. A frozen base makes both sides of the real
/// retry floor independent of wall-clock time and filesystem latency.
#[tokio::test]
async fn native_work_snapshot_reads_the_test_offset_aware_clock() {
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_000_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-clock", "/h/.claude").await;

    // Consume cycle 1 and fold an undelivered failure at the frozen instant:
    // the second cycle becomes due exactly five seconds after the fold.
    let claim = store
        .claim_native_cycle(target.clone(), "cycle-1".to_string())
        .await
        .unwrap()
        .expect("cycle 1 claims — an armed series is immediately ready");
    store
        .fold_native_outcome(
            claim.clone(),
            NativeOutcomeFold::Undelivered {
                reason: "connect refusal".to_string(),
            },
        )
        .await
        .expect("failure folds a record update");
    assert_eq!(
        native_entry_of(&document_json(dir.path()))["nextDue"].as_i64(),
        Some(start_ms + 5_000)
    );

    for offset in [0, 4_999] {
        set_offset(offset);
        assert!(
            store.native_work_snapshot().is_empty(),
            "cycle 2 waits for its retry floor at offset {offset}"
        );
        assert!(
            store
                .claim_native_cycle(target.clone(), format!("too-early-{offset}"))
                .await
                .unwrap()
                .is_none(),
            "the claim agrees with the snapshot before the retry floor"
        );
    }

    // Only the test offset advances: both the snapshot and the claim become
    // ready exactly at the production floor, without a wall-clock wait.
    set_offset(5_000);
    let items = store.native_work_snapshot();
    assert!(
        items.iter().any(|item| item.target == target),
        "the offset-aware clock admits the due native retry"
    );
    let claim = store
        .claim_native_cycle(target, "cycle-2".to_string())
        .await
        .unwrap()
        .expect("cycle 2 claims exactly at the retry floor");
    assert_eq!(claim.cycle, 2);
    crate::session_names::clear_test_hooks(dir.path());
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
                error: Box::new(RpcError {
                    code: -32004,
                    message: "thread not found".into(),
                    data: None,
                }),
            }),
            super::NativeClassified::Unsupported(_)
        ),
        "a diagnosed not-found is a capability failure"
    );
    assert!(
        matches!(
            classified(CodexAppServerError::Rpc {
                method: "thread/name/set".into(),
                error: Box::new(RpcError {
                    code: -32603,
                    message: "internal error".into(),
                    data: None,
                }),
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
    impl crate::session_name_capability::SessionNameTransport for NeverGemini {
        fn generate_content(
            &self,
            _prompt: String,
            _max_output_tokens: u32,
        ) -> crate::ai_title::BoxFuture<Result<String, crate::gemini_failure::GeminiFailure>>
        {
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
        Arc::new(NeverGemini) as Arc<dyn crate::session_name_capability::SessionNameTransport>,
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

/// When an absent capability arrived and when the worker's probe first
/// reported it available, on tokio's clock. The capability-pause tests run
/// on the paused clock, where only the worker's own timers advance time
/// (blocking document IO does not), so the gap measures the worker's re-probe
/// scheduling exactly, never disk speed.
#[derive(Clone, Copy, Debug, Default)]
struct CapabilityArrival {
    wired_at: Option<tokio::time::Instant>,
    first_available_probe: Option<tokio::time::Instant>,
}

impl CapabilityArrival {
    fn wired(&mut self) {
        self.wired_at = Some(tokio::time::Instant::now());
        self.first_available_probe = None;
    }

    fn probed_available(&mut self) {
        if self.wired_at.is_some() && self.first_available_probe.is_none() {
            self.first_available_probe = Some(tokio::time::Instant::now());
        }
    }

    /// The re-probe contract: a refused series rotates out of selection for
    /// one `CAPABILITY_REPROBE_DELAY` and re-probes at the first worker poll
    /// after that, so capability arrival is discovered within one window
    /// plus one `WORKER_POLL_INTERVAL`.
    fn assert_discovered_within_one_reprobe_window(&self, what: &str) {
        let wired_at = self
            .wired_at
            .unwrap_or_else(|| panic!("{what}: the capability was never wired"));
        let probed_at = self
            .first_available_probe
            .unwrap_or_else(|| panic!("{what}: no probe ever saw the arrived capability"));
        let latency = probed_at.duration_since(wired_at);
        let window = super::CAPABILITY_REPROBE_DELAY + super::WORKER_POLL_INTERVAL;
        assert!(
            latency <= window,
            "{what}: the arrived capability was first probed {latency:?} after it \
             arrived; one re-probe window allows {window:?}"
        );
    }
}

/// A dispatch-shaped backend whose wired adapter can swap mid-test: `None`
/// models the degraded boot (no adapter for the provider — every operation
/// answers the production `Unsupported`), `Some(scripted)` models the
/// capability arriving.
struct SwappableDispatch {
    live: Arc<std::sync::RwLock<Option<Arc<ScriptedBackend>>>>,
    arrival: Mutex<CapabilityArrival>,
}

impl SwappableDispatch {
    fn unwired() -> Arc<Self> {
        Arc::new(Self {
            live: Arc::new(std::sync::RwLock::new(None)),
            arrival: Mutex::new(CapabilityArrival::default()),
        })
    }

    fn wire(self: &Arc<Self>, backend: Arc<ScriptedBackend>) {
        *self.live.write().unwrap() = Some(backend);
        self.arrival.lock().unwrap().wired();
    }

    fn arrival(&self) -> CapabilityArrival {
        *self.arrival.lock().unwrap()
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
        if live {
            self.arrival.lock().unwrap().probed_available();
        }
        Box::pin(async move { live.into() })
    }
}

/// A supervisor that keeps refusing only the lifecycle probe. The worker
/// must apply the bounded durable lifecycle-contention budget without consuming any
/// provider read/write allowance.
struct LifecycleBusyProbeBackend {
    scripted: Arc<ScriptedBackend>,
    probes: AtomicU32,
    lifecycle_busy: AtomicBool,
}

impl LifecycleBusyProbeBackend {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            scripted: ScriptedBackend::new(vec![]),
            probes: AtomicU32::new(0),
            lifecycle_busy: AtomicBool::new(true),
        })
    }

    fn probes(&self) -> u32 {
        self.probes.load(Ordering::SeqCst)
    }

    fn set_lifecycle_busy(&self, busy: bool) {
        self.lifecycle_busy.store(busy, Ordering::SeqCst);
    }
}

impl NativeNameBackend for LifecycleBusyProbeBackend {
    fn read(&self, target: NativeNameTarget) -> super::NativeFuture<NativeNameReadback> {
        self.scripted.read(target)
    }

    fn write(&self, attempt: super::NativeNameAttempt) -> super::NativeFuture<()> {
        self.scripted.write(attempt)
    }

    fn route_available(&self, _target: NativeNameTarget) -> super::NativeProbeFuture {
        self.probes.fetch_add(1, Ordering::SeqCst);
        let busy = self.lifecycle_busy.load(Ordering::SeqCst);
        Box::pin(async move {
            if busy {
                super::NativeProbeResult::LifecycleBusy
            } else {
                super::NativeProbeResult::Available
            }
        })
    }
}

/// T3-I3: rename a session whose provider capability is ABSENT (a degraded
/// boot with no adapter wired): no cycle is consumed, the series stays
/// `pending` and discoverable, and the work proceeds once the capability
/// arrives — discovered within one re-probe window — never a burned cycle
/// and a misleading `unsupported` per decision. Paused clock: the worker's
/// poll and re-probe timers are virtual, so the discovery bound is exact and
/// the durable writes in between take as long as the disk does.
#[tokio::test(start_paused = true)]
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
    // is absent: several re-probe windows of worker polls (virtual time).
    tokio::time::sleep(3 * (super::CAPABILITY_REPROBE_DELAY + super::WORKER_POLL_INTERVAL)).await;

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
    assert_eq!(
        native_entry_of(&doc)["lifecycleBusyDeferrals"].as_u64(),
        Some(0),
        "genuine capability absence does not spend the lifecycle contention budget"
    );

    // The capability arrives: the SAME series is re-probed within one
    // re-probe window and converges through its own cycle.
    let mut published = store.subscribe();
    let backend = ScriptedBackend::new(vec![WriteStep::Confirm]);
    backend.set_title(Some("Divergent"));
    dispatch.wire(backend.clone());
    await_published_native_status(
        &store,
        &mut published,
        &target,
        NativeSyncStatus::Synced,
        CAPABILITY_ARRIVAL_CONVERGENCE_BOUND,
        "the paused series must converge once the capability arrives",
    )
    .await;
    worker.abort();
    dispatch
        .arrival()
        .assert_discovered_within_one_reprobe_window("the paused series");
    assert_eq!(backend.writes(), 1);
    assert_eq!(backend.reads(), 2);
}

/// Typed lock refusals from the route probe are lifecycle contention, not
/// missing capability: after the bounded deferral budget the series enters
/// a durable cooldown, survives a store reopen, and resumes when contention
/// clears.
#[tokio::test(start_paused = true)]
async fn lifecycle_busy_route_probe_recovers_after_durable_cooldown_and_restart() {
    const MAX_BUSY_DEFERRALS: u64 = 6;
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_475_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-probe-always-busy", "/h/probe-busy").await;
    let backend = LifecycleBusyProbeBackend::new();
    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        backend.clone(),
        inert_generation(dir.path()),
    );

    for expected in 1..=MAX_BUSY_DEFERRALS {
        let state = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let state = native_entry_for_target(&document_json(dir.path()), &target);
                if state["lifecycleBusyDeferrals"].as_u64() == Some(expected) {
                    break state;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("probe busy deferral {expected} was not persisted"));

        if expected < MAX_BUSY_DEFERRALS {
            let due = state["nextDue"].as_i64().expect("retry is scheduled");
            set_offset(due - start_ms);
            tokio::time::advance(WORKER_POLL_INTERVAL).await;
        }
    }
    worker.abort();
    let _ = worker.await;

    let state = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(backend.probes(), MAX_BUSY_DEFERRALS as u32);
    assert_eq!(backend.scripted.reads(), 0, "busy probes dispatch no reads");
    assert_eq!(
        backend.scripted.writes(),
        0,
        "busy probes dispatch no writes"
    );
    assert_eq!(state["cyclesConsumed"].as_u64(), Some(0));
    assert_eq!(state["readsConsumed"].as_u64(), Some(0));
    assert!(state.get("attemptedReceipts").is_none());
    assert!(!state["settled"].as_bool().unwrap());
    let cooldown_due = state["nextDue"]
        .as_i64()
        .expect("a durable cooldown is scheduled after the fast budget");
    assert!(
        store.native_work_snapshot().is_empty(),
        "cooldown is not yet due"
    );
    let sync = native_sync_of(&store, target.clone()).await.unwrap();
    assert_eq!(sync.status, NativeSyncStatus::Unsynced);
    assert!(sync.reason.unwrap().contains("lifecycle lock contention"));

    // Restart while the cooldown is pending. The exact series becomes due
    // from its persisted timestamp and converges after the typed refusal
    // clears, without claiming or writing while it was busy.
    drop(store);
    set_offset(cooldown_due - start_ms);
    let reopened = open_store(dir.path());
    assert_eq!(reopened.native_work_snapshot().len(), 1);
    backend.set_lifecycle_busy(false);
    let mut published = reopened.subscribe();
    let resumed_worker = SessionNameWorker::start(
        Arc::clone(&reopened),
        backend.clone(),
        inert_generation(dir.path()),
    );
    await_published_native_status(
        &reopened,
        &mut published,
        &target,
        NativeSyncStatus::Synced,
        CAPABILITY_ARRIVAL_CONVERGENCE_BOUND,
        "the same native series resumes after lifecycle contention clears",
    )
    .await;
    resumed_worker.abort();
    let _ = resumed_worker.await;
    assert_eq!(backend.probes(), MAX_BUSY_DEFERRALS as u32 + 1);
    assert_eq!(
        backend.scripted.reads(),
        2,
        "resume reads and confirms once"
    );
    assert_eq!(
        backend.scripted.writes(),
        1,
        "resume writes only the target title"
    );
    assert_eq!(backend.scripted.confirmed_writes(), 1);
    assert_eq!(
        native_entry_for_target(&document_json(dir.path()), &target)["lifecycleBusyDeferrals"]
            .as_u64(),
        Some(0),
        "the due claim starts a fresh bounded contention window"
    );
    crate::session_names::clear_test_hooks(dir.path());
}

#[tokio::test]
async fn stale_busy_probe_item_cannot_defer_a_relocated_or_renamed_series() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-probe-stale-item", "/h/probe-original").await;
    let old_route_item = store
        .native_work_snapshot()
        .into_iter()
        .find(|item| item.target == target)
        .expect("armed route is due");

    record_acquisition(
        &store,
        target.clone(),
        verified_acquisition(claude_location("/h/probe-moved", "h-probe-stale-item")),
    )
    .await
    .expect("route relocation commits while the old probe is in flight");
    let after_relocation = native_entry_for_target(&document_json(dir.path()), &target);
    assert!(matches!(
        store
            .defer_native_lifecycle_busy_for_item(old_route_item)
            .await
            .unwrap(),
        super::NativeLifecycleDeferralResult::Stale
    ));
    assert_eq!(
        native_entry_for_target(&document_json(dir.path()), &target),
        after_relocation,
        "a busy result for an old route changes no counter or deadline"
    );

    let old_name_item = store
        .native_work_snapshot()
        .into_iter()
        .find(|item| item.target == target)
        .expect("relocated route is due");
    rename_user(&store, target.clone(), "Newer Canonical Title")
        .await
        .expect("new canonical revision commits while the probe is in flight");
    let after_rename = native_entry_for_target(&document_json(dir.path()), &target);
    assert!(matches!(
        store
            .defer_native_lifecycle_busy_for_item(old_name_item)
            .await
            .unwrap(),
        super::NativeLifecycleDeferralResult::Stale
    ));
    assert_eq!(
        native_entry_for_target(&document_json(dir.path()), &target),
        after_rename,
        "a busy result for an old name changes no counter or deadline"
    );
    crate::session_names::clear_test_hooks(dir.path());
}

/// Repeated write refusals occur after successful pre-reads, so the physical
/// reads consume the old window's allowance. Starting a fresh durable window
/// after cooldown must permit a fresh pre-read while retaining the global
/// write-cycle limit and receipt safety.
#[tokio::test]
async fn lifecycle_busy_write_retries_after_cooldown_with_fresh_read_window() {
    const MAX_BUSY_DEFERRALS: u32 = 6;
    let dir = temp_data_dir();
    let start_ms = 1_700_000_000_525_i64;
    let set_offset = |offset| {
        crate::session_names::set_test_hooks(
            dir.path(),
            vec![
                crate::session_names::TestHook::FrozenClockMs(start_ms),
                crate::session_names::TestHook::ClockOffsetMs(offset),
            ],
        );
    };
    set_offset(0);
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-write-busy-cooldown", "/h/write-busy").await;
    let write_steps = (0..MAX_BUSY_DEFERRALS)
        .flat_map(|_| lifecycle_busy_write_steps())
        .collect();
    let backend = ScriptedBackend::new(write_steps);
    backend.set_title(Some("Different"));

    let mut current_offset = 0_i64;
    for attempt in 0..MAX_BUSY_DEFERRALS {
        super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
        if attempt + 1 < MAX_BUSY_DEFERRALS {
            let state = native_entry_for_target(&document_json(dir.path()), &target);
            let due = state["nextDue"].as_i64().expect("busy retry is scheduled");
            current_offset = due - start_ms;
            set_offset(current_offset);
        }
    }
    let state = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(backend.reads(), MAX_BUSY_DEFERRALS);
    assert_eq!(
        backend.writes(),
        MAX_BUSY_DEFERRALS * LIFECYCLE_BUSY_CALLS_PER_PHASE as u32
    );
    assert_eq!(backend.confirmed_writes(), 0);
    assert_eq!(state["cyclesConsumed"].as_u64(), Some(0));
    assert_eq!(
        state["readsConsumed"].as_u64(),
        Some(MAX_BUSY_DEFERRALS as u64)
    );
    assert_eq!(
        state["lifecycleBusyDeferrals"].as_u64(),
        Some(MAX_BUSY_DEFERRALS as u64)
    );
    assert!(state["attemptedReceipts"]
        .as_array()
        .is_none_or(|receipts| receipts.is_empty()));
    let cooldown_due = state["nextDue"].as_i64().expect("cooldown is scheduled");
    assert_eq!(
        cooldown_due - (start_ms + current_offset),
        crate::session_names::NATIVE_LIFECYCLE_BUSY_COOLDOWN_MS
    );

    // Reopen after the persisted cooldown. The new window admits the fresh
    // pre-read and one write; the acknowledgement is confirmed by a second
    // read, and only that dispatched write has an owned receipt.
    drop(store);
    set_offset(cooldown_due - start_ms);
    let reopened = open_store(dir.path());
    super::run_cycle(
        &reopened,
        backend.as_ref() as &dyn NativeNameBackend,
        &target,
    )
    .await;
    assert_eq!(backend.reads(), MAX_BUSY_DEFERRALS + 2);
    assert_eq!(
        backend.writes(),
        MAX_BUSY_DEFERRALS * LIFECYCLE_BUSY_CALLS_PER_PHASE as u32 + 1
    );
    assert_eq!(backend.confirmed_writes(), 1);
    assert_eq!(
        backend.write_titles(),
        vec![
            "Manual Title".to_string();
            MAX_BUSY_DEFERRALS as usize * LIFECYCLE_BUSY_CALLS_PER_PHASE + 1
        ]
    );
    let resumed = native_entry_for_target(&document_json(dir.path()), &target);
    assert_eq!(resumed["cyclesConsumed"].as_u64(), Some(1));
    assert_eq!(resumed["readsConsumed"].as_u64(), Some(2));
    assert_eq!(resumed["lifecycleBusyDeferrals"].as_u64(), Some(0));
    assert_eq!(
        native_sync_of(&reopened, target).await.unwrap().status,
        NativeSyncStatus::Synced
    );
    crate::session_names::clear_test_hooks(dir.path());
}

/// A capability probe authorizes only the exact route it inspected. If that
/// route relocates while the probe is pending, the stale snapshot cannot
/// claim or write the replacement route; the worker must probe the new route
/// before its fresh cycle.
#[tokio::test(start_paused = true)]
async fn relocation_during_route_probe_requires_a_fresh_probe_before_claim() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-probe-relocate", "/h/probe-original").await;
    let original = claude_location("/h/probe-original", "h-probe-relocate");
    let moved = claude_location("/h/probe-moved", "h-probe-relocate");
    let backend = ScriptedBackend::new(vec![WriteStep::Confirm]).arm_probe_gate();
    backend.set_title(Some("Different"));
    let mut published = store.subscribe();
    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        backend.clone(),
        inert_generation(dir.path()),
    );

    backend.probe_gate_arrived.notified().await;
    record_acquisition(&store, target.clone(), verified_acquisition(moved.clone()))
        .await
        .expect("the verified route changes while its old probe is pending");
    backend.probe_gate_open.notify_one();

    await_published_native_status(
        &store,
        &mut published,
        &target,
        NativeSyncStatus::Synced,
        CAPABILITY_ARRIVAL_CONVERGENCE_BOUND,
        "the fresh route should converge after it is probed",
    )
    .await;
    worker.abort();

    assert_eq!(
        backend.probe_locations(),
        vec![original, moved.clone()],
        "a stale probe result cannot authorize work on a replacement route"
    );
    assert_eq!(backend.writes(), 1);
    assert_eq!(backend.write_titles(), vec!["Manual Title"]);
    assert_eq!(backend.write_locations(), vec![moved]);
}

/// A dispatch-shaped backend whose capability probe refuses a chosen set of
/// claude locations (keyed by config root) until they are wired: the
/// per-target capability shape the fairness guarantee needs — one paused
/// head, one ready series — over an ordinary scripted provider.
struct SelectiveCapabilityBackend {
    scripted: Arc<ScriptedBackend>,
    refused: Arc<Mutex<Vec<String>>>,
    /// Arrival of each refused root's capability, keyed by config root.
    arrivals: Mutex<std::collections::BTreeMap<String, CapabilityArrival>>,
}

impl SelectiveCapabilityBackend {
    fn refusing(scripted: Arc<ScriptedBackend>, roots: &[&str]) -> Arc<Self> {
        Arc::new(Self {
            scripted,
            refused: Arc::new(Mutex::new(
                roots.iter().map(|root| root.to_string()).collect(),
            )),
            arrivals: Mutex::new(std::collections::BTreeMap::new()),
        })
    }

    fn wire(&self, root: &str) {
        self.refused.lock().unwrap().retain(|r| r != root);
        self.arrivals
            .lock()
            .unwrap()
            .entry(root.to_string())
            .or_default()
            .wired();
    }

    fn arrival(&self, root: &str) -> CapabilityArrival {
        self.arrivals
            .lock()
            .unwrap()
            .get(root)
            .copied()
            .unwrap_or_default()
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
            NativeLocation::Claude { config_root, .. } => {
                let refused = self
                    .refused
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|r| r == config_root);
                if !refused {
                    if let Some(arrival) = self.arrivals.lock().unwrap().get_mut(config_root) {
                        arrival.probed_available();
                    }
                }
                refused
            }
            _ => false,
        };
        Box::pin(async move { (!refused).into() })
    }
}

/// NEW-1: a capability-paused series at the HEAD of the selector must never
/// starve the armed series behind it. A probe refusal rotates the paused
/// head out of selection for a bounded window: the READY series converges,
/// the paused series itself stays pending, discoverable, and uncharged, and
/// once its capability arrives it is re-probed within one bounded window and
/// converges — the rotation is a re-probe backoff, never an eviction. Paused
/// clock, as in the capability-pause test above: the window is measured on
/// the worker's virtual timers, independent of disk speed.
#[tokio::test(start_paused = true)]
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

    let mut published = store.subscribe();
    let worker = SessionNameWorker::start(
        Arc::clone(&store),
        dispatch.clone(),
        inert_generation(dir.path()),
    );

    // THE fairness assertion: the ready series converges DESPITE the paused
    // head holding the front of the selector.
    await_published_native_status(
        &store,
        &mut published,
        &ready,
        NativeSyncStatus::Synced,
        CAPABILITY_ARRIVAL_CONVERGENCE_BOUND,
        "the ready series must converge despite the paused head",
    )
    .await;

    // The paused head stays refused across several re-probe windows
    // (virtual time) and consumed nothing: still pending, still discoverable
    // work, its whole allowance intact.
    tokio::time::sleep(3 * (super::CAPABILITY_REPROBE_DELAY + super::WORKER_POLL_INTERVAL)).await;
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

    // The capability arrives: the paused head is re-probed within one
    // re-probe window and converges too.
    dispatch.wire("/paused/.claude");
    await_published_native_status(
        &store,
        &mut published,
        &paused,
        NativeSyncStatus::Synced,
        CAPABILITY_ARRIVAL_CONVERGENCE_BOUND,
        "the paused head must converge once its capability arrives",
    )
    .await;
    worker.abort();
    dispatch
        .arrival("/paused/.claude")
        .assert_discovered_within_one_reprobe_window("the paused head");
    // Both series converged through their own full cycles — one write and
    // two reads each — and nothing was double-dispatched while paused.
    assert_eq!(scripted.writes(), 2);
    assert_eq!(scripted.reads(), 4);
}

// ---------------------------------------------------------------------------
// T3-I4: the packaged desktop app's staged helper path derivation.
// ---------------------------------------------------------------------------

/// `from_env` reads process-global env — own it through the crate-wide
/// `TestEnv` (`crate::test_env_lock`), which restores the prior values.
fn probe_from_env(
    vars: &[(&str, Option<&str>)],
    probe: impl FnOnce(&super::ClaudeNativeNameAdapter),
) {
    let mut env = crate::test_env_lock::TestEnv::lock_blocking();
    for (key, value) in vars {
        match value {
            Some(value) => env.set(key, value),
            None => env.remove(key),
        }
    }
    probe(&super::ClaudeNativeNameAdapter::from_env());
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
            store.charge_native_read(claim.clone()).await.unwrap(),
            "read {i} charges against the allowance"
        );
    }
    assert!(
        !store.charge_native_read(claim.clone()).await.unwrap(),
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
            claim.clone(),
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

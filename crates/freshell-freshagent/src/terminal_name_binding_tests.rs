//! Name reliability (Task 10): the shared terminal naming bind — every
//! terminal row path binds its name through one helper, a transient store
//! error is retried instead of leaving the row nameless or unbound, and the
//! 2 s tick reconciles what a failed or skipped bind left behind.
//!
//! Driven over the in-crate `RecordingSink` (wrapped to inject store
//! errors) and a fake [`TerminalNameBinder`] standing in for a door's
//! identity table. Paused tokio time auto-advances the bounded retry sleeps.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use freshell_protocol::native_location::NativeAcquisition;
use freshell_protocol::session_names::{
    NameIntent, NamedProvider, SessionNameRecord, SessionNameRef, SessionNameUpdate,
};
use freshell_terminal::registry::{HeadlessTerminal, ManagedTerminalDescriptor};
use freshell_terminal::TerminalRegistry;

use super::{
    bind_terminal_naming_from_identity, reconcile_terminal_names, NameBinding, NamingBindHint,
    NamingBindOutcome, TerminalNameBinder,
};
use crate::naming::test_support::{verified_claude_acquisition, RecordingSink};
use crate::naming::{
    BindNameInput, NameActivity, NameError, NameFuture, NativeNameObservation, PendingNameInput,
    RenameNameInput, SessionNaming,
};

// ── fakes ────────────────────────────────────────────────────────────────

/// The recording sink with injectable store failures: each queued error is
/// answered by one call; `fail_*` makes every call fail until cleared.
struct FaultySink {
    inner: Arc<RecordingSink>,
    get_failures: Mutex<VecDeque<NameError>>,
    fail_gets: AtomicBool,
    fail_ensures: AtomicBool,
    gets: AtomicUsize,
    ensures: AtomicUsize,
}

impl FaultySink {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: RecordingSink::new(),
            get_failures: Mutex::new(VecDeque::new()),
            fail_gets: AtomicBool::new(false),
            fail_ensures: AtomicBool::new(false),
            gets: AtomicUsize::new(0),
            ensures: AtomicUsize::new(0),
        })
    }
}

impl SessionNaming for FaultySink {
    fn get(&self, refs: Vec<SessionNameRef>) -> NameFuture<Vec<SessionNameUpdate>> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        if self.fail_gets.load(Ordering::SeqCst) {
            return Box::pin(async { Err(NameError::Persistence("disk read failed".into())) });
        }
        if let Some(error) = self.get_failures.lock().unwrap().pop_front() {
            return Box::pin(async move { Err(error) });
        }
        self.inner.get(refs)
    }

    fn ensure_pending(&self, input: PendingNameInput) -> NameFuture<SessionNameUpdate> {
        self.ensures.fetch_add(1, Ordering::SeqCst);
        if self.fail_ensures.load(Ordering::SeqCst) {
            return Box::pin(async { Err(NameError::LockUnavailable("lock busy".into())) });
        }
        self.inner.ensure_pending(input)
    }

    fn bind_pending(&self, input: BindNameInput) -> NameFuture<SessionNameUpdate> {
        self.inner.bind_pending(input)
    }

    fn rename(&self, input: RenameNameInput) -> NameFuture<SessionNameUpdate> {
        self.inner.rename(input)
    }

    fn activity(&self, input: NameActivity) -> NameFuture<SessionNameUpdate> {
        self.inner.activity(input)
    }

    fn observe_native(&self, input: NativeNameObservation) -> NameFuture<SessionNameUpdate> {
        self.inner.observe_native(input)
    }

    fn record_acquisition(
        &self,
        target: SessionNameRef,
        acquisition: NativeAcquisition,
    ) -> NameFuture<SessionNameUpdate> {
        self.inner.record_acquisition(target, acquisition)
    }
}

/// A door's identity table: option-write bindings plus the durable session
/// each terminal is known to run.
#[derive(Default)]
struct FakeBinder {
    bindings: Mutex<HashMap<String, (SessionNameRef, Option<String>)>>,
    durable: Mutex<HashMap<String, (String, String)>>,
}

impl FakeBinder {
    fn binding(&self, terminal_id: &str) -> Option<(SessionNameRef, Option<String>)> {
        self.bindings.lock().unwrap().get(terminal_id).cloned()
    }
}

impl TerminalNameBinder for FakeBinder {
    fn set_name_binding(
        &self,
        terminal_id: &str,
        name_ref: &SessionNameRef,
        naming_handle: Option<&str>,
    ) {
        let mut bindings = self.bindings.lock().unwrap();
        let handle = naming_handle
            .map(str::to_string)
            .or_else(|| bindings.get(terminal_id).and_then(|(_, h)| h.clone()));
        bindings.insert(terminal_id.to_string(), (name_ref.clone(), handle));
    }

    fn name_ref_of(&self, terminal_id: &str) -> Option<SessionNameRef> {
        self.binding(terminal_id).map(|(name_ref, _)| name_ref)
    }

    fn naming_handle_of(&self, terminal_id: &str) -> Option<String> {
        self.binding(terminal_id).and_then(|(_, handle)| handle)
    }

    fn durable_session_of(&self, terminal_id: &str) -> Option<(String, String)> {
        self.durable.lock().unwrap().get(terminal_id).cloned()
    }
}

// ── helpers ──────────────────────────────────────────────────────────────

fn session(provider: NamedProvider, session_id: &str) -> SessionNameRef {
    SessionNameRef::Session {
        provider,
        session_id: session_id.to_string(),
    }
}

/// Seed a durable record named `name` through the public naming surface
/// (admit a handle, verify-bind it, then a user rename).
async fn seed(sink: &dyn SessionNaming, target: &SessionNameRef, name: &str) -> SessionNameRecord {
    let handle = format!("seed-{name}");
    let provider = match target {
        SessionNameRef::Session { provider, .. } => *provider,
        SessionNameRef::Pending { .. } => NamedProvider::Claude,
    };
    sink.ensure_pending(PendingNameInput {
        handle: handle.clone(),
        provider,
        cwd: None,
    })
    .await
    .unwrap();
    sink.bind_pending(BindNameInput {
        pending: SessionNameRef::Pending { id: handle },
        target: target.clone(),
        acquisition: verified_claude_acquisition("seed"),
    })
    .await
    .unwrap();
    sink.rename(RenameNameInput {
        target: target.clone(),
        name: name.to_string(),
        intent: NameIntent::User,
        if_revision: None,
    })
    .await
    .unwrap()
    .record
}

/// A row created long ago (well past the tick's create-path grace).
fn headless_row(registry: &TerminalRegistry, terminal_id: &str, mode: &str) {
    headless_row_created_at(registry, terminal_id, mode, Some(1_000));
}

fn headless_row_created_at(
    registry: &TerminalRegistry,
    terminal_id: &str,
    mode: &str,
    created_at: Option<i64>,
) {
    registry.register_headless(HeadlessTerminal {
        terminal_id: terminal_id.to_string(),
        stream_id: format!("S-{terminal_id}"),
        mode: mode.to_string(),
        resume_session_id: None,
        create_request_id: None,
        created_at,
    });
}

fn hint(mode: &str, resume: Option<&str>, handle: Option<&str>) -> NamingBindHint {
    NamingBindHint {
        mode: mode.to_string(),
        cwd: Some("/work/project".to_string()),
        resume_session_id: resume.map(str::to_string),
        naming_handle: handle.map(str::to_string),
        fallback_title: format!("{mode}-label"),
    }
}

fn label(mode: &str) -> String {
    format!("{mode}-label")
}

fn dyn_sink(sink: &Arc<FaultySink>) -> Option<Arc<dyn SessionNaming>> {
    Some(sink.clone() as Arc<dyn SessionNaming>)
}

// ── create / resume ──────────────────────────────────────────────────────

/// A resume create whose first read hits the busy document lock retries and
/// fills the row's cache with the durable session's saved name.
#[tokio::test(start_paused = true)]
async fn resume_create_retries_a_lock_error_and_fills_the_cache() {
    let sink = FaultySink::new();
    let durable = session(NamedProvider::Claude, "s-resume");
    seed(sink.as_ref(), &durable, "LotL").await;
    sink.get_failures
        .lock()
        .unwrap()
        .push_back(NameError::LockUnavailable("busy".into()));
    let registry = TerminalRegistry::new();
    headless_row(&registry, "T-resume", "claude");
    let binder = FakeBinder::default();
    let gets_before = sink.gets.load(Ordering::SeqCst);

    let outcome = bind_terminal_naming_from_identity(
        dyn_sink(&sink).as_ref(),
        &registry,
        &binder,
        "T-resume",
        hint("claude", Some("s-resume"), None),
    )
    .await;

    match &outcome {
        NamingBindOutcome::Bound { binding, record } => {
            assert_eq!(binding.name_ref, durable);
            assert_eq!(record.name, "LotL");
        }
        other => panic!("expected a bound outcome, got {other:?}"),
    }
    assert_eq!(
        sink.gets.load(Ordering::SeqCst) - gets_before,
        2,
        "one failed read, one retried read"
    );
    assert_eq!(
        registry.session_name_of("T-resume").map(|r| r.name),
        Some("LotL".to_string())
    );
    assert_eq!(registry.title_of("T-resume").as_deref(), Some("LotL"));
    assert_eq!(registry.name_ref_of("T-resume"), Some(durable.clone()));
    assert_eq!(binder.name_ref_of("T-resume"), Some(durable));
}

/// A resume create whose reads keep failing keeps its DURABLE binding (it
/// never falls into the fresh pending path, even with a persisted handle),
/// answers `Deferred`, and a later tick fills the cache.
#[tokio::test(start_paused = true)]
async fn resume_create_read_failure_never_falls_into_the_fresh_pending_path() {
    let sink = FaultySink::new();
    let durable = session(NamedProvider::Claude, "s-unreadable");
    seed(sink.as_ref(), &durable, "LotL").await;
    let ensures_before = sink.ensures.load(Ordering::SeqCst);
    sink.fail_gets.store(true, Ordering::SeqCst);
    let registry = TerminalRegistry::new();
    headless_row(&registry, "T-unreadable", "claude");
    let binder = FakeBinder::default();

    let outcome = bind_terminal_naming_from_identity(
        dyn_sink(&sink).as_ref(),
        &registry,
        &binder,
        "T-unreadable",
        hint("claude", Some("s-unreadable"), Some("nh-persisted")),
    )
    .await;

    match &outcome {
        NamingBindOutcome::Deferred { binding, .. } => {
            assert_eq!(binding.name_ref, durable);
        }
        other => panic!("expected a deferred outcome, got {other:?}"),
    }
    assert_eq!(
        sink.ensures.load(Ordering::SeqCst),
        ensures_before,
        "a read failure must never mint or ensure a pending record"
    );
    assert_eq!(registry.name_ref_of("T-unreadable"), Some(durable.clone()));
    assert_eq!(binder.name_ref_of("T-unreadable"), Some(durable));
    assert!(registry.session_name_of("T-unreadable").is_none());
    assert_eq!(
        registry.title_of("T-unreadable").as_deref(),
        Some("claude-label")
    );

    // The store recovers; the tick's empty-cache pass fills the row.
    sink.fail_gets.store(false, Ordering::SeqCst);
    reconcile_terminal_names(dyn_sink(&sink).as_ref(), &registry, &binder, &label).await;
    assert_eq!(
        registry.session_name_of("T-unreadable").map(|r| r.name),
        Some("LotL".to_string())
    );
    assert_eq!(registry.title_of("T-unreadable").as_deref(), Some("LotL"));
}

/// A fresh create whose `ensure_pending` keeps failing is still bound to the
/// pending ref (never left unbound); the tick's next pass creates the record.
#[tokio::test(start_paused = true)]
async fn ensure_pending_failure_keeps_a_pending_binding_for_the_tick() {
    let sink = FaultySink::new();
    sink.fail_ensures.store(true, Ordering::SeqCst);
    let registry = TerminalRegistry::new();
    headless_row(&registry, "T-fresh", "codex");
    let binder = FakeBinder::default();
    let pending = SessionNameRef::Pending { id: "nh-1".into() };

    let outcome = bind_terminal_naming_from_identity(
        dyn_sink(&sink).as_ref(),
        &registry,
        &binder,
        "T-fresh",
        hint("codex", None, Some("nh-1")),
    )
    .await;

    match &outcome {
        NamingBindOutcome::Deferred { binding, .. } => assert_eq!(
            binding,
            &NameBinding {
                name_ref: pending.clone(),
                naming_handle: Some("nh-1".into()),
            }
        ),
        other => panic!("expected a deferred outcome, got {other:?}"),
    }
    assert!(
        sink.ensures.load(Ordering::SeqCst) > 1,
        "ensure_pending is retried before deferring"
    );
    assert_eq!(registry.name_ref_of("T-fresh"), Some(pending.clone()));
    assert_eq!(
        binder.binding("T-fresh"),
        Some((pending.clone(), Some("nh-1".into())))
    );
    assert_eq!(registry.title_of("T-fresh").as_deref(), Some("codex-label"));

    sink.fail_ensures.store(false, Ordering::SeqCst);
    reconcile_terminal_names(dyn_sink(&sink).as_ref(), &registry, &binder, &label).await;
    let record = registry
        .session_name_of("T-fresh")
        .expect("the tick created and cached the pending record");
    assert_eq!(record.name_ref, pending);
    assert_eq!(
        record.name, "Codex",
        "the admitted fallback (a headless row has no folder, so the provider label)"
    );
    assert_eq!(registry.title_of("T-fresh").as_deref(), Some("Codex"));
}

/// A managed OpenCode soul's facade row binds through the helper: its title
/// becomes the saved name, and with no record it stays the mode label —
/// never "Shell".
#[tokio::test(start_paused = true)]
async fn register_managed_opencode_soul_binds_saved_name_and_mode_title() {
    let sink = FaultySink::new();
    let named = session(NamedProvider::Opencode, "ses_named");
    seed(sink.as_ref(), &named, "Survivor").await;
    let registry = TerminalRegistry::new();
    let binder = FakeBinder::default();
    for (terminal_id, session_id) in [("T-soul-named", "ses_named"), ("T-soul-new", "ses_new")] {
        registry.register_managed(
            ManagedTerminalDescriptor {
                soul_id: format!("soul-{terminal_id}"),
                incarnation_id: format!("incarnation-{terminal_id}"),
                terminal_id: terminal_id.to_string(),
                stream_id: format!("S-{terminal_id}"),
                mode: "opencode".into(),
                cwd: "/workspace".into(),
                resume_session_id: Some(session_id.into()),
                create_request_id: Some(format!("req-{terminal_id}")),
            },
            "OpenCode".to_string(),
        );
        let mut soul_hint = hint("opencode", Some(session_id), None);
        soul_hint.fallback_title = "OpenCode".into();
        bind_terminal_naming_from_identity(
            dyn_sink(&sink).as_ref(),
            &registry,
            &binder,
            terminal_id,
            soul_hint,
        )
        .await;
    }

    assert_eq!(
        registry.title_of("T-soul-named").as_deref(),
        Some("Survivor")
    );
    assert_eq!(registry.name_ref_of("T-soul-named"), Some(named));
    assert_eq!(
        registry.title_of("T-soul-new").as_deref(),
        Some("OpenCode"),
        "a soul with no record presents its mode label, never Shell"
    );
    assert_eq!(
        registry.name_ref_of("T-soul-new"),
        Some(session(NamedProvider::Opencode, "ses_new")),
        "a record-less durable session stays bound to its own ref"
    );
    assert!(registry.session_name_of("T-soul-new").is_none());
}

/// Out-of-scope modes and an unwired naming authority bind nothing.
#[tokio::test(start_paused = true)]
async fn unscoped_rows_and_unwired_naming_bind_nothing() {
    let sink = FaultySink::new();
    let registry = TerminalRegistry::new();
    headless_row(&registry, "T-shell", "shell");
    headless_row(&registry, "T-unwired", "claude");
    let binder = FakeBinder::default();

    let shell = bind_terminal_naming_from_identity(
        dyn_sink(&sink).as_ref(),
        &registry,
        &binder,
        "T-shell",
        hint("shell", None, None),
    )
    .await;
    let unwired = bind_terminal_naming_from_identity(
        None,
        &registry,
        &binder,
        "T-unwired",
        hint("claude", Some("s-1"), None),
    )
    .await;

    assert_eq!(shell, NamingBindOutcome::NotScoped);
    assert_eq!(unwired, NamingBindOutcome::NotScoped);
    assert!(registry.name_ref_of("T-shell").is_none());
    assert!(registry.name_ref_of("T-unwired").is_none());
    assert!(binder.binding("T-shell").is_none());
}

// ── the tick ─────────────────────────────────────────────────────────────

/// A scoped row that no create/adopt path bound gets a binding from the
/// tick: its door-known durable session when it has a record, else a
/// freshly admitted pending handle. Shell rows stay unbound.
#[tokio::test(start_paused = true)]
async fn tick_binds_a_scoped_row_with_no_ref() {
    let sink = FaultySink::new();
    let known = session(NamedProvider::Codex, "thread-known");
    seed(sink.as_ref(), &known, "Known thread").await;
    let registry = TerminalRegistry::new();
    headless_row(&registry, "T-orphan", "opencode");
    headless_row(&registry, "T-known", "codex");
    headless_row(&registry, "T-shell", "shell");
    let binder = FakeBinder::default();
    binder
        .durable
        .lock()
        .unwrap()
        .insert("T-known".into(), ("codex".into(), "thread-known".into()));

    reconcile_terminal_names(dyn_sink(&sink).as_ref(), &registry, &binder, &label).await;

    let (orphan_ref, orphan_handle) = binder
        .binding("T-orphan")
        .expect("the tick binds the orphan row");
    let handle = orphan_handle.expect("a pending binding retains its handle");
    assert_eq!(orphan_ref, SessionNameRef::Pending { id: handle });
    assert_eq!(registry.name_ref_of("T-orphan"), Some(orphan_ref));
    assert!(
        registry.session_name_of("T-orphan").is_some(),
        "the admitted fallback record is cached"
    );
    assert_eq!(registry.name_ref_of("T-known"), Some(known.clone()));
    assert_eq!(binder.name_ref_of("T-known"), Some(known));
    assert_eq!(
        registry.title_of("T-known").as_deref(),
        Some("Known thread")
    );
    assert!(registry.name_ref_of("T-shell").is_none());
    assert!(binder.binding("T-shell").is_none());
}

/// A row the tick sees mid-create (registered, its create path's naming
/// admission still in flight) is left to that create path: binding it here
/// would mint a handle that pre-empts the client's own `namingHandle`.
#[tokio::test(start_paused = true)]
async fn tick_leaves_a_just_created_row_to_its_create_path() {
    let sink = FaultySink::new();
    let registry = TerminalRegistry::new();
    headless_row_created_at(&registry, "T-creating", "claude", None);
    let binder = FakeBinder::default();

    let report =
        reconcile_terminal_names(dyn_sink(&sink).as_ref(), &registry, &binder, &label).await;

    assert_eq!(report.bound, 0);
    assert!(registry.name_ref_of("T-creating").is_none());
    assert!(binder.binding("T-creating").is_none());
    assert_eq!(
        sink.ensures.load(Ordering::SeqCst),
        0,
        "no handle was minted"
    );
}

/// Bound rows with an empty display cache are filled from their records.
#[tokio::test(start_paused = true)]
async fn tick_reconciles_bound_rows_with_empty_cache() {
    let sink = FaultySink::new();
    let durable = session(NamedProvider::Claude, "s-bound");
    seed(sink.as_ref(), &durable, "LotL").await;
    let registry = TerminalRegistry::new();
    headless_row(&registry, "T-bound", "claude");
    let binder = FakeBinder::default();
    binder.set_name_binding("T-bound", &durable, None);
    registry.set_naming("T-bound", Some(durable.clone()), None);
    assert!(registry.session_name_of("T-bound").is_none());

    reconcile_terminal_names(dyn_sink(&sink).as_ref(), &registry, &binder, &label).await;

    assert_eq!(
        registry.session_name_of("T-bound").map(|r| r.name),
        Some("LotL".to_string())
    );
    assert_eq!(registry.title_of("T-bound").as_deref(), Some("LotL"));
}

/// The tick's backstop for a binding move it did not see happen: the door's
/// identity table names a different session than the registry row, so the
/// row follows the identity and adopts that session's record — or, with no
/// record, drops the old session's cached name for the mode label.
#[tokio::test(start_paused = true)]
async fn tick_moves_a_row_whose_identity_ref_moved() {
    let sink = FaultySink::new();
    let old = session(NamedProvider::Claude, "s-old");
    let new_named = session(NamedProvider::Claude, "s-new-named");
    let new_bare = session(NamedProvider::Claude, "s-new-bare");
    let old_record = seed(sink.as_ref(), &old, "LotL").await;
    seed(sink.as_ref(), &new_named, "Billing bug").await;
    let registry = TerminalRegistry::new();
    let binder = FakeBinder::default();
    for (terminal_id, moved_to) in [("T-a", &new_named), ("T-b", &new_bare)] {
        headless_row(&registry, terminal_id, "claude");
        registry.set_naming(terminal_id, Some(old.clone()), None);
        registry.update_session_name(terminal_id, &old_record);
        binder.set_name_binding(terminal_id, moved_to, None);
    }

    reconcile_terminal_names(dyn_sink(&sink).as_ref(), &registry, &binder, &label).await;

    assert_eq!(registry.name_ref_of("T-a"), Some(new_named));
    assert_eq!(registry.title_of("T-a").as_deref(), Some("Billing bug"));
    assert_eq!(registry.name_ref_of("T-b"), Some(new_bare));
    assert!(registry.session_name_of("T-b").is_none());
    assert_eq!(registry.title_of("T-b").as_deref(), Some("claude-label"));
    let kept = sink.get(vec![old]).await.unwrap();
    assert_eq!(
        kept[0].record.name, "LotL",
        "the old session keeps its name"
    );
}

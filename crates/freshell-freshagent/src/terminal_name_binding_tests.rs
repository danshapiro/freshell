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
use tokio::sync::Notify;

use super::{
    bind_terminal_naming_from_identity, follow_identity_name_ref, managed_reused_session,
    reconcile_terminal_names, NameBinding, NamingBindHint, NamingBindOutcome, TerminalNameBinder,
    TerminalNamesTick,
};
use crate::naming::test_support::{verified_claude_acquisition, RecordingSink};
use crate::naming::{
    BindNameInput, NameActivity, NameError, NameFuture, NativeNameObservation, PendingNameInput,
    RenameNameInput, SessionNaming,
};

// ── fakes ────────────────────────────────────────────────────────────────

/// The recording sink with injectable store failures: each queued error is
/// answered by one call; `fail_*` makes every call fail until cleared. A
/// [`ReadGate`] holds one read's ANSWER in flight, so a test can interleave
/// a newer binding move (or a publisher write) between the store's answer and
/// the caller acting on it.
struct FaultySink {
    inner: Arc<RecordingSink>,
    get_failures: Mutex<VecDeque<NameError>>,
    fail_gets: AtomicBool,
    fail_ensures: AtomicBool,
    gets: AtomicUsize,
    ensures: AtomicUsize,
    gate: Mutex<Option<ReadGate>>,
    ensure_gate: Mutex<Option<ReadGate>>,
}

/// The first read that asks for `target` is answered by the store at once,
/// then held: `entered` fires, and the answer is returned only after
/// `release` fires.
struct ReadGate {
    target: SessionNameRef,
    entered: Arc<Notify>,
    release: Arc<Notify>,
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
            gate: Mutex::new(None),
            ensure_gate: Mutex::new(None),
        })
    }

    /// Hold the next `ensure_pending` of `handle` the same way (its answer is
    /// computed at once, then held until `release`).
    fn hold_next_ensure_of(&self, handle: &str) -> (Arc<Notify>, Arc<Notify>) {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        *self.ensure_gate.lock().unwrap() = Some(ReadGate {
            target: SessionNameRef::Pending {
                id: handle.to_string(),
            },
            entered: entered.clone(),
            release: release.clone(),
        });
        (entered, release)
    }

    /// Hold the next read of `target` (see [`ReadGate`]); answers the
    /// `(entered, release)` pair.
    fn hold_next_read_of(&self, target: &SessionNameRef) -> (Arc<Notify>, Arc<Notify>) {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        *self.gate.lock().unwrap() = Some(ReadGate {
            target: target.clone(),
            entered: entered.clone(),
            release: release.clone(),
        });
        (entered, release)
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
        let gate = {
            let mut gate = self.gate.lock().unwrap();
            if gate
                .as_ref()
                .is_some_and(|gate| refs.contains(&gate.target))
            {
                gate.take()
            } else {
                None
            }
        };
        let answer = self.inner.get(refs);
        match gate {
            Some(gate) => Box::pin(async move {
                let answer = answer.await;
                gate.entered.notify_one();
                gate.release.notified().await;
                answer
            }),
            None => answer,
        }
    }

    fn ensure_pending(&self, input: PendingNameInput) -> NameFuture<SessionNameUpdate> {
        self.ensures.fetch_add(1, Ordering::SeqCst);
        if self.fail_ensures.load(Ordering::SeqCst) {
            return Box::pin(async { Err(NameError::LockUnavailable("lock busy".into())) });
        }
        let pending = SessionNameRef::Pending {
            id: input.handle.clone(),
        };
        let gate = {
            let mut gate = self.ensure_gate.lock().unwrap();
            if gate.as_ref().is_some_and(|gate| gate.target == pending) {
                gate.take()
            } else {
                None
            }
        };
        let answer = self.inner.ensure_pending(input);
        match gate {
            Some(gate) => Box::pin(async move {
                let answer = answer.await;
                gate.entered.notify_one();
                gate.release.notified().await;
                answer
            }),
            None => answer,
        }
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
    reconcile_terminal_names(
        dyn_sink(&sink).as_ref(),
        &registry,
        &binder,
        &label,
        &TerminalNamesTick::default(),
    )
    .await;
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
    reconcile_terminal_names(
        dyn_sink(&sink).as_ref(),
        &registry,
        &binder,
        &label,
        &TerminalNamesTick::default(),
    )
    .await;
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

    reconcile_terminal_names(
        dyn_sink(&sink).as_ref(),
        &registry,
        &binder,
        &label,
        &TerminalNamesTick::default(),
    )
    .await;

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

    let report = reconcile_terminal_names(
        dyn_sink(&sink).as_ref(),
        &registry,
        &binder,
        &label,
        &TerminalNamesTick::default(),
    )
    .await;

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

    reconcile_terminal_names(
        dyn_sink(&sink).as_ref(),
        &registry,
        &binder,
        &label,
        &TerminalNamesTick::default(),
    )
    .await;

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

    reconcile_terminal_names(
        dyn_sink(&sink).as_ref(),
        &registry,
        &binder,
        &label,
        &TerminalNamesTick::default(),
    )
    .await;

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

// ── a read that a newer move superseded ──────────────────────────────────

/// A claude row bound (in both homes) to `bound_to`, with `cached` on it.
fn bound_row(
    registry: &TerminalRegistry,
    binder: &FakeBinder,
    terminal_id: &str,
    bound_to: &SessionNameRef,
    cached: Option<&SessionNameRecord>,
) {
    headless_row(registry, terminal_id, "claude");
    registry.set_naming(terminal_id, Some(bound_to.clone()), None);
    binder.set_name_binding(terminal_id, bound_to, None);
    if let Some(record) = cached {
        registry.update_session_name(terminal_id, record);
    }
}

/// Two quick switches A→B→C: B's read answers after C's follow finished.
/// The row stays bound to C and keeps C's record — B's late answer is
/// dropped instead of caching B's name on a row bound to C.
#[tokio::test(start_paused = true)]
async fn a_superseded_switch_read_never_overwrites_the_newer_binding() {
    let sink = FaultySink::new();
    let a = session(NamedProvider::Claude, "s-a");
    let b = session(NamedProvider::Claude, "s-b");
    let c = session(NamedProvider::Claude, "s-c");
    let a_record = seed(sink.as_ref(), &a, "LotL").await;
    seed(sink.as_ref(), &b, "Billing bug").await;
    seed(sink.as_ref(), &c, "Cache layer").await;
    let registry = TerminalRegistry::new();
    let binder = FakeBinder::default();
    bound_row(&registry, &binder, "T-switch", &a, Some(&a_record));
    binder.set_name_binding("T-switch", &b, None);
    let (entered, release) = sink.hold_next_read_of(&b);
    let naming = dyn_sink(&sink);

    let follow_b = follow_identity_name_ref(
        naming.as_ref(),
        &registry,
        &binder,
        "T-switch",
        "claude-label",
    );
    let switch_to_c = async {
        entered.notified().await; // B's answer is in flight
        binder.set_name_binding("T-switch", &c, None);
        let outcome = follow_identity_name_ref(
            naming.as_ref(),
            &registry,
            &binder,
            "T-switch",
            "claude-label",
        )
        .await;
        release.notify_one();
        outcome
    };
    let (b_outcome, c_outcome) = tokio::join!(follow_b, switch_to_c);

    assert!(
        matches!(c_outcome, Some(NamingBindOutcome::Bound { .. })),
        "{c_outcome:?}"
    );
    assert!(
        matches!(b_outcome, Some(NamingBindOutcome::Superseded { .. })),
        "the late answer reports that a newer move owns the row: {b_outcome:?}"
    );
    assert_eq!(registry.name_ref_of("T-switch"), Some(c.clone()));
    assert_eq!(
        registry.session_name_of("T-switch").map(|r| r.name),
        Some("Cache layer".to_string()),
        "the row bound to C must never cache B's record"
    );
    assert_eq!(
        registry.title_of("T-switch").as_deref(),
        Some("Cache layer")
    );
}

/// A resume create's read of its durable session answers after a
/// conversation switch moved the row on: the create drops that answer and
/// projects nothing, leaving the switch's record on the row.
#[tokio::test(start_paused = true)]
async fn a_create_read_superseded_by_a_switch_drops_its_record() {
    let sink = FaultySink::new();
    let b = session(NamedProvider::Claude, "s-b");
    let c = session(NamedProvider::Claude, "s-c");
    seed(sink.as_ref(), &b, "Billing bug").await;
    seed(sink.as_ref(), &c, "Cache layer").await;
    let registry = TerminalRegistry::new();
    headless_row(&registry, "T-create", "claude");
    let binder = FakeBinder::default();
    let (entered, release) = sink.hold_next_read_of(&b);
    let naming = dyn_sink(&sink);

    let create = bind_terminal_naming_from_identity(
        naming.as_ref(),
        &registry,
        &binder,
        "T-create",
        hint("claude", Some("s-b"), None),
    );
    let switch_to_c = async {
        entered.notified().await;
        binder.set_name_binding("T-create", &c, None);
        follow_identity_name_ref(
            naming.as_ref(),
            &registry,
            &binder,
            "T-create",
            "claude-label",
        )
        .await;
        release.notify_one();
    };
    let (created, ()) = tokio::join!(create, switch_to_c);

    assert!(
        matches!(created, NamingBindOutcome::Superseded { .. }),
        "{created:?}"
    );
    assert_eq!(
        created.projection(),
        None,
        "the created frame projects nothing stale"
    );
    assert_eq!(registry.name_ref_of("T-create"), Some(c.clone()));
    assert_eq!(binder.name_ref_of("T-create"), Some(c));
    assert_eq!(
        registry.session_name_of("T-create").map(|r| r.name),
        Some("Cache layer".to_string())
    );
    assert_eq!(
        registry.title_of("T-create").as_deref(),
        Some("Cache layer")
    );
}

/// A recovery create against a record-less durable session falls back to its
/// persisted pending handle; a conversation switch that lands while that
/// handle's admission is in flight keeps the row — the late admission never
/// re-binds it to the pending handle.
#[tokio::test(start_paused = true)]
async fn a_pending_fallback_superseded_by_a_switch_never_rebinds_the_row() {
    let sink = FaultySink::new();
    let c = session(NamedProvider::Claude, "s-c");
    seed(sink.as_ref(), &c, "Cache layer").await;
    let registry = TerminalRegistry::new();
    headless_row(&registry, "T-fallback", "claude");
    let binder = FakeBinder::default();
    let (entered, release) = sink.hold_next_ensure_of("nh-persisted");
    let naming = dyn_sink(&sink);

    let create = bind_terminal_naming_from_identity(
        naming.as_ref(),
        &registry,
        &binder,
        "T-fallback",
        hint("claude", Some("s-prospective"), Some("nh-persisted")),
    );
    // The switch's identity upsert lands during the admission; its
    // follow-up runs only after the admission answered.
    let switch_to_c = async {
        entered.notified().await;
        binder.set_name_binding("T-fallback", &c, None);
        release.notify_one();
    };
    let (created, ()) = tokio::join!(create, switch_to_c);
    follow_identity_name_ref(
        naming.as_ref(),
        &registry,
        &binder,
        "T-fallback",
        "claude-label",
    )
    .await;

    assert_eq!(registry.name_ref_of("T-fallback"), Some(c.clone()));
    assert_eq!(binder.name_ref_of("T-fallback"), Some(c));
    assert_eq!(
        registry.session_name_of("T-fallback").map(|r| r.name),
        Some("Cache layer".to_string())
    );
    assert!(
        matches!(created, NamingBindOutcome::Superseded { .. }),
        "{created:?}"
    );
}

/// Move `handle` onto `target` (a materialization's verified transfer) and
/// name the target `name`.
async fn spend_handle_onto(
    sink: &dyn SessionNaming,
    handle: &str,
    target: &SessionNameRef,
    name: &str,
) {
    sink.ensure_pending(PendingNameInput {
        handle: handle.to_string(),
        provider: NamedProvider::Codex,
        cwd: None,
    })
    .await
    .unwrap();
    sink.bind_pending(BindNameInput {
        pending: SessionNameRef::Pending {
            id: handle.to_string(),
        },
        target: target.clone(),
        acquisition: verified_claude_acquisition("spend"),
    })
    .await
    .unwrap();
    sink.rename(RenameNameInput {
        target: target.clone(),
        name: name.to_string(),
        intent: NameIntent::User,
        if_revision: None,
        cwd: None,
    })
    .await
    .unwrap();
}

/// A restore create for a record-less durable session T2 whose persisted
/// handle was already SPENT (moved onto T1 when T1 materialized) keeps the
/// row bound to T2: the handle now resolves to T1's record, and on this arm
/// that is always another session (a handle moved onto T2 itself would have
/// answered the durable read). The row shows the mode label; no record is
/// created or changed.
#[tokio::test(start_paused = true)]
async fn a_record_less_resume_target_never_binds_through_a_spent_handle() {
    let sink = FaultySink::new();
    let t1 = session(NamedProvider::Codex, "thread-T1");
    let t2 = session(NamedProvider::Codex, "thread-T2");
    spend_handle_onto(sink.as_ref(), "nh-spent", &t1, "First thread").await;
    let registry = TerminalRegistry::new();
    headless_row(&registry, "T-restore", "codex");
    let binder = FakeBinder::default();

    let outcome = bind_terminal_naming_from_identity(
        dyn_sink(&sink).as_ref(),
        &registry,
        &binder,
        "T-restore",
        hint("codex", Some("thread-T2"), Some("nh-spent")),
    )
    .await;

    assert_eq!(
        outcome,
        NamingBindOutcome::BoundNoRecord {
            binding: NameBinding {
                name_ref: t2.clone(),
                naming_handle: None,
            }
        }
    );
    assert_eq!(registry.name_ref_of("T-restore"), Some(t2.clone()));
    assert_eq!(binder.name_ref_of("T-restore"), Some(t2.clone()));
    assert!(
        registry.session_name_of("T-restore").is_none(),
        "the other session's name is never cached on the row"
    );
    assert_eq!(
        registry.title_of("T-restore").as_deref(),
        Some("codex-label")
    );
    let reads = sink.inner.get(vec![t1.clone(), t2]).await.unwrap();
    assert_eq!(reads.len(), 1, "no record was created for T2: {reads:?}");
    assert_eq!(reads[0].record.name_ref, t1);
    assert_eq!(reads[0].record.name, "First thread", "T1 is untouched");
}

/// The same arm with a STILL-pending persisted handle (a zero-turn pane whose
/// server restarted) takes the pending path: the row binds the handle's own
/// record, which the verified bind lane later transfers.
#[tokio::test(start_paused = true)]
async fn a_record_less_resume_target_rejoins_its_still_pending_handle() {
    let sink = FaultySink::new();
    let pending = SessionNameRef::Pending {
        id: "nh-zero-turn".into(),
    };
    sink.ensure_pending(PendingNameInput {
        handle: "nh-zero-turn".into(),
        provider: NamedProvider::Codex,
        cwd: None,
    })
    .await
    .unwrap();
    sink.rename(RenameNameInput {
        target: pending.clone(),
        name: "Billing".into(),
        intent: NameIntent::User,
        if_revision: None,
        cwd: None,
    })
    .await
    .unwrap();
    let registry = TerminalRegistry::new();
    headless_row(&registry, "T-zero-turn", "codex");
    let binder = FakeBinder::default();

    let outcome = bind_terminal_naming_from_identity(
        dyn_sink(&sink).as_ref(),
        &registry,
        &binder,
        "T-zero-turn",
        hint("codex", Some("thread-prospective"), Some("nh-zero-turn")),
    )
    .await;

    match &outcome {
        NamingBindOutcome::Bound { binding, record } => {
            assert_eq!(
                binding,
                &NameBinding {
                    name_ref: pending.clone(),
                    naming_handle: Some("nh-zero-turn".into()),
                }
            );
            assert_eq!(record.name, "Billing");
        }
        other => panic!("expected a pending binding, got {other:?}"),
    }
    assert_eq!(registry.name_ref_of("T-zero-turn"), Some(pending.clone()));
    assert_eq!(
        binder.binding("T-zero-turn"),
        Some((pending, Some("nh-zero-turn".into())))
    );
    assert_eq!(registry.title_of("T-zero-turn").as_deref(), Some("Billing"));
}

/// The same arm when the persisted handle moves onto the TARGET itself
/// between the durable read ("no record") and the pending admission (the
/// session materialized in between): the admission answers the target's own
/// record, so the row binds it.
#[tokio::test(start_paused = true)]
async fn a_record_less_resume_target_accepts_its_handle_moving_onto_it() {
    let sink = FaultySink::new();
    let target = session(NamedProvider::Codex, "thread-materializing");
    sink.ensure_pending(PendingNameInput {
        handle: "nh-moving".into(),
        provider: NamedProvider::Codex,
        cwd: None,
    })
    .await
    .unwrap();
    let registry = TerminalRegistry::new();
    headless_row(&registry, "T-moving", "codex");
    let binder = FakeBinder::default();
    let (entered, release) = sink.hold_next_read_of(&target);
    let naming = dyn_sink(&sink);

    let create = bind_terminal_naming_from_identity(
        naming.as_ref(),
        &registry,
        &binder,
        "T-moving",
        hint("codex", Some("thread-materializing"), Some("nh-moving")),
    );
    let materialize = async {
        entered.notified().await;
        spend_handle_onto(sink.inner.as_ref(), "nh-moving", &target, "Materialized").await;
        release.notify_one();
    };
    let (outcome, ()) = tokio::join!(create, materialize);

    match &outcome {
        NamingBindOutcome::Bound { binding, record } => {
            assert_eq!(binding.name_ref, target);
            assert_eq!(record.name, "Materialized");
        }
        other => panic!("expected the target's own record, got {other:?}"),
    }
    assert_eq!(registry.name_ref_of("T-moving"), Some(target.clone()));
    assert_eq!(binder.name_ref_of("T-moving"), Some(target));
    assert_eq!(
        registry.title_of("T-moving").as_deref(),
        Some("Materialized")
    );
}

/// A switch onto a session whose read answered "no record" keeps the record
/// the naming publisher wrote onto the row meanwhile (the session was named
/// between the store's answer and the follow acting on it) — only the OLD
/// session's cached name is dropped.
#[tokio::test(start_paused = true)]
async fn a_switch_to_a_bare_session_keeps_a_record_the_publisher_just_wrote() {
    let sink = FaultySink::new();
    let a = session(NamedProvider::Claude, "s-a");
    let c = session(NamedProvider::Claude, "s-c");
    let a_record = seed(sink.as_ref(), &a, "LotL").await;
    let registry = TerminalRegistry::new();
    let binder = FakeBinder::default();
    bound_row(&registry, &binder, "T-named", &a, Some(&a_record));
    binder.set_name_binding("T-named", &c, None);
    let (entered, release) = sink.hold_next_read_of(&c);
    let naming = dyn_sink(&sink);

    let follow_c = follow_identity_name_ref(
        naming.as_ref(),
        &registry,
        &binder,
        "T-named",
        "claude-label",
    );
    let publisher_names_c = async {
        entered.notified().await; // the read already answered "no record"
        let named = seed(sink.as_ref(), &c, "Fresh title").await;
        for terminal_id in registry.terminals_bound_to(&c) {
            registry.update_session_name(&terminal_id, &named);
        }
        release.notify_one();
    };
    tokio::join!(follow_c, publisher_names_c);

    assert_eq!(registry.name_ref_of("T-named"), Some(c));
    assert_eq!(
        registry.session_name_of("T-named").map(|r| r.name),
        Some("Fresh title".to_string()),
        "the publisher's record for the new session survives the follow"
    );
    assert_eq!(registry.title_of("T-named").as_deref(), Some("Fresh title"));
}

/// The tick's batched cache fill drops an answer for a row whose binding
/// moved while the read was in flight.
#[tokio::test(start_paused = true)]
async fn tick_fill_drops_an_answer_for_a_row_that_moved() {
    let sink = FaultySink::new();
    let b = session(NamedProvider::Claude, "s-b");
    let c = session(NamedProvider::Claude, "s-c");
    seed(sink.as_ref(), &b, "Billing bug").await;
    seed(sink.as_ref(), &c, "Cache layer").await;
    let registry = TerminalRegistry::new();
    let binder = FakeBinder::default();
    bound_row(&registry, &binder, "T-fill", &b, None);
    let (entered, release) = sink.hold_next_read_of(&b);
    let naming = dyn_sink(&sink);
    let tick = TerminalNamesTick::default();

    let fill = reconcile_terminal_names(naming.as_ref(), &registry, &binder, &label, &tick);
    let switch_to_c = async {
        entered.notified().await;
        binder.set_name_binding("T-fill", &c, None);
        follow_identity_name_ref(
            naming.as_ref(),
            &registry,
            &binder,
            "T-fill",
            "claude-label",
        )
        .await;
        release.notify_one();
    };
    let (report, ()) = tokio::join!(fill, switch_to_c);

    assert_eq!(report.filled, 0, "the stale answer fills nothing");
    assert_eq!(registry.name_ref_of("T-fill"), Some(c));
    assert_eq!(
        registry.session_name_of("T-fill").map(|r| r.name),
        Some("Cache layer".to_string())
    );
}

// ── the tick's cost bounds ───────────────────────────────────────────────

/// An exited row is never re-read for its empty cache: its process is gone,
/// and only the publisher (on a record commit) refreshes it from here on.
#[tokio::test(start_paused = true)]
async fn tick_never_reads_for_an_exited_rows_empty_cache() {
    let sink = FaultySink::new();
    let durable = session(NamedProvider::Opencode, "ses_exited");
    seed(sink.as_ref(), &durable, "Finished").await;
    let registry = TerminalRegistry::new();
    registry.register_managed(
        ManagedTerminalDescriptor {
            soul_id: "soul-exited".into(),
            incarnation_id: "incarnation-exited".into(),
            terminal_id: "T-exited".into(),
            stream_id: "S-exited".into(),
            mode: "opencode".into(),
            cwd: "/workspace".into(),
            resume_session_id: Some("ses_exited".into()),
            create_request_id: Some("req-exited".into()),
        },
        "OpenCode".to_string(),
    );
    registry.finish_managed_exit("T-exited", 0);
    let binder = FakeBinder::default();
    registry.set_naming("T-exited", Some(durable.clone()), None);
    binder.set_name_binding("T-exited", &durable, None);
    let gets_before = sink.gets.load(Ordering::SeqCst);
    let tick = TerminalNamesTick::default();

    for _ in 0..3 {
        reconcile_terminal_names(dyn_sink(&sink).as_ref(), &registry, &binder, &label, &tick).await;
    }

    assert_eq!(sink.gets.load(Ordering::SeqCst), gets_before);
    assert!(registry.session_name_of("T-exited").is_none());
}

/// A live row bound to a durable session that has no record yet is read on
/// a back-off (passes 1, 3, 7, … — doubling, capped), not on every 2 s pass:
/// the naming publisher fills the row the moment the session is named, so
/// the tick only backstops a missed push. A due re-check still fills it.
#[tokio::test(start_paused = true)]
async fn tick_backs_off_a_bound_session_that_has_no_record() {
    let sink = FaultySink::new();
    let bare = session(NamedProvider::Claude, "s-bare");
    let registry = TerminalRegistry::new();
    let binder = FakeBinder::default();
    bound_row(&registry, &binder, "T-bare", &bare, None);
    let tick = TerminalNamesTick::default();
    let mut reads_per_pass = Vec::new();

    for _ in 0..7 {
        let before = sink.gets.load(Ordering::SeqCst);
        reconcile_terminal_names(dyn_sink(&sink).as_ref(), &registry, &binder, &label, &tick).await;
        reads_per_pass.push(sink.gets.load(Ordering::SeqCst) - before);
    }
    assert_eq!(reads_per_pass, vec![1, 0, 1, 0, 0, 0, 1]);

    // The session is named but the push never reached the row: the next
    // due re-check (8 passes after the third miss) fills it.
    seed(sink.as_ref(), &bare, "Named later").await;
    let mut filled_on = None;
    for pass in 8..=15 {
        let report =
            reconcile_terminal_names(dyn_sink(&sink).as_ref(), &registry, &binder, &label, &tick)
                .await;
        if report.filled == 1 {
            filled_on = Some(pass);
            break;
        }
    }
    assert_eq!(filled_on, Some(15));
    assert_eq!(registry.title_of("T-bare").as_deref(), Some("Named later"));
}

/// A row rebound to another session leaves the back-off of its old binding
/// behind: the new binding is read on the very next pass.
#[tokio::test(start_paused = true)]
async fn tick_back_off_resets_when_the_binding_moves() {
    let sink = FaultySink::new();
    let first = session(NamedProvider::Claude, "s-first");
    let second = session(NamedProvider::Claude, "s-second");
    let registry = TerminalRegistry::new();
    let binder = FakeBinder::default();
    bound_row(&registry, &binder, "T-rebound", &first, None);
    let tick = TerminalNamesTick::default();
    reconcile_terminal_names(dyn_sink(&sink).as_ref(), &registry, &binder, &label, &tick).await;

    registry.set_naming("T-rebound", Some(second.clone()), None);
    binder.set_name_binding("T-rebound", &second, None);
    let before = sink.gets.load(Ordering::SeqCst);
    reconcile_terminal_names(dyn_sink(&sink).as_ref(), &registry, &binder, &label, &tick).await;

    assert_eq!(sink.gets.load(Ordering::SeqCst) - before, 1);
}

/// The tick binds an unbound row whose door-known session has NO record
/// through a pending handle — never to the bare session. The door's session
/// may be a fresh create's preallocated (prospective) id; only a pending
/// binding lets the verified bind lanes transfer the name at
/// materialization.
#[tokio::test(start_paused = true)]
async fn tick_binds_a_record_less_door_session_through_a_pending_handle() {
    let sink = FaultySink::new();
    let registry = TerminalRegistry::new();
    headless_row(&registry, "T-prealloc", "claude");
    let binder = FakeBinder::default();
    binder
        .durable
        .lock()
        .unwrap()
        .insert("T-prealloc".into(), ("claude".into(), "s-prealloc".into()));

    reconcile_terminal_names(
        dyn_sink(&sink).as_ref(),
        &registry,
        &binder,
        &label,
        &TerminalNamesTick::default(),
    )
    .await;

    let (bound, handle) = binder
        .binding("T-prealloc")
        .expect("the tick binds the row");
    let handle = handle.expect("a pending binding retains its handle");
    assert_eq!(bound, SessionNameRef::Pending { id: handle });
    assert_eq!(registry.name_ref_of("T-prealloc"), Some(bound));
    assert_eq!(
        sink.ensures.load(Ordering::SeqCst),
        1,
        "the pending record was admitted"
    );
    assert!(registry.session_name_of("T-prealloc").is_some());
}

// ── the managed descriptor's session ─────────────────────────────────────

/// The supervisor echoes a create's own launch session id into the managed
/// descriptor. A fresh Claude create's server-preallocated `--session-id` is
/// prospective, so it never counts as an established durable session; any
/// other descriptor session (an existing soul's, reused by a retried create)
/// does.
#[test]
fn a_managed_descriptor_names_a_durable_session_only_when_it_is_not_the_creates_own_preallocation()
{
    let registry = TerminalRegistry::new();
    registry.register_managed(
        ManagedTerminalDescriptor {
            soul_id: "soul-T-managed".into(),
            incarnation_id: "incarnation-T-managed".into(),
            terminal_id: "T-managed".into(),
            stream_id: "S-T-managed".into(),
            mode: "claude".into(),
            cwd: "/workspace".into(),
            resume_session_id: Some("s-echoed".into()),
            create_request_id: Some("req-T-managed".into()),
        },
        "Claude CLI".to_string(),
    );

    assert_eq!(
        managed_reused_session(&registry, "T-managed", Some("s-echoed")),
        None,
        "this create's own preallocation is prospective"
    );
    assert_eq!(
        managed_reused_session(&registry, "T-managed", Some("s-this-create")),
        Some("s-echoed".to_string()),
        "a reused soul's session differs from this create's preallocation"
    );
    assert_eq!(
        managed_reused_session(&registry, "T-managed", None),
        Some("s-echoed".to_string())
    );
    assert_eq!(managed_reused_session(&registry, "T-unknown", None), None);
}

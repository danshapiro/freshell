//! Name reliability (Task 10): one naming bind for every terminal row path.
//!
//! Every terminal row the server creates or adopts — the WebSocket and REST
//! creates, resume, auto-resume, managed register/reattach, compatibility
//! adoption — binds its saved name through [`bind_terminal_naming_from_identity`].
//! It resolves the naming target (the durable scoped session when the caller
//! knows one, else a pre-durable pending handle), writes the door's identity
//! binding and the registry binding together, then reads the record into the
//! row's display cache and title. A transient store failure is retried
//! (50 ms, 250 ms, 1 s) and then deferred to the 2 s tick with the binding
//! kept — a row is never left unbound, and "read failed" never falls into the
//! fresh pending path the way "no record" may.
//!
//! The core lives in this crate so both doors can call it: `freshell-ws`
//! depends on `freshell-freshagent`, never the reverse, so each door bridges
//! its own identity table in through [`TerminalNameBinder`] (the
//! `identity_sink.rs` trait precedent).
//!
//! [`follow_identity_name_ref`] is the conversation-switch arm: when a door's
//! identity table moves a terminal onto a new durable session (Claude's
//! `/clear`, an OpenCode switch, a new Codex thread), the registry binding
//! follows and the row adopts the NEW session's record — or, with none yet,
//! drops the old session's cached name for the mode label. The switch never
//! creates or changes a record. [`reconcile_terminal_names`] is the tick:
//! it backstops moves no caller reported, binds scoped rows that have no
//! binding, and fills live bound rows whose cache is empty.
//!
//! Every read here is awaited after the binding it serves was written, and a
//! newer move (a quick second switch, a switch during a create) can land
//! while it is in flight. An answer is therefore applied only while the row
//! is still bound to the ref that was read; otherwise it is dropped
//! ([`NamingBindOutcome::Superseded`]) and the newer move owns the row.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use freshell_protocol::session_names::{NamedProvider, SessionNameRecord, SessionNameRef};
use freshell_terminal::TerminalRegistry;

use crate::naming::{
    log_name_error, name_ref_debug_key, named_provider_for, NameError, PendingNameInput,
    SessionNaming,
};

#[path = "terminal_name_cache.rs"]
mod cache;
use cache::{answers, fill_uncached_rows, UncachedRow};

/// The bounded retry schedule for a transient store failure: each delay
/// precedes one more attempt, so a persistently busy store costs at most
/// ~1.3 s before the bind defers to the tick.
const BIND_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_millis(50),
    Duration::from_millis(250),
    Duration::from_millis(1000),
];

/// How long a scoped row with no binding is left to its own create path
/// before the tick binds it. A row is visible in the registry from its spawn,
/// a beat before the create's naming admission (ledger writes and the
/// ownership settle run in between); binding it from the tick inside that
/// window would mint a handle that pre-empts the client's own `namingHandle`.
const UNBOUND_ROW_GRACE_MS: i64 = 30_000;

/// The longest back-off, in tick passes (~64 s at the 2 s cadence), before a
/// live row bound to a record-less durable session is read again.
const EMPTY_ANSWER_MAX_SKIP_PASSES: u64 = 32;

/// A door's identity table, as the naming bind needs it. The WebSocket door
/// implements it over `freshell-ws`'s identity registry; the REST door over
/// the same registry through its injected binder plus its own handle stash.
pub trait TerminalNameBinder: Send + Sync {
    /// Record the terminal's naming binding. Option-write for the handle:
    /// `None` keeps the handle already retained.
    fn set_name_binding(
        &self,
        terminal_id: &str,
        name_ref: &SessionNameRef,
        naming_handle: Option<&str>,
    );
    /// The naming ref the identity table holds for this terminal.
    fn name_ref_of(&self, terminal_id: &str) -> Option<SessionNameRef>;
    /// The pre-durable handle the identity table retains for this terminal.
    fn naming_handle_of(&self, terminal_id: &str) -> Option<String>;
    /// The durable `(provider, session id)` the door knows for this terminal.
    fn durable_session_of(&self, terminal_id: &str) -> Option<(String, String)>;
}

/// What the caller knows about the row it is binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamingBindHint {
    /// The terminal mode (`claude`, `codex`, `opencode`, …); out-of-scope
    /// modes bind nothing.
    pub mode: String,
    /// The row's folder (the pending record's directory-name fallback).
    pub cwd: Option<String>,
    /// An ESTABLISHED durable session id (a resume's sessionRef, a managed
    /// soul's native id, an auto-resume target). Never a prospective id.
    pub resume_session_id: Option<String>,
    /// A persisted or client-sent pre-durable handle. Only a persisted handle
    /// lets a record-less durable session fall back to the pending path.
    pub naming_handle: Option<String>,
    /// The row title when no saved name is known (the mode label).
    pub fallback_title: String,
}

/// The binding a row ended up with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameBinding {
    pub name_ref: SessionNameRef,
    /// The pending handle the row retains (the pending path only).
    pub naming_handle: Option<String>,
}

/// How a bind ended.
#[derive(Debug, Clone, PartialEq)]
pub enum NamingBindOutcome {
    /// Bound, and the saved record is cached on the row.
    Bound {
        binding: NameBinding,
        record: SessionNameRecord,
    },
    /// Bound to a durable session that has no record yet; the row shows the
    /// fallback title until the normal naming paths create one.
    BoundNoRecord { binding: NameBinding },
    /// Out of naming scope, or no naming authority is wired.
    NotScoped,
    /// Bound, but the store stayed unavailable through the bounded retry;
    /// the tick fills the cache (or admits the pending record) later.
    Deferred {
        binding: NameBinding,
        reason: String,
    },
    /// Bound, but a newer move retargeted the row while this bind's read was
    /// in flight; the read's answer was dropped and the newer move owns the
    /// row's binding and cache.
    Superseded { binding: NameBinding },
}

impl NamingBindOutcome {
    /// The row's binding, when it has one.
    pub fn binding(&self) -> Option<&NameBinding> {
        match self {
            Self::Bound { binding, .. }
            | Self::BoundNoRecord { binding }
            | Self::Deferred { binding, .. }
            | Self::Superseded { binding } => Some(binding),
            Self::NotScoped => None,
        }
    }

    /// The `nameRef` + `sessionName` frame projection, when a record is known.
    pub fn projection(&self) -> Option<(SessionNameRef, SessionNameRecord)> {
        match self {
            Self::Bound { record, .. } => Some((record.name_ref.clone(), record.clone())),
            _ => None,
        }
    }
}

/// Bind a terminal row's saved name (see the module doc). A row the registry
/// already holds a binding for keeps it — re-adopting an existing facade
/// never re-targets its name — and only has its cache refreshed.
pub async fn bind_terminal_naming_from_identity(
    sink: Option<&Arc<dyn SessionNaming>>,
    registry: &TerminalRegistry,
    binder: &dyn TerminalNameBinder,
    terminal_id: &str,
    hint: NamingBindHint,
) -> NamingBindOutcome {
    let Some(provider) = named_provider_for(Some(hint.mode.as_str()), None) else {
        return NamingBindOutcome::NotScoped;
    };
    let Some(sink) = sink else {
        return NamingBindOutcome::NotScoped;
    };
    if let Some(existing) = registry.name_ref_of(terminal_id) {
        return refresh_existing_binding(
            sink.as_ref(),
            registry,
            binder,
            terminal_id,
            existing,
            &hint,
        )
        .await;
    }
    let durable = hint
        .resume_session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|session_id| SessionNameRef::Session {
            provider,
            session_id: session_id.to_string(),
        });
    if let Some(target) = durable {
        let binding = NameBinding {
            name_ref: target.clone(),
            naming_handle: None,
        };
        apply_binding(registry, binder, terminal_id, &binding);
        let answer = read_record(sink.as_ref(), &target).await;
        if !still_bound(registry, terminal_id, &target) {
            return superseded(terminal_id, binding);
        }
        match answer {
            Ok(Some(record)) => {
                registry.update_session_name(terminal_id, &record);
                log_bound(terminal_id, &binding, "durable");
                return NamingBindOutcome::Bound { binding, record };
            }
            Ok(None) => {
                // A recovery create against a PROSPECTIVE (record-less)
                // session — a zero-turn pane whose server restarted — must
                // re-stamp the PERSISTED pre-durable handle: only a pending
                // binding lets the verified bind transfer the record once the
                // transcript materializes. Without a persisted handle the
                // durable binding stands, unnamed until the normal paths name
                // the session — and so it does when the handle turns out to
                // be spent on another session (see `bind_pending_path`).
                let Some(handle) = persisted_handle(&hint).map(str::to_string) else {
                    present_unnamed(registry, terminal_id, &target, &hint.fallback_title);
                    log_bound(terminal_id, &binding, "durable_no_record");
                    return NamingBindOutcome::BoundNoRecord { binding };
                };
                return bind_pending_path(
                    sink.as_ref(),
                    registry,
                    binder,
                    terminal_id,
                    provider,
                    handle,
                    Some(&target),
                    &hint,
                )
                .await;
            }
            Err(error) => {
                // "Read failed" is not "no record": the durable binding is
                // kept and NEVER replaced by the fresh pending path (that
                // would orphan the session's saved name behind a new handle).
                present_unnamed(registry, terminal_id, &target, &hint.fallback_title);
                return deferred(terminal_id, binding, &error);
            }
        }
    }
    let handle = persisted_handle(&hint)
        .map(str::to_string)
        .unwrap_or_else(mint_naming_handle);
    bind_pending_path(
        sink.as_ref(),
        registry,
        binder,
        terminal_id,
        provider,
        handle,
        None,
        &hint,
    )
    .await
}

/// The conversation-switch arm: the door's identity table moved this
/// terminal onto a new naming ref, so the registry binding follows it and
/// the row adopts THAT ref's record. With no record, the row drops the old
/// session's cached name and shows `fallback_title`; the normal naming paths
/// name the new session later (the publisher refreshes every row bound to
/// it). `None` when nothing moved. Creates and changes no record.
pub async fn follow_identity_name_ref(
    sink: Option<&Arc<dyn SessionNaming>>,
    registry: &TerminalRegistry,
    binder: &dyn TerminalNameBinder,
    terminal_id: &str,
    fallback_title: &str,
) -> Option<NamingBindOutcome> {
    let sink = sink?;
    let moved_to = binder.name_ref_of(terminal_id)?;
    let moved_from = registry.name_ref_of(terminal_id);
    if moved_from.as_ref() == Some(&moved_to) || !registry.exists(terminal_id) {
        return None;
    }
    registry.set_naming(terminal_id, Some(moved_to.clone()), None);
    let binding = NameBinding {
        name_ref: moved_to.clone(),
        naming_handle: binder.naming_handle_of(terminal_id),
    };
    let answer = read_record(sink.as_ref(), &moved_to).await;
    if !still_bound(registry, terminal_id, &moved_to) {
        return Some(superseded(terminal_id, binding));
    }
    let outcome = match answer {
        Ok(Some(record)) => {
            registry.update_session_name(terminal_id, &record);
            NamingBindOutcome::Bound { binding, record }
        }
        Ok(None) => {
            present_unnamed(registry, terminal_id, &moved_to, fallback_title);
            NamingBindOutcome::BoundNoRecord { binding }
        }
        Err(error) => {
            // The old session's name must not keep showing on the moved row.
            present_unnamed(registry, terminal_id, &moved_to, fallback_title);
            deferred(terminal_id, binding, &error)
        }
    };
    tracing::info!(
        target: "freshell_freshagent::naming",
        terminal_id = %terminal_id,
        from = %moved_from
            .as_ref()
            .map(name_ref_debug_key)
            .unwrap_or_else(|| "-".to_string()),
        to = %name_ref_debug_key(&moved_to),
        has_record = matches!(outcome, NamingBindOutcome::Bound { .. }),
        "session_names.terminal_binding_moved"
    );
    Some(outcome)
}

/// The established durable session a managed create's supervisor answered
/// with: an existing soul's native session (a retried create reusing the
/// running soul after a web restart). The supervisor otherwise echoes the
/// create's OWN launch id, so `preallocated_session_id` — this create's
/// server-preallocated `--session-id`, prospective until its transcript
/// exists — is never answered as durable: a record-less durable binding
/// would leave no pending record for the verified bind lane to transfer.
pub fn managed_reused_session(
    registry: &TerminalRegistry,
    terminal_id: &str,
    preallocated_session_id: Option<&str>,
) -> Option<String> {
    registry
        .managed_descriptor(terminal_id)
        .and_then(|descriptor| descriptor.resume_session_id)
        .filter(|session_id| Some(session_id.as_str()) != preallocated_session_id)
}

/// The REST door's identity table: its own create-lane handle stash (the
/// pane rename resolver's last fallback) plus the shared identity table
/// `freshell-server` injects (the same one the WebSocket door binds).
pub(crate) struct RestDoorBinder<'a> {
    state: &'a crate::FreshAgentState,
}

impl TerminalNameBinder for RestDoorBinder<'_> {
    fn set_name_binding(
        &self,
        terminal_id: &str,
        name_ref: &SessionNameRef,
        naming_handle: Option<&str>,
    ) {
        if let Some(handle) = naming_handle {
            self.state.stash_naming_handle(terminal_id, handle);
        }
        if let Some(door) = self.state.terminal_name_binder.as_ref() {
            door.set_name_binding(terminal_id, name_ref, naming_handle);
        }
    }

    fn name_ref_of(&self, terminal_id: &str) -> Option<SessionNameRef> {
        self.state
            .terminal_name_binder
            .as_ref()
            .and_then(|door| door.name_ref_of(terminal_id))
    }

    fn naming_handle_of(&self, terminal_id: &str) -> Option<String> {
        self.state
            .terminal_name_binder
            .as_ref()
            .and_then(|door| door.naming_handle_of(terminal_id))
            .or_else(|| self.state.peek_naming_handle(terminal_id))
    }

    fn durable_session_of(&self, terminal_id: &str) -> Option<(String, String)> {
        self.state
            .terminal_name_binder
            .as_ref()
            .and_then(|door| door.durable_session_of(terminal_id))
    }
}

/// Bind one REST-created terminal row through the shared helper.
pub(crate) async fn bind_rest_terminal_naming(
    state: &crate::FreshAgentState,
    registry: &TerminalRegistry,
    terminal_id: &str,
    hint: NamingBindHint,
) -> NamingBindOutcome {
    let sink = state.naming();
    let binder = RestDoorBinder { state };
    bind_terminal_naming_from_identity(sink.as_ref(), registry, &binder, terminal_id, hint).await
}

/// What one tick pass did (for the tick's own structured log).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TerminalNamesReconcile {
    /// Rows whose registry binding followed a moved identity ref.
    pub moved: usize,
    /// Scoped rows that had no binding and got one.
    pub bound: usize,
    /// Bound rows whose empty cache was filled.
    pub filled: usize,
}

/// The tick's memory across passes: the per-row back-off for live rows bound
/// to a durable session that answered "no record". The naming publisher
/// fills such a row the moment the session is named (it refreshes every row
/// bound to a committed record), so the tick only backstops a missed push:
/// re-reading every 2 s would cost one locked document read per pass for as
/// long as the session stays unnamed. After the n-th consecutive empty
/// answer the row is skipped for 2^n passes (capped at
/// [`EMPTY_ANSWER_MAX_SKIP_PASSES`]); a binding move resets it.
#[derive(Debug, Default)]
pub struct TerminalNamesTick {
    state: Mutex<TickMemory>,
}

#[derive(Debug, Default)]
struct TickMemory {
    pass: u64,
    empty_answers: HashMap<String, EmptyAnswer>,
}

#[derive(Debug)]
struct EmptyAnswer {
    name_ref: SessionNameRef,
    misses: u32,
    next_pass: u64,
}

impl TerminalNamesTick {
    fn begin_pass(&self) -> u64 {
        let mut memory = self.state.lock().expect("terminal names tick lock");
        memory.pass += 1;
        memory.pass
    }

    /// Whether this row's empty-cache read waits out its back-off this pass.
    fn backing_off(&self, terminal_id: &str, name_ref: &SessionNameRef, pass: u64) -> bool {
        self.state
            .lock()
            .expect("terminal names tick lock")
            .empty_answers
            .get(terminal_id)
            .is_some_and(|miss| &miss.name_ref == name_ref && pass < miss.next_pass)
    }

    /// Fold this pass's read outcomes in: `empty` rows (durable, no record)
    /// extend their back-off; every other memory not `waiting` this pass
    /// (filled, moved, exited, gone) is forgotten.
    fn settle_pass(
        &self,
        pass: u64,
        empty: &[(String, SessionNameRef)],
        waiting: &HashSet<String>,
    ) {
        let mut memory = self.state.lock().expect("terminal names tick lock");
        let mut next: HashMap<String, EmptyAnswer> = HashMap::new();
        for (terminal_id, name_ref) in empty {
            let misses = memory
                .empty_answers
                .get(terminal_id)
                .filter(|miss| &miss.name_ref == name_ref)
                .map_or(1, |miss| miss.misses.saturating_add(1));
            let skip = 2u64
                .saturating_pow(misses)
                .min(EMPTY_ANSWER_MAX_SKIP_PASSES);
            next.insert(
                terminal_id.clone(),
                EmptyAnswer {
                    name_ref: name_ref.clone(),
                    misses,
                    next_pass: pass + skip,
                },
            );
        }
        for (terminal_id, miss) in memory.empty_answers.drain() {
            if waiting.contains(&terminal_id) && !next.contains_key(&terminal_id) {
                next.insert(terminal_id, miss);
            }
        }
        memory.empty_answers = next;
    }
}

/// The 2 s tick's terminal-naming reconcile (see the module doc). Bounded:
/// one batched read for the uncached live rows not backing off, plus at most
/// one bind per row that has no binding at all. `label_for` maps a mode to
/// its row title; `tick` carries the back-off between passes.
pub async fn reconcile_terminal_names(
    sink: Option<&Arc<dyn SessionNaming>>,
    registry: &TerminalRegistry,
    binder: &dyn TerminalNameBinder,
    label_for: &(dyn Fn(&str) -> String + Sync),
    tick: &TerminalNamesTick,
) -> TerminalNamesReconcile {
    let mut report = TerminalNamesReconcile::default();
    let Some(sink) = sink else {
        return report;
    };
    let pass = tick.begin_pass();
    let mut uncached: Vec<UncachedRow> = Vec::new();
    let mut waiting: HashSet<String> = HashSet::new();
    for row in registry.identity_probe_rows() {
        let Some(provider) = named_provider_for(Some(row.mode.as_str()), None) else {
            continue;
        };
        let terminal_id = row.terminal_id.as_str();
        let identity_ref = binder.name_ref_of(terminal_id);
        let registry_ref = registry.name_ref_of(terminal_id);
        let bound = match (identity_ref, registry_ref) {
            (Some(identity_ref), Some(registry_ref)) if identity_ref == registry_ref => {
                identity_ref
            }
            (Some(_), _) => {
                if follow_identity_name_ref(
                    Some(sink),
                    registry,
                    binder,
                    terminal_id,
                    &label_for(&row.mode),
                )
                .await
                .is_some()
                {
                    report.moved += 1;
                }
                continue;
            }
            (None, Some(registry_ref)) => {
                // Keep both homes consistent: the rename resolvers read the
                // identity table.
                binder.set_name_binding(terminal_id, &registry_ref, None);
                registry_ref
            }
            (None, None) => {
                if row.status != freshell_protocol::TerminalRunStatus::Running {
                    continue; // an exited row is never minted a new record
                }
                if now_ms().saturating_sub(row.created_at) < UNBOUND_ROW_GRACE_MS {
                    continue; // still inside its create path's admission window
                }
                let durable = binder
                    .durable_session_of(terminal_id)
                    .filter(|(door_provider, _)| door_provider.as_str() == provider.as_str())
                    .map(|(_, session_id)| session_id);
                // The door's session binds directly only when it has a
                // record: it may be a fresh create's server-preallocated
                // (prospective) id, and only a pending binding lets the
                // verified bind lanes transfer the name at materialization.
                // A handle is therefore always supplied, so a record-less
                // session takes the pending path.
                let hint = NamingBindHint {
                    mode: row.mode.clone(),
                    cwd: row.cwd.clone(),
                    resume_session_id: durable,
                    naming_handle: Some(
                        binder
                            .naming_handle_of(terminal_id)
                            .unwrap_or_else(mint_naming_handle),
                    ),
                    fallback_title: label_for(&row.mode),
                };
                let outcome = bind_terminal_naming_from_identity(
                    Some(sink),
                    registry,
                    binder,
                    terminal_id,
                    hint,
                )
                .await;
                tracing::info!(
                    target: "freshell_freshagent::naming",
                    terminal_id = %terminal_id,
                    name_ref = %outcome
                        .binding()
                        .map(|binding| name_ref_debug_key(&binding.name_ref))
                        .unwrap_or_else(|| "-".to_string()),
                    "session_names.terminal_binding_reconciled: bound a scoped row that had no binding"
                );
                report.bound += 1;
                continue;
            }
        };
        // An exited row is never re-read: only the publisher (on a record
        // commit) refreshes it from here on.
        if row.status != freshell_protocol::TerminalRunStatus::Running
            || registry.session_name_of(terminal_id).is_some()
        {
            continue;
        }
        if tick.backing_off(terminal_id, &bound, pass) {
            waiting.insert(row.terminal_id.clone());
            continue;
        }
        uncached.push(UncachedRow {
            terminal_id: row.terminal_id.clone(),
            provider,
            cwd: row.cwd.clone(),
            name_ref: bound,
            durable_target: binder.durable_session_of(terminal_id).and_then(
                |(provider, session_id)| {
                    named_provider_for(Some(&provider), None).map(|provider| {
                        SessionNameRef::Session {
                            provider,
                            session_id,
                        }
                    })
                },
            ),
            fallback_title: label_for(&row.mode),
        });
    }
    let fill = fill_uncached_rows(sink.as_ref(), registry, binder, &uncached).await;
    tick.settle_pass(pass, &fill.empty, &waiting);
    report.filled = fill.filled;
    report
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// A row already bound keeps its binding; its identity home is re-stamped
/// and its cache refreshed (a compatibility re-adoption of a live facade).
async fn refresh_existing_binding(
    sink: &dyn SessionNaming,
    registry: &TerminalRegistry,
    binder: &dyn TerminalNameBinder,
    terminal_id: &str,
    existing: SessionNameRef,
    hint: &NamingBindHint,
) -> NamingBindOutcome {
    let binding = NameBinding {
        name_ref: existing.clone(),
        naming_handle: binder.naming_handle_of(terminal_id),
    };
    binder.set_name_binding(terminal_id, &existing, None);
    let answer = read_record(sink, &existing).await;
    if !still_bound(registry, terminal_id, &existing) {
        return superseded(terminal_id, binding);
    }
    match answer {
        Ok(Some(record)) => {
            registry.update_session_name(terminal_id, &record);
            NamingBindOutcome::Bound { binding, record }
        }
        Ok(None) => {
            if registry.session_name_of(terminal_id).is_none() {
                registry.set_meta(
                    terminal_id,
                    Some(hint.fallback_title.clone()),
                    None,
                    None,
                    None,
                );
            }
            NamingBindOutcome::BoundNoRecord { binding }
        }
        Err(error) => deferred(terminal_id, binding, &error),
    }
}

/// Admit (or re-resolve) the pending record for `handle` and bind the row
/// to it. On a persistent store failure the row is STILL bound to the
/// pending ref, so the tick can admit the record later. A row whose binding
/// moved while the admission was in flight (a switch onto a new session) is
/// left to that move.
///
/// `record_less_target` is the durable session this bind first targeted when
/// its read answered "no record" (a recovery create's fallback to the
/// persisted handle). Then only the handle's OWN record, or the target's,
/// is accepted: a handle the store resolves to any other session was spent
/// on an earlier conversation, and binding it would show (and rename) that
/// session's name on this row. The row keeps the durable binding instead.
#[allow(clippy::too_many_arguments)]
async fn bind_pending_path(
    sink: &dyn SessionNaming,
    registry: &TerminalRegistry,
    binder: &dyn TerminalNameBinder,
    terminal_id: &str,
    provider: NamedProvider,
    handle: String,
    record_less_target: Option<&SessionNameRef>,
    hint: &NamingBindHint,
) -> NamingBindOutcome {
    let input = PendingNameInput {
        handle: handle.clone(),
        provider,
        cwd: hint.cwd.clone(),
    };
    let pending = SessionNameRef::Pending { id: handle.clone() };
    // Both homes: a switch retargets the identity table first and the
    // registry row only on its follow-up.
    let bound_before = (
        registry.name_ref_of(terminal_id),
        binder.name_ref_of(terminal_id),
    );
    let mut attempt = 0;
    let admitted = loop {
        match sink.ensure_pending(input.clone()).await {
            Ok(update) => break Ok(update),
            Err(error) if is_transient(&error) && attempt < BIND_RETRY_DELAYS.len() => {
                log_retry("ensure_pending", &pending, &error, attempt);
                tokio::time::sleep(BIND_RETRY_DELAYS[attempt]).await;
                attempt += 1;
            }
            Err(error) => break Err(error),
        }
    };
    if (
        registry.name_ref_of(terminal_id),
        binder.name_ref_of(terminal_id),
    ) != bound_before
    {
        return superseded(
            terminal_id,
            NameBinding {
                name_ref: pending,
                naming_handle: Some(handle),
            },
        );
    }
    match admitted {
        Ok(update) => {
            if let Some(target) = record_less_target.filter(|target| {
                update.record.name_ref != pending && &update.record.name_ref != *target
            }) {
                return keep_record_less_target(
                    registry,
                    terminal_id,
                    target,
                    &pending,
                    &update.record.name_ref,
                    &hint.fallback_title,
                );
            }
            // `ensure_pending` resolves a handle already bound to a durable
            // session onto that session's record; the row follows it.
            let binding = NameBinding {
                name_ref: update.record.name_ref.clone(),
                naming_handle: Some(handle),
            };
            apply_binding(registry, binder, terminal_id, &binding);
            registry.update_session_name(terminal_id, &update.record);
            log_bound(terminal_id, &binding, "pending");
            NamingBindOutcome::Bound {
                binding,
                record: update.record,
            }
        }
        Err(error) => {
            log_name_error("ensure_pending", &pending, &error);
            let binding = NameBinding {
                name_ref: pending,
                naming_handle: Some(handle),
            };
            apply_binding(registry, binder, terminal_id, &binding);
            registry.set_meta(
                terminal_id,
                Some(hint.fallback_title.clone()),
                None,
                None,
                None,
            );
            deferred(terminal_id, binding, &error)
        }
    }
}

/// The recovery fallback's persisted handle was spent on another session:
/// the row stays on its record-less durable target (both homes already hold
/// it — the caller checked nothing moved) and presents `fallback_title`
/// until the normal naming paths name the target.
fn keep_record_less_target(
    registry: &TerminalRegistry,
    terminal_id: &str,
    target: &SessionNameRef,
    spent: &SessionNameRef,
    resolved_to: &SessionNameRef,
    fallback_title: &str,
) -> NamingBindOutcome {
    present_unnamed(registry, terminal_id, target, fallback_title);
    tracing::info!(
        target: "freshell_freshagent::naming",
        terminal_id = %terminal_id,
        name_ref = %name_ref_debug_key(target),
        handle = %name_ref_debug_key(spent),
        resolved_to = %name_ref_debug_key(resolved_to),
        "session_names.terminal_binding_spent_handle: the persisted handle names another session; the row keeps its own"
    );
    NamingBindOutcome::BoundNoRecord {
        binding: NameBinding {
            name_ref: target.clone(),
            naming_handle: None,
        },
    }
}

/// Read one ref's record with the bounded retry; `Ok(None)` = no record.
async fn read_record(
    sink: &dyn SessionNaming,
    target: &SessionNameRef,
) -> Result<Option<SessionNameRecord>, NameError> {
    let mut attempt = 0;
    loop {
        match sink.get(vec![target.clone()]).await {
            Ok(updates) => {
                return Ok(updates
                    .into_iter()
                    .find(|update| answers(update, target))
                    .map(|update| update.record))
            }
            Err(error) if is_transient(&error) && attempt < BIND_RETRY_DELAYS.len() => {
                log_retry("get", target, &error, attempt);
                tokio::time::sleep(BIND_RETRY_DELAYS[attempt]).await;
                attempt += 1;
            }
            Err(error) => {
                log_name_error("get", target, &error);
                return Err(error);
            }
        }
    }
}

/// A verified bind lane's accepted answer (the pending→durable transfer at
/// materialization): when the store answered the requested durable target,
/// the row's binding advances onto it in BOTH homes; either way the row
/// caches the accepted record (an already-bound handle answers its own).
pub fn apply_transferred_record(
    registry: &TerminalRegistry,
    binder: &dyn TerminalNameBinder,
    terminal_id: &str,
    target: &SessionNameRef,
    record: &SessionNameRecord,
) {
    if &record.name_ref == target {
        apply_binding(
            registry,
            binder,
            terminal_id,
            &NameBinding {
                name_ref: target.clone(),
                naming_handle: None,
            },
        );
    }
    registry.update_session_name(terminal_id, record);
}

/// Write the binding into BOTH homes together: the door's identity table
/// (the rename resolvers) and the registry row (the projections).
fn apply_binding(
    registry: &TerminalRegistry,
    binder: &dyn TerminalNameBinder,
    terminal_id: &str,
    binding: &NameBinding,
) {
    binder.set_name_binding(
        terminal_id,
        &binding.name_ref,
        binding.naming_handle.as_deref(),
    );
    registry.set_naming(
        terminal_id,
        Some(binding.name_ref.clone()),
        binding.naming_handle.clone(),
    );
}

/// Whether the row is still bound to `name_ref`: an answer read for a ref
/// the row has since moved off belongs to a superseded move and is dropped.
/// (Check-then-write with no await between, the publisher's own pattern.)
fn still_bound(registry: &TerminalRegistry, terminal_id: &str, name_ref: &SessionNameRef) -> bool {
    registry.name_ref_of(terminal_id).as_ref() == Some(name_ref)
}

/// A row bound to `bound_to`, which has no record (or could not be read),
/// presents `fallback_title` and drops a cached record of ANOTHER ref (the
/// previous session's name). A record for `bound_to` itself is kept: the
/// naming publisher wrote it after the store answered, when the session was
/// named in between.
fn present_unnamed(
    registry: &TerminalRegistry,
    terminal_id: &str,
    bound_to: &SessionNameRef,
    fallback_title: &str,
) {
    let cached = registry.session_name_of(terminal_id);
    if cached.is_some_and(|record| &record.name_ref == bound_to) {
        return;
    }
    registry.clear_session_name(terminal_id, fallback_title);
}

/// A fresh server-minted pre-durable naming handle.
fn mint_naming_handle() -> String {
    format!("nh-{}", uuid::Uuid::new_v4())
}

fn persisted_handle(hint: &NamingBindHint) -> Option<&str> {
    hint.naming_handle
        .as_deref()
        .map(str::trim)
        .filter(|handle| !handle.is_empty())
}

/// Store failures worth a bounded retry: lock contention, a document
/// read/write failure with the old state intact, and an uncertain commit
/// (every bind operation here is idempotent).
fn is_transient(error: &NameError) -> bool {
    matches!(
        error,
        NameError::LockUnavailable(_) | NameError::Persistence(_) | NameError::CommitUncertain(_)
    )
}

fn deferred(terminal_id: &str, binding: NameBinding, error: &NameError) -> NamingBindOutcome {
    tracing::warn!(
        target: "freshell_freshagent::naming",
        terminal_id = %terminal_id,
        name_ref = %name_ref_debug_key(&binding.name_ref),
        class = %error.code(),
        "session_names.terminal_binding_deferred: the binding is kept and the 2s tick fills the name"
    );
    NamingBindOutcome::Deferred {
        binding,
        reason: error.code().to_string(),
    }
}

fn superseded(terminal_id: &str, binding: NameBinding) -> NamingBindOutcome {
    log_superseded(terminal_id, &binding.name_ref);
    NamingBindOutcome::Superseded { binding }
}

fn log_superseded(terminal_id: &str, read_for: &SessionNameRef) {
    tracing::debug!(
        target: "freshell_freshagent::naming",
        terminal_id = %terminal_id,
        read_for = %name_ref_debug_key(read_for),
        "session_names.terminal_read_superseded: a newer move retargeted the row; the answer was dropped"
    );
}

fn log_retry(op: &str, target: &SessionNameRef, error: &NameError, attempt: usize) {
    tracing::debug!(
        target: "freshell_freshagent::naming",
        op = %op,
        name_ref = %name_ref_debug_key(target),
        class = %error.code(),
        attempt = attempt + 1,
        "session_names.terminal_binding_retry"
    );
}

fn log_bound(terminal_id: &str, binding: &NameBinding, path: &str) {
    tracing::debug!(
        target: "freshell_freshagent::naming",
        terminal_id = %terminal_id,
        name_ref = %name_ref_debug_key(&binding.name_ref),
        path = %path,
        "session_names.terminal_binding_bound"
    );
}

#[cfg(test)]
#[path = "terminal_name_binding_tests.rs"]
mod tests;

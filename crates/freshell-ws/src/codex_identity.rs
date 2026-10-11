//! Shared codex identity adoption tail: bind a verified codex thread id into
//! every identity home (identity store, registry meta, durable pane ledger,
//! broadcast frames, activity hub) in the load-bearing order. Extracted from
//! the retired client candidate channel (`codex_candidate.rs`, campaign
//! §2.3.2) and now owned solely by the server-side rollout locator.

use std::path::{Path, PathBuf};

use freshell_protocol::{
    ServerMessage, SessionLocator, TerminalMetaRecord, TerminalMetaUpdated,
    TerminalSessionAssociated,
};

use crate::terminal::now_ms;
use crate::WsState;

/// `CODEX_HOME` env (non-empty) else `<HOME>/.codex`, then `/sessions` --
/// mirrors `freshell-server/src/session_directory.rs::codex_home` (which is
/// crate-private there; HOME only, never FRESHELL_HOME) joined with the
/// `sessions` dir the way `freshell_sessions::directory_index::CodexSource`
/// does.
///
/// `pub` (re-exported from the crate root) for `freshell-server`'s boot-time
/// codex rollout-locator wiring.
pub fn codex_sessions_root() -> Option<PathBuf> {
    let home = match std::env::var("CODEX_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => {
            #[cfg(windows)]
            let base = std::env::var("USERPROFILE").ok()?;
            #[cfg(not(windows))]
            let base = std::env::var("HOME").ok()?;
            PathBuf::from(base).join(".codex")
        }
    };
    Some(home.join("sessions"))
}

pub(crate) struct CodexAdoption<'a> {
    pub terminal_id: &'a str,
    pub thread_id: &'a str,
    pub rollout_path: Option<&'a Path>,
    pub cwd: Option<&'a str>,
}

/// A mid-session identity move: the live pane's bound codex session forked
/// (in-TUI /resume) and the pane now belongs to the fork child.
pub(crate) struct CodexRebind<'a> {
    pub terminal_id: &'a str,
    pub old_session_id: &'a str,
    pub new_session_id: &'a str,
    pub rollout_path: &'a std::path::Path,
    pub cwd: Option<&'a str>,
}

/// Bind a codex identity into every home, in the load-bearing order.
/// Returns false (and adopts nothing) when the session is already bound to a
/// DIFFERENT terminal -- retired-INCLUSIVE (ledger A8), preserving the
/// cross-pane hijack defense the candidate channel had.
pub(crate) async fn adopt_codex_identity(state: &WsState, a: CodexAdoption<'_>) -> bool {
    if codex_claim_refused(state, a.terminal_id, a.thread_id).await {
        return false;
    }
    // b8ke ext r14 F1: the authority is acquired FIRST and held across
    // the identity homes' writes; the owner commits + broadcasts only
    // AFTER the registry/metadata/durable-binding updates all landed
    // (pre-r14 the commit+broadcast preceded the writes: a handoff could
    // acquire the supposedly-complete owner, reap it, and install another
    // writer while this task kept writing stale bindings, and a durable
    // write failure could not unwind the committed owner).
    let Some(authority) = crate::identity_ownership::coordinator_begin_identity(
        state,
        "codex",
        a.terminal_id,
        a.thread_id,
        None,
    )
    .await
    else {
        return false;
    };
    let applied = apply_codex_identity(
        state,
        a.terminal_id,
        a.thread_id,
        a.rollout_path,
        a.cwd,
        None,
    )
    .await;
    if !applied {
        // b8ke ext r39 F2: the durable binding write failed with NOTHING
        // installed or announced (the reorder above: the identity homes
        // keep the consistent prior state, no association frame
        // broadcast). The held authority COMMITS instead of failing —
        // the terminal process is alive and IS the session's writer, so
        // failing the ticket to Vacant would let a later lifecycle
        // command start a SECOND writer beside it. The committed owner
        // keeps the one-writer invariant; the missing durable row is the
        // typed recoverable state — the next locator sweep re-adopts
        // (the idempotent re-adopt) and retries the binding write.
        tracing::warn!(target: "freshell_ws::codex_identity",
            terminal_id = %a.terminal_id, thread_id = %a.thread_id,
            event = "codex_identity.adoption_binding_failed",
            outcome = "committed_owner_kept", failure_reason = "DURABLE_BINDING_WRITE_FAILED",
            "codex_identity_adoption_refused: the durable binding write failed — \
             nothing installed/announced; the held authority commits so the \
             live terminal stays the named owner (never a \
             Vacant-with-live-writer)"
        );
        crate::identity_ownership::coordinator_commit_identity(
            state,
            authority,
            "codex",
            a.terminal_id,
            a.thread_id,
            None,
        )
        .await;
        return false;
    }
    crate::identity_ownership::coordinator_commit_identity(
        state,
        authority,
        "codex",
        a.terminal_id,
        a.thread_id,
        None,
    )
    .await
}

/// Move a live pane's codex identity to a fork child. Guards: (1) the pane is
/// the LIVE owner of old_session_id (D7 predicate), (2) new_session_id has no
/// live owner (A13) and is not bound elsewhere retired-inclusive (ledger A8),
/// (3) the shared freshagent guards. Returns false (rebinds nothing) on any
/// guard failure.
pub(crate) async fn rebind_codex_identity(state: &WsState, r: CodexRebind<'_>) -> bool {
    // Guard 1 -- the pane must be the LIVE owner of the id being superseded
    // (D7 predicate: identity arm + registry-row arm, Running only). This is
    // the anti-hijack core: fork lineage alone is not enough; the lineage
    // must point at THIS pane's current identity while the pane is alive.
    if state
        .registry
        .live_session_owner(Some(&state.identity), "codex", r.old_session_id)
        .as_deref()
        != Some(r.terminal_id)
    {
        tracing::warn!(terminal_id = %r.terminal_id, old = %r.old_session_id,
            "codex_rebind_refused: pane is not the live owner of the superseded session");
        return false;
    }
    // Guard 2 -- A13: the NEW id must have no live owner anywhere.
    if let Some(owner) =
        state
            .registry
            .live_session_owner(Some(&state.identity), "codex", r.new_session_id)
    {
        tracing::warn!(terminal_id = %r.terminal_id, new = %r.new_session_id, owner = %owner,
            "codex_rebind_refused: target session already live-owned (A13)");
        return false;
    }
    // Guard 3 -- shared adoption guards on the claimed id (retired-inclusive
    // bound-elsewhere + freshagent lanes).
    if codex_claim_refused(state, r.terminal_id, r.new_session_id).await {
        return false;
    }
    // b8ke ext r14 F1/F2: the rebind's authority is acquired FIRST (the
    // new key's claim + the OLD key's guard — a stop/handoff on the old
    // key mid-rebind answers Blocked typed) and held across the identity
    // homes' writes; the commit is the ATOMIC coordinator move (the new
    // key commits Live while the old key's Live record becomes Aliased in
    // ONE lock scope, the registry's retained claim rekeyed in the same
    // step — never the interval where both keys name the writer). A
    // refusal mutates nothing.
    // Task 14: the fork's app-server announced the fork (`thread/started`)
    // before this lane saw its rollout, so the pane's unit may hold it as an
    // extra thread: that hold is released, so the rebind's claim commits the
    // fork as the pane's main conversation and aliases the original to it
    // (claiming a key the pane already holds would only adopt it, and release
    // the original instead). A refused rebind holds it again.
    let released_extra =
        crate::unit_threads::release_for_main(state, r.terminal_id, r.new_session_id);
    let Some(authority) = crate::identity_ownership::coordinator_begin_identity(
        state,
        "codex",
        r.terminal_id,
        r.new_session_id,
        Some(r.old_session_id),
    )
    .await
    else {
        if released_extra {
            crate::unit_threads::restore_extra(state, r.terminal_id, r.new_session_id);
        }
        return false;
    };
    tracing::info!(terminal_id = %r.terminal_id, old = %r.old_session_id, new = %r.new_session_id,
        "codex_rebind: in-TUI fork detected; moving pane identity");
    let applied = apply_codex_identity(
        state,
        r.terminal_id,
        r.new_session_id,
        Some(r.rollout_path),
        r.cwd,
        Some(r.old_session_id),
    )
    .await;
    if !applied {
        // b8ke ext r39 F2: the durable binding write failed with NOTHING
        // installed or announced (the identity homes still name the OLD
        // session, no association frame broadcast). The held authority
        // COMMITS instead of failing — the forked CLI process is alive
        // and IS the new session's writer, so failing the ticket to
        // Vacant would let a later lifecycle command start a SECOND
        // writer beside it. The commit's atomic move (new key Live,
        // old key Aliased) keeps the one-writer invariant; the missing
        // durable row is the typed recoverable state.
        tracing::warn!(target: "freshell_ws::codex_identity",
            terminal_id = %r.terminal_id,
            old_session_id = %r.old_session_id, new_session_id = %r.new_session_id,
            event = "codex_identity.rebind_binding_failed",
            outcome = "committed_owner_kept", failure_reason = "DURABLE_BINDING_WRITE_FAILED",
            "codex_identity_rebind_refused: the durable binding write failed — \
             nothing installed/announced; the held authority commits so the \
             live forked writer stays the named owner (never a \
             Vacant-with-live-writer)"
        );
    }
    let committed = crate::identity_ownership::coordinator_commit_identity(
        state,
        authority,
        "codex",
        r.terminal_id,
        r.new_session_id,
        Some(r.old_session_id),
    )
    .await;
    // Task 14: the app-server holds both threads: the fork is the pane's
    // conversation now, and the original stays on the unit (and in the
    // sidecar record) until Codex unloads it.
    crate::unit_threads::note_rebind(state, r.terminal_id, r.old_session_id, r.new_session_id);
    applied && committed
}

/// Shared hijack/misbind guards for BOTH adoption and rebind. `thread_id` is
/// the id being CLAIMED. Semantics identical to the inline originals
/// (retired-INCLUSIVE ledger A8; same-terminal re-adopt allowed).
async fn codex_claim_refused(state: &WsState, terminal_id: &str, thread_id: &str) -> bool {
    // Cross-pane hijack / replay defense, retired-INCLUSIVE (ledger A8): a
    // victim's binding retires at exit, so a live-only lookup would allow
    // replaying a DEAD pane's identity onto a fresh terminal. Inherited from
    // the retired candidate channel's guard 3b -- keep the exact
    // comparison semantics that code used; re-adopting the SAME
    // terminal is an idempotent allow. This guard is also a REQUIRED A4
    // misbind hardening for the locator path: the adoption tail must refuse
    // a thread id already bound to another terminal (Validated Premise 9),
    // so it must never be weakened when the candidate channel is deleted.
    if let Some(existing) = state
        .identity
        .find_by_session_including_retired("codex", thread_id)
    {
        if existing != terminal_id {
            tracing::warn!(
                terminal_id = %terminal_id,
                thread_id = %thread_id,
                "codex_adopt_rejected: session_bound_elsewhere"
            );
            return true;
        }
    }
    // B2xB4 misbind hardening (B2 plan item 10, fix enabled by B4's
    // kind:fresh-agent ledger rows): the freshagent codex sidecar writes
    // rollouts into the SAME sessions root the locator walks, so a foreign
    // same-cwd rollout appearing after a pane's first Enter could misbind as
    // a sole candidate. A thread id the server knows as a FRESH-AGENT
    // session -- live in the fresh_codex session map, or recorded by B4's
    // durable-before-answer ledger write at thread start -- must never bind
    // to a terminal pane.
    if state.fresh_codex.has_live_session(thread_id).await {
        tracing::warn!(
            terminal_id = %terminal_id,
            thread_id = %thread_id,
            "codex_adopt_rejected: freshagent_live_session"
        );
        return true;
    }
    if state
        .pane_ledger
        .lookup_by_session("codex", thread_id)
        .is_some_and(|r| r.row.pane_kind.as_deref() == Some("fresh-agent"))
    {
        tracing::warn!(
            terminal_id = %terminal_id,
            thread_id = %thread_id,
            "codex_adopt_rejected: freshagent_ledger_row"
        );
        return true;
    }
    false
}

/// The shared identity write tail (adoption AND rebind), in the PINNED
/// load-bearing order: durable ledger (awaited; fsync-before-announce) ->
/// identity.upsert -> registry set_meta -> broadcast `terminal.session.
/// associated` -> activity hub. Do not reorder.
/// b8ke ext r39 F2: the DURABLE BINDING GATES THE INSTALL/ANNOUNCE — the
/// binding write runs FIRST and a failure installs/announces NOTHING
/// (the volatile identity homes keep the consistent prior state, no
/// association frame broadcasts, no activity-hub update). Pre-r39 the
/// upsert/set_meta/association broadcast/activity hub all landed BEFORE
/// the awaited binding write, so a failure had already installed and
/// announced the identity and the caller's ticket fail left a
/// Vacant-with-live-writer: the volatile registries and clients still
/// identified the terminal as the session writer while the coordinator
/// held nothing — a later lifecycle command could start a second writer.
async fn apply_codex_identity(
    state: &WsState,
    terminal_id: &str,
    thread_id: &str,
    rollout_path: Option<&std::path::Path>,
    cwd: Option<&str>,
    previous_session_id: Option<&str>,
) -> bool {
    // Durable ledger: binding row FIRST, pending marker delete SECOND --
    // awaited BEFORE any install/announce (fsync-before-announce; a
    // failed write installs nothing). On a rebind the marker is long gone
    // (a no-op delete) and the write supersedes the old bound row (new
    // bound row FIRST, then retire old).
    if !crate::pane_ledger::ledger_resolve_identity(state, terminal_id, "codex", thread_id, cwd)
        .await
    {
        tracing::warn!(target: "freshell_ws::codex_identity",
            terminal_id = %terminal_id, thread_id = %thread_id,
            event = "codex_identity.binding_failed",
            outcome = "refused", failure_reason = "DURABLE_BINDING_WRITE_FAILED",
            "codex_identity_binding_failed: the durable binding write failed — \
             nothing installed or announced (the identity homes keep the \
             prior state); the caller commits the held authority (the live \
             terminal stays the owner) and the binding retries on the next \
             locator sweep"
        );
        return false;
    }
    // Both identity homes -- different consumers (see opencode_association.rs:135-148).
    state
        .identity
        .upsert(terminal_id, Some("codex"), Some(thread_id), cwd, now_ms());
    // Unified agent names (Task 2): the rollout locator's adoption/rebind —
    // the rollout file IS the verified persistence evidence (the locator's
    // whole job is finding persisted rollouts). The upsert established the
    // durable identity and deliberately left a still-pending name ref for
    // THIS transfer (the switch rule retargets only already-durable refs);
    // the stashed pending handle transfers onto the thread with the rollout
    // path as the native location, then the identity/registry bindings
    // advance. A pathless adoption keeps the handle pending for a later
    // located edge.
    if let Some(rollout) = rollout_path {
        // T2-M6 (Task 3): the rollout walk's root prefers the PROXIED
        // initialize's captured home (the app-server itself reported where
        // these rollouts live) over ambient env.
        let codex_home = state
            .identity
            .codex_home_of(terminal_id)
            .or_else(|| {
                codex_sessions_root()
                    .and_then(|root| root.parent().map(|home| home.display().to_string()))
            })
            .unwrap_or_default();
        let acquisition = freshell_protocol::native_location::NativeAcquisition {
            location: freshell_protocol::native_location::NativeLocation::Codex {
                codex_home,
                native_thread_id: Some(thread_id.to_string()),
                rollout_path: Some(rollout.display().to_string()),
                persistence_evidence: Some(rollout.display().to_string()),
            },
            evidence: freshell_protocol::native_location::NativeEvidenceKind::PersistedMetadata,
            persistence: freshell_protocol::native_location::NativePersistence::Verified,
        };
        crate::identity::bind_pending_naming(
            &state.identity,
            &state.registry,
            terminal_id,
            freshell_protocol::session_names::NamedProvider::Codex,
            thread_id,
            acquisition,
        )
        .await;
    }
    state.registry.set_meta(
        terminal_id,
        None,
        None,
        Some("codex".to_string()),
        Some(thread_id.to_string()),
    );
    broadcast_terminal_session_associated(
        state,
        "codex",
        terminal_id,
        thread_id,
        cwd.map(str::to_string),
        previous_session_id.map(str::to_string),
    );
    // Activity hub (channel-deferred, safe off the dispatch path): G3 --
    // codex.activity.updated / terminal.turn.complete carry the sessionId;
    // G9 -- the rollout reconcile lane gets its file.
    if let Some(hub) = &state.activity {
        hub.bind_codex_session(terminal_id, thread_id);
        if let Some(path) = rollout_path {
            hub.attach_codex_rollout(terminal_id, thread_id, path);
        }
    }
    true
}

/// Fan `terminal.session.associated` + a `terminal.meta.updated` upsert to
/// every connection. Byte-for-byte the shape of
/// `opencode_association.rs::broadcast_terminal_session_associated`,
/// provider-parameterized: the codex adoption/rebind tail passes "codex",
/// the claude signal rebind (`claude_signal.rs`) passes "claude" -- ONE
/// shared broadcaster, no copy. EMISSION ORDER IS PINNED: `associated`
/// FIRST, then `meta.updated` (mirroring opencode_association.rs:163-198)
/// -- the integration test awaits them in exactly this order, and
/// `next_frame_of_type` drops out-of-order frames. Do not reorder.
pub(crate) fn broadcast_terminal_session_associated(
    state: &WsState,
    provider: &str,
    terminal_id: &str,
    session_id: &str,
    cwd: Option<String>,
    previous_session_id: Option<String>,
) {
    let associated = ServerMessage::TerminalSessionAssociated(TerminalSessionAssociated {
        terminal_id: terminal_id.to_string(),
        session_ref: SessionLocator {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
        },
        previous_session_id,
    });
    if let Ok(frame) = serde_json::to_string(&associated) {
        let _ = state.broadcast_tx.send(frame);
    }

    let meta = ServerMessage::TerminalMetaUpdated(TerminalMetaUpdated {
        remove: Vec::new(),
        upsert: vec![TerminalMetaRecord {
            terminal_id: terminal_id.to_string(),
            updated_at: now_ms(),
            branch: None,
            checkout_root: None,
            cwd,
            display_subdir: None,
            is_dirty: None,
            provider: Some(provider.to_string()),
            repo_root: None,
            session_id: Some(session_id.to_string()),
            token_usage: None,
        }],
    });
    if let Ok(frame) = serde_json::to_string(&meta) {
        let _ = state.broadcast_tx.send(frame);
    }
}

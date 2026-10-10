//! b8ke ext r11 F1: the coordinator step for terminal identities learned
//! AFTER process creation. Four lanes adopt or rebind a live terminal's
//! canonical session id without touching the coordinator — the codex
//! locator adoption (`codex_identity::adopt_codex_identity`), the codex
//! fork rebind (`codex_identity::rebind_codex_identity`), the opencode
//! locator adoption (`opencode_association::drain_and_associate`), and the
//! opencode/claude SessionStart signal rebinds (`apply_opencode_signal` /
//! `apply_claude_signal`). Pre-r11 those paths only updated the identity
//! homes, so the REAL terminal writer ran while the canonical coordinator
//! key was VACANT (a later Fresh Agent lifecycle op saw no prior owner and
//! could not stop-and-confirm-reap it), and a rebind left the OLD key
//! live under the moved writer.
//!
//! Every lane now routes through [`coordinator_commit_identity`] — the
//! ext-r6 learned-identity discipline applied at the association boundary:
//! claim `Live{Terminal}` under the learned canonical key through the
//! shared coordinator (an idempotent Adopt of THIS terminal's own live
//! owner proceeds; every other outcome — a foreign owner, a competing
//! fresh-agent owner, or an in-flight lifecycle transition — refuses
//! typed, fail-closed, and NOTHING mutates), commit under the terminal
//! registry's own `commit_session_ref_ownership` (which also stamps the
//! retained claim + verifies the row is still Running — the ext-r9 F2
//! liveness contract), broadcast the authoritative owner frame
//! (`handoff-committed`, the adopt-commits-Live shape), and on a REBIND
//! release the superseded old key in the SAME step (`released` under the
//! old key — never a stale-live old key after the writer moved).

use crate::terminal::now_ms;
use crate::WsState;
use freshell_protocol::ServerMessage;

/// b8ke ext r14 F1: the held authority for an identity adoption/rebind —
/// the claim phase's artifact, carried across the caller's identity
/// registry / terminal-metadata / awaited durable pane-ledger writes and
/// consumed by the commit phase (or dropped by the fail phase — a binding
/// failure unwinds with NO committed owner).
pub(crate) enum IdentityAuthority {
    /// A Granted `Starting` ticket on the (new) canonical key — the
    /// adoption's claim from a non-Live key; the commit commits it Live.
    Ticket(freshell_ownership::OperationTicket),
    /// A live same-kind incumbent re-adopt (the key already names THIS
    /// terminal): the ext-r12 attach guard holds the window across the
    /// caller's writes — a handoff or stop begin inside answers the typed
    /// Blocked outcome.
    AdoptGuard(freshell_ownership::AttachGuard),
    /// A REBIND whose new key granted a Starting ticket, with the OLD
    /// key's Live record guarded through the window (the atomic commit
    /// rekeys old→new).
    RebindTicket {
        ticket: freshell_ownership::OperationTicket,
        old_key_guard: freshell_ownership::AttachGuard,
    },
    /// A REBIND whose new key already names this terminal (the idempotent
    /// re-adopt), with the OLD key guarded through the window.
    RebindAdopt {
        adopt_guard: freshell_ownership::AttachGuard,
        old_key_guard: freshell_ownership::AttachGuard,
    },
    /// No coordinator wired: the legacy proceed (nothing to commit).
    Unwired,
}

/// b8ke ext r14 F1: the CLAIM phase — the association lane's coordinator
/// authority is acquired BEFORE any identity home mutates and held across
/// the caller's registry/metadata/durable-binding writes (the ext-r11
/// order committed Live and broadcast FIRST, so a handoff could acquire
/// the supposedly-complete owner, reap it, and install another writer
/// while the association task kept writing stale bindings, and a durable
/// write failure could not unwind the committed owner). Returns the held
/// authority, or `None` (logged) when the coordinator refuses — the
/// caller aborts with NOTHING mutated.
///
/// `previous_session_id: Some(old)` marks a REBIND: the claim covers the
/// NEW key (a Granted ticket from a non-Live key, or this terminal's own
/// live incumbent re-adopt), and the OLD key's Live record is protected
/// by the ext-r12 attach guard through the window (a stop or handoff on
/// the old key mid-rebind answers Blocked typed — never a reap of the
/// writer while the new key's fate is pending).
pub(crate) async fn coordinator_begin_identity(
    state: &WsState,
    provider: &str,
    terminal_id: &str,
    session_id: &str,
    previous_session_id: Option<&str>,
) -> Option<IdentityAuthority> {
    let Some(ownership) = state.ownership.as_ref() else {
        return Some(IdentityAuthority::Unwired);
    };
    let is_rebind = previous_session_id.is_some();
    let operation_id = if is_rebind {
        format!("assoc-rebind-{terminal_id}")
    } else {
        format!("assoc-adopt-{terminal_id}")
    };
    let initiator = if is_rebind {
        "ws-identity-association/rebind"
    } else {
        "ws-identity-association/adopt"
    };
    // b8ke ext r14 F2: a REBIND also holds authority over the OLD key —
    // its Live record is the writer's current owner, and the ext-r12
    // guard blocks a stop/handoff on it through the rebind's window.
    let mut old_key_guard = None;
    if let Some(old_session_id) = previous_session_id {
        if old_session_id != session_id {
            old_key_guard = match ownership.begin_attach_guard(
                provider,
                old_session_id,
                &format!("{operation_id}-old"),
                None,
                initiator,
            ) {
                freshell_ownership::AttachGuardOutcome::Armed(guard) => Some(*guard),
                freshell_ownership::AttachGuardOutcome::Refused { state, .. } => {
                    tracing::warn!(target: "freshell_ws::identity_ownership",
                        provider = %provider, session_id = %old_session_id,
                        terminal_id = %terminal_id, state = ?state,
                        "identity_association_refused: the rebind's old key entered a \
                         transition — the rebind mutates nothing"
                    );
                    return None;
                }
                freshell_ownership::AttachGuardOutcome::StaleGeneration { .. } => {
                    tracing::warn!(target: "freshell_ws::identity_ownership",
                        provider = %provider, session_id = %old_session_id,
                        terminal_id = %terminal_id,
                        "identity_association_refused: the rebind's old-key fence is \
                         stale — the rebind mutates nothing"
                    );
                    return None;
                }
            };
        }
    }
    let mut authority = match freshell_freshagent::ownership_lane::begin_terminal_lane_claim(
        &state.ownership,
        provider,
        session_id,
        &operation_id,
        // No observed fence: the association lane holds no prior wire
        // observation for the learned id (it did not come from a create).
        None,
        initiator,
        now_ms().max(0) as u64,
    ) {
        freshell_freshagent::ownership_lane::TerminalLaneClaim::Granted(ticket) => {
            IdentityAuthority::Ticket(ticket)
        }
        // Unwired is unreachable here (the ownership Option was Some) —
        // treat it as the legacy no-op allow.
        freshell_freshagent::ownership_lane::TerminalLaneClaim::Unwired => {
            IdentityAuthority::Unwired
        }
        freshell_freshagent::ownership_lane::TerminalLaneClaim::Adopt => {
            // The coordinator already holds a live same-kind owner. THIS
            // terminal re-adopting its own live record is the idempotent
            // allow; any other live owner refuses fail-closed (the
            // caller's identity guards should have caught it; the
            // coordinator is the authority).
            let snapshot = ownership.observe(provider, session_id);
            match &snapshot.state {
                freshell_ownership::OwnershipState::Live { owner, .. }
                    if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
                        && owner.terminal_id.as_deref() == Some(terminal_id) =>
                {
                    // b8ke ext r14 F1 → ext r39 F1: the re-adopt proceeds
                    // under HELD authority across the caller's writes —
                    // and the arm is the ATOMIC ADOPT (the r38 primitive):
                    // the snapshot's observed pair plus the EXPECTED
                    // owner (this kind AND this terminal id) validated in
                    // ONE coordinator-lock decision. Pre-r39 the arm was
                    // the generic `begin_attach_guard` with NO fence and
                    // NO expected identity: a completed cross-kind handoff
                    // between the snapshot and the arm made the guard arm
                    // on the NEW Fresh Agent owner (the generic guard
                    // accepts any Live owner), and the path applied
                    // terminal identity changes and broadcast a terminal
                    // owner over the Fresh Agent's session. The adopt
                    // closes the interval: any advance or a foreign
                    // owner refuses typed BEFORE anything mutates.
                    //
                    // Test seam (ext r39 F1): park with the precheck
                    // observation taken but the adopt NOT yet armed — the
                    // deterministic-race tests commit a cross-kind handoff
                    // in THIS interval (the one the post-arm pauses can
                    // never reach). No-op in production.
                    if let Some(pause) = state.registry.identity_readopt_pause_hook() {
                        pause(provider, session_id).await;
                    }
                    let expected_terminal = freshell_ownership::OwnerIdentity {
                        kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                        terminal_id: Some(terminal_id.to_string()),
                        live_session_key: None,
                        pid: None,
                        ownership_id: None,
                        unit_id: None,
                        hold: freshell_ownership::HoldKind::Main,
                    };
                    match ownership.begin_adopt_guard(
                        provider,
                        session_id,
                        &format!("{operation_id}-readopt"),
                        &expected_terminal,
                        freshell_ownership::ObservedFence {
                            epoch: snapshot.epoch,
                            generation: snapshot.generation,
                        },
                        initiator,
                    ) {
                        freshell_ownership::AttachGuardOutcome::Armed(guard) => {
                            IdentityAuthority::AdoptGuard(*guard)
                        }
                        freshell_ownership::AttachGuardOutcome::Refused { state, .. } => {
                            tracing::warn!(target: "freshell_ws::identity_ownership",
                                provider = %provider, session_id = %session_id,
                                terminal_id = %terminal_id, state = ?state,
                                "identity_association_refused: the re-adopt's atomic adopt \
                                 refused to arm (ownership advanced or a foreign owner \
                                 holds the key) — the adoption mutates nothing"
                            );
                            return None;
                        }
                        freshell_ownership::AttachGuardOutcome::StaleGeneration { .. } => {
                            tracing::warn!(target: "freshell_ws::identity_ownership",
                                provider = %provider, session_id = %session_id,
                                terminal_id = %terminal_id,
                                "identity_association_refused: the re-adopt's atomic adopt \
                                 refused to arm (the observed pair is stale or names a \
                                 different epoch) — the adoption mutates nothing"
                            );
                            return None;
                        }
                    }
                }
                other => {
                    tracing::warn!(target: "freshell_ws::identity_ownership",
                        provider = %provider, session_id = %session_id,
                        terminal_id = %terminal_id, state = ?other,
                        "identity_association_refused: the canonical key already \
                         has a live owner — the adoption/rebind mutates nothing"
                    );
                    return None;
                }
            }
        }
        freshell_freshagent::ownership_lane::TerminalLaneClaim::Refused(outcome) => {
            tracing::warn!(target: "freshell_ws::identity_ownership",
                provider = %provider, session_id = %session_id,
                terminal_id = %terminal_id, outcome = ?outcome,
                "identity_association_refused: the ownership coordinator refused \
                 the identity claim — the adoption/rebind mutates nothing"
            );
            return None;
        }
    };
    // Splice the old-key guard into the authority so its Drop closes
    // the old key's window with the commit.
    if let Some(guard) = old_key_guard {
        authority = match authority {
            IdentityAuthority::Ticket(ticket) => IdentityAuthority::RebindTicket {
                ticket,
                old_key_guard: guard,
            },
            IdentityAuthority::AdoptGuard(adopt_guard) => IdentityAuthority::RebindAdopt {
                adopt_guard,
                old_key_guard: guard,
            },
            // Unwired cannot occur (the ownership Option was Some); a
            // refused claim returned above.
            other => other,
        };
    }
    Some(authority)
}

// b8ke ext r39 F2: the FAIL phase is DELETED — under the binding-gates-
// install contract a failed durable binding write installs/announces
// NOTHING and the held authority COMMITS (the live terminal process
// stays the named owner — never a Vacant-with-live-writer beside it,
// which a ticket fail would produce). The authority's own Drop remains
// the panic/early-return unwind (the ticket's typed fail, the guards'
// window close) — there is deliberately no explicit fail call left on
// any identity path.

/// b8ke ext r14 F1: the COMMIT phase — the callers' identity registry,
/// terminal-metadata, and awaited durable pane-ledger writes have ALL
/// landed (under the held authority); NOW the owner commits and the
/// authoritative frames broadcast. A handoff acquiring the owner after
/// this point finds the binding already durable — no stale-binding
/// writes after a reap. Returns `false` when the commit went stale (the
/// coordinator moved on across the caller's writes) — the identity homes
/// hold a binding for a terminal the coordinator does not name (the
/// stale-teardown discipline owns it; logged loudly).
///
/// b8ke ext r14 F2: a REBIND's commit is the ATOMIC coordinator move —
/// the new key's Starting claim commits Live while the OLD key's
/// Live{Terminal} record becomes Aliased in ONE coordinator lock scope
/// (never the interval where both keys name the writer), and the
/// registry's retained claim is REKEYED in one registry scope (the old
/// claim removed as the new is inserted — the kill/exit selection can
/// never pick a stale old claim).
///
/// b8ke ext r14 F3: the old key's `released` broadcast carries the
/// VACANT owner shape (ownerKind "vacant", no terminal id) — the shape
/// the client's convergence clears on (a terminal-owner frame on a
/// superseded key left old-key Fresh Agent panes presenting "opened as
/// CLI elsewhere" with a direct-attach action pointing at a terminal
/// that had moved to a different session).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn coordinator_commit_identity(
    state: &WsState,
    authority: IdentityAuthority,
    provider: &str,
    terminal_id: &str,
    session_id: &str,
    previous_session_id: Option<&str>,
) -> bool {
    let Some(ownership) = state.ownership.as_ref() else {
        return true;
    };
    let is_rebind = previous_session_id.is_some();
    let operation_id = if is_rebind {
        format!("assoc-rebind-{terminal_id}")
    } else {
        format!("assoc-adopt-{terminal_id}")
    };
    let initiator = if is_rebind {
        "ws-identity-association/rebind"
    } else {
        "ws-identity-association/adopt"
    };
    let locator = freshell_protocol::SessionLocator {
        provider: provider.to_string(),
        session_id: session_id.to_string(),
    };
    match authority {
        IdentityAuthority::Unwired => true,
        IdentityAuthority::AdoptGuard(guard) => {
            // The idempotent re-adopt: the record already names this
            // terminal — nothing to commit; the guard closes with the
            // scope and the frame refreshes the authoritative owner.
            drop(guard);
            // b8ke ext r39 F1: the broadcast carries the coordinator's
            // POST-COMMIT truth — never an unconditional terminal owner.
            // The guard's drop opens the key before this observe, so a
            // completed handoff in that interval can have moved the
            // owner: broadcasting "terminal" over a Fresh Agent (or
            // mid-transition) record would converge clients and durable
            // recovery state on the reaped terminal. The conditional
            // frame only fires when the coordinator still names THIS
            // terminal; otherwise this is the honest stale shape (the
            // identity homes hold a binding the coordinator does not
            // name — the stale-teardown discipline owns it).
            if broadcast_owner_frame_if_authoritative(
                state,
                ownership,
                provider,
                session_id,
                terminal_id,
                &operation_id,
                "handoff-committed",
            ) {
                true
            } else {
                tracing::warn!(target: "freshell_ws::identity_ownership",
                    provider = %provider, session_id = %session_id,
                    terminal_id = %terminal_id,
                    "identity_association_commit_stale: the re-adopt's owner frame \
                     suppressed — the coordinator no longer names this terminal \
                     (the adoption's homes hold a binding the coordinator does not \
                     name; the stale-teardown discipline owns the bound terminal)"
                );
                false
            }
        }
        IdentityAuthority::RebindAdopt {
            adopt_guard,
            old_key_guard,
        } => {
            // The idempotent re-adopt of the NEW key (already ours); the
            // old key still needs its atomic release.
            drop(adopt_guard);
            let released = rebind_release_old_key(
                state,
                ownership,
                provider,
                terminal_id,
                session_id,
                previous_session_id,
                &operation_id,
                initiator,
            );
            drop(old_key_guard);
            released
        }
        IdentityAuthority::Ticket(mut ticket) => {
            // The adoption's commit: the registry's own API (the retained
            // claim + the ext-r9 commit-time liveness check).
            let outcome = state.registry.commit_session_ref_ownership(
                &locator,
                ticket.operation_id(),
                ticket.generation(),
                terminal_id,
            );
            match outcome {
                freshell_ownership::CommitOutcome::Committed => {
                    ticket.disarm();
                    note_unit_conversation(state, terminal_id, provider, session_id).await;
                    let snapshot = ownership.observe(provider, session_id);
                    // b8ke ext r22 F2: the commit-side ownership stamp — the
                    // row's delayed-write fence baseline advances to THIS
                    // commit's pair, so a delayed pre-teardown binding write
                    // (an older pair) refuses typed and the newer owner's
                    // recovery row survives.
                    if let Err(err) = state.pane_ledger.stamp_owner_pair(
                        provider,
                        session_id,
                        snapshot.epoch,
                        snapshot.generation,
                    ) {
                        tracing::warn!(target: "freshell_ws::identity_ownership",
                            provider = %provider, session_id = %session_id,
                            error = %err,
                            "identity_association_stamp_owner_pair_failed: the row's \
                             ownership stamp refresh failed (the fence baseline is \
                             stale until the next successful stamp)"
                        );
                    }
                    // b8ke ext r39 F1: the broadcast carries the
                    // POST-COMMIT truth — the commit and this observe are
                    // two coordinator reads, so a handoff completing in
                    // between must NOT be overwritten with an
                    // unconditional terminal frame.
                    if broadcast_owner_frame_if_authoritative(
                        state,
                        ownership,
                        provider,
                        session_id,
                        terminal_id,
                        &operation_id,
                        "handoff-committed",
                    ) {
                        true
                    } else {
                        tracing::warn!(target: "freshell_ws::identity_ownership",
                            provider = %provider, session_id = %session_id,
                            terminal_id = %terminal_id,
                            "identity_association_commit_stale: the committed owner \
                             frame suppressed — the coordinator moved on between \
                             the commit and the broadcast (the adoption's homes hold \
                             a binding the coordinator does not name; the \
                             stale-teardown discipline owns the bound terminal)"
                        );
                        false
                    }
                }
                stale => {
                    tracing::error!(target: "invariant",
                        provider = %provider, session_id = %session_id,
                        terminal_id = %terminal_id, stale = ?stale,
                        "identity_association_commit_stale: the coordinator moved on \
                         while the learned identity committed — the adoption mutates \
                         nothing (the stale-teardown discipline owns the bound terminal)"
                    );
                    false
                }
            }
        }
        IdentityAuthority::RebindTicket {
            mut ticket,
            old_key_guard,
        } => {
            // b8ke ext r14 F2: the REBIND's ATOMIC commit — the new key's
            // Starting claim commits Live while the old key's Live
            // record becomes Aliased in ONE coordinator lock scope, and
            // the registry's retained claim is rekeyed in one registry
            // scope (the old removed as the new is inserted).
            let old_locator = freshell_protocol::SessionLocator {
                provider: provider.to_string(),
                session_id: previous_session_id
                    .expect("the rebind authority requires a previous id")
                    .to_string(),
            };
            let (outcome, _removed_old_claim) = state.registry.commit_session_ref_ownership_rekey(
                &old_locator,
                &locator,
                ticket.operation_id(),
                ticket.generation(),
                terminal_id,
            );
            drop(old_key_guard);
            match outcome {
                freshell_ownership::CommitOutcome::Committed => {
                    ticket.disarm();
                    note_unit_conversation(state, terminal_id, provider, session_id).await;
                    // The new key's authoritative owner frame.
                    let snapshot = ownership.observe(provider, session_id);
                    // b8ke ext r22 F2: the commit-side ownership stamp — the
                    // row's delayed-write fence baseline advances to THIS
                    // rekey commit's pair (the delayed-write fence).
                    if let Err(err) = state.pane_ledger.stamp_owner_pair(
                        provider,
                        session_id,
                        snapshot.epoch,
                        snapshot.generation,
                    ) {
                        tracing::warn!(target: "freshell_ws::identity_ownership",
                            provider = %provider, session_id = %session_id,
                            error = %err,
                            "identity_association_stamp_owner_pair_failed: the row's \
                             ownership stamp refresh failed (the fence baseline is \
                             stale until the next successful stamp)"
                        );
                    }
                    broadcast_owner_frame(
                        state,
                        provider,
                        session_id,
                        terminal_id,
                        &operation_id,
                        snapshot.generation,
                        "handoff-committed",
                    );
                    // The old key's frame (b8ke ext r31 F2): the SAME
                    // aliased truth the reconnect replay resolves —
                    // `aliasOf` naming the new canonical id and the
                    // canonical's ownerKind/terminalId/generation — so
                    // an ONLINE old-key pane converges exactly like a
                    // reconnecting one (pre-r31 this broadcast the
                    // VACANT shape with aliasOf None and the two
                    // channels disagreed).
                    broadcast_rebind_alias_frame(
                        state,
                        provider,
                        old_locator.session_id.as_str(),
                        &operation_id,
                    );
                    true
                }
                stale => {
                    tracing::error!(target: "invariant",
                        provider = %provider, session_id = %session_id,
                        terminal_id = %terminal_id, stale = ?stale,
                        "identity_rebind_commit_stale: the coordinator moved on while \
                         the rebind committed — the rebind's ownership did not move (the \
                         stale-teardown discipline owns the bound terminal)"
                    );
                    false
                }
            }
        }
    }
}

/// A committed conversation of a unit row (the commit's owner already
/// carries the row's unit id) joins that unit's recorded conversation keys,
/// so a restarted server finds every conversation the unit held. The record
/// write runs on a blocking thread.
async fn note_unit_conversation(
    state: &WsState,
    terminal_id: &str,
    provider: &str,
    session_id: &str,
) {
    let Some(entry) = state.units.by_terminal(terminal_id) else {
        return;
    };
    let (provider, session_id) = (provider.to_string(), session_id.to_string());
    let _ = tokio::task::spawn_blocking(move || {
        entry.unit.note_conversation(&provider, &session_id);
    })
    .await;
}

/// b8ke ext r14 F2: the rebind's old-key release for the ADOPT-armed
/// shape (the new key already names this terminal idempotently; the old
/// key still holds a Live record naming it). The old record is verified
/// (THIS terminal) and released under the coordinator lock — the
/// registry's retained claim for the old key is removed in the same
/// step.
#[allow(clippy::too_many_arguments)] // the release field set (the keys + the identities + the op)
fn rebind_release_old_key(
    state: &WsState,
    ownership: &std::sync::Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    provider: &str,
    terminal_id: &str,
    session_id: &str,
    previous_session_id: Option<&str>,
    operation_id: &str,
    initiator: &str,
) -> bool {
    let Some(old_session_id) = previous_session_id else {
        return true;
    };
    if old_session_id == session_id {
        return true;
    }
    let old_snapshot = ownership.observe(provider, old_session_id);
    match &old_snapshot.state {
        freshell_ownership::OwnershipState::Live {
            owner, generation, ..
        } if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
            && owner.terminal_id.as_deref() == Some(terminal_id) =>
        {
            let claim = freshell_ownership::ReleaseClaim {
                operation_id: owner
                    .ownership_id
                    .clone()
                    .unwrap_or_else(|| operation_id.to_string()),
                generation: *generation,
                runtime: Some(owner.clone()),
            };
            ownership.release(provider, old_session_id, &claim, initiator);
            tracing::info!(target: "freshell_ws::identity_ownership",
                provider = %provider, old_session_id = %old_session_id,
                new_session_id = %session_id, terminal_id = %terminal_id,
                "identity_rebind_old_key_released: the superseded canonical \
                 key released in the same step as the move"
            );
            // The old key's retained claim is removed (the rebind moved
            // it — the kill/exit selection must never find it).
            state
                .registry
                .remove_retained_session_ref_claim(&freshell_protocol::SessionLocator {
                    provider: provider.to_string(),
                    session_id: old_session_id.to_string(),
                });
            // b8ke ext r14 F3: the VACANT release frame under the old key
            // (b8ke ext r32 F2: stamped with THIS release's own pair —
            // the old key's pre-release generation, never a re-observed
            // current generation).
            broadcast_vacant_frame(
                state,
                provider,
                old_session_id,
                operation_id,
                ownership.boot_epoch(),
                *generation,
            );
            true
        }
        other => {
            tracing::warn!(target: "freshell_ws::identity_ownership",
                provider = %provider, old_session_id = %old_session_id,
                terminal_id = %terminal_id, state = ?other,
                "identity_rebind_old_key_mismatch: the old canonical key's \
                 record does not name this terminal — left untouched"
            );
            false
        }
    }
}

/// b8ke ext r31 F2: the rebind's OLD-key frame — the SAME aliased truth
/// the reconnect replay resolves. The frame is DERIVED from
/// `snapshot_records()` itself (the one-resolve, one-read fixpoint —
/// the exact record a reconnecting client's `ready.runtimeOwners`
/// carries), so an ONLINE old-key pane and a RECONNECTING one converge
/// identically, BY CONSTRUCTION: both see the old key with `aliasOf`
/// naming the new canonical id and the CANONICAL record's
/// ownerKind/terminalId/generation. Pre-r31 the live broadcast said
/// `ownerKind:"vacant", aliasOf:None` while the replay resolved the
/// same aliased key to the new canonical owner — identical
/// old-sessionRef panes converged differently depending on whether
/// they stayed online (owner/attach UI cleared) or reconnected (the
/// authoritative owner folded). The `alias_of` field's own contract
/// ("Set on the rekey transition's OLD-key mirror frame") is what
/// this frame now honors; the client's fold already follows aliases.
pub(crate) fn broadcast_rebind_alias_frame(
    state: &WsState,
    provider: &str,
    old_session_id: &str,
    operation_id: &str,
) {
    let Some(ownership) = state.ownership.as_ref() else {
        return;
    };
    // ONE resolve, ONE read — the replay's own fixpoint discipline
    // (delta round-3 F6): the record carries the canonical's
    // owner_kind/terminal_id/generation plus aliasOf naming the
    // canonical id.
    let Some(rec) = ownership
        .snapshot_records()
        .into_iter()
        .find(|rec| rec.provider == provider && rec.session_id == old_session_id)
    else {
        // No coordinator record for the old key (never occurs on a
        // committed rebind — the rekey wrote Aliased{to: new} in the
        // same scope): the honest vacant frame. A MISSING record has no
        // transition pair to mislabel (its observed generation is 0
        // and nothing can race a key that does not exist).
        broadcast_vacant_frame(
            state,
            provider,
            old_session_id,
            operation_id,
            ownership.boot_epoch(),
            ownership.observe(provider, old_session_id).generation,
        );
        return;
    };
    let frame = serde_json::to_string(&ServerMessage::SessionRuntimeOwner(
        freshell_protocol::SessionRuntimeOwner {
            provider: rec.provider,
            session_id: rec.session_id,
            epoch: rec.epoch,
            generation: rec.generation,
            owner_kind: rec.owner_kind,
            previous_kind: None,
            terminal_id: rec.terminal_id,
            operation_id: operation_id.to_string(),
            transition: "released".to_string(),
            reason: rec.reason.clone(),
            fenced: match rec.state {
                freshell_ownership::ReplayOwnerState::Fenced => Some(true),
                _ => None,
            },
            alias_of: rec.alias_of.clone(),
        },
    ))
    .unwrap_or_default();
    let _ = state.broadcast_tx.send(frame);
}

/// b8ke ext r14 F3: the VACANT owner frame — `ownerKind: "vacant"`, no
/// terminal id — the shape the client's convergence CLEARS on. The rebind's
/// old-key release and any superseded-key vacancy broadcast this shape (a
/// terminal-owner frame on a released key left old-key Fresh Agent panes
/// presenting the divergence card with a direct-attach action long after
/// the writer moved).
///
/// b8ke ext r32 F2: the frame carries ITS OWN transition's pair — the
/// (epoch, generation) captured at the release/commit_stop commit —
/// NEVER a re-observed current generation. If a lifecycle operation on
/// another device starts or completes between the commit and this
/// broadcast, a re-observed frame would carry the NEWER operation's
/// generation and the client (which accepts all same-generation
/// frames) would fold the vacant frame OVER the newer
/// `handoff-started`/live-owner state until another event or a
/// reconnect. The committed pair keeps the frame honestly labeled: the
/// client's fence discipline orders it as the older transition it is.
pub(crate) fn broadcast_vacant_frame(
    state: &WsState,
    provider: &str,
    session_id: &str,
    operation_id: &str,
    committed_epoch: u64,
    committed_generation: u64,
) {
    // The unwired check only — the frame's pair comes from the CALLER
    // (the committed transition's own), never an observation.
    if state.ownership.is_none() {
        return;
    }
    let frame = serde_json::to_string(&ServerMessage::SessionRuntimeOwner(
        freshell_protocol::SessionRuntimeOwner {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            epoch: committed_epoch,
            generation: committed_generation,
            owner_kind: "vacant".into(),
            previous_kind: None,
            terminal_id: None,
            operation_id: operation_id.to_string(),
            transition: "released".to_string(),
            reason: None,
            fenced: None,
            alias_of: None,
        },
    ))
    .unwrap_or_default();
    let _ = state.broadcast_tx.send(frame);
}

/// The owner frame broadcast (the `broadcast_owner` shape the handoff
/// runner uses, adapted to the WS state's broadcast bus).
/// b8ke ext r39 F1: the POST-COMMIT truth broadcast — the terminal owner
/// frame fires ONLY when the coordinator's current record still names
/// THIS terminal as the live owner. An unconditional terminal frame over
/// a moved-on record (a completed cross-kind handoff in the
/// commit-to-broadcast interval) would converge clients and durable
/// recovery state on the reaped terminal; the caller logs the suppressed
/// frame and takes the stale path (the identity homes hold a binding the
/// coordinator does not name). Returns `true` when the frame broadcast.
pub(crate) fn broadcast_owner_frame_if_authoritative(
    state: &WsState,
    ownership: &std::sync::Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    provider: &str,
    session_id: &str,
    terminal_id: &str,
    operation_id: &str,
    transition: &str,
) -> bool {
    let snapshot = ownership.observe(provider, session_id);
    match snapshot.state {
        freshell_ownership::OwnershipState::Live { ref owner, .. }
            if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
                && owner.terminal_id.as_deref() == Some(terminal_id) =>
        {
            broadcast_owner_frame(
                state,
                provider,
                session_id,
                terminal_id,
                operation_id,
                snapshot.generation,
                transition,
            );
            true
        }
        other => {
            tracing::warn!(target: "freshell_ws::identity_ownership",
                provider = %provider, session_id = %session_id,
                terminal_id = %terminal_id, state = ?other,
                "identity_owner_frame_suppressed: the coordinator does not name \
                 this terminal as the live owner — no terminal frame broadcast"
            );
            false
        }
    }
}

/// b8ke fence-heal: `pub(crate)` so the terminal lane's create-settle call
/// site (and the auto-resume respawn settle) can route their commit-to-Live
/// broadcasts through the SAME committed-pair helper — never through
/// `broadcast_owner_frame_if_authoritative` (it re-observes the generation;
/// the r32 F2 constraint forbids it for commit broadcasts).
pub(crate) fn broadcast_owner_frame(
    state: &WsState,
    provider: &str,
    session_id: &str,
    terminal_id: &str,
    operation_id: &str,
    generation: u64,
    transition: &str,
) {
    let Some(ownership) = state.ownership.as_ref() else {
        return;
    };
    let frame = serde_json::to_string(&ServerMessage::SessionRuntimeOwner(
        freshell_protocol::SessionRuntimeOwner {
            provider: provider.to_string(),
            session_id: session_id.to_string(),
            epoch: ownership.boot_epoch(),
            generation,
            owner_kind: "terminal".into(),
            previous_kind: None,
            terminal_id: Some(terminal_id.to_string()),
            operation_id: operation_id.to_string(),
            transition: transition.to_string(),
            reason: None,
            fenced: None,
            alias_of: None,
        },
    ))
    .unwrap_or_default();
    let _ = state.broadcast_tx.send(frame);
}

/// The Adopt-outcome helper for tests: whether the coordinator holds a live
/// terminal owner for the id naming THIS terminal.
#[cfg(test)]
pub(crate) fn holds_live_terminal_owner(
    ownership: &std::sync::Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    provider: &str,
    session_id: &str,
    terminal_id: &str,
) -> bool {
    match ownership.observe(provider, session_id).state {
        freshell_ownership::OwnershipState::Live { owner, .. } => {
            owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
                && owner.terminal_id.as_deref() == Some(terminal_id)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// The r39 race-test fixture: a full `WsState` with a WIRED ownership
    /// coordinator (the fields mirror `opencode_association`'s
    /// `state_with_locator`; no locator — the tests drive the coordinator
    /// identity phase directly, the entry all four identity lanes share).
    fn race_state(
        ownership: Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    ) -> (WsState, tokio::sync::broadcast::Receiver<String>) {
        let auth_token = Arc::new("s3cr3t-token-abcdef".to_string());
        let broadcast_tx = Arc::new(tokio::sync::broadcast::channel::<String>(16).0);
        let rx = broadcast_tx.subscribe();
        let state = WsState {
            pane_ledger: std::sync::Arc::new(crate::pane_ledger::PaneLedger::disabled()),
            layout: Default::default(),
            identity: crate::identity::TerminalIdentityRegistry::new(),
            terminal_meta: Default::default(),
            auth_token: Arc::clone(&auth_token),
            server_instance_id: Arc::new("srv-r39".to_string()),
            boot_id: Arc::new("boot-r39".to_string()),
            settings: Arc::new(crate::test_settings()),
            handshake_settings: Arc::new(tokio::sync::RwLock::new(crate::test_settings())),
            broadcast_tx: Arc::clone(&broadcast_tx),
            auto_resume_tx: tokio::sync::mpsc::unbounded_channel().0,
            auto_resume_cancels: Default::default(),
            fresh_codex: freshell_freshagent::FreshCodexState::new(
                Arc::clone(&auth_token),
                Arc::clone(&broadcast_tx),
                serde_json::json!({ "freshAgent": { "enabled": false } }),
            ),
            fresh_claude: freshell_freshagent::FreshClaudeState::new(Arc::clone(&broadcast_tx)),
            fresh_opencode: freshell_freshagent::FreshOpencodeState::new(
                freshell_freshagent::FreshAgentState::new(auth_token, broadcast_tx),
            ),
            registry: freshell_terminal::TerminalRegistry::new()
                .with_ownership(Arc::clone(&ownership)),
            shutdown: Arc::new(tokio::sync::Notify::new()),
            tabs: crate::tabs::TabsRegistry::new(),
            screenshots: crate::screenshot::ScreenshotBroker::new(state_broadcast_tx()),
            subagent_interest: Default::default(),
            host_stats: Default::default(),
            terminals_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
            sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
            cli_commands: Arc::new(Vec::new()),
            ping_interval_ms: 30_000,
            hello_timeout_ms: 5_000,
            allowed_origins: Arc::new(crate::origin::default_allowed_origins()),
            ws_max_payload_bytes: 16 * 1024 * 1024,
            term09: crate::backpressure::Term09Config::default(),
            create_protect: crate::create_limit::CreateProtectConfig::default(),
            spawn_gate: Arc::new(crate::spawn_gate::SpawnGate::new(4, 64)),
            shutdown_started: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            create_dedupe: Arc::new(crate::create_dedupe::CreateDedupe::default()),
            config_fallback: None,
            opencode_locator: None,
            codex_locator: None,
            activity: None,
            session_existence: Arc::new(crate::existence::NoIndexProbe::default()),
            reconcile_deferral_budget_ms: crate::reconcile::RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT,
            fresh_agent_respawn_counts: Default::default(),
            ownership: Some(ownership),
            units: Default::default(),
        };
        (state, rx)
    }

    fn state_broadcast_tx() -> Arc<tokio::sync::broadcast::Sender<String>> {
        Arc::new(tokio::sync::broadcast::channel::<String>(16).0)
    }

    const SID: &str = "ses_r39race00000000000000000";
    const TID: &str = "t-r39-race";

    fn seed_live_terminal_owner(ownership: &Arc<freshell_ownership::RuntimeOwnershipRegistry>) {
        let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_start(
            "codex",
            SID,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-r39-fixture-start",
            None,
            "test",
            1_000,
        ) else {
            panic!("fixture start grants")
        };
        assert_eq!(
            ownership.commit_live(
                "codex",
                SID,
                "op-r39-fixture-start",
                generation,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                    terminal_id: Some(TID.to_string()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: freshell_ownership::HoldKind::Main,
                },
            ),
            freshell_ownership::CommitOutcome::Committed
        );
    }

    fn commit_cross_kind_handoff(
        ownership: &Arc<freshell_ownership::RuntimeOwnershipRegistry>,
        op: &str,
    ) {
        let freshell_ownership::BeginOutcome::Granted { generation } = ownership.begin_handoff(
            "codex",
            SID,
            freshell_ownership::RuntimeOwnerKind::FreshAgent,
            op,
            None,
            "test",
            2_000,
        ) else {
            panic!("the racing cross-kind handoff must grant against the pre-arm key")
        };
        assert_eq!(
            ownership.commit_live(
                "codex",
                SID,
                op,
                generation,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("k-r39-race".to_string()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: freshell_ownership::HoldKind::Main,
                },
            ),
            freshell_ownership::CommitOutcome::Committed
        );
    }

    /// b8ke ext r39 F1: the re-adopt's PRE-ARM interval — the claim
    /// answered AdoptLive, the precheck snapshot observed THIS terminal's
    /// live record, and THEN a completed cross-kind handoff lands before
    /// the guard arms (the deterministic park seam — the interval the
    /// r12-era post-arm pauses never cover). The ATOMIC ADOPT validates
    /// the snapshot's observed pair + the expected owner in ONE
    /// coordinator decision: the raced association answers the typed
    /// refusal (no authority — the caller's identity homes mutate
    /// nothing, no terminal owner frame broadcasts over the Fresh
    /// Agent's session). Pre-r39 the generic guard armed on the NEW
    /// Fresh Agent owner (it accepts ANY Live owner) — the red/green
    /// proves the interval.
    #[tokio::test]
    async fn a_cross_kind_handoff_in_the_readopt_pre_arm_interval_refuses_typed() {
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let (state, mut rx) = race_state(ownership.clone());
        seed_live_terminal_owner(&ownership);

        // The park seam: between the precheck observation and the adopt.
        let parked = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        {
            let parked = Arc::clone(&parked);
            let release = Arc::clone(&release);
            state
                .registry
                .set_identity_readopt_pause_for_tests(Arc::new(
                    move |_provider: &str, _session_id: &str| {
                        let parked = Arc::clone(&parked);
                        let release = Arc::clone(&release);
                        Box::pin(async move {
                            parked.notify_one();
                            let _ = release.notified().await;
                        })
                    },
                ));
        }

        // The claim phase — parks INSIDE the re-adopt arm's interval.
        let st = state.clone();
        let task =
            tokio::spawn(
                async move { coordinator_begin_identity(&st, "codex", TID, SID, None).await },
            );
        parked.notified().await;

        // THE RACE: a completed cross-kind handoff in the snapshot-to-arm
        // interval (no guard window is open — the adopt has not armed).
        commit_cross_kind_handoff(&ownership, "op-r39-racing-handoff");

        release.notify_one();
        let authority = task.await.expect("the claim task must join");

        // GREEN: the atomic adopt refused typed — NO authority, so the
        // caller's four identity lanes mutate nothing and never reach the
        // commit phase.
        assert!(
            authority.is_none(),
            "the raced re-adopt must answer the typed refusal (no authority)"
        );
        // The Fresh Agent owner stays authoritative at the bumped
        // generation — the adopt never armed over it.
        assert!(matches!(
            ownership.observe("codex", SID).state,
            freshell_ownership::OwnershipState::Live { ref owner, .. }
                if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
        ));
        // No terminal owner frame broadcast over the Fresh Agent's
        // session (the claim phase alone broadcasts nothing).
        match rx.try_recv() {
            Ok(frame) => panic!("a refused re-adopt must broadcast nothing: {frame}"),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {}
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => {}
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
        }
        state.registry.clear_identity_readopt_pause_for_tests();
    }

    /// b8ke ext r39 F1: the commit-phase broadcast carries the
    /// coordinator's POST-COMMIT truth — the re-adopt commit drops its
    /// guard and then observes, so the broadcast decision is
    /// `broadcast_owner_frame_if_authoritative`'s contract: a record
    /// still naming THIS terminal broadcasts the terminal owner frame; a
    /// moved-on record (a completed cross-kind handoff in the
    /// drop-to-observe interval) suppresses the frame — never
    /// "terminal" broadcast over the Fresh Agent's session — and the
    /// caller takes the honest stale shape. Pre-r39 the commit
    /// broadcast the terminal owner unconditionally.
    #[tokio::test]
    async fn a_moved_on_readopt_commit_suppresses_the_terminal_owner_frame() {
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let (state, mut rx) = race_state(ownership.clone());
        seed_live_terminal_owner(&ownership);

        // The authoritative shape: the record names THIS terminal — the
        // frame broadcasts.
        assert!(
            broadcast_owner_frame_if_authoritative(
                &state,
                &ownership,
                "codex",
                SID,
                TID,
                "assoc-adopt-r39",
                "handoff-committed",
            ),
            "the authoritative record must broadcast"
        );
        let frame = rx.try_recv().expect("the terminal owner frame broadcasts");
        let value: serde_json::Value = serde_json::from_str(&frame).expect("json frame");
        assert_eq!(value["type"], "session.runtimeOwner");
        assert_eq!(value["ownerKind"], "terminal");
        assert_eq!(value["terminalId"], TID);

        // The moved-on shape: a completed cross-kind handoff in the
        // commit's drop-to-observe interval — NO frame over the Fresh
        // Agent's session.
        commit_cross_kind_handoff(&ownership, "op-r39-commit-race");
        assert!(
            !broadcast_owner_frame_if_authoritative(
                &state,
                &ownership,
                "codex",
                SID,
                TID,
                "assoc-adopt-r39",
                "handoff-committed",
            ),
            "the moved-on record must suppress the terminal owner frame"
        );
        match rx.try_recv() {
            Ok(frame) => panic!("the moved-on commit must not broadcast a terminal owner: {frame}"),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {}
            Err(tokio::sync::broadcast::error::TryRecvError::Closed) => {}
            Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => {}
        }
    }

    /// b8ke fence-heal (plan-review round 3, finding 1): the emission-time
    /// r32 F2 discriminator for `broadcast_owner_frame` — the frame carries
    /// the CALLER's committed pair, never a re-observed current generation.
    /// The deterministic probe mirrors the vacant-frame F2 test
    /// (`codex_association.rs`'s
    /// `broadcast_vacant_frame_carries_the_committed_pair_not_the_current_generation`):
    /// a key with NO record observes generation 0, while the caller-supplied
    /// pair says 7 — a re-observing emission would fold the current 0 over
    /// the transition's own 7 (the same defect that, on an ADVANCED key,
    /// would let an older transition's frame overwrite a newer lifecycle's
    /// state because the client accepts all same-generation frames). The
    /// end-to-end settle path cannot build this divergence deterministically
    /// (no transition can land between the commit and the same-handler-turn
    /// broadcast), so the discrimination lives HERE.
    #[tokio::test]
    async fn a_broadcast_owner_frame_carries_the_committed_pair_not_the_current_generation() {
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let (state, mut rx) = race_state(ownership.clone());
        while rx.try_recv().is_ok() {}

        let sid = "ses-fenceheal-f2-missing";
        assert_eq!(
            ownership.observe("codex", sid).generation,
            0,
            "fixture: the missing key's observed generation is 0"
        );
        broadcast_owner_frame(
            &state,
            "codex",
            sid,
            TID,
            "op-fenceheal-f2",
            7,
            "handoff-committed",
        );
        let frame = rx.try_recv().expect("the owner frame was broadcast");
        let value: serde_json::Value = serde_json::from_str(&frame).expect("json frame");
        assert_eq!(value["type"], "session.runtimeOwner");
        assert_eq!(
            value["generation"],
            serde_json::json!(7),
            "the owner frame carries the SUPPLIED committed pair's generation, \
             never the re-observed current generation: {value}"
        );
        assert_eq!(
            value["epoch"],
            serde_json::json!(ownership.boot_epoch()),
            "the owner frame carries the emitting coordinator's boot epoch: {value}"
        );
        assert_eq!(value["ownerKind"], "terminal");
        assert_eq!(value["terminalId"], TID);
        assert_eq!(value["transition"], "handoff-committed");
    }
}

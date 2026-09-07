//! Fresh-agent pane verdicts (P1.13, campaign §4.3): same verdict vocabulary
//! as terminals — attach (tracked live) / respawn (resumable via
//! provider-native resume) / dead_session (positively gone) / fresh — no new
//! states. All async work (session maps, probes) happens in the snapshot
//! builder (Task 13); this module is pure + sync so it stays legal inside
//! derive_verdicts' catch_unwind.
//!
//! Verdict-mapping caveats (V5/A8, documented here for future readers):
//! - Zero-turn codex threads have NO rollout file until the first PERSISTED
//!   user message (vendor deferred materialization, verified at rust-v0.145.0)
//!   ⇒ the probe answers Absent ⇒ verdict `fresh` (identity never observed)
//!   or `dead_session` (ledger already bound it). Acceptable either way:
//!   zero turns means there is no conversation content to lose.
//! - On-disk-but-index-invisible CLAUDE transcripts are the OPPOSITE
//!   asymmetry (kata 09v1): a claude transcript can exist on disk yet carry
//!   no cwd-bearing line (the e2e fixture creates a 0-byte file at session
//!   create; crash-window partial writes can leave the same shape), so the
//!   directory index's R10b gate excludes it and the warm index answers
//!   Absent — while the attach arm (freshell-freshagent claude_snapshot.rs)
//!   trusts raw file existence and would attempt resume on it. The
//!   IndexExistenceProbe (freshell-server existence.rs) therefore falls back
//!   to the attach arm's raw-file check (locate_transcript) before finalizing
//!   Absent for claude ⇒ Present ⇒ OnDisk ⇒ respawn, never dead_session.
//!   Do NOT re-extend the codex "acceptable either way" reasoning to claude:
//!   adjudicating dead a transcript the attach arm would try to resume is the
//!   two-arms-disagree bug this fix cures; if a resume genuinely cannot
//!   succeed (validated: the real CLI prompt-exits on unresumable ids), the
//!   pane converges to the honest, bounded dead_session{respawn_exhausted}
//!   via the respawn cap instead of a false session_not_on_disk.
//! - WATCH: codex `.jsonl.zst` cold-rollout compression (vendor feature,
//!   default-OFF today) would hide ≥7-day-old sessions from the `.jsonl`-only
//!   index walk ⇒ false Absent. Revisit if the vendor flag graduates.
//! - WATCH (narrowed by kata 09v1): CLAUDE_CONFIG_DIR/CLAUDE_HOME
//!   reader/writer split — the existence probe's claude Absent-fallback now
//!   reads the attach arm's FULL ordered candidate-root set
//!   (CLAUDE_CONFIG_DIR > CLAUDE_HOME > $HOME/.claude via
//!   locate_transcript), so RECONCILE verdicts no longer depend on the
//!   single-root index walk for file existence. The History index walk
//!   itself still reads one root; that residual listing exposure remains.

use freshell_protocol::{PaneVerdict, ReconcilePane, ReconcileVerdict, SessionLocator};

pub const FRESH_AGENT_RESPAWN_CAP: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FreshAgentPresence {
    Live,
    OnDisk,
    GoneObserved,
    NeverObserved,
    Unknown,
}
// B1 pre-decision (V9/A12): when B1's `SessionExistence::ProviderUnavailable`
// lands, it maps to FreshAgentPresence::Unknown (conservative: respawn-with-cap,
// never dead_session). Keep every SessionExistence match exhaustive, no catch-all.

#[derive(Debug, Clone, PartialEq)]
pub struct FreshAgentPaneFacts {
    pub presence: FreshAgentPresence,
    pub duplicate_of: Option<String>, // paneKey of the earlier pane claiming the same session
    pub respawn_exhausted: bool,
    /// G3 supersession terminus (V8/A14): when the claimed sessionRef resolved
    /// through the ledger's supersededBy chain to a DIFFERENT id, this is the
    /// terminus id — the verdict answers with it + `corrected: true`.
    pub resolved_session_id: Option<String>,
}

#[derive(Debug, Default)]
pub struct FreshAgentReconcileSnapshot {
    pub facts: std::collections::HashMap<String /* paneKey */, FreshAgentPaneFacts>,
}

/// The ONE async gathering pass per reconcile request (Task 13): session-map
/// liveness, disk existence, ledger supersession resolution, in-request
/// dedupe, and the respawn cap all condense into per-pane facts here, so
/// [`verdict_for_pane`] stays pure + sync inside derive_verdicts'
/// catch_unwind. Built ONCE per request and REUSED if deps are re-derived —
/// rebuilding would double-burn the respawn counter.
///
/// Respawn-cap rationale (V2/A7): the terminal donor counts actual process
/// exits within a liveness window and RESETS on survival
/// (`registry.rs:1271-1283`) — per-answer burning without decay would let 3
/// reloads kill a healthy session. Counting respawn ANSWERS with
/// reset-on-live means only a genuinely non-recovering loop trips the cap.
/// Residual A19 (accepted): the next-wave client's reconcile cadence is
/// unpinned — REVISIT the cap value/semantics when that client lands.
pub async fn build_snapshot(
    state: &crate::WsState,
    panes: &[ReconcilePane],
) -> FreshAgentReconcileSnapshot {
    let mut facts = std::collections::HashMap::new();
    let mut claimed: std::collections::HashMap<(String, String), String> =
        std::collections::HashMap::new();
    for pane in panes
        .iter()
        .filter(|p| p.kind.as_deref() == Some("fresh-agent"))
    {
        let Some(sref) = pane.session_ref.as_ref() else {
            continue; // verdict fn answers no_recoverable_identity
        };
        // G3 reader rule (V8/A14): resolve the CLAIM through the ledger's
        // supersession chain FIRST — dedupe, liveness, existence, and the
        // respawn counter all key on the TERMINUS id (lookup_by_session is
        // public + memory-only).
        let resolved = state
            .pane_ledger
            .lookup_by_session(&sref.provider, &sref.session_id)
            .filter(|r| r.corrected)
            .map(|r| r.row.session_id);
        let session_id = resolved.clone().unwrap_or_else(|| sref.session_id.clone());
        let key = (sref.provider.clone(), session_id.clone());
        if let Some(winner) = claimed.get(&key) {
            facts.insert(
                pane.pane_key.clone(),
                FreshAgentPaneFacts {
                    presence: FreshAgentPresence::Unknown,
                    duplicate_of: Some(winner.clone()),
                    respawn_exhausted: false,
                    resolved_session_id: resolved,
                },
            );
            continue;
        }
        claimed.insert(key.clone(), pane.pane_key.clone());
        let live = match sref.provider.as_str() {
            "codex" => state.fresh_codex.has_live_session(&session_id).await,
            "claude" => state.fresh_claude.has_live_session(&session_id).await,
            "opencode" => state.fresh_opencode.has_live_session(&session_id).await,
            _ => false,
        };
        use crate::existence::SessionExistence as E;
        let presence = if live {
            FreshAgentPresence::Live
        } else {
            // Exhaustive match, NO catch-all (B1 hardening). ProviderUnavailable
            // arm is the B4 pre-decision (V9/A12, module doc above): conservative
            // respawn-with-cap via Unknown, never dead_session.
            match state.session_existence.exists(&sref.provider, &session_id) {
                E::Present => FreshAgentPresence::OnDisk,
                E::ProviderUnavailable => FreshAgentPresence::Unknown,
                E::Absent => {
                    if state
                        .session_existence
                        .ever_observed(&sref.provider, &session_id)
                    {
                        FreshAgentPresence::GoneObserved
                    } else {
                        FreshAgentPresence::NeverObserved
                    }
                }
                E::Unknown => {
                    // The ledger is positive evidence the session existed.
                    if state.pane_ledger.ever_bound(&sref.provider, &session_id) {
                        FreshAgentPresence::OnDisk
                    } else {
                        FreshAgentPresence::Unknown
                    }
                }
            }
        };
        // Respawn cap (V2/A7 — reworked): count only answers that actually
        // come back `respawn`, and CLEAR the counter when presence resolves
        // Live (a successful respawn is OBSERVED as the session going live).
        // The counting lives HERE because for non-duplicate panes the verdict
        // is fully determined by presence: OnDisk/Unknown + !exhausted ⇒
        // respawn (see verdict_for_pane) — so "this answer will be respawn"
        // is known at increment time. Mutation stays in this async builder,
        // OUTSIDE derive_verdicts' catch_unwind.
        let respawn_exhausted = match presence {
            FreshAgentPresence::Live => {
                state
                    .fresh_agent_respawn_counts
                    .lock()
                    .expect("respawn counts poisoned")
                    .remove(&key); // reset-on-live
                false
            }
            FreshAgentPresence::OnDisk | FreshAgentPresence::Unknown => {
                let mut counts = state
                    .fresh_agent_respawn_counts
                    .lock()
                    .expect("respawn counts poisoned");
                let c = counts.entry(key).or_insert(0);
                if *c >= FRESH_AGENT_RESPAWN_CAP {
                    true // this answer becomes dead_session{respawn_exhausted}; no burn
                } else {
                    *c += 1; // this answer goes out as `respawn` — burn one
                    false
                }
            }
            FreshAgentPresence::GoneObserved | FreshAgentPresence::NeverObserved => false,
        };
        facts.insert(
            pane.pane_key.clone(),
            FreshAgentPaneFacts {
                presence,
                duplicate_of: None,
                respawn_exhausted,
                resolved_session_id: resolved,
            },
        );
    }
    FreshAgentReconcileSnapshot { facts }
}

/// The SINGLE PaneVerdict construction point in this module (B1-coexistence
/// hardening, V9/A12 — keep it that way).
fn base(pane: &ReconcilePane, verdict: ReconcileVerdict) -> PaneVerdict {
    PaneVerdict {
        pane_key: pane.pane_key.clone(),
        verdict,
        terminal_id: None,
        session_ref: None,
        corrected: None,
        reason: None,
        duplicate: None,
        runtime: None,
    }
}

pub fn verdict_for_pane(
    snapshot: Option<&FreshAgentReconcileSnapshot>,
    pane: &ReconcilePane,
) -> PaneVerdict {
    let Some(snapshot) = snapshot else {
        // Capability not negotiated: the frozen client keeps today's contract.
        let mut v = base(pane, ReconcileVerdict::Invalid);
        v.reason = Some("unsupported_kind".into());
        return v;
    };
    let Some(sref) = pane.session_ref.clone() else {
        let mut v = base(pane, ReconcileVerdict::Fresh);
        v.reason = Some("no_recoverable_identity".into());
        return v;
    };
    let Some(facts) = snapshot.facts.get(&pane.pane_key) else {
        let mut v = base(pane, ReconcileVerdict::Fresh);
        v.reason = Some("no_recoverable_identity".into());
        return v;
    };
    if let Some(winner) = &facts.duplicate_of {
        let mut v = base(pane, ReconcileVerdict::Fresh);
        v.reason = Some("duplicate_session_claim".into());
        v.duplicate = Some(winner.clone());
        return v;
    }
    // G3 reader rule (V8/A14): when the claim resolved through the ledger's
    // supersession chain, every echoed session_ref carries the TERMINUS id
    // and the verdict is marked corrected (never answer the retired ref).
    let (sref, corrected) = match &facts.resolved_session_id {
        Some(terminus) if *terminus != sref.session_id => (
            SessionLocator {
                provider: sref.provider.clone(),
                session_id: terminus.clone(),
            },
            Some(true),
        ),
        _ => (sref, None),
    };
    match facts.presence {
        FreshAgentPresence::Live => {
            let mut v = base(pane, ReconcileVerdict::Attach);
            v.session_ref = Some(sref);
            v.corrected = corrected;
            v
        }
        FreshAgentPresence::OnDisk | FreshAgentPresence::Unknown => {
            if facts.respawn_exhausted {
                let mut v = base(pane, ReconcileVerdict::DeadSession);
                v.reason = Some("respawn_exhausted".into());
                v.session_ref = Some(sref);
                v.corrected = corrected;
                v
            } else {
                let mut v = base(pane, ReconcileVerdict::Respawn);
                v.session_ref = Some(sref);
                v.corrected = corrected;
                v
            }
        }
        FreshAgentPresence::GoneObserved => {
            let mut v = base(pane, ReconcileVerdict::DeadSession);
            v.reason = Some("session_not_on_disk".into());
            v.session_ref = Some(sref);
            v.corrected = corrected;
            v
        }
        FreshAgentPresence::NeverObserved => {
            let mut v = base(pane, ReconcileVerdict::Fresh);
            v.reason = Some("identity_never_observed".into());
            v
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pane(key: &str, sref: Option<(&str, &str)>) -> ReconcilePane {
        ReconcilePane {
            pane_key: key.to_string(),
            kind: Some("fresh-agent".into()),
            mode: None,
            create_request_id: None,
            terminal_id: None,
            server_instance_id: None,
            session_ref: sref.map(|(provider, session_id)| SessionLocator {
                provider: provider.to_string(),
                session_id: session_id.to_string(),
            }),
            resume_session_id: None,
            status: None,
        }
    }

    fn snap(
        entries: &[(&str, FreshAgentPresence, Option<&str>, bool)],
    ) -> FreshAgentReconcileSnapshot {
        let mut snapshot = FreshAgentReconcileSnapshot::default();
        for (pane_key, presence, duplicate_of, respawn_exhausted) in entries {
            snapshot.facts.insert(
                pane_key.to_string(),
                FreshAgentPaneFacts {
                    presence: *presence,
                    duplicate_of: duplicate_of.map(|s| s.to_string()),
                    respawn_exhausted: *respawn_exhausted,
                    resolved_session_id: None,
                },
            );
        }
        snapshot
    }

    #[test]
    fn no_snapshot_means_capability_off_and_stays_invalid_unsupported() {
        let v = verdict_for_pane(None, &pane("p", Some(("claude", "s"))));
        assert_eq!(v.verdict, ReconcileVerdict::Invalid);
        assert_eq!(v.reason.as_deref(), Some("unsupported_kind"));
    }

    #[test]
    fn missing_session_ref_is_fresh_no_recoverable_identity() {
        let s = snap(&[]);
        let v = verdict_for_pane(Some(&s), &pane("p", None));
        assert_eq!(v.verdict, ReconcileVerdict::Fresh);
        assert_eq!(v.reason.as_deref(), Some("no_recoverable_identity"));
    }

    #[test]
    fn live_maps_to_attach_with_session_ref_echoed() {
        let s = snap(&[("p", FreshAgentPresence::Live, None, false)]);
        let v = verdict_for_pane(Some(&s), &pane("p", Some(("codex", "t1"))));
        assert_eq!(v.verdict, ReconcileVerdict::Attach);
        assert_eq!(v.session_ref.as_ref().unwrap().session_id, "t1");
        assert_eq!(v.terminal_id, None, "fresh-agent panes have no terminal id");
    }

    #[test]
    fn on_disk_maps_to_respawn() {
        let s = snap(&[("p", FreshAgentPresence::OnDisk, None, false)]);
        let v = verdict_for_pane(Some(&s), &pane("p", Some(("opencode", "ses_1"))));
        assert_eq!(v.verdict, ReconcileVerdict::Respawn);
        assert_eq!(v.session_ref.as_ref().unwrap().session_id, "ses_1");
    }

    #[test]
    fn gone_observed_maps_to_dead_session_not_on_disk() {
        let s = snap(&[("p", FreshAgentPresence::GoneObserved, None, false)]);
        let v = verdict_for_pane(Some(&s), &pane("p", Some(("claude", "gone"))));
        assert_eq!(v.verdict, ReconcileVerdict::DeadSession);
        assert_eq!(v.reason.as_deref(), Some("session_not_on_disk"));
        assert_eq!(
            v.session_ref.as_ref().unwrap().session_id,
            "gone",
            "claimed identity echoed for the error UI"
        );
    }

    #[test]
    fn never_observed_maps_to_fresh_identity_never_observed() {
        let s = snap(&[("p", FreshAgentPresence::NeverObserved, None, false)]);
        let v = verdict_for_pane(Some(&s), &pane("p", Some(("claude", "never"))));
        assert_eq!(v.verdict, ReconcileVerdict::Fresh);
        assert_eq!(v.reason.as_deref(), Some("identity_never_observed"));
    }

    #[test]
    fn unknown_prefers_respawn_over_memory_loss() {
        // Cost asymmetry: respawn on a gone session degrades gracefully via the
        // providers' native not-found fallbacks; fresh on a live-on-disk session
        // loses conversation memory permanently.
        let s = snap(&[("p", FreshAgentPresence::Unknown, None, false)]);
        let v = verdict_for_pane(Some(&s), &pane("p", Some(("codex", "warm"))));
        assert_eq!(v.verdict, ReconcileVerdict::Respawn);
    }

    #[test]
    fn duplicate_claim_yields_fresh_with_duplicate_marker() {
        let s = snap(&[("p2", FreshAgentPresence::OnDisk, Some("p1"), false)]);
        let v = verdict_for_pane(Some(&s), &pane("p2", Some(("codex", "t1"))));
        assert_eq!(v.verdict, ReconcileVerdict::Fresh);
        assert_eq!(v.reason.as_deref(), Some("duplicate_session_claim"));
        assert_eq!(v.duplicate.as_deref(), Some("p1"));
    }

    #[test]
    fn respawn_exhausted_yields_dead_session() {
        let s = snap(&[("p", FreshAgentPresence::OnDisk, None, true)]);
        let v = verdict_for_pane(Some(&s), &pane("p", Some(("codex", "t1"))));
        assert_eq!(v.verdict, ReconcileVerdict::DeadSession);
        assert_eq!(v.reason.as_deref(), Some("respawn_exhausted"));
    }

    #[test]
    fn superseded_claim_is_answered_from_the_chain_terminus_with_corrected() {
        // G3 reader rule (V8/A14): a client claiming a superseded ref is
        // answered from the chain terminus — never respawn the retired ref.
        // Facts built directly: presence OnDisk, resolved_session_id Some("t2").
        let mut s = snap(&[("p", FreshAgentPresence::OnDisk, None, false)]);
        s.facts.get_mut("p").unwrap().resolved_session_id = Some("t2".into());
        let v = verdict_for_pane(Some(&s), &pane("p", Some(("codex", "t1"))));
        assert_eq!(v.verdict, ReconcileVerdict::Respawn);
        assert_eq!(
            v.session_ref.as_ref().unwrap().session_id,
            "t2",
            "answer carries the terminus id, not the retired claim"
        );
        assert_eq!(v.corrected, Some(true));
    }
}

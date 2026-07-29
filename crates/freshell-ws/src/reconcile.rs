//! Reconciliation-handshake verdict derivation (design §5) — the pure,
//! read-only function behind `pane.reconcile.request`.
//!
//! One protocol replaces the N ad-hoc client-side latches: the client
//! *presents* its pane view; this module answers with an authoritative
//! per-pane verdict derived from the terminal registry × identity registry ×
//! disk session index. The derivation MUTATES NOTHING — receiving the same
//! request 1 or N times, on 1 or N sockets, is indistinguishable from
//! receiving it once (the idempotency keystone, §7.2).

use freshell_protocol::{PaneVerdict, ReconcilePane, ReconcileVerdict, SessionLocator};
use freshell_terminal::TerminalRegistry;

use crate::existence::{SessionExistence, SessionExistenceProbe};
use crate::identity::TerminalIdentityRegistry;

/// §4.3: an over-cap request is answered with `error{RECONCILE_TOO_LARGE}`,
/// never silently truncated.
pub const MAX_RECONCILE_PANES: usize = 200;

/// §5.3 row 5 default budget for the handler's ONE bounded deferral before
/// re-deriving verdicts once (council-pinned single deferral): when a
/// derivation comes back `error{index_warming}`, `handle_pane_reconcile`
/// waits at most this long, re-derives once, and answers — never loops.
pub const RECONCILE_DEFERRAL_BUDGET_MS_DEFAULT: u64 = 2000;

/// The read-only inputs of the derivation (§5.1) — all shared handles that
/// already live on [`crate::WsState`].
pub struct ReconcileDeps<'a> {
    pub registry: &'a TerminalRegistry,
    pub identity: &'a TerminalIdentityRegistry,
    pub existence: &'a dyn SessionExistenceProbe,
    /// Fresh-agent facts snapshot (campaign §4.3): `Some` only on a
    /// connection that negotiated `paneReconcileFreshAgentV1` AND presented
    /// fresh-agent panes; `None` keeps the frozen client's
    /// `invalid{unsupported_kind}` contract.
    pub fresh_agent: Option<&'a crate::reconcile_freshagent::FreshAgentReconcileSnapshot>,
}

/// Derive one verdict per presented pane, 1:1 by `paneKey`, order preserved
/// (§8 total cardinality: a malformed entry gets `invalid{reason}`, never
/// omission). Pure read — no server state is mutated.
pub fn derive_verdicts(deps: &ReconcileDeps<'_>, panes: &[ReconcilePane]) -> Vec<PaneVerdict> {
    let mut seen_keys: std::collections::HashSet<&str> = std::collections::HashSet::new();
    panes
        .iter()
        .map(|pane| {
            // §5.5 server-side contract enforcement: two panes in ONE request
            // carrying the same createRequestId would each drive a create —
            // flag the duplicate instead of emitting two actionable verdicts.
            if let Some(key) = pane.create_request_id.as_deref().filter(|k| !k.is_empty()) {
                if !seen_keys.insert(key) {
                    return invalid(pane, "duplicate_create_request_id");
                }
            }
            verdict_for_pane(deps, pane)
        })
        .collect()
}

fn invalid(pane: &ReconcilePane, reason: &str) -> PaneVerdict {
    PaneVerdict {
        pane_key: pane.pane_key.clone(),
        verdict: ReconcileVerdict::Invalid,
        terminal_id: None,
        session_ref: None,
        corrected: None,
        reason: Some(reason.to_string()),
        duplicate: None,
    }
}

fn base(pane: &ReconcilePane, verdict: ReconcileVerdict) -> PaneVerdict {
    PaneVerdict {
        pane_key: pane.pane_key.clone(),
        verdict,
        terminal_id: None,
        session_ref: None,
        corrected: None,
        reason: None,
        duplicate: None,
    }
}

/// `corrected: true` iff the server overrode a DIFFERING client claim (§5.2):
/// requires a claim to be present and the server's ref to be present and
/// different — the server-wins rule that retires the client's `matchScore`
/// guessing.
fn corrected_flag(claim: Option<&SessionLocator>, server: Option<&SessionLocator>) -> Option<bool> {
    match (claim, server) {
        (Some(c), Some(s)) if c != s => Some(true),
        _ => None,
    }
}

/// §5.2 `resolve_authoritative_ref`: server memory wins (even retired), then
/// the retired identity of the newest generation for the key — including the
/// registry-side `resume_session_id` path for REST-created resumes that never
/// reached the WS-owned identity registry (design assumption 1's acceptance
/// check) — then the client's claims, promoted by ONE uniform rule.
fn resolve_authoritative_ref(
    deps: &ReconcileDeps<'_>,
    pane: &ReconcilePane,
    key: &str,
) -> Option<SessionLocator> {
    // 1. Identity registry by the client's terminalId (retired entries included).
    if let Some(tid) = pane.terminal_id.as_deref() {
        if let Some(sref) = deps.identity.session_ref_for(tid) {
            return Some(sref);
        }
    }
    // 2. The newest generation (INCLUDING exited) for this key.
    if let Some(newest) = deps.registry.newest_by_create_request_id(key) {
        if let Some(sref) = deps.identity.session_ref_for(&newest) {
            return Some(sref);
        }
        // Crate-boundary path: REST-created resumes carry identity only on
        // the registry row (`IdentityProbeRow.resume_session_id`).
        if let Some(row) = deps.registry.probe(&newest) {
            if row.mode != "shell" {
                if let Some(rsid) = row.resume_session_id.filter(|s| !s.is_empty()) {
                    return Some(SessionLocator {
                        provider: row.mode,
                        session_id: rsid,
                    });
                }
            }
        }
    }
    // 3. The client's structured claim (validated against disk by the caller).
    if let Some(sref) = pane.session_ref.clone() {
        return Some(sref);
    }
    // 4. ONE uniform promotion rule.
    promoted_legacy_claim(pane)
}

/// §5.2's ONE uniform promotion rule: a legacy `mode` + `resumeSessionId`
/// pair IS a sessionRef claim — `{provider: mode, sessionId: resumeSessionId}`.
fn promoted_legacy_claim(pane: &ReconcilePane) -> Option<SessionLocator> {
    let mode = pane
        .mode
        .as_deref()
        .filter(|m| !m.is_empty() && *m != "shell")?;
    let rsid = pane
        .resume_session_id
        .as_deref()
        .filter(|s| !s.is_empty())?;
    Some(SessionLocator {
        provider: mode.to_string(),
        session_id: rsid.to_string(),
    })
}

fn attach(
    deps: &ReconcileDeps<'_>,
    pane: &ReconcilePane,
    terminal_id: String,
    duplicate: Option<String>,
) -> PaneVerdict {
    let server_ref = deps.identity.session_ref_for(&terminal_id);
    let corrected = corrected_flag(pane.session_ref.as_ref(), server_ref.as_ref());
    PaneVerdict {
        terminal_id: Some(terminal_id),
        session_ref: server_ref,
        corrected,
        duplicate,
        ..base(pane, ReconcileVerdict::Attach)
    }
}

/// Council rule 6: the live terminal (if any) currently carrying this CLAIMED
/// sessionRef — consulted across BOTH identity stores, mirroring
/// [`resolve_authoritative_ref`]'s dual-source read: the ws-owned identity
/// registry (live entries, re-verified against registry liveness so a stale
/// un-retired entry never produces a phantom attach), then the registry-row
/// join (REST-created resumes whose identity never reached the identity
/// registry across the crate boundary).
fn live_terminal_for_claimed_ref(
    deps: &ReconcileDeps<'_>,
    claim: &SessionLocator,
) -> Option<String> {
    if let Some(entry) = deps
        .identity
        .find_by_session(&claim.provider, &claim.session_id)
    {
        if deps.registry.is_live(&entry.terminal_id) {
            return Some(entry.terminal_id);
        }
    }
    deps.registry.live_terminal_for_session_ref(claim)
}

fn verdict_for_pane(deps: &ReconcileDeps<'_>, pane: &ReconcilePane) -> PaneVerdict {
    // §5.3 row 10 protocol hygiene: malformed entries get an explicit reason.
    if pane.pane_key.is_empty() {
        return invalid(pane, "missing_pane_key");
    }
    match pane.kind.as_deref() {
        Some("terminal") => {}
        Some("fresh-agent") => {
            return crate::reconcile_freshagent::verdict_for_pane(deps.fresh_agent, pane)
        }
        Some(_) => return invalid(pane, "unsupported_kind"),
        None => return invalid(pane, "missing_kind"),
    }
    let Some(key) = pane
        .create_request_id
        .as_deref()
        .filter(|k| !k.is_empty())
        .map(str::to_string)
    else {
        return invalid(pane, "missing_create_request_id");
    };

    // Council rule 6 (sessionRef-level single-flight, reconcile side): a
    // live terminal ALREADY carrying the claimed sessionRef wins over
    // createRequestId keying — every other client's claim for the same ref
    // (regardless of createRequestId) attaches to the winner, never a
    // respawn that would open a second JSONL writer (D8). The effective
    // claim is the structured `sessionRef`, or the legacy `mode` +
    // `resumeSessionId` pair promoted by §5.2's ONE uniform rule — a
    // legacy-claiming client must not bypass this branch.
    if let Some(claim) = pane
        .session_ref
        .clone()
        .or_else(|| promoted_legacy_claim(pane))
    {
        if let Some(tid) = live_terminal_for_claimed_ref(deps, &claim) {
            let server_ref = deps
                .identity
                .session_ref_for(&tid)
                .or_else(|| Some(claim.clone()));
            let corrected = corrected_flag(Some(&claim), server_ref.as_ref());
            return PaneVerdict {
                terminal_id: Some(tid),
                session_ref: server_ref,
                corrected,
                ..base(pane, ReconcileVerdict::Attach)
            };
        }
    }

    // Rows 1/2/2b: any LIVE terminal wins.
    let t1 = deps.registry.newest_live_by_create_request_id(&key);
    let t2 = pane
        .terminal_id
        .as_deref()
        .filter(|tid| deps.registry.is_live(tid))
        .map(str::to_string);
    match (t1, t2) {
        // Row 2b (invariant I6): the client is live-attached to T while a
        // newer duplicate generation T′ exists for the same key — keep the
        // client on T, flag T′, never silently switch.
        (Some(t1), Some(t2)) if t1 != t2 => return attach(deps, pane, t2, Some(t1)),
        (Some(t1), _) => return attach(deps, pane, t1, None),
        (None, Some(t2)) => return attach(deps, pane, t2, None),
        (None, None) => {}
    }

    // No live terminal for this key — recover a retired identity if one exists.
    let Some(sref) = resolve_authoritative_ref(deps, pane, &key) else {
        // Row 8: shells are stateless by design; row 9: CLI with nothing to
        // resume becomes an explicit, labeled fresh — never a surprise.
        if pane.mode.as_deref() == Some("shell") {
            return base(pane, ReconcileVerdict::Fresh);
        }
        return PaneVerdict {
            reason: Some("no_recoverable_identity".to_string()),
            ..base(pane, ReconcileVerdict::Fresh)
        };
    };

    match deps.existence.exists(&sref.provider, &sref.session_id) {
        SessionExistence::Present => {
            // §7.5: a respawn ↔ instant-exit loop converges to a terminal,
            // actionable dead_session instead of thrashing forever.
            if deps.registry.respawn_exhausted(&key) {
                return PaneVerdict {
                    session_ref: Some(sref),
                    reason: Some("respawn_exhausted".to_string()),
                    ..base(pane, ReconcileVerdict::DeadSession)
                };
            }
            let corrected = corrected_flag(pane.session_ref.as_ref(), Some(&sref));
            PaneVerdict {
                session_ref: Some(sref),
                corrected,
                ..base(pane, ReconcileVerdict::Respawn)
            }
        }
        SessionExistence::Absent => {
            // Launcher-assigned amplifier identity: a missing session dir is
            // never a dead state for amplifier. The broker guarantees a
            // resume of this id is viable again — both spawn doors run
            // `amplifier_stub::ensure_session` (ensure-after-GC) before
            // spawning, re-stubbing the SAME id. Without this arm, the
            // DESIGNED never-used-stub GC at terminal exit/shutdown would
            // park every never-typed pane in the dead-sessions dialog on the
            // next boot instead of restoring it. §7.5's respawn_exhausted
            // convergence still applies — a respawn ↔ instant-exit loop ends
            // in an actionable dead_session, never thrash.
            if sref.provider == "amplifier" {
                if deps.registry.respawn_exhausted(&key) {
                    return PaneVerdict {
                        session_ref: Some(sref),
                        reason: Some("respawn_exhausted".to_string()),
                        ..base(pane, ReconcileVerdict::DeadSession)
                    };
                }
                let corrected = corrected_flag(pane.session_ref.as_ref(), Some(&sref));
                return PaneVerdict {
                    session_ref: Some(sref),
                    corrected,
                    ..base(pane, ReconcileVerdict::Respawn)
                };
            }
            // dead_session is gated on the identity having been SEEN on disk
            // at least once — never a data-loss-shaped verdict for an
            // identity disk has no memory of (§5.3 rows 4/4b).
            if deps
                .existence
                .ever_observed(&sref.provider, &sref.session_id)
            {
                PaneVerdict {
                    session_ref: Some(sref),
                    reason: Some("session_not_on_disk".to_string()),
                    ..base(pane, ReconcileVerdict::DeadSession)
                }
            } else {
                PaneVerdict {
                    reason: Some("identity_never_observed".to_string()),
                    ..base(pane, ReconcileVerdict::Fresh)
                }
            }
        }
        SessionExistence::Unknown => PaneVerdict {
            reason: Some("index_warming".to_string()),
            ..base(pane, ReconcileVerdict::Error)
        },
        // A known provider with no home on this machine is NOT warming — the
        // honest, immediate provider_unavailable (the handler's single
        // deferral fires only on index_warming, `terminal.rs`).
        SessionExistence::ProviderUnavailable => PaneVerdict {
            reason: Some("provider_unavailable".to_string()),
            ..base(pane, ReconcileVerdict::Error)
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_terminal::registry::HeadlessTerminal;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// §5.1 test fake: per-key existence answers + an observed-history set.
    #[derive(Default)]
    struct FakeProbe {
        answers: Mutex<HashMap<String, SessionExistence>>,
        observed: Mutex<std::collections::HashSet<String>>,
    }

    impl FakeProbe {
        fn set(&self, provider: &str, session_id: &str, existence: SessionExistence) {
            self.answers
                .lock()
                .unwrap()
                .insert(format!("{provider}:{session_id}"), existence);
            if existence == SessionExistence::Present {
                self.observed
                    .lock()
                    .unwrap()
                    .insert(format!("{provider}:{session_id}"));
            }
        }

        fn mark_observed(&self, provider: &str, session_id: &str) {
            self.observed
                .lock()
                .unwrap()
                .insert(format!("{provider}:{session_id}"));
        }
    }

    impl SessionExistenceProbe for FakeProbe {
        fn exists(&self, provider: &str, session_id: &str) -> SessionExistence {
            *self
                .answers
                .lock()
                .unwrap()
                .get(&format!("{provider}:{session_id}"))
                .unwrap_or(&SessionExistence::Absent)
        }

        fn ever_observed(&self, provider: &str, session_id: &str) -> bool {
            self.observed
                .lock()
                .unwrap()
                .contains(&format!("{provider}:{session_id}"))
        }
    }

    struct Fixture {
        registry: TerminalRegistry,
        identity: TerminalIdentityRegistry,
        probe: FakeProbe,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                registry: TerminalRegistry::new(),
                identity: TerminalIdentityRegistry::new(),
                probe: FakeProbe::default(),
            }
        }

        fn deps(&self) -> ReconcileDeps<'_> {
            ReconcileDeps {
                registry: &self.registry,
                identity: &self.identity,
                existence: &self.probe,
                fresh_agent: None,
            }
        }

        fn headless(&self, id: &str, key: Option<&str>, mode: &str, created_at: i64) {
            self.registry.register_headless(HeadlessTerminal {
                terminal_id: id.to_string(),
                stream_id: format!("S-{id}"),
                mode: mode.to_string(),
                resume_session_id: None,
                create_request_id: key.map(str::to_string),
                created_at: Some(created_at),
            });
        }

        fn one(&self, pane: ReconcilePane) -> PaneVerdict {
            let verdicts = derive_verdicts(&self.deps(), &[pane]);
            assert_eq!(verdicts.len(), 1);
            verdicts.into_iter().next().unwrap()
        }
    }

    fn pane(key: &str) -> ReconcilePane {
        ReconcilePane {
            pane_key: format!("pk-{key}"),
            kind: Some("terminal".to_string()),
            mode: Some("claude".to_string()),
            create_request_id: Some(key.to_string()),
            terminal_id: None,
            server_instance_id: None,
            session_ref: None,
            resume_session_id: None,
            status: None,
        }
    }

    fn sref(provider: &str, id: &str) -> SessionLocator {
        SessionLocator {
            provider: provider.to_string(),
            session_id: id.to_string(),
        }
    }

    // --- decision table §5.3 --------------------------------------------

    /// Row 1: a live terminal under this createRequestId wins over anything
    /// the client claims (closes the interrupted-respawn orphan).
    #[test]
    fn row1_live_terminal_under_key_yields_attach() {
        let f = Fixture::new();
        f.headless("T-live", Some("cr-1"), "claude", 1_000);
        f.identity
            .upsert("T-live", Some("claude"), Some("s-1"), None, 1);

        let mut p = pane("cr-1");
        p.terminal_id = Some("T-stale-handle".to_string()); // dead handle
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Attach);
        assert_eq!(v.terminal_id.as_deref(), Some("T-live"));
        assert_eq!(v.session_ref, Some(sref("claude", "s-1")));
    }

    /// Row 2: no match by key, but the presented terminalId is live →
    /// attach(T) with the server's corrected identity.
    #[test]
    fn row2_live_presented_terminal_yields_attach_with_corrected_ref() {
        let f = Fixture::new();
        f.headless("T-2", None, "claude", 1_000);
        f.identity
            .upsert("T-2", Some("claude"), Some("s-real"), None, 1);

        let mut p = pane("cr-2");
        p.terminal_id = Some("T-2".to_string());
        p.session_ref = Some(sref("claude", "s-wrong")); // contradicting claim
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Attach);
        assert_eq!(v.terminal_id.as_deref(), Some("T-2"));
        assert_eq!(v.session_ref, Some(sref("claude", "s-real")));
        assert_eq!(v.corrected, Some(true), "server overrode a differing claim");
    }

    /// Row 2b (§9.1 test 12, invariant I6): live-attached T + newer duplicate
    /// T′ for the same key → keep the client on T, flag T′, never switch.
    #[test]
    fn row2b_both_live_prefers_clients_terminal_and_flags_duplicate() {
        let f = Fixture::new();
        f.headless("T-mine", Some("cr-2b"), "claude", 1_000);
        f.headless("T-newer", Some("cr-2b"), "claude", 2_000);

        let mut p = pane("cr-2b");
        p.terminal_id = Some("T-mine".to_string());
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Attach);
        assert_eq!(
            v.terminal_id.as_deref(),
            Some("T-mine"),
            "never silently switch a live attachment"
        );
        assert_eq!(v.duplicate.as_deref(), Some("T-newer"));
    }

    /// Row 3 (+ §9.1 test 11): terminal exited; its RETIRED identity drives
    /// respawn when the session is Present on disk.
    #[test]
    fn row3_exited_terminal_with_retired_identity_yields_respawn() {
        let f = Fixture::new();
        f.headless("T-3", Some("cr-3"), "claude", 1_000);
        f.identity
            .upsert("T-3", Some("claude"), Some("s-3"), None, 1);
        f.registry.finish_pty_exit("T-3", 0);
        f.identity.retire("T-3");
        f.probe.set("claude", "s-3", SessionExistence::Present);

        let mut p = pane("cr-3");
        p.terminal_id = Some("T-3".to_string());
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Respawn);
        assert_eq!(v.session_ref, Some(sref("claude", "s-3")));
    }

    /// §9.1 test 11 second half + row 4b: an identity the index has NEVER
    /// observed → fresh(identity_never_observed), never dead_session.
    #[test]
    fn row4b_never_observed_identity_yields_fresh_not_dead_session() {
        let f = Fixture::new();
        let mut p = pane("cr-4b");
        p.session_ref = Some(sref("claude", "s-typo"));
        // Probe default: Absent + never observed.
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Fresh);
        assert_eq!(v.reason.as_deref(), Some("identity_never_observed"));
    }

    /// Row 4/7: Absent but EVER seen on disk → explicit dead_session.
    #[test]
    fn row4_absent_but_ever_observed_yields_dead_session() {
        let f = Fixture::new();
        f.probe.mark_observed("claude", "s-gone");
        let mut p = pane("cr-4");
        p.session_ref = Some(sref("claude", "s-gone"));
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::DeadSession);
        assert_eq!(v.reason.as_deref(), Some("session_not_on_disk"));
        assert_eq!(
            v.session_ref,
            Some(sref("claude", "s-gone")),
            "dead_session carries the claimed-but-missing identity for the error UI"
        );
    }

    /// Launcher-assigned amplifier identity: a missing session dir is never
    /// a dead state for amplifier — the respawn door re-stubs the SAME id
    /// before spawning (`amplifier_stub::ensure_session`, ensure-after-GC,
    /// `terminal.rs`), so Absent (even ever-observed: the DESIGNED
    /// never-used-stub GC at terminal exit/shutdown removes the dir while
    /// the pane's persisted sessionRef lives on) yields Respawn, never
    /// dead_session.
    #[test]
    fn amplifier_absent_even_observed_yields_respawn_not_dead_session() {
        let f = Fixture::new();
        f.probe.mark_observed("amplifier", "s-gcd");
        let mut p = pane("cr-amp");
        p.mode = Some("amplifier".to_string());
        p.session_ref = Some(sref("amplifier", "s-gcd"));
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Respawn);
        assert_eq!(v.session_ref, Some(sref("amplifier", "s-gcd")));
    }

    /// Row 5 (§9.1 test 6): cold index on a known provider → honest
    /// error{index_warming}, never dead_session, never optimistic respawn.
    /// (`retry` is deleted from the wire; the handler's bounded single
    /// deferral is the recovery attempt, `terminal.rs`.)
    #[test]
    fn row5_unknown_existence_yields_error_index_warming() {
        let f = Fixture::new();
        f.probe.set("claude", "s-cold", SessionExistence::Unknown);
        let mut p = pane("cr-5");
        p.session_ref = Some(sref("claude", "s-cold"));
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Error);
        assert_eq!(v.reason.as_deref(), Some("index_warming"));
    }

    /// A known provider whose session root does not exist on this machine →
    /// immediate error{provider_unavailable} — never index_warming (which
    /// would trigger the handler's deferral), never dead_session.
    #[test]
    fn provider_unavailable_existence_yields_error_provider_unavailable() {
        let f = Fixture::new();
        f.probe
            .set("codex", "s-pu", SessionExistence::ProviderUnavailable);
        let mut p = pane("cr-pu");
        p.mode = Some("codex".to_string());
        p.session_ref = Some(sref("codex", "s-pu"));
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Error);
        assert_eq!(v.reason.as_deref(), Some("provider_unavailable"));
    }

    /// Row 6: no terminalId at all, just a claim that IS on disk → respawn
    /// (restore-after-persist-cycle). The claim matched, so no `corrected`.
    #[test]
    fn row6_claim_present_on_disk_yields_respawn_without_corrected() {
        let f = Fixture::new();
        f.probe.set("codex", "s-6", SessionExistence::Present);
        let mut p = pane("cr-6");
        p.mode = Some("codex".to_string());
        p.session_ref = Some(sref("codex", "s-6"));
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Respawn);
        assert_eq!(v.session_ref, Some(sref("codex", "s-6")));
        assert_eq!(v.corrected, None);
    }

    /// Row 8: shells are stateless by design — plain fresh.
    #[test]
    fn row8_shell_pane_with_nothing_yields_fresh() {
        let f = Fixture::new();
        let mut p = pane("cr-8");
        p.mode = Some("shell".to_string());
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Fresh);
        assert_eq!(v.reason, None);
    }

    /// Row 9: CLI pane with no recoverable identity — an explicit, labeled
    /// fresh (never a surprise grey pane).
    #[test]
    fn row9_cli_pane_with_no_identity_yields_labeled_fresh() {
        let f = Fixture::new();
        let v = f.one(pane("cr-9"));
        assert_eq!(v.verdict, ReconcileVerdict::Fresh);
        assert_eq!(v.reason.as_deref(), Some("no_recoverable_identity"));
    }

    /// Row 10: malformed entries → invalid{reason}, never omission.
    #[test]
    fn row10_malformed_entries_yield_invalid_with_reasons() {
        let f = Fixture::new();

        let mut no_key = pane("cr-10a");
        no_key.pane_key = String::new();
        assert_eq!(f.one(no_key).reason.as_deref(), Some("missing_pane_key"));

        let mut no_crid = pane("cr-10b");
        no_crid.create_request_id = None;
        let v = f.one(no_crid);
        assert_eq!(v.verdict, ReconcileVerdict::Invalid);
        assert_eq!(v.reason.as_deref(), Some("missing_create_request_id"));

        let mut bad_kind = pane("cr-10c");
        bad_kind.kind = Some("browser".to_string());
        let v = f.one(bad_kind);
        assert_eq!(v.verdict, ReconcileVerdict::Invalid);
        assert_eq!(v.reason.as_deref(), Some("unsupported_kind"));
    }

    // --- beyond the table: §9.1-named tests -------------------------------

    /// §9.1 test 3: N panes in → N verdicts out, paneKey echoed VERBATIM
    /// (hostile strings included), order preserved.
    #[test]
    fn cardinality_and_opacity_hold_for_hostile_pane_keys() {
        let f = Fixture::new();
        let hostile = r#"tab"3:\pane {}</script> 💥 \u0000"#;
        let mut p1 = pane("cr-a");
        p1.pane_key = hostile.to_string();
        let p2 = pane("cr-b");
        let mut p3 = pane("cr-c");
        p3.create_request_id = None; // malformed — still answered

        let verdicts = derive_verdicts(&f.deps(), &[p1, p2, p3]);
        assert_eq!(verdicts.len(), 3);
        assert_eq!(verdicts[0].pane_key, hostile);
        assert_eq!(verdicts[1].pane_key, "pk-cr-b");
        assert_eq!(verdicts[2].verdict, ReconcileVerdict::Invalid);
    }

    /// §9.1 test 4a (derivation half): the derivation is a deterministic pure
    /// read — the same request twice yields identical verdicts.
    #[test]
    fn same_request_twice_yields_identical_verdicts() {
        let f = Fixture::new();
        f.headless("T-idem", Some("cr-idem"), "claude", 1_000);
        f.identity
            .upsert("T-idem", Some("claude"), Some("s-i"), None, 1);
        let panes = vec![pane("cr-idem"), pane("cr-other")];
        let first = derive_verdicts(&f.deps(), &panes);
        let second = derive_verdicts(&f.deps(), &panes);
        assert_eq!(first, second);
    }

    /// §9.1 test 9 (spawn-failed / exited exclusion): a key whose only
    /// generations have EXITED must re-derive respawn/fresh — never a phantom
    /// attach to a dead handle.
    #[test]
    fn exited_only_generations_never_yield_attach() {
        let f = Fixture::new();
        f.headless("T-dead", Some("cr-dead"), "claude", 1_000);
        f.registry.finish_pty_exit("T-dead", 1);
        let v = f.one(pane("cr-dead"));
        assert_ne!(v.verdict, ReconcileVerdict::Attach);
    }

    /// §9.1 test 14 (§5.5 contract): duplicate createRequestId within ONE
    /// request — the duplicate is flagged invalid, the first is answered.
    #[test]
    fn duplicate_create_request_id_in_one_request_is_flagged() {
        let f = Fixture::new();
        let mut p1 = pane("cr-dup");
        p1.pane_key = "first".to_string();
        let mut p2 = pane("cr-dup");
        p2.pane_key = "second".to_string();
        let verdicts = derive_verdicts(&f.deps(), &[p1, p2]);
        assert_ne!(verdicts[0].verdict, ReconcileVerdict::Invalid);
        assert_eq!(verdicts[1].verdict, ReconcileVerdict::Invalid);
        assert_eq!(
            verdicts[1].reason.as_deref(),
            Some("duplicate_create_request_id")
        );
    }

    /// §9.1 test 15 (§7.5): the respawn-generation cap converts an infinite
    /// respawn loop into dead_session(respawn_exhausted); the healthy-reset
    /// half lives in `freshell-terminal`'s cap tests.
    #[test]
    fn respawn_exhausted_key_yields_dead_session_not_another_respawn() {
        let f = Fixture::new();
        f.registry.set_respawn_liveness_window_ms(60_000);
        f.registry.set_respawn_generation_cap(2);
        f.probe.set("claude", "s-loop", SessionExistence::Present);
        for gen in 1..=2 {
            let id = format!("T-loop{gen}");
            f.headless(&id, Some("cr-loop"), "claude", now_ms_for_test());
            f.identity
                .upsert(&id, Some("claude"), Some("s-loop"), None, gen);
            f.registry.finish_pty_exit(&id, 1);
            f.identity.retire(&id);
        }
        let v = f.one(pane("cr-loop"));
        assert_eq!(v.verdict, ReconcileVerdict::DeadSession);
        assert_eq!(v.reason.as_deref(), Some("respawn_exhausted"));
        assert_eq!(v.session_ref, Some(sref("claude", "s-loop")));
    }

    /// Design assumption 1's Phase-1 ACCEPTANCE CHECK: a REST-created resumed
    /// terminal (registry-side `resume_session_id`, NO identity-registry
    /// entry) reconciles to respawn with the correct sessionRef — the
    /// derivation reads identity across the crate boundary.
    #[test]
    fn rest_created_resume_resolves_identity_from_registry_row() {
        let f = Fixture::new();
        f.registry.register_headless(HeadlessTerminal {
            terminal_id: "T-rest".to_string(),
            stream_id: "S-rest".to_string(),
            mode: "codex".to_string(),
            resume_session_id: Some("s-rest".to_string()),
            create_request_id: Some("cr-rest".to_string()),
            created_at: Some(1_000),
        });
        // NO identity-registry entry — the WS-owned registry never saw this
        // create. The terminal has exited (server restart shape).
        f.registry.finish_pty_exit("T-rest", 0);
        f.probe.set("codex", "s-rest", SessionExistence::Present);

        let mut p = pane("cr-rest");
        p.mode = Some("codex".to_string());
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Respawn);
        assert_eq!(
            v.session_ref,
            Some(sref("codex", "s-rest")),
            "identity must resolve via the registry-side resume_session_id"
        );
    }

    /// Council rule 6, registry-row half: a REST-created LIVE terminal whose
    /// identity lives ONLY on the registry row (resume_session_id, no
    /// identity-registry entry) still answers a different client's claim for
    /// the same sessionRef with attach{its terminalId} — never a second
    /// writer (D8).
    #[test]
    fn cross_client_claim_attaches_to_live_rest_created_terminal() {
        let f = Fixture::new();
        f.registry.register_headless(HeadlessTerminal {
            terminal_id: "T-rest-live".to_string(),
            stream_id: "S-rest-live".to_string(),
            mode: "codex".to_string(),
            resume_session_id: Some("s-shared".to_string()),
            create_request_id: Some("cr-WINNER".to_string()),
            created_at: Some(1_000),
        });
        // Session Present on disk — the D8 shape would otherwise be respawn.
        f.probe.set("codex", "s-shared", SessionExistence::Present);

        let mut p = pane("cr-OTHER");
        p.mode = Some("codex".to_string());
        p.session_ref = Some(sref("codex", "s-shared"));
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Attach);
        assert_eq!(v.terminal_id.as_deref(), Some("T-rest-live"));
        assert_eq!(v.session_ref, Some(sref("codex", "s-shared")));
        assert_eq!(v.corrected, None, "the claim matched server truth");
    }

    /// Council rule 6, legacy-claim half: §5.2's ONE uniform promotion rule
    /// applies BEFORE the sessionRef-attach lookup — a pane claiming only the
    /// legacy `mode` + `resumeSessionId` pair (NO structured sessionRef)
    /// whose session is carried by a live terminal under a DIFFERENT
    /// createRequestId attaches to that terminal, never the D8 respawn that
    /// would open a second JSONL writer.
    #[test]
    fn legacy_resume_claim_attaches_to_live_terminal_across_create_request_ids() {
        let f = Fixture::new();
        f.registry.register_headless(HeadlessTerminal {
            terminal_id: "T-legacy-live".to_string(),
            stream_id: "S-legacy-live".to_string(),
            mode: "codex".to_string(),
            resume_session_id: Some("s-legacy".to_string()),
            create_request_id: Some("cr-WINNER".to_string()),
            created_at: Some(1_000),
        });
        // Session Present on disk — the fall-through path would derive the
        // D8 respawn.
        f.probe.set("codex", "s-legacy", SessionExistence::Present);

        let mut p = pane("cr-OTHER");
        p.mode = Some("codex".to_string());
        p.resume_session_id = Some("s-legacy".to_string()); // legacy claim only
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Attach);
        assert_eq!(v.terminal_id.as_deref(), Some("T-legacy-live"));
        assert_eq!(v.session_ref, Some(sref("codex", "s-legacy")));
        assert_eq!(
            v.corrected, None,
            "a matching promoted claim is not a correction"
        );
    }

    /// §9.1 test 8 trust boundary, respawn shape: the claim contradicts the
    /// retired server identity → server ref + corrected: true.
    #[test]
    fn contradicting_claim_is_corrected_on_respawn() {
        let f = Fixture::new();
        f.headless("T-tb", Some("cr-tb"), "claude", 1_000);
        f.identity
            .upsert("T-tb", Some("claude"), Some("s-server"), None, 1);
        f.registry.finish_pty_exit("T-tb", 0);
        f.identity.retire("T-tb");
        f.probe.set("claude", "s-server", SessionExistence::Present);

        let mut p = pane("cr-tb");
        p.terminal_id = Some("T-tb".to_string());
        p.session_ref = Some(sref("claude", "s-client-guess"));
        let v = f.one(p);
        assert_eq!(v.verdict, ReconcileVerdict::Respawn);
        assert_eq!(v.session_ref, Some(sref("claude", "s-server")));
        assert_eq!(v.corrected, Some(true));
    }

    fn now_ms_for_test() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

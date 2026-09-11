//! Conservative **disposal** side of the sidecar lifecycle (katas ynfn/da92):
//! the tree-aware verified kill helper (Task 6) and the boot-time reap sweep
//! over the [`SidecarReconciler`]'s unclaimed survivors (Task 9).
//!
//! Sibling of [`crate::sidecar_reconcile`] (the pre-authorized split: the
//! reconcile module sits at its 1,000-line ceiling, the `runtime_select.rs`
//! precedent from Task 7): the reconciler owns boot/claim; this module owns
//! everything that may ever SIGNAL a recorded sidecar — and therefore also
//! the never-signal refusals.
//!
//! PROCESS SAFETY (binding, plan-wide): nothing here ever kills by
//! process-name pattern. Only pids recorded AND re-verified via
//! `(pid, starttime, cmdline)` immediately before each signal are ever
//! signalled; `Mismatch`/`Dead`/`Unverifiable` are NEVER signalled.

use std::sync::Arc;
use std::time::Duration;

use crate::app_server::CodexAppServerClient;
use crate::events::{normalize_codex_thread_status, CodexStatus};
use crate::sidecar_reconcile::{
    remove_pruned, unix_millis, write_record_loudly, SidecarReconciler,
};
#[cfg(target_os = "linux")]
use crate::sidecar_store::{proc_cmdline, proc_starttime};
use crate::sidecar_store::{
    verify_sidecar_identity, CodexSidecarRecord, IdentityVerdict, SidecarRecordState,
};
use crate::transport::TungsteniteTransport;

/// Env override for the boot-time reap grace window (milliseconds): how long
/// a freshly booted server waits before sweeping unclaimed survivors, so
/// restores get to claim them first. Consumed by the boot wiring (Task 10);
/// [`SidecarReconciler::sweep_unclaimed`] itself takes no age into account —
/// the grace decides WHEN the sweep runs, not what it sees.
pub const FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS_ENV: &str = "FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS";

/// Default reap grace: 30 minutes.
pub const CODEX_SIDECAR_REAP_GRACE_MS_DEFAULT: u64 = 30 * 60 * 1000; // incident gap was 18 min

/// The boot wiring's grace read (Task 10):
/// [`FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS_ENV`] parsed as u64 millis; unset
/// or non-numeric falls back to [`CODEX_SIDECAR_REAP_GRACE_MS_DEFAULT`].
/// `0` IS honored — an operator/test asking for an immediate sweep (unlike
/// `FRESHELL_CODEX_PLAN_QUEUE_CAP`, where 0 is meaningless).
pub fn reap_grace_from_env() -> Duration {
    reap_grace_from_value(
        std::env::var(FRESHELL_CODEX_SIDECAR_REAP_GRACE_MS_ENV)
            .ok()
            .as_deref(),
    )
}

/// Pure parse half of [`reap_grace_from_env`] — unit-testable without
/// process-global env mutation (parallel test runs share the env).
fn reap_grace_from_value(value: Option<&str>) -> Duration {
    value
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(CODEX_SIDECAR_REAP_GRACE_MS_DEFAULT))
}

/// Whole-probe budget per sweep candidate (connect → initialize →
/// thread/loaded/list → thread/read per loaded thread). Bounded so a wedged
/// survivor cannot stall the sweep; on timeout the candidate is treated as
/// ws-unreachable and falls to the conservative writer-evidence check (a
/// wedged mid-turn writer still holds its rollout handle ⇒ retained).
const SWEEP_PROBE_BUDGET: Duration = Duration::from_secs(10);

/// Poll-gone drain budget per signalled pid: 5s, not 500ms — codex's SIGTERM
/// handler is a graceful drain (reports/V2.md), so give it time to exit
/// before escalating to SIGKILL.
#[cfg(target_os = "linux")]
const KILL_DRAIN_BUDGET: Duration = Duration::from_secs(5);

/// A force signal must also be followed by positive disappearance evidence;
/// "SIGKILL sent" is not itself a reaping verdict.
#[cfg(target_os = "linux")]
const KILL_FORCE_DRAIN_BUDGET: Duration = Duration::from_secs(2);

/// Poll interval while waiting for a signalled pid to go away.
#[cfg(target_os = "linux")]
const KILL_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// What the sweep did with one still-held record.
#[derive(Debug, PartialEq)]
pub enum SweepOutcome {
    /// Verified, reap-eligible, and killed tree-wide; record removed.
    Reaped,
    /// A thread/read reported status ACTIVE — retained, never signalled;
    /// state recorded as `Retained{reason:"mid-turn-active-thread"}`.
    RetainedMidTurn,
    /// ws unreachable but writer evidence held (`/proc/<pid>/fd`) — retained,
    /// never signalled; `Retained{reason:"ws-unreachable-writer-held"}`.
    RetainedWriterHeld,
    /// Dead/Mismatch verdict at sweep time — record removed, NEVER signalled.
    RecordRemovedStale,
    /// Identity unverifiable — retained, never signalled;
    /// `Retained{reason:"identity-unverifiable"}`.
    RetainedUnverifiable,
    /// The record left `held` (claimed by a restore) during the probe
    /// window — skipped, NO signal sent.
    SkippedClaimedDuringSweep,
    /// A verified kill attempt did not prove the entire owned tree empty.
    /// The row is retained with `termination-unconfirmed` and MUST NOT be
    /// reported as reaped.
    TerminationUnconfirmed,
}

/// The decide-phase verdict the commit arm executes. Fieldless (Copy) so the
/// TOCTOU test can drive [`SidecarReconciler::commit_sweep_decision`]
/// directly with a pre-claim snapshot.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum SweepDecision {
    /// Dead/Mismatch — remove the record, NEVER signal.
    RemoveStale,
    /// Retain with reason `"mid-turn-active-thread"`.
    RetainMidTurn,
    /// Retain with reason `"ws-unreachable-writer-held"`.
    RetainWriterHeld,
    /// Retain with reason `"identity-unverifiable"`.
    RetainUnverifiable,
    /// Verified + reap-eligible — kill the tree, remove the record.
    Kill,
}

impl SweepDecision {
    /// The durable `Retained{reason}` string for retain decisions.
    fn retain_reason(self) -> Option<&'static str> {
        match self {
            SweepDecision::RetainMidTurn => Some("mid-turn-active-thread"),
            SweepDecision::RetainWriterHeld => Some("ws-unreachable-writer-held"),
            SweepDecision::RetainUnverifiable => Some("identity-unverifiable"),
            SweepDecision::RemoveStale | SweepDecision::Kill => None,
        }
    }
}

impl SidecarReconciler {
    /// For every still-held, unclaimed record: re-verify identity, then
    ///   Dead / Mismatch      -> remove record, NEVER signal        (RecordRemovedStale)
    ///   Unverifiable         -> retain, state = Retained{reason:"identity-unverifiable"}
    ///   Verified + ws probe (initialize -> thread/loaded/list -> thread/read
    ///   per loaded thread; `loaded` alone does NOT mean mid-turn — idle
    ///   threads stay loaded forever, reports/V1.md):
    ///     any thread/read status ACTIVE -> retain, Retained{reason:"mid-turn-active-thread"}
    ///     reachable, no active thread   -> kill_verified_sidecar_tree, remove record (Reaped)
    ///     ws UNREACHABLE                -> /proc/<pid>/fd writer-evidence check
    ///                                      (open rollout .jsonl write handle or
    ///                                      thread-writer-locks/ file — readable
    ///                                      same-uid on this host, reports/V2.md):
    ///        evidence held  -> retain, Retained{reason:"ws-unreachable-writer-held"}
    ///        no evidence    -> kill_verified_sidecar_tree, remove record (Reaped)
    /// TOCTOU guard (binding): the probe phase runs on a SNAPSHOT of `held`
    /// (no locks across awaits), and a late claim_for_session may adopt a
    /// snapshotted record while a probe awaits. Per-pid identity
    /// re-verification CANNOT detect that (same live process), so it never
    /// authorizes a kill alone. Structure the sweep decide → commit: for
    /// each kill decision, re-acquire the `held` lock, confirm the record
    /// is STILL held (unclaimed), REMOVE it from `held`/`by_session` under
    /// that lock, release, and only then `kill_verified_sidecar_tree(...)
    /// .await` + `store.remove`. If the record already left `held`
    /// (claimed mid-sweep), skip with outcome SkippedClaimedDuringSweep and
    /// send NO signal — a restore just reattached to that sidecar; killing
    /// it is the exact da92 harm. Membership in `held` is the single source
    /// of truth for claim-vs-sweep ownership (Task 5's claim removes
    /// winners under the same lock).
    /// Sweep CONSUMES only Reaped/RecordRemovedStale entries from `held`;
    /// every Retained row STAYS held and claimable (a late restore must still
    /// reattach a mid-turn survivor — reports/V3.md), and is re-evaluated at
    /// next boot. Every decision logged with ownership id + verdict + outcome.
    pub async fn sweep_unclaimed(&self) -> Vec<(String, SweepOutcome)> {
        // Probe-phase SNAPSHOT: no `held` lock is held across any await.
        // Sorted for deterministic result/log ordering.
        let snapshot: Vec<CodexSidecarRecord> = {
            let held = self.held.lock().unwrap();
            let mut records: Vec<CodexSidecarRecord> = held.values().cloned().collect();
            records.sort_by(|a, b| a.ownership_id.cmp(&b.ownership_id));
            records
        };

        let mut results = Vec::with_capacity(snapshot.len());
        for record in snapshot {
            let verdict = verify_sidecar_identity(&record);
            let decision = decide_sweep_action(&record, &verdict).await;
            let outcome = self.commit_sweep_decision(&record, decision).await;
            tracing::info!(
                target: "freshell_codex::sidecar_sweep",
                ownership_id = %record.ownership_id,
                pid = record.pid,
                verdict = ?verdict,
                outcome = ?outcome,
                "sidecar_sweep_decision: unclaimed survivor swept to an explicit fate"
            );
            results.push((record.ownership_id, outcome));
        }
        results
    }

    /// The commit arm of one sweep decision (the decide → commit structure
    /// from [`SidecarReconciler::sweep_unclaimed`]'s TOCTOU guard).
    /// pub(crate) so the TOCTOU test can drive it directly with a pre-claim
    /// snapshot — deterministic, no timing dependence.
    pub(crate) async fn commit_sweep_decision(
        &self,
        record: &CodexSidecarRecord,
        decision: SweepDecision,
    ) -> SweepOutcome {
        match decision {
            SweepDecision::RemoveStale => {
                if !self.take_if_still_held(record) {
                    return SweepOutcome::SkippedClaimedDuringSweep;
                }
                // Dead/Mismatch: remove the row, NEVER signal (the pid is
                // either gone or NOT ours).
                remove_pruned(&self.store, &record.ownership_id);
                SweepOutcome::RecordRemovedStale
            }
            SweepDecision::Kill => {
                if !self.take_if_still_held(record) {
                    return SweepOutcome::SkippedClaimedDuringSweep;
                }
                // Removed from `held` under its lock — the claim can no
                // longer adopt this record. Kill AFTER the lock is released;
                // the helper re-verifies (pid, starttime, cmdline)
                // immediately before every signal.
                let outcome = kill_verified_sidecar_tree(record).await;
                if outcome.verified_empty(record) {
                    tracing::info!(
                        target: "freshell_codex::sidecar_sweep",
                        ownership_id = %record.ownership_id,
                        pid = record.pid,
                        outcomes = ?outcome.outcomes,
                        "sidecar_sweep_reaped: unclaimed sidecar tree verified empty"
                    );
                    remove_pruned(&self.store, &record.ownership_id);
                    SweepOutcome::Reaped
                } else {
                    tracing::error!(
                        target: "freshell_codex::sidecar_sweep",
                        ownership_id = %record.ownership_id,
                        pid = record.pid,
                        outcomes = ?outcome.outcomes,
                        "sidecar_sweep_termination_unconfirmed: ownership evidence retained; NOT reaped"
                    );
                    self.restore_unconfirmed_held(record);
                    SweepOutcome::TerminationUnconfirmed
                }
            }
            SweepDecision::RetainMidTurn
            | SweepDecision::RetainWriterHeld
            | SweepDecision::RetainUnverifiable => {
                let reason = decision
                    .retain_reason()
                    .expect("retain decisions carry a reason");
                // Retained rows STAY held (and claimable): update the held
                // record in place — under the lock, no await — then persist
                // the recorded reason.
                let snapshot = {
                    let mut held = self.held.lock().unwrap();
                    let Some(held_record) = held.get_mut(&record.ownership_id) else {
                        return SweepOutcome::SkippedClaimedDuringSweep;
                    };
                    held_record.state = SidecarRecordState::Retained {
                        reason: reason.to_string(),
                    };
                    held_record.updated_at = unix_millis();
                    held_record.clone()
                };
                write_record_loudly(&self.store, &snapshot);
                match decision {
                    SweepDecision::RetainMidTurn => SweepOutcome::RetainedMidTurn,
                    SweepDecision::RetainWriterHeld => SweepOutcome::RetainedWriterHeld,
                    _ => SweepOutcome::RetainedUnverifiable,
                }
            }
        }
    }

    /// A kill attempt can lose certainty after the record was fenced out of
    /// `held`. Put the ownership evidence back so a later boot can retry or
    /// an operator can inspect it. This is intentionally conservative: a
    /// failed cleanup is never converted into absence by deleting its row.
    fn restore_unconfirmed_held(&self, record: &CodexSidecarRecord) {
        let mut retained = record.clone();
        retained.state = SidecarRecordState::Retained {
            reason: "termination-unconfirmed".to_string(),
        };
        retained.updated_at = unix_millis();
        {
            let mut held = self.held.lock().unwrap();
            held.insert(retained.ownership_id.clone(), retained.clone());
            let mut by_session = self.by_session.lock().unwrap();
            if let Some(session_id) = &retained.session_id {
                let ids = by_session.entry(session_id.clone()).or_default();
                if !ids.iter().any(|id| id == &retained.ownership_id) {
                    ids.push(retained.ownership_id.clone());
                }
            }
        }
        write_record_loudly(&self.store, &retained);
    }

    /// The TOCTOU commit gate: re-acquire `held`, confirm the record is
    /// STILL held (unclaimed), and remove it from `held`/`by_session` under
    /// that lock. `false` ⇒ a claim consumed the record during the probe
    /// await — the caller must send NO signal (a restore just reattached to
    /// that sidecar). Lock order (held, then by_session) matches every
    /// claim-path acquisition.
    fn take_if_still_held(&self, record: &CodexSidecarRecord) -> bool {
        let mut held = self.held.lock().unwrap();
        if held.remove(&record.ownership_id).is_none() {
            tracing::info!(
                target: "freshell_codex::sidecar_sweep",
                ownership_id = %record.ownership_id,
                pid = record.pid,
                "sidecar_sweep_skipped_claimed: record left `held` during the \
                 probe window (claimed by a restore); NO signal sent"
            );
            return false;
        }
        let mut by_session = self.by_session.lock().unwrap();
        if let Some(session_id) = &record.session_id {
            if let Some(ids) = by_session.get_mut(session_id) {
                ids.retain(|id| id != &record.ownership_id);
                if ids.is_empty() {
                    by_session.remove(session_id);
                }
            }
        }
        true
    }
}

/// The decide phase for one record (no locks held; may await the ws probe).
/// Pure decision — the commit arm re-checks `held` membership before acting.
/// pub(crate) so the Unverifiable mapping (unsynthesizable end-to-end for a
/// test-owned child) is directly testable.
pub(crate) async fn decide_sweep_action(
    record: &CodexSidecarRecord,
    verdict: &IdentityVerdict,
) -> SweepDecision {
    match verdict {
        // Dead or pid-reuse: the row is stale; the pid is never signalled.
        IdentityVerdict::Dead | IdentityVerdict::Mismatch => SweepDecision::RemoveStale,
        // Not provably ours ⇒ never signalled; not provably stale ⇒ kept on
        // the books with a recorded reason.
        IdentityVerdict::Unverifiable => SweepDecision::RetainUnverifiable,
        IdentityVerdict::Verified => match probe_mid_turn(&record.ws_url).await {
            MidTurnProbe::ActiveThread => SweepDecision::RetainMidTurn,
            MidTurnProbe::ReachableIdle => SweepDecision::Kill,
            MidTurnProbe::Unreachable => {
                if writer_evidence_held(record.pid as i32) {
                    SweepDecision::RetainWriterHeld
                } else {
                    SweepDecision::Kill
                }
            }
        },
    }
}

/// What the bounded mid-turn ws probe concluded about one verified survivor.
enum MidTurnProbe {
    /// Some loaded thread's `thread/read` status is `active` — mid-turn.
    ActiveThread,
    /// Reachable and every loaded thread reads idle (`loaded` alone does NOT
    /// mean mid-turn — idle threads stay loaded forever, reports/V1.md).
    ReachableIdle,
    /// Connect/handshake/read failure or budget exhausted — fall to the
    /// writer-evidence check.
    Unreachable,
}

/// The mid-turn probe over the crate's own client ([`CodexAppServerClient`]
/// on [`TungsteniteTransport`]): connect → `initialize`/`initialized` →
/// `thread/loaded/list` → `thread/read` per loaded thread, discriminating on
/// status `active`. Whole-candidate budget: [`SWEEP_PROBE_BUDGET`]; any
/// failure ⇒ [`MidTurnProbe::Unreachable`] (conservative — a wedged mid-turn
/// writer still holds its rollout handle, so the fd check retains it).
async fn probe_mid_turn(ws_url: &str) -> MidTurnProbe {
    let inner = async {
        let Ok(transport) = TungsteniteTransport::connect(ws_url).await else {
            return MidTurnProbe::Unreachable;
        };
        // Keep the notification receiver alive for the probe's lifetime; the
        // client Drop aborts the background consumer.
        let (client, _notifications) = CodexAppServerClient::connect(Arc::new(transport));
        let result = probe_loaded_threads(&client).await;
        client.close().await;
        result
    };
    tokio::time::timeout(SWEEP_PROBE_BUDGET, inner)
        .await
        .unwrap_or(MidTurnProbe::Unreachable)
}

/// `initialize` → `thread/loaded/list` → `thread/read` per loaded thread.
async fn probe_loaded_threads(client: &CodexAppServerClient) -> MidTurnProbe {
    if client.initialize().await.is_err() {
        return MidTurnProbe::Unreachable;
    }
    let Ok(loaded) = client.list_loaded_threads().await else {
        return MidTurnProbe::Unreachable;
    };
    for thread_id in loaded {
        let Ok(result) = client.read_thread(&thread_id, false).await else {
            // Reachable but the read failed: cannot prove idle — treat as
            // unreachable and let the writer-evidence check decide.
            return MidTurnProbe::Unreachable;
        };
        let status = result
            .get("thread")
            .and_then(|thread| thread.get("status"))
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        if normalize_codex_thread_status(&status) == CodexStatus::Running {
            return MidTurnProbe::ActiveThread;
        }
    }
    MidTurnProbe::ReachableIdle
}

/// Writer-evidence check for a ws-unreachable Verified survivor: does
/// `/proc/<pid>/fd` hold an open rollout `.jsonl` WRITE handle or any
/// `thread-writer-locks/` file handle? Same-uid readable on this host
/// (reports/V2.md). Unreadable fd table / fdinfo ⇒ `true` (evidence-held —
/// conservative: retain, never kill on missing evidence).
#[cfg(target_os = "linux")]
pub(crate) fn writer_evidence_held(pid: i32) -> bool {
    let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return true; // fd table unreadable ⇒ treat as evidence-held
    };
    for entry in entries.flatten() {
        let Ok(target) = std::fs::read_link(entry.path()) else {
            continue; // this fd vanished mid-scan — not evidence
        };
        let target = target.to_string_lossy();
        if target.contains("thread-writer-locks/") {
            return true;
        }
        let file_name = target.rsplit('/').next().unwrap_or(&target);
        if file_name.starts_with("rollout-")
            && file_name.ends_with(".jsonl")
            && fd_opened_for_write(pid, &entry.file_name().to_string_lossy())
        {
            return true;
        }
    }
    false
}

/// Non-Linux: no `/proc` — evidence can never be ruled out (conservative).
/// Structurally unreachable today (non-Linux identity is never Verified).
#[cfg(not(target_os = "linux"))]
pub(crate) fn writer_evidence_held(_pid: i32) -> bool {
    true
}

/// Is `/proc/<pid>/fdinfo/<fd>`'s `flags:` octal opened for write
/// (O_WRONLY/O_RDWR)? Unreadable/unparsable ⇒ `true` (conservative).
#[cfg(target_os = "linux")]
fn fd_opened_for_write(pid: i32, fd: &str) -> bool {
    let Ok(info) = std::fs::read_to_string(format!("/proc/{pid}/fdinfo/{fd}")) else {
        return true;
    };
    for line in info.lines() {
        if let Some(rest) = line.strip_prefix("flags:") {
            let Ok(flags) = u32::from_str_radix(rest.trim(), 8) else {
                return true;
            };
            return flags & (libc::O_ACCMODE as u32) != libc::O_RDONLY as u32;
        }
    }
    true
}

// ---------------------------------------------------------------------------
// The shared tree-aware kill helper (Task 6; reused by Task 9's sweep).
// A3 was FALSIFIED (reports/V2.md): sidecars are process TREES (children
// like `codex-code-mode-host` live in their OWN pgids/sessions, so neither
// single-pid signalling nor a pgid group-kill covers them), codex's SIGTERM
// handler is a graceful drain, and SIGKILL provably orphans its children
// (no PDEATHSIG; cleanup is userspace-only). "Reaped" must mean the whole
// tree is gone.
// ---------------------------------------------------------------------------

/// What happened to one pid during [`kill_verified_sidecar_tree`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillOutcome {
    /// Gone (exited, reaped, or zombie) within the drain budget after SIGTERM.
    ExitedAfterSigterm,
    /// Survived SIGTERM, then exited after a verified SIGKILL.
    ExitedAfterSigkill,
    /// A verified SIGKILL was sent but this exact incarnation was still
    /// observed after the force-drain budget. Cleanup is unconfirmed.
    SigkillSentStillAlive,
    /// Already gone before any signal was needed.
    AlreadyDead,
    /// Live pid whose evidence no longer matches its snapshot (pid reuse) —
    /// NEVER signalled.
    SkippedIdentityMismatch,
    /// Evidence unreadable / non-Linux — NEVER signalled.
    SkippedUnverifiable,
    /// SIGTERM WAS sent to the verified pid, the drain budget expired, and
    /// the pre-SIGKILL re-verify no longer matched (Mismatch/Unverifiable —
    /// e.g. a mid-drain re-exec rewrote the argv on the same incarnation).
    /// The escalation was REFUSED: no SIGKILL was sent. Distinct from the
    /// pre-signal `Skipped*` outcomes, which would under-report the SIGTERM
    /// that was actually delivered (Task 6 review carry-forward).
    SigtermSentEscalationRefused,
}

/// Per-pid outcomes of one [`kill_verified_sidecar_tree`] call: the root
/// first, then each captured descendant in capture order.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KillTreeOutcome {
    pub outcomes: Vec<(u32, KillOutcome)>,
}

impl KillTreeOutcome {
    /// True only when every captured pid has positive disappearance evidence
    /// and no process still advertises this invocation's unique ownership tag.
    /// The `/proc` scan is verification-only; it never authorizes a signal.
    pub fn verified_empty(&self, record: &CodexSidecarRecord) -> bool {
        let all_confirmed = self.outcomes.iter().all(|(_, outcome)| {
            matches!(
                outcome,
                KillOutcome::ExitedAfterSigterm
                    | KillOutcome::ExitedAfterSigkill
                    | KillOutcome::AlreadyDead
            )
        });
        all_confirmed && !ownership_tag_still_live(&record.ownership_id)
    }
}

/// Re-verify (pid, starttime, cmdline); capture the pid's live descendant
/// set from `/proc` (children recursively via `/proc/<pid>/task/*/children`,
/// each snapshotted with its own (pid, starttime, cmdline) so nothing is
/// ever signalled on a stale pid); SIGTERM the root; poll-gone with a
/// drain-tolerant budget (`KILL_DRAIN_BUDGET` = 5s, not 500ms — codex
/// drains gracefully); SIGKILL the root once if needed; then SIGTERM →
/// poll → SIGKILL each captured descendant that survived, re-verified by its
/// snapshot immediately before each signal. Returns what happened per pid.
/// Never signals anything whose snapshot no longer matches.
///
/// ASYNC (binding): every call site is async on the tokio runtime —
/// [`ReattachedCodexAppServerRuntime`]'s `ensure_ready` (inside the
/// user-facing restore path, holding one of the manager's two plan permits),
/// `shutdown`, and Task 9's `sweep_unclaimed` — and the poll-gone budgets
/// wait for multi-second intervals. All waits are `tokio::time::sleep`
/// awaits, never `std::thread::sleep`: a sync fn here would block executor
/// workers for the whole SIGTERM→poll→SIGKILL sequence (the same
/// sync/async impedance class the claim path already fixed). Callers must
/// not hold any `held`/store lock across this await.
///
/// [`ReattachedCodexAppServerRuntime`]: crate::sidecar_reconcile::ReattachedCodexAppServerRuntime
pub async fn kill_verified_sidecar_tree(record: &CodexSidecarRecord) -> KillTreeOutcome {
    let verdict = verify_sidecar_identity(record);
    match verdict {
        IdentityVerdict::Dead => KillTreeOutcome {
            outcomes: vec![(record.pid, KillOutcome::AlreadyDead)],
        },
        IdentityVerdict::Mismatch | IdentityVerdict::Unverifiable => {
            tracing::warn!(
                target: "freshell_codex::sidecar_sweep",
                ownership_id = %record.ownership_id,
                pid = record.pid,
                verdict = ?verdict,
                "sidecar_tree_kill_skipped: identity not provably ours; NEVER signalled"
            );
            let outcome = if verdict == IdentityVerdict::Mismatch {
                KillOutcome::SkippedIdentityMismatch
            } else {
                KillOutcome::SkippedUnverifiable
            };
            KillTreeOutcome {
                outcomes: vec![(record.pid, outcome)],
            }
        }
        IdentityVerdict::Verified => {
            #[cfg(target_os = "linux")]
            {
                kill_verified_tree_linux(record).await
            }
            #[cfg(not(target_os = "linux"))]
            {
                // Structurally unreachable: non-Linux identity is always
                // Unverifiable (never Verified). Kept as the conservative
                // never-signal posture should that ever change.
                KillTreeOutcome {
                    outcomes: vec![(record.pid, KillOutcome::SkippedUnverifiable)],
                }
            }
        }
    }
}

/// One captured descendant's OWN identity evidence, snapshotted at capture
/// time — the only thing a descendant is ever verified (and signalled)
/// against.
#[cfg(target_os = "linux")]
struct PidSnapshot {
    pid: i32,
    starttime: u64,
    cmdline: Vec<String>,
}

/// Does `/proc/<pid>` still hold the process this snapshot captured?
#[cfg(target_os = "linux")]
enum SnapshotVerdict {
    Matches,
    Gone,
    /// Live pid, different incarnation or changed cmdline — NEVER signal.
    Mismatch,
    /// Live pid, unreadable cmdline — not provably the captured process;
    /// NEVER signal (kept distinct from Mismatch so outcomes stay truthful,
    /// Task 6 review carry-forward).
    Unverifiable,
}

#[cfg(target_os = "linux")]
fn verify_snapshot(snapshot: &PidSnapshot) -> SnapshotVerdict {
    let Some(starttime) = proc_starttime(snapshot.pid) else {
        return SnapshotVerdict::Gone;
    };
    if starttime != snapshot.starttime {
        return SnapshotVerdict::Mismatch;
    }
    match proc_cmdline(snapshot.pid) {
        Some(cmdline) if cmdline == snapshot.cmdline => SnapshotVerdict::Matches,
        Some(_) => SnapshotVerdict::Mismatch,
        None => SnapshotVerdict::Unverifiable,
    }
}

/// The Verified arm of [`kill_verified_sidecar_tree`]: capture, then the
/// root and per-descendant SIGTERM→poll→SIGKILL sequences, each signal
/// preceded by its own fresh verification.
#[cfg(target_os = "linux")]
async fn kill_verified_tree_linux(record: &CodexSidecarRecord) -> KillTreeOutcome {
    let root_pid = record.pid as i32;
    // Capture the descendants BEFORE the root is signalled: codex's SIGTERM
    // drain tears down (some of) its children in userspace and a SIGKILLed
    // root orphans them — either way the parent links that let /proc find
    // them are gone once the root dies (reports/V2.md).
    let descendants = capture_descendants(root_pid);
    let mut outcomes = Vec::with_capacity(1 + descendants.len());

    // The caller's verify dispatched here, but re-verify immediately before
    // the signal — nothing is ever signalled on a stale pid.
    let root_outcome = match verify_sidecar_identity(record) {
        IdentityVerdict::Verified => {
            signal_pid(root_pid, libc::SIGTERM);
            if poll_incarnation_gone(root_pid, record.starttime, KILL_DRAIN_BUDGET).await {
                KillOutcome::ExitedAfterSigterm
            } else {
                // Re-verify immediately before the escalation too.
                match verify_sidecar_identity(record) {
                    IdentityVerdict::Verified => {
                        signal_pid(root_pid, libc::SIGKILL);
                        if poll_incarnation_gone(
                            root_pid,
                            record.starttime,
                            KILL_FORCE_DRAIN_BUDGET,
                        )
                        .await
                        {
                            KillOutcome::ExitedAfterSigkill
                        } else {
                            KillOutcome::SigkillSentStillAlive
                        }
                    }
                    IdentityVerdict::Dead => KillOutcome::ExitedAfterSigterm,
                    verdict @ (IdentityVerdict::Mismatch | IdentityVerdict::Unverifiable) => {
                        tracing::warn!(
                            target: "freshell_codex::sidecar_sweep",
                            ownership_id = %record.ownership_id,
                            pid = record.pid,
                            verdict = ?verdict,
                            "sidecar_tree_kill_escalation_refused: identity decayed \
                             after SIGTERM; SIGKILL NOT sent"
                        );
                        KillOutcome::SigtermSentEscalationRefused
                    }
                }
            }
        }
        IdentityVerdict::Dead => KillOutcome::AlreadyDead,
        IdentityVerdict::Mismatch => KillOutcome::SkippedIdentityMismatch,
        IdentityVerdict::Unverifiable => KillOutcome::SkippedUnverifiable,
    };
    outcomes.push((record.pid, root_outcome));

    // Final-review H3b: a PRE-signal root refusal (Mismatch/Unverifiable)
    // throws the whole capture's provenance into doubt — the descendants were
    // snapshotted as children of a root we can no longer prove is ours, so
    // NONE of them are processed (nothing is signalled). Post-SIGTERM
    // outcomes (incl. SigtermSentEscalationRefused) keep the per-descendant
    // sweep: the tree was captured while the root still verified as ours.
    if matches!(
        root_outcome,
        KillOutcome::SkippedIdentityMismatch | KillOutcome::SkippedUnverifiable
    ) {
        if !descendants.is_empty() {
            tracing::warn!(
                target: "freshell_codex::sidecar_sweep",
                ownership_id = %record.ownership_id,
                pid = record.pid,
                skipped_descendants = descendants.len(),
                "sidecar_tree_kill_descendants_skipped: root identity refused \
                 pre-signal; captured descendants NOT processed"
            );
        }
        return KillTreeOutcome { outcomes };
    }

    for snapshot in &descendants {
        let outcome = kill_captured_descendant(snapshot).await;
        outcomes.push((snapshot.pid as u32, outcome));
    }

    let result = KillTreeOutcome { outcomes };
    tracing::info!(
        target: "freshell_codex::sidecar_sweep",
        ownership_id = %record.ownership_id,
        outcomes = ?result.outcomes,
        "sidecar_tree_killed: verified sidecar tree torn down"
    );
    result
}

/// SIGTERM → poll-gone → SIGKILL one captured descendant, re-verified by
/// its OWN snapshot immediately before EACH signal.
#[cfg(target_os = "linux")]
async fn kill_captured_descendant(snapshot: &PidSnapshot) -> KillOutcome {
    match verify_snapshot(snapshot) {
        SnapshotVerdict::Gone => return KillOutcome::AlreadyDead,
        SnapshotVerdict::Mismatch => return KillOutcome::SkippedIdentityMismatch,
        SnapshotVerdict::Unverifiable => return KillOutcome::SkippedUnverifiable,
        SnapshotVerdict::Matches => {}
    }
    signal_pid(snapshot.pid, libc::SIGTERM);
    if poll_incarnation_gone(snapshot.pid, snapshot.starttime, KILL_DRAIN_BUDGET).await {
        return KillOutcome::ExitedAfterSigterm;
    }
    match verify_snapshot(snapshot) {
        SnapshotVerdict::Gone => KillOutcome::ExitedAfterSigterm,
        // SIGTERM WAS sent; the escalation is refused on decayed identity —
        // reported truthfully, never as a pre-signal "Skipped*".
        SnapshotVerdict::Mismatch | SnapshotVerdict::Unverifiable => {
            KillOutcome::SigtermSentEscalationRefused
        }
        SnapshotVerdict::Matches => {
            signal_pid(snapshot.pid, libc::SIGKILL);
            if poll_incarnation_gone(snapshot.pid, snapshot.starttime, KILL_FORCE_DRAIN_BUDGET)
                .await
            {
                KillOutcome::ExitedAfterSigkill
            } else {
                KillOutcome::SigkillSentStillAlive
            }
        }
    }
}

/// Walk `/proc/<pid>/task/*/children` recursively (a visited set guards
/// against reparenting races) and snapshot each live descendant's own
/// evidence. Descendants that are gone — or whose evidence is unreadable —
/// at capture time are NOT captured: no snapshot ⇒ never signalled.
#[cfg(target_os = "linux")]
fn capture_descendants(root_pid: i32) -> Vec<PidSnapshot> {
    let mut snapshots = Vec::new();
    let mut visited = std::collections::HashSet::new();
    visited.insert(root_pid);
    let mut frontier = vec![root_pid];
    while let Some(pid) = frontier.pop() {
        for child in proc_children(pid) {
            if !visited.insert(child) {
                continue;
            }
            frontier.push(child);
            let Some(starttime) = proc_starttime(child) else {
                continue; // gone/zombie — nothing to signal
            };
            let Some(cmdline) = proc_cmdline(child) else {
                continue; // unreadable — never signalled
            };
            snapshots.push(PidSnapshot {
                pid: child,
                starttime,
                cmdline,
            });
        }
    }
    snapshots
}

/// One pid's direct children, from every thread's
/// `/proc/<pid>/task/<tid>/children` row (space-separated child pids).
#[cfg(target_os = "linux")]
fn proc_children(pid: i32) -> Vec<i32> {
    let mut children = Vec::new();
    let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) else {
        return children;
    };
    for task in tasks.flatten() {
        let tid = task.file_name();
        let Some(tid) = tid.to_str() else { continue };
        let Ok(row) = std::fs::read_to_string(format!("/proc/{pid}/task/{tid}/children")) else {
            continue;
        };
        children.extend(row.split_whitespace().filter_map(|p| p.parse::<i32>().ok()));
    }
    children
}

/// Send one signal to one just-verified pid.
#[cfg(target_os = "linux")]
fn signal_pid(pid: i32, signal: libc::c_int) {
    // SAFETY: kill(2) only dispatches a signal — no memory is touched. The
    // caller verified the pid's identity evidence immediately before this
    // call (transport.rs:110 precedent).
    unsafe {
        libc::kill(pid, signal);
    }
}

/// Poll until `(pid, starttime)` no longer names a live incarnation
/// (exited, reaped, zombie, or pid reused) or the budget expires. All waits
/// are `tokio::time::sleep` — never `std::thread::sleep` (the
/// [`kill_verified_sidecar_tree`] ASYNC contract).
#[cfg(target_os = "linux")]
async fn poll_incarnation_gone(pid: i32, starttime: u64, budget: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + budget;
    loop {
        if proc_starttime(pid) != Some(starttime) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(KILL_POLL_INTERVAL).await;
    }
}

#[cfg(target_os = "linux")]
fn ownership_tag_still_live(ownership_id: &str) -> bool {
    let needle = crate::durability::ownership_needle(ownership_id);
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return true;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        // Zombies do not count as a live workload; their pid cannot be reused
        // until the parent reaps them.
        if proc_starttime(pid).is_none() {
            continue;
        }
        let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else {
            continue;
        };
        if environ
            .split(|&b| b == 0)
            .any(|var| var == needle.as_bytes())
        {
            return true;
        }
    }
    false
}

#[cfg(not(target_os = "linux"))]
fn ownership_tag_still_live(_ownership_id: &str) -> bool {
    true
}

#[cfg(test)]
#[path = "sidecar_sweep_tests.rs"]
mod tests;

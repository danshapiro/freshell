//! # Fresh-agent per-sessionRef create/resume lease (D8 for fresh agents)
//!
//! One durable `(provider, sessionId)` may have at most ONE in-flight create/resume
//! and at most ONE live bound session at a time — the JSONL/rollout transcript on disk
//! tolerates exactly one writer. Mirror of `TerminalRegistry`'s session-ref lease
//! INCLUDING its binding closure (registry.rs:1805-1885 and the TOCTOU fix at
//! registry.rs:1819-1844): a loser preempted across the winner's register→complete
//! window arrives after `complete()` removed the winner's lease — seeing no lease —
//! while only the bindings map records the winner. `claim` re-checks bindings WHILE
//! HOLDING the leases lock, so it answers [`FreshSessionClaim::BoundLive`] instead of
//! `Acquired` (never a duplicate spawn).
//!
//! Kill-before-release TTL semantics: an expired holder with a recorded kill handle is
//! answered [`FreshSessionClaim::ExpiredNeedsKill`] — the lease stays held until the
//! caller confirms the holder's ENTIRE process tree is dead (child kill + ownership
//! sweep empty) and calls [`FreshAgentSessionLeases::force_release_after_confirmed_kill`].
//! An expired HANDLE-LESS holder is revoked and held closed forever (never release what
//! you can't kill); its own `fail()` — proof no orphan exists — reopens the key.

use std::collections::HashMap;
use std::sync::Mutex;

/// Opaque and reparented fixtures share this binary's `/proc` view with native
/// provider tests. Reuse their existing environment guards in the same order
/// as cross-provider handoff tests, from before spawn through physical cleanup.
#[cfg(test)]
pub(crate) mod process_fixture {
    pub(crate) type Guard = (
        crate::codex::tests::IsolatedCodexEnvGuard<'static>,
        tokio::sync::MutexGuard<'static, ()>,
    );

    pub(crate) async fn lock() -> Guard {
        let claude = crate::claude::tests::CLAUDE_ENV_LOCK.lock().await;
        let codex = crate::codex::tests::ENV_LOCK.lock().await;
        (codex, claude)
    }

    pub(crate) fn blocking_lock() -> Guard {
        let claude = crate::claude::tests::CLAUDE_ENV_LOCK.blocking_lock();
        let codex = crate::codex::tests::ENV_LOCK.blocking_lock();
        (codex, claude)
    }
}

/// Lease TTL: how long a create/resume may hold the sessionRef before contenders may
/// demand the kill-before-release path. Env `FRESHELL_FRESH_AGENT_LEASE_TTL_MS` overrides.
pub const FRESH_AGENT_SESSION_LEASE_TTL_MS: u64 = 20_000;
/// The `retry_after_ms` hint handed to `SESSION_RESERVED` losers.
pub const FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS: u64 = 1_000;

/// The effective lease TTL (env-overridable for tests).
pub fn fresh_agent_session_lease_ttl_ms() -> u64 {
    std::env::var("FRESHELL_FRESH_AGENT_LEASE_TTL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(FRESH_AGENT_SESSION_LEASE_TTL_MS)
}

/// Epoch milliseconds for lease claims (callers pass time in for testability of the
/// primitive; the seams use this shared clock).
pub fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Kill an expired holder's sidecar TREE and confirm it is dead (Task 12, V6).
///
/// YAMA-aware design: under restricted ptrace (`/proc/sys/kernel/yama/ptrace_scope=1`,
/// the Ubuntu default) `/proc/<pid>/environ` is readable only while this process is an
/// ANCESTOR of the target — the moment the intermediate sidecar dies, its children
/// reparent to init and the ownership tag becomes unreadable. So the tagged tree is
/// captured FIRST (while the chain is intact), remembered as `(pid, starttime)` pairs,
/// and death is confirmed via the world-readable `/proc/<pid>/stat` with a starttime
/// match (the pid-reuse guard). Sequence:
///
/// 1. Scan the ownership-tagged `/proc` set (sidecar + SDK-spawned grandchildren).
/// 2. Graceful SIGTERM to the recorded child first (catchable — lets the SDK cleanly
///    kill its own CLI grandchild), poll ≤500ms, SIGKILL fallback.
/// 3. Sweep the captured tree (SIGTERM rounds, SIGKILL escalation) until every member
///    is confirmed dead-by-starttime, folding in any still-readable tagged newcomers.
///
/// b8ke focused round-5 review R5-4: every signal in this family is
/// IDENTITY-SAFE — issued through a pidfd pinned to the recorded
/// incarnation (see [`signal_recorded_incarnation`]). An unreadable or
/// missing start time is NEVER proof of liveness: no signal is issued
/// (fail-closed — the caller's unconfirmed path), and a pid recycled
/// between the verify and the send can never receive it.
///
/// Returns `true` only when the whole captured tree is confirmed gone; callers may
/// `force_release` ONLY then. Non-Linux: no `/proc` — returns `false` (hold closed).
#[cfg(target_os = "linux")]
pub async fn kill_and_confirm_tree_dead(pid: u32, ownership_env: &str, ownership_id: &str) -> bool {
    let recorded = record_condemned_runtime_identity(pid, ownership_env, ownership_id);
    kill_and_confirm_recorded_tree_dead(&recorded, ownership_env).await
}

/// The sweep behind [`kill_and_confirm_tree_dead`]'s step 3: poll the
/// captured `(pid, starttime)` tree until every member is confirmed
/// dead-by-starttime (SIGTERM rounds, SIGKILL escalation after 20 rounds),
/// folding in currently-readable tagged newcomers each round. R5-4: every
/// member signal is issued through the pidfd-pinned recorded incarnation —
/// a member whose identity cannot be pinned/verified is simply not
/// signaled that round (fail-closed; the next round's retain revalidates).
#[cfg(target_os = "linux")]
async fn sweep_captured_tree_until_dead(
    mut tree: Vec<(i32, u64)>,
    ownership_env: &str,
    ownership_id: &str,
    owned_root_pid: Option<i32>,
    expected_start: Option<u64>,
) -> bool {
    for round in 0..24u8 {
        let mut observation_complete = true;
        tree.retain(|(p, st)| match proc_starttime_observation(*p) {
            Ok(Some(actual)) => actual == *st,
            Ok(None) => false,
            Err(_) => {
                observation_complete = false;
                true
            }
        });
        if !observation_complete {
            return false;
        }
        let scan = scan_tagged_pids_observing(
            ownership_env,
            ownership_id,
            owned_root_pid,
            expected_start,
            &tree,
            &mut |_, _| {},
        );
        if !scan.complete {
            return false;
        }
        for p in scan.pids {
            if !tree.iter().any(|(q, _)| *q == p) {
                match proc_starttime_observation(p) {
                    Ok(Some(st)) => tree.push((p, st)),
                    Ok(None) => {}
                    Err(_) => return false,
                }
            }
        }
        if tree.is_empty() {
            return true;
        }
        let sig = if round < 20 {
            libc::SIGTERM
        } else {
            libc::SIGKILL
        };
        for (p, st) in &tree {
            signal_recorded_incarnation(*p as u32, Some(*st), sig);
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    let mut observation_complete = true;
    tree.retain(|(p, st)| match proc_starttime_observation(*p) {
        Ok(Some(actual)) => actual == *st,
        Ok(None) => false,
        Err(_) => {
            observation_complete = false;
            true
        }
    });
    observation_complete && tree.is_empty()
}

/// b8ke focused round-3 review R3-7: the recorded identity of a condemned
/// runtime — the direct child's pid + its `/proc` start time and the tagged
/// descendant tree discovered at KILL TIME (while the ancestry chain was
/// still intact and the ownership tags readable). The replacement probe (a
/// cancelled/panicked teardown's finisher) verifies the pid's start time
/// BEFORE signaling (a recycled pid belongs to an unrelated process —
/// never signaled) and sweeps the RECORDED tree, so reparented descendants
/// whose tags became unreadable after the child died are still confirmed
/// dead-by-starttime — never an empty-tree false confirmation.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CondemnedRuntimeIdentity {
    /// The direct sidecar child's pid at kill time.
    pub pid: u32,
    /// The child's `/proc` start time at kill time (`None` when unreadable
    /// or on non-Linux): the pid-reuse guard.
    pub start_time: Option<u64>,
    /// The tagged `(pid, starttime)` pairs discovered at kill time — the
    /// child plus its descendants, captured while readable.
    pub tree: Vec<(i32, u64)>,
    /// The ownership tag the tree was discovered under.
    pub ownership_id: String,
    /// Whether the owned-process observation completed without losing the
    /// direct runtime identity. An incomplete capture is never proof that
    /// the recorded writer set is gone.
    pub capture_complete: bool,
}

/// Evidence for one recorded process candidate. A missing process or a
/// readable different incarnation proves the recorded process is gone;
/// read/parse/permission failures remain explicitly unavailable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecordedProcessEvidence {
    SameIncarnation,
    Gone,
    Unavailable,
}

/// Capture a condemned runtime's identity NOW (kill time): the tagged tree
/// scan plus the direct child's start time. Cheap, sync, no signals.
#[cfg(target_os = "linux")]
pub fn record_condemned_runtime_identity(
    pid: u32,
    ownership_env: &str,
    ownership_id: &str,
) -> CondemnedRuntimeIdentity {
    record_condemned_runtime_identity_observing(pid, ownership_env, ownership_id, &mut |_, _| {})
}

#[cfg(target_os = "linux")]
fn record_condemned_runtime_identity_observing(
    pid: u32,
    ownership_env: &str,
    ownership_id: &str,
    before_read: &mut impl FnMut(&str, i32),
) -> CondemnedRuntimeIdentity {
    capture_runtime_identity(pid, ownership_env, ownership_id, None, before_read)
}

/// Enrich a recorded identity without replacing its members, root incarnation,
/// or unavailable coverage. The old root start also bounds later opaque orphans.
#[cfg(target_os = "linux")]
pub fn refresh_condemned_runtime_identity(
    recorded: &CondemnedRuntimeIdentity,
    ownership_env: &str,
) -> CondemnedRuntimeIdentity {
    capture_runtime_identity(
        recorded.pid,
        ownership_env,
        &recorded.ownership_id,
        Some(recorded),
        &mut |_, _| {},
    )
}

#[cfg(target_os = "linux")]
fn capture_runtime_identity(
    pid: u32,
    ownership_env: &str,
    ownership_id: &str,
    previous: Option<&CondemnedRuntimeIdentity>,
    before_read: &mut impl FnMut(&str, i32),
) -> CondemnedRuntimeIdentity {
    before_read("root_stat", pid as i32);
    let child_observation = proc_starttime_observation(pid as i32);
    let mut capture_complete =
        child_observation.is_ok() && previous.is_none_or(|recorded| recorded.capture_complete);
    if let Err(error) = &child_observation {
        capture_failure(pid as i32, None, ownership_id, error);
    }
    let observed_start = child_observation.ok().flatten();
    let child_start = previous.map_or(observed_start, |recorded| recorded.start_time);
    let mut tree = previous.map_or_else(Vec::new, |recorded| recorded.tree.clone());
    if let Some(start) = child_start {
        capture_complete &= capture_linked_descendants(pid as i32, start, ownership_id, &mut tree);
    }
    // Reuse exact descendant membership from this walk as well as the old
    // record. A fresh root is added only after the scan: its unavailable
    // ownership evidence must still make the capture incomplete.
    let scan = scan_tagged_pids_observing(
        ownership_env,
        ownership_id,
        Some(pid as i32),
        child_start,
        &tree,
        before_read,
    );
    capture_complete &= scan.complete;
    for p in scan.pids {
        before_read("member_stat", p);
        match proc_starttime_observation(p) {
            Ok(Some(st)) => {
                if !tree.contains(&(p, st)) {
                    tree.push((p, st));
                }
            }
            Ok(None) => {}
            Err(error) => {
                capture_failure(p, child_start, ownership_id, &error);
                capture_complete = false;
            }
        }
    }
    if !tree.iter().any(|(p, _)| *p == pid as i32) {
        if let Some(st) = child_start {
            tree.push((pid as i32, st));
        }
    }
    CondemnedRuntimeIdentity {
        pid,
        start_time: child_start,
        tree,
        ownership_id: ownership_id.to_string(),
        capture_complete,
    }
}

/// Non-Linux: no `/proc` — nothing can be captured (the direct child's
/// death remains the caller's portable floor; the fence stays held).
#[cfg(not(target_os = "linux"))]
pub fn record_condemned_runtime_identity(
    pid: u32,
    _ownership_env: &str,
    ownership_id: &str,
) -> CondemnedRuntimeIdentity {
    CondemnedRuntimeIdentity {
        pid,
        start_time: None,
        tree: Vec::new(),
        ownership_id: ownership_id.to_string(),
        capture_complete: false,
    }
}

/// The recorded-identity kill-and-confirm (b8ke focused round-3 R3-7):
/// like [`kill_and_confirm_tree_dead`] but driven by the identity captured
/// at kill time —
///
/// 1. The pid-reuse guard BEFORE any signal: a pid whose CURRENT start
///    time differs from the recorded one belongs to an unrelated
///    replacement process (the original incarnation is gone for the pid to
///    have been reused) — it is NEVER signaled; the sweep proceeds without
///    it.
/// 2. The graceful-then-forced direct-child kill — every signal issued
///    through a pidfd PINNED to the recorded incarnation (b8ke focused
///    round-5 R5-4: an unreadable start time or an unavailable pidfd is
///    NEVER proof of liveness — no signal is issued at all, and the kill
///    fails closed to the caller's unconfirmed path).
/// 3. The sweep runs over the RECORDED tree (reparented descendants whose
///    tags became unreadable are still confirmed dead-by-starttime) plus
///    any currently-readable tagged newcomers.
#[cfg(target_os = "linux")]
pub async fn kill_and_confirm_recorded_tree_dead(
    recorded: &CondemnedRuntimeIdentity,
    ownership_env: &str,
) -> bool {
    if !recorded.capture_complete {
        tracing::warn!(target: "freshell_freshagent::session_lease",
            pid = recorded.pid,
            ownership_id = %recorded.ownership_id,
            "session_lease.recorded_tree_incomplete: owned-process evidence is unavailable; \
             the reap remains unconfirmed"
        );
        return false;
    }
    let recorded = refresh_condemned_runtime_identity(recorded, ownership_env);
    if !recorded.capture_complete {
        return false;
    }
    // The recorded start time is the identity license: the direct child's
    // signals ride the pidfd-pinned incarnation only (R5-4). No recorded
    // start time (the identity says the child was already gone at capture
    // — `proc_starttime` reads None for a dead or zombie process): NOTHING
    // is signaled on the bare pid (an unconfirmable identity never signals
    // its occupant) and the recorded tree alone is confirmed.
    if recorded.start_time.is_some() {
        match recorded_process_evidence(recorded.pid, recorded.start_time) {
            RecordedProcessEvidence::SameIncarnation => {
                let unconfirmed =
                    kill_recorded_child_unconfirmed(recorded.pid, recorded.start_time).await;
                if unconfirmed {
                    return false;
                }
            }
            RecordedProcessEvidence::Gone => {}
            RecordedProcessEvidence::Unavailable => return false,
        }
    }
    let swept = sweep_captured_tree_until_dead(
        recorded.tree.clone(),
        ownership_env,
        &recorded.ownership_id,
        Some(recorded.pid as i32),
        recorded.start_time,
    )
    .await;
    swept
}

/// Non-Linux: no `/proc` — hold closed (the fence stays held).
#[cfg(not(target_os = "linux"))]
pub async fn kill_and_confirm_recorded_tree_dead(
    _recorded: &CondemnedRuntimeIdentity,
    _ownership_env: &str,
) -> bool {
    false
}

#[cfg(not(target_os = "linux"))]
pub async fn kill_and_confirm_tree_dead(
    _pid: u32,
    _ownership_env: &str,
    _ownership_id: &str,
) -> bool {
    false
}

/// b8ke focused round-5 review R5-4: identity-safe signaling through a
/// pidfd PINNED to the recorded process incarnation. `pidfd_open` captures
/// the process currently holding the pid; the recorded start time is
/// reverified against that occupant and the signal is sent THROUGH the
/// pidfd — a pid recycled between the verify and the send can never
/// receive it (the pidfd addresses the original incarnation, and an exited
/// original answers ESRCH, not some replacement). Without a recorded
/// start time, or where the pidfd syscalls are unavailable (a kernel
/// without pidfd, or an unsupported architecture), the identity is
/// UNCONFIRMABLE: no signal is ever issued (fail-closed — the caller's
/// unconfirmed path, never a signal to a possibly-unrelated occupant).
#[cfg(target_os = "linux")]
mod pinned_signal {
    /// The unified-pool syscall numbers (stable ABI since Linux 5.3). The
    /// libc crate exports these only for some targets, so the numbers are
    /// declared for the architectures the pidfd path supports; every other
    /// Linux arch fails closed at runtime (the syscalls return `-ENOSYS`,
    /// [`super::signal_recorded_incarnation`] answers `Unconfirmable`).
    #[cfg(any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64",
        target_arch = "powerpc64",
        target_arch = "s390x",
        target_arch = "loongarch64"
    ))]
    const SYS_PIDFD_OPEN: libc::c_long = 434;
    #[cfg(any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64",
        target_arch = "powerpc64",
        target_arch = "s390x",
        target_arch = "loongarch64"
    ))]
    const SYS_PIDFD_SEND_SIGNAL: libc::c_long = 424;

    /// `pidfd_open(pid, 0)` — pin the process currently holding `pid`.
    /// `Err(1)` (`ESRCH`): NO process holds the pid — the recorded
    /// incarnation has provably exited (a process always holds its own
    /// pid while alive); `Err(other)`: the pidfd facility is unavailable
    /// (kernel/arch/permission) — the caller fails closed.
    #[cfg(any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64",
        target_arch = "powerpc64",
        target_arch = "s390x",
        target_arch = "loongarch64"
    ))]
    pub(super) fn open(pid: libc::pid_t) -> Result<i32, i32> {
        let fd = unsafe { libc::syscall(SYS_PIDFD_OPEN, pid, 0u32) };
        if fd >= 0 {
            Ok(fd as i32)
        } else {
            Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(-1))
        }
    }

    /// `pidfd_send_signal(pidfd, sig, NULL, 0)` — signal the PINNED
    /// incarnation exactly.
    #[cfg(any(
        target_arch = "x86_64",
        target_arch = "aarch64",
        target_arch = "riscv64",
        target_arch = "powerpc64",
        target_arch = "s390x",
        target_arch = "loongarch64"
    ))]
    pub(super) fn send_signal(pidfd: i32, sig: libc::c_int) -> bool {
        unsafe {
            libc::syscall(
                SYS_PIDFD_SEND_SIGNAL,
                pidfd,
                sig,
                std::ptr::null::<libc::c_void>(),
                0u32,
            ) == 0
        }
    }
}

/// The outcome of an identity-safe signal attempt (R5-4).
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IncarnationSignal {
    /// The signal was delivered through the pidfd to the recorded
    /// incarnation.
    Sent,
    /// The recorded incarnation is provably gone (a different process now
    /// holds the readable pid, or the pinned incarnation exited since the
    /// verify) — nothing was signaled and nothing of ours remains.
    Gone,
    /// The identity could not be pinned/verified (unreadable start time,
    /// unavailable pidfd) — NOTHING was signaled (fail-closed).
    Unconfirmable,
}

/// Issue ONE signal to the RECORDED process incarnation, identity-safe
/// (b8ke focused round-5 R5-4): pin the pid's current occupant with a
/// pidfd, verify the occupant still carries the recorded start time, and
/// send through the pidfd. Never signals an unconfirmable identity.
#[cfg(target_os = "linux")]
pub(crate) fn signal_recorded_incarnation(
    pid: u32,
    recorded_start: Option<u64>,
    sig: libc::c_int,
) -> IncarnationSignal {
    let Some(expected) = recorded_start else {
        // No recorded start time: the identity is unconfirmable — no
        // signal (fail-closed; the caller must NOT treat the pid's
        // occupant as the condemned child).
        return IncarnationSignal::Unconfirmable;
    };
    let pidfd = match pinned_signal::open(pid as libc::pid_t) {
        Ok(pidfd) => pidfd,
        // ESRCH: NO process holds the pid — the recorded incarnation has
        // provably exited (the strongest death proof available). Nothing
        // to signal; the caller proceeds to its tree confirmation.
        Err(libc::ESRCH) => return IncarnationSignal::Gone,
        // pidfd unavailable (kernel/arch without it, permission): without
        // the pin there is no identity-safe send — no signal.
        Err(_) => return IncarnationSignal::Unconfirmable,
    };
    let sent = match proc_starttime_observation(pid as i32) {
        Err(_) => {
            return {
                unsafe { libc::close(pidfd) };
                IncarnationSignal::Unconfirmable
            }
        }
        Ok(None) => false,
        // STILL the recorded incarnation at this instant — and the pidfd
        // pins that same occupant, so the send below cannot reach a
        // recycled replacement even if the pid turns over between this
        // verify and the send.
        Ok(Some(actual)) if actual == expected => {
            let sent = pinned_signal::send_signal(pidfd, sig);
            // `false` here is ESRCH: the pinned incarnation exited since
            // the verify — provably gone, never a replacement.
            sent
        }
        // A DIFFERENT readable process holds the pid: the original
        // incarnation is provably gone (the pid was reused) — never
        // signaled. The same holds for an UNREADABLE pid: `proc_starttime`
        // reads None exactly for a gone, zombie, or exited process (the
        // wait discipline's proof of death) — nothing to signal, nothing
        // of ours remains.
        Ok(Some(_)) => false,
    };
    unsafe { libc::close(pidfd) };
    if sent {
        IncarnationSignal::Sent
    } else {
        IncarnationSignal::Gone
    }
}

/// The direct child's graceful-then-forced kill with EVERY signal issued
/// through the pidfd-pinned recorded incarnation (b8ke focused round-5
/// R5-4). Returns `true` when the child's death could NOT be confirmed —
/// the caller must fail closed (its unconfirmed path), never claim the
/// reap. `recorded_start: None` (dead at capture per the identity
/// contract) skips signaling entirely; the recorded tree alone is
/// confirmed by the caller's sweep.
#[cfg(target_os = "linux")]
async fn kill_recorded_child_unconfirmed(pid: u32, recorded_start: Option<u64>) -> bool {
    let Some(expected) = recorded_start else {
        return false;
    };
    match signal_recorded_incarnation(pid, recorded_start, libc::SIGTERM) {
        IncarnationSignal::Sent => {}
        // The recorded incarnation is provably gone — nothing to kill.
        IncarnationSignal::Gone => return false,
        // Unconfirmable identity: NO signal was issued — fail closed.
        IncarnationSignal::Unconfirmable => {
            tracing::warn!(target: "freshell_freshagent::session_lease",
                pid, expected_start_time = expected,
                "session_lease.condemned_child_unconfirmable: the recorded child's identity \
                 could not be pinned/verified — no signal issued (fail-closed)"
            );
            return true;
        }
    }
    if wait_recorded_incarnation_gone(pid, recorded_start).await {
        return false;
    }
    // R4-8/R5-4: the escalation signal re-pins and re-verifies the
    // recorded incarnation immediately before firing — only the ORIGINAL
    // process is ever SIGKILLed, through the pidfd.
    match signal_recorded_incarnation(pid, recorded_start, libc::SIGKILL) {
        IncarnationSignal::Sent => {}
        // Exited (or turned over) since the grace wait — provably gone.
        IncarnationSignal::Gone => return false,
        IncarnationSignal::Unconfirmable => {
            tracing::warn!(target: "freshell_freshagent::session_lease",
                pid, expected_start_time = expected,
                "session_lease.condemned_child_escalation_unconfirmable: the escalation \
                 signal could not be pinned to the recorded incarnation — not issued"
            );
            return true;
        }
    }
    !wait_recorded_incarnation_gone(pid, recorded_start).await
}

/// b8ke focused episode-2 round-1 F5/F6: the process's recorded start time
/// for the delayed start-cancellation machinery — the pid-reuse guard the
/// cancellation signals verify against. `None` when the pid is absent or
/// (non-Linux) the platform cannot read it: the cancellation then carries
/// no confirmable identity and never signals (the fail-closed watchdog
/// treats it as unconfirmed).
#[cfg(target_os = "linux")]
pub(crate) fn recorded_start_time(pid: Option<u32>) -> Option<u64> {
    pid.and_then(|p| proc_starttime(p as i32))
}

/// Non-Linux: no `/proc` — no identity can be recorded; the cancellation
/// is unconfirmable by construction and never signals.
#[cfg(not(target_os = "linux"))]
pub(crate) fn recorded_start_time(_pid: Option<u32>) -> Option<u64> {
    None
}

/// b8ke focused round-4 review R4-8: the RECORDED-INCARNATION grace wait —
/// the kill path's quiescence poll. The pid counts as gone when it is no
/// longer the recorded incarnation: dead/zombie (`starttime` reads None)
/// OR RECYCLED (a different start time — the original incarnation is
/// provably dead and the replacement must never be signaled, so the wait
/// reports gone instead of letting the escalation fire at the unrelated
/// process). Bounded: 20 × 25ms, then a final check.
#[cfg(target_os = "linux")]
async fn wait_recorded_incarnation_gone(pid: u32, recorded_start: Option<u64>) -> bool {
    for _ in 0..20u8 {
        match recorded_process_evidence(pid, recorded_start) {
            RecordedProcessEvidence::Gone => return true,
            RecordedProcessEvidence::Unavailable => return false,
            RecordedProcessEvidence::SameIncarnation => {}
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    matches!(
        recorded_process_evidence(pid, recorded_start),
        RecordedProcessEvidence::Gone
    )
}

/// The process's `starttime` (field 22 of `/proc/<pid>/stat`, world-readable — no
/// ptrace needed), or `None` when the pid is gone, a zombie, or dead (`Z`/`X` state).
/// `(pid, starttime)` uniquely identifies a process incarnation: a recycled pid gets a
/// new starttime, so comparing both is the pid-reuse guard. `pub(crate)` for the claude
/// lane's confirmed-reap capture (b8ke delta review F2).
#[cfg(target_os = "linux")]
pub(crate) fn proc_starttime(pid: i32) -> Option<u64> {
    proc_starttime_observation(pid).ok().flatten()
}

/// Whether a failed `/proc/<pid>/…` access proves the process is gone: the
/// entry is absent (`NotFound`), or the task exited and was reaped between the
/// open and the read — procfs then answers `ESRCH` on the already-open
/// descriptor. Both mean the observed incarnation no longer exists; neither is
/// "unavailable" evidence. (A sweep reads exactly the processes it is killing,
/// so a member reaped mid-read is the expected race, not an unknown writer.)
#[cfg(target_os = "linux")]
fn proc_entry_gone(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH)
}

/// Read a process start time while preserving unavailable observations as a
/// distinct result from a process that is gone.
#[cfg(target_os = "linux")]
fn proc_starttime_observation(pid: i32) -> Result<Option<u64>, ProcObservationError> {
    match std::fs::File::open(format!("/proc/{pid}/stat")) {
        Ok(stat) => proc_starttime_from_open_stat(stat),
        Err(error) if proc_entry_gone(&error) => Ok(None),
        Err(error) => Err(ProcObservationError::io("stat_open", &error)),
    }
}

/// [`proc_starttime_observation`] past the open: the read of an
/// already-open `/proc/<pid>/stat` (split out so the open→read window —
/// the process reaped in between — is testable deterministically).
#[cfg(target_os = "linux")]
fn proc_starttime_from_open_stat(
    mut stat_file: std::fs::File,
) -> Result<Option<u64>, ProcObservationError> {
    use std::io::Read;
    let mut stat = String::new();
    match stat_file.read_to_string(&mut stat) {
        Ok(_) => {}
        Err(error) if proc_entry_gone(&error) => return Ok(None),
        Err(error) => return Err(ProcObservationError::io("stat_read", &error)),
    }
    // comm (field 2) may contain spaces/parens: split at the LAST ')' — the remainder
    // starts at field 3 (state), so starttime (field 22) is index 19 there.
    let invalid = || ProcObservationError::invalid("stat_parse");
    let rest = stat.rsplit(')').next().ok_or_else(invalid)?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    match fields.first() {
        Some(&"Z") | Some(&"X") => return Ok(None),
        None => return Err(invalid()),
        Some(_) => {}
    }
    fields
        .get(19)
        .ok_or_else(invalid)?
        .parse()
        .map(Some)
        .map_err(|_| invalid())
}

/// Classify the current occupant against the recorded process incarnation.
#[cfg(target_os = "linux")]
pub(crate) fn recorded_process_evidence(
    pid: u32,
    recorded_start: Option<u64>,
) -> RecordedProcessEvidence {
    match proc_starttime_observation(pid as i32) {
        Err(_) => RecordedProcessEvidence::Unavailable,
        Ok(None) => RecordedProcessEvidence::Gone,
        Ok(Some(actual)) => match recorded_start {
            Some(expected) if expected == actual => RecordedProcessEvidence::SameIncarnation,
            Some(_) => RecordedProcessEvidence::Gone,
            None => RecordedProcessEvidence::Unavailable,
        },
    }
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn recorded_process_evidence(
    _pid: u32,
    _recorded_start: Option<u64>,
) -> RecordedProcessEvidence {
    RecordedProcessEvidence::Unavailable
}

/// All live pids whose `/proc/<pid>/environ` carries `{env}={id}` (the ownership tag
/// the sidecar AND its SDK-spawned grandchildren inherit). Readable only for processes
/// this process may ptrace (YAMA) — see [`kill_and_confirm_tree_dead`]'s capture-first
/// design for why that constraint is handled there.
#[cfg(target_os = "linux")]
struct TaggedProcessScan {
    pids: Vec<i32>,
    complete: bool,
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcObservationError {
    stage: &'static str,
    kind: std::io::ErrorKind,
    errno: Option<i32>,
}

#[cfg(target_os = "linux")]
impl ProcObservationError {
    fn io(stage: &'static str, error: &std::io::Error) -> Self {
        Self {
            stage,
            kind: error.kind(),
            errno: error.raw_os_error(),
        }
    }

    fn invalid(stage: &'static str) -> Self {
        Self {
            stage,
            kind: std::io::ErrorKind::InvalidData,
            errno: None,
        }
    }
}

#[cfg(target_os = "linux")]
fn capture_failure(
    pid: i32,
    expected_start: Option<u64>,
    ownership_id: &str,
    error: &ProcObservationError,
) {
    // Debug/test harnesses do not necessarily install a tracing subscriber.
    // Keep failed observations diagnosable there with the same bounded fields.
    #[cfg(debug_assertions)]
    eprintln!(
        "{}",
        serde_json::json!({"severity":"warn","event":"session_lease.capture_incomplete","stage":error.stage,"pid":pid,"expectedStart":expected_start,"ownershipId":ownership_id,"errorKind":format!("{:?}",error.kind),"errno":error.errno,"captureComplete":false})
    );
    tracing::warn!(stage=error.stage, pid, ?expected_start, ownership_id,
        error_kind = ?error.kind, errno = ?error.errno,
        capture_complete = false, "session_lease.capture_incomplete");
}

/// A live parent link proves membership even when the host and provider have
/// different UIDs. Every parent incarnation is checked around the observation;
/// each child's own start and parent come from the same stat read.
#[cfg(target_os = "linux")]
fn capture_linked_descendants(
    root: i32,
    start: u64,
    ownership_id: &str,
    tree: &mut Vec<(i32, u64)>,
) -> bool {
    let mut pending = vec![(root, start)];
    let mut visited = std::collections::HashSet::new();
    let mut complete = true;
    while let Some((pid, expected)) = pending.pop() {
        if !visited.insert((pid, expected)) {
            continue;
        }
        match proc_starttime_observation(pid) {
            Ok(Some(actual)) if actual == expected => {}
            Ok(_) => continue,
            Err(error) => {
                capture_failure(pid, Some(start), ownership_id, &error);
                complete = false;
                continue;
            }
        }
        let observation = (|| -> Result<Vec<(i32, u64)>, ProcObservationError> {
            let tasks = std::fs::read_dir(format!("/proc/{pid}/task"))
                .map_err(|error| ProcObservationError::io("owned_tasks", &error))?;
            let mut children = Vec::new();
            for task in tasks {
                let task = task.map_err(|error| ProcObservationError::io("owned_task", &error))?;
                let row = std::fs::read_to_string(task.path().join("children"))
                    .map_err(|error| ProcObservationError::io("owned_children", &error))?;
                for child in row.split_whitespace() {
                    let child: i32 = child
                        .parse()
                        .map_err(|_| ProcObservationError::invalid("owned_child_pid"))?;
                    let stat = match std::fs::read_to_string(format!("/proc/{child}/stat")) {
                        Ok(stat) => stat,
                        Err(error) if proc_entry_gone(&error) => continue,
                        Err(error) => {
                            return Err(ProcObservationError::io("owned_child_stat", &error))
                        }
                    };
                    let fields: Vec<_> = stat
                        .rsplit(')')
                        .next()
                        .unwrap_or_default()
                        .split_whitespace()
                        .collect();
                    if matches!(fields.first(), Some(&"Z") | Some(&"X")) {
                        continue;
                    }
                    let parent: i32 = fields
                        .get(1)
                        .ok_or_else(|| ProcObservationError::invalid("owned_child_stat"))?
                        .parse()
                        .map_err(|_| ProcObservationError::invalid("owned_child_stat"))?;
                    let child_start: u64 = fields
                        .get(19)
                        .ok_or_else(|| ProcObservationError::invalid("owned_child_stat"))?
                        .parse()
                        .map_err(|_| ProcObservationError::invalid("owned_child_stat"))?;
                    if child <= 0 || parent != pid {
                        return Err(ProcObservationError::invalid("owned_child_link"));
                    }
                    children.push((child, child_start));
                }
            }
            if proc_starttime_observation(pid)? != Some(expected) {
                return Err(ProcObservationError::invalid("owned_parent_changed"));
            }
            Ok(children)
        })();
        match observation {
            Ok(children) => {
                for child in children {
                    if !tree.contains(&child) {
                        tree.push(child);
                    }
                    pending.push(child);
                }
            }
            Err(error) => {
                capture_failure(pid, Some(start), ownership_id, &error);
                complete = false;
            }
        }
    }
    complete
}

#[cfg(target_os = "linux")]
fn scan_tagged_pids_observing(
    ownership_env: &str,
    ownership_id: &str,
    owned_root_pid: Option<i32>,
    expected_start: Option<u64>,
    known_tree: &[(i32, u64)],
    before_read: &mut impl FnMut(&str, i32),
) -> TaggedProcessScan {
    let needle = format!("{ownership_env}={ownership_id}");
    let mut out = Vec::new();
    let entries = match std::fs::read_dir("/proc") {
        Ok(entries) => entries,
        Err(error) => {
            capture_failure(
                owned_root_pid.unwrap_or(0),
                expected_start,
                ownership_id,
                &ProcObservationError::io("proc_directory", &error),
            );
            return TaggedProcessScan {
                pids: out,
                complete: false,
            };
        }
    };
    let mut complete = true;
    before_read("proc_directory", owned_root_pid.unwrap_or(0));
    // Cross-UID membership is captured from anchored links above. A different
    // UID alone cannot authorize a signal or prove a descendant unrelated.
    let current_uid = unsafe { libc::geteuid() };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                capture_failure(
                    owned_root_pid.unwrap_or(0),
                    expected_start,
                    ownership_id,
                    &ProcObservationError::io("proc_directory_entry", &error),
                );
                // An unreadable directory entry leaves the process identity
                // unknown, so this capture cannot prove the tree is gone.
                complete = false;
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            capture_failure(
                owned_root_pid.unwrap_or(0),
                expected_start,
                ownership_id,
                &ProcObservationError::invalid("proc_directory_name"),
            );
            complete = false;
            continue;
        };
        let Ok(pid) = name.parse::<i32>() else {
            continue;
        };
        if Some(pid) == owned_root_pid
            && expected_start.is_some()
            && matches!(proc_starttime_observation(pid), Ok(Some(start)) if Some(start) != expected_start)
        {
            continue;
        }
        let status_path = std::path::Path::new("/proc").join(name).join("status");
        before_read("status", pid);
        let status = match std::fs::read_to_string(status_path) {
            Ok(status) => status,
            Err(error) if proc_entry_gone(&error) => continue,
            Err(error) => {
                if unreadable_process_may_be_owned(pid, owned_root_pid, expected_start, known_tree)
                {
                    capture_failure(
                        pid,
                        expected_start,
                        ownership_id,
                        &ProcObservationError::io("owned_status", &error),
                    );
                    complete = false;
                }
                continue;
            }
        };
        let Some(uid) = status
            .lines()
            .find_map(|line| line.strip_prefix("Uid:")?.split_whitespace().next())
            .and_then(|uid| uid.parse::<libc::uid_t>().ok())
        else {
            if unreadable_process_may_be_owned(pid, owned_root_pid, expected_start, known_tree) {
                capture_failure(
                    pid,
                    expected_start,
                    ownership_id,
                    &ProcObservationError::invalid("owned_uid"),
                );
                complete = false;
            }
            continue;
        };
        if uid != current_uid {
            continue;
        }
        let environ = std::path::Path::new("/proc").join(name).join("environ");
        before_read("environ", pid);
        let bytes = match std::fs::read(environ) {
            Ok(bytes) => bytes,
            // A process disappearing between the directory and environ read
            // is an expected race, not unknown surviving-writer evidence.
            Err(error) if proc_entry_gone(&error) => continue,
            Err(error) => {
                // Same-user processes can still make environ unreadable (for
                // example a non-dumpable user service). An unrelated process
                // cannot be evidence about this sidecar; an unreadable
                // process in the known sidecar ancestry does.
                if unreadable_process_may_be_owned(pid, owned_root_pid, expected_start, known_tree)
                {
                    capture_failure(
                        pid,
                        expected_start,
                        ownership_id,
                        &ProcObservationError::io("owned_environ", &error),
                    );
                    complete = false;
                }
                continue;
            }
        };
        if bytes.split(|b| *b == 0).any(|kv| kv == needle.as_bytes()) {
            out.push(pid);
        }
    }
    TaggedProcessScan {
        pids: out,
        complete,
    }
}

#[cfg(target_os = "linux")]
fn process_is_known_owned_process(
    pid: i32,
    owned_root_pid: Option<i32>,
    expected_start: Option<u64>,
) -> bool {
    owned_root_pid.is_some_and(|root| {
        // The direct root is expected to be a zombie briefly after the
        // watcher reaps it. Its unreadable `/proc/<pid>/environ` is therefore
        // evidence of normal exit, not an unknown surviving writer.
        if pid == root && matches!(proc_starttime_observation(pid), Ok(None)) {
            return false;
        }
        expected_start.is_some()
            && proc_starttime_observation(root).ok().flatten() == expected_start
            && process_is_descendant_of(pid, root).unwrap_or(false)
            && proc_starttime_observation(root).ok().flatten() == expected_start
    })
}

#[cfg(target_os = "linux")]
fn unreadable_process_may_be_owned(
    pid: i32,
    owned_root_pid: Option<i32>,
    expected_start: Option<u64>,
    known_tree: &[(i32, u64)],
) -> bool {
    unreadable_process_may_be_owned_observing(
        pid,
        owned_root_pid,
        expected_start,
        known_tree,
        &mut || {},
    )
}

#[cfg(target_os = "linux")]
fn unreadable_process_may_be_owned_observing(
    pid: i32,
    owned_root_pid: Option<i32>,
    expected_start: Option<u64>,
    known_tree: &[(i32, u64)],
    after_stat: &mut impl FnMut(),
) -> bool {
    let observed = match proc_starttime_observation(pid) {
        Ok(None) => return false,
        Ok(Some(start)) => start,
        Err(_) => return expected_start.is_some(),
    };
    after_stat();
    // This exact original incarnation already has positive ownership evidence.
    if known_tree.contains(&(pid, observed)) {
        return false;
    }
    if process_is_known_owned_process(pid, owned_root_pid, expected_start) {
        return true;
    }
    let Some(root_start) = expected_start else {
        return false;
    };
    if observed < root_start {
        return false;
    }
    // A direct child of this non-subreaper cannot have reparented here from
    // the condemned root. PID1/subreapers must retain the uncertainty instead.
    let parent_pid = |candidate| {
        std::fs::read_to_string(format!("/proc/{candidate}/status"))
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find_map(|line| line.strip_prefix("PPid:")?.trim().parse::<u32>().ok())
            })
    };
    let mut subreaper: libc::c_int = 0;
    let is_subreaper =
        unsafe { libc::prctl(libc::PR_GET_CHILD_SUBREAPER, &mut subreaper, 0, 0, 0) };
    if std::process::id() != 1
        && Some(pid) != owned_root_pid
        && is_subreaper == 0
        && subreaper == 0
        && parent_pid(pid) == Some(std::process::id())
    {
        return false;
    }
    // The candidate can exit between its first stat and the ancestry/status
    // reads. Positive disappearance is not an unavailable surviving writer;
    // a live different incarnation or a failed read still retains uncertainty.
    if matches!(proc_starttime_observation(pid), Ok(None)) {
        return false;
    }
    // A later opaque orphan may have been born after the snapshot and lost its
    // ancestry. It is not licensed for signaling, but it prevents confirmation.
    #[cfg(debug_assertions)]
    eprintln!(
        "{}",
        serde_json::json!({"severity":"warn","event":"session_lease.opaque_ownership_unavailable","pid":pid,"rootPid":owned_root_pid,"expectedStart":expected_start,"observedStart":observed,"observerPid":std::process::id(),"parentPid":parent_pid(pid),"rootParentPid":owned_root_pid.and_then(parent_pid),"observerSubreaper":subreaper,"subreaperProbe":is_subreaper})
    );
    tracing::warn!(pid, ?owned_root_pid, ?expected_start, observed_start=observed,
        "session_lease.opaque_ownership_unavailable: opaque process may be a later reparented writer");
    true
}

#[cfg(target_os = "linux")]
fn process_is_descendant_of(mut pid: i32, root_pid: i32) -> Result<bool, ()> {
    for _ in 0..128 {
        if pid == root_pid {
            return Ok(true);
        }
        let status = match std::fs::read_to_string(format!("/proc/{pid}/status")) {
            Ok(status) => status,
            Err(error) if proc_entry_gone(&error) => return Ok(false),
            Err(_) => return Err(()),
        };
        let parent = status
            .lines()
            .find_map(|line| line.strip_prefix("PPid:")?.split_whitespace().next())
            .ok_or(())?
            .parse::<i32>()
            .map_err(|_| ())?;
        if parent <= 1 {
            return Ok(false);
        }
        pid = parent;
    }
    Err(())
}

/// The answer to a [`FreshAgentSessionLeases::claim`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FreshSessionClaim {
    /// The caller now holds the lease — it may spawn/resume, and MUST end with
    /// `complete()` (session registered) or `fail()` (released).
    Acquired,
    /// Another holder is in flight (or a revoked holder is held closed). The caller
    /// answers its client `SESSION_RESERVED { retryable: true }`.
    Held { retry_after_ms: u64 },
    /// The holder expired with a recorded kill handle: the caller must confirm the
    /// holder's ENTIRE tree dead (kill + ownership sweep), then
    /// `force_release_after_confirmed_kill` and re-claim ONCE.
    ExpiredNeedsKill { pid: u32, ownership_id: String },
    /// A completed winner's LIVE session owns this durable id (binding map hit,
    /// answered under the same lock) — the caller must ADOPT, never spawn.
    BoundLive { live_session_key: String },
}

struct LeaseEntry {
    holder_request_id: String,
    acquired_at_ms: u64,
    kill_handle: Option<(u32 /* pid */, String /* ownership_id */)>,
    revoked: bool,
}

/// A completed lease binding carries the runtime incarnation that won it.
/// Keeping the ownership tag beside the live-session key lets a delayed
/// teardown prove it still owns the binding before reopening the durable id.
#[derive(Clone, Debug)]
struct Binding {
    live_session_key: String,
    ownership_id: Option<String>,
}

#[derive(Default)]
struct Inner {
    leases: HashMap<String, LeaseEntry>,
    /// durable key -> live sessions-map key, recorded by `complete()` UNDER THE SAME
    /// LOCK as the lease removal (registry.rs:1931-1940: releasing first and binding
    /// under a separate lock opens a no-lease/no-binding window -> a second spawn).
    bindings: HashMap<String, Binding>,
}

fn lease_key(provider: &str, session_id: &str) -> String {
    format!("{provider}\u{0}{session_id}")
}

/// The lease map: ONE `Mutex` over both the leases and the bindings maps, so every
/// claim/complete decision is atomic with respect to the binding record.
#[derive(Default)]
pub struct FreshAgentSessionLeases {
    inner: Mutex<Inner>,
}

impl FreshAgentSessionLeases {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claim `(provider, session_id)` for `holder_request_id` at `now_ms`. Checks the
    /// BINDINGS map FIRST, under the same lock as the lease map — the under-the-lock
    /// TOCTOU re-check. Caller pre-checks via `has_live_session` are a fast path ONLY,
    /// never the defense (a miss→win→release→duplicate-spawn interleaving is
    /// constructible without this).
    pub fn claim(
        &self,
        provider: &str,
        session_id: &str,
        holder_request_id: &str,
        now_ms: u64,
    ) -> FreshSessionClaim {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        // TOCTOU closure (registry.rs:1819-1844): a loser arriving after the winner's
        // complete() removed the lease sees the BINDING instead of an empty map.
        if let Some(binding) = inner.bindings.get(&key) {
            return FreshSessionClaim::BoundLive {
                live_session_key: binding.live_session_key.clone(),
            };
        }
        match inner.leases.get_mut(&key) {
            None => {
                inner.leases.insert(
                    key,
                    LeaseEntry {
                        holder_request_id: holder_request_id.to_string(),
                        acquired_at_ms: now_ms,
                        kill_handle: None,
                        revoked: false,
                    },
                );
                FreshSessionClaim::Acquired
            }
            Some(lease) => {
                let expired = now_ms
                    > lease
                        .acquired_at_ms
                        .saturating_add(fresh_agent_session_lease_ttl_ms());
                if !expired || lease.revoked {
                    // Re-claims by the SAME holder_request_id also answer Held: the
                    // original task is still running; idempotent re-sends are answered
                    // by the per-requestId dedup, not the lease.
                    return FreshSessionClaim::Held {
                        retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS,
                    };
                }
                match &lease.kill_handle {
                    Some((pid, ownership_id)) => FreshSessionClaim::ExpiredNeedsKill {
                        pid: *pid,
                        ownership_id: ownership_id.clone(),
                    },
                    None => {
                        lease.revoked = true;
                        tracing::error!(target: "invariant", provider, session_id,
                            holder = %lease.holder_request_id,
                            "fresh_agent_session_lease_revoked: expired handle-less holder — holding closed");
                        FreshSessionClaim::Held {
                            retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS,
                        }
                    }
                }
            }
        }
    }

    /// Arm the TTL kill path once the sidecar child pid AND its ownership tag are known
    /// (the tag drives the tree-kill sweep — a bare pid misses the SDK-spawned
    /// grandchild writer). No-op if the lease is gone or foreign.
    pub fn set_kill_handle(
        &self,
        provider: &str,
        session_id: &str,
        holder_request_id: &str,
        pid: u32,
        ownership_id: &str,
    ) {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        if let Some(lease) = inner.leases.get_mut(&key) {
            if lease.holder_request_id == holder_request_id {
                lease.kill_handle = Some((pid, ownership_id.to_string()));
            }
        }
    }

    /// Winner registered its session: insert `bindings[key] = live_session_key` and
    /// remove the lease IN THE SAME LOCK SCOPE. Returns `false` if the lease was
    /// revoked or foreign — the caller must tear down its own child and fail loudly
    /// (no binding recorded, lease untouched for foreign / held closed for revoked).
    pub fn complete(
        &self,
        provider: &str,
        session_id: &str,
        holder_request_id: &str,
        live_session_key: &str,
    ) -> bool {
        self.complete_with_identity(
            provider,
            session_id,
            holder_request_id,
            live_session_key,
            None,
        )
    }

    /// Complete a lease while retaining the sidecar incarnation that owns
    /// the binding. Teardown paths use this identity-scoped form so a stale
    /// watcher cannot clear a replacement binding for the same durable id.
    pub fn complete_with_identity(
        &self,
        provider: &str,
        session_id: &str,
        holder_request_id: &str,
        live_session_key: &str,
        ownership_id: Option<&str>,
    ) -> bool {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        match inner.leases.get(&key) {
            Some(lease) if lease.holder_request_id == holder_request_id && !lease.revoked => {
                inner.leases.remove(&key);
                inner.bindings.insert(
                    key,
                    Binding {
                        live_session_key: live_session_key.to_string(),
                        ownership_id: ownership_id.map(str::to_string),
                    },
                );
                true
            }
            _ => false,
        }
    }

    /// Spawn/resume failed: release. Safe for revoked leases — a holder calling
    /// `fail()` proves no orphan exists, so the key reopens.
    pub fn fail(&self, provider: &str, session_id: &str, holder_request_id: &str) {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        if let Some(lease) = inner.leases.get(&key) {
            if lease.holder_request_id == holder_request_id {
                inner.leases.remove(&key);
            }
        }
    }

    /// The bound live session exited: session exit watchers MUST call this or the
    /// durable id stays adopt-only forever.
    pub fn clear_binding(&self, provider: &str, session_id: &str) {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        inner.bindings.remove(&lease_key(provider, session_id));
    }

    /// Move a completed binding with the same live process after a native
    /// conversation reset. An unrelated or in-flight target is untouched.
    pub(crate) fn rekey_binding(
        &self,
        provider: &str,
        old: &str,
        new: &str,
        old_live_key: &str,
        new_live_key: &str,
        ownership_id: &str,
    ) -> bool {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let old_key = lease_key(provider, old);
        let new_key = lease_key(provider, new);
        let Some(binding) = inner.bindings.get(&old_key) else {
            return true;
        };
        if binding.live_session_key != old_live_key
            || binding.ownership_id.as_deref() != Some(ownership_id)
            || inner.bindings.contains_key(&new_key)
            || inner.leases.contains_key(&new_key)
        {
            return false;
        }
        let mut binding = inner.bindings.remove(&old_key).expect("validated binding");
        binding.live_session_key = new_live_key.into();
        inner.bindings.insert(new_key, binding);
        true
    }

    /// Clear a completed binding only when it still names the watched
    /// runtime. A missing or different ownership tag is a deliberate no-op:
    /// the caller is stale or cannot prove it owns the binding.
    pub fn clear_binding_if_matches(
        &self,
        provider: &str,
        session_id: &str,
        live_session_key: &str,
        ownership_id: &str,
    ) -> bool {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        let matches = inner.bindings.get(&key).is_some_and(|binding| {
            binding.live_session_key == live_session_key
                && binding.ownership_id.as_deref() == Some(ownership_id)
        });
        if matches {
            inner.bindings.remove(&key);
        }
        matches
    }

    /// Only legal after the holder's ENTIRE process tree death was confirmed
    /// (child kill + ownership sweep empty). Also clears any binding — the whole
    /// tree is confirmed dead.
    pub fn force_release_after_confirmed_kill(&self, provider: &str, session_id: &str) {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        inner.leases.remove(&key);
        inner.bindings.remove(&key);
    }

    /// Release a confirmed Codex runtime only when the current binding or
    /// in-flight lease belongs to that same sidecar incarnation. This is the
    /// single-owner cleanup path used by delayed/stale teardown continuations.
    /// It intentionally refuses to remove an untagged or replacement lease.
    pub fn force_release_after_confirmed_kill_if_matches(
        &self,
        provider: &str,
        session_id: &str,
        live_session_key: &str,
        ownership_id: &str,
    ) -> bool {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        let binding_matches = inner.bindings.get(&key).is_some_and(|binding| {
            binding.live_session_key == live_session_key
                && binding.ownership_id.as_deref() == Some(ownership_id)
        });
        let lease_matches = inner.leases.get(&key).is_some_and(|lease| {
            lease
                .kill_handle
                .as_ref()
                .is_some_and(|(_, tag)| tag == ownership_id)
        });
        let matched = binding_matches || lease_matches;
        if binding_matches {
            inner.bindings.remove(&key);
        }
        if lease_matches {
            inner.leases.remove(&key);
        }
        matched
    }

    /// kata b8ke Task 3: the CURRENT holder's armed kill handle, if any —
    /// the ownership watchdog's `kill_raw_for_watchdog` reaps an
    /// uncommitted, over-aged spawn's sidecar with the same `(pid,
    /// ownership tag)` pair the TTL expiry path kills by. Read-only; the
    /// lease itself is untouched.
    pub fn peek_kill_handle(&self, provider: &str, session_id: &str) -> Option<(u32, String)> {
        let inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        inner
            .leases
            .get(&lease_key(provider, session_id))
            .and_then(|lease| lease.kill_handle.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TTL: u64 = FRESH_AGENT_SESSION_LEASE_TTL_MS;

    #[cfg(target_os = "linux")]
    fn capture_child(non_dumpable: bool) -> (std::process::Child, String) {
        use std::io::BufRead;
        let tag = format!("capture-{}", uuid::Uuid::new_v4());
        let mut child = std::process::Command::new("python3")
            .args(["-c", if non_dumpable {
                "import ctypes,sys; assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0; print('ready',flush=True); assert sys.stdin.readline()=='exit\\n'"
            } else {
                "import sys; print('ready',flush=True); assert sys.stdin.readline()=='exit\\n'"
            }])
            .env("CAPTURE_TEST_OWNERSHIP", &tag)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn().unwrap();
        let mut ready = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready, "ready\n");
        (child, tag)
    }

    /// The dumpable root owns the opaque child's readiness/release pipes and
    /// reaps it on either our explicit exit or the production SIGTERM path.
    #[cfg(target_os = "linux")]
    struct LinkedOpaqueFixture {
        root: std::process::Child,
        replies: std::io::BufReader<std::process::ChildStdout>,
        tag: String,
    }

    #[cfg(target_os = "linux")]
    impl LinkedOpaqueFixture {
        fn new() -> Self {
            let tag = format!("capture-{}", uuid::Uuid::new_v4());
            let mut root = std::process::Command::new("python3")
                .args(["-c", r#"
import ctypes, json, os, signal, sys
libc = ctypes.CDLL(None)
child = None
release = None
def close(*_):
    if child is not None:
        os.write(release, b'X')
        assert os.waitpid(child, 0)[1] == 0
    sys.exit(0)
signal.signal(signal.SIGTERM, close)
print(json.dumps({'pid':os.getpid(), 'uid':os.geteuid(), 'dumpable':libc.prctl(3,0,0,0,0)}), flush=True)
for command in sys.stdin:
    if command == 'exit\n':
        close()
    if command in ('hide\n', 'show\n'):
        dumpable = int(command == 'show\n')
        assert libc.prctl(4,dumpable,0,0,0) == 0
        assert libc.prctl(3,0,0,0,0) == dumpable
        print(json.dumps({'dumpable':dumpable}), flush=True)
        continue
    assert command == 'spawn\n' and child is None
    reader, release = os.pipe()
    ready, ack = os.pipe()
    child = os.fork()
    if child == 0:
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        assert libc.prctl(4,0,0,0,0) == 0
        assert libc.prctl(3,0,0,0,0) == 0
        os.write(ack, json.dumps({'pid':os.getpid(), 'parent':os.getppid(), 'uid':os.geteuid(), 'dumpable':0}).encode() + b'\n')
        assert os.read(reader,1) == b'X'
        os._exit(0)
    with os.fdopen(ready) as replies:
        print(replies.readline(), end='', flush=True)
close()
"#])
                .env("CAPTURE_TEST_OWNERSHIP", &tag)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn().unwrap();
            let replies = std::io::BufReader::new(root.stdout.take().unwrap());
            let mut fixture = Self { root, replies, tag };
            let ready = fixture.read_reply();
            assert_eq!(ready["pid"], fixture.root.id());
            assert_eq!(ready["uid"], unsafe { libc::geteuid() });
            assert_eq!(ready["dumpable"], 1);
            fixture
        }

        fn read_reply(&mut self) -> serde_json::Value {
            use std::io::BufRead;
            let mut line = String::new();
            self.replies.read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        }

        fn command(&mut self, command: &[u8]) -> serde_json::Value {
            use std::io::Write;
            self.root
                .stdin
                .as_mut()
                .unwrap()
                .write_all(command)
                .unwrap();
            self.read_reply()
        }

        fn spawn_opaque_member(&mut self) -> (i32, u64) {
            let ready = self.command(b"spawn\n");
            let pid = ready["pid"].as_i64().unwrap() as i32;
            assert_eq!(ready["parent"], self.root.id());
            assert_eq!(ready["uid"], unsafe { libc::geteuid() });
            assert_eq!(ready["dumpable"], 0);
            assert_eq!(
                std::fs::read(format!("/proc/{pid}/environ"))
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::PermissionDenied
            );
            let start = proc_starttime(pid).unwrap();
            assert_eq!(
                process_is_descendant_of(pid, self.root.id() as i32),
                Ok(true)
            );
            (pid, start)
        }

        fn set_root_dumpable(&mut self, dumpable: bool) {
            let ready = self.command(if dumpable { b"show\n" } else { b"hide\n" });
            assert_eq!(ready["dumpable"], u8::from(dumpable));
        }

        fn close(&mut self) {
            use std::io::Write;
            if self.root.try_wait().unwrap().is_none() {
                let _ = self.root.stdin.as_mut().unwrap().write_all(b"exit\n");
            }
            assert!(self.root.wait().unwrap().success());
        }
    }

    #[cfg(target_os = "linux")]
    impl Drop for LinkedOpaqueFixture {
        fn drop(&mut self) {
            self.close();
        }
    }

    #[cfg(target_os = "linux")]
    async fn assert_linked_opaque_capture(late_member: bool) {
        let mut fixture = LinkedOpaqueFixture::new();
        let pid = fixture.root.id();
        let root_start = proc_starttime(pid as i32).unwrap();
        let original = late_member.then(|| {
            record_condemned_runtime_identity(pid, "CAPTURE_TEST_OWNERSHIP", &fixture.tag)
        });
        let member = fixture.spawn_opaque_member();
        let mut linked = Vec::new();
        let link_complete =
            capture_linked_descendants(pid as i32, root_start, &fixture.tag, &mut linked);
        let without_membership = scan_tagged_pids_observing(
            "CAPTURE_TEST_OWNERSHIP",
            &fixture.tag,
            Some(pid as i32),
            Some(root_start),
            &[],
            &mut |_, _| {},
        );
        let with_membership = scan_tagged_pids_observing(
            "CAPTURE_TEST_OWNERSHIP",
            &fixture.tag,
            Some(pid as i32),
            Some(root_start),
            &linked,
            &mut |_, _| {},
        );
        let recorded = original.unwrap_or_else(|| {
            record_condemned_runtime_identity(pid, "CAPTURE_TEST_OWNERSHIP", &fixture.tag)
        });
        let original_bytes = serde_json::to_vec(&recorded).unwrap();
        let refreshed = refresh_condemned_runtime_identity(&recorded, "CAPTURE_TEST_OWNERSHIP");
        let confirmed =
            kill_and_confirm_recorded_tree_dead(&recorded, "CAPTURE_TEST_OWNERSHIP").await;
        let root_survived_cleanup = proc_starttime(pid as i32) == Some(root_start);
        let member_survived_cleanup = proc_starttime(member.0) == Some(member.1);
        // Close and reap before the intended Red assertions, even when the
        // production consumer correctly refuses genuinely missing coverage.
        fixture.close();
        let root_reaped = !std::path::Path::new(&format!("/proc/{pid}")).exists();
        let member_reaped = !std::path::Path::new(&format!("/proc/{}", member.0)).exists();
        eprintln!(
            "{}",
            serde_json::json!({"severity":"info","event":"session_lease.linked_opaque_fixture","lateMember":late_member,"rootPid":pid,"rootStart":root_start,"member":member,"uid":unsafe {libc::geteuid()},"dumpable":0,"environPermissionDenied":true,"linkComplete":link_complete,"linked":linked,"scanWithoutMembership":without_membership.complete,"scanWithMembership":with_membership.complete,"originalComplete":recorded.capture_complete,"refreshedComplete":refreshed.capture_complete,"confirmed":confirmed,"rootSurvivedCleanup":root_survived_cleanup,"memberSurvivedCleanup":member_survived_cleanup,"rootReaped":root_reaped,"memberReaped":member_reaped})
        );
        assert!(root_reaped && member_reaped);
        assert!(
            link_complete,
            "missing descendant coverage is not an ownership-only defect"
        );
        assert!(linked.contains(&member));
        assert!(!without_membership.complete);
        assert!(
            with_membership.complete,
            "positive exact membership resolves only the duplicate ownership lookup"
        );
        assert!(
            with_membership.pids.contains(&(pid as i32)),
            "the original root's ownership tag remains readable and matching"
        );
        assert_eq!(serde_json::to_vec(&recorded).unwrap(), original_bytes);
        assert_eq!(recorded.start_time, Some(root_start));
        assert!(recorded
            .tree
            .iter()
            .all(|member| refreshed.tree.contains(member)));
        if late_member {
            assert!(
                recorded.capture_complete,
                "the original root-only record was complete"
            );
            assert!(!recorded.tree.contains(&member));
        } else {
            assert!(recorded.tree.contains(&member));
            assert!(
                recorded.capture_complete,
                "complete positive links must suffice for an opaque descendant"
            );
        }
        assert!(refreshed.tree.contains(&member));
        assert!(
            refreshed.capture_complete,
            "refresh must reuse complete positive links for the new member"
        );
        assert!(
            confirmed,
            "the unchanged original record must drive physical cleanup"
        );
        assert!(
            !root_survived_cleanup && !member_survived_cleanup,
            "confirmation must stop the actual root and writer"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linked_opaque_member_is_complete_at_initial_capture() {
        let _process_fixture = process_fixture::lock().await;
        assert_linked_opaque_capture(false).await;
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linked_opaque_member_first_seen_at_refresh_is_killed_from_original_record() {
        let _process_fixture = process_fixture::lock().await;
        assert_linked_opaque_capture(true).await;
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn linked_opaque_member_cannot_confirm_an_unavailable_root_or_incomplete_original() {
        let _process_fixture = process_fixture::lock().await;
        let mut fixture = LinkedOpaqueFixture::new();
        let member = fixture.spawn_opaque_member();
        fixture.set_root_dumpable(false);
        assert_eq!(
            std::fs::read(format!("/proc/{}/environ", fixture.root.id()))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::PermissionDenied
        );
        let original = record_condemned_runtime_identity(
            fixture.root.id(),
            "CAPTURE_TEST_OWNERSHIP",
            &fixture.tag,
        );
        let original_bytes = serde_json::to_vec(&original).unwrap();
        let unavailable_confirmed =
            kill_and_confirm_recorded_tree_dead(&original, "CAPTURE_TEST_OWNERSHIP").await;
        fixture.set_root_dumpable(true);
        let fresh = record_condemned_runtime_identity(
            fixture.root.id(),
            "CAPTURE_TEST_OWNERSHIP",
            &fixture.tag,
        );
        let refreshed = refresh_condemned_runtime_identity(&original, "CAPTURE_TEST_OWNERSHIP");
        let incomplete_confirmed =
            kill_and_confirm_recorded_tree_dead(&original, "CAPTURE_TEST_OWNERSHIP").await;
        let root_survived = proc_starttime(fixture.root.id() as i32) == original.start_time;
        let member_survived = proc_starttime(member.0) == Some(member.1);
        fixture.close();
        assert!(original.tree.contains(&member));
        assert!(!original.capture_complete);
        assert!(!unavailable_confirmed);
        assert!(
            fresh.capture_complete,
            "restored root evidence permits only a new complete capture"
        );
        assert!(
            !refreshed.capture_complete,
            "refresh cannot upgrade original unavailable coverage"
        );
        assert!(original
            .tree
            .iter()
            .all(|member| refreshed.tree.contains(member)));
        assert!(!incomplete_confirmed);
        assert!(
            root_survived && member_survived,
            "incomplete original evidence cannot authorize a signal"
        );
        assert_eq!(serde_json::to_vec(&original).unwrap(), original_bytes);
        assert!(!std::path::Path::new(&format!("/proc/{}", member.0)).exists());
    }

    #[cfg(target_os = "linux")]
    async fn assert_capture_across_normal_exit(stage: &str, reap_before_read: bool) {
        use std::io::Write;
        let (mut child, tag) = capture_child(false);
        let pid = child.id();
        let start = proc_starttime(pid as i32).unwrap();
        let zombie_identity = || {
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
            let fields: Vec<_> = stat
                .rsplit(')')
                .next()
                .unwrap()
                .split_whitespace()
                .collect();
            (fields[0].to_owned(), fields[19].parse::<u64>().unwrap())
        };
        let mut exited = false;
        let recorded = record_condemned_runtime_identity_observing(
            pid,
            "CAPTURE_TEST_OWNERSHIP",
            &tag,
            &mut |observed, candidate| {
                if observed == stage && candidate == pid as i32 {
                    assert!(!exited);
                    child.stdin.as_mut().unwrap().write_all(b"exit\n").unwrap();
                    if reap_before_read {
                        assert!(child.wait().unwrap().success());
                    } else {
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_secs(2);
                        loop {
                            let (state, observed_start) = zombie_identity();
                            assert_eq!(observed_start, start);
                            if state == "Z" {
                                break;
                            }
                            assert!(
                                std::time::Instant::now() < deadline,
                                "normal exit did not reach zombie state"
                            );
                            std::thread::yield_now();
                        }
                    }
                    exited = true;
                }
            },
        );
        let confirmed =
            kill_and_confirm_recorded_tree_dead(&recorded, "CAPTURE_TEST_OWNERSHIP").await;
        if !reap_before_read {
            // No wait/try_wait has run: confirmation observes exactly the
            // original unreaped incarnation, then the owner finally reaps it.
            assert_eq!(zombie_identity(), ("Z".into(), start));
            assert!(child.wait().unwrap().success());
        }
        assert!(exited, "the {stage} barrier was actually exercised");
        assert_eq!(recorded.start_time, Some(start));
        assert_eq!(recorded.ownership_id, tag);
        assert_eq!(recorded.tree, vec![(pid as i32, start)]);
        assert!(
            recorded.capture_complete,
            "the {stage} exit lost coverage: {recorded:?}"
        );
        assert!(confirmed);
    }

    /// Each observation has its own barrier. These are controls: a green
    /// reap window is not a missing-behavior Red.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn capture_preserves_identity_when_exit_precedes_each_tree_read() {
        let _process_fixture = crate::session_lease::process_fixture::lock().await;
        for stage in ["status", "environ", "member_stat"] {
            assert_capture_across_normal_exit(stage, true).await;
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn capture_preserves_identity_during_unreaped_exit_at_each_tree_read() {
        let _process_fixture = crate::session_lease::process_fixture::lock().await;
        // proc_directory releases the normal exit after opening the iterator,
        // before enumeration; member_stat releases it after tagged discovery.
        for stage in ["proc_directory", "status", "environ", "member_stat"] {
            assert_capture_across_normal_exit(stage, false).await;
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn capture_keeps_a_real_unavailable_live_root_unconfirmed() {
        let _process_fixture = crate::session_lease::process_fixture::lock().await;
        use std::io::Write;
        let (mut child, tag) = capture_child(true);
        let pid = child.id();
        let start = proc_starttime(pid as i32).unwrap();
        assert_eq!(
            std::fs::read(format!("/proc/{pid}/environ"))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::PermissionDenied
        );
        let recorded = record_condemned_runtime_identity(pid, "CAPTURE_TEST_OWNERSHIP", &tag);
        let confirmed =
            kill_and_confirm_recorded_tree_dead(&recorded, "CAPTURE_TEST_OWNERSHIP").await;
        let signaled = child.try_wait().unwrap().is_some();
        child.stdin.as_mut().unwrap().write_all(b"exit\n").unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(recorded.start_time, Some(start));
        assert_eq!(recorded.tree, vec![(pid as i32, start)]);
        assert!(!recorded.capture_complete);
        assert!(!confirmed);
        assert!(
            !signaled,
            "unavailable original evidence cannot authorize a signal"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn capture_retains_linked_descendants_without_readable_ownership_tags() {
        let _process_fixture = crate::session_lease::process_fixture::blocking_lock();
        use std::io::{BufRead, Write};
        let tag = format!("capture-{}", uuid::Uuid::new_v4());
        let mut root = std::process::Command::new("python3")
            .args(["-c", r#"
import os, subprocess, sys
child = subprocess.Popen([sys.executable, '-c', "import sys; print('ready',flush=True); assert sys.stdin.readline()=='exit\\n'"], env={}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
assert child.stdout.readline() == 'ready\n'
print(child.pid, flush=True)
assert sys.stdin.readline() == 'exit\n'
child.stdin.write('exit\n'); child.stdin.flush()
assert child.wait() == 0
"#])
            .env("CAPTURE_TEST_OWNERSHIP", &tag)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn().unwrap();
        let mut ready = String::new();
        std::io::BufReader::new(root.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        let descendant: i32 = ready.trim().parse().unwrap();
        let start = proc_starttime(descendant).unwrap();
        let original = record_condemned_runtime_identity(root.id(), "CAPTURE_TEST_OWNERSHIP", &tag);
        let root_start = original.start_time.unwrap();
        let stale = CondemnedRuntimeIdentity {
            start_time: Some(root_start + 1),
            tree: vec![(root.id() as i32, root_start + 1)],
            ..original.clone()
        };
        let stale_observed = refresh_condemned_runtime_identity(&stale, "CAPTURE_TEST_OWNERSHIP");
        root.stdin.as_mut().unwrap().write_all(b"exit\n").unwrap();
        assert!(root.wait().unwrap().success());
        assert!(original.capture_complete);
        assert_eq!(
            stale_observed.tree, stale.tree,
            "another root incarnation must not donate its descendants"
        );
        assert!(
            original.tree.contains(&(descendant, start)),
            "a positively linked child must survive the UID/tag filter: {original:?}"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn positively_unrelated_opaque_child_does_not_block_owned_cleanup() {
        let _process_fixture = crate::session_lease::process_fixture::lock().await;
        use std::io::Write;
        let (mut owned, tag) = capture_child(false);
        let (mut unrelated, _) = capture_child(true);
        let original =
            record_condemned_runtime_identity(owned.id(), "CAPTURE_TEST_OWNERSHIP", &tag);
        let confirmed =
            kill_and_confirm_recorded_tree_dead(&original, "CAPTURE_TEST_OWNERSHIP").await;
        let unrelated_signaled = unrelated.try_wait().unwrap().is_some();
        unrelated
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"exit\n")
            .unwrap();
        assert!(unrelated.wait().unwrap().success());
        let owned_exit = owned.wait().unwrap();
        assert!(original.capture_complete);
        assert!(confirmed);
        assert!(!unrelated_signaled);
        assert!(!owned_exit.success());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn opaque_candidate_reaped_during_observation_is_gone() {
        let _process_fixture = crate::session_lease::process_fixture::blocking_lock();
        use std::io::{BufRead, Write};
        let (mut owned, _) = capture_child(false);
        let root_start = proc_starttime(owned.id() as i32).unwrap();
        let mut other = std::process::Command::new("python3")
            .args([
                "-c",
                r#"
import ctypes, os, sys
reader, writer = os.pipe()
acks_r, acks_w = os.pipe()
child = os.fork()
if child == 0:
    assert ctypes.CDLL(None).prctl(4,0,0,0,0) == 0
    os.write(acks_w,b'R')
    assert os.read(reader,1) == b'X'
    os._exit(0)
assert os.read(acks_r,1) == b'R'
print(child,flush=True)
assert sys.stdin.readline() == 'close\n'
os.write(writer,b'X')
assert os.waitpid(child,0)[1] == 0
print('reaped',flush=True)
assert sys.stdin.readline() == 'exit\n'
"#,
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut replies = std::io::BufReader::new(other.stdout.take().unwrap());
        let mut line = String::new();
        replies.read_line(&mut line).unwrap();
        let candidate: i32 = line.trim().parse().unwrap();
        assert!(proc_starttime(candidate).unwrap() >= root_start);
        assert_eq!(
            std::fs::read(format!("/proc/{candidate}/environ"))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::PermissionDenied
        );
        let may_be_owned = unreadable_process_may_be_owned_observing(
            candidate,
            Some(owned.id() as i32),
            Some(root_start),
            &[],
            &mut || {
                other.stdin.as_mut().unwrap().write_all(b"close\n").unwrap();
                line.clear();
                replies.read_line(&mut line).unwrap();
                assert_eq!(line, "reaped\n");
            },
        );
        other.stdin.as_mut().unwrap().write_all(b"exit\n").unwrap();
        assert!(other.wait().unwrap().success());
        owned.stdin.as_mut().unwrap().write_all(b"exit\n").unwrap();
        assert!(owned.wait().unwrap().success());
        assert!(!may_be_owned, "positive reaping resolves this candidate, rather than reporting an unavailable live writer");
    }

    /// A process reaped between the open and the read of its `/proc` files
    /// reads as GONE — procfs answers ESRCH on the already-open descriptor —
    /// never as unavailable evidence. The expired-lease kill sweep reads
    /// exactly the processes it is killing; an "unavailable" verdict there
    /// left the kill unconfirmed and the lease held closed, so the contending
    /// create was refused SESSION_RESERVED although the tree was dead.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_process_reaped_between_proc_open_and_read_reads_as_gone() {
        let _process_fixture = crate::session_lease::process_fixture::blocking_lock();
        use std::io::Read;
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .expect("spawn a child to observe");
        let pid = child.id();
        let stat = std::fs::File::open(format!("/proc/{pid}/stat")).expect("open the live stat");
        let mut status =
            std::fs::File::open(format!("/proc/{pid}/status")).expect("open the live status");
        child.kill().expect("kill the child");
        child.wait().expect("reap the child");

        assert_eq!(
            proc_starttime_from_open_stat(stat),
            Ok(None),
            "a start-time read racing the reap answers gone, not unavailable"
        );
        let error = status
            .read_to_string(&mut String::new())
            .expect_err("procfs refuses a reaped task's open descriptor");
        assert!(
            proc_entry_gone(&error),
            "the scan's status/environ reads classify the reap race as gone: {error}"
        );
    }

    #[test]
    fn first_claim_acquires_second_is_held() {
        let leases = FreshAgentSessionLeases::new();
        assert_eq!(
            leases.claim("claude", "sid-1", "req-a", 1_000),
            FreshSessionClaim::Acquired
        );
        assert_eq!(
            leases.claim("claude", "sid-1", "req-b", 1_100),
            FreshSessionClaim::Held {
                retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS
            }
        );
    }

    #[test]
    fn different_sessions_and_providers_do_not_contend() {
        let leases = FreshAgentSessionLeases::new();
        assert_eq!(
            leases.claim("claude", "sid-1", "req-a", 0),
            FreshSessionClaim::Acquired
        );
        assert_eq!(
            leases.claim("claude", "sid-2", "req-b", 0),
            FreshSessionClaim::Acquired
        );
        assert_eq!(
            leases.claim("codex", "sid-1", "req-c", 0),
            FreshSessionClaim::Acquired
        );
    }

    #[test]
    fn winner_fail_releases_so_loser_acquires() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("codex", "sid-1", "req-a", 0);
        leases.fail("codex", "sid-1", "req-a");
        assert_eq!(
            leases.claim("codex", "sid-1", "req-b", 10),
            FreshSessionClaim::Acquired
        );
    }

    #[test]
    fn winner_complete_records_binding_and_loser_claim_answers_bound_live() {
        // THE TOCTOU PIN (registry.rs:1819-1844's exact window, no threads needed):
        // a loser preempted across the winner's register -> complete window must see
        // BoundLive — NEVER Acquired — after complete removed the winner's lease.
        let leases = FreshAgentSessionLeases::new();
        leases.claim("codex", "sid-1", "req-a", 0);
        assert!(leases.complete("codex", "sid-1", "req-a", "live-key-1"));
        assert_eq!(
            leases.claim("codex", "sid-1", "req-b", 10),
            FreshSessionClaim::BoundLive {
                live_session_key: "live-key-1".into()
            }
        );
    }

    #[test]
    fn conversation_reset_moves_only_the_matching_runtime_binding() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("claude", "old", "create", 0);
        assert!(leases.complete_with_identity("claude", "old", "create", "old", Some("owner")));
        assert!(!leases.rekey_binding("claude", "old", "new", "old", "new", "stale"));
        assert_eq!(
            leases.claim("claude", "old", "observe", 1),
            FreshSessionClaim::BoundLive {
                live_session_key: "old".into()
            }
        );
        assert!(leases.rekey_binding("claude", "old", "new", "old", "new", "owner"));
        assert_eq!(
            leases.claim("claude", "new", "observe", 2),
            FreshSessionClaim::BoundLive {
                live_session_key: "new".into()
            }
        );
        assert_eq!(
            leases.claim("claude", "old", "reuse", 2),
            FreshSessionClaim::Acquired
        );
        assert!(leases.clear_binding_if_matches("claude", "new", "new", "owner"));
        assert_eq!(
            leases.claim("claude", "new", "resume", 3),
            FreshSessionClaim::Acquired
        );
    }

    #[test]
    fn conversation_reset_does_not_overwrite_another_launch() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("claude", "old", "create", 0);
        assert!(leases.complete_with_identity("claude", "old", "create", "old", Some("owner")));
        leases.claim("claude", "new", "other", 0);
        assert!(!leases.rekey_binding("claude", "old", "new", "old", "new", "owner"));
        assert_eq!(
            leases.claim("claude", "old", "observe", 1),
            FreshSessionClaim::BoundLive {
                live_session_key: "old".into()
            }
        );
        assert!(matches!(
            leases.claim("claude", "new", "observe", 1),
            FreshSessionClaim::Held { .. }
        ));
    }

    #[test]
    fn clear_binding_reopens_after_the_bound_session_exits() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("codex", "sid-1", "req-a", 0);
        assert!(leases.complete("codex", "sid-1", "req-a", "live-key-1"));
        leases.clear_binding("codex", "sid-1");
        assert_eq!(
            leases.claim("codex", "sid-1", "req-b", 20),
            FreshSessionClaim::Acquired
        );
    }

    #[test]
    fn stale_confirmed_teardown_cannot_remove_a_replacement_binding() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("codex", "sid-identity", "req-old", 0);
        leases.set_kill_handle("codex", "sid-identity", "req-old", 100, "owner-old");
        assert!(leases.complete_with_identity(
            "codex",
            "sid-identity",
            "req-old",
            "live-old",
            Some("owner-old"),
        ));

        // The old watcher legitimately reopens the key first; a replacement
        // then wins and publishes its own binding before the old detached
        // confirmation runs again.
        assert!(leases.clear_binding_if_matches("codex", "sid-identity", "live-old", "owner-old",));
        leases.claim("codex", "sid-identity", "req-new", 1);
        leases.set_kill_handle("codex", "sid-identity", "req-new", 200, "owner-new");
        assert!(leases.complete_with_identity(
            "codex",
            "sid-identity",
            "req-new",
            "live-new",
            Some("owner-new"),
        ));

        assert!(!leases.force_release_after_confirmed_kill_if_matches(
            "codex",
            "sid-identity",
            "live-old",
            "owner-old",
        ));
        assert_eq!(
            leases.claim("codex", "sid-identity", "req-third", 2),
            FreshSessionClaim::BoundLive {
                live_session_key: "live-new".into()
            }
        );
    }

    #[test]
    fn expired_with_kill_handle_needs_kill_then_force_release_reopens() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("claude", "sid-1", "req-a", 0);
        leases.set_kill_handle("claude", "sid-1", "req-a", 4242, "own-1");
        assert_eq!(
            leases.claim("claude", "sid-1", "req-b", TTL + 1),
            FreshSessionClaim::ExpiredNeedsKill {
                pid: 4242,
                ownership_id: "own-1".into()
            }
        );
        // lease is still held until the tree-kill is confirmed
        assert_eq!(
            leases.claim("claude", "sid-1", "req-c", TTL + 2),
            FreshSessionClaim::ExpiredNeedsKill {
                pid: 4242,
                ownership_id: "own-1".into()
            }
        );
        leases.force_release_after_confirmed_kill("claude", "sid-1");
        assert_eq!(
            leases.claim("claude", "sid-1", "req-b", TTL + 3),
            FreshSessionClaim::Acquired
        );
    }

    #[test]
    fn expired_pidless_is_revoked_and_held_closed_and_late_complete_fails() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("opencode", "ses-1", "req-a", 0);
        assert_eq!(
            leases.claim("opencode", "ses-1", "req-b", TTL + 1),
            FreshSessionClaim::Held {
                retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS
            }
        );
        // revoked holder must tear down (no binding recorded)
        assert!(!leases.complete("opencode", "ses-1", "req-a", "live-x"));
        // fail() by the revoked holder proves no orphan exists and reopens
        leases.fail("opencode", "ses-1", "req-a");
        assert_eq!(
            leases.claim("opencode", "ses-1", "req-b", TTL + 2),
            FreshSessionClaim::Acquired
        );
    }

    #[test]
    fn set_kill_handle_by_foreign_request_is_a_no_op() {
        let leases = FreshAgentSessionLeases::new();
        leases.claim("claude", "sid-1", "req-a", 0);
        leases.set_kill_handle("claude", "sid-1", "req-INTRUDER", 999, "own-x");
        // still handle-less: expiry revokes instead of ExpiredNeedsKill
        assert_eq!(
            leases.claim("claude", "sid-1", "req-b", TTL + 1),
            FreshSessionClaim::Held {
                retry_after_ms: FRESH_AGENT_SESSION_RESERVED_RETRY_AFTER_MS
            }
        );
    }

    /// b8ke focused round-4 review R4-8: the grace wait (and the
    /// escalation decision after it) must revalidate the RECORDED start
    /// time — a pid that now belongs to a DIFFERENT incarnation was
    /// recycled while the original died, so the original is provably gone
    /// and the replacement must NEVER be signaled. Pre-fix, the grace
    /// wait polled PID EXISTENCE alone: a recycled pid made the wait
    /// answer "still alive" and the escalation SIGKILLed the unrelated
    /// replacement process.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_grace_wait_treats_a_recycled_pid_as_gone_and_never_escalates() {
        let _process_fixture = crate::session_lease::process_fixture::lock().await;
        // A live "unrelated replacement" process holding the recorded pid.
        let mut unrelated = tokio::process::Command::new("sleep")
            .arg("300")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the unrelated replacement");
        let pid = unrelated.id().expect("unrelated pid");
        // The recorded identity: the pid with the ORIGINAL (dead)
        // incarnation's start time — forged to differ from the
        // replacement's, the exact pid-reuse shape.
        let recorded_start = proc_starttime(pid as i32).expect("the replacement's start time") + 1;

        let began = std::time::Instant::now();
        let gone = wait_recorded_incarnation_gone(pid, Some(recorded_start)).await;
        assert!(
            gone,
            "a recycled pid's original incarnation is gone — the wait must report it gone"
        );
        assert!(
            began.elapsed() < std::time::Duration::from_secs(1),
            "the incarnation mismatch must be detected on the first poll, not the bounded window"
        );
        assert!(
            proc_starttime(pid as i32).is_some(),
            "the reused pid's unrelated process must never be signaled"
        );
        let _ = unrelated.kill().await;
    }

    /// b8ke focused round-4 review R4-8 (the matching-incarnation control):
    /// a pid that still carries the RECORDED start time is the original
    /// process — the wait must report it STILL PRESENT after the bounded
    /// window so the escalation signal stays licensed for exactly that
    /// incarnation.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_grace_wait_reports_a_live_recorded_incarnation_still_present() {
        let _process_fixture = crate::session_lease::process_fixture::lock().await;
        let mut child = tokio::process::Command::new("sleep")
            .arg("300")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the recorded child");
        let pid = child.id().expect("child pid");
        let recorded_start = proc_starttime(pid as i32).expect("the child's start time");

        let still_present = !wait_recorded_incarnation_gone(pid, Some(recorded_start)).await;

        assert!(
            still_present,
            "the recorded incarnation is alive — the wait must report it still present"
        );
        assert!(
            proc_starttime(pid as i32).is_some(),
            "the wait itself never signals — the live recorded incarnation survives it"
        );
        let _ = child.kill().await;
    }
    /// b8ke focused round-4 review R4-8 (the kill-path contract): a
    /// recorded identity whose pid belongs to an UNRELATED incarnation is
    /// never signaled at ANY point of the kill-and-confirm — the original
    /// is provably dead (only its recycled pid remains) and the
    /// confirmation proceeds through the recorded tree alone.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_recorded_kill_path_never_signals_a_recycled_pid() {
        let _process_fixture = crate::session_lease::process_fixture::lock().await;
        let mut unrelated = tokio::process::Command::new("sleep")
            .arg("300")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the unrelated replacement");
        let pid = unrelated.id().expect("unrelated pid");
        let recorded = CondemnedRuntimeIdentity {
            pid,
            start_time: Some(proc_starttime(pid as i32).expect("start time") + 1),
            tree: Vec::new(),
            ownership_id: "r48-kill-path".to_string(),
            capture_complete: true,
        };

        let confirmed = kill_and_confirm_recorded_tree_dead(&recorded, "R48_TEST_OWNERSHIP").await;

        assert!(
            confirmed,
            "the original incarnation is provably gone (its pid was recycled) — confirmed"
        );
        assert!(
            proc_starttime(pid as i32).is_some(),
            "the recycled pid's unrelated process must survive the whole kill-and-confirm"
        );
        let _ = unrelated.kill().await;
    }

    /// b8ke focused round-5 review R5-4: an UNCONFIRMABLE identity never
    /// signals. A recorded identity with NO start time cannot prove the
    /// pid's current occupant is the condemned child — pre-fix the guard
    /// treated it as "live" and SIGTERMed (then SIGKILLed) whatever held
    /// the pid, so a recycled occupant died. Post-fix the direct-child
    /// signals are licensed ONLY through a pidfd pinned to the RECORDED
    /// incarnation (verified before every send); with no identity there
    /// is no signal, and the recorded tree alone is confirmed.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn an_unconfirmable_identity_never_signals_the_pids_occupant() {
        let _process_fixture = crate::session_lease::process_fixture::lock().await;
        // A live process holding the recorded pid — under the forged
        // identity it is an unrelated occupant (the identity claims the
        // condemned child was already gone at capture time).
        let mut occupant = tokio::process::Command::new("sleep")
            .arg("300")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the unrelated occupant");
        let pid = occupant.id().expect("occupant pid");
        let unconfirmable = CondemnedRuntimeIdentity {
            pid,
            start_time: None,
            tree: Vec::new(),
            ownership_id: "r54-unconfirmable".to_string(),
            capture_complete: true,
        };

        let confirmed =
            kill_and_confirm_recorded_tree_dead(&unconfirmable, "R54_TEST_OWNERSHIP").await;

        assert!(
            confirmed,
            "the recorded identity says the child was dead at capture — the empty recorded \
             tree is confirmed without any signal"
        );
        assert!(
            proc_starttime(pid as i32).is_some(),
            "the UNCONFIRMABLE identity must never signal the pid's occupant"
        );
        let _ = occupant.kill().await;
    }

    /// b8ke focused round-5 review R5-4 (the pinned-signal positive
    /// control): a CONFIRMABLE identity — the pid still carrying the
    /// recorded start time — is signaled through the pidfd and the
    /// kill-and-confirm settles its death.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_recorded_incarnation_is_killed_through_the_pinned_pidfd() {
        let _process_fixture = crate::session_lease::process_fixture::lock().await;
        let mut child = tokio::process::Command::new("sleep")
            .arg("300")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the recorded child");
        let pid = child.id().expect("child pid");
        let recorded = CondemnedRuntimeIdentity {
            pid,
            start_time: proc_starttime(pid as i32),
            tree: Vec::new(),
            ownership_id: "r54-pinned".to_string(),
            capture_complete: true,
        };

        let confirmed = kill_and_confirm_recorded_tree_dead(&recorded, "R54_TEST_OWNERSHIP").await;

        assert!(
            confirmed,
            "the pinned-incarnation kill must confirm the recorded child's death"
        );
        assert!(
            proc_starttime(pid as i32).is_none(),
            "the recorded child itself was signaled (through the pidfd) and is dead"
        );
        let _ = child.kill().await;
    }

    /// An owned candidate whose process observation was incomplete is not a
    /// confirmed reap. The direct pid may already be gone, but the missing
    /// candidate evidence could still represent a surviving writer.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn incomplete_owned_process_evidence_keeps_the_reap_unconfirmed() {
        let _process_fixture = crate::session_lease::process_fixture::lock().await;
        let mut occupant = tokio::process::Command::new("sleep")
            .arg("300")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the evidence-test occupant");
        let pid = occupant.id().expect("occupant pid");
        let recorded = CondemnedRuntimeIdentity {
            pid,
            start_time: None,
            tree: Vec::new(),
            ownership_id: "r56-incomplete-evidence".to_string(),
            capture_complete: false,
        };

        let confirmed =
            kill_and_confirm_recorded_tree_dead(&recorded, "R56_INCOMPLETE_EVIDENCE").await;

        assert!(
            !confirmed,
            "incomplete owned evidence must retain the fence"
        );
        assert!(
            proc_starttime(pid as i32).is_some(),
            "the unconfirmable occupant must not be signaled"
        );
        let _ = occupant.kill().await;
    }
}

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
/// 2. Sweep the captured tree in graceful SIGTERM rounds, folding in any
///    still-readable tagged newcomers while ancestry is intact.
/// 3. Escalate stubborn members to SIGKILL and confirm every captured
///    `(pid,starttime)` incarnation is gone.
///
/// Returns `true` only when the whole captured tree is confirmed gone; callers may
/// `force_release` ONLY then. Non-Linux: no `/proc` — returns `false` (hold closed).
pub async fn kill_and_confirm_tree_dead(pid: u32, ownership_env: &str, ownership_id: &str) -> bool {
    let mut barrier = freshell_codex::transport::OwnedProcessTreeBarrier::capture(
        pid,
        ownership_env,
        ownership_id,
    );
    barrier.terminate_and_confirm().await
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

#[derive(Default)]
struct Inner {
    leases: HashMap<String, LeaseEntry>,
    /// durable key -> live sessions-map key, recorded by `complete()` UNDER THE SAME
    /// LOCK as the lease removal (registry.rs:1931-1940: releasing first and binding
    /// under a separate lock opens a no-lease/no-binding window -> a second spawn).
    bindings: HashMap<String, String>,
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
        if let Some(live) = inner.bindings.get(&key) {
            return FreshSessionClaim::BoundLive {
                live_session_key: live.clone(),
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
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        match inner.leases.get(&key) {
            Some(lease) if lease.holder_request_id == holder_request_id && !lease.revoked => {
                inner.leases.remove(&key);
                inner.bindings.insert(key, live_session_key.to_string());
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

    /// Only legal after the holder's ENTIRE process tree death was confirmed
    /// (child kill + ownership sweep empty). Also clears any binding — the whole
    /// tree is confirmed dead.
    pub fn force_release_after_confirmed_kill(&self, provider: &str, session_id: &str) {
        let mut inner = self.inner.lock().expect("fresh-agent lease lock poisoned");
        let key = lease_key(provider, session_id);
        inner.leases.remove(&key);
        inner.bindings.remove(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TTL: u64 = FRESH_AGENT_SESSION_LEASE_TTL_MS;

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
}

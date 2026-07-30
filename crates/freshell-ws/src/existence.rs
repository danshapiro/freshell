//! `SessionExistence` — the reconcile derivation's disk-truth input
//! (reconciliation-handshake design §5.1, second additive piece).
//!
//! Answers "does `provider:sessionId` exist on disk?" with DEFINED semantics:
//!
//! * [`SessionExistence::Present`] / [`SessionExistence::Absent`] require a
//!   **known provider** whose index has been consulted.
//! * An **unknown provider** returns `Absent` (surfacing as `fresh`/`invalid`
//!   downstream), never `Unknown`.
//! * [`SessionExistence::Unknown`] is reserved strictly for a *cold index on a
//!   known provider* (boot sweep not finished / index unavailable) — it is
//!   what makes the `error{index_warming}` verdict honest instead of
//!   guessing (§5.3 row 5).
//!
//! Trait-shaped so crate tests inject a fake; the real implementation is
//! backed by the shared `freshell_sessions::directory_index::SessionIndex`
//! and constructed in `freshell-server::main`, cloned into [`crate::WsState`]
//! — the exact precedent of the `identity` and locator handles.

use std::sync::Arc;

/// Disk-existence answer for one `provider:sessionId`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionExistence {
    /// The identity exists on disk (known provider, consulted index).
    Present,
    /// The identity does not exist on disk — ALSO the answer for an unknown
    /// provider (never `Unknown`).
    Absent,
    /// Known provider, but the index cannot answer yet (cold/unavailable).
    Unknown,
    /// Known provider whose session root does not exist on this machine —
    /// it will never warm up, so downstream answers an immediate
    /// `error{provider_unavailable}` with NO deferral (never `index_warming`).
    ProviderUnavailable,
}

/// The reconcile derivation's read-only view of disk session truth.
pub trait SessionExistenceProbe: Send + Sync {
    /// Does `provider:sessionId` exist on disk? See the module doc for the
    /// Present/Absent/Unknown contract.
    fn exists(&self, provider: &str, session_id: &str) -> SessionExistence;

    /// Whether this identity has EVER been observed on disk by this probe.
    /// Gates `dead_session` (§5.3 rows 4/4b): a data-loss-shaped verdict is
    /// only raised for an identity disk has some memory of — a never-observed
    /// (stale/typo) claim falls through to `fresh`.
    fn ever_observed(&self, provider: &str, session_id: &str) -> bool;

    /// "Seen on disk" strictly: true only if this process actually observed
    /// the session artifact on disk (index snapshots, or the claude
    /// locator-fallback hit). Unlike `ever_observed`, durable ledger bindings
    /// do NOT count — a binding proves the identity was minted, not that a
    /// transcript ever existed (PIN 1: the claude never-conversed carve-out
    /// keys on this distinction). Default: delegate to `ever_observed`, which
    /// is already disk-only for fakes without a ledger.
    fn ever_observed_on_disk(&self, provider: &str, session_id: &str) -> bool {
        self.ever_observed(provider, session_id)
    }

    /// Gate-caller variant of [`Self::exists`]: may perform EXPENSIVE by-id
    /// disk work (the codex rollout walk, ~1s on a real store) to adjudicate
    /// a warm-snapshot Absent. Callers MUST run it inside
    /// `tokio::task::spawn_blocking` (A13: never inline on the async
    /// runtime). `exists()` stays bounded for the sync reconcile path (the
    /// ~250ms reconcile IO budget). Default: delegate to `exists()`, so
    /// fakes and [`NoIndexProbe`] need no change.
    fn exists_for_gate(&self, provider: &str, session_id: &str) -> SessionExistence {
        self.exists(provider, session_id)
    }
}

/// The no-index fallback (mirrors `session_index: None` in
/// `freshell-server::main` when no provider home resolves): every query on a
/// KNOWN provider is honestly `Unknown` (the index does not exist, so nothing
/// can be asserted); unknown providers are `Absent` per the contract.
pub struct NoIndexProbe {
    known_providers: Vec<String>,
}

impl NoIndexProbe {
    pub fn new(known_providers: Vec<String>) -> Self {
        Self { known_providers }
    }
}

impl Default for NoIndexProbe {
    /// The four disk-indexed providers of `freshell-server::main`'s
    /// `SessionIndex` construction.
    fn default() -> Self {
        Self::new(
            ["claude", "codex", "opencode", "amplifier"]
                .into_iter()
                .map(str::to_string)
                .collect(),
        )
    }
}

impl SessionExistenceProbe for NoIndexProbe {
    fn exists(&self, provider: &str, _session_id: &str) -> SessionExistence {
        if self.known_providers.iter().any(|p| p == provider) {
            SessionExistence::Unknown
        } else {
            SessionExistence::Absent
        }
    }

    fn ever_observed(&self, _provider: &str, _session_id: &str) -> bool {
        false
    }
}

/// Shared handle type carried on [`crate::WsState`].
pub type SharedExistenceProbe = Arc<dyn SessionExistenceProbe>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_index_probe_is_unknown_for_known_provider_and_absent_for_unknown() {
        let probe = NoIndexProbe::default();
        assert_eq!(probe.exists("claude", "s1"), SessionExistence::Unknown);
        assert_eq!(probe.exists("amplifier", "s1"), SessionExistence::Unknown);
        // Unknown provider → Absent, NEVER Unknown (design §5.1 / change #4c).
        assert_eq!(
            probe.exists("not-a-provider", "s1"),
            SessionExistence::Absent
        );
        assert!(!probe.ever_observed("claude", "s1"));
    }
}

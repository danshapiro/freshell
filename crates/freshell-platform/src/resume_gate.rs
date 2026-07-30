//! Pre-spawn resume validation policy (resume-validation feature).
//!
//! Pure decision logic: given a provider and a disk-existence answer, decide
//! whether a cached resume id may be passed to the CLI or the pane must spawn
//! fresh. IO-free by design (mirrors `cli_launch`'s purity rule); callers map
//! their probe answers into [`ResumeExistence`].
//!
//! FAIL-OPEN INVARIANT: only a POSITIVE "store readable, session definitively
//! absent" returns [`ResumeGateDecision::SpawnFresh`]. Unknown/unreadable
//! stores, unvalidated providers (gemini, kimi, third-party), and the claude
//! zero-turn carve-out all Proceed (today's behavior).

use std::sync::Arc;

/// Providers whose on-disk store the existence probe knows how to read.
/// MUST stay a subset of `freshell-server`'s `KNOWN_PROVIDERS`: the probe's
/// contract maps unknown providers to `Absent`, so callers must check this
/// list BEFORE consulting the probe.
pub const VALIDATED_PROVIDERS: [&str; 4] = ["claude", "codex", "opencode", "amplifier"];

pub fn provider_validated(provider: &str) -> bool {
    VALIDATED_PROVIDERS.contains(&provider)
}

/// Caller-mapped existence answer. `ProviderUnavailable` maps to `Unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeExistence {
    Present,
    Absent,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeGateDecision {
    /// Pass the resume id through unchanged (validated present, or fail-open).
    Proceed,
    /// Definitively absent: drop the resume, spawn fresh, notify, retire.
    SpawnFresh,
}

pub fn evaluate_resume_gate(
    provider: &str,
    existence: ResumeExistence,
    ever_observed_on_disk: bool,
) -> ResumeGateDecision {
    if !provider_validated(provider) {
        return ResumeGateDecision::Proceed;
    }
    match existence {
        ResumeExistence::Present | ResumeExistence::Unknown => ResumeGateDecision::Proceed,
        ResumeExistence::Absent => {
            // Zero-turn carve-out: a freshell-minted claude session that never
            // conversed has no transcript on disk yet (mirrors
            // freshell-ws/reconcile.rs claude carve-out, deliberately more
            // fail-open: no ledger-bound requirement).
            //
            // Amplifier deliberately gets NO such carve-out (plan AD-5): a
            // never-used stub GC'd at terminal exit is indistinguishable on
            // disk from the incident's stale id, and the gate-fired fresh
            // spawn is an equivalent empty session for a never-typed pane.
            if provider == "claude" && !ever_observed_on_disk {
                ResumeGateDecision::Proceed
            } else {
                ResumeGateDecision::SpawnFresh
            }
        }
    }
}

/// The operator-visible notice line. MUST name the stale id (spec requirement).
pub fn stale_resume_notice(provider: &str, stale_id: &str) -> String {
    format!(
        "Saved {provider} session {stale_id} could not be found on disk — started a fresh session instead."
    )
}

/// Injection shape for crates that cannot depend on `freshell-ws`'s probe
/// trait (freshell-freshagent): one call answering both existence and
/// disk-history for `(provider, session_id)`.
pub struct ResumeProbeAnswer {
    pub existence: ResumeExistence,
    pub ever_observed_on_disk: bool,
}

pub type ResumeProbeFn = Arc<dyn Fn(&str, &str) -> ResumeProbeAnswer + Send + Sync>;

#[cfg(test)]
mod tests {
    use super::*;
    use ResumeExistence::*;
    use ResumeGateDecision::*;

    #[test]
    fn amplifier_absent_spawns_fresh() {
        // THE incident case: stale amplifier id with no session dir anywhere.
        // Deliberately ALSO covers the never-used-stub-GC'd-at-exit shape —
        // indistinguishable on disk from the incident (plan AD-5).
        assert_eq!(evaluate_resume_gate("amplifier", Absent, false), SpawnFresh);
        assert_eq!(evaluate_resume_gate("amplifier", Absent, true), SpawnFresh);
    }

    #[test]
    fn codex_and_opencode_absent_spawn_fresh() {
        assert_eq!(evaluate_resume_gate("codex", Absent, true), SpawnFresh);
        assert_eq!(evaluate_resume_gate("opencode", Absent, true), SpawnFresh);
        assert_eq!(evaluate_resume_gate("codex", Absent, false), SpawnFresh);
        assert_eq!(evaluate_resume_gate("opencode", Absent, false), SpawnFresh);
    }

    #[test]
    fn claude_zero_turn_carve_out_proceeds() {
        // Never observed on disk => could be a legit zero-turn session. Fail open.
        assert_eq!(evaluate_resume_gate("claude", Absent, false), Proceed);
    }

    #[test]
    fn claude_absent_but_previously_on_disk_spawns_fresh() {
        // Transcript existed once and is gone now: positive absence.
        assert_eq!(evaluate_resume_gate("claude", Absent, true), SpawnFresh);
    }

    #[test]
    fn present_and_unknown_always_proceed() {
        for p in VALIDATED_PROVIDERS {
            assert_eq!(evaluate_resume_gate(p, Present, false), Proceed);
            assert_eq!(evaluate_resume_gate(p, Unknown, false), Proceed);
            assert_eq!(evaluate_resume_gate(p, Present, true), Proceed);
            assert_eq!(evaluate_resume_gate(p, Unknown, true), Proceed);
        }
    }

    #[test]
    fn unvalidated_providers_never_blocked() {
        // gemini/kimi have no resumeArgs and are outside KNOWN_PROVIDERS;
        // the probe would answer Absent for them — the gate must not care.
        for p in ["gemini", "kimi", "some-third-party-ext", "shell"] {
            assert_eq!(evaluate_resume_gate(p, Absent, false), Proceed);
            assert!(!provider_validated(p));
        }
    }

    #[test]
    fn notice_names_the_stale_id() {
        let n = stale_resume_notice("amplifier", "8dab420a-f76b-407c-bcbe-dfb2a971c2e1");
        assert!(n.contains("amplifier"));
        assert!(n.contains("8dab420a-f76b-407c-bcbe-dfb2a971c2e1"));
        assert!(n.contains("could not be found"));
        assert!(n.contains("fresh session"));
    }
}

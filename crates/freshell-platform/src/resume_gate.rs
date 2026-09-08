//! Pre-spawn resume validation policy (resume-validation feature).
//!
//! Pure decision logic: given a provider and a disk-existence answer, decide
//! whether a cached resume id may be passed to the CLI or the pane must spawn
//! fresh. IO-free by design (mirrors `cli_launch`'s purity rule); callers map
//! their probe answers into [`ResumeExistence`].
//!
//! User-create requests preserve the legacy fail-open behavior. Managed
//! recovery is deliberately fail-closed: it may proceed only with positive
//! evidence and can never convert an absent or unreadable native session into a
//! fresh conversation.

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
    /// Pass the exact resume id through unchanged.
    Proceed,
    /// A user-create request may retire a stale id and intentionally start a
    /// new conversation. This outcome is impossible for managed recovery.
    SpawnFresh,
    /// Recovery evidence is absent, unreadable, or unsupported. Preserve the
    /// soul and surface a repair/retry path; never mint another conversation.
    BlockedRecovery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeIntent {
    /// A new user request may retain the legacy stale-id retirement behavior.
    UserCreate,
    /// Resurrection of an existing managed soul must preserve exact identity.
    ManagedRecovery,
}

fn evaluate_user_create_gate(
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
            // Zero-turn carve-out belongs only to user-create. The managed
            // coordinator requires its own durable never-dispatched proof.
            if provider == "claude" && !ever_observed_on_disk {
                ResumeGateDecision::Proceed
            } else {
                ResumeGateDecision::SpawnFresh
            }
        }
    }
}

fn evaluate_managed_recovery_gate(
    provider: &str,
    existence: ResumeExistence,
) -> ResumeGateDecision {
    match (provider_validated(provider), existence) {
        (true, ResumeExistence::Present) => ResumeGateDecision::Proceed,
        _ => ResumeGateDecision::BlockedRecovery,
    }
}

pub fn evaluate_resume_gate_for_intent(
    provider: &str,
    existence: ResumeExistence,
    ever_observed_on_disk: bool,
    intent: ResumeIntent,
) -> ResumeGateDecision {
    match intent {
        ResumeIntent::UserCreate => {
            evaluate_user_create_gate(provider, existence, ever_observed_on_disk)
        }
        ResumeIntent::ManagedRecovery => evaluate_managed_recovery_gate(provider, existence),
    }
}

pub fn evaluate_resume_gate(
    provider: &str,
    existence: ResumeExistence,
    ever_observed_on_disk: bool,
) -> ResumeGateDecision {
    evaluate_resume_gate_for_intent(
        provider,
        existence,
        ever_observed_on_disk,
        ResumeIntent::UserCreate,
    )
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
    fn managed_recovery_never_spawns_fresh() {
        for provider in [
            "claude",
            "codex",
            "opencode",
            "amplifier",
            "gemini",
            "kimi",
            "shell",
        ] {
            for existence in [Present, Absent, Unknown] {
                for ever_observed in [false, true] {
                    let decision = evaluate_resume_gate_for_intent(
                        provider,
                        existence,
                        ever_observed,
                        ResumeIntent::ManagedRecovery,
                    );
                    assert!(
                        matches!(decision, Proceed | BlockedRecovery),
                        "{provider} {existence:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn managed_recovery_requires_positive_supported_evidence() {
        for provider in VALIDATED_PROVIDERS {
            assert_eq!(
                evaluate_resume_gate_for_intent(
                    provider,
                    Present,
                    false,
                    ResumeIntent::ManagedRecovery,
                ),
                Proceed
            );
            for existence in [Absent, Unknown] {
                assert_eq!(
                    evaluate_resume_gate_for_intent(
                        provider,
                        existence,
                        false,
                        ResumeIntent::ManagedRecovery,
                    ),
                    BlockedRecovery
                );
            }
        }
        assert_eq!(
            evaluate_resume_gate_for_intent(
                "unimplemented-provider",
                Present,
                true,
                ResumeIntent::ManagedRecovery,
            ),
            BlockedRecovery
        );
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

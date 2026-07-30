//! Spawn-door resume validation (resume-validation feature): before a cached
//! session id is turned into resume argv, ask the disk-existence probe. On
//! POSITIVE absence, fall back to the same shape a genuinely fresh pane of
//! that mode uses. Unknown/unavailable always fail open.
//!
//! Callers (the spawn doors in `crate::terminal`) apply the outcome: retire
//! the stale ledger row, emit the notice, and never stamp the stale ref.

use freshell_platform::cli_launch::LaunchIntent;
use freshell_platform::resume_gate::{
    evaluate_resume_gate, provider_validated, stale_resume_notice, ResumeExistence,
    ResumeGateDecision,
};

use crate::existence::{SessionExistence, SessionExistenceProbe};

pub struct ResumeValidationOutcome {
    pub resume_session_id: Option<String>,
    pub launch_intent: LaunchIntent,
    /// True when the fallback minted a fresh claude Start id (caller must set
    /// its claude_fresh_prealloc flag so downstream identity stamping matches
    /// the genuine fresh-claude path).
    pub claude_fresh_prealloc: bool,
    /// Some(stale_id) iff the gate fired: caller retires the ledger row,
    /// emits the notice, and must NOT stamp the stale sessionRef.
    pub stale_session_id: Option<String>,
    pub notice: Option<String>,
}

fn passthrough(
    resume_session_id: Option<String>,
    launch_intent: LaunchIntent,
) -> ResumeValidationOutcome {
    ResumeValidationOutcome {
        resume_session_id,
        launch_intent,
        claude_fresh_prealloc: false,
        stale_session_id: None,
        notice: None,
    }
}

pub fn map_existence(e: SessionExistence) -> ResumeExistence {
    match e {
        SessionExistence::Present => ResumeExistence::Present,
        SessionExistence::Absent => ResumeExistence::Absent,
        SessionExistence::Unknown | SessionExistence::ProviderUnavailable => {
            ResumeExistence::Unknown
        }
    }
}

pub fn validate_wire_resume(
    mode: &str,
    resume_session_id: Option<String>,
    launch_intent: LaunchIntent,
    probe: &dyn SessionExistenceProbe,
) -> ResumeValidationOutcome {
    let Some(sid) = resume_session_id.clone().filter(|s| !s.is_empty()) else {
        return passthrough(resume_session_id, launch_intent);
    };
    if !provider_validated(mode) {
        return passthrough(resume_session_id, launch_intent);
    }
    let existence = map_existence(probe.exists_for_gate(mode, &sid));
    let ever_on_disk = probe.ever_observed_on_disk(mode, &sid);
    match evaluate_resume_gate(mode, existence, ever_on_disk) {
        ResumeGateDecision::Proceed => passthrough(resume_session_id, launch_intent),
        ResumeGateDecision::SpawnFresh => {
            let notice = stale_resume_notice(mode, &sid);
            let (fresh_id, intent, claude_prealloc) = match mode {
                // Mirror the genuine fresh-pane shapes in handle_create
                // (should_preallocate_fresh_claude / _amplifier).
                "claude" => (
                    Some(uuid::Uuid::new_v4().to_string()),
                    LaunchIntent::Start,
                    true,
                ),
                "amplifier" => (
                    Some(uuid::Uuid::new_v4().to_string()),
                    LaunchIntent::Resume,
                    false,
                ),
                _ => (None, LaunchIntent::Resume, false),
            };
            ResumeValidationOutcome {
                resume_session_id: fresh_id,
                launch_intent: intent,
                claude_fresh_prealloc: claude_prealloc,
                stale_session_id: Some(sid),
                notice: Some(notice),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::existence::{SessionExistence, SessionExistenceProbe};
    use freshell_platform::cli_launch::LaunchIntent;

    struct FakeProbe {
        answer: SessionExistence,
        ever_on_disk: bool,
    }
    impl SessionExistenceProbe for FakeProbe {
        fn exists(&self, _p: &str, _s: &str) -> SessionExistence {
            self.answer
        }
        fn ever_observed(&self, _p: &str, _s: &str) -> bool {
            false
        }
        fn ever_observed_on_disk(&self, _p: &str, _s: &str) -> bool {
            self.ever_on_disk
        }
    }

    fn absent() -> FakeProbe {
        FakeProbe {
            answer: SessionExistence::Absent,
            ever_on_disk: true,
        }
    }

    #[test]
    fn amplifier_absent_mints_fresh_uuid_and_reports_stale() {
        let out = validate_wire_resume(
            "amplifier",
            Some("stale-amp".into()),
            LaunchIntent::Resume,
            &absent(),
        );
        let fresh = out
            .resume_session_id
            .expect("fresh amplifier id preallocated");
        assert_ne!(fresh, "stale-amp");
        assert_eq!(out.launch_intent, LaunchIntent::Resume);
        assert!(!out.claude_fresh_prealloc);
        assert_eq!(out.stale_session_id.as_deref(), Some("stale-amp"));
        let notice = out.notice.expect("notice set");
        assert!(notice.contains("stale-amp"));
    }

    #[test]
    fn claude_absent_previously_on_disk_falls_back_to_start_intent() {
        let out = validate_wire_resume(
            "claude",
            Some("stale-claude".into()),
            LaunchIntent::Resume,
            &absent(),
        );
        assert!(out.resume_session_id.is_some());
        assert_ne!(out.resume_session_id.as_deref(), Some("stale-claude"));
        assert_eq!(out.launch_intent, LaunchIntent::Start);
        assert!(out.claude_fresh_prealloc);
        assert_eq!(out.stale_session_id.as_deref(), Some("stale-claude"));
    }

    #[test]
    fn claude_zero_turn_absent_proceeds_untouched() {
        let probe = FakeProbe {
            answer: SessionExistence::Absent,
            ever_on_disk: false,
        };
        let out = validate_wire_resume(
            "claude",
            Some("zero-turn".into()),
            LaunchIntent::Resume,
            &probe,
        );
        assert_eq!(out.resume_session_id.as_deref(), Some("zero-turn"));
        assert_eq!(out.launch_intent, LaunchIntent::Resume);
        assert!(out.stale_session_id.is_none());
        assert!(out.notice.is_none());
    }

    #[test]
    fn codex_and_opencode_absent_drop_resume_entirely() {
        for mode in ["codex", "opencode"] {
            let out = validate_wire_resume(
                mode,
                Some("stale-x".into()),
                LaunchIntent::Resume,
                &absent(),
            );
            assert!(out.resume_session_id.is_none());
            assert_eq!(out.stale_session_id.as_deref(), Some("stale-x"));
            assert!(out.notice.is_some());
        }
    }

    #[test]
    fn unknown_and_provider_unavailable_fail_open() {
        for answer in [
            SessionExistence::Unknown,
            SessionExistence::ProviderUnavailable,
        ] {
            let probe = FakeProbe {
                answer,
                ever_on_disk: false,
            };
            let out = validate_wire_resume(
                "amplifier",
                Some("maybe".into()),
                LaunchIntent::Resume,
                &probe,
            );
            assert_eq!(out.resume_session_id.as_deref(), Some("maybe"));
            assert!(out.stale_session_id.is_none());
            assert!(out.notice.is_none());
        }
    }

    #[test]
    fn present_passes_through_untouched() {
        let probe = FakeProbe {
            answer: SessionExistence::Present,
            ever_on_disk: true,
        };
        let out = validate_wire_resume(
            "amplifier",
            Some("real".into()),
            LaunchIntent::Resume,
            &probe,
        );
        assert_eq!(out.resume_session_id.as_deref(), Some("real"));
        assert!(out.stale_session_id.is_none());
    }

    #[test]
    fn unvalidated_providers_and_empty_ids_never_consult_probe() {
        struct PanickingProbe;
        impl SessionExistenceProbe for PanickingProbe {
            fn exists(&self, _: &str, _: &str) -> SessionExistence {
                panic!("probe must not be consulted");
            }
            fn ever_observed(&self, _: &str, _: &str) -> bool {
                panic!("probe must not be consulted");
            }
            fn ever_observed_on_disk(&self, _: &str, _: &str) -> bool {
                panic!("probe must not be consulted");
            }
        }
        for mode in ["gemini", "kimi", "shell", "third-party"] {
            let out = validate_wire_resume(
                mode,
                Some("id".into()),
                LaunchIntent::Resume,
                &PanickingProbe,
            );
            assert_eq!(out.resume_session_id.as_deref(), Some("id"));
        }
        let out = validate_wire_resume("amplifier", None, LaunchIntent::Resume, &PanickingProbe);
        assert!(out.resume_session_id.is_none());
        assert!(out.stale_session_id.is_none());
    }
}

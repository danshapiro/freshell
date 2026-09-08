//! Construction of exact, durable recovery candidates.
//!
//! This module never searches for a "latest" provider session.  It binds the
//! provider-native identity recorded for one soul to either its original
//! terminal launch or the deterministic native-session fixture.

use crate::registry::RecoveryContext;
use freshell_agent_runtime::{build_resume_spec, ResumeSpecInput, PROVIDER_HOME};
use freshell_runtime_protocol::{
    AllocationState, CheckpointReference, CredentialReference, DurablePosition, IdentityProvenance,
    ProviderSessionRef, ProviderVolumeRef, RecoveryBlockReason, RecoveryPath, RecoveryProbe,
    ResumeSpec, RetryHint, RESUME_SPEC_SCHEMA_VERSION,
};
use std::collections::BTreeMap;

pub fn exact_resume_candidate(
    context: &RecoveryContext,
    observed_native_session_id: Option<&str>,
) -> Result<Option<ResumeSpec>, RecoveryProbe> {
    if let (Some(recorded), Some(observed)) = (
        context.native_session_id.as_deref(),
        observed_native_session_id,
    ) {
        if recorded != observed {
            return Err(blocked(
                RecoveryBlockReason::WrongNativeIdentity,
                format!("runtime reported native identity {observed}, registry expects {recorded}"),
            ));
        }
    }

    if let Some(stored) = context.resume_spec.clone() {
        let expected = context.native_session_id.as_deref();
        if stored.provider_session.provider != context.provider
            || stored.provider_session.provider_store_id != context.provider_store_id
            || expected != Some(stored.provider_session.native_session_id.as_str())
        {
            return Err(blocked(
                RecoveryBlockReason::WrongNativeIdentity,
                "stored resume specification is not bound to the current soul identity".into(),
            ));
        }
        return Ok(Some(stored));
    }

    let native_session_id = observed_native_session_id
        .or(context.native_session_id.as_deref())
        .map(str::to_string);
    let Some(native_session_id) = native_session_id else {
        return Ok(None);
    };

    if let Some(terminal) = context.terminal.as_ref() {
        let spec = build_resume_spec(ResumeSpecInput {
            provider: &context.provider,
            provider_store_id: &context.provider_store_id,
            native_session_id: &native_session_id,
            terminal,
            provider_version: pinned_provider_version(&context.provider),
            creation_seed_ref: context.creation_seed_ref.clone(),
            checkpoint_revision: context.checkpoint_revision,
            evidence_revision: context.evidence_revision,
            never_dispatched: context.never_dispatched,
        })
        .map_err(|error| {
            blocked(
                RecoveryBlockReason::ImplementationUnavailable,
                error.to_string(),
            )
        })?;
        return Ok(Some(enrich_resume_spec(
            context,
            Some(terminal),
            spec,
            IdentityProvenance::ProviderObserved,
        )));
    }

    if context.fixture == Some(freshell_runtime_protocol::FixtureKind::NativeSession) {
        let spec = ResumeSpec {
            schema_version: RESUME_SPEC_SCHEMA_VERSION,
            provider_session: ProviderSessionRef {
                provider: context.provider.clone(),
                provider_store_id: context.provider_store_id.clone(),
                native_session_id,
            },
            mode: "native_session_fixture".into(),
            runtime_variant: "native_session_fixture".into(),
            program: "freshell-session-host fixture native_session".into(),
            resume_argv: Vec::new(),
            provider_home: PROVIDER_HOME.into(),
            provider_volume: None,
            cwd: PROVIDER_HOME.into(),
            workspace_path: PROVIDER_HOME.into(),
            project_key: Some(context.project_key.clone()),
            runtime_profile: Some(context.profile),
            environment: BTreeMap::from([("HOME".into(), PROVIDER_HOME.into())]),
            model: None,
            reasoning_effort: None,
            permission_mode: None,
            image_ref: None,
            provider_version: Some(env!("CARGO_PKG_VERSION").into()),
            credential_references: Vec::new(),
            identity_provenance: IdentityProvenance::FixtureObserved,
            durable_position: DurablePosition::default(),
            checkpoint_references: Vec::new(),
            creation_seed_ref: context.creation_seed_ref.clone(),
            checkpoint_revision: context.checkpoint_revision,
            allocation_state: AllocationState::VerifiedDurable,
            evidence_revision: context.evidence_revision,
            never_dispatched: context.never_dispatched,
        };
        return Ok(Some(enrich_resume_spec(
            context,
            None,
            spec,
            IdentityProvenance::FixtureObserved,
        )));
    }

    Err(blocked(
        RecoveryBlockReason::ImplementationUnavailable,
        format!(
            "provider {} has a native identity but no managed resume adapter",
            context.provider
        ),
    ))
}

fn enrich_resume_spec(
    context: &RecoveryContext,
    terminal: Option<&freshell_runtime_protocol::TerminalLaunchSpec>,
    mut spec: ResumeSpec,
    provenance: IdentityProvenance,
) -> ResumeSpec {
    spec.schema_version = RESUME_SPEC_SCHEMA_VERSION;
    spec.runtime_variant = if terminal.is_some() {
        "managed_terminal_pty".into()
    } else {
        "native_session_fixture".into()
    };
    spec.provider_volume = Some(ProviderVolumeRef {
        volume_name: context.prior_handle.provider_volume_name().to_string(),
        mount_path: PROVIDER_HOME.into(),
    });
    spec.project_key = Some(context.project_key.clone());
    spec.runtime_profile = Some(context.profile);
    spec.image_ref = Some(context.prior_handle.image_ref().to_string());
    spec.credential_references = terminal
        .into_iter()
        .flat_map(|terminal| terminal.provider_bootstrap_files.iter())
        .map(|file| CredentialReference {
            provider_relative_path: file.provider_relative_path.clone(),
        })
        .collect();
    spec.identity_provenance = provenance;
    spec.durable_position = DurablePosition {
        accepted_command_count: context.accepted_command_count,
        completed_command_count: context.completed_command_count,
        output_sequence: 0,
        provider_cursor: Some(format!("evidence:{}", context.evidence_revision)),
    };
    spec.checkpoint_references = if context.checkpoint_revision == 0 {
        Vec::new()
    } else {
        vec![CheckpointReference {
            kind: "provider_state".into(),
            reference: format!(
                "soul://{}/checkpoint/{}",
                context.soul_id, context.checkpoint_revision
            ),
            revision: context.checkpoint_revision,
            verified: true,
        }]
    };
    spec
}

fn pinned_provider_version(provider: &str) -> Option<String> {
    match provider {
        "claude" => Some("2.1.263".into()),
        "opencode" => Some("1.18.21".into()),
        _ => None,
    }
}

fn blocked(reason: RecoveryBlockReason, message: String) -> RecoveryProbe {
    RecoveryProbe::Blocked {
        path: RecoveryPath::NativeResume,
        reason,
        retry_hint: RetryHint {
            automatic_after_ms: None,
            manual_retry: true,
            repair: Some(message.clone()),
        },
        evidence: vec![message],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::OwnedRuntimeHandle;
    use freshell_runtime_protocol::{
        DesiredState, DockerDaemonId, DurabilityState, IncarnationId, InstallationId, LaunchNonce,
        RecoveryState, RuntimeLimits, RuntimeProfile, SoulId,
    };
    use std::path::PathBuf;

    fn fixture_context(native: Option<&str>) -> RecoveryContext {
        let soul = SoulId::parse("soul-resume-catalog").unwrap();
        let incarnation = IncarnationId::parse("incarnation-resume-catalog").unwrap();
        RecoveryContext {
            soul_id: soul.clone(),
            prior_handle: OwnedRuntimeHandle::from_registry(
                InstallationId::parse("installation-resume-catalog").unwrap(),
                soul,
                incarnation,
                LaunchNonce::parse("launch-resume-catalog").unwrap(),
                DockerDaemonId::parse("daemon-resume-catalog").unwrap(),
                "container".into(),
                "sha256:12345678901234567890".into(),
                PathBuf::from("/tmp/runtime"),
                PathBuf::from("/tmp/host"),
                "sha256:digest".into(),
                RuntimeLimits {
                    cpu_milli: 100,
                    memory_bytes: 1,
                    swap_bytes: 0,
                    pids_max: 4,
                },
                Some(freshell_runtime_protocol::FixtureKind::NativeSession),
                None,
                "freshell-provider-test".into(),
            ),
            provider: "phase1-fixture".into(),
            provider_store_id: "store".into(),
            native_session_id: native.map(str::to_string),
            creation_seed_ref: "seed".into(),
            desired_state: DesiredState::Running,
            intent_revision: 1,
            recovery_state: RecoveryState::Live,
            durability_state: DurabilityState::Unknown,
            allocation_state: AllocationState::Allocated,
            checkpoint_revision: 0,
            evidence_revision: 0,
            resume_spec: None,
            project_key: "test".into(),
            profile: RuntimeProfile::TestFixture,
            fixture: Some(freshell_runtime_protocol::FixtureKind::NativeSession),
            terminal: None,
            requested_limits: RuntimeLimits {
                cpu_milli: 100,
                memory_bytes: 1,
                swap_bytes: 0,
                pids_max: 4,
            },
            accepted_command_count: 2,
            completed_command_count: 1,
            never_dispatched: false,
            recovery_window_started_at: None,
            successful_recoveries_in_window: 0,
        }
    }

    #[test]
    fn native_fixture_candidate_is_exact() {
        let candidate = exact_resume_candidate(&fixture_context(Some("fixture-exact")), None)
            .unwrap()
            .unwrap();
        assert_eq!(
            candidate.provider_session.native_session_id,
            "fixture-exact"
        );
        assert_eq!(candidate.allocation_state, AllocationState::VerifiedDurable);
    }

    #[test]
    fn conflicting_observation_is_blocked() {
        assert!(matches!(
            exact_resume_candidate(&fixture_context(Some("expected")), Some("wrong")),
            Err(RecoveryProbe::Blocked {
                reason: RecoveryBlockReason::WrongNativeIdentity,
                ..
            })
        ));
    }
}

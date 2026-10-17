//! Construction of exact, durable recovery candidates.
//!
//! This module never searches for a "latest" provider session.  It binds the
//! provider-native identity recorded for one soul to either its original
//! terminal launch or the deterministic native-session fixture.

use crate::registry::{NativeImportState, RecoveryContext};
use freshell_agent_runtime::{
    build_resume_spec, pinned_fresh_provider_version, pinned_provider_version, ResumeSpecInput,
    PROVIDER_HOME,
};
use freshell_runtime_protocol::{
    AllocationState, CheckpointReference, CredentialReference, DurablePosition, IdentityProvenance,
    OpenCodeAdoptionBaseline, ProviderSessionRef, ProviderVolumeRef, RecoveryBlockReason,
    RecoveryPath, RecoveryProbe, ResumeSpec, RetryHint, RESUME_SPEC_SCHEMA_VERSION,
};
use std::collections::BTreeMap;

pub fn exact_resume_candidate(
    context: &RecoveryContext,
    observed_native_session_id: Option<&str>,
) -> Result<Option<ResumeSpec>, RecoveryProbe> {
    let Some(mut spec) = exact_resume_candidate_base(context, observed_native_session_id)? else {
        if context.opencode_adoption_baseline.is_some() {
            return Err(blocked(
                RecoveryBlockReason::StoreUnreadable,
                "the repaired soul has an adoption baseline but no exact resumable launch specification"
                    .into(),
            ));
        }
        return Ok(None);
    };

    // The saved launch/receipt stays immutable. A new read belongs to the
    // current registry evidence generation, including after import refresh.
    spec.evidence_revision = context.evidence_revision;
    let baseline = match context.opencode_adoption_baseline.clone() {
        Some(baseline) => Some(baseline),
        None => match spec.opencode_adoption_baseline.clone() {
            Some(baseline) => Some(baseline),
            None => derive_completed_import_baseline(context)?,
        },
    };
    let Some(baseline) = baseline else {
        return Ok(Some(spec));
    };
    let descriptor = &baseline.descriptor;
    if context.provider != "opencode"
        || context.native_import_state != NativeImportState::Completed
        || context.native_import_authority != "verified_import_receipt"
        || context.native_import_source_store_id.as_deref()
            != Some(descriptor.source_store_id.as_str())
        || context.native_import_root_session_id.as_deref()
            != Some(descriptor.root_session_id.as_str())
        || context.native_import_source_generation.as_deref()
            != Some(descriptor.source_generation.as_str())
        || context.native_session_id.as_deref() != Some(descriptor.root_session_id.as_str())
        || descriptor.destination_store_id != context.provider_store_id
        || spec.provider_session.provider != context.provider
        || spec.provider_session.provider_store_id != context.provider_store_id
        || spec.provider_session.native_session_id != descriptor.root_session_id
    {
        return Err(blocked(
            RecoveryBlockReason::StoreUnreadable,
            "the completed OpenCode adoption baseline does not match the soul's exact import identity"
                .into(),
        ));
    }
    if spec
        .opencode_adoption_baseline
        .as_ref()
        .is_some_and(|saved| saved != &baseline)
    {
        return Err(blocked(
            RecoveryBlockReason::WrongNativeIdentity,
            "the saved OpenCode resume baseline differs from the completed repair receipt".into(),
        ));
    }

    spec.opencode_adoption_baseline = Some(baseline);
    let data_home = format!("{PROVIDER_HOME}/.local/share");
    spec.environment.insert("HOME".into(), PROVIDER_HOME.into());
    spec.environment
        .insert("XDG_DATA_HOME".into(), data_home.clone());
    spec.environment
        .insert("XDG_CONFIG_HOME".into(), format!("{PROVIDER_HOME}/.config"));
    // Legacy repaired launches need the same native-library staging directory
    // as new managed OpenCode launches; the global /tmp mount remains noexec.
    spec.environment
        .insert("TMPDIR".into(), "/run/opencode-tmp".into());
    spec.environment.insert(
        "OPENCODE_DB".into(),
        format!("{data_home}/opencode/opencode.db"),
    );
    Ok(Some(spec))
}

fn derive_completed_import_baseline(
    context: &RecoveryContext,
) -> Result<Option<OpenCodeAdoptionBaseline>, RecoveryProbe> {
    if context.provider != "opencode"
        || context.native_import_state != NativeImportState::Completed
        || context.native_import_authority != "verified_import_receipt"
    {
        return Ok(None);
    }
    let descriptor = context
        .terminal
        .as_ref()
        .and_then(|terminal| terminal.opencode_transfer.as_ref())
        .ok_or_else(|| {
            blocked(
                RecoveryBlockReason::StoreUnreadable,
                "completed OpenCode import has no verified transfer descriptor for exact recovery"
                    .into(),
            )
        })?;
    OpenCodeAdoptionBaseline::from_descriptor(descriptor.clone())
        .map(Some)
        .map_err(|_| {
            blocked(
                RecoveryBlockReason::StoreUnreadable,
                "completed OpenCode import transfer descriptor is not valid recovery evidence"
                    .into(),
            )
        })
}

fn exact_resume_candidate_base(
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
            || (stored.claude_fork.is_some() && stored.claude_fork != context.claude_fork)
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
        if context.provider != "shell" && !context.never_dispatched {
            return Err(freshell_agent_runtime::unverified_native_probe());
        }
        return Ok(None);
    };

    if let Some(agent) = context.fresh_agent.as_ref() {
        let spec = ResumeSpec {
            claude_fork: context.claude_fork.clone(),
            schema_version: RESUME_SPEC_SCHEMA_VERSION,
            provider_session: ProviderSessionRef {
                provider: agent.provider.as_str().into(),
                provider_store_id: agent.provider_store_id.clone(),
                native_session_id,
            },
            mode: agent.session_type.clone(),
            runtime_variant: agent.runtime_variant.clone(),
            fixture_transport: agent.fixture_transport,
            opencode_adoption_baseline: None,
            program: "freshell-session-host fresh-agent".into(),
            resume_argv: Vec::new(),
            provider_home: PROVIDER_HOME.into(),
            provider_volume: Some(ProviderVolumeRef {
                volume_name: context.prior_handle.provider_volume_name().to_string(),
                mount_path: PROVIDER_HOME.into(),
            }),
            cwd: agent.cwd.clone(),
            workspace_path: agent.workspace_path.clone(),
            project_key: Some(context.project_key.clone()),
            runtime_profile: Some(context.profile),
            environment: BTreeMap::from([("HOME".into(), PROVIDER_HOME.into())]),
            model: agent.model.clone(),
            reasoning_effort: agent.effort.clone(),
            permission_mode: agent.permission_mode.clone(),
            image_ref: Some(context.prior_handle.image_ref().to_string()),
            provider_version: pinned_fresh_provider_version(&agent.provider),
            credential_references: agent
                .provider_bootstrap_files
                .iter()
                .map(|file| CredentialReference {
                    provider_relative_path: file.provider_relative_path.clone(),
                })
                .chain(
                    agent
                        .provider_secret_references
                        .iter()
                        .filter_map(|reference| {
                            reference
                                .profile
                                .auth_relative_path()
                                .map(|path| CredentialReference {
                                    provider_relative_path: path.into(),
                                })
                        }),
                )
                .collect(),
            identity_provenance: IdentityProvenance::ProviderObserved,
            durable_position: DurablePosition {
                accepted_command_count: context.accepted_command_count,
                completed_command_count: context.completed_command_count,
                output_sequence: 0,
                provider_cursor: Some(format!("evidence:{}", context.evidence_revision)),
            },
            checkpoint_references: checkpoint_references(context),
            creation_seed_ref: context.creation_seed_ref.clone(),
            checkpoint_revision: context.checkpoint_revision,
            allocation_state: AllocationState::VerifiedDurable,
            evidence_revision: context.evidence_revision,
            never_dispatched: context.never_dispatched,
        };
        return Ok(Some(spec));
    }

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
            claude_fork: None,
            schema_version: RESUME_SPEC_SCHEMA_VERSION,
            provider_session: ProviderSessionRef {
                provider: context.provider.clone(),
                provider_store_id: context.provider_store_id.clone(),
                native_session_id,
            },
            mode: "native_session_fixture".into(),
            runtime_variant: "native_session_fixture".into(),
            fixture_transport: None,
            opencode_adoption_baseline: None,
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
        .flat_map(|terminal| {
            terminal
                .provider_bootstrap_files
                .iter()
                .map(|file| CredentialReference {
                    provider_relative_path: file.provider_relative_path.clone(),
                })
                .chain(
                    terminal
                        .provider_secret_references
                        .iter()
                        .filter_map(|reference| {
                            reference
                                .profile
                                .auth_relative_path()
                                .map(|path| CredentialReference {
                                    provider_relative_path: path.into(),
                                })
                        }),
                )
                .collect::<Vec<_>>()
        })
        .collect();
    spec.identity_provenance = provenance;
    spec.durable_position = DurablePosition {
        accepted_command_count: context.accepted_command_count,
        completed_command_count: context.completed_command_count,
        output_sequence: 0,
        provider_cursor: Some(format!("evidence:{}", context.evidence_revision)),
    };
    spec.checkpoint_references = checkpoint_references(context);
    spec
}

fn checkpoint_references(context: &RecoveryContext) -> Vec<CheckpointReference> {
    if context.checkpoint_revision == 0 {
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
pub(crate) mod tests {
    use super::*;
    use crate::registry::{NativeImportState, OwnedRuntimeHandle};
    use freshell_runtime_protocol::{
        DesiredState, DockerDaemonId, DurabilityState, FreshAgentLaunchSpec, FreshProvider,
        IncarnationId, InstallationId, LaunchNonce, OpenCodeTransferDescriptor,
        OpenCodeTransferFile, RecoveryState, RuntimeLimits, RuntimeProfile, SoulId,
        TerminalLaunchSpec,
    };
    use sha2::Digest;
    use std::path::PathBuf;

    fn fixture_context(native: Option<&str>) -> RecoveryContext {
        let soul = SoulId::parse("soul-resume-catalog").unwrap();
        let incarnation = IncarnationId::parse("incarnation-resume-catalog").unwrap();
        RecoveryContext {
            claude_fork: None,
            native_identity_launch: None,
            soul_id: soul.clone(),
            prior_handle: OwnedRuntimeHandle::from_registry(
                InstallationId::parse("installation-resume-catalog").unwrap(),
                soul,
                "store".into(),
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
                None,
                "freshell-provider-test".into(),
            ),
            provider: "phase1-fixture".into(),
            provider_store_id: "store".into(),
            native_session_id: native.map(str::to_string),
            fresh_agent: None,
            creation_seed_ref: "seed".into(),
            desired_state: DesiredState::Running,
            intent_revision: 1,
            identity_revision: 0,
            recovery_state: RecoveryState::Live,
            durability_state: DurabilityState::Unknown,
            allocation_state: AllocationState::Allocated,
            checkpoint_revision: 0,
            evidence_revision: 0,
            native_import_revision: 0,
            native_import_state: NativeImportState::NotApplicable,
            native_import_source_store_id: None,
            native_import_root_session_id: None,
            native_import_source_generation: None,
            native_import_schema_fingerprint: None,
            native_import_migration_fingerprint: None,
            native_import_complete_inventory: false,
            native_import_authority: "no_import_configured".into(),
            recovery_attempt_id: None,
            control_epoch: 1,
            resume_spec: None,
            opencode_adoption_baseline: None,
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
            dispatched_command_count: 1,
            never_dispatched: false,
            recovery_window_started_at: None,
            successful_recoveries_in_window: 0,
        }
    }

    pub(crate) fn imported_opencode_descriptor() -> OpenCodeTransferDescriptor {
        let root_session_id = "ses_recovery_exact";
        let source_store_id = "b".repeat(64);
        let source_generation = "c".repeat(64);
        let source_schema_fingerprint = "d".repeat(64);
        let migration_journal_fingerprint = "e".repeat(64);
        let payload_sha256 = hex::encode(sha2::Sha256::digest(b"x"));
        let manifest_json = serde_json::json!({
            "version": 1,
            "provider_schema": "opencode-1.18.21",
            "root_session_id": root_session_id,
            "source_store_id": source_store_id,
            "source_schema_fingerprint": source_schema_fingerprint,
            "migration_journal_fingerprint": migration_journal_fingerprint,
            "sqlite_version": "test",
            "row_count": 0,
            "rows": [],
            "assets": [],
            "payload_bytes": 1,
            "payload_sha256": payload_sha256,
            "generation": source_generation,
        })
        .to_string();
        let files = vec![OpenCodeTransferFile {
            index: 0,
            relative_path: "payload.json".into(),
            size_bytes: 1,
            sha256: payload_sha256,
        }];
        let target_image_ref = format!("sha256:{}", "a".repeat(64));
        let mut descriptor = OpenCodeTransferDescriptor {
            transfer_id: "transfer-resume-catalog".into(),
            provider: "opencode".into(),
            source_store_id,
            root_session_id: root_session_id.into(),
            source_generation,
            provider_schema: "opencode-1.18.21".into(),
            source_schema_fingerprint,
            migration_journal_fingerprint,
            destination_store_id: "destination-store".into(),
            destination_database_path: freshell_runtime_protocol::OPENCODE_TRANSFER_DESTINATION_DB
                .into(),
            target_build_receipt: freshell_runtime_protocol::opencode_target_build_receipt(
                &target_image_ref,
                "opencode-1.18.21",
            ),
            target_image_ref,
            incarnation_id: "incarnation-resume-catalog".into(),
            manifest_json,
            files,
            total_bytes: 1,
            bundle_sha256: String::new(),
        };
        descriptor.bundle_sha256 = freshell_runtime_protocol::opencode_transfer_bundle_digest(
            &descriptor.manifest_json,
            &descriptor.files,
        );
        descriptor.validate().unwrap();
        descriptor
    }

    fn completed_import_context() -> RecoveryContext {
        let descriptor = imported_opencode_descriptor();
        let mut context = fixture_context(Some(&descriptor.root_session_id));
        context.provider = "opencode".into();
        context.provider_store_id = descriptor.destination_store_id.clone();
        context.fixture = None;
        context.native_import_state = NativeImportState::Completed;
        context.native_import_authority = "verified_import_receipt".into();
        context.native_import_source_store_id = Some(descriptor.source_store_id.clone());
        context.native_import_root_session_id = Some(descriptor.root_session_id.clone());
        context.native_import_source_generation = Some(descriptor.source_generation.clone());
        context.native_import_schema_fingerprint =
            Some(descriptor.source_schema_fingerprint.clone());
        context.native_import_migration_fingerprint =
            Some(descriptor.migration_journal_fingerprint.clone());
        context.terminal = Some(TerminalLaunchSpec {
            terminal_id: "terminal-resume-catalog".into(),
            stream_id: "stream-resume-catalog".into(),
            mode: "opencode".into(),
            program: "opencode".into(),
            args: vec!["--session".into(), descriptor.root_session_id.clone()],
            env: BTreeMap::from([("HOME".into(), PROVIDER_HOME.into())]),
            cwd: "/workspace/project".into(),
            run_as_uid: 65_534,
            run_as_gid: 0,
            cols: 80,
            rows: 24,
            project_key: "project-resume-catalog".into(),
            workspace_path: "/workspace".into(),
            git_common_dir: None,
            create_request_id: Some("create-resume-catalog".into()),
            resume_session_id: Some(descriptor.root_session_id.clone()),
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
            provider_launch_context: None,
            opencode_transfer: Some(descriptor),
            opencode_transfer_attempt_id: None,
            opencode_adoption: None,
        });
        context
    }

    #[test]
    fn hosted_fresh_agent_resume_preserves_exact_runtime_profile_and_native_identity() {
        let mut context = fixture_context(Some("thread-native-42"));
        context.provider = "codex".into();
        context.provider_store_id = "codex-store-42".into();
        context.fresh_agent = Some(FreshAgentLaunchSpec {
            session_id: "presentation-42".into(),
            provider: FreshProvider::Codex,
            session_type: "freshcodex".into(),
            runtime_variant: "codex-app-server-v1".into(),
            provider_store_id: "codex-store-42".into(),
            cwd: "/workspace/project".into(),
            workspace_path: "/workspace/project".into(),
            git_common_dir: None,
            run_as_uid: 65_534,
            run_as_gid: 0,
            model: Some("gpt-test".into()),
            effort: Some("high".into()),
            permission_mode: Some("ask".into()),
            sandbox: Some("workspace-write".into()),
            native_session_id: Some("thread-native-42".into()),
            plugins: None,
            model_selection: None,
            session_ref: None,
            fixture_transport: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
            provider_launch_context: None,
        });

        let resume = exact_resume_candidate(&context, Some("thread-native-42"))
            .unwrap()
            .unwrap();
        assert_eq!(
            resume.provider_session.native_session_id,
            "thread-native-42"
        );
        assert_eq!(resume.provider_session.provider_store_id, "codex-store-42");
        assert_eq!(resume.runtime_variant, "codex-app-server-v1");
        assert_eq!(resume.model.as_deref(), Some("gpt-test"));
        assert_eq!(resume.reasoning_effort.as_deref(), Some("high"));
        assert_eq!(resume.permission_mode.as_deref(), Some("ask"));
        assert_eq!(resume.fixture_transport, None);
        assert_eq!(resume.provider_version.as_deref(), Some("0.147.0"));

        context.provider = "opencode".into();
        let agent = context.fresh_agent.as_mut().unwrap();
        agent.provider = FreshProvider::Opencode;
        agent.session_type = "freshopencode".into();
        agent.runtime_variant = "opencode-sdk-ws".into();
        let opencode = exact_resume_candidate(&context, Some("thread-native-42"))
            .unwrap()
            .unwrap();
        assert_eq!(opencode.provider_version.as_deref(), Some("1.18.21"));
        assert_eq!(
            opencode.provider_session.native_session_id,
            "thread-native-42"
        );
        assert_eq!(opencode.provider_session.provider, "opencode");
        assert_eq!(opencode.model, resume.model);
        assert_eq!(opencode.permission_mode, resume.permission_mode);
    }

    fn claude_backed_fresh_context(provider: FreshProvider) -> RecoveryContext {
        let mut context = fixture_context(Some("native-exact"));
        context.provider = provider.as_str().into();
        context.fixture = None;
        context.profile = RuntimeProfile::DefaultAgent;
        let session_type = if provider == FreshProvider::Kilroy {
            "kilroy"
        } else {
            "freshclaude"
        };
        context.fresh_agent = Some(FreshAgentLaunchSpec {
            session_id: "presentation-key".into(),
            provider,
            session_type: session_type.into(),
            runtime_variant: "claude-sdk-sidecar".into(),
            provider_store_id: context.provider_store_id.clone(),
            cwd: "/workspace/project".into(),
            workspace_path: "/workspace/project".into(),
            git_common_dir: None,
            run_as_uid: 65_534,
            run_as_gid: 0,
            model: Some("selected-model".into()),
            effort: Some("low".into()),
            permission_mode: Some("default".into()),
            sandbox: None,
            native_session_id: Some("native-exact".into()),
            plugins: None,
            model_selection: None,
            session_ref: None,
            fixture_transport: None,
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
            provider_launch_context: None,
        });
        context
    }

    fn assert_selected_sdk_child_resume_profile(provider: FreshProvider) {
        let expected_provider = provider.as_str();
        let context = claude_backed_fresh_context(provider);
        let candidate = exact_resume_candidate(&context, Some("native-exact"))
            .unwrap()
            .unwrap();
        assert_eq!(candidate.provider_version.as_deref(), Some("2.1.237"));
        assert_eq!(candidate.provider_session.provider, expected_provider);
        assert_eq!(candidate.provider_session.native_session_id, "native-exact");
        assert_eq!(
            candidate.mode,
            context.fresh_agent.as_ref().unwrap().session_type
        );
        assert_eq!(candidate.runtime_profile, Some(context.profile));
        assert_eq!(candidate.model.as_deref(), Some("selected-model"));
        assert_eq!(candidate.permission_mode.as_deref(), Some("default"));
        assert_eq!(
            candidate.identity_provenance,
            IdentityProvenance::ProviderObserved
        );
        assert_eq!(candidate.fixture_transport, None);
        let projected = serde_json::to_value(&candidate).unwrap();
        assert_eq!(projected["providerVersion"], "2.1.237");
        assert!(matches!(
            exact_resume_candidate(&context, Some("wrong-root")),
            Err(RecoveryProbe::Blocked {
                reason: RecoveryBlockReason::WrongNativeIdentity,
                ..
            })
        ));
    }

    #[test]
    fn fresh_claude_catalog_preserves_selected_sdk_child_recovery_profile() {
        assert_selected_sdk_child_resume_profile(FreshProvider::Claude);
    }

    #[test]
    fn logical_kilroy_catalog_preserves_selected_sdk_child_recovery_profile() {
        assert_selected_sdk_child_resume_profile(FreshProvider::Kilroy);
    }

    #[test]
    fn saved_fresh_versions_remain_immutable_and_terminal_claude_stays_separate() {
        let mut fresh = claude_backed_fresh_context(FreshProvider::Claude);
        let mut saved = exact_resume_candidate(&fresh, None).unwrap().unwrap();
        saved.provider_version = Some("historical-native-version".into());
        fresh.resume_spec = Some(saved.clone());
        assert_eq!(
            exact_resume_candidate(&fresh, None).unwrap().unwrap(),
            saved
        );
        let mut terminal = completed_import_context();
        terminal.provider = "claude".into();
        terminal.native_import_state = NativeImportState::NotApplicable;
        terminal.native_import_authority = "no_import_configured".into();
        let launch = terminal.terminal.as_mut().unwrap();
        launch.mode = "claude".into();
        launch.program = "claude".into();
        launch.opencode_transfer = None;
        launch.args = vec![
            "--resume".into(),
            terminal.native_session_id.clone().unwrap(),
        ];
        let spec = exact_resume_candidate(&terminal, None).unwrap().unwrap();
        assert_eq!(spec.provider_version.as_deref(), Some("2.1.263"));
        assert_eq!(spec.mode, "claude");
        assert_eq!(
            spec.provider_session.native_session_id,
            terminal.native_session_id.unwrap()
        );
    }

    #[test]
    fn hosted_fixture_resume_preserves_typed_transport_selection() {
        let mut context = fixture_context(Some("thread-fixture-42"));
        context.provider = "codex".into();
        context.provider_store_id = "fixture-store-42".into();
        context.fresh_agent = Some(FreshAgentLaunchSpec {
            session_id: "presentation-fixture-42".into(),
            provider: FreshProvider::Codex,
            session_type: "freshcodex".into(),
            runtime_variant: "codex-app-server-v1".into(),
            provider_store_id: "fixture-store-42".into(),
            cwd: "/workspace/project".into(),
            workspace_path: "/workspace/project".into(),
            git_common_dir: None,
            run_as_uid: 65_534,
            run_as_gid: 0,
            model: Some("gpt-test".into()),
            effort: Some("low".into()),
            permission_mode: None,
            sandbox: Some("workspace-write".into()),
            native_session_id: Some("thread-fixture-42".into()),
            plugins: None,
            model_selection: None,
            session_ref: None,
            fixture_transport: Some(
                freshell_runtime_protocol::FreshAgentFixtureTransport::Deterministic,
            ),
            provider_bootstrap_files: Vec::new(),
            provider_secret_references: Vec::new(),
            provider_launch_context: None,
        });

        let resume = exact_resume_candidate(&context, Some("thread-fixture-42"))
            .unwrap()
            .unwrap();
        assert_eq!(
            resume.fixture_transport,
            Some(freshell_runtime_protocol::FreshAgentFixtureTransport::Deterministic)
        );
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

    #[test]
    fn dispatched_missing_identity_has_no_exact_candidate() {
        let mut context = fixture_context(None);
        context.never_dispatched = false;
        assert!(matches!(
            exact_resume_candidate(&context, None),
            Err(RecoveryProbe::Blocked {
                reason: RecoveryBlockReason::StoreUnreadable,
                ..
            })
        ));
    }

    #[test]
    fn offline_saved_spec_must_still_match_current_identity() {
        let mut context = fixture_context(Some("expected"));
        let mut spec = exact_resume_candidate(&context, None).unwrap().unwrap();
        spec.provider_session.native_session_id = "conflicting".into();
        context.resume_spec = Some(spec);
        assert!(matches!(
            crate::recovery::offline_probe(&context).unwrap(),
            RecoveryProbe::Blocked {
                reason: RecoveryBlockReason::WrongNativeIdentity,
                ..
            }
        ));
    }

    #[test]
    fn saved_candidate_is_inspected_at_the_current_evidence_revision() {
        let mut context = fixture_context(Some("expected"));
        let saved = exact_resume_candidate(&context, None).unwrap().unwrap();
        context.resume_spec = Some(saved.clone());
        context.evidence_revision += 1;
        let candidate = exact_resume_candidate(&context, None).unwrap().unwrap();
        assert_eq!(candidate.evidence_revision, context.evidence_revision);
        assert_eq!(candidate.provider_session, saved.provider_session);
        assert_eq!(candidate.resume_argv, saved.resume_argv);
        assert_eq!(
            candidate.opencode_adoption_baseline,
            saved.opencode_adoption_baseline
        );
        assert_eq!(context.resume_spec, Some(saved));
    }

    #[test]
    fn offline_recovery_derives_the_adoption_baseline_from_a_completed_import() {
        let context = completed_import_context();
        let descriptor = context
            .terminal
            .as_ref()
            .unwrap()
            .opencode_transfer
            .clone()
            .unwrap();
        let expected_baseline = freshell_runtime_protocol::OpenCodeAdoptionBaseline {
            manifest_sha256: format!(
                "{:x}",
                sha2::Sha256::digest(descriptor.manifest_json.as_bytes())
            ),
            descriptor,
        };

        let probe = crate::recovery::offline_probe(&context).unwrap();
        let RecoveryProbe::ResumeReady { resume_spec, .. } = probe else {
            panic!("completed OpenCode imports must recover without a live old host: {probe:?}");
        };
        assert_eq!(
            resume_spec.provider_session.native_session_id,
            "ses_recovery_exact"
        );
        assert_eq!(
            resume_spec.opencode_adoption_baseline,
            Some(expected_baseline)
        );
        assert_eq!(
            resume_spec
                .environment
                .get("OPENCODE_DB")
                .map(String::as_str),
            Some("/home/freshell/provider/.local/share/opencode/opencode.db")
        );
    }

    #[test]
    fn blocked_retry_reuses_persisted_resume_baseline_after_transfer_descriptor_cleanup() {
        let mut context = completed_import_context();
        let first_resume = exact_resume_candidate(&context, None).unwrap().unwrap();
        let baseline = first_resume.opencode_adoption_baseline.clone().unwrap();
        context.resume_spec = Some(first_resume);
        context.recovery_state = freshell_runtime_protocol::RecoveryState::Blocked;
        context.opencode_adoption_baseline = None;
        context.terminal.as_mut().unwrap().opencode_transfer = None;

        let probe = crate::recovery::offline_probe(&context).unwrap();
        let RecoveryProbe::ResumeReady { resume_spec, .. } = probe else {
            panic!("a blocked retry must retain the exact repair baseline: {probe:?}");
        };
        assert_eq!(resume_spec.opencode_adoption_baseline, Some(baseline));
        assert_eq!(
            resume_spec.provider_session.native_session_id,
            "ses_recovery_exact"
        );
    }

    #[cfg(unix)]
    #[test]
    fn repaired_opencode_resume_and_blocked_retry_select_executable_native_temp_directory() {
        let interpreter = std::process::Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .expect("resolve Node before clearing the native resolver's environment");
        assert!(interpreter.status.success());
        let node = PathBuf::from(String::from_utf8(interpreter.stdout).unwrap().trim());
        assert!(node.is_absolute());
        for legacy_tmpdir in [None, Some("/tmp")] {
            let mut context = completed_import_context();
            let terminal = context.terminal.as_mut().unwrap();
            terminal.opencode_transfer_attempt_id = Some("a".repeat(32));
            if let Some(tmpdir) = legacy_tmpdir {
                terminal.env.insert("TMPDIR".into(), tmpdir.into());
            }
            let original = context.terminal.clone().unwrap();
            let resume = exact_resume_candidate(&context, None).unwrap().unwrap();
            let baseline = resume.opencode_adoption_baseline.clone().unwrap();
            let launch =
                freshell_agent_runtime::prepare_terminal_for_resume(&original, &resume).unwrap();
            assert_native_temp_directory(&node, &launch);
            assert_eq!(context.terminal, Some(original.clone()));

            // A persisted legacy candidate must be upgraded on Retry as well,
            // even after the transient transfer descriptor has been cleared.
            let mut saved = resume.clone();
            saved.environment.remove("TMPDIR");
            if let Some(tmpdir) = legacy_tmpdir {
                saved.environment.insert("TMPDIR".into(), tmpdir.into());
            }
            context.resume_spec = Some(saved.clone());
            context.recovery_state = RecoveryState::Blocked;
            context.opencode_adoption_baseline = None;
            let terminal = context.terminal.as_mut().unwrap();
            terminal.opencode_transfer = None;
            terminal.opencode_transfer_attempt_id = None;
            context.evidence_revision += 1;

            let retry = exact_resume_candidate(&context, None).unwrap().unwrap();
            let launch = freshell_agent_runtime::prepare_terminal_for_resume(
                context.terminal.as_ref().unwrap(),
                &retry,
            )
            .unwrap();
            assert_native_temp_directory(&node, &launch);
            assert_eq!(retry.opencode_adoption_baseline, Some(baseline));
            assert_eq!(retry.provider_session, resume.provider_session);
            assert_eq!(retry.evidence_revision, context.evidence_revision);
            assert_eq!(context.resume_spec, Some(saved));
        }
    }

    #[cfg(unix)]
    fn assert_native_temp_directory(node: &std::path::Path, launch: &TerminalLaunchSpec) {
        // Run the child process's native temporary-directory resolver with the
        // actual resume adapter environment, without ambient host fallbacks.
        let child = std::process::Command::new(node)
            .args(["-e", "process.stdout.write(require('node:os').tmpdir())"])
            .env_clear()
            .envs(&launch.env)
            .output()
            .expect("run the native temporary-directory resolver");
        assert!(child.status.success());
        let selected = String::from_utf8(child.stdout).unwrap();
        println!("OpenCode native temporary directory: {selected}");
        assert_eq!(
            selected, "/run/opencode-tmp",
            "OpenCode must load its native render library from the dedicated executable tmpfs"
        );
    }

    #[test]
    fn completed_import_without_its_verified_transfer_descriptor_stays_blocked() {
        let mut context = completed_import_context();
        context.terminal.as_mut().unwrap().opencode_transfer = None;

        assert!(matches!(
            crate::recovery::offline_probe(&context).unwrap(),
            RecoveryProbe::Blocked {
                reason: RecoveryBlockReason::StoreUnreadable,
                ..
            }
        ));
    }

    #[test]
    fn every_terminal_resume_adapter_uses_the_checked_in_provider_pin() {
        assert_eq!(
            pinned_provider_version("claude").as_deref(),
            Some("2.1.263")
        );
        assert_eq!(pinned_provider_version("codex").as_deref(), Some("0.147.0"));
        assert_eq!(
            pinned_provider_version("opencode").as_deref(),
            Some("1.18.21")
        );
        assert_eq!(
            pinned_provider_version("amplifier").as_deref(),
            Some("0.1.1")
        );
        assert_eq!(pinned_provider_version("not-a-provider"), None);
    }
}

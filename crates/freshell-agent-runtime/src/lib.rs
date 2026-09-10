//! Provider-independent recovery policy plus provider-specific resume adapters.
//!
//! This crate is intentionally unable to spawn or kill a process.  It turns
//! durable identity/evidence into an exact launch specification and classifies
//! soul-local provider stores.  The supervisor retains lifecycle authority and
//! the session host is the only component allowed to execute provider code.

use freshell_runtime_protocol::{
    AllocationState, DurablePosition, EvidenceStoreState, IdentityProvenance, ProviderSessionRef,
    RecoveryBlockReason, RecoveryPath, ResumeSpec, RetryHint, RuntimeError, RuntimeErrorCode,
    TerminalLaunchSpec, RESUME_SPEC_SCHEMA_VERSION,
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    path::Path,
};

mod provider_inventory;
pub use provider_inventory::pinned_provider_version;
mod qualification_policy;
pub use qualification_policy::{
    process_qualification_policy, qualification_managed_provider_enabled,
    qualification_policy_from_value, QualificationPolicy, QUALIFICATION_PROVIDER_ENV,
};
pub mod host_actor;
pub mod snapshot_projection;

#[cfg(test)]
#[path = "snapshot_projection_tests.rs"]
mod snapshot_projection_tests;

pub const PROVIDER_HOME: &str = "/home/freshell/provider";
pub const MAX_SUCCESSFUL_RECOVERIES_PER_HOUR: u64 = 5;
pub const RECOVERY_WINDOW_MS: i64 = 60 * 60 * 1_000;
pub const AUTOMATIC_RETRY_DELAYS_MS: [u64; 2] = [2_000, 10_000];

/// Whether a provider's durable-soul behavior has actually been proven by a
/// live, candidate-bound certification campaign.
///
/// This is deliberately a separate axis from `managed_enabled`: deterministic
/// implementation support can exist and be unit-tested long before a real
/// provider turn has ever been observed. Only `Certified` authorizes a
/// production durable-soul promise; the landing gate may defer the rest, and
/// the production gate stays blocked while any remain deferred.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CertificationState {
    /// A live provider campaign produced a candidate-bound PASS receipt.
    Certified,
    /// The adapter exists and is deterministically tested, but no live receipt
    /// exists yet. The provider must not be advertised as production-ready.
    PendingLiveProviderCertification,
    /// The provider makes no managed durable-soul claim at all.
    NotApplicable,
}

impl CertificationState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Certified => "certified",
            Self::PendingLiveProviderCertification => "pending_live_provider_certification",
            Self::NotApplicable => "not_applicable",
        }
    }
}

/// The typed reason a provider is withheld from the production release scope.
pub const PENDING_LIVE_PROVIDER_CERTIFICATION_REASON: &str = "pending_live_provider_certification";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCapability {
    pub provider: &'static str,
    /// Certification is the outer bound on every other release promise below.
    pub certification_state: CertificationState,
    pub managed_enabled: bool,
    /// True only when Phase 3 can prove exact durable conversation recovery.
    /// A managed shell remains useful but is intentionally not counted as an
    /// AI-provider durability claim after its live process exits.
    pub durable_recovery_enabled: bool,
    /// Complete recovery-path inventory consumed by the Phase 5 loss
    /// certificate. An absent path is explicitly inapplicable.
    pub recovery_paths: &'static [RecoveryPath],
    pub managed_modes: &'static [&'static str],
    pub execution_boundary: &'static str,
    pub identity_capture: &'static str,
    pub state_store: &'static str,
    pub resume_command: Option<&'static str>,
    pub zero_turn_policy: &'static str,
    pub checkpoint_policy: &'static str,
    pub bootstrap: &'static str,
    pub live_gate: &'static str,
    pub blocked_reason: Option<&'static str>,
}

/// The runtime-side provider inventory.  The checked-in JSON capability
/// manifest expands this with UI/API ingress coverage; both are compared by
/// tests so an enabled provider cannot silently lack an adapter.
pub const PROVIDER_CAPABILITIES: &[ProviderCapability] = &[
    ProviderCapability {
        provider: "shell",
        certification_state: CertificationState::Certified,
        managed_enabled: true,
        durable_recovery_enabled: false,
        recovery_paths: &[RecoveryPath::Reattach, RecoveryPath::PristineSeed],
        managed_modes: &["shell"],
        execution_boundary: "session-host-pty",
        identity_capture: "none-live-process-only",
        state_store: "soul-volume-plus-terminal-spool",
        resume_command: None,
        zero_turn_policy: "pristine-seed-only-with-never-dispatched-proof",
        checkpoint_policy: "none",
        bootstrap: "none",
        live_gate: "deterministic-shell",
        blocked_reason: None,
    },
    ProviderCapability {
        provider: "claude",
        certification_state: CertificationState::PendingLiveProviderCertification,
        managed_enabled: false,
        durable_recovery_enabled: false,
        recovery_paths: &[
            RecoveryPath::Reattach,
            RecoveryPath::NativeResume,
            RecoveryPath::CheckpointRestore,
            RecoveryPath::PristineSeed,
        ],
        managed_modes: &["claude"],
        execution_boundary: "session-host-pty",
        identity_capture: "preallocated-session-id-plus-transcript-probe",
        state_store: "$CLAUDE_CONFIG_DIR/projects/**/*.jsonl",
        resume_command: Some("claude --resume <exact-session-id>"),
        zero_turn_policy: "preallocated-id-is-not-durable-before-transcript",
        checkpoint_policy: "provider-transcript-only",
        bootstrap: ".claude/.credentials.json copied before privilege drop",
        live_gate: "haiku-lowest-reasoning",
        blocked_reason: Some("PENDING_LIVE_QUALIFICATION"),
    },
    ProviderCapability {
        provider: "opencode",
        certification_state: CertificationState::Certified,
        managed_enabled: true,
        durable_recovery_enabled: true,
        recovery_paths: &[
            RecoveryPath::Reattach,
            RecoveryPath::NativeResume,
            RecoveryPath::CheckpointRestore,
            RecoveryPath::PristineSeed,
        ],
        managed_modes: &["opencode"],
        execution_boundary: "session-host-pty",
        identity_capture: "soul-local-sqlite-exact-row",
        state_store: "$XDG_DATA_HOME/opencode/opencode.db",
        resume_command: Some("opencode --session <exact-ses-id>"),
        zero_turn_policy: "session-row-must-materialize",
        checkpoint_policy: "provider-sqlite-only-no-live-copy",
        bootstrap: ".local/share/opencode/auth.json copied before privilege drop",
        live_gate: "opencode-1.18.21-big-pickle-free-tier",
        blocked_reason: None,
    },
    ProviderCapability {
        provider: "codex",
        certification_state: CertificationState::PendingLiveProviderCertification,
        managed_enabled: false,
        durable_recovery_enabled: false,
        recovery_paths: &[
            RecoveryPath::Reattach,
            RecoveryPath::NativeResume,
            RecoveryPath::CheckpointRestore,
            RecoveryPath::PristineSeed,
        ],
        managed_modes: &["codex"],
        execution_boundary: "session-host-pty-plus-app-server-proxy",
        identity_capture: "host-proxy-exact-thread-event-plus-rollout-probe",
        state_store: "$CODEX_HOME/sessions/**/*.jsonl",
        resume_command: Some("codex resume <exact-thread-id>"),
        zero_turn_policy: "no-durable-thread-until-provider-materializes",
        checkpoint_policy: "provider-rollout-only",
        bootstrap: ".codex/auth.json copied before privilege drop",
        live_gate: "gpt-5.6-luna-lowest-reasoning",
        blocked_reason: Some("PENDING_LIVE_QUALIFICATION"),
    },
    ProviderCapability {
        provider: "amplifier",
        certification_state: CertificationState::PendingLiveProviderCertification,
        managed_enabled: false,
        durable_recovery_enabled: false,
        recovery_paths: &[
            RecoveryPath::Reattach,
            RecoveryPath::NativeResume,
            RecoveryPath::CheckpointRestore,
            RecoveryPath::PristineSeed,
        ],
        managed_modes: &["amplifier"],
        execution_boundary: "session-host-pty",
        identity_capture: "launcher-stub-plus-exact-materialized-session-directory",
        state_store: "$HOME/.amplifier/projects/**/sessions/<id>",
        resume_command: Some("amplifier session resume --full-history <exact-id>"),
        zero_turn_policy: "stub-is-not-durable-conversation-proof",
        checkpoint_policy: "provider-session-directory",
        bootstrap: "approved private keys.env reference resolved into child-only env plus image-pinned OneCLI Haiku/low profile; raw OAuth forbidden",
        live_gate: "provider-approved-lowest-cost-model",
        blocked_reason: Some("PENDING_LIVE_QUALIFICATION"),
    },
    ProviderCapability {
        provider: "gemini",
        certification_state: CertificationState::NotApplicable,
        managed_enabled: false,
        durable_recovery_enabled: false,
        recovery_paths: &[],
        managed_modes: &["gemini"],
        execution_boundary: "legacy-extension",
        identity_capture: "none",
        state_store: "unimplemented",
        resume_command: None,
        zero_turn_policy: "no-continuity-claim",
        checkpoint_policy: "none",
        bootstrap: "extension-owned",
        live_gate: "not-enabled",
        blocked_reason: Some("BLOCKED_RECOVERY_IMPLEMENTATION"),
    },
    ProviderCapability {
        provider: "kimi",
        certification_state: CertificationState::NotApplicable,
        managed_enabled: false,
        durable_recovery_enabled: false,
        recovery_paths: &[],
        managed_modes: &["kimi"],
        execution_boundary: "legacy-extension",
        identity_capture: "none",
        state_store: "unimplemented",
        resume_command: None,
        zero_turn_policy: "no-continuity-claim",
        checkpoint_policy: "none",
        bootstrap: "extension-owned",
        live_gate: "not-enabled",
        blocked_reason: Some("BLOCKED_RECOVERY_IMPLEMENTATION"),
    },
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum ProviderStoreProbe {
    Ready {
        evidence: Vec<String>,
    },
    DefinitivelyUnavailable {
        reason: String,
        evidence: Vec<String>,
        store_state: EvidenceStoreState,
    },
    Blocked {
        reason: RecoveryBlockReason,
        retry_hint: RetryHint,
        evidence: Vec<String>,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error("managed recovery adapter is unavailable for provider {0}")]
    UnsupportedProvider(String),
    #[error("resume identity does not match the provider launch: {0}")]
    IdentityMismatch(String),
    #[error("invalid managed recovery launch: {0}")]
    InvalidLaunch(String),
}

impl AdapterError {
    pub fn runtime_error(&self) -> RuntimeError {
        let code = match self {
            Self::UnsupportedProvider(_) => RuntimeErrorCode::RecoveryImplementationUnavailable,
            Self::IdentityMismatch(_) => RuntimeErrorCode::RecoveryWrongIdentity,
            Self::InvalidLaunch(_) => RuntimeErrorCode::InvalidRequest,
        };
        RuntimeError::new(code, self.to_string())
    }
}

pub fn capability(provider: &str) -> Option<&'static ProviderCapability> {
    PROVIDER_CAPABILITIES
        .iter()
        .find(|candidate| candidate.provider == provider)
}

/// Complete recovery-path inventory for production providers and the
/// deterministic native-session fixture used by destructive gates. Fixtures
/// are deliberately not included in the checked-in production provider
/// matrix, but their loss proof remains just as explicit.
pub fn recovery_paths(provider: &str) -> Option<&'static [RecoveryPath]> {
    match provider {
        "phase1-fixture" | "native-session-fixture" => Some(&[
            RecoveryPath::Reattach,
            RecoveryPath::NativeResume,
            RecoveryPath::CheckpointRestore,
            RecoveryPath::PristineSeed,
        ]),
        other => capability(other).map(|capability| capability.recovery_paths),
    }
}

pub fn managed_recovery_enabled(provider: &str) -> bool {
    matches!(provider, "phase1-fixture" | "native-session-fixture")
        || capability(provider).is_some_and(|capability| capability.managed_enabled)
}

pub fn managed_provider_enabled(provider: &str) -> bool {
    capability(provider).is_some_and(|candidate| candidate.managed_enabled)
        || qualification_managed_provider_enabled(provider)
}

/// True only when the provider may make a production durable-soul promise:
/// live-certified, managed-enabled, and durable-recovery-enabled together.
///
/// Every managed-durability claim in the runtime, API, and gates derives from
/// this single predicate so a deferred provider cannot be promoted by editing
/// one flag in isolation.
pub fn durable_souls_certified(provider: &str) -> bool {
    capability(provider).is_some_and(|candidate| {
        candidate.certification_state == CertificationState::Certified
            && candidate.managed_enabled
            && candidate.durable_recovery_enabled
    })
}

/// Providers whose live certification campaign has not yet run. They stay on
/// the legacy path and are the only cases the landing gate may defer.
pub fn providers_pending_live_certification() -> Vec<&'static str> {
    PROVIDER_CAPABILITIES
        .iter()
        .filter(|capability| {
            capability.certification_state == CertificationState::PendingLiveProviderCertification
        })
        .map(|capability| capability.provider)
        .collect()
}

#[derive(Debug)]
pub struct ResumeSpecInput<'a> {
    pub provider: &'a str,
    pub provider_store_id: &'a str,
    pub native_session_id: &'a str,
    pub terminal: &'a TerminalLaunchSpec,
    pub provider_version: Option<String>,
    pub creation_seed_ref: String,
    pub checkpoint_revision: u64,
    pub evidence_revision: u64,
    pub never_dispatched: bool,
}

pub fn build_resume_spec(input: ResumeSpecInput<'_>) -> Result<ResumeSpec, AdapterError> {
    let ResumeSpecInput {
        provider,
        provider_store_id,
        native_session_id,
        terminal,
        provider_version,
        creation_seed_ref,
        checkpoint_revision,
        evidence_revision,
        never_dispatched,
    } = input;
    if provider != terminal.mode {
        return Err(AdapterError::IdentityMismatch(format!(
            "provider {provider} != terminal mode {}",
            terminal.mode
        )));
    }
    if native_session_id.trim().is_empty() {
        return Err(AdapterError::InvalidLaunch(
            "native session id is empty".into(),
        ));
    }
    let provider_home = terminal
        .env
        .get("HOME")
        .cloned()
        .ok_or_else(|| AdapterError::InvalidLaunch("provider HOME is absent".into()))?;
    if provider_home != PROVIDER_HOME {
        return Err(AdapterError::InvalidLaunch(format!(
            "provider HOME must be {PROVIDER_HOME}, got {provider_home}"
        )));
    }
    let resume_argv = exact_resume_args(provider, &terminal.args, native_session_id)?;
    Ok(ResumeSpec {
        schema_version: RESUME_SPEC_SCHEMA_VERSION,
        provider_session: ProviderSessionRef {
            provider: provider.to_string(),
            provider_store_id: provider_store_id.to_string(),
            native_session_id: native_session_id.to_string(),
        },
        mode: terminal.mode.clone(),
        runtime_variant: terminal.mode.clone(),
        fixture_transport: None,
        program: terminal.program.clone(),
        resume_argv,
        provider_home,
        provider_volume: None,
        cwd: terminal.cwd.clone(),
        workspace_path: terminal.workspace_path.clone(),
        project_key: Some(terminal.project_key.clone()),
        runtime_profile: None,
        environment: terminal.env.clone(),
        model: terminal
            .provider_model
            .clone()
            .or_else(|| option_value(&terminal.args, &["--model", "-m"])),
        reasoning_effort: terminal.provider_reasoning_effort.clone(),
        permission_mode: terminal.provider_permission_mode.clone().or_else(|| {
            option_value(
                &terminal.args,
                &["--permission-mode", "--approval-mode", "--approval-policy"],
            )
        }),
        image_ref: None,
        provider_version,
        credential_references: Vec::new(),
        identity_provenance: IdentityProvenance::ProviderObserved,
        durable_position: DurablePosition {
            provider_cursor: Some(format!("evidence:{evidence_revision}")),
            ..DurablePosition::default()
        },
        checkpoint_references: Vec::new(),
        creation_seed_ref,
        checkpoint_revision,
        allocation_state: AllocationState::VerifiedDurable,
        evidence_revision,
        never_dispatched,
    })
}

/// Construct the replacement launch exclusively from the durable resume spec.
/// No `--continue`, latest-session lookup, or fresh-session substitution is
/// available on this path.
pub fn prepare_terminal_for_resume(
    original: &TerminalLaunchSpec,
    resume: &ResumeSpec,
) -> Result<TerminalLaunchSpec, AdapterError> {
    if original.mode != resume.mode
        || resume.provider_session.provider != resume.mode
        || original.program != resume.program
    {
        return Err(AdapterError::IdentityMismatch(
            "durable resume provider/program does not match the soul launch".into(),
        ));
    }
    if resume.allocation_state != AllocationState::VerifiedDurable {
        return Err(AdapterError::InvalidLaunch(
            "automatic native resume requires VERIFIED_DURABLE evidence".into(),
        ));
    }
    let expected = &resume.provider_session.native_session_id;
    if expected.is_empty() {
        return Err(AdapterError::InvalidLaunch(
            "automatic resume has no native session identity".into(),
        ));
    }
    let mut replacement = original.clone();
    replacement.program = resume.program.clone();
    replacement.args = exact_resume_args(&resume.mode, &resume.resume_argv, expected)?;
    replacement.env = resume.environment.clone();
    replacement.cwd = resume.cwd.clone();
    replacement.workspace_path = resume.workspace_path.clone();
    replacement.resume_session_id = Some(expected.clone());
    replacement.provider_model = resume.model.clone();
    replacement.provider_reasoning_effort = resume.reasoning_effort.clone();
    replacement.provider_permission_mode = resume.permission_mode.clone();
    replacement
        .validate()
        .map_err(|error| AdapterError::InvalidLaunch(error.message))?;
    Ok(replacement)
}

pub fn verify_native_identity(expected: &str, observed: Option<&str>) -> Result<(), AdapterError> {
    match observed {
        Some(actual) if actual == expected => Ok(()),
        Some(actual) => Err(AdapterError::IdentityMismatch(format!(
            "expected native session {expected}, provider returned {actual}"
        ))),
        None => Err(AdapterError::IdentityMismatch(format!(
            "expected native session {expected}, provider returned no identity"
        ))),
    }
}

pub fn exact_resume_args(
    provider: &str,
    original: &[String],
    native_session_id: &str,
) -> Result<Vec<String>, AdapterError> {
    if native_session_id.trim().is_empty() {
        return Err(AdapterError::InvalidLaunch(
            "native session id is empty".into(),
        ));
    }
    match provider {
        "claude" => {
            let mut args = strip_value_flags(original, &["--session-id", "--resume", "-r"]);
            args.retain(|value| value != "--continue" && value != native_session_id);
            args.push("--resume".into());
            args.push(native_session_id.into());
            Ok(args)
        }
        "opencode" => {
            let mut args = strip_value_flags(original, &["--session", "-s"]);
            args.retain(|value| value != "--continue" && value != native_session_id);
            args.push("--session".into());
            args.push(native_session_id.into());
            Ok(args)
        }
        "codex" => {
            let mut args = original.to_vec();
            if let Some(index) = args.iter().position(|value| value == "resume") {
                args.remove(index);
                if index < args.len() && !args[index].starts_with('-') {
                    args.remove(index);
                }
            }
            args.retain(|value| value != "--continue" && value != native_session_id);
            args.insert(0, native_session_id.into());
            args.insert(0, "resume".into());
            Ok(args)
        }
        "amplifier" => {
            let mut args = original.to_vec();
            if let Some(index) = args
                .windows(2)
                .position(|pair| pair[0] == "session" && pair[1] == "resume")
            {
                args.truncate(index);
            }
            args.retain(|value| value != "--continue" && value != native_session_id);
            args.extend([
                "session".into(),
                "resume".into(),
                "--full-history".into(),
                native_session_id.into(),
            ]);
            Ok(args)
        }
        other => Err(AdapterError::UnsupportedProvider(other.to_string())),
    }
}

fn option_value(args: &[String], flags: &[&str]) -> Option<String> {
    let mut index = 0;
    while index < args.len() {
        for flag in flags {
            if args[index] == *flag {
                return args.get(index + 1).cloned();
            }
            if let Some(value) = args[index].strip_prefix(&format!("{flag}=")) {
                if !value.is_empty() {
                    return Some(value.to_string());
                }
            }
        }
        index += 1;
    }
    None
}

fn strip_value_flags(args: &[String], flags: &[&str]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut index = 0;
    while index < args.len() {
        if flags.contains(&args[index].as_str()) {
            index += 1;
            if index < args.len() {
                index += 1;
            }
            continue;
        }
        if flags
            .iter()
            .any(|flag| args[index].starts_with(&format!("{flag}=")))
        {
            index += 1;
            continue;
        }
        out.push(args[index].clone());
        index += 1;
    }
    out
}

pub fn probe_provider_store(provider_home: &Path, spec: &ResumeSpec) -> ProviderStoreProbe {
    if !provider_home.is_dir() {
        return blocked(
            RecoveryBlockReason::StoreMissing,
            "soul provider-state mount is unavailable",
            vec![provider_home.display().to_string()],
            Some("restore the soul provider-state volume"),
        );
    }
    let expected = spec.provider_session.native_session_id.as_str();
    match spec.provider_session.provider.as_str() {
        "phase1-fixture" | "native-session-fixture" => {
            probe_native_fixture(provider_home, expected)
        }
        "claude" => probe_bounded_tree(
            &provider_home.join(".claude/projects"),
            expected,
            ArtifactMatch::FileNameOrJsonText,
        ),
        "codex" => probe_bounded_tree(
            &provider_home.join(".codex/sessions"),
            expected,
            ArtifactMatch::FileNameOrJsonText,
        ),
        "amplifier" => probe_amplifier(provider_home, expected),
        "opencode" => probe_opencode(provider_home, expected),
        other => blocked(
            RecoveryBlockReason::ImplementationUnavailable,
            &format!("no managed recovery probe for provider {other}"),
            vec![format!("provider={other}")],
            None,
        ),
    }
}

fn probe_native_fixture(provider_home: &Path, expected: &str) -> ProviderStoreProbe {
    let path = provider_home.join("native-session-state.json");
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return probe_native_fixture_checkpoint(provider_home, expected, &path)
        }
        Err(error) => {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                &format!("read native fixture state: {error}"),
                vec![path.display().to_string()],
                Some("repair provider-state volume permissions"),
            )
        }
    };
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                &format!("parse native fixture state: {error}"),
                vec![path.display().to_string()],
                Some("restore a valid provider-compatible checkpoint"),
            )
        }
    };
    let actual = value.get("sessionId").and_then(serde_json::Value::as_str);
    let checkpoint_revision = value
        .get("checkpointRevision")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    match actual {
        Some(actual) if actual == expected => ProviderStoreProbe::Ready {
            evidence: vec![
                path.display().to_string(),
                format!("sessionId={actual}"),
                format!("checkpointRevision={checkpoint_revision}"),
            ],
        },
        Some(actual) => blocked(
            RecoveryBlockReason::WrongNativeIdentity,
            &format!("fixture state belongs to {actual}, expected {expected}"),
            vec![path.display().to_string()],
            None,
        ),
        None => blocked(
            RecoveryBlockReason::StoreUnreadable,
            "fixture state has no native identity",
            vec![path.display().to_string()],
            None,
        ),
    }
}

fn probe_native_fixture_checkpoint(
    provider_home: &Path,
    expected: &str,
    primary_path: &Path,
) -> ProviderStoreProbe {
    let directory = provider_home.join(".freshell/checkpoints/native-session");
    if !directory.exists() {
        return ProviderStoreProbe::DefinitivelyUnavailable {
            reason: "native fixture state and checkpoints are absent".into(),
            evidence: vec![
                primary_path.display().to_string(),
                directory.display().to_string(),
            ],
            store_state: EvidenceStoreState::Missing,
        };
    }
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) => {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                &format!("read native fixture checkpoint directory: {error}"),
                vec![directory.display().to_string()],
                Some("repair provider-state checkpoint permissions"),
            )
        }
    };
    let mut candidates = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                return blocked(
                    RecoveryBlockReason::StoreUnreadable,
                    &format!("read native fixture checkpoint entry: {error}"),
                    vec![directory.display().to_string()],
                    None,
                )
            }
        };
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                return blocked(
                    RecoveryBlockReason::StoreUnreadable,
                    &format!("inspect native fixture checkpoint: {error}"),
                    vec![path.display().to_string()],
                    None,
                )
            }
        };
        if metadata.file_type().is_symlink() {
            return blocked(
                RecoveryBlockReason::AmbiguousIdentity,
                "native fixture checkpoint path is a symlink",
                vec![path.display().to_string()],
                Some("replace checkpoint symlinks with private regular files"),
            );
        }
        if !metadata.is_file() || metadata.len() > 1024 * 1024 {
            continue;
        }
        let revision = path
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(|value| value.parse::<u64>().ok());
        if let Some(revision) = revision {
            candidates.push((revision, path));
        }
    }
    candidates.sort_by_key(|(revision, _)| *revision);
    let Some((revision, path)) = candidates.pop() else {
        return ProviderStoreProbe::DefinitivelyUnavailable {
            reason: "native fixture state is absent and no numeric checkpoint exists".into(),
            evidence: vec![
                primary_path.display().to_string(),
                directory.display().to_string(),
            ],
            store_state: EvidenceStoreState::Missing,
        };
    };
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                &format!("read native fixture checkpoint: {error}"),
                vec![path.display().to_string()],
                Some("repair provider-state checkpoint permissions"),
            )
        }
    };
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(error) => {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                &format!("parse native fixture checkpoint: {error}"),
                vec![path.display().to_string()],
                Some("restore a valid checkpoint"),
            )
        }
    };
    let actual = value.get("sessionId").and_then(serde_json::Value::as_str);
    let stored_revision = value
        .get("checkpointRevision")
        .and_then(serde_json::Value::as_u64);
    match (actual, stored_revision) {
        (Some(actual), Some(stored)) if actual == expected && stored == revision => {
            ProviderStoreProbe::Ready {
                evidence: vec![
                    path.display().to_string(),
                    format!("sessionId={actual}"),
                    format!("checkpointRevision={revision}"),
                    "checkpointPrimaryMissing=true".into(),
                ],
            }
        }
        (Some(actual), _) if actual != expected => blocked(
            RecoveryBlockReason::WrongNativeIdentity,
            &format!("fixture checkpoint belongs to {actual}, expected {expected}"),
            vec![path.display().to_string()],
            None,
        ),
        _ => blocked(
            RecoveryBlockReason::StoreUnreadable,
            "fixture checkpoint has no exact matching identity/revision",
            vec![path.display().to_string()],
            Some("restore a valid checkpoint"),
        ),
    }
}

fn probe_opencode(provider_home: &Path, expected: &str) -> ProviderStoreProbe {
    let path = provider_home.join(".local/share/opencode/opencode.db");
    if !path.exists() {
        return ProviderStoreProbe::DefinitivelyUnavailable {
            reason: "OpenCode session database is absent".into(),
            evidence: vec![path.display().to_string()],
            store_state: EvidenceStoreState::Missing,
        };
    }
    let connection = match Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(error) => {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                &format!("open OpenCode session database: {error}"),
                vec![path.display().to_string()],
                Some("repair the soul-local OpenCode database"),
            )
        }
    };
    let present = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM session WHERE id = ?1)",
            [expected],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value == 1);
    match present {
        Ok(true) => ProviderStoreProbe::Ready {
            evidence: vec![path.display().to_string(), format!("session.id={expected}")],
        },
        Ok(false) => ProviderStoreProbe::DefinitivelyUnavailable {
            reason: format!("OpenCode database has no exact session row {expected}"),
            evidence: vec![path.display().to_string()],
            store_state: EvidenceStoreState::PresentReadable,
        },
        Err(error) => blocked(
            RecoveryBlockReason::UnsupportedProtocol,
            &format!("query OpenCode session database: {error}"),
            vec![path.display().to_string()],
            Some("install the pinned compatible OpenCode runtime"),
        ),
    }
}

fn probe_amplifier(provider_home: &Path, expected: &str) -> ProviderStoreProbe {
    let root = provider_home.join(".amplifier/projects");
    if !root.exists() {
        return ProviderStoreProbe::DefinitivelyUnavailable {
            reason: "Amplifier project store is absent".into(),
            evidence: vec![root.display().to_string()],
            store_state: EvidenceStoreState::Missing,
        };
    }
    let mut queue = VecDeque::from([(root.clone(), 0_u8)]);
    let mut matches = Vec::new();
    let mut visited = 0_usize;
    while let Some((path, depth)) = queue.pop_front() {
        visited += 1;
        if visited > 50_000 {
            return blocked(
                RecoveryBlockReason::AmbiguousIdentity,
                "Amplifier store exceeded the bounded exact-identity probe",
                vec![root.display().to_string()],
                None,
            );
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                return blocked(
                    RecoveryBlockReason::StoreUnreadable,
                    &format!("inspect Amplifier artifact {}: {error}", path.display()),
                    vec![root.display().to_string()],
                    Some("repair provider-state volume permissions"),
                )
            }
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        if path.file_name().is_some_and(|name| name == expected) {
            matches.push(path.clone());
            continue;
        }
        if depth >= 8 {
            continue;
        }
        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(error) => {
                return blocked(
                    RecoveryBlockReason::StoreUnreadable,
                    &format!("read Amplifier directory {}: {error}", path.display()),
                    vec![root.display().to_string()],
                    Some("repair provider-state volume permissions"),
                )
            }
        };
        for entry in entries {
            match entry {
                Ok(entry) => queue.push_back((entry.path(), depth + 1)),
                Err(error) => {
                    return blocked(
                        RecoveryBlockReason::StoreUnreadable,
                        &format!("read Amplifier directory entry: {error}"),
                        vec![root.display().to_string()],
                        Some("repair provider-state volume permissions"),
                    )
                }
            }
        }
    }
    match matches.as_slice() {
        [] => ProviderStoreProbe::DefinitivelyUnavailable {
            reason: format!("Amplifier store has no exact session {expected}"),
            evidence: vec![root.display().to_string()],
            store_state: EvidenceStoreState::PresentReadable,
        },
        [session_dir] if freshell_sessions::amplifier_stub::stub_is_unused(session_dir) => {
            ProviderStoreProbe::DefinitivelyUnavailable {
                reason: format!(
                    "Amplifier session {expected} is a pristine launcher stub, not a durable conversation"
                ),
                evidence: vec![session_dir.display().to_string(), "turnCount=0".into()],
                store_state: EvidenceStoreState::PresentReadable,
            }
        }
        [session_dir] => ProviderStoreProbe::Ready {
            evidence: vec![session_dir.display().to_string(), format!("sessionId={expected}")],
        },
        many => blocked(
            RecoveryBlockReason::AmbiguousIdentity,
            &format!(
                "Amplifier exact session identity {expected} exists in {} project stores",
                many.len()
            ),
            many.iter().map(|path| path.display().to_string()).collect(),
            None,
        ),
    }
}

#[derive(Debug, Clone, Copy)]
enum ArtifactMatch {
    FileNameOrJsonText,
}

fn probe_bounded_tree(root: &Path, expected: &str, mode: ArtifactMatch) -> ProviderStoreProbe {
    if !root.exists() {
        return ProviderStoreProbe::DefinitivelyUnavailable {
            reason: "provider session root is absent".into(),
            evidence: vec![root.display().to_string()],
            store_state: EvidenceStoreState::Missing,
        };
    }
    let mut queue = VecDeque::from([(root.to_path_buf(), 0_u8)]);
    let mut visited = 0_usize;
    while let Some((path, depth)) = queue.pop_front() {
        visited += 1;
        if visited > 50_000 {
            return blocked(
                RecoveryBlockReason::AmbiguousIdentity,
                "provider store exceeded the bounded exact-identity probe",
                vec![root.display().to_string()],
                None,
            );
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                return blocked(
                    RecoveryBlockReason::StoreUnreadable,
                    &format!("inspect provider artifact {}: {error}", path.display()),
                    vec![root.display().to_string()],
                    Some("repair provider-state volume permissions"),
                )
            }
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if depth >= 8 {
                continue;
            }
            let entries = match fs::read_dir(&path) {
                Ok(entries) => entries,
                Err(error) => {
                    return blocked(
                        RecoveryBlockReason::StoreUnreadable,
                        &format!("read provider directory {}: {error}", path.display()),
                        vec![root.display().to_string()],
                        Some("repair provider-state volume permissions"),
                    )
                }
            };
            for entry in entries {
                match entry {
                    Ok(entry) => queue.push_back((entry.path(), depth + 1)),
                    Err(error) => {
                        return blocked(
                            RecoveryBlockReason::StoreUnreadable,
                            &format!("read provider directory entry: {error}"),
                            vec![root.display().to_string()],
                            Some("repair provider-state volume permissions"),
                        )
                    }
                }
            }
            continue;
        }
        if matches!(mode, ArtifactMatch::FileNameOrJsonText) {
            let filename_match = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(expected));
            let content_match = if filename_match || metadata.len() > 1024 * 1024 {
                false
            } else {
                fs::read(&path).ok().is_some_and(|bytes| {
                    bytes
                        .windows(expected.len())
                        .any(|w| w == expected.as_bytes())
                })
            };
            if filename_match || content_match {
                return ProviderStoreProbe::Ready {
                    evidence: vec![path.display().to_string()],
                };
            }
        }
    }
    ProviderStoreProbe::DefinitivelyUnavailable {
        reason: format!("no exact provider artifact for {expected}"),
        evidence: vec![root.display().to_string()],
        store_state: EvidenceStoreState::PresentReadable,
    }
}

fn blocked(
    reason: RecoveryBlockReason,
    message: &str,
    evidence: Vec<String>,
    repair: Option<&str>,
) -> ProviderStoreProbe {
    ProviderStoreProbe::Blocked {
        reason,
        retry_hint: RetryHint {
            automatic_after_ms: None,
            manual_retry: true,
            repair: repair
                .map(str::to_string)
                .or_else(|| Some(message.to_string())),
        },
        evidence,
    }
}

pub fn retry_hint_for_failure(failure_index: u64) -> RetryHint {
    RetryHint {
        automatic_after_ms: AUTOMATIC_RETRY_DELAYS_MS
            .get(failure_index as usize)
            .copied(),
        manual_retry: true,
        repair: None,
    }
}

pub fn successful_recovery_budget_available(
    window_started_at_ms: Option<i64>,
    successful_recoveries: u64,
    now_ms: i64,
) -> bool {
    match window_started_at_ms {
        None => true,
        Some(started) if now_ms.saturating_sub(started) >= RECOVERY_WINDOW_MS => true,
        Some(_) => successful_recoveries < MAX_SUCCESSFUL_RECOVERIES_PER_HOUR,
    }
}

pub fn classify_provider_failure(message: &str) -> RecoveryBlockReason {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("credential")
        || normalized.contains("unauthorized")
        || normalized.contains("authentication")
        || normalized.contains("401")
    {
        RecoveryBlockReason::CredentialsExpired
    } else if normalized.contains("rate limit") || normalized.contains("429") {
        RecoveryBlockReason::RateLimited
    } else if normalized.contains("retry budget") || normalized.contains("retry exhausted") {
        RecoveryBlockReason::RetryBudget
    } else if normalized.contains("store")
        && (normalized.contains("unreadable")
            || normalized.contains("permission denied")
            || normalized.contains("corrupt"))
    {
        RecoveryBlockReason::StoreUnreadable
    } else if normalized.contains("store")
        && (normalized.contains("missing")
            || normalized.contains("not found")
            || normalized.contains("absent"))
    {
        RecoveryBlockReason::StoreMissing
    } else if normalized.contains("version") || normalized.contains("schema") {
        RecoveryBlockReason::IncompatibleBinary
    } else if normalized.contains("workspace") || normalized.contains("cwd") {
        RecoveryBlockReason::WorkspaceUnavailable
    } else {
        RecoveryBlockReason::ProviderUnavailable
    }
}

pub fn recovery_environment(spec: &ResumeSpec) -> BTreeMap<String, String> {
    spec.environment.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::ProviderBootstrapFile;

    fn terminal(mode: &str, args: &[&str]) -> TerminalLaunchSpec {
        TerminalLaunchSpec {
            terminal_id: "terminal-one".into(),
            stream_id: "stream-one".into(),
            mode: mode.into(),
            program: mode.into(),
            args: args.iter().map(|value| value.to_string()).collect(),
            env: BTreeMap::from([("HOME".into(), PROVIDER_HOME.into())]),
            cwd: "/workspace".into(),
            run_as_uid: 65_534,
            run_as_gid: 0,
            cols: 80,
            rows: 24,
            project_key: "project-one".into(),
            workspace_path: "/workspace".into(),
            git_common_dir: None,
            create_request_id: Some("create-one".into()),
            resume_session_id: None,
            provider_model: None,
            provider_reasoning_effort: None,
            provider_sandbox: None,
            provider_permission_mode: None,
            provider_bootstrap_files: Vec::<ProviderBootstrapFile>::new(),
            provider_secret_references: Vec::new(),
        }
    }

    #[test]
    fn durable_model_and_effort_are_captured_and_restored_without_argv_inference() {
        let mut original = terminal("codex", &["resume", "thread-one"]);
        original.provider_model = Some("gpt-5.6-luna".into());
        original.provider_reasoning_effort = Some("minimal".into());
        let resume = build_resume_spec(ResumeSpecInput {
            provider: "codex",
            provider_store_id: "store-one",
            native_session_id: "thread-one",
            terminal: &original,
            provider_version: Some("1.0.0".into()),
            creation_seed_ref: "seed-one".into(),
            checkpoint_revision: 0,
            evidence_revision: 1,
            never_dispatched: false,
        })
        .unwrap();
        let resume: ResumeSpec =
            serde_json::from_str(&serde_json::to_string(&resume).unwrap()).unwrap();
        assert_eq!(resume.model.as_deref(), Some("gpt-5.6-luna"));
        assert_eq!(resume.reasoning_effort.as_deref(), Some("minimal"));

        let restored = prepare_terminal_for_resume(&original, &resume).unwrap();
        assert_eq!(restored.provider_model.as_deref(), Some("gpt-5.6-luna"));
        assert_eq!(
            restored.provider_reasoning_effort.as_deref(),
            Some("minimal")
        );
    }

    #[test]
    fn exact_adapters_never_emit_fresh_or_latest_fallbacks() {
        let claude = exact_resume_args(
            "claude",
            &[
                "--session-id".into(),
                "allocated".into(),
                "--continue".into(),
            ],
            "claude-real",
        )
        .unwrap();
        assert_eq!(claude, ["--resume", "claude-real"]);

        let opencode = exact_resume_args(
            "opencode",
            &["--session=old".into(), "--continue".into()],
            "ses_real",
        )
        .unwrap();
        assert_eq!(opencode, ["--session", "ses_real"]);

        let codex =
            exact_resume_args("codex", &["--model".into(), "luna".into()], "thread-1").unwrap();
        assert_eq!(codex[0..2], ["resume", "thread-1"]);
        assert!(!codex.iter().any(|arg| arg == "--continue"));

        let amplifier = exact_resume_args("amplifier", &[], "amp-1").unwrap();
        assert_eq!(amplifier, ["session", "resume", "--full-history", "amp-1"]);
    }

    #[test]
    fn durable_resume_spec_drives_replacement_launch() {
        let original = terminal("opencode", &["--model", "opencode/big-pickle"]);
        let spec = build_resume_spec(ResumeSpecInput {
            provider: "opencode",
            provider_store_id: "store-one",
            native_session_id: "ses_exact",
            terminal: &original,
            provider_version: Some("1.18.21".into()),
            creation_seed_ref: "seed-one".into(),
            checkpoint_revision: 0,
            evidence_revision: 7,
            never_dispatched: false,
        })
        .unwrap();
        assert_eq!(spec.schema_version, RESUME_SPEC_SCHEMA_VERSION);
        assert_eq!(spec.runtime_variant, "opencode");
        assert_eq!(spec.model.as_deref(), Some("opencode/big-pickle"));
        assert_eq!(
            spec.identity_provenance,
            IdentityProvenance::ProviderObserved
        );
        let replacement = prepare_terminal_for_resume(&original, &spec).unwrap();
        assert_eq!(replacement.resume_session_id.as_deref(), Some("ses_exact"));
        assert_eq!(
            replacement.args.last().map(String::as_str),
            Some("ses_exact")
        );
        assert_eq!(replacement.terminal_id, original.terminal_id);
        assert_eq!(replacement.cwd, original.cwd);
    }

    #[test]
    fn wrong_or_missing_identity_is_never_success() {
        assert!(verify_native_identity("expected", Some("expected")).is_ok());
        assert!(matches!(
            verify_native_identity("expected", Some("wrong")),
            Err(AdapterError::IdentityMismatch(_))
        ));
        assert!(verify_native_identity("expected", None).is_err());
    }

    #[test]
    fn native_fixture_probe_requires_exact_persisted_identity() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("native-session-state.json"),
            r#"{"sessionId":"fixture-exact","history":["create"]}"#,
        )
        .unwrap();
        let terminal = terminal("opencode", &[]);
        let mut spec = build_resume_spec(ResumeSpecInput {
            provider: "opencode",
            provider_store_id: "store-one",
            native_session_id: "fixture-exact",
            terminal: &terminal,
            provider_version: None,
            creation_seed_ref: "seed".into(),
            checkpoint_revision: 0,
            evidence_revision: 1,
            never_dispatched: false,
        })
        .unwrap();
        spec.provider_session.provider = "native-session-fixture".into();
        assert!(matches!(
            probe_provider_store(dir.path(), &spec),
            ProviderStoreProbe::Ready { .. }
        ));
        spec.provider_session.native_session_id = "wrong".into();
        assert!(matches!(
            probe_provider_store(dir.path(), &spec),
            ProviderStoreProbe::Blocked {
                reason: RecoveryBlockReason::WrongNativeIdentity,
                ..
            }
        ));
    }

    #[test]
    fn native_fixture_probe_uses_exact_verified_checkpoint_when_primary_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let checkpoint = dir
            .path()
            .join(".freshell/checkpoints/native-session/3.json");
        fs::create_dir_all(checkpoint.parent().unwrap()).unwrap();
        fs::write(
            &checkpoint,
            r#"{"sessionId":"fixture-checkpoint","history":["create"],"checkpointRevision":3}"#,
        )
        .unwrap();
        let terminal = terminal("opencode", &[]);
        let mut spec = build_resume_spec(ResumeSpecInput {
            provider: "opencode",
            provider_store_id: "store-one",
            native_session_id: "fixture-checkpoint",
            terminal: &terminal,
            provider_version: None,
            creation_seed_ref: "seed".into(),
            checkpoint_revision: 3,
            evidence_revision: 4,
            never_dispatched: false,
        })
        .unwrap();
        spec.provider_session.provider = "native-session-fixture".into();
        let probe = probe_provider_store(dir.path(), &spec);
        match probe {
            ProviderStoreProbe::Ready { evidence } => {
                assert!(evidence.iter().any(|row| row == "checkpointRevision=3"));
                assert!(evidence
                    .iter()
                    .any(|row| row == "checkpointPrimaryMissing=true"));
            }
            other => panic!("expected checkpoint readiness, got {other:?}"),
        }
        spec.provider_session.native_session_id = "wrong".into();
        assert!(matches!(
            probe_provider_store(dir.path(), &spec),
            ProviderStoreProbe::Blocked {
                reason: RecoveryBlockReason::WrongNativeIdentity,
                ..
            }
        ));
    }

    #[test]
    fn opencode_probe_reads_exact_row_without_guessing_latest() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join(".local/share/opencode/opencode.db");
        fs::create_dir_all(db.parent().unwrap()).unwrap();
        let connection = Connection::open(&db).unwrap();
        connection
            .execute("CREATE TABLE session(id TEXT PRIMARY KEY)", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO session(id) VALUES ('ses_other'), ('ses_exact')",
                [],
            )
            .unwrap();
        drop(connection);
        let terminal = terminal("opencode", &[]);
        let spec = build_resume_spec(ResumeSpecInput {
            provider: "opencode",
            provider_store_id: "store-one",
            native_session_id: "ses_exact",
            terminal: &terminal,
            provider_version: None,
            creation_seed_ref: "seed".into(),
            checkpoint_revision: 0,
            evidence_revision: 1,
            never_dispatched: false,
        })
        .unwrap();
        assert!(matches!(
            probe_provider_store(dir.path(), &spec),
            ProviderStoreProbe::Ready { .. }
        ));
    }

    #[test]
    fn persisted_flap_budget_is_not_a_loss_verdict() {
        assert!(successful_recovery_budget_available(None, 99, 10));
        assert!(successful_recovery_budget_available(Some(0), 4, 1_000));
        assert!(!successful_recovery_budget_available(Some(0), 5, 1_000));
        assert!(successful_recovery_budget_available(
            Some(0),
            5,
            RECOVERY_WINDOW_MS
        ));
        assert_eq!(retry_hint_for_failure(0).automatic_after_ms, Some(2_000));
        assert_eq!(retry_hint_for_failure(1).automatic_after_ms, Some(10_000));
        assert_eq!(retry_hint_for_failure(2).automatic_after_ms, None);
    }

    #[test]
    fn transient_failures_map_to_blocked_reasons() {
        assert_eq!(
            classify_provider_failure("401 unauthorized credentials"),
            RecoveryBlockReason::CredentialsExpired
        );
        assert_eq!(
            classify_provider_failure("429 rate limit exceeded"),
            RecoveryBlockReason::RateLimited
        );
        assert_eq!(
            classify_provider_failure("provider service is unavailable"),
            RecoveryBlockReason::ProviderUnavailable
        );
        assert_eq!(
            classify_provider_failure("provider session schema version changed"),
            RecoveryBlockReason::IncompatibleBinary
        );
        assert_eq!(
            classify_provider_failure("workspace cwd is unavailable"),
            RecoveryBlockReason::WorkspaceUnavailable
        );
    }

    #[test]
    fn release_qualified_opencode_blocker_matrix_is_explicit() {
        let cases = [
            (
                "401 unauthorized credentials",
                RecoveryBlockReason::CredentialsExpired,
            ),
            ("429 rate limit exceeded", RecoveryBlockReason::RateLimited),
            (
                "provider service is unavailable",
                RecoveryBlockReason::ProviderUnavailable,
            ),
            (
                "provider state store is unreadable",
                RecoveryBlockReason::StoreUnreadable,
            ),
            (
                "provider state store is missing",
                RecoveryBlockReason::StoreMissing,
            ),
            (
                "provider session schema version changed",
                RecoveryBlockReason::IncompatibleBinary,
            ),
            ("retry budget exhausted", RecoveryBlockReason::RetryBudget),
        ];
        for (message, expected) in cases {
            assert_eq!(classify_provider_failure(message), expected, "{message}");
        }
        let capability = capability("opencode").unwrap();
        assert!(capability.managed_enabled);
        assert!(capability.durable_recovery_enabled);
        assert_eq!(capability.blocked_reason, None);
    }

    #[test]
    fn checked_in_capability_manifest_matches_runtime_inventory() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/development/runtime-provider-capabilities.json"
        ))
        .unwrap();
        assert_eq!(manifest["schemaVersion"], 1);
        assert_eq!(manifest["managedRuntimeVersion"], 1);
        assert_eq!(manifest["releaseScope"]["freshAgentEnabled"], false);
        assert_eq!(
            manifest["releaseScope"]["managedTerminalProviders"],
            serde_json::json!(["opencode"])
        );
        let providers = manifest["providers"].as_array().unwrap();
        assert_eq!(providers.len(), PROVIDER_CAPABILITIES.len());

        for capability in PROVIDER_CAPABILITIES {
            let matches: Vec<_> = providers
                .iter()
                .filter(|entry| entry["provider"] == capability.provider)
                .collect();
            assert_eq!(
                matches.len(),
                1,
                "provider {} must occur once",
                capability.provider
            );
            let entry = matches[0];
            assert_eq!(entry["managedEnabled"], capability.managed_enabled);
            assert_eq!(
                entry["durableRecoveryEnabled"],
                capability.durable_recovery_enabled
            );
            let recovery_paths: Vec<_> = entry["recoveryPaths"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect();
            let expected_paths: Vec<_> = capability
                .recovery_paths
                .iter()
                .map(|path| match path {
                    RecoveryPath::Reattach => "reattach",
                    RecoveryPath::NativeResume => "native_resume",
                    RecoveryPath::CheckpointRestore => "checkpoint_restore",
                    RecoveryPath::PristineSeed => "pristine_seed",
                    RecoveryPath::NativeImport => "native_import",
                })
                .collect();
            assert_eq!(recovery_paths, expected_paths);
            let modes: Vec<_> = entry["managedModes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect();
            assert_eq!(modes, capability.managed_modes);
            assert_eq!(entry["executionBoundary"], capability.execution_boundary);
            assert_eq!(entry["identityCapture"], capability.identity_capture);
            assert_eq!(entry["stateStore"], capability.state_store);
            assert_eq!(entry["zeroTurnPolicy"], capability.zero_turn_policy);
            assert_eq!(entry["checkpointPolicy"], capability.checkpoint_policy);
            assert_eq!(entry["bootstrap"], capability.bootstrap);
            assert_eq!(entry["liveGate"], capability.live_gate);
            assert_eq!(entry["resumeCommand"].as_str(), capability.resume_command);
            assert_eq!(entry["blockedReason"].as_str(), capability.blocked_reason);
            if capability.durable_recovery_enabled {
                assert!(capability.managed_enabled);
                assert!(capability.resume_command.is_some());
            }
        }

        let durable: Vec<_> = PROVIDER_CAPABILITIES
            .iter()
            .filter(|capability| capability.durable_recovery_enabled)
            .map(|capability| capability.provider)
            .collect();
        assert_eq!(durable, ["opencode"]);
        assert_eq!(
            manifest["releaseScope"]["deferredManagedProviders"],
            serde_json::json!(["claude", "codex", "amplifier"])
        );
        for provider in ["claude", "codex", "amplifier"] {
            let deferred = capability(provider).expect("deferred adapter remains registered");
            assert!(!deferred.managed_enabled);
            assert!(!deferred.durable_recovery_enabled);
            assert_eq!(deferred.blocked_reason, Some("PENDING_LIVE_QUALIFICATION"));
        }

        for doorway in manifest["doorways"].as_array().unwrap() {
            let policy = doorway["policy"].as_str().unwrap();
            assert!(matches!(policy, "managed" | "blocked" | "legacy"));
            for provider in doorway["providers"].as_array().unwrap() {
                let provider = provider.as_str().unwrap();
                let capability = capability(provider)
                    .unwrap_or_else(|| panic!("doorway names unknown provider {provider}"));
                if policy == "managed" {
                    assert!(
                        capability.managed_enabled,
                        "managed doorway cannot route disabled provider {provider}"
                    );
                }
            }
        }

        assert_eq!(
            manifest["invariants"]["retryDelaysMs"],
            serde_json::json!(AUTOMATIC_RETRY_DELAYS_MS)
        );
        assert_eq!(
            manifest["invariants"]["maxSuccessfulRecoveriesPerHour"],
            MAX_SUCCESSFUL_RECOVERIES_PER_HOUR
        );
        assert_eq!(
            manifest["invariants"]["managedRecoveryMaySpawnFresh"],
            false
        );
        assert_eq!(manifest["invariants"]["automaticPromptReplay"], false);
        assert_eq!(
            manifest["invariants"]["lostRequiresAllPathsDefinitivelyUnavailable"],
            true
        );
        assert_eq!(manifest["invariants"]["stopIntentWins"], true);
    }

    #[test]
    fn durable_souls_certification_state_is_typed_and_fail_closed() {
        // A provider may only advertise managed durable-soul ownership when its
        // live certification campaign has actually passed. The certification
        // state is the single typed switch; `managedEnabled` /
        // `durableRecoveryEnabled` are derived promises that must never exceed
        // it. This is what keeps a documentation-only or convenience
        // enablement from silently widening the release scope.
        for capability in PROVIDER_CAPABILITIES {
            match capability.certification_state {
                CertificationState::PendingLiveProviderCertification => {
                    assert!(
                        !capability.managed_enabled,
                        "{} is pending live certification and must not be managed-enabled",
                        capability.provider
                    );
                    assert!(
                        !capability.durable_recovery_enabled,
                        "{} is pending live certification and must not claim durable recovery",
                        capability.provider
                    );
                    assert_eq!(
                        capability.blocked_reason,
                        Some("PENDING_LIVE_QUALIFICATION"),
                        "{} must carry the typed pending reason",
                        capability.provider
                    );
                    assert!(!durable_souls_certified(capability.provider));
                }
                CertificationState::NotApplicable => {
                    assert!(!capability.durable_recovery_enabled);
                    assert!(!durable_souls_certified(capability.provider));
                }
                CertificationState::Certified => {
                    assert!(
                        capability.managed_enabled,
                        "{} is certified and must be managed-enabled",
                        capability.provider
                    );
                }
            }
            if capability.durable_recovery_enabled {
                assert_eq!(
                    capability.certification_state,
                    CertificationState::Certified,
                    "{} claims durable recovery without a certification",
                    capability.provider
                );
                assert!(durable_souls_certified(capability.provider));
            }
        }

        // Unknown providers are never certified.
        assert!(!durable_souls_certified("not-a-provider"));

        let deferred: Vec<_> = PROVIDER_CAPABILITIES
            .iter()
            .filter(|capability| {
                capability.certification_state
                    == CertificationState::PendingLiveProviderCertification
            })
            .map(|capability| capability.provider)
            .collect();
        assert_eq!(deferred, ["claude", "codex", "amplifier"]);

        let certified_durable: Vec<_> = PROVIDER_CAPABILITIES
            .iter()
            .filter(|capability| durable_souls_certified(capability.provider))
            .map(|capability| capability.provider)
            .collect();
        assert_eq!(certified_durable, ["opencode"]);
    }

    #[test]
    fn checked_in_manifest_publishes_the_same_certification_states() {
        let manifest: serde_json::Value = serde_json::from_str(include_str!(
            "../../../docs/development/runtime-provider-capabilities.json"
        ))
        .unwrap();
        for capability in PROVIDER_CAPABILITIES {
            let entry = manifest["providers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["provider"] == capability.provider)
                .unwrap();
            assert_eq!(
                entry["certificationState"],
                capability.certification_state.as_str(),
                "manifest certification state drifted for {}",
                capability.provider
            );
        }

        let certification = &manifest["certification"];
        assert_eq!(certification["schemaVersion"], 1);
        assert_eq!(
            certification["deferralReason"],
            "pending_live_provider_certification"
        );
        assert_eq!(
            certification["productionGate"]["status"],
            "BLOCKED_PENDING_LIVE_PROVIDER_CERTIFICATION"
        );
        assert_eq!(
            certification["deferredProviders"],
            serde_json::json!(["claude", "codex", "amplifier"])
        );
        assert_eq!(
            certification["certifiedDurableProviders"],
            serde_json::json!(["opencode"])
        );
        assert_eq!(certification["landingGate"]["id"], "durable-souls-landing");
        assert_eq!(
            certification["landingGate"]["deferrableProviders"],
            serde_json::json!(["claude", "codex", "amplifier"])
        );
    }

    fn resume_spec_for_test(provider: &str, session_id: &str, provider_home: &Path) -> ResumeSpec {
        ResumeSpec {
            schema_version: RESUME_SPEC_SCHEMA_VERSION,
            provider_session: ProviderSessionRef {
                provider: provider.into(),
                provider_store_id: "store-test".into(),
                native_session_id: session_id.into(),
            },
            mode: provider.into(),
            runtime_variant: provider.into(),
            fixture_transport: None,
            program: provider.into(),
            resume_argv: Vec::new(),
            provider_home: provider_home.display().to_string(),
            provider_volume: None,
            cwd: provider_home.display().to_string(),
            workspace_path: provider_home.display().to_string(),
            project_key: None,
            runtime_profile: None,
            environment: BTreeMap::new(),
            model: None,
            reasoning_effort: None,
            permission_mode: None,
            image_ref: None,
            provider_version: None,
            credential_references: Vec::new(),
            identity_provenance: IdentityProvenance::ProviderObserved,
            durable_position: DurablePosition::default(),
            checkpoint_references: Vec::new(),
            creation_seed_ref: "seed".into(),
            checkpoint_revision: 0,
            allocation_state: AllocationState::VerifiedDurable,
            evidence_revision: 1,
            never_dispatched: false,
        }
    }

    #[test]
    fn amplifier_probe_requires_a_materialized_exact_session() {
        let home = tempfile::tempdir().unwrap();
        let amplifier_home = home.path().join(".amplifier");
        let cwd = home.path().join("workspace");
        std::fs::create_dir_all(&cwd).unwrap();
        let session_id = "amp-exact-session";
        let ensured = freshell_sessions::amplifier_stub::ensure_session(
            &amplifier_home,
            session_id,
            cwd.to_str().unwrap(),
            "terminal-one",
        )
        .unwrap();
        let spec = resume_spec_for_test("amplifier", session_id, home.path());
        assert!(matches!(
            probe_provider_store(home.path(), &spec),
            ProviderStoreProbe::DefinitivelyUnavailable { .. }
        ));

        let mut metadata: serde_json::Value = serde_json::from_slice(
            &std::fs::read(ensured.session_dir.join("metadata.json")).unwrap(),
        )
        .unwrap();
        metadata["turn_count"] = serde_json::json!(1);
        std::fs::write(
            ensured.session_dir.join("metadata.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            probe_provider_store(home.path(), &spec),
            ProviderStoreProbe::Ready { .. }
        ));
    }
}

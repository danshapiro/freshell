//! Provider-independent recovery policy plus provider-specific resume adapters.
//!
//! This crate is intentionally unable to spawn or kill a process.  It turns
//! durable identity/evidence into an exact launch specification and classifies
//! soul-local provider stores.  The supervisor retains lifecycle authority and
//! the session host is the only component allowed to execute provider code.

use freshell_runtime_protocol::{
    AllocationState, DurablePosition, EvidenceStoreState, IdentityProvenance, ProviderSessionRef,
    RecoveryBlockReason, RecoveryPath, RecoveryProbe, ResumeSpec, RetryHint, RuntimeError,
    RuntimeErrorCode, TerminalLaunchSpec, RESUME_SPEC_SCHEMA_VERSION,
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
pub mod opencode_transfer;
pub mod snapshot_projection;

#[cfg(test)]
#[path = "snapshot_projection_tests.rs"]
mod snapshot_projection_tests;

pub const PROVIDER_HOME: &str = "/home/freshell/provider";
pub const MAX_SUCCESSFUL_RECOVERIES_PER_HOUR: u64 = 5;
pub const RECOVERY_WINDOW_MS: i64 = 60 * 60 * 1_000;
pub const AUTOMATIC_RETRY_DELAYS_MS: [u64; 2] = [2_000, 10_000];

/// Missing identity cannot identify which provider history must be inspected.
pub fn unverified_native_probe() -> RecoveryProbe {
    RecoveryProbe::Blocked {
        path: RecoveryPath::NativeResume,
        reason: RecoveryBlockReason::StoreUnreadable,
        retry_hint: RetryHint {
            automatic_after_ms: None,
            manual_retry: true,
            repair: Some("provider identity or exact storage census has not been verified".into()),
        },
        evidence: Vec::new(),
    }
}

const NATIVE_CENSUS_PREFIX: &str = "nativeAbsenceCensus=v2:";

/// Body-free evidence emitted only after a complete provider reader negative.
/// The storage generation is independent of the registry evidence revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeAbsenceCensus {
    provider: String,
    store: String,
    native_id: String,
    evidence_revision: u64,
    provider_home: String,
    environment_fingerprint: String,
    inspected_home: String,
    generation: String,
    store_state: EvidenceStoreState,
}

fn native_census(evidence: &[String]) -> Option<NativeAbsenceCensus> {
    let mut receipts = evidence
        .iter()
        .filter_map(|reference| reference.strip_prefix(NATIVE_CENSUS_PREFIX));
    let receipt = serde_json::from_str(receipts.next()?).ok()?;
    if receipts.next().is_some() {
        return None;
    }
    Some(receipt)
}

/// Canonical body-free serialization for an already qualified reader receipt.
/// Parsing alone is not absence proof; callers must validate the exact tuple,
/// environment and current storage before relying on this reference.
pub fn canonical_native_absence_census_reference(evidence: &[String]) -> Option<String> {
    let census = native_census(evidence)?;
    Some(format!(
        "{NATIVE_CENSUS_PREFIX}{}",
        serde_json::to_string(&census).ok()?
    ))
}

fn native_environment_fingerprint(spec: &ResumeSpec) -> String {
    let selection: BTreeMap<_, _> = spec
        .environment
        .iter()
        .filter(|(key, _)| {
            matches!(
                key.as_str(),
                "HOME"
                    | "CLAUDE_CONFIG_DIR"
                    | "CODEX_HOME"
                    | "AMPLIFIER_HOME"
                    | "XDG_DATA_HOME"
                    | "OPENCODE_DB"
            )
        })
        .collect();
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(spec.provider_home.as_str(), selection))
                .expect("store selection serializes")
        )
    )
}

pub fn native_absence_census_environment_matches(spec: &ResumeSpec, evidence: &[String]) -> bool {
    native_census(evidence).is_some_and(|census| {
        census.provider_home == spec.provider_home
            && census.environment_fingerprint == native_environment_fingerprint(spec)
    })
}

pub fn native_absence_census_matches(
    provider: &str,
    store: &str,
    native_id: &str,
    revision: u64,
    store_state: EvidenceStoreState,
    evidence: &[String],
) -> bool {
    let Some(census) = native_census(evidence) else {
        return false;
    };
    census.provider == provider
        && census.store == store
        && census.native_id == native_id
        && census.evidence_revision == revision
        && census.store_state == store_state
        && !native_id.trim().is_empty()
        && !census.provider_home.is_empty()
        && [&census.environment_fingerprint, &census.generation]
            .iter()
            .all(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            })
        && (census.inspected_home == PROVIDER_HOME || native_absence_census_current(evidence))
}

/// Reinspect a directly accessible capture before registry commit or cleanup.
/// Container-home receipts instead require a new owned-volume reader result.
pub fn native_absence_census_current(evidence: &[String]) -> bool {
    native_census(evidence).is_some_and(|census| {
        let home = Path::new(&census.inspected_home);
        let before = native_store_generation(home, &census.provider).ok();
        before.as_deref() == Some(&census.generation)
            && matches!(probe_selected_provider_identity(home, &census.provider, &census.native_id),
                ProviderStoreProbe::DefinitivelyUnavailable { store_state, .. } if store_state == census.store_state)
            && native_store_generation(home, &census.provider).ok() == before
    })
}

pub fn native_absence_census_is_container(evidence: &[String]) -> bool {
    native_census(evidence).is_some_and(|census| census.inspected_home == PROVIDER_HOME)
}

pub fn same_native_absence_census(captured: &[String], current: &[String]) -> bool {
    match (native_census(captured), native_census(current)) {
        (Some(captured), Some(current)) => captured == current,
        _ => false,
    }
}

fn native_store_generation(home: &Path, provider: &str) -> Result<String, ()> {
    let canonical = fs::canonicalize(home).map_err(|_| ())?;
    if canonical != home {
        return Err(());
    }
    let root = home.join(match provider {
        "claude" | "kilroy" => ".claude/projects",
        "codex" => ".codex/sessions",
        "amplifier" => ".amplifier/projects",
        "opencode" => ".local/share/opencode",
        "phase1-fixture" | "native-session-fixture" => ".",
        _ => return Err(()),
    });
    inspect_native_path(home, &root).map_err(|_| ())?;
    let mut hash = Sha256::new();
    hash.update(b"freshell-native-store-generation-v2\0");
    let mut queue = VecDeque::from([(root, 0_u8)]);
    let mut visited = 0_usize;
    let mut total_bytes = 0_u64;
    while let Some((path, depth)) = queue.pop_front() {
        visited += 1;
        if visited > 50_000 || depth > 8 {
            return Err(());
        }
        hash.update(
            path.strip_prefix(home)
                .map_err(|_| ())?
                .as_os_str()
                .as_encoded_bytes(),
        );
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && depth == 0 => {
                hash.update(b"missing");
                continue;
            }
            Err(_) => return Err(()),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = metadata.permissions().mode();
            hash.update(mode.to_le_bytes());
            if mode & 0o444 == 0 || (metadata.is_dir() && mode & 0o111 == 0) {
                return Err(());
            }
        }
        if metadata.is_dir() {
            hash.update(b"directory\0");
            let mut children = fs::read_dir(&path)
                .map_err(|_| ())?
                .map(|entry| entry.map(|entry| entry.path()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| ())?;
            children.sort();
            for child in children {
                queue.push_back((child, depth + 1));
            }
        } else if metadata.is_file() {
            total_bytes = total_bytes.checked_add(metadata.len()).ok_or(())?;
            if total_bytes > 512 * 1024 * 1024 {
                return Err(());
            }
            hash.update(b"file\0");
            hash.update(metadata.len().to_le_bytes());
            use std::io::Read;
            let mut file = fs::File::open(&path).map_err(|_| ())?;
            let mut buffer = [0_u8; 64 * 1024];
            let mut read_bytes = 0_u64;
            loop {
                let count = file.read(&mut buffer).map_err(|_| ())?;
                if count == 0 {
                    break;
                }
                read_bytes = read_bytes.checked_add(count as u64).ok_or(())?;
                if read_bytes > metadata.len() {
                    return Err(());
                }
                hash.update(&buffer[..count]);
            }
            if read_bytes != metadata.len() {
                return Err(());
            }
        } else {
            return Err(());
        }
    }
    Ok(format!("{:x}", hash.finalize()))
}

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
    /// The adapter can run in an explicitly selected qualification build.
    /// This does not authorize a release claim.
    pub qualification_ready: bool,
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
        qualification_ready: true,
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
        qualification_ready: true,
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
        bootstrap: "typed Claude OneCLI environment/auth-file reference resolved for provider child; legacy Kilroy raw bootstrap is separate",
        live_gate: "haiku-lowest-reasoning",
        blocked_reason: Some("PENDING_LIVE_QUALIFICATION"),
    },
    ProviderCapability {
        provider: "opencode",
        certification_state: CertificationState::Certified,
        qualification_ready: true,
        managed_enabled: true,
        durable_recovery_enabled: true,
        recovery_paths: &[
            RecoveryPath::Reattach,
            RecoveryPath::NativeResume,
            RecoveryPath::CheckpointRestore,
            RecoveryPath::PristineSeed,
            RecoveryPath::NativeImport,
        ],
        managed_modes: &["opencode"],
        execution_boundary: "session-host-pty",
        identity_capture: "soul-local-sqlite-exact-row",
        state_store: "$XDG_DATA_HOME/opencode/opencode.db",
        resume_command: Some("opencode --session <exact-ses-id>"),
        zero_turn_policy: "session-row-must-materialize",
        checkpoint_policy: "provider-sqlite-only-no-live-copy",
        bootstrap: "typed OpenCode OneCLI environment/auth-file reference resolved for provider child",
        live_gate: "opencode-1.18.21-big-pickle-free-tier",
        blocked_reason: None,
    },
    ProviderCapability {
        provider: "codex",
        certification_state: CertificationState::PendingLiveProviderCertification,
        qualification_ready: true,
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
        bootstrap: "typed Codex OneCLI environment/auth-file reference resolved for provider child",
        live_gate: "gpt-5.6-luna-lowest-reasoning",
        blocked_reason: Some("PENDING_LIVE_QUALIFICATION"),
    },
    ProviderCapability {
        provider: "amplifier",
        certification_state: CertificationState::PendingLiveProviderCertification,
        qualification_ready: true,
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
        bootstrap: "optional typed Amplifier OneCLI environment/auth-file reference resolved for provider child; ordinary configured bundle/provider/model/plugins/operations",
        live_gate: "provider-approved-lowest-cost-model",
        blocked_reason: Some("PENDING_LIVE_QUALIFICATION"),
    },
    ProviderCapability {
        provider: "gemini",
        certification_state: CertificationState::NotApplicable,
        qualification_ready: false,
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
        qualification_ready: false,
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
        opencode_adoption_baseline: None,
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
    if !fs::symlink_metadata(provider_home).is_ok_and(|metadata| metadata.is_dir()) {
        return blocked(
            RecoveryBlockReason::StoreMissing,
            "soul provider-state mount is unavailable",
            vec![provider_home.display().to_string()],
            Some("restore the soul provider-state volume"),
        );
    }
    let expected = spec.provider_session.native_session_id.as_str();
    if expected.trim().is_empty() {
        return blocked(
            RecoveryBlockReason::StoreUnreadable,
            "provider identity has not been verified",
            Vec::new(),
            None,
        );
    }
    let home = &spec.provider_home;
    let mut canonical_overrides = match spec.provider_session.provider.as_str() {
        "claude" | "kilroy" => vec![("CLAUDE_CONFIG_DIR", format!("{home}/.claude"))],
        "codex" => vec![("CODEX_HOME", format!("{home}/.codex"))],
        "amplifier" => vec![("AMPLIFIER_HOME", format!("{home}/.amplifier"))],
        "opencode" => vec![
            ("XDG_DATA_HOME", format!("{home}/.local/share")),
            (
                "OPENCODE_DB",
                format!("{home}/.local/share/opencode/opencode.db"),
            ),
        ],
        _ => Vec::new(),
    };
    canonical_overrides.push(("HOME", home.clone()));
    if canonical_overrides.iter().any(|(key, canonical)| {
        spec.environment
            .get(*key)
            .is_some_and(|value| value != canonical)
    }) {
        return blocked(
            RecoveryBlockReason::StoreUnreadable,
            "selected provider environment points to an uninspected store",
            Vec::new(),
            None,
        );
    }
    let mut result = probe_selected_provider_store(provider_home, spec);
    let captured_result = result.clone();
    if let ProviderStoreProbe::DefinitivelyUnavailable {
        evidence,
        store_state,
        ..
    } = &mut result
    {
        let generation_before =
            native_store_generation(provider_home, &spec.provider_session.provider);
        // Repeat the semantic reader inside the storage-generation window.
        // Positive resume probes need no negative census.
        if probe_selected_provider_store(provider_home, spec) != captured_result {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                "native storage classification changed during inspection",
                Vec::new(),
                None,
            );
        }
        let generation_after =
            native_store_generation(provider_home, &spec.provider_session.provider);
        let (Ok(before), Ok(after)) = (generation_before, generation_after) else {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                "complete native storage generation could not be inspected",
                Vec::new(),
                None,
            );
        };
        if before != after {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                "native storage changed during inspection",
                Vec::new(),
                None,
            );
        }
        let census = NativeAbsenceCensus {
            provider: spec.provider_session.provider.clone(),
            store: spec.provider_session.provider_store_id.clone(),
            native_id: expected.into(),
            evidence_revision: spec.evidence_revision,
            provider_home: spec.provider_home.clone(),
            environment_fingerprint: native_environment_fingerprint(spec),
            inspected_home: provider_home.display().to_string(),
            generation: after,
            store_state: *store_state,
        };
        evidence.push(format!(
            "{NATIVE_CENSUS_PREFIX}{}",
            serde_json::to_string(&census).expect("census serializes")
        ));
    }
    result
}

fn probe_selected_provider_store(provider_home: &Path, spec: &ResumeSpec) -> ProviderStoreProbe {
    probe_selected_provider_identity(
        provider_home,
        &spec.provider_session.provider,
        &spec.provider_session.native_session_id,
    )
}

fn probe_selected_provider_identity(
    provider_home: &Path,
    provider: &str,
    expected: &str,
) -> ProviderStoreProbe {
    match provider {
        "phase1-fixture" | "native-session-fixture" => {
            probe_native_fixture(provider_home, expected)
        }
        "claude" | "kilroy" => probe_bounded_tree(
            &provider_home.join(".claude/projects"),
            expected,
            ArtifactMatch::Claude,
        ),
        "codex" => probe_bounded_tree(
            &provider_home.join(".codex/sessions"),
            expected,
            ArtifactMatch::Codex,
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
    if let Err(probe) = inspect_native_path(provider_home, &path) {
        return probe;
    }
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
    let present = match inspect_native_path(provider_home, &directory) {
        Ok(present) => present,
        Err(probe) => return probe,
    };
    if !present {
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
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                "native fixture checkpoint cannot be completely inspected within the byte limit",
                vec![path.display().to_string()],
                None,
            );
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

// Inspect every canonical ancestor before interpreting NotFound as absence.
// `Path::exists` alone hides permission failures and dangling/looping links.
fn inspect_native_path(provider_home: &Path, path: &Path) -> Result<bool, ProviderStoreProbe> {
    let relative = path.strip_prefix(provider_home).map_err(|_| {
        blocked(
            RecoveryBlockReason::StoreUnreadable,
            "provider store is outside its owned HOME",
            Vec::new(),
            None,
        )
    })?;
    let mut current = provider_home.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(blocked(
                    RecoveryBlockReason::AmbiguousIdentity,
                    "provider store path is not canonical",
                    vec![path.display().to_string()],
                    None,
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => {
                return Err(blocked(
                    RecoveryBlockReason::StoreUnreadable,
                    "provider store path could not be inspected",
                    vec![path.display().to_string()],
                    Some("repair provider-state volume permissions"),
                ))
            }
        }
    }
    Ok(true)
}

fn probe_opencode(provider_home: &Path, expected: &str) -> ProviderStoreProbe {
    let path = provider_home.join(".local/share/opencode/opencode.db");
    let present = match inspect_native_path(provider_home, &path) {
        Ok(present) => present,
        Err(probe) => return probe,
    };
    if !present {
        for companion in ["opencode.db-wal", "opencode.db-shm", "opencode.db-journal"] {
            match inspect_native_path(provider_home, &path.with_file_name(companion)) {
                Ok(false) => {}
                Ok(true) => {
                    return blocked(
                        RecoveryBlockReason::StoreUnreadable,
                        "OpenCode database is missing but retained SQLite storage remains",
                        vec![path.display().to_string()],
                        None,
                    )
                }
                Err(probe) => return probe,
            }
        }
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
        Ok(false) => {
            let census = path.canonicalize().ok().and_then(|canonical| {
                let source_store =
                    hex::encode(Sha256::digest(canonical.to_string_lossy().as_bytes()));
                freshell_sessions::opencode_transfer::HostOpenCodeInventory::new(canonical)
                    .inspect_exact_origin(&source_store, expected)
                    .ok()
            });
            match census {
                Some(census) if !census.available() => ProviderStoreProbe::DefinitivelyUnavailable {
                    reason: format!("qualified OpenCode database has no exact session row or retained references for {expected}"),
                    evidence: vec![path.display().to_string(), format!("nativeStoreCensus=sha256:{}", census.inventory_fingerprint())],
                    store_state: EvidenceStoreState::PresentReadable,
                },
                _ => blocked(RecoveryBlockReason::StoreUnreadable,
                    "exact OpenCode store census is incomplete or unqualified",
                    vec![path.display().to_string()], None),
            }
        }
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
    let present = match inspect_native_path(provider_home, &root) {
        Ok(present) => present,
        Err(probe) => return probe,
    };
    if !present {
        return ProviderStoreProbe::DefinitivelyUnavailable {
            reason: "Amplifier project store is absent".into(),
            evidence: vec![root.display().to_string()],
            store_state: EvidenceStoreState::Missing,
        };
    }
    let mut queue = VecDeque::from([(root.clone(), 0_u8)]);
    let mut matches = Vec::new();
    let mut unresolved_candidates = false;
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
        if metadata.file_type().is_symlink() {
            return blocked(
                RecoveryBlockReason::AmbiguousIdentity,
                "provider store contains an uninspected symlink",
                vec![root.display().to_string()],
                None,
            );
        }
        if !metadata.is_dir() {
            if path == root {
                return blocked(
                    RecoveryBlockReason::StoreUnreadable,
                    "provider store root is not a directory",
                    vec![root.display().to_string()],
                    None,
                );
            }
            continue;
        }
        if path.file_name().is_some_and(|name| name == expected) {
            matches.push(path.clone());
            continue;
        }
        if path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "sessions")
        {
            unresolved_candidates |= path
                .file_name()
                .and_then(|name| name.to_str())
                .is_none_or(|identity| qualified_amplifier_stub(&path, identity).is_none());
        }
        if depth >= 8 {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                "provider store census reached its depth limit",
                vec![root.display().to_string()],
                None,
            );
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
    let stub = matches.first().and_then(|session_dir| {
        qualified_amplifier_stub(session_dir, expected)
            .or_else(|| completed_amplifier_store(session_dir, expected).then_some(false))
    });
    if unresolved_candidates && matches.len() <= 1 && stub != Some(false) {
        return blocked(
            RecoveryBlockReason::StoreUnreadable,
            "Amplifier store contains a candidate without complete native identity evidence",
            vec![root.display().to_string()],
            None,
        );
    }
    match matches.as_slice() {
        [] => ProviderStoreProbe::DefinitivelyUnavailable {
            reason: format!("Amplifier store has no exact session {expected}"),
            evidence: vec![root.display().to_string()],
            store_state: EvidenceStoreState::PresentReadable,
        },
        [session_dir] if stub == Some(true) => {
            ProviderStoreProbe::DefinitivelyUnavailable {
                reason: format!(
                    "Amplifier session {expected} is a pristine launcher stub, not a durable conversation"
                ),
                evidence: vec![session_dir.display().to_string(), "turnCount=0".into()],
                store_state: EvidenceStoreState::PresentReadable,
            }
        }
        [session_dir] if stub == Some(false) => ProviderStoreProbe::Ready {
            evidence: vec![session_dir.display().to_string(), format!("sessionId={expected}")],
        },
        [_] => blocked(RecoveryBlockReason::StoreUnreadable,
            "Amplifier exact candidate identity or complete launcher-stub census is unresolved",
            vec![root.display().to_string()], None),
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
    Claude,
    Codex,
}

fn probe_bounded_tree(root: &Path, expected: &str, mode: ArtifactMatch) -> ProviderStoreProbe {
    let provider_home = root
        .parent()
        .and_then(Path::parent)
        .expect("provider root is under HOME");
    let present = match inspect_native_path(provider_home, root) {
        Ok(present) => present,
        Err(probe) => return probe,
    };
    if !present {
        return ProviderStoreProbe::DefinitivelyUnavailable {
            reason: "provider session root is absent".into(),
            evidence: vec![root.display().to_string()],
            store_state: EvidenceStoreState::Missing,
        };
    }
    let mut queue = VecDeque::from([(root.to_path_buf(), 0_u8)]);
    let mut visited = 0_usize;
    let mut matches = Vec::new();
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
            return blocked(
                RecoveryBlockReason::AmbiguousIdentity,
                "provider store contains an uninspected symlink",
                vec![root.display().to_string()],
                None,
            );
        }
        if path == root && !metadata.is_dir() {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                "provider store root is not a directory",
                vec![root.display().to_string()],
                None,
            );
        }
        if metadata.is_dir() {
            if depth >= 8 {
                return blocked(
                    RecoveryBlockReason::StoreUnreadable,
                    "provider store census reached its depth limit",
                    vec![root.display().to_string()],
                    None,
                );
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
        {
            let filename_match = path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(expected));
            if !metadata.is_file() || metadata.len() > 1024 * 1024 {
                return blocked(
                    RecoveryBlockReason::StoreUnreadable,
                    "provider artifact cannot be completely inspected within the byte limit",
                    vec![root.display().to_string()],
                    None,
                );
            }
            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => {
                    return blocked(
                        RecoveryBlockReason::StoreUnreadable,
                        "provider artifact read failed",
                        vec![root.display().to_string()],
                        Some("repair provider-state volume permissions"),
                    )
                }
            };
            let content_match = bytes
                .windows(expected.len())
                .any(|w| w == expected.as_bytes());
            if filename_match || content_match {
                matches.push(path.display().to_string());
            } else if !native_artifact_excludes_identity(&bytes, expected, &mode) {
                return blocked(
                    RecoveryBlockReason::StoreUnreadable,
                    "provider artifact is partial or its encoded identity is unresolved",
                    vec![root.display().to_string()],
                    None,
                );
            }
        }
    }
    match matches.len() {
        0 => ProviderStoreProbe::DefinitivelyUnavailable {
            reason: format!("no exact provider artifact for {expected}"),
            evidence: vec![root.display().to_string()],
            store_state: EvidenceStoreState::PresentReadable,
        },
        1 => ProviderStoreProbe::Ready { evidence: matches },
        _ => blocked(
            RecoveryBlockReason::AmbiguousIdentity,
            "provider identity has multiple candidate artifacts",
            matches,
            None,
        ),
    }
}

// A text-search miss cannot certify absence from malformed or encoded JSONL.
// Encoded matches stay unresolved; this never selects another native session.
fn native_artifact_excludes_identity(bytes: &[u8], expected: &str, mode: &ArtifactMatch) -> bool {
    let mut identity: Option<String> = None;
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
    {
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
            return false;
        };
        if !value.is_object() {
            return false;
        }
        let Ok(normalized) = serde_json::to_vec(&value) else {
            return false;
        };
        if normalized
            .windows(expected.len())
            .any(|window| window == expected.as_bytes())
        {
            return false;
        }
        let candidate = match mode {
            ArtifactMatch::Claude => {
                let kind = value.get("type").and_then(serde_json::Value::as_str);
                let complete = match kind {
                    Some("user" | "assistant") => value.get("message").is_some_and(|message| {
                        message.get("role").and_then(serde_json::Value::as_str) == kind
                            && message
                                .get("content")
                                .is_some_and(|content| content.is_string() || content.is_array())
                    }),
                    Some("system") => value
                        .get("subtype")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|subtype| !subtype.is_empty()),
                    Some("custom-title") => value
                        .get("customTitle")
                        .is_some_and(serde_json::Value::is_string),
                    _ => false,
                };
                if !complete {
                    return false;
                }
                value.get("sessionId").and_then(serde_json::Value::as_str)
            }
            ArtifactMatch::Codex => {
                if value.get("type").and_then(serde_json::Value::as_str) == Some("session_meta") {
                    value
                        .get("payload")
                        .and_then(|payload| payload.get("id"))
                        .and_then(serde_json::Value::as_str)
                } else if identity.is_some()
                    && value
                        .get("type")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|kind| {
                            matches!(kind, "event_msg" | "response_item" | "turn_context")
                        })
                    && value
                        .get("payload")
                        .is_some_and(serde_json::Value::is_object)
                {
                    continue;
                } else {
                    return false;
                }
            }
        };
        let Some(candidate) = candidate.filter(|id| !id.trim().is_empty() && *id != expected)
        else {
            return false;
        };
        if identity.as_deref().is_some_and(|id| id != candidate) {
            return false;
        }
        identity = Some(candidate.into());
    }
    identity.is_some()
}

// Loss evidence is stricter than the independent best-effort stub GC policy.
// Every canonical child must be inspected; partial candidates remain unknown.
fn qualified_amplifier_stub(session_dir: &Path, expected: &str) -> Option<bool> {
    let mut files = BTreeMap::new();
    for entry in fs::read_dir(session_dir).ok()? {
        let path = entry.ok()?.path();
        let name = path.file_name()?.to_str()?.to_owned();
        if !matches!(
            name.as_str(),
            "metadata.json" | "transcript.jsonl" | "events.jsonl"
        ) {
            return None;
        }
        let metadata = fs::symlink_metadata(&path).ok()?;
        if !metadata.is_file() || metadata.len() > 1024 * 1024 {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o444 == 0 {
                return None;
            }
        }
        files.insert(name, fs::read(path).ok()?);
    }
    let metadata: serde_json::Value = serde_json::from_slice(files.get("metadata.json")?).ok()?;
    if metadata
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        != Some(expected)
        || !["created", "working_dir"].iter().all(|key| {
            metadata
                .get(key)
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
        })
    {
        return None;
    }
    let transcript = files.get("transcript.jsonl")?;
    let events = files.get("events.jsonl")?;
    let mut materialized = !transcript.is_empty();
    if let Some(turn_count) = metadata.get("turn_count") {
        if turn_count.as_u64().is_none_or(|count| count == 0) {
            return None;
        }
        materialized = true;
    }
    for line in events
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
    {
        let event: serde_json::Value = serde_json::from_slice(line).ok()?;
        match event.get("event").and_then(serde_json::Value::as_str)? {
            "session:start" | "session:end" | "session:resume" => {}
            "prompt:submit" => materialized = true,
            _ => return None,
        }
        if event
            .get("session_id")
            .is_some_and(|id| id.as_str() != Some(expected))
        {
            return None;
        }
    }
    Some(!materialized)
}

// A native save has ordinary execution events and atomic-write backups. Those
// are positive history evidence, while pristine-stub absence keeps its stricter
// exhaustive census above.
fn completed_amplifier_store(session_dir: &Path, expected: &str) -> bool {
    let inspect = || -> Option<()> {
        let mut files = BTreeMap::new();
        for entry in fs::read_dir(session_dir).ok()? {
            let path = entry.ok()?.path();
            let name = path.file_name()?.to_str()?.to_owned();
            if !matches!(
                name.as_str(),
                "metadata.json"
                    | "metadata.json.backup"
                    | "transcript.jsonl"
                    | "transcript.jsonl.backup"
                    | "events.jsonl"
            ) {
                return None;
            }
            let before = fs::symlink_metadata(&path).ok()?;
            if !before.is_file() || before.len() > 64 * 1024 * 1024 {
                return None;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if before.permissions().mode() & 0o444 == 0 {
                    return None;
                }
            }
            let bytes = fs::read(&path).ok()?;
            let after = fs::symlink_metadata(&path).ok()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if before.dev() != after.dev() || before.ino() != after.ino() {
                    return None;
                }
            }
            if before.len() != after.len()
                || before.modified().ok()? != after.modified().ok()?
                || bytes.len() as u64 != after.len()
            {
                return None;
            }
            files.insert(name, bytes);
        }
        for name in ["metadata.json", "metadata.json.backup"] {
            if let Some(bytes) = files.get(name) {
                let metadata: serde_json::Value = serde_json::from_slice(bytes).ok()?;
                if metadata["session_id"].as_str() != Some(expected) {
                    return None;
                }
                if name == "metadata.json"
                    && (metadata["turn_count"].as_u64()? == 0
                        || !["created", "working_dir"].iter().all(|key| {
                            metadata[key].as_str().is_some_and(|v| !v.trim().is_empty())
                        }))
                {
                    return None;
                }
            } else if name == "metadata.json" {
                return None;
            }
        }
        let mut user = false;
        let mut assistant = false;
        let mut completed = false;
        for name in [
            "transcript.jsonl",
            "transcript.jsonl.backup",
            "events.jsonl",
        ] {
            let Some(bytes) = files.get(name) else {
                if name.ends_with(".backup") {
                    continue;
                }
                return None;
            };
            if !bytes.is_empty() && !bytes.ends_with(b"\n") {
                return None;
            }
            for line in bytes
                .split(|b| *b == b'\n')
                .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
            {
                let row: serde_json::Value = serde_json::from_slice(line).ok()?;
                if name == "events.jsonl" {
                    let event = row["event"].as_str().filter(|v| !v.is_empty())?;
                    if row["session_id"].as_str() != Some(expected) {
                        return None;
                    }
                    completed |= event == "cleanup:store_end";
                } else {
                    let role = row["role"].as_str()?;
                    if !matches!(role, "user" | "assistant" | "tool")
                        || !row["content"].is_string() && !row["content"].is_array()
                        || row
                            .get("session_id")
                            .is_some_and(|id| id.as_str() != Some(expected))
                    {
                        return None;
                    }
                    if name == "transcript.jsonl" {
                        user |= role == "user";
                        assistant |= role == "assistant";
                    }
                }
            }
        }
        (user && assistant && completed).then_some(())
    };
    inspect().is_some()
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
            provider_launch_context: None,
            opencode_transfer: None,
            opencode_transfer_attempt_id: None,
            opencode_adoption: None,
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
    fn incomplete_native_census_cannot_certify_absence() {
        for provider in ["claude", "codex", "amplifier"] {
            for fault in ["depth", "symlink", "bytes"] {
                if provider == "amplifier" && fault == "bytes" {
                    continue;
                }
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path().join(match provider {
                    "claude" => ".claude/projects",
                    "codex" => ".codex/sessions",
                    _ => ".amplifier/projects",
                });
                fs::create_dir_all(&root).unwrap();
                match fault {
                    "depth" => {
                        let mut deep = root.clone();
                        for _ in 0..10 {
                            deep.push("nested");
                        }
                        fs::create_dir_all(&deep).unwrap();
                        fs::write(deep.join("uninspected.jsonl"), "saved-exact-root").unwrap();
                    }
                    "bytes" => {
                        fs::write(root.join("large.jsonl"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
                    }
                    "symlink" => {
                        #[cfg(unix)]
                        std::os::unix::fs::symlink(
                            dir.path().join("missing"),
                            root.join("uninspected"),
                        )
                        .unwrap();
                    }
                    _ => unreachable!(),
                }
                let spec = build_resume_spec(ResumeSpecInput {
                    provider,
                    provider_store_id: "store-one",
                    native_session_id: "saved-exact-root",
                    terminal: &terminal(provider, &[]),
                    provider_version: None,
                    creation_seed_ref: "seed".into(),
                    checkpoint_revision: 0,
                    evidence_revision: 1,
                    never_dispatched: false,
                })
                .unwrap();
                let probe = probe_provider_store(dir.path(), &spec);
                assert!(
                    matches!(probe, ProviderStoreProbe::Blocked { .. }),
                    "{provider}/{fault}: {probe:?}"
                );
                assert!(root.is_dir());
            }
        }
    }

    #[test]
    fn native_artifact_reader_failure_or_encoded_identity_cannot_certify_absence() {
        for provider in ["claude", "codex"] {
            for bytes in [
                b"{partial native artifact".as_slice(),
                br#"{"sessionId":"saved-exact-\u0072oot"}"#.as_slice(),
            ] {
                let dir = tempfile::tempdir().unwrap();
                let root = dir.path().join(if provider == "claude" {
                    ".claude/projects"
                } else {
                    ".codex/sessions"
                });
                fs::create_dir_all(&root).unwrap();
                fs::write(root.join("unknown.jsonl"), bytes).unwrap();
                let spec = build_resume_spec(ResumeSpecInput {
                    provider,
                    provider_store_id: "store",
                    native_session_id: "saved-exact-root",
                    terminal: &terminal(provider, &[]),
                    provider_version: None,
                    creation_seed_ref: "seed".into(),
                    checkpoint_revision: 0,
                    evidence_revision: 1,
                    never_dispatched: false,
                })
                .unwrap();
                let probe = probe_provider_store(dir.path(), &spec);
                assert!(
                    matches!(probe, ProviderStoreProbe::Blocked { .. }),
                    "{provider}: {probe:?}"
                );
            }
        }
    }

    #[test]
    fn native_artifact_semantic_identity_is_required_for_absence() {
        for provider in ["claude", "kilroy", "codex"] {
            for bytes in [
                br#"{}"#.as_slice(),
                br#"{"sessionId":null}"#.as_slice(),
                br#"{"type":"session_meta","payload":{}}"#.as_slice(),
                br#"{"type":"session_meta","payload":{"id":null}}"#.as_slice(),
                br#"{"type":"session_meta","payload":{"id":"other"}}"#.as_slice(),
                br#"{"sessionId":"other"}"#.as_slice(),
                br#"{"type":"user","sessionId":"other"}"#.as_slice(),
                br#"{"type":"user","sessionId":"other","message":{"role":"user","content":"synthetic"}}"#.as_slice(),
            ] {
                let home = tempfile::tempdir().unwrap();
                let root = home.path().join(if provider == "codex" {
                    ".codex/sessions"
                } else {
                    ".claude/projects"
                });
                fs::create_dir_all(&root).unwrap();
                fs::write(root.join("unknown.jsonl"), bytes).unwrap();
                let spec = resume_spec_for_test(provider, "saved-exact-root", home.path());
                let probe = probe_provider_store(home.path(), &spec);
                let complete_other = if provider == "codex" {
                    bytes == br#"{"type":"session_meta","payload":{"id":"other"}}"#
                } else {
                    bytes == br#"{"type":"user","sessionId":"other","message":{"role":"user","content":"synthetic"}}"#
                };
                assert_eq!(
                    matches!(probe, ProviderStoreProbe::DefinitivelyUnavailable { .. }),
                    complete_other,
                    "{provider}: semantically unresolved artifacts must stay blocked: {probe:?}"
                );
            }
        }
    }

    #[test]
    fn alternate_home_cannot_certify_native_absence_from_the_canonical_store() {
        for provider in ["claude", "kilroy", "codex", "opencode", "amplifier"] {
            let home = tempfile::tempdir().unwrap();
            let mut spec = resume_spec_for_test(provider, "saved-exact-root", home.path());
            spec.environment
                .insert("HOME".into(), "/uninspected/provider-home".into());
            assert!(
                matches!(
                    probe_provider_store(home.path(), &spec),
                    ProviderStoreProbe::Blocked { .. }
                ),
                "{provider}: selected HOME must match the inspected provider home"
            );
        }
    }

    #[test]
    fn amplifier_absence_requires_complete_exact_stub() {
        for fault in [
            "null",
            "empty",
            "missing_id",
            "conflicting_id",
            "partial_events",
            "unknown_events",
            "child_symlink",
            "missing_transcript",
            "extra_child",
            "unreadable_child",
            "null_turn_count",
            "materialized_partial_events",
        ] {
            let home = tempfile::tempdir().unwrap();
            let cwd = home.path().join("workspace");
            fs::create_dir_all(&cwd).unwrap();
            let session = freshell_sessions::amplifier_stub::ensure_session(
                &home.path().join(".amplifier"),
                "amp-exact-session",
                cwd.to_str().unwrap(),
                "terminal-one",
            )
            .unwrap();
            let metadata = session.session_dir.join("metadata.json");
            match fault {
                "null" => fs::write(&metadata, "null").unwrap(),
                "empty" => fs::write(&metadata, "{}").unwrap(),
                "missing_id" | "conflicting_id" => {
                    let mut value: serde_json::Value =
                        serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
                    if fault == "missing_id" {
                        value.as_object_mut().unwrap().remove("session_id");
                    } else {
                        value["session_id"] = "different-session".into();
                    }
                    fs::write(&metadata, serde_json::to_vec(&value).unwrap()).unwrap();
                }
                "null_turn_count" | "materialized_partial_events" => {
                    let mut value: serde_json::Value =
                        serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
                    value["turn_count"] = if fault == "null_turn_count" {
                        serde_json::Value::Null
                    } else {
                        1.into()
                    };
                    fs::write(&metadata, serde_json::to_vec(&value).unwrap()).unwrap();
                    if fault == "materialized_partial_events" {
                        fs::write(
                            session.session_dir.join("events.jsonl"),
                            "{\"event\":\"session:sta",
                        )
                        .unwrap();
                    }
                }
                "unreadable_child" => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        fs::set_permissions(&metadata, fs::Permissions::from_mode(0o000)).unwrap();
                    }
                }
                "partial_events" => fs::write(
                    session.session_dir.join("events.jsonl"),
                    "{\"event\":\"session:sta",
                )
                .unwrap(),
                "unknown_events" => {
                    fs::write(session.session_dir.join("events.jsonl"), "{}\n").unwrap()
                }
                "missing_transcript" => {
                    fs::remove_file(session.session_dir.join("transcript.jsonl")).unwrap()
                }
                "extra_child" => {
                    fs::write(session.session_dir.join("uninspected"), "retained").unwrap()
                }
                "child_symlink" => {
                    fs::remove_file(&metadata).unwrap();
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(home.path().join("missing"), &metadata).unwrap();
                }
                _ => unreachable!(),
            }
            let spec = resume_spec_for_test("amplifier", "amp-exact-session", home.path());
            assert!(
                matches!(
                    probe_provider_store(home.path(), &spec),
                    ProviderStoreProbe::Blocked { .. }
                ),
                "{fault}: incomplete stub cannot certify absence"
            );
            assert!(session.session_dir.is_dir());
        }
    }

    #[test]
    fn amplifier_other_candidate_identity_must_be_resolved_before_absence() {
        let home = tempfile::tempdir().unwrap();
        let workspace = home.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let other = freshell_sessions::amplifier_stub::ensure_session(
            &home.path().join(".amplifier"),
            "other-session",
            workspace.to_str().unwrap(),
            "terminal",
        )
        .unwrap();
        fs::write(other.session_dir.join("metadata.json"), "{}").unwrap();
        let spec = resume_spec_for_test("amplifier", "saved-exact-root", home.path());
        assert!(
            matches!(
                probe_provider_store(home.path(), &spec),
                ProviderStoreProbe::Blocked { .. }
            ),
            "an identity-incomplete candidate cannot exclude the requested exact Amplifier root"
        );
        assert!(other.session_dir.is_dir());
    }

    #[test]
    fn partial_opencode_store_cannot_certify_native_absence() {
        for fault in [
            "partial_schema",
            "unqualified_migrations",
            "retained_history",
            "orphan_wal",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let db = dir.path().join(".local/share/opencode/opencode.db");
            fs::create_dir_all(db.parent().unwrap()).unwrap();
            if fault == "orphan_wal" {
                fs::write(
                    db.with_file_name("opencode.db-wal"),
                    "retained native storage",
                )
                .unwrap();
            } else {
                let connection = Connection::open(&db).unwrap();
                if fault == "partial_schema" {
                    connection
                        .execute("CREATE TABLE session(id TEXT PRIMARY KEY)", [])
                        .unwrap();
                } else {
                    connection
                        .execute_batch(
                            freshell_sessions::opencode_transfer::pinned_destination_schema_sql(),
                        )
                        .unwrap();
                    if fault == "retained_history" {
                        for migration in
                            freshell_sessions::opencode_transfer::pinned_destination_migration_ids()
                        {
                            connection
                                .execute("INSERT INTO migration VALUES (?1,0)", [migration])
                                .unwrap();
                        }
                        connection.execute("INSERT INTO event_sequence(aggregate_id,seq,owner_id) VALUES ('ses_absent',1,'retained')", []).unwrap();
                    }
                }
            }
            let spec = build_resume_spec(ResumeSpecInput {
                provider: "opencode",
                provider_store_id: "store",
                native_session_id: "ses_absent",
                terminal: &terminal("opencode", &[]),
                provider_version: None,
                creation_seed_ref: "seed".into(),
                checkpoint_revision: 0,
                evidence_revision: 1,
                never_dispatched: false,
            })
            .unwrap();
            let probe = probe_provider_store(dir.path(), &spec);
            assert!(
                matches!(probe, ProviderStoreProbe::Blocked { .. }),
                "{fault}: {probe:?}"
            );
        }
    }

    #[test]
    fn native_census_inspection_error_is_unknown_and_exact_absence_remains_negative() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".local/share/opencode");
        fs::create_dir_all(&root).unwrap();
        let db = root.join("opencode.db");
        #[cfg(unix)]
        std::os::unix::fs::symlink("opencode.db", &db).unwrap();
        let spec = build_resume_spec(ResumeSpecInput {
            provider: "opencode",
            provider_store_id: "store",
            native_session_id: "ses_absent",
            terminal: &terminal("opencode", &[]),
            provider_version: None,
            creation_seed_ref: "seed".into(),
            checkpoint_revision: 0,
            evidence_revision: 1,
            never_dispatched: false,
        })
        .unwrap();
        assert!(matches!(
            probe_provider_store(dir.path(), &spec),
            ProviderStoreProbe::Blocked { .. }
        ));
        fs::remove_file(&db).unwrap();
        let connection = Connection::open(&db).unwrap();
        connection
            .execute_batch(freshell_sessions::opencode_transfer::pinned_destination_schema_sql())
            .unwrap();
        for migration in freshell_sessions::opencode_transfer::pinned_destination_migration_ids() {
            connection
                .execute("INSERT INTO migration VALUES (?1,0)", [migration])
                .unwrap();
        }
        connection
            .execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('prj','/synthetic',1,1,'[]')", [])
            .unwrap();
        connection
            .execute("INSERT INTO session(id,slug,project_id,directory,title,version,time_created,time_updated) VALUES ('ses_other','slug','prj','/synthetic','synthetic','1.18.21',1,1)", [])
            .unwrap();
        let probe = probe_provider_store(dir.path(), &spec);
        assert!(
            matches!(
                probe,
                ProviderStoreProbe::DefinitivelyUnavailable {
                    store_state: EvidenceStoreState::PresentReadable,
                    ..
                }
            ),
            "{probe:?}"
        );
        assert!(matches!(
            probe_provider_store(&dir.path().join("missing-mount"), &spec),
            ProviderStoreProbe::Blocked { .. }
        ));
    }

    #[test]
    fn native_fixture_partial_checkpoint_cannot_certify_absence() {
        let dir = tempfile::tempdir().unwrap();
        let checkpoints = dir.path().join(".freshell/checkpoints/native-session");
        fs::create_dir_all(&checkpoints).unwrap();
        fs::write(checkpoints.join("3.json"), vec![b'x'; 1024 * 1024 + 1]).unwrap();
        let mut spec = build_resume_spec(ResumeSpecInput {
            provider: "opencode",
            provider_store_id: "store",
            native_session_id: "fixture-exact",
            terminal: &terminal("opencode", &[]),
            provider_version: None,
            creation_seed_ref: "seed".into(),
            checkpoint_revision: 3,
            evidence_revision: 1,
            never_dispatched: false,
        })
        .unwrap();
        spec.provider_session.provider = "native-session-fixture".into();
        assert!(matches!(
            probe_provider_store(dir.path(), &spec),
            ProviderStoreProbe::Blocked { .. }
        ));
    }

    #[test]
    fn native_census_noncanonical_home_or_root_cannot_certify_absence() {
        for provider in ["claude", "codex", "amplifier"] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join(match provider {
                "claude" => ".claude/projects",
                "codex" => ".codex/sessions",
                _ => ".amplifier/projects",
            });
            fs::create_dir_all(root.parent().unwrap()).unwrap();
            fs::write(&root, "incomplete store representation").unwrap();
            let spec = build_resume_spec(ResumeSpecInput {
                provider,
                provider_store_id: "store",
                native_session_id: "saved-exact-root",
                terminal: &terminal(provider, &[]),
                provider_version: None,
                creation_seed_ref: "seed".into(),
                checkpoint_revision: 0,
                evidence_revision: 1,
                never_dispatched: false,
            })
            .unwrap();
            assert!(
                matches!(
                    probe_provider_store(dir.path(), &spec),
                    ProviderStoreProbe::Blocked { .. }
                ),
                "{provider}: non-directory store is unknown"
            );
        }
        #[cfg(unix)]
        {
            let dir = tempfile::tempdir().unwrap();
            let home = dir.path().join("linked-home");
            std::os::unix::fs::symlink(dir.path(), &home).unwrap();
            let spec = build_resume_spec(ResumeSpecInput {
                provider: "opencode",
                provider_store_id: "store",
                native_session_id: "ses_exact",
                terminal: &terminal("opencode", &[]),
                provider_version: None,
                creation_seed_ref: "seed".into(),
                checkpoint_revision: 0,
                evidence_revision: 1,
                never_dispatched: false,
            })
            .unwrap();
            assert!(matches!(
                probe_provider_store(&home, &spec),
                ProviderStoreProbe::Blocked { .. }
            ));
        }
    }

    #[test]
    fn native_census_cannot_certify_an_uninspected_environment_or_ambiguous_root() {
        for provider in ["claude", "codex", "amplifier", "opencode"] {
            let dir = tempfile::tempdir().unwrap();
            let mut spec = build_resume_spec(ResumeSpecInput {
                provider,
                provider_store_id: "store",
                native_session_id: "saved-exact-root",
                terminal: &terminal(provider, &[]),
                provider_version: None,
                creation_seed_ref: "seed".into(),
                checkpoint_revision: 0,
                evidence_revision: 1,
                never_dispatched: false,
            })
            .unwrap();
            let key = match provider {
                "claude" => "CLAUDE_CONFIG_DIR",
                "codex" => "CODEX_HOME",
                "amplifier" => "AMPLIFIER_HOME",
                _ => "OPENCODE_DB",
            };
            spec.environment
                .insert(key.into(), "/alternate-uninspected-store".into());
            assert!(
                matches!(
                    probe_provider_store(dir.path(), &spec),
                    ProviderStoreProbe::Blocked { .. }
                ),
                "{provider}: alternate environment must stay unknown"
            );
            spec.environment.remove(key);
            if provider == "opencode" {
                continue;
            }
            let root = dir.path().join(match provider {
                "claude" => ".claude/projects",
                "codex" => ".codex/sessions",
                _ => ".amplifier/projects",
            });
            for project in ["one", "two"] {
                let project = root.join(project);
                fs::create_dir_all(&project).unwrap();
                if provider == "amplifier" {
                    fs::create_dir(project.join("saved-exact-root")).unwrap();
                } else {
                    fs::write(project.join("history.jsonl"), "saved-exact-root").unwrap();
                }
            }
            assert!(
                matches!(
                    probe_provider_store(dir.path(), &spec),
                    ProviderStoreProbe::Blocked {
                        reason: RecoveryBlockReason::AmbiguousIdentity,
                        ..
                    }
                ),
                "{provider}: duplicate exact candidates must stay unknown"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn native_census_unreadable_artifacts_cannot_certify_absence() {
        use std::os::unix::{fs::PermissionsExt, process::CommandExt};
        const CHILD_ROOT: &str = "FRESHELL_TEST_NATIVE_CENSUS_UNREADABLE_ROOT";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            for provider in ["claude", "codex", "amplifier", "opencode"] {
                let spec = build_resume_spec(ResumeSpecInput {
                    provider,
                    provider_store_id: "store",
                    native_session_id: "saved-exact-root",
                    terminal: &terminal(provider, &[]),
                    provider_version: None,
                    creation_seed_ref: "seed".into(),
                    checkpoint_revision: 0,
                    evidence_revision: 1,
                    never_dispatched: false,
                })
                .unwrap();
                assert!(
                    matches!(
                        probe_provider_store(Path::new(&root), &spec),
                        ProviderStoreProbe::Blocked { .. }
                    ),
                    "{provider}: unreadable artifact must remain unknown"
                );
            }
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
        let mut unreadable = Vec::new();
        for root in [
            ".claude/projects",
            ".codex/sessions",
            ".amplifier/projects",
            ".local/share/opencode",
        ] {
            let root = dir.path().join(root);
            fs::create_dir_all(&root).unwrap();
            let path = if root.ends_with("projects")
                && root.to_string_lossy().contains(".amplifier")
                || root.ends_with("opencode")
            {
                root
            } else {
                let path = root.join("history.jsonl");
                fs::write(&path, "unreadable retained content").unwrap();
                path
            };
            fs::set_permissions(&path, fs::Permissions::from_mode(0o0)).unwrap();
            unreadable.push(path);
        }
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "tests::native_census_unreadable_artifacts_cannot_certify_absence",
                "--nocapture",
            ])
            .env(CHILD_ROOT, dir.path());
        // Root test runners must inspect as an ordinary workload user too.
        if unsafe { libc::geteuid() } == 0 {
            child.uid(65534).gid(65534);
        }
        let result = child.status().unwrap();
        for path in unreadable {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert!(result.success());
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
            assert_eq!(
                entry["qualificationReady"], capability.qualification_ready,
                "manifest qualification readiness drifted for {}",
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
            opencode_adoption_baseline: None,
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
    fn amplifier_completed_native_store_with_backups_is_ready() {
        let home = tempfile::tempdir().unwrap();
        let cwd = home.path().join("workspace");
        fs::create_dir_all(&cwd).unwrap();
        let expected = "owned-completed-native-root";
        let ensured = freshell_sessions::amplifier_stub::ensure_session(
            &home.path().join(".amplifier"),
            expected,
            cwd.to_str().unwrap(),
            "owned-terminal",
        )
        .unwrap();
        let metadata_path = ensured.session_dir.join("metadata.json");
        let original = fs::read(&metadata_path).unwrap();
        let mut metadata: serde_json::Value = serde_json::from_slice(&original).unwrap();
        metadata["turn_count"] = serde_json::json!(1);
        metadata["model"] = serde_json::json!("glm-5.3");
        fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();
        fs::write(ensured.session_dir.join("metadata.json.backup"), original).unwrap();
        fs::write(ensured.session_dir.join("transcript.jsonl.backup"), b"").unwrap();
        fs::write(ensured.session_dir.join("transcript.jsonl"),
            b"{\"role\":\"user\",\"content\":\"owned seed\"}\n{\"role\":\"assistant\",\"content\":\"stored\"}\n").unwrap();
        let events = [
            "session:resume",
            "prompt:submit",
            "provider:request",
            "llm:request",
            "llm:response",
            "provider:response",
            "orchestrator:complete",
            "cleanup:store_end",
        ]
        .into_iter()
        .map(|event| serde_json::json!({"event":event,"session_id":expected}).to_string() + "\n")
        .collect::<String>();
        fs::write(ensured.session_dir.join("events.jsonl"), events).unwrap();
        let spec = resume_spec_for_test("amplifier", expected, home.path());
        assert!(matches!(probe_provider_store(home.path(), &spec), ProviderStoreProbe::Ready { .. }),
            "a completed ordinary native save must not be classified using pristine-stub-only file/event rules");
        let original_files = fs::read_dir(&ensured.session_dir)
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                let bytes = fs::read(&path).unwrap();
                (path, bytes)
            })
            .collect::<Vec<_>>();
        for fault in [
            "wrong-metadata-root",
            "wrong-event-root",
            "truncated-transcript",
            "partial-events",
            "corrupt-backup",
            "unknown-child",
        ] {
            for (path, bytes) in &original_files {
                fs::write(path, bytes).unwrap();
            }
            match fault {
                "wrong-metadata-root" => {
                    let mut wrong = metadata.clone(); wrong["session_id"] = "another-root".into();
                    fs::write(&metadata_path, serde_json::to_vec(&wrong).unwrap()).unwrap();
                }
                "wrong-event-root" => fs::write(ensured.session_dir.join("events.jsonl"),
                    b"{\"event\":\"llm:response\",\"session_id\":\"another-root\"}\n").unwrap(),
                "truncated-transcript" => fs::write(ensured.session_dir.join("transcript.jsonl"),
                    b"{\"role\":\"user\",\"content\":\"seed\"}\n{\"role\":\"assistant\",\"content\":\"stored\"}").unwrap(),
                "partial-events" => fs::write(ensured.session_dir.join("events.jsonl"), b"{\"event\":").unwrap(),
                "corrupt-backup" => fs::write(ensured.session_dir.join("metadata.json.backup"), b"null").unwrap(),
                "unknown-child" => fs::write(ensured.session_dir.join("uninspected"), b"retained").unwrap(),
                _ => unreachable!(),
            }
            assert!(
                matches!(
                    probe_provider_store(home.path(), &spec),
                    ProviderStoreProbe::Blocked { .. }
                ),
                "{fault}"
            );
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

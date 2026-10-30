//! Provider-independent recovery policy plus provider-specific resume adapters.
//!
//! This crate is intentionally unable to spawn or kill a process.  It turns
//! durable identity/evidence into an exact launch specification and classifies
//! soul-local provider stores.  The supervisor retains lifecycle authority and
//! the session host is the only component allowed to execute provider code.

use freshell_runtime_protocol::{
    AllocationState, DurablePosition, EvidenceStoreState, IdentityProvenance, ProviderSessionRef,
    RecoveryBlockReason, RecoveryEvidenceVerdict, RecoveryPath, RecoveryPathEvidence,
    RecoveryProbe, ResumeSpec, RetryHint, RuntimeError, RuntimeErrorCode, TerminalLaunchSpec,
    RESUME_SPEC_SCHEMA_VERSION,
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    io::{BufRead, BufReader, Read},
    path::Path,
};

mod provider_inventory;
pub use provider_inventory::{pinned_fresh_provider_version, pinned_provider_version};
mod qualification_policy;
pub use qualification_policy::{
    process_qualification_policy, qualification_managed_provider_enabled,
    qualification_policy_from_value, QualificationPolicy, QUALIFICATION_PROVIDER_ENV,
};
pub mod host_actor;
pub mod opencode_transfer;
pub mod snapshot_projection;
pub mod snapshot_text;
pub use freshell_runtime_protocol::{ClaudeForkRecipe, ClaudeForkTarget};

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

const NATIVE_STORE_ENVIRONMENT: &[&str] = &[
    "HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "AMPLIFIER_HOME",
    "XDG_DATA_HOME",
    "OPENCODE_DB",
    "OPENCODE_DISABLE_CHANNEL_DB",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeStoreSelection {
    cwd: String,
    provider_version: Option<String>,
    environment: BTreeMap<String, String>,
}
impl NativeStoreSelection {
    fn from_spec(spec: &ResumeSpec) -> Self {
        Self {
            cwd: spec.cwd.clone(),
            provider_version: spec.provider_version.clone(),
            environment: spec
                .environment
                .iter()
                .filter(|(name, _)| NATIVE_STORE_ENVIRONMENT.contains(&name.as_str()))
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
        }
    }
    fn fingerprint(&self, provider_home: &str) -> String {
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(provider_home, self)).expect("store selection serializes")
            )
        )
    }
    fn valid(&self) -> bool {
        self.environment
            .keys()
            .all(|name| NATIVE_STORE_ENVIRONMENT.contains(&name.as_str()))
    }
}

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
    selection: NativeStoreSelection,
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
    NativeStoreSelection::from_spec(spec).fingerprint(&spec.provider_home)
}

pub fn native_absence_census_environment_matches(spec: &ResumeSpec, evidence: &[String]) -> bool {
    native_census(evidence).is_some_and(|census| {
        census.provider_home == spec.provider_home
            && census.selection == NativeStoreSelection::from_spec(spec)
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
    census.selection.valid()
        && census.environment_fingerprint == census.selection.fingerprint(&census.provider_home)
        && census.provider == provider
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
        if !census.selection.valid()
            || census.environment_fingerprint != census.selection.fingerprint(&census.provider_home)
        { return false; }
        let home = Path::new(&census.inspected_home);
        let before = native_store_generation(home, &census.provider, &census.selection).ok();
        before.as_deref() == Some(&census.generation)
            && matches!(probe_selected_provider_identity(home, &census.provider, &census.native_id, &census.selection),
                ProviderStoreProbe::DefinitivelyUnavailable { store_state, .. } if store_state == census.store_state)
            && native_store_generation(home, &census.provider, &census.selection).ok() == before
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

fn native_store_roots(
    home: &Path,
    provider: &str,
    selection: &NativeStoreSelection,
) -> Result<Vec<std::path::PathBuf>, ProviderStoreProbe> {
    let roots = match provider {
        "claude" | "kilroy" => vec![selection
            .environment
            .get("CLAUDE_CONFIG_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"))
            .join("projects")],
        "codex" => vec![selection
            .environment
            .get("CODEX_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"))
            .join("sessions")],
        "amplifier" => vec![home.join(".amplifier/projects")],
        "opencode" => {
            let (path, _) = selected_opencode_database(home, selection)?;
            let mut roots = vec![path.clone()];
            for suffix in ["-wal", "-shm", "-journal"] {
                let mut companion = path.as_os_str().to_os_string();
                companion.push(suffix);
                roots.push(companion.into());
            }
            roots
        }
        "phase1-fixture" | "native-session-fixture" => vec![home.to_path_buf()],
        _ => {
            return Err(blocked(
                RecoveryBlockReason::ImplementationUnavailable,
                "native storage selection is unavailable",
                Vec::new(),
                None,
            ))
        }
    };
    Ok(roots)
}

/// Exact nonsecret paths the owned native reader must be able to inspect.
pub fn native_store_paths(
    home: &Path,
    spec: &ResumeSpec,
) -> Result<Vec<std::path::PathBuf>, ProviderStoreProbe> {
    native_store_roots(
        home,
        &spec.provider_session.provider,
        &NativeStoreSelection::from_spec(spec),
    )
}

fn native_store_generation(
    home: &Path,
    provider: &str,
    selection: &NativeStoreSelection,
) -> Result<String, ()> {
    let canonical = fs::canonicalize(home).map_err(|_| ())?;
    if canonical != home {
        return Err(());
    }
    let roots = native_store_roots(home, provider, selection).map_err(|_| ())?;
    for root in &roots {
        if !root.is_absolute() {
            return Err(());
        }
        inspect_native_path(home, root).map_err(|_| ())?;
    }
    let mut hash = Sha256::new();
    hash.update(b"freshell-native-store-generation-v2\0");
    let mut queue = roots
        .into_iter()
        .map(|root| (root, 0_u8))
        .collect::<VecDeque<_>>();
    let mut visited = 0_usize;
    let mut total_bytes = 0_u64;
    while let Some((path, depth)) = queue.pop_front() {
        visited += 1;
        if visited > 50_000 || depth > 8 {
            return Err(());
        }
        hash.update(path.as_os_str().as_encoded_bytes());
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

/// Source policy for admitting a provider's durable-soul candidate routing.
///
/// This is deliberately a separate axis from `managed_enabled`: deterministic
/// implementation support can exist and be unit-tested long before a real
/// provider turn has ever been observed. `Certified` enables the intended
/// production route in this unverified candidate. Public release still needs
/// current native receipts and final checks; source flags are not that proof.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CertificationState {
    /// Intended production routing; current candidate-bound proof is required.
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

/// The runtime-side candidate policy. Source flags are not native verification;
/// release still requires current candidate-bound evidence. The checked-in JSON capability
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
        certification_state: CertificationState::Certified,
        qualification_ready: true,
        managed_enabled: true,
        durable_recovery_enabled: true,
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
        blocked_reason: None,
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
        certification_state: CertificationState::Certified,
        qualification_ready: true,
        managed_enabled: true,
        durable_recovery_enabled: true,
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
        blocked_reason: None,
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
    ParentBackedClaudeFork {
        evidence: Vec<String>,
    },
    Ready {
        evidence: Vec<String>,
    },
    DefinitivelyUnavailable {
        reason: String,
        evidence: Vec<String>,
        store_state: EvidenceStoreState,
        #[serde(default)]
        negative_paths: Vec<RecoveryPathEvidence>,
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

/// Native fresh transports retained by the repair. This admission boundary
/// does not certify their recovery or enable a release promise.
pub fn managed_native_fresh_agent_enabled(
    provider: &freshell_runtime_protocol::FreshProvider,
    session_type: &str,
) -> bool {
    use freshell_runtime_protocol::FreshProvider;
    matches!(
        (provider, session_type),
        (FreshProvider::Claude, "freshclaude")
            | (FreshProvider::Codex, "freshcodex")
            | (FreshProvider::Opencode, "freshopencode")
    )
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
        claude_fork: None,
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
    match fs::symlink_metadata(provider_home) {
        Ok(metadata) if metadata.is_dir() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return blocked(
                RecoveryBlockReason::StoreMissing,
                "soul provider-state mount is unavailable",
                vec![provider_home.display().to_string()],
                Some("restore the soul provider-state volume"),
            )
        }
        _ => {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                "soul provider-state mount cannot be inspected",
                vec![provider_home.display().to_string()],
                Some("repair the soul provider-state volume"),
            )
        }
    }
    let expected = spec.provider_session.native_session_id.as_str();
    if expected.trim().is_empty() {
        return blocked(
            RecoveryBlockReason::AmbiguousIdentity,
            "native identity is unrecorded",
            vec![provider_home.display().to_string()],
            None,
        );
    }
    if spec.provider_session.provider == "amplifier"
        && spec
            .environment
            .get("AMPLIFIER_HOME")
            .is_some_and(|selected| selected != &format!("{}/.amplifier", spec.provider_home))
    {
        return blocked(
            RecoveryBlockReason::StoreUnreadable,
            "selected provider environment points to an uninspected store",
            Vec::new(),
            None,
        );
    }
    if spec
        .environment
        .get("HOME")
        .is_some_and(|home| home != &spec.provider_home)
    {
        return blocked(
            RecoveryBlockReason::StoreUnreadable,
            "recorded provider HOME differs from the inspected store",
            Vec::new(),
            None,
        );
    }
    let selection = NativeStoreSelection::from_spec(spec);
    let mut result = probe_selected_provider_store(provider_home, spec);
    let captured_result = result.clone();
    if let ProviderStoreProbe::DefinitivelyUnavailable {
        evidence,
        store_state,
        negative_paths,
        ..
    } = &mut result
    {
        let generation_before =
            native_store_generation(provider_home, &spec.provider_session.provider, &selection);
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
            native_store_generation(provider_home, &spec.provider_session.provider, &selection);
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
            selection,
            inspected_home: provider_home.display().to_string(),
            generation: after,
            store_state: *store_state,
        };
        let reference = format!(
            "{NATIVE_CENSUS_PREFIX}{}",
            serde_json::to_string(&census).expect("census serializes")
        );
        evidence.push(reference.clone());
        for row in negative_paths.iter_mut().filter(|row| {
            row.path == RecoveryPath::NativeResume
                && row.verdict == RecoveryEvidenceVerdict::DefinitiveNegative
        }) {
            row.evidence_refs.push(reference.clone());
        }
    }
    result
}

fn probe_selected_provider_store(provider_home: &Path, spec: &ResumeSpec) -> ProviderStoreProbe {
    let Some(recipe) = spec.claude_fork.as_ref() else {
        return probe_selected_provider_identity(
            provider_home,
            &spec.provider_session.provider,
            &spec.provider_session.native_session_id,
            &NativeStoreSelection::from_spec(spec),
        );
    };
    if !matches!(spec.provider_session.provider.as_str(), "claude" | "kilroy")
        || !matches!(spec.mode.as_str(), "freshclaude" | "kilroy")
        || recipe
            .validate(&spec.provider_session.native_session_id)
            .is_err()
    {
        return blocked(
            RecoveryBlockReason::StoreUnreadable,
            "Claude fork recipe is not current",
            Vec::new(),
            None,
        );
    }
    // A present child always owns recovery. Never hide partial/corrupt child
    // state behind an older parent prefix after a possibly accepted input.
    match inspect_native_path(provider_home, &provider_home.join(&recipe.child_transcript)) {
        Ok(true) => {
            let current =
                read_stable_claude_transcript(&provider_home.join(&recipe.child_transcript));
            let valid_child = current.as_ref().is_ok_and(|content| {
                let messages: Vec<_> = content
                    .lines()
                    .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                    .filter(|row| matches!(row["type"].as_str(), Some("user" | "assistant")))
                    .collect();
                !messages.is_empty()
                    && messages
                        .iter()
                        .all(|row| row["sessionId"] == recipe.child_session_id)
            });
            if !valid_child {
                return blocked(
                    RecoveryBlockReason::StoreUnreadable,
                    "Claude child transcript is unreadable",
                    Vec::new(),
                    None,
                );
            }
            return ProviderStoreProbe::Ready {
                evidence: vec!["native Claude child transcript identity verified".into()],
            };
        }
        Err(probe) => return probe,
        Ok(false) => {}
    }
    // This is positive proof of a current, explicitly observed fork's source.
    // Native companion records need not certify any other session's absence.
    // Keep the ordinary store census separate, including all of its blockers.
    if recipe.recovery_disabled {
        return blocked(RecoveryBlockReason::StoreUnreadable,
            "Claude child history has not materialized after a possibly accepted effect; parent-prefix recovery is disabled", Vec::new(), None);
    }
    match read_verified_claude_fork_parent(provider_home, recipe) {
        Ok(_) => ProviderStoreProbe::ParentBackedClaudeFork {
            evidence: vec!["native Claude fork is recoverable from its verified parent prefix; child transcript not materialized".into()],
        },
        Err(_) => blocked(RecoveryBlockReason::StoreUnreadable, "Claude fork parent/cutoff could not be verified", Vec::new(), None),
    }
}

fn read_stable_claude_transcript(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let file = fs::File::open(path).map_err(|_| "Claude transcript unavailable")?;
    let before = file
        .metadata()
        .map_err(|_| "Claude transcript metadata unavailable")?;
    if !before.is_file() || before.len() == 0 {
        return Err("Claude transcript is not a complete file".into());
    }
    let mut bytes = Vec::new();
    (&file)
        .take(before.len().saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| "Claude transcript read failed")?;
    let after = file
        .metadata()
        .map_err(|_| "Claude transcript metadata unavailable")?;
    let current = fs::metadata(path).map_err(|_| "Claude transcript path changed")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let stamp = |m: &fs::Metadata| {
            (
                m.dev(),
                m.ino(),
                m.len(),
                m.mtime(),
                m.mtime_nsec(),
                m.ctime(),
                m.ctime_nsec(),
            )
        };
        if stamp(&before) != stamp(&after) || stamp(&after) != stamp(&current) {
            return Err("Claude transcript changed".into());
        }
    }
    if bytes.len() as u64 != before.len()
        || after.len() != current.len()
        || bytes.last() != Some(&b'\n')
    {
        return Err("Claude transcript changed or has incomplete EOF".into());
    }
    let content = String::from_utf8(bytes).map_err(|_| "Claude transcript is not UTF-8")?;
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        serde_json::from_str::<serde_json::Value>(line)
            .map_err(|_| "Claude transcript is incomplete")?;
    }
    Ok(content)
}

/// Called only inside the existing provider-UID reader. This returns private
/// source bytes; callers must never put them in probe evidence or shared logs.
pub fn read_verified_claude_fork_parent(
    home: &Path,
    recipe: &ClaudeForkRecipe,
) -> Result<String, String> {
    recipe.validate(&recipe.child_session_id)?;
    if recipe.recovery_disabled {
        return Err("Claude fork recovery was disabled before effect dispatch".into());
    }
    let path = home.join(&recipe.parent_transcript);
    if inspect_native_path(home, &path).ok() != Some(true) {
        return Err("Claude fork parent unavailable".into());
    }
    let content = read_stable_claude_transcript(&path)?;
    if hex::encode(Sha256::digest(content.as_bytes())) != recipe.parent_sha256 {
        return Err("Claude fork parent changed".into());
    }
    let rows = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(serde_json::from_str::<serde_json::Value>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Claude fork parent invalid")?;
    if !rows
        .iter()
        .any(|row| row["sessionId"] == recipe.parent_session_id)
        || rows.iter().any(|row| {
            matches!(row["type"].as_str(), Some("user" | "assistant"))
                && row["sessionId"] != recipe.parent_session_id
        })
    {
        return Err("Claude fork parent identity changed".into());
    }
    let candidates: Vec<_> = rows
        .iter()
        .filter(|row| {
            row["uuid"].as_str().is_some_and(|id| !id.is_empty())
                && !matches!(
                    row["type"].as_str(),
                    Some("mode" | "atis-latch" | "queue-operation" | "last-prompt")
                )
        })
        .collect();
    let mut chain = Vec::new();
    let mut current = candidates.last().copied();
    while let Some(row) = current {
        let id = row["uuid"].as_str().unwrap();
        if chain
            .iter()
            .any(|item: &&serde_json::Value| item["uuid"] == id)
        {
            return Err("Claude fork parent cycle".into());
        }
        chain.push(row);
        current = row["parentUuid"].as_str().and_then(|parent| {
            candidates
                .iter()
                .rev()
                .copied()
                .find(|row| row["uuid"] == parent)
        });
    }
    chain.reverse();
    match &recipe.target {
        ClaudeForkTarget::Empty if !chain.is_empty() => {}
        ClaudeForkTarget::Prefix {
            cutoff_uuid,
            drop_turn_uuid,
        } => {
            let index = chain
                .iter()
                .position(|row| row["uuid"] == *cutoff_uuid)
                .ok_or("Claude fork cutoff missing")?;
            if drop_turn_uuid
                .as_ref()
                .is_some_and(|guard| chain.get(index + 1).is_none_or(|row| row["uuid"] != *guard))
            {
                return Err("Claude fork drop-turn guard changed".into());
            }
        }
        _ => return Err("Claude fork parent has no native chain".into()),
    }
    Ok(content)
}

fn probe_selected_provider_identity(
    provider_home: &Path,
    provider: &str,
    expected: &str,
    selection: &NativeStoreSelection,
) -> ProviderStoreProbe {
    match provider {
        "phase1-fixture" | "native-session-fixture" => {
            probe_native_fixture(provider_home, expected)
        }
        "claude" | "kilroy" => probe_bounded_tree(
            &selection
                .environment
                .get("CLAUDE_CONFIG_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| provider_home.join(".claude"))
                .join("projects"),
            expected,
            provider,
        ),
        "codex" => probe_bounded_tree(
            &selection
                .environment
                .get("CODEX_HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| provider_home.join(".codex"))
                .join("sessions"),
            expected,
            provider,
        ),
        "amplifier" => probe_amplifier(provider_home, expected),
        "opencode" => probe_opencode(provider_home, expected, selection),
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
    match fs::symlink_metadata(&path) {
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= 1024 * 1024 => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return probe_native_fixture_checkpoint(provider_home, expected, &path)
        }
        _ => {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                "native fixture state cannot be completely inspected",
                vec![path.display().to_string()],
                None,
            )
        }
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
    if let Err(probe) = inspect_native_path(provider_home, &directory) {
        return probe;
    }
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return native_fixture_absence(primary_path, &directory, EvidenceStoreState::Missing)
        }
        _ => {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                "native fixture checkpoint directory cannot be inspected",
                vec![directory.display().to_string()],
                None,
            )
        }
    }
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return native_fixture_absence(primary_path, &directory, EvidenceStoreState::Missing);
        }
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
    for (index, entry) in entries.enumerate() {
        if index >= 50_000 {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                "native fixture checkpoint directory exceeds the inspection bound",
                vec![directory.display().to_string()],
                None,
            );
        }
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
        let revision = path
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(|value| value.parse::<u64>().ok());
        if revision.is_some() && (!metadata.is_file() || metadata.len() > 1024 * 1024) {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                "native fixture checkpoint cannot be completely inspected",
                vec![path.display().to_string()],
                None,
            );
        }
        if !metadata.is_file() {
            continue;
        }
        if let Some(revision) = revision {
            candidates.push((revision, path));
        }
    }
    candidates.sort_by_key(|(revision, _)| *revision);
    let Some((revision, path)) = candidates.pop() else {
        return native_fixture_absence(
            primary_path,
            &directory,
            EvidenceStoreState::PresentReadable,
        );
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

fn inspected_absence(
    reason: String,
    evidence: Vec<String>,
    store_state: EvidenceStoreState,
    paths: &[RecoveryPath],
) -> ProviderStoreProbe {
    let negative_paths = paths
        .iter()
        .map(|path| RecoveryPathEvidence {
            path: *path,
            verdict: RecoveryEvidenceVerdict::DefinitiveNegative,
            reason_code: "INSPECTED_PROVIDER_STORE_ABSENCE".into(),
            evidence_refs: evidence.clone(),
            store_state,
        })
        .collect();
    ProviderStoreProbe::DefinitivelyUnavailable {
        reason,
        evidence,
        store_state,
        negative_paths,
    }
}

fn native_fixture_absence(
    primary: &Path,
    checkpoints: &Path,
    checkpoint_state: EvidenceStoreState,
) -> ProviderStoreProbe {
    let mut result = inspected_absence(
        "native fixture state and numeric checkpoints are absent".into(),
        vec![
            primary.display().to_string(),
            checkpoints.display().to_string(),
        ],
        EvidenceStoreState::Missing,
        &[RecoveryPath::NativeResume, RecoveryPath::CheckpointRestore],
    );
    if let ProviderStoreProbe::DefinitivelyUnavailable { negative_paths, .. } = &mut result {
        negative_paths[0].evidence_refs = vec![primary.display().to_string()];
        negative_paths[1].evidence_refs = vec![checkpoints.display().to_string()];
        negative_paths[1].store_state = checkpoint_state;
    }
    result
}

// Inspect the selected path's ancestors before treating absence as evidence.
// Configured absolute stores may be outside the default provider HOME.
fn inspect_native_path(provider_home: &Path, path: &Path) -> Result<bool, ProviderStoreProbe> {
    let (mut current, relative) = if let Ok(relative) = path.strip_prefix(provider_home) {
        (provider_home.to_path_buf(), relative)
    } else if path.is_absolute() {
        (std::path::PathBuf::new(), path)
    } else {
        return Err(blocked(
            RecoveryBlockReason::StoreUnreadable,
            "selected provider store has no established absolute root",
            Vec::new(),
            None,
        ));
    };
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

fn selected_opencode_database(
    provider_home: &Path,
    selection: &NativeStoreSelection,
) -> Result<(std::path::PathBuf, bool), ProviderStoreProbe> {
    // OpenCode v1.18's relative OPENCODE_DB is relative to its XDG data
    // directory. Channel is compiled into the executable, not an environment
    // override; an explicit DB or disabled channel DB establishes its authority.
    let data = selection
        .environment
        .get("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| provider_home.join(".local/share"))
        .join("opencode");
    let explicit_db = selection
        .environment
        .get("OPENCODE_DB")
        .filter(|value| !value.is_empty());
    let channel_disabled = selection
        .environment
        .get("OPENCODE_DISABLE_CHANNEL_DB")
        .is_some_and(|value| value == "1" || value == "true");
    if explicit_db.is_some_and(|value| value == ":memory:") {
        return Err(blocked(
            RecoveryBlockReason::AmbiguousIdentity,
            "OpenCode in-memory database is unavailable for durable inspection",
            vec!["database=:memory:".into()],
            None,
        ));
    }
    let path = explicit_db
        .map(|value| {
            let path = std::path::PathBuf::from(value);
            if path.is_absolute() {
                path
            } else {
                data.join(path)
            }
        })
        .unwrap_or_else(|| data.join("opencode.db"));
    let path = if path.is_absolute() {
        path
    } else if Path::new(&selection.cwd).is_absolute() {
        Path::new(&selection.cwd).join(path)
    } else {
        return Err(blocked(
            RecoveryBlockReason::AmbiguousIdentity,
            "OpenCode relative database root requires a recorded absolute provider cwd",
            vec!["providerCwd=unestablished".into()],
            None,
        ));
    };
    let authoritative = explicit_db.is_some() || channel_disabled;
    if !authoritative
        && selection
            .provider_version
            .as_deref()
            .is_some_and(|version| version.contains('-'))
    {
        return Err(blocked(
            RecoveryBlockReason::AmbiguousIdentity,
            "OpenCode channel database is unrecorded",
            vec![data.display().to_string()],
            None,
        ));
    }
    Ok((path, authoritative))
}

fn probe_opencode(
    provider_home: &Path,
    expected: &str,
    selection: &NativeStoreSelection,
) -> ProviderStoreProbe {
    let (path, authoritative) = match selected_opencode_database(provider_home, selection) {
        Ok(selected) => selected,
        Err(probe) => return probe,
    };
    let present = match inspect_native_path(provider_home, &path) {
        Ok(present) => present,
        Err(probe) => return probe,
    };
    if !present {
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut companion = path.as_os_str().to_os_string();
            companion.push(suffix);
            match inspect_native_path(provider_home, Path::new(&companion)) {
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
    }
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && authoritative => {
            return inspected_absence(
                "OpenCode effective session database is absent".into(),
                vec![path.display().to_string()],
                EvidenceStoreState::Missing,
                &[RecoveryPath::NativeResume, RecoveryPath::CheckpointRestore],
            );
        }
        _ => {
            return blocked(
                RecoveryBlockReason::StoreUnreadable,
                "OpenCode effective database cannot be established and inspected",
                vec![path.display().to_string()],
                None,
            )
        }
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
        Ok(false) if authoritative => {
            let census = path.canonicalize().ok().and_then(|canonical| {
                let source_store =
                    hex::encode(Sha256::digest(canonical.to_string_lossy().as_bytes()));
                freshell_sessions::opencode_transfer::HostOpenCodeInventory::new(canonical)
                    .inspect_exact_origin(&source_store, expected)
                    .ok()
            });
            match census {
                Some(census) if !census.available() => inspected_absence(
                    format!("qualified OpenCode database has no exact session row or retained references for {expected}"),
                    vec![path.display().to_string(), format!("nativeStoreCensus=sha256:{}", census.inventory_fingerprint())],
                    EvidenceStoreState::PresentReadable,
                    &[RecoveryPath::NativeResume, RecoveryPath::CheckpointRestore]),
                _ => blocked(RecoveryBlockReason::StoreUnreadable,
                    "exact OpenCode store census is incomplete or unqualified",
                    vec![path.display().to_string()], None),
            }
        }
        Ok(false) => blocked(
            RecoveryBlockReason::AmbiguousIdentity,
            "OpenCode effective channel database is unrecorded; default no-match is not absence",
            vec![path.display().to_string()],
            None,
        ),
        Err(error) => blocked(
            RecoveryBlockReason::UnsupportedProtocol,
            &format!("query OpenCode session database: {error}"),
            vec![path.display().to_string()],
            Some("install the pinned compatible OpenCode runtime"),
        ),
    }
}

fn probe_amplifier(provider_home: &Path, expected: &str) -> ProviderStoreProbe {
    const MAX_INSPECTED_METADATA_BYTES: u64 = 1024 * 1024;

    let root = provider_home.join(".amplifier/projects");
    if let Err(probe) = inspect_native_path(provider_home, &root) {
        return probe;
    }
    // This tree alone does not establish all effective Amplifier stores.
    // Exact readable positives are usable; an unrecorded store is unknown.
    let mut incomplete = false;
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
            incomplete = true;
            continue;
        }
        if !metadata.is_dir() {
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
            incomplete = true;
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
        [] => blocked(
            RecoveryBlockReason::AmbiguousIdentity,
            "Amplifier native/checkpoint store authority is incomplete",
            vec![root.display().to_string()],
            None,
        ),
        [session_dir] => {
            let entries = match fs::read_dir(session_dir) {
                Ok(entries) => entries,
                Err(error) => {
                    return blocked(
                        RecoveryBlockReason::StoreUnreadable,
                        &format!("inspect Amplifier session artifacts: {error}"),
                        vec![session_dir.display().to_string()],
                        None,
                    )
                }
            };
            let mut materialized = false;
            let mut events_scan_incomplete = false;
            let mut identity_recorded = false;
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(error) => {
                        return blocked(
                            RecoveryBlockReason::StoreUnreadable,
                            &format!("inspect Amplifier session entry: {error}"),
                            vec![session_dir.display().to_string()],
                            None,
                        )
                    }
                };
                let path = entry.path();
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if !(name.starts_with("transcript.jsonl")
                    || name.starts_with("metadata.json")
                    || name == "events.jsonl")
                {
                    continue;
                }
                let metadata = match fs::symlink_metadata(&path) {
                    Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                        metadata
                    }
                    _ => {
                        return blocked(
                            RecoveryBlockReason::StoreUnreadable,
                            "Amplifier session artifact cannot be completely inspected",
                            vec![path.display().to_string()],
                            None,
                        )
                    }
                };
                // Metadata carries the bounded identity document. Inspect small
                // histories for corruption; large histories need readability
                // without an unbounded parse.
                let inspection = if name.starts_with("metadata.json")
                    || metadata.len() <= MAX_INSPECTED_METADATA_BYTES
                {
                    if metadata.len() > MAX_INSPECTED_METADATA_BYTES {
                        return blocked(
                            RecoveryBlockReason::StoreUnreadable,
                            "Amplifier session metadata exceeds the bounded identity probe",
                            vec![path.display().to_string()],
                            None,
                        );
                    }
                    let mut bytes = Vec::new();
                    fs::File::open(&path)
                        .and_then(|file| {
                            file.take(MAX_INSPECTED_METADATA_BYTES + 1)
                                .read_to_end(&mut bytes)
                        })
                        .map(|_| bytes)
                } else {
                    fs::File::open(&path)
                        .and_then(|mut file| file.read(&mut [0_u8; 1]))
                        .map(|_| Vec::new())
                };
                let bytes = match inspection {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        return blocked(
                            RecoveryBlockReason::StoreUnreadable,
                            &format!("read Amplifier session artifact: {error}"),
                            vec![path.display().to_string()],
                            None,
                        )
                    }
                };
                if name == "events.jsonl" && metadata.len() <= MAX_INSPECTED_METADATA_BYTES {
                    match qualified_amplifier_events(&bytes, expected) {
                        Some(has_history) => materialized |= has_history,
                        None => {
                            return blocked(
                                RecoveryBlockReason::StoreUnreadable,
                                "Amplifier event history is incomplete or malformed",
                                vec![path.display().to_string()],
                                None,
                            )
                        }
                    }
                }
                if name.starts_with("transcript.jsonl") && metadata.len() > 0 {
                    if metadata.len() <= MAX_INSPECTED_METADATA_BYTES
                        && bytes
                            .split(|byte| *byte == b'\n')
                            .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
                            .any(|line| {
                                !serde_json::from_slice::<serde_json::Value>(line)
                                    .is_ok_and(|row| row.is_object())
                            })
                    {
                        return blocked(
                            RecoveryBlockReason::StoreUnreadable,
                            "Amplifier transcript contains an incomplete or malformed message",
                            vec![path.display().to_string()],
                            None,
                        );
                    }
                    materialized = true;
                }
                if name == "events.jsonl" && metadata.len() > MAX_INSPECTED_METADATA_BYTES {
                    events_scan_incomplete = true;
                }
                if name.starts_with("metadata.json") {
                    if bytes.len() as u64 > MAX_INSPECTED_METADATA_BYTES {
                        return blocked(
                            RecoveryBlockReason::StoreUnreadable,
                            "Amplifier session metadata exceeds the bounded identity probe",
                            vec![path.display().to_string()],
                            None,
                        );
                    }
                    match serde_json::from_slice::<serde_json::Value>(&bytes) {
                        Ok(value) => {
                            if let Some(actual) =
                                value.get("session_id").and_then(serde_json::Value::as_str)
                            {
                                if actual != expected {
                                    return blocked(
                                        RecoveryBlockReason::WrongNativeIdentity,
                                        "Amplifier metadata belongs to another native identity",
                                        vec![path.display().to_string()],
                                        None,
                                    );
                                }
                                identity_recorded = true;
                            }
                            if let Some(turn_count) = value.get("turn_count") {
                                if turn_count.as_u64().is_none_or(|count| count == 0) {
                                    return blocked(
                                        RecoveryBlockReason::StoreUnreadable,
                                        "Amplifier recorded turn count is incomplete",
                                        vec![path.display().to_string()],
                                        None,
                                    );
                                }
                                materialized = true;
                            }
                        }
                        Err(_) => {
                            return blocked(
                                RecoveryBlockReason::StoreUnreadable,
                                "Amplifier session metadata is malformed",
                                vec![path.display().to_string()],
                                None,
                            )
                        }
                    }
                }
            }
            if !identity_recorded {
                return blocked(
                    RecoveryBlockReason::AmbiguousIdentity,
                    "Amplifier native identity is unrecorded in readable metadata",
                    vec![session_dir.display().to_string()],
                    None,
                );
            }
            // The stub predicate scans events for prompt:submit only when no
            // recorded turn or transcript has already established materialization.
            // An oversized unscanned event log cannot prove a pristine stub.
            if !materialized && events_scan_incomplete {
                return blocked(
                    RecoveryBlockReason::AmbiguousIdentity,
                    "Amplifier event history exceeds the bounded pristine-stub inspection",
                    vec![session_dir.join("events.jsonl").display().to_string()],
                    None,
                );
            }
            if !materialized {
                if qualified_amplifier_stub(session_dir, expected) != Some(true) {
                    return blocked(
                        RecoveryBlockReason::StoreUnreadable,
                        "Amplifier exact launcher-stub census is unresolved",
                        vec![session_dir.display().to_string()],
                        None,
                    );
                }
                if incomplete || unresolved_candidates {
                    return blocked(
                        RecoveryBlockReason::AmbiguousIdentity,
                        "Amplifier store scan is incomplete",
                        vec![root.display().to_string()],
                        None,
                    );
                }
                inspected_absence(
                    format!("Amplifier session {expected} is an inspected pristine launcher stub"),
                    vec![session_dir.display().to_string(), "turnCount=0".into()],
                    EvidenceStoreState::PresentReadable,
                    &[RecoveryPath::NativeResume],
                )
            } else {
                ProviderStoreProbe::Ready {
                    evidence: vec![
                        session_dir.display().to_string(),
                        format!("sessionId={expected}"),
                    ],
                }
            }
        }
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

fn probe_bounded_tree(root: &Path, expected: &str, provider: &str) -> ProviderStoreProbe {
    if let Err(probe) = inspect_native_path(Path::new(""), root) {
        return probe;
    }
    if fs::symlink_metadata(root).is_ok_and(|metadata| !metadata.is_dir()) {
        return blocked(
            RecoveryBlockReason::StoreUnreadable,
            "provider store root is not a directory",
            vec![root.display().to_string()],
            None,
        );
    }
    let mut matches = Vec::new();
    let mut unresolved_absence = false;
    let mut first_problem = None;
    let mut queue = VecDeque::from([(root.to_path_buf(), 0_u8)]);
    let mut visited = 0_usize;
    while let Some((path, depth)) = queue.pop_front() {
        visited += 1;
        if visited > 50_000 {
            first_problem.get_or_insert_with(|| {
                blocked(
                    RecoveryBlockReason::AmbiguousIdentity,
                    "provider store exceeded the bounded exact-identity probe",
                    vec![root.display().to_string()],
                    None,
                )
            });
            break;
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && depth == 0 => {
                return inspected_absence(
                    "selected provider native store is absent".into(),
                    vec![root.display().to_string()],
                    EvidenceStoreState::Missing,
                    &[RecoveryPath::NativeResume],
                );
            }
            Err(_) => {
                first_problem.get_or_insert_with(|| {
                    blocked(
                        RecoveryBlockReason::StoreUnreadable,
                        "provider native artifact could not be inspected",
                        vec![path.display().to_string()],
                        None,
                    )
                });
                continue;
            }
        };
        if metadata.file_type().is_symlink() {
            first_problem.get_or_insert_with(|| {
                blocked(
                    RecoveryBlockReason::AmbiguousIdentity,
                    "provider native store contains an unresolved symlink",
                    vec![path.display().to_string()],
                    None,
                )
            });
            continue;
        }
        if metadata.is_dir() {
            if depth >= 8 {
                first_problem.get_or_insert_with(|| {
                    blocked(
                        RecoveryBlockReason::AmbiguousIdentity,
                        "provider native store exceeds the bounded directory inspection",
                        vec![path.display().to_string()],
                        None,
                    )
                });
                continue;
            }
            let entries = match fs::read_dir(&path) {
                Ok(entries) => entries,
                Err(_) => {
                    first_problem.get_or_insert_with(|| {
                        blocked(
                            RecoveryBlockReason::StoreUnreadable,
                            "provider native directory could not be read",
                            vec![path.display().to_string()],
                            None,
                        )
                    });
                    continue;
                }
            };
            for entry in entries {
                match entry {
                    Ok(entry) => queue.push_back((entry.path(), depth + 1)),
                    Err(_) => {
                        first_problem.get_or_insert_with(|| {
                            blocked(
                                RecoveryBlockReason::StoreUnreadable,
                                "provider native directory entry could not be inspected",
                                vec![path.display().to_string()],
                                None,
                            )
                        });
                    }
                }
            }
            continue;
        }
        if !metadata.is_file() {
            first_problem.get_or_insert_with(|| {
                blocked(
                    RecoveryBlockReason::StoreUnreadable,
                    "provider native artifact is not a regular file",
                    vec![path.display().to_string()],
                    None,
                )
            });
            continue;
        }
        if matches!(provider, "claude" | "kilroy")
            && (path
                .extension()
                .is_none_or(|extension| extension != "jsonl")
                || path
                    .parent()
                    .and_then(Path::file_name)
                    .is_some_and(|directory| directory == "subagents"))
        {
            // Native tool output and subagents accompany the primary transcript;
            // subagent records can carry the parent's sessionId. They cannot
            // count as another primary owner or prove the primary is absent.
            unresolved_absence = true;
            continue;
        }
        let (owner, complete) =
            match read_native_rollout_owner(&path, provider, expected) {
                Ok(owner) => owner,
                Err(true) => return blocked(
                    RecoveryBlockReason::StoreUnreadable,
                    "the selected provider native root contains unreadable or conflicting records",
                    vec![path.display().to_string()],
                    None,
                ),
                Err(false) => {
                    first_problem.get_or_insert_with(|| {
                        blocked(
                            RecoveryBlockReason::StoreUnreadable,
                            "provider native artifact has no readable unambiguous owner",
                            vec![path.display().to_string()],
                            None,
                        )
                    });
                    continue;
                }
            };
        unresolved_absence |= !complete;
        if owner == expected {
            matches.push(path.display().to_string());
        }
    }
    matches.sort();
    // A positive belongs to the selected root itself. An unfinished sibling
    // cannot invalidate it, but still prevents proving that a missing root is
    // absent. Continue inspecting readable siblings to detect real duplicates.
    if matches.is_empty() {
        if let Some(problem) = first_problem {
            return problem;
        }
    }
    match matches.len() {
        0 if unresolved_absence => blocked(
            RecoveryBlockReason::StoreUnreadable,
            "provider native history contains companion or incompletely inspected artifacts; exact-root absence is unresolved",
            vec![root.display().to_string()],
            None,
        ),
        0 => inspected_absence(
            "selected provider native store has no matching owner".into(),
            vec![root.display().to_string()],
            EvidenceStoreState::PresentReadable,
            &[RecoveryPath::NativeResume],
        ),
        1 => ProviderStoreProbe::Ready { evidence: matches },
        _ => blocked(
            RecoveryBlockReason::AmbiguousIdentity,
            "provider identity has multiple candidate artifacts",
            matches,
            None,
        ),
    }
}

// An error records whether readable metadata already identified the requested
// root. Corrupt copies of that root cannot be treated as unrelated siblings.
fn read_native_rollout_owner(
    path: &Path,
    provider: &str,
    expected: &str,
) -> Result<(String, bool), bool> {
    const MAX_INSPECTED_BYTES: u64 = 1024 * 1024;
    let file = fs::File::open(path).map_err(|_| false)?;
    let extent = file.metadata().map_err(|_| false)?.len();
    let mut reader = BufReader::new(file.take(extent));
    let mut inspected = 0_u64;
    let mut owner = None;
    let mut index = 0;
    loop {
        // Native bookends can precede the first actual user/image record.
        // Finish that owning record through the captured file extent. Once
        // ownership is known, retain the ordinary small history-prefix scan.
        let limit = if owner.is_none() {
            extent - inspected
        } else {
            MAX_INSPECTED_BYTES
                .saturating_sub(inspected)
                .min(extent - inspected)
        };
        if limit == 0 {
            break;
        }
        let mut line = Vec::new();
        let count = reader
            .by_ref()
            .take(limit)
            .read_until(b'\n', &mut line)
            .map_err(|_| owner.as_deref() == Some(expected))? as u64;
        inspected += count;
        if count == 0 {
            return Err(owner.as_deref() == Some(expected));
        }
        if line.last() != Some(&b'\n') && inspected < extent {
            if count < limit {
                return Err(owner.as_deref() == Some(expected));
            }
            break; // The bounded prefix ended inside a later record.
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let row: serde_json::Value =
            serde_json::from_slice(&line).map_err(|_| owner.as_deref() == Some(expected))?;
        let first_record = index == 0;
        index += 1;
        let identity = if provider == "codex" {
            if row["type"] != "session_meta" {
                if first_record {
                    return Err(false);
                }
                continue;
            }
            // `session_id`, fork ancestry, message text and filenames can all
            // refer to other sessions. Only the native metadata id owns this
            // rollout.
            row.get("payload").and_then(|payload| payload.get("id"))
        } else {
            let Some(role @ ("user" | "assistant")) = row["type"].as_str() else {
                continue;
            };
            if row["message"]["role"] != role || row["message"].get("content").is_none() {
                return Err(owner.as_deref() == Some(expected)
                    || row.get("sessionId").and_then(serde_json::Value::as_str) == Some(expected));
            }
            row.get("sessionId")
        };
        let identity = identity
            .and_then(serde_json::Value::as_str)
            .filter(|identity| !identity.trim().is_empty())
            .ok_or_else(|| owner.as_deref() == Some(expected))?;
        if owner.as_deref().is_some_and(|owner| owner != identity) {
            return Err(owner.as_deref() == Some(expected) || identity == expected);
        }
        owner = Some(identity.to_string());
    }
    owner.map(|owner| (owner, inspected == extent)).ok_or(false)
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
    materialized |= qualified_amplifier_events(events, expected)?;
    Some(!materialized)
}

fn qualified_amplifier_events(bytes: &[u8], expected: &str) -> Option<bool> {
    let mut materialized = false;
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
    {
        let event: serde_json::Value = serde_json::from_slice(line).ok()?;
        match event
            .get("event")
            .and_then(serde_json::Value::as_str)
            .filter(|event| !event.trim().is_empty())?
        {
            "session:start" | "session:end" | "session:resume" => {}
            // Native event names are extensible hook names. Provider/tool and
            // orchestrator activity is ordinary history, not a malformed stub.
            _ => materialized = true,
        }
        if event
            .get("session_id")
            .is_some_and(|id| id.as_str() != Some(expected))
        {
            return None;
        }
    }
    Some(materialized)
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
    fn native_fixture_probe_oversized_or_unreadable_checkpoint_cannot_certify_absence() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".freshell/checkpoints/native-session");
        fs::create_dir_all(&dir).unwrap();
        let file = fs::File::create(dir.join("7.json")).unwrap();
        file.set_len(1024 * 1024 + 1).unwrap();
        assert!(matches!(
            probe_provider_store(
                home.path(),
                &resume_spec_for_test("native-session-fixture", "exact", home.path())
            ),
            ProviderStoreProbe::Blocked { .. }
        ));
    }

    #[test]
    fn recovery_store_opencode_relative_data_root_uses_recorded_provider_cwd() {
        assert_opencode_data_root("relative-data", true);
    }

    #[test]
    fn recovery_store_opencode_empty_data_root_uses_provider_home() {
        assert_opencode_data_root("", false);
    }

    fn assert_opencode_data_root(data_root: &str, relative: bool) {
        let home = tempfile::tempdir().unwrap();
        let cwd = home.path().join("provider-workspace");
        fs::create_dir(&cwd).unwrap();
        let mut spec = resume_spec_for_test("opencode", "exact", home.path());
        spec.cwd = cwd.display().to_string();
        spec.environment
            .insert("XDG_DATA_HOME".into(), data_root.into());
        spec.environment
            .insert("OPENCODE_DB".into(), "selected.db".into());
        let data = if relative {
            cwd.join(data_root)
        } else {
            home.path().join(".local/share")
        };
        let path = data.join("opencode/selected.db");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch(freshell_sessions::opencode_transfer::pinned_destination_schema_sql())
            .unwrap();
        for migration in freshell_sessions::opencode_transfer::pinned_destination_migration_ids() {
            db.execute("INSERT INTO migration VALUES (?1,0)", [migration])
                .unwrap();
        }
        db.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES ('prj','/synthetic',1,1,'[]')", []).unwrap();
        db.execute("INSERT INTO session(id,slug,project_id,directory,title,version,time_created,time_updated) VALUES ('exact','slug','prj','/synthetic','synthetic','1.18.21',1,1)", []).unwrap();
        assert!(
            matches!(
                probe_provider_store(home.path(), &spec),
                ProviderStoreProbe::Ready { .. }
            ),
            "data root {data_root:?}"
        );
        db.execute("DELETE FROM session WHERE id='exact'", [])
            .unwrap();
        let result = probe_provider_store(home.path(), &spec);
        let ProviderStoreProbe::DefinitivelyUnavailable {
            negative_paths,
            store_state,
            ..
        } = result
        else {
            panic!("{result:?}");
        };
        assert_eq!(store_state, EvidenceStoreState::PresentReadable);
        assert_eq!(negative_paths.len(), 2);
        let native = negative_paths
            .iter()
            .find(|row| row.path == RecoveryPath::NativeResume)
            .unwrap();
        assert!(
            native_absence_census_matches(
                "opencode",
                &spec.provider_session.provider_store_id,
                "exact",
                spec.evidence_revision,
                native.store_state,
                &native.evidence_refs,
            ),
            "the path-specific native verdict must retain its qualified current reader receipt"
        );
        assert!(negative_paths.iter().all(|row| row
            .evidence_refs
            .iter()
            .any(|reference| reference == &path.display().to_string())));
        let captured = &native.evidence_refs;
        assert!(native_absence_census_environment_matches(&spec, captured));
        assert!(native_absence_census_current(captured));
        let mut changed = spec.clone();
        changed.cwd = cwd.join("different-workspace").display().to_string();
        assert!(!native_absence_census_environment_matches(
            &changed, captured
        ));
        changed = spec.clone();
        changed
            .environment
            .insert("OPENCODE_DISABLE_CHANNEL_DB".into(), "1".into());
        assert!(!native_absence_census_environment_matches(
            &changed, captured
        ));
        let companion = std::path::PathBuf::from(format!("{}-journal", path.display()));
        fs::write(&companion, "unsettled selected database journal").unwrap();
        assert!(!native_absence_census_current(captured));
        fs::remove_file(companion).unwrap();
        assert!(native_absence_census_current(captured));
        db.execute("INSERT INTO session(id,slug,project_id,directory,title,version,time_created,time_updated) VALUES ('exact','slug','prj','/synthetic','synthetic','1.18.21',1,1)", []).unwrap();
        assert!(!native_absence_census_current(captured));
    }

    #[test]
    fn recovery_store_opencode_custom_database_companions_prevent_absence() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("selected.db");
        let mut spec = resume_spec_for_test("opencode", "exact", home.path());
        spec.environment
            .insert("OPENCODE_DB".into(), path.display().to_string());
        assert!(matches!(
            probe_provider_store(home.path(), &spec),
            ProviderStoreProbe::DefinitivelyUnavailable { .. }
        ));
        for suffix in ["-wal", "-shm", "-journal"] {
            let companion = home.path().join(format!("selected.db{suffix}"));
            fs::write(&companion, b"retained selected database storage").unwrap();
            let result = probe_provider_store(home.path(), &spec);
            assert!(
                matches!(result, ProviderStoreProbe::Blocked { .. }),
                "{suffix}: {result:?}"
            );
            assert_eq!(
                fs::read(&companion).unwrap(),
                b"retained selected database storage"
            );
            fs::remove_file(companion).unwrap();
        }
        assert!(matches!(
            probe_provider_store(home.path(), &spec),
            ProviderStoreProbe::DefinitivelyUnavailable { .. }
        ));
    }

    #[test]
    fn recovery_store_opencode_unresolved_relative_data_root_blocks() {
        let home = tempfile::tempdir().unwrap();
        let mut spec = resume_spec_for_test("opencode", "exact", home.path());
        spec.cwd = "unrecorded-relative-cwd".into();
        spec.environment
            .insert("XDG_DATA_HOME".into(), "unrecorded-relative-data".into());
        spec.environment
            .insert("OPENCODE_DB".into(), "selected.db".into());
        assert!(
            matches!(
                probe_provider_store(home.path(), &spec),
                ProviderStoreProbe::Blocked { .. }
            ),
            "unresolved provider cwd must not authorize probe-cwd absence"
        );
        let path = home.path().join("absolute.db");
        let db = Connection::open(&path).unwrap();
        db.execute("CREATE TABLE session(id TEXT PRIMARY KEY)", [])
            .unwrap();
        db.execute("INSERT INTO session(id) VALUES ('exact')", [])
            .unwrap();
        spec.environment
            .insert("OPENCODE_DB".into(), path.display().to_string());
        assert!(
            matches!(
                probe_provider_store(home.path(), &spec),
                ProviderStoreProbe::Ready { .. }
            ),
            "explicit absolute database remains authoritative"
        );
    }

    #[test]
    fn recovery_store_opencode_resolves_data_and_database_overrides_before_inspection() {
        let home = tempfile::tempdir().unwrap();
        for route in ["xdg", "absolute", "relative", "channel-disabled"] {
            let mut spec = resume_spec_for_test("opencode", "exact", home.path());
            let path = match route {
                "xdg" => {
                    spec.environment.insert(
                        "XDG_DATA_HOME".into(),
                        home.path().join("selected-data").display().to_string(),
                    );
                    home.path().join("selected-data/opencode/opencode.db")
                }
                "absolute" => {
                    let path = home.path().join("selected.db");
                    spec.environment
                        .insert("OPENCODE_DB".into(), path.display().to_string());
                    path
                }
                "relative" => {
                    spec.environment
                        .insert("OPENCODE_DB".into(), "relative.db".into());
                    home.path().join(".local/share/opencode/relative.db")
                }
                "channel-disabled" => {
                    spec.environment
                        .insert("OPENCODE_DISABLE_CHANNEL_DB".into(), "1".into());
                    home.path().join(".local/share/opencode/opencode.db")
                }
                _ => unreachable!(),
            };
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let db = Connection::open(path).unwrap();
            db.execute("CREATE TABLE session(id TEXT PRIMARY KEY)", [])
                .unwrap();
            db.execute("INSERT INTO session(id) VALUES ('exact')", [])
                .unwrap();
            assert!(
                matches!(
                    probe_provider_store(home.path(), &spec),
                    ProviderStoreProbe::Ready { .. }
                ),
                "{route}"
            );
        }
        let mut memory = resume_spec_for_test("opencode", "exact", home.path());
        memory
            .environment
            .insert("OPENCODE_DB".into(), ":memory:".into());
        assert!(matches!(
            probe_provider_store(home.path(), &memory),
            ProviderStoreProbe::Blocked { .. }
        ));
        let mut unknown_channel = resume_spec_for_test("opencode", "absent", home.path());
        unknown_channel.provider_version = Some("0.0.0-preview".into());
        assert!(
            matches!(
                probe_provider_store(home.path(), &unknown_channel),
                ProviderStoreProbe::Blocked { .. }
            ),
            "unrecorded installed channel cannot certify a default-database negative"
        );
    }

    #[test]
    fn recovery_store_large_exact_claude_transcript_remains_ready() {
        assert_large_exact_transcript_ready("claude");
    }

    #[test]
    fn claude_exact_resume_survives_native_tool_and_subagent_companions() {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join(".claude/projects/-workspace");
        let artifacts = project.join("exact");
        fs::create_dir_all(artifacts.join("tool-results")).unwrap();
        fs::create_dir_all(artifacts.join("subagents")).unwrap();
        fs::write(
            project.join("exact.jsonl"),
            native_rollout_for_test("claude", "exact", false),
        )
        .unwrap();
        fs::write(
            artifacts.join("tool-results/toolu_original.txt"),
            "native tool output\n",
        )
        .unwrap();
        fs::write(
            artifacts.join("subagents/agent-child.meta.json"),
            "{\"agentType\":\"Explore\"}",
        )
        .unwrap();
        fs::write(
            artifacts.join("subagents/agent-child.jsonl"),
            native_rollout_for_test("claude", "exact", false),
        )
        .unwrap();
        let spec = resume_spec_for_test("claude", "exact", home.path());
        assert!(matches!(
            probe_provider_store(home.path(), &spec),
            ProviderStoreProbe::Ready { .. }
        ));

        // Companion evidence must not become proof that a missing native root
        // is safe to replace, even if a subagent carries its parent's ID.
        fs::remove_file(project.join("exact.jsonl")).unwrap();
        assert!(matches!(
            probe_provider_store(home.path(), &spec),
            ProviderStoreProbe::Blocked { .. }
        ));
    }

    #[test]
    fn claude_companion_filter_keeps_malformed_native_transcripts_blocked() {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join(".claude/projects/-workspace");
        fs::create_dir_all(project.join("exact/tool-results")).unwrap();
        fs::write(
            project.join("exact/tool-results/toolu_original.txt"),
            "native output",
        )
        .unwrap();
        fs::write(
            project.join("exact.jsonl"),
            "{ incomplete native transcript\n",
        )
        .unwrap();
        assert!(matches!(
            probe_provider_store(
                home.path(),
                &resume_spec_for_test("claude", "exact", home.path())
            ),
            ProviderStoreProbe::Blocked { .. }
        ));
    }

    #[test]
    fn recovery_store_large_exact_codex_transcript_remains_ready() {
        assert_large_exact_transcript_ready("codex");
    }

    fn assert_large_exact_transcript_ready(provider: &str) {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(if provider == "claude" {
            ".claude/projects"
        } else {
            ".codex/sessions"
        });
        fs::create_dir_all(&root).unwrap();
        let path = root.join("exact.jsonl");
        fs::write(&path, native_rollout_for_test(provider, "exact", true)).unwrap();
        let result = probe_provider_store(
            home.path(),
            &resume_spec_for_test(provider, "exact", home.path()),
        );
        match result {
            ProviderStoreProbe::Ready { evidence } => {
                assert_eq!(evidence, vec![path.display().to_string()]);
            }
            other => panic!("readable large {provider} exact transcript must recover: {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn recovery_store_exact_symlink_and_directory_candidates_stay_unknown() {
        use std::os::unix::fs::symlink;

        let home = tempfile::tempdir().unwrap();
        let outside = home.path().join("outside.jsonl");
        fs::write(&outside, br#"{"sessionId":"exact"}"#).unwrap();
        for provider in ["claude", "codex"] {
            let root = home.path().join(if provider == "claude" {
                ".claude/projects"
            } else {
                ".codex/sessions"
            });
            fs::create_dir_all(root.join("exact-directory")).unwrap();
            symlink(&outside, root.join("exact.jsonl")).unwrap();
            assert!(matches!(
                probe_provider_store(
                    home.path(),
                    &resume_spec_for_test(provider, "exact", home.path())
                ),
                ProviderStoreProbe::Blocked {
                    reason: RecoveryBlockReason::AmbiguousIdentity,
                    ..
                }
            ));
        }
    }

    #[test]
    fn recovery_store_large_nonmatching_transcript_content_stays_unknown() {
        let home = tempfile::tempdir().unwrap();
        for provider in ["claude", "codex"] {
            let root = home.path().join(if provider == "claude" {
                ".claude/projects"
            } else {
                ".codex/sessions"
            });
            fs::create_dir_all(&root).unwrap();
            let path = root.join("different.jsonl");
            fs::write(&path, native_rollout_for_test(provider, "another", true)).unwrap();
            assert!(matches!(
                probe_provider_store(
                    home.path(),
                    &resume_spec_for_test(provider, "exact", home.path())
                ),
                ProviderStoreProbe::Blocked {
                    reason: RecoveryBlockReason::StoreUnreadable,
                    ..
                }
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn recovery_store_unreadable_exact_transcripts_block_without_certifying_absence() {
        use std::os::unix::fs::PermissionsExt;

        let home = tempfile::tempdir().unwrap();
        for provider in ["claude", "codex"] {
            let root = home.path().join(if provider == "claude" {
                ".claude/projects"
            } else {
                ".codex/sessions"
            });
            fs::create_dir_all(&root).unwrap();
            let path = root.join("exact.jsonl");
            fs::write(&path, br#"{"sessionId":"exact"}"#).unwrap();
            let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
            for size in [24, 1024 * 1024 + 1] {
                file.set_len(size).unwrap();
                assert_eq!(
                    fs::File::open(&path).unwrap_err().kind(),
                    std::io::ErrorKind::PermissionDenied,
                    "synthetic unreadable fixture requires unprivileged execution"
                );
                assert!(
                    matches!(
                        probe_provider_store(
                            home.path(),
                            &resume_spec_for_test(provider, "exact", home.path())
                        ),
                        ProviderStoreProbe::Blocked {
                            reason: RecoveryBlockReason::StoreUnreadable,
                            ..
                        }
                    ),
                    "{provider} unreadable exact transcript of {size} bytes"
                );
            }
        }
    }

    #[test]
    fn recovery_store_incomplete_scan_blocks_but_exact_positive_survives() {
        let home = tempfile::tempdir().unwrap();
        for provider in ["claude", "codex"] {
            let root = home.path().join(if provider == "claude" {
                ".claude/projects"
            } else {
                ".codex/sessions"
            });
            fs::create_dir_all(&root).unwrap();
            fs::write(
                root.join("oversized.jsonl"),
                native_rollout_for_test(provider, "another", true),
            )
            .unwrap();
            let spec = resume_spec_for_test(provider, "exact", home.path());
            assert!(
                matches!(
                    probe_provider_store(home.path(), &spec),
                    ProviderStoreProbe::Blocked { .. }
                ),
                "{provider}"
            );
            fs::write(
                root.join("exact.jsonl"),
                native_rollout_for_test(provider, "exact", false),
            )
            .unwrap();
            assert!(
                matches!(
                    probe_provider_store(home.path(), &spec),
                    ProviderStoreProbe::Ready { .. }
                ),
                "{provider}"
            );
        }
    }

    #[test]
    fn recovery_store_amplifier_large_primary_transcript_remains_ready() {
        for recorded_turn in [false, true] {
            assert_large_amplifier_artifact_ready("transcript.jsonl", recorded_turn);
        }
    }

    #[test]
    fn recovery_store_amplifier_large_events_with_recorded_turn_remain_ready() {
        assert_large_amplifier_artifact_ready("events.jsonl", true);
    }

    #[test]
    fn recovery_store_amplifier_large_backup_transcripts_remain_ready() {
        for name in ["transcript.jsonl.backup", "transcript.jsonl.bak"] {
            assert_large_amplifier_artifact_ready(name, false);
        }
    }

    fn amplifier_session_fixture(home: &Path, recorded_turn: bool) -> std::path::PathBuf {
        let session = home.join(".amplifier/projects/project/sessions/exact");
        fs::create_dir_all(&session).unwrap();
        let metadata = if recorded_turn {
            br#"{"session_id":"exact","turn_count":1}"#.as_slice()
        } else {
            br#"{"session_id":"exact"}"#.as_slice()
        };
        fs::write(session.join("metadata.json"), metadata).unwrap();
        fs::write(session.join("transcript.jsonl"), b"").unwrap();
        fs::write(session.join("events.jsonl"), b"").unwrap();
        session
    }

    fn assert_large_amplifier_artifact_ready(name: &str, recorded_turn: bool) {
        let home = tempfile::tempdir().unwrap();
        let session = amplifier_session_fixture(home.path(), recorded_turn);
        let path = session.join(name);
        let file = fs::File::create(&path).unwrap();
        file.set_len(1024 * 1024 + 1).unwrap();
        let result = probe_provider_store(
            home.path(),
            &resume_spec_for_test("amplifier", "exact", home.path()),
        );
        match result {
            ProviderStoreProbe::Ready { evidence } => {
                assert_eq!(
                    evidence,
                    vec![session.display().to_string(), "sessionId=exact".into()]
                );
            }
            other => panic!("readable large Amplifier {name} must recover: {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn recovery_store_amplifier_unreadable_artifacts_block_without_absence() {
        use std::os::unix::fs::PermissionsExt;

        for name in [
            "transcript.jsonl",
            "events.jsonl",
            "transcript.jsonl.backup",
        ] {
            let home = tempfile::tempdir().unwrap();
            let session = amplifier_session_fixture(home.path(), true);
            let path = session.join(name);
            let file = fs::File::create(&path).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
            for size in [24, 1024 * 1024 + 1] {
                file.set_len(size).unwrap();
                assert_eq!(
                    fs::File::open(&path).unwrap_err().kind(),
                    std::io::ErrorKind::PermissionDenied,
                    "synthetic unreadable fixture requires unprivileged execution"
                );
                assert!(
                    matches!(
                        probe_provider_store(
                            home.path(),
                            &resume_spec_for_test("amplifier", "exact", home.path())
                        ),
                        ProviderStoreProbe::Blocked {
                            reason: RecoveryBlockReason::StoreUnreadable,
                            ..
                        }
                    ),
                    "unreadable {name} of {size} bytes cannot certify readiness or absence"
                );
            }
        }
    }

    #[test]
    fn recovery_store_amplifier_incomplete_identity_and_events_stay_unknown() {
        for artifact in ["metadata.json", "metadata.json.backup", "events.jsonl"] {
            let home = tempfile::tempdir().unwrap();
            let session = amplifier_session_fixture(home.path(), artifact != "events.jsonl");
            let path = session.join(artifact);
            fs::File::create(&path)
                .unwrap()
                .set_len(1024 * 1024 + 1)
                .unwrap();
            assert!(
                matches!(
                    probe_provider_store(
                        home.path(),
                        &resume_spec_for_test("amplifier", "exact", home.path())
                    ),
                    ProviderStoreProbe::Blocked { .. }
                ),
                "incomplete {artifact} inspection cannot certify readiness or absence"
            );
        }
        for metadata in [
            br#"{"session_id":"wrong","turn_count":1}"#.as_slice(),
            b"{}",
            b"invalid",
        ] {
            let home = tempfile::tempdir().unwrap();
            let session = amplifier_session_fixture(home.path(), true);
            fs::write(session.join("metadata.json"), metadata).unwrap();
            fs::File::create(session.join("transcript.jsonl"))
                .unwrap()
                .set_len(1024 * 1024 + 1)
                .unwrap();
            assert!(
                matches!(
                    probe_provider_store(
                        home.path(),
                        &resume_spec_for_test("amplifier", "exact", home.path())
                    ),
                    ProviderStoreProbe::Blocked { .. }
                ),
                "large readable history does not establish metadata identity"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn recovery_store_amplifier_symlink_and_nonregular_artifacts_stay_unknown() {
        use std::os::unix::fs::symlink;

        for name in [
            "events.jsonl",
            "transcript.jsonl.backup",
            "metadata.json.backup",
        ] {
            for linked in [false, true] {
                let home = tempfile::tempdir().unwrap();
                let session = amplifier_session_fixture(home.path(), true);
                let path = session.join(name);
                if name == "events.jsonl" {
                    fs::remove_file(&path).unwrap();
                }
                if linked {
                    let outside = home.path().join("outside");
                    fs::write(&outside, br#"{"session_id":"exact","turn_count":1}"#).unwrap();
                    symlink(&outside, &path).unwrap();
                } else {
                    fs::create_dir(&path).unwrap();
                }
                assert!(matches!(
                    probe_provider_store(
                        home.path(),
                        &resume_spec_for_test("amplifier", "exact", home.path())
                    ),
                    ProviderStoreProbe::Blocked {
                        reason: RecoveryBlockReason::StoreUnreadable,
                        ..
                    }
                ));
            }
        }
    }

    #[test]
    fn recovery_store_amplifier_backup_transcript_preserves_materialized_session() {
        let home = tempfile::tempdir().unwrap();
        let cwd = home.path().join("workspace");
        fs::create_dir(&cwd).unwrap();
        let session = freshell_sessions::amplifier_stub::ensure_session(
            &home.path().join(".amplifier"),
            "exact",
            cwd.to_str().unwrap(),
            "terminal",
        )
        .unwrap();
        fs::write(
            session.session_dir.join("transcript.jsonl.backup"),
            b"{\"role\":\"assistant\",\"content\":\"synthetic retained turn\"}\n",
        )
        .unwrap();
        assert!(matches!(
            probe_provider_store(
                home.path(),
                &resume_spec_for_test("amplifier", "exact", home.path())
            ),
            ProviderStoreProbe::Ready { .. }
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
    fn native_probe_large_rollouts_remain_ready() {
        let expected = "11111111-2222-3333-4444-555555555555";
        for (provider, mode) in [
            ("codex", "codex"),
            ("codex", "freshcodex"),
            ("claude", "claude"),
            ("kilroy", "kilroy"),
        ] {
            for large_exact in [true, false] {
                let home = tempfile::tempdir().unwrap();
                let root = home.path().join(if provider == "codex" {
                    ".codex/sessions/2026/10/15"
                } else {
                    ".claude/projects/work"
                });
                fs::create_dir_all(&root).unwrap();
                fs::write(
                    root.join("exact.jsonl"),
                    native_rollout_for_test(provider, expected, large_exact),
                )
                .unwrap();
                if !large_exact {
                    fs::write(
                        root.join("other.jsonl"),
                        native_rollout_for_test(
                            provider,
                            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
                            true,
                        ),
                    )
                    .unwrap();
                }
                let mut spec = resume_spec_for_test(provider, expected, home.path());
                spec.mode = mode.into();
                let probe = probe_provider_store(home.path(), &spec);
                assert!(
                    matches!(probe, ProviderStoreProbe::Ready { .. }),
                    "{mode}/large_exact={large_exact}: {probe:?}"
                );
                if !large_exact {
                    fs::remove_file(root.join("exact.jsonl")).unwrap();
                    let probe = probe_provider_store(home.path(), &spec);
                    assert!(
                        matches!(
                            probe,
                            ProviderStoreProbe::Blocked {
                                reason: RecoveryBlockReason::StoreUnreadable,
                                ..
                            }
                        ),
                        "a large unrelated body cannot certify absence: {mode}: {probe:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn native_probe_reads_exact_claude_owner_from_a_large_first_record() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".claude/projects/work");
        fs::create_dir_all(&root).unwrap();
        let expected = "11111111-2222-4333-8444-555555555555";
        let record = serde_json::json!({
            "type":"user", "sessionId":expected,
            "message":{"role":"user","content":[
                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"A".repeat(1024 * 1024 + 4)}},
                {"type":"text","text":"Inspect this image"},
            ]},
        });
        let bookend = serde_json::json!({"type":"queue-operation","operation":"dequeue",
            "timestamp":"2026-10-19T00:00:00.000Z","sessionId":expected});
        for prefix in [String::new(), format!("{bookend}\n")] {
            fs::write(
                root.join("image-first.jsonl"),
                format!("{prefix}{record}\n"),
            )
            .unwrap();
            let probe = probe_provider_store(
                home.path(),
                &resume_spec_for_test("claude", expected, home.path()),
            );
            assert!(matches!(probe, ProviderStoreProbe::Ready { .. }),
                "a complete native first turn can exceed the ordinary prefix after native bookends: {probe:?}");
        }
        let mut incomplete = record.to_string();
        incomplete.pop();
        fs::write(root.join("image-first.jsonl"), incomplete).unwrap();
        assert!(
            matches!(
                probe_provider_store(
                    home.path(),
                    &resume_spec_for_test("claude", expected, home.path())
                ),
                ProviderStoreProbe::Blocked { .. }
            ),
            "an incomplete first record still cannot qualify the selected root"
        );
    }

    #[test]
    fn native_probe_exact_positive_survives_unrelated_partial_transcript() {
        let expected = "11111111-2222-4333-8444-555555555555";
        for provider in ["claude", "codex"] {
            let home = tempfile::tempdir().unwrap();
            let root = home.path().join(if provider == "codex" {
                ".codex/sessions/2026/10/19"
            } else {
                ".claude/projects/work"
            });
            fs::create_dir_all(&root).unwrap();
            let exact = root.join("exact.jsonl");
            fs::write(&exact, native_rollout_for_test(provider, expected, false)).unwrap();
            let spec = resume_spec_for_test(provider, expected, home.path());
            assert!(matches!(
                probe_provider_store(home.path(), &spec),
                ProviderStoreProbe::Ready { .. }
            ));
            let partial = root.join("starting-child.jsonl");
            fs::write(&partial, b"{\"type\":\"user\",\"message\":").unwrap();
            let current = probe_provider_store(home.path(), &spec);
            assert!(matches!(current, ProviderStoreProbe::Ready { .. }), "{provider}: exact readable root must survive an unrelated unfinished write: {current:?}");
            fs::remove_file(&exact).unwrap();
            assert!(
                matches!(
                    probe_provider_store(home.path(), &spec),
                    ProviderStoreProbe::Blocked { .. }
                ),
                "an unfinished neighbor cannot prove the selected root absent"
            );
            fs::write(&exact, native_rollout_for_test(provider, expected, false)).unwrap();
            let corrupt_copy = root.join("corrupt-copy.jsonl");
            fs::write(
                &corrupt_copy,
                format!("{}{{", native_rollout_for_test(provider, expected, false)),
            )
            .unwrap();
            assert!(
                matches!(
                    probe_provider_store(home.path(), &spec),
                    ProviderStoreProbe::Blocked {
                        reason: RecoveryBlockReason::StoreUnreadable,
                        ..
                    }
                ),
                "a malformed copy identifying the selected root is not an unrelated sibling"
            );
            fs::remove_file(corrupt_copy).unwrap();
            fs::write(
                root.join("duplicate.jsonl"),
                native_rollout_for_test(provider, expected, false),
            )
            .unwrap();
            assert!(
                matches!(
                    probe_provider_store(home.path(), &spec),
                    ProviderStoreProbe::Blocked {
                        reason: RecoveryBlockReason::AmbiguousIdentity,
                        ..
                    }
                ),
                "two readable owners of the same native ID remain ambiguous"
            );
        }
    }

    fn native_rollout_for_test(provider: &str, id: &str, large: bool) -> String {
        let text = if large {
            "x".repeat(1024 * 1024 + 1)
        } else {
            "saved".into()
        };
        let rows = if provider == "codex" {
            vec![
                serde_json::json!({"timestamp":"2026-10-15T00:00:00.000Z","type":"session_meta","payload":{"id":id,"cwd":"/work"}}),
                serde_json::json!({"timestamp":"2026-10-15T00:00:01.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}}),
            ]
        } else {
            vec![
                serde_json::json!({"type":"user","sessionId":id,"message":{"role":"user","content":"saved"}}),
                serde_json::json!({"type":"assistant","sessionId":id,"message":{"role":"assistant","content":text}}),
            ]
        };
        rows.iter().map(|row| format!("{row}\n")).collect()
    }

    #[test]
    fn native_probe_codex_lineage_and_message_references_are_not_owners() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".codex/sessions");
        fs::create_dir_all(&root).unwrap();
        let parent = "11111111-2222-3333-4444-555555555555";
        let child = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let parent_path = root.join("parent.jsonl");
        fs::write(
            &parent_path,
            format!(
                "{}\n",
                serde_json::json!({"type":"session_meta","payload":{"id":parent,"cwd":"/work"}})
            ),
        )
        .unwrap();
        // Even a misleading filename and all known native lineage fields are references.
        fs::write(root.join(format!("child-referring-to-{parent}.jsonl")), format!("{}\n{}\n",
            serde_json::json!({"type":"session_meta","payload":{"id":child,"cwd":"/work","session_id":parent,"forked_from_id":parent,"source":{"subagent":{"thread_spawn":{"parent_thread_id":parent}}}}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":format!("Discuss session {parent}")}]}}),
        )).unwrap();
        let spec = resume_spec_for_test("codex", parent, home.path());
        let probe = probe_provider_store(home.path(), &spec);
        assert!(
            matches!(probe, ProviderStoreProbe::Ready { .. }),
            "{probe:?}"
        );
        fs::remove_file(parent_path).unwrap();
        let probe = probe_provider_store(home.path(), &spec);
        assert!(
            matches!(probe, ProviderStoreProbe::DefinitivelyUnavailable { .. }),
            "lineage alone cannot own a rollout: {probe:?}"
        );
    }

    #[test]
    fn native_probe_codex_requires_native_owner_even_when_filename_and_text_match() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".codex/sessions");
        fs::create_dir_all(&root).unwrap();
        let expected = "11111111-2222-3333-4444-555555555555";
        fs::write(
            root.join(format!("{expected}.jsonl")),
            format!(
                "{}\n",
                serde_json::json!({"type":"response_item","payload":{"text":expected}})
            ),
        )
        .unwrap();
        let spec = resume_spec_for_test("codex", expected, home.path());
        let probe = probe_provider_store(home.path(), &spec);
        assert!(
            matches!(
                probe,
                ProviderStoreProbe::Blocked {
                    reason: RecoveryBlockReason::StoreUnreadable,
                    ..
                }
            ),
            "{probe:?}"
        );
        fs::write(
            root.join("valid.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({"type":"session_meta","payload":{"id":expected,"cwd":"/work"}})
            ),
        )
        .unwrap();
        let probe = probe_provider_store(home.path(), &spec);
        assert!(
            matches!(probe, ProviderStoreProbe::Ready { .. }),
            "an exact readable owner does not depend on inspecting its sibling: {probe:?}"
        );
    }

    #[test]
    fn native_probe_codex_decodes_owner_and_blocks_conflicting_native_headers() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".codex/sessions");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout.jsonl");
        fs::write(
            &path,
            b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"saved-exact-\\u0072oot\"}}\n",
        )
        .unwrap();
        let spec = resume_spec_for_test("codex", "saved-exact-root", home.path());
        assert!(matches!(
            probe_provider_store(home.path(), &spec),
            ProviderStoreProbe::Ready { .. }
        ));

        fs::write(
            &path,
            b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"saved-exact-root\"}}\n{\"type\":\"session_meta\",\"payload\":{\"id\":\"another-root\"}}\n",
        )
        .unwrap();
        assert!(matches!(
            probe_provider_store(home.path(), &spec),
            ProviderStoreProbe::Blocked {
                reason: RecoveryBlockReason::StoreUnreadable,
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
            let mut spec = build_resume_spec(ResumeSpecInput {
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
            spec.environment
                .insert("OPENCODE_DISABLE_CHANNEL_DB".into(), "1".into());
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
        let mut spec = build_resume_spec(ResumeSpecInput {
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
        spec.environment
            .insert("OPENCODE_DISABLE_CHANNEL_DB".into(), "1".into());
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
            let selected = dir.path().join("uninspectable-selected-store");
            #[cfg(unix)]
            std::os::unix::fs::symlink(&selected, &selected).unwrap();
            #[cfg(not(unix))]
            fs::create_dir(&selected).unwrap();
            spec.environment
                .insert(key.into(), selected.display().to_string());
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
                    let row = if provider == "codex" {
                        serde_json::json!({"type":"session_meta","payload":{"id":"saved-exact-root","cwd":"/work"}})
                    } else {
                        serde_json::json!({"type":"user","sessionId":"saved-exact-root","message":{"role":"user","content":"saved"}})
                    };
                    fs::write(project.join("history.jsonl"), format!("{row}\n")).unwrap();
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
        // Candidate source policy must keep managed ownership and durability
        // consistent with its typed release state. Current native verification
        // remains separate. The state is the single typed switch; `managedEnabled` /
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
    }

    fn resume_spec_for_test(provider: &str, session_id: &str, provider_home: &Path) -> ResumeSpec {
        ResumeSpec {
            claude_fork: None,
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
    fn claude_parent_backed_fork_is_positive_without_certifying_child_absence() {
        let home = tempfile::tempdir().unwrap();
        let parent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let child = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let first = "11111111-1111-4111-8111-111111111111";
        let last = "22222222-2222-4222-8222-222222222222";
        let removed = "33333333-3333-4333-8333-333333333333";
        let attachment = "44444444-4444-4444-8444-444444444444";
        let parent_path = format!(".claude/projects/work/{parent}.jsonl");
        fs::create_dir_all(home.path().join(".claude/projects/work")).unwrap();
        let content = [
            serde_json::json!({"type":"atis-latch","sessionId":parent}),
            serde_json::json!({"type":"user","sessionId":parent,"uuid":first,"parentUuid":null,"message":{"role":"user","content":"kept"}}),
            serde_json::json!({"type":"attachment","sessionId":parent,"uuid":attachment,"parentUuid":first,"attachment":{"type":"invoked_skills","skills":[]}}),
            serde_json::json!({"type":"assistant","sessionId":parent,"uuid":last,"parentUuid":attachment,"message":{"role":"assistant","content":[]}}),
            serde_json::json!({"type":"user","sessionId":parent,"uuid":removed,"parentUuid":last,"message":{"role":"user","content":"undone"}}),
            serde_json::json!({"type":"queue-operation","operation":"remove","sessionId":parent}),
            serde_json::json!({"type":"mode","mode":"default","sessionId":parent}),
        ].iter().map(|row| format!("{row}\n")).collect::<String>();
        fs::write(home.path().join(&parent_path), &content).unwrap();
        let mut spec = resume_spec_for_test("claude", child, home.path());
        spec.mode = "freshclaude".into();
        assert!(
            matches!(
                probe_provider_store(
                    home.path(),
                    &resume_spec_for_test("claude", parent, home.path())
                ),
                ProviderStoreProbe::Ready { .. }
            ),
            "the complete parent transcript has a readable native owner"
        );
        assert!(
            matches!(
                probe_provider_store(home.path(), &spec),
                ProviderStoreProbe::DefinitivelyUnavailable { .. }
            ),
            "a complete unrelated transcript permits an exact child absence census"
        );
        // A metadata-only artifact has no native message owner. Keep the
        // ordinary census unresolved while the explicit fork remains usable.
        fs::write(
            home.path().join(".claude/projects/work/companion.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({"type":"mode","sessionId":parent})
            ),
        )
        .unwrap();
        assert!(
            matches!(
                probe_provider_store(home.path(), &spec),
                ProviderStoreProbe::Blocked { .. }
            ),
            "ordinary native companion rows cannot certify another child's absence"
        );
        spec.claude_fork = Some(freshell_runtime_protocol::ClaudeForkRecipe {
            recovery_disabled: false,
            child_session_id: child.into(),
            parent_session_id: parent.into(),
            parent_transcript: parent_path.clone(),
            child_transcript: format!(".claude/projects/work/{child}.jsonl"),
            parent_sha256: hex::encode(Sha256::digest(content.as_bytes())),
            target: freshell_runtime_protocol::ClaudeForkTarget::Prefix {
                cutoff_uuid: last.into(),
                drop_turn_uuid: Some(removed.into()),
            },
        });
        let probe = probe_provider_store(home.path(), &spec);
        assert!(
            matches!(probe, ProviderStoreProbe::ParentBackedClaudeFork { .. }),
            "{probe:?}"
        );
        let child_path = home
            .path()
            .join(&spec.claude_fork.as_ref().unwrap().child_transcript);
        spec.claude_fork.as_mut().unwrap().recovery_disabled = true;
        assert!(
            matches!(
                probe_provider_store(home.path(), &spec),
                ProviderStoreProbe::Blocked { .. }
            ),
            "missing child after an ambiguous effect is a blocker, never inspected absence"
        );
        for child_content in [
            "{not-json}\n".into(),
            format!("{}\n", serde_json::json!({"type":"mode","sessionId":child})),
            format!(
                "{}\n",
                serde_json::json!({"type":"user","sessionId":parent,"uuid":first})
            ),
            format!(
                "{}",
                serde_json::json!({"type":"user","sessionId":child,"uuid":first})
            ),
            format!(
                "{}\n{}\n",
                serde_json::json!({"type":"user","sessionId":child,"uuid":first}),
                serde_json::json!({"type":"assistant","sessionId":parent,"uuid":last})
            ),
        ] {
            fs::write(&child_path, child_content).unwrap();
            for disabled in [false, true] {
                spec.claude_fork.as_mut().unwrap().recovery_disabled = disabled;
                assert!(
                    matches!(
                        probe_provider_store(home.path(), &spec),
                        ProviderStoreProbe::Blocked { .. }
                    ),
                    "partial, ambiguous, wrong-root, or metadata-only child must block with recovery_disabled={disabled}"
                );
            }
        }
        fs::write(
            &child_path,
            format!(
                "{}\n",
                serde_json::json!({"type":"user","sessionId":child,"uuid":first,"forkedFrom":{"sessionId":parent}})
            ),
        )
        .unwrap();
        fs::write(home.path().join(&parent_path), format!("{content}{{}}\n")).unwrap();
        assert!(
            matches!(
                probe_provider_store(home.path(), &spec),
                ProviderStoreProbe::Ready { .. }
            ),
            "an actual materialized child takes precedence even when the source changed and recovery is disabled"
        );
        fs::remove_file(child_path).unwrap();
        spec.claude_fork.as_mut().unwrap().recovery_disabled = false;
        assert!(matches!(
            probe_provider_store(home.path(), &spec),
            ProviderStoreProbe::Blocked { .. }
        ));
        fs::write(home.path().join(&parent_path), &content).unwrap();
        let recipe = spec.claude_fork.clone();
        spec.claude_fork.as_mut().unwrap().target = ClaudeForkTarget::Prefix {
            cutoff_uuid: last.into(),
            drop_turn_uuid: Some(first.into()),
        };
        assert!(matches!(
            probe_provider_store(home.path(), &spec),
            ProviderStoreProbe::Blocked { .. }
        ));
        spec.claude_fork = recipe;
        fs::remove_file(home.path().join(&parent_path)).unwrap();
        assert!(matches!(
            probe_provider_store(home.path(), &spec),
            ProviderStoreProbe::Blocked { .. }
        ));
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
        let probe = probe_provider_store(home.path(), &spec);
        assert!(matches!(probe, ProviderStoreProbe::Ready { .. }),
            "a completed ordinary native save must not be classified using pristine-stub-only file/event rules: {probe:?}");
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
            "corrupt-metadata",
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
                    b"{\"role\":\"user\",\"content\":\"seed\"}\n{\"role\":\"assistant\",\"content\":").unwrap(),
                "partial-events" => fs::write(ensured.session_dir.join("events.jsonl"), b"{\"event\":").unwrap(),
                "corrupt-metadata" => {
                    fs::write(&metadata_path, b"null").unwrap();
                    fs::write(ensured.session_dir.join("metadata.json.backup"), b"null").unwrap();
                }
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
        for native_save in [
            "no-final-newline",
            "unused-invalid-backup",
            "native-sidecars",
        ] {
            for (path, bytes) in &original_files {
                fs::write(path, bytes).unwrap();
            }
            match native_save {
                "no-final-newline" => fs::write(ensured.session_dir.join("transcript.jsonl"),
                    b"{\"role\":\"user\",\"content\":\"seed\"}\n{\"role\":\"assistant\",\"content\":\"stored\"}").unwrap(),
                "unused-invalid-backup" => fs::write(ensured.session_dir.join("metadata.json.backup"), b"null").unwrap(),
                "native-sidecars" => {
                    fs::write(ensured.session_dir.join("config.md"), b"native session configuration").unwrap();
                    fs::write(ensured.session_dir.join("uninspected"), b"retained").unwrap();
                }
                _ => unreachable!(),
            }
            let probe = probe_provider_store(home.path(), &spec);
            assert!(
                matches!(probe, ProviderStoreProbe::Ready { .. }),
                "{native_save}: {probe:?}"
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

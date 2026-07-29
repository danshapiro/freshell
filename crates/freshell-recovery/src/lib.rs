//! Shared durable-recovery boundary.
//!
//! This crate deliberately contains no provider-store implementation. It owns
//! the closed provider vocabulary, canonical validation, request/result value
//! types, and the coordinator/ownership interfaces used on both sides of the
//! server composition root.

mod coordinator;
mod ownership;

pub use coordinator::{
    BlockingExactRecoveryProbe, ExactRecoveryLookupKey, ExactRecoveryProvider,
    ExactRecoveryProviderResult, ExactRecoveryProviderSnapshot, ExactRecoveryQuery,
    ExactRecoverySnapshot, ExactRecoveryState, ProviderNormalizedProject, RecoveryProviderRegistry,
    RegistryRegistrationError,
};
pub use ownership::RecoveryOwnerKey;

use freshell_protocol::SessionLocator;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::{Uuid, Variant};

/// The complete set of providers allowed to claim durable recovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DurableRecoveryProvider {
    Claude,
    Codex,
    Opencode,
    Amplifier,
}

impl DurableRecoveryProvider {
    pub const ALL: [Self; 4] = [Self::Claude, Self::Codex, Self::Opencode, Self::Amplifier];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
            Self::Amplifier => "amplifier",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::Opencode),
            "amplifier" => Some(Self::Amplifier),
            _ => None,
        }
    }
}

/// Whether a durable identity is only allocated or has been positively
/// observed in its provider store.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaterializationState {
    Allocated,
    Observed,
    #[default]
    Unknown,
}

impl MaterializationState {
    /// Materialization is monotonic: positive observation can never regress.
    pub fn advance(self, next: Self) -> Self {
        match (self, next) {
            (Self::Observed, _) | (_, Self::Observed) => Self::Observed,
            (Self::Allocated, _) | (_, Self::Allocated) => Self::Allocated,
            (Self::Unknown, Self::Unknown) => Self::Unknown,
        }
    }
}

/// Why an exact lookup could not produce a positive proof.
///
/// `UnsupportedSessionProvider`, `ProviderModeMismatch`, and
/// `InvalidSessionId` are input failures. All other variants are retryable;
/// deliberately, there is no `Absent` variant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExactRecoveryIssue {
    UnsupportedSessionProvider,
    ProviderModeMismatch,
    InvalidSessionId,
    MissingProjectScope,
    StoreReadFailed,
    ArtifactIncomplete,
    ArtifactChanged,
    ArtifactMissing,
    AmbiguousArtifact,
    Unproved,
}

impl ExactRecoveryIssue {
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedSessionProvider => "unsupported_session_provider",
            Self::ProviderModeMismatch => "provider_mode_mismatch",
            Self::InvalidSessionId => "invalid_session_id",
            Self::MissingProjectScope => "missing_project_scope",
            Self::StoreReadFailed => "store_read_failed",
            Self::ArtifactIncomplete => "artifact_incomplete",
            Self::ArtifactChanged => "artifact_changed",
            Self::ArtifactMissing => "artifact_missing",
            Self::AmbiguousArtifact => "ambiguous_artifact",
            Self::Unproved => "unproved",
        }
    }
}

/// Positive, provider-owned evidence for one canonical recovery owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactRecoveryProof {
    pub owner_key: RecoveryOwnerKey,
    pub artifact_fingerprint: String,
    pub resolved_cwd: Option<PathBuf>,
}

/// Validate and canonicalize an untrusted structured session reference.
///
/// Validation is purely lexical and performs no root resolution, filesystem
/// access, or database access. UUID providers accept uppercase input but
/// always return lowercase, hyphenated canonical IDs.
pub fn validate_session_ref(
    mode: &str,
    session_ref: &SessionLocator,
) -> Result<SessionLocator, ExactRecoveryIssue> {
    let ref_provider = DurableRecoveryProvider::parse(&session_ref.provider)
        .ok_or(ExactRecoveryIssue::UnsupportedSessionProvider)?;
    if mode != ref_provider.as_str() {
        return Err(ExactRecoveryIssue::ProviderModeMismatch);
    }

    let session_id = match ref_provider {
        DurableRecoveryProvider::Claude => canonical_uuid(&session_ref.session_id, 1..=5)?,
        DurableRecoveryProvider::Codex => canonical_uuid(&session_ref.session_id, 1..=8)?,
        DurableRecoveryProvider::Opencode => validate_opencode_session_id(&session_ref.session_id)?,
        DurableRecoveryProvider::Amplifier => {
            validate_amplifier_session_id(&session_ref.session_id)?
        }
    };
    Ok(SessionLocator {
        provider: ref_provider.as_str().to_string(),
        session_id,
    })
}

/// Validate an untrusted locator before it can reach the blocking registry.
pub fn prepare_exact_recovery_query(
    mode: &str,
    session_ref: &SessionLocator,
    cwd: Option<PathBuf>,
    materialization: MaterializationState,
) -> Result<ExactRecoveryQuery, ExactRecoveryIssue> {
    let session_ref = validate_session_ref(mode, session_ref)?;
    let mode = DurableRecoveryProvider::parse(mode)
        .ok_or(ExactRecoveryIssue::UnsupportedSessionProvider)?;
    Ok(ExactRecoveryQuery {
        mode,
        key: ExactRecoveryLookupKey { session_ref, cwd },
        materialization,
    })
}

fn canonical_uuid(
    supplied: &str,
    versions: std::ops::RangeInclusive<usize>,
) -> Result<String, ExactRecoveryIssue> {
    let bytes = supplied.as_bytes();
    let canonical_shape = bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|&i| bytes[i] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(i, byte)| [8, 13, 18, 23].contains(&i) || byte.is_ascii_hexdigit());
    if !canonical_shape {
        return Err(ExactRecoveryIssue::InvalidSessionId);
    }
    let parsed = Uuid::parse_str(supplied).map_err(|_| ExactRecoveryIssue::InvalidSessionId)?;
    if parsed.get_variant() != Variant::RFC4122 || !versions.contains(&parsed.get_version_num()) {
        return Err(ExactRecoveryIssue::InvalidSessionId);
    }
    Ok(parsed.hyphenated().to_string())
}

fn validate_opencode_session_id(supplied: &str) -> Result<String, ExactRecoveryIssue> {
    let suffix = supplied
        .strip_prefix("ses_")
        .ok_or(ExactRecoveryIssue::InvalidSessionId)?;
    if suffix.is_empty()
        || suffix.len() > 124
        || !suffix.bytes().all(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(ExactRecoveryIssue::InvalidSessionId);
    }
    Ok(supplied.to_string())
}

/// Host-independent lexical validation for an Amplifier session directory
/// component. This function must succeed before any caller joins the value to
/// a provider root.
pub fn validate_amplifier_session_id(supplied: &str) -> Result<String, ExactRecoveryIssue> {
    if supplied.is_empty()
        || supplied.len() > 255
        || supplied.encode_utf16().count() > 255
        || supplied.chars().any(char::is_whitespace)
        || supplied == "."
        || supplied == ".."
        || supplied.ends_with(['.', ' '])
    {
        return Err(ExactRecoveryIssue::InvalidSessionId);
    }

    if has_windows_path_prefix(supplied)
        || supplied.chars().any(|ch| {
            ch.is_ascii_control()
                || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
        || is_windows_reserved_basename(supplied)
    {
        return Err(ExactRecoveryIssue::InvalidSessionId);
    }

    Ok(supplied.to_string())
}

fn has_windows_path_prefix(value: &str) -> bool {
    value.starts_with(r"\\")
        || value.starts_with("//")
        || value
            .as_bytes()
            .get(0..2)
            .is_some_and(|prefix| prefix[0].is_ascii_alphabetic() && prefix[1] == b':')
}

fn is_windows_reserved_basename(value: &str) -> bool {
    let basename = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    if matches!(basename.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$") {
        return true;
    }

    let Some(digit) = basename
        .strip_prefix("COM")
        .or_else(|| basename.strip_prefix("LPT"))
    else {
        return false;
    };
    matches!(
        digit,
        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
    )
}

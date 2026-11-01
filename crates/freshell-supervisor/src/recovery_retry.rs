//! Failed automatic attempts are separate from the successful-recovery flap
//! window. The registry owns reservation and settlement; this is only policy.
use crate::backend::BackendError;
use freshell_runtime_protocol::{
    RecoveryAttemptId, RecoveryBlockReason, RuntimeError, RuntimeErrorCode, SoulId,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecoveryRetry {
    pub soul_id: SoulId,
    pub intent_revision: u64,
    pub attempt_count: u8,
    pub next_due_at_ms: Option<i64>,
    pub reserved_attempt_id: Option<RecoveryAttemptId>,
    pub last_reason: String,
}

impl RecoveryRetry {
    pub fn is_due(&self, now_ms: i64) -> bool {
        self.reserved_attempt_id.is_none()
            && self.attempt_count < 3
            && self.next_due_at_ms.is_some_and(|due| now_ms >= due)
    }
}

pub(crate) fn next_due(attempt_count: u8, retryable: bool, settled_at_ms: i64) -> Option<i64> {
    let delay = match (retryable, attempt_count) {
        (true, 1) => 2_000,
        (true, 2) => 10_000,
        _ => return None,
    };
    Some(settled_at_ms.saturating_add(delay))
}

/// Eligibility comes from a typed dependency failure, never from a retry hint
/// or provider error prose. Missing identity/evidence is deliberately absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TransientRecoveryFailure {
    Backend,
    Host,
    Preparation,
}

impl TransientRecoveryFailure {
    pub fn from_backend(error: &BackendError) -> Option<Self> {
        match error {
            BackendError::Unavailable(_) => Some(Self::Backend),
            BackendError::DockerHttp {
                status: 408 | 429 | 500..=599,
                ..
            } => Some(Self::Backend),
            _ => None,
        }
    }

    pub fn from_runtime(error: &RuntimeError) -> Option<Self> {
        match error.code {
            RuntimeErrorCode::BackendUnavailable => Some(Self::Backend),
            RuntimeErrorCode::HostUnreachable => Some(Self::Host),
            _ => None,
        }
    }

    pub fn permits(self, reason: RecoveryBlockReason) -> bool {
        match self {
            Self::Preparation => reason == RecoveryBlockReason::CapabilityPending,
            Self::Backend | Self::Host => reason == RecoveryBlockReason::ProviderUnavailable,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Backend => "backend_unavailable",
            Self::Host => "host_unavailable",
            Self::Preparation => "preparation_unavailable",
        }
    }
}

//! Checkpoint fallback classification.
//!
//! Phase 3 records the fallback in the decision lattice but does not claim a
//! provider-neutral checkpoint implementation.  An existing checkpoint is
//! therefore BLOCKED_IMPLEMENTATION, never LOST; absence is definitive for
//! this path only and may still be followed by a pristine-seed proof.

use crate::registry::RecoveryContext;
use freshell_runtime_protocol::{RecoveryBlockReason, RecoveryPath, RecoveryProbe, RetryHint};

pub fn probe(context: &RecoveryContext) -> RecoveryProbe {
    if context.checkpoint_revision == 0 {
        RecoveryProbe::DefinitivelyUnavailable {
            path: RecoveryPath::CheckpointRestore,
            reason: "no checkpoint revision is recorded for this soul".into(),
            evidence: vec!["checkpointRevision=0".into()],
        }
    } else {
        RecoveryProbe::Blocked {
            path: RecoveryPath::CheckpointRestore,
            reason: RecoveryBlockReason::ImplementationUnavailable,
            retry_hint: RetryHint {
                automatic_after_ms: None,
                manual_retry: true,
                repair: Some(
                    "install a provider-specific checkpoint restore implementation".into(),
                ),
            },
            evidence: vec![format!(
                "checkpointRevision={}",
                context.checkpoint_revision
            )],
        }
    }
}

//! Verified checkpoint fallback classification.
//!
//! A nonzero revision is not sufficient. Recovery is ready only when the
//! durable resume specification carries a matching, explicitly verified
//! checkpoint reference. Missing metadata is a definitive negative for this
//! path; mismatched or unverified metadata remains blocked and can never
//! participate in a loss certificate.

use crate::registry::RecoveryContext;
use freshell_runtime_protocol::{
    EvidenceStoreState, RecoveryBlockReason, RecoveryPath, RecoveryProbe, RetryHint,
};

pub fn probe(context: &RecoveryContext) -> RecoveryProbe {
    if context.checkpoint_revision == 0 {
        return RecoveryProbe::DefinitivelyUnavailable {
            path: RecoveryPath::CheckpointRestore,
            reason: "no checkpoint revision is recorded for this soul".into(),
            evidence: vec!["checkpointRevision=0".into()],
            store_state: EvidenceStoreState::Missing,
        };
    }

    let Some(spec) = context.resume_spec.clone() else {
        return blocked(
            context,
            "checkpoint revision exists, but no durable resume specification references it",
        );
    };
    if spec.checkpoint_revision != context.checkpoint_revision {
        return blocked(
            context,
            "checkpoint revision conflicts with the durable resume specification",
        );
    }
    let matching = spec.checkpoint_references.iter().filter(|reference| {
        reference.revision == context.checkpoint_revision && reference.verified
    });
    if matching.count() != 1 {
        return blocked(
            context,
            "checkpoint path requires exactly one verified matching reference",
        );
    }
    RecoveryProbe::ResumeReady {
        evidence_revision: spec.evidence_revision,
        resume_spec: Box::new(spec),
    }
}

/// Refine checkpoint viability with evidence gathered inside the provider
/// enclosure. The native-session fixture probe can positively inspect both
/// the primary state and independent checkpoint directory; a missing result
/// from that probe overrides a stale registry locator. Other providers remain
/// fail-closed on registry metadata until their checkpoint backend exposes the
/// same concrete existence proof.
pub fn probe_after_provider(
    context: &RecoveryContext,
    provider_probe: &RecoveryProbe,
) -> RecoveryProbe {
    if let RecoveryProbe::DefinitivelyUnavailable {
        reason,
        evidence,
        store_state: EvidenceStoreState::Missing,
        ..
    } = provider_probe
    {
        let inspected_checkpoint_store = reason.to_ascii_lowercase().contains("checkpoint")
            || evidence.iter().any(|item| {
                item.contains("/.freshell/checkpoints/")
                    || item.contains(r"\.freshell\checkpoints\")
            });
        if inspected_checkpoint_store {
            return RecoveryProbe::DefinitivelyUnavailable {
                path: RecoveryPath::CheckpointRestore,
                reason: "provider-side checkpoint store was inspected and is absent".into(),
                evidence: evidence.clone(),
                store_state: EvidenceStoreState::Missing,
            };
        }
    }
    probe(context)
}

fn blocked(context: &RecoveryContext, message: &str) -> RecoveryProbe {
    RecoveryProbe::Blocked {
        path: RecoveryPath::CheckpointRestore,
        reason: RecoveryBlockReason::ImplementationUnavailable,
        retry_hint: RetryHint {
            automatic_after_ms: None,
            manual_retry: true,
            repair: Some(message.into()),
        },
        evidence: vec![
            format!("checkpointRevision={}", context.checkpoint_revision),
            message.into(),
        ],
    }
}

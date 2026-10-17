//! Verified checkpoint fallback classification.
//!
//! A nonzero revision is not sufficient. Recovery is ready only when the
//! durable resume specification carries a matching, explicitly verified
//! checkpoint reference. Missing metadata is unknown. Loss additionally
//! requires a fresh, explicit inspection of the applicable provider stores.

use crate::registry::RecoveryContext;
use freshell_runtime_protocol::{
    EvidenceStoreState, RecoveryBlockReason, RecoveryPath, RecoveryPathEvidence, RecoveryProbe,
    RetryHint,
};

pub fn probe(context: &RecoveryContext) -> RecoveryProbe {
    if context.checkpoint_revision == 0 {
        return blocked(context, "checkpoint revision is unrecorded; provider checkpoint-store absence has not been established");
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
    if matches!(
        provider_probe,
        RecoveryProbe::DefinitivelyUnavailable { .. }
    ) {
        return match inspected_negative(provider_probe, RecoveryPath::CheckpointRestore) {
            Ok(row) => RecoveryProbe::DefinitivelyUnavailable {
                path: row.path,
                reason: row.reason_code.clone(),
                evidence: row.evidence_refs.clone(),
                store_state: row.store_state,
                negative_paths: vec![row],
            },
            Err(probe) => probe,
        };
    }
    probe(context)
}

/// Select exactly one explicit inspected row before any normalization. Both
/// live and offline loss collection use this same boundary; prose, locators
/// and aggregate store status cannot create a path-specific verdict.
pub(crate) fn inspected_negative(
    probe: &RecoveryProbe,
    path: RecoveryPath,
) -> Result<RecoveryPathEvidence, RecoveryProbe> {
    let RecoveryProbe::DefinitivelyUnavailable { negative_paths, .. } = probe else {
        return Err(probe.clone());
    };
    let mut selected = negative_paths.iter().filter(|row| row.path == path);
    let row = selected.next();
    if let Some(row) = row.filter(|row| {
        selected.next().is_none()
            && !row.reason_code.trim().is_empty()
            && !row.evidence_refs.is_empty()
            && row
                .evidence_refs
                .iter()
                .all(|reference| !reference.trim().is_empty())
            && matches!(
                row.store_state,
                EvidenceStoreState::Missing | EvidenceStoreState::PresentReadable
            )
    }) {
        return Ok(row.clone());
    }
    Err(RecoveryProbe::Blocked {
        path,
        reason: RecoveryBlockReason::StoreUnreadable,
        retry_hint: RetryHint {
            automatic_after_ms: None,
            manual_retry: true,
            repair: Some(
                "inspect the exact provider store for this recovery path, then retry".into(),
            ),
        },
        evidence: vec![
            "required recovery path has missing, conflicting or uninspected store evidence".into(),
        ],
    })
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

#[cfg(test)]
#[path = "checkpoint_tests.rs"]
pub(crate) mod tests;

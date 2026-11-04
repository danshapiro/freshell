//! Plan-aware runtime selection (Task 7) — the reattach-vs-spawn seam the
//! production [`CodexRuntimeFactory`] dispatches through.
//!
//! Sibling of [`crate::sidecar_reconcile`] (the pre-authorized split: the
//! reconcile module sits at its 1,000-line ceiling): the reconciler owns the
//! CLAIM; this module owns the SELECTION the claim's outcome drives.
//!
//! [`CodexRuntimeFactory`]: crate::launch_lifecycle::CodexRuntimeFactory

use std::sync::Arc;

use crate::app_server::BoxFuture;
use crate::launch_lifecycle::{
    CodexLaunchRuntime, CodexRuntimeReady, SpawnedCodexAppServerRuntime,
};
use crate::launch_plan::CodexLaunchPlan;
use crate::sidecar_reconcile::{ReattachedCodexAppServerRuntime, SidecarReconciler};
use crate::sidecar_store::CodexSidecarStore;

/// The production selection: a claimable verified survivor for the plan's
/// resume session ⇒ reattach; otherwise the spawn runtime, unless the plan
/// requires a retained owner, in which case it refuses without a replacement.
/// Reattach applies
/// only to resume plans (`plan.session_id` is `Some` ⇔ resume,
/// [`CodexLaunchPlan::session_id`]), so the A4 fresh-restore exclusion and
/// the 45s candidate-capture timer are untouched. `None` reconciler/store
/// (nothing installed at boot) keeps the ordinary spawn behavior; a required
/// retained-owner plan still refuses.
pub async fn select_codex_runtime(
    reconciler: Option<&Arc<SidecarReconciler>>,
    store: Option<&Arc<CodexSidecarStore>>,
    plan: &CodexLaunchPlan,
) -> Arc<dyn CodexLaunchRuntime> {
    if let (Some(reconciler), Some(store), Some(session_id)) =
        (reconciler, store, plan.session_id.as_deref())
    {
        if let Some(record) = reconciler.claim_for_session(session_id).await {
            if plan.require_retained_sidecar {
                if !record
                    .terminal_id
                    .as_deref()
                    .is_some_and(|id| !id.is_empty())
                {
                    reconciler.return_uncommitted_claim(record);
                    tracing::warn!(
                        event = "codex.retained_sidecar_claim_unqualified",
                        session_id,
                        "Claim has no prior terminal owner; no replacement was started"
                    );
                    return Arc::new(UnavailableRetainedRuntime);
                }
                return Arc::new(crate::retained_sidecar::RetainedSidecarRuntime::new(
                    record,
                    Arc::clone(store),
                    Arc::clone(reconciler),
                ));
            }
            return Arc::new(ReattachedCodexAppServerRuntime::new(
                record,
                Arc::clone(store),
            ));
        }
    }
    if plan.require_retained_sidecar {
        tracing::warn!(
            event = "codex.retained_sidecar_claim_unavailable",
            session_id = plan.session_id.as_deref(),
            "Existing Codex owner could not be claimed; no replacement was started"
        );
        return Arc::new(UnavailableRetainedRuntime);
    }
    Arc::new(SpawnedCodexAppServerRuntime::with_context(
        plan.sidecar_context.clone(),
    ))
}

struct UnavailableRetainedRuntime;

impl CodexLaunchRuntime for UnavailableRetainedRuntime {
    fn ensure_ready(&self, _: Option<String>) -> BoxFuture<'_, Result<CodexRuntimeReady, String>> {
        Box::pin(async {
            Err(
                "The existing Codex agent could not be claimed. No replacement agent was started."
                    .into(),
            )
        })
    }

    fn update_ownership_metadata(&self, _: String, _: u64) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Err("The existing Codex agent was not claimed.".into()) })
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

//! Plan-aware runtime selection (Task 7) — the reattach-vs-spawn seam the
//! production [`CodexRuntimeFactory`] dispatches through.
//!
//! Sibling of [`crate::sidecar_reconcile`] (the pre-authorized split: the
//! reconcile module sits at its 1,000-line ceiling): the reconciler owns the
//! CLAIM; this module owns the SELECTION the claim's outcome drives.
//!
//! [`CodexRuntimeFactory`]: crate::launch_lifecycle::CodexRuntimeFactory

use std::sync::Arc;

use crate::launch_lifecycle::{CodexLaunchRuntime, SpawnedCodexAppServerRuntime};
use crate::launch_plan::CodexLaunchPlan;
use crate::sidecar_reconcile::{ReattachedCodexAppServerRuntime, SidecarReconciler};
use crate::sidecar_store::CodexSidecarStore;

/// The production selection: a claimable verified survivor for the plan's
/// resume session ⇒ reattach; otherwise the spawn runtime. Reattach applies
/// only to resume plans (`plan.session_id` is `Some` ⇔ resume,
/// [`CodexLaunchPlan::session_id`]), so the A4 fresh-restore exclusion and
/// the 45s candidate-capture timer are untouched. `None` reconciler/store
/// (nothing installed at boot) ⇒ spawn — behavior identical to the
/// pre-reconciler world.
pub async fn select_codex_runtime(
    reconciler: Option<&Arc<SidecarReconciler>>,
    store: Option<&Arc<CodexSidecarStore>>,
    plan: &CodexLaunchPlan,
) -> Arc<dyn CodexLaunchRuntime> {
    if let (Some(reconciler), Some(store), Some(session_id)) =
        (reconciler, store, plan.session_id.as_deref())
    {
        if let Some(record) = reconciler.claim_for_session(session_id).await {
            return Arc::new(ReattachedCodexAppServerRuntime::new(
                record,
                Arc::clone(store),
            ));
        }
    }
    Arc::new(SpawnedCodexAppServerRuntime::with_context(
        plan.sidecar_context.clone(),
    ))
}

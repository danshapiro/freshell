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
use crate::sidecar_store::{CodexSidecarRecord, CodexSidecarStore};

/// The production selection: a claimable verified survivor for the plan's
/// resume session ⇒ reattach; otherwise the spawn runtime. Reattach applies
/// only to resume plans (`plan.session_id` is `Some` ⇔ resume,
/// [`CodexLaunchPlan::session_id`]), so the A4 fresh-restore exclusion and
/// the 45s candidate-capture timer are untouched. `None` reconciler/store
/// (nothing installed at boot) ⇒ spawn — behavior identical to the
/// pre-reconciler world. A plan with a unit seed reattaches inside the
/// record's unit (its boot unit record from the reconciler) and spawns each
/// attempt in a unit of its own; a seedless plan keeps the unit-less
/// runtimes, and never reattaches a record that names a native main (only its
/// unit can stop that sidecar): it refuses that claim and spawns.
pub async fn select_codex_runtime(
    reconciler: Option<&Arc<SidecarReconciler>>,
    store: Option<&Arc<CodexSidecarStore>>,
    plan: &CodexLaunchPlan,
) -> Arc<dyn CodexLaunchRuntime> {
    if let (Some(reconciler), Some(store), Some(session_id)) =
        (reconciler, store, plan.session_id.as_deref())
    {
        if let Some(record) = reconciler.claim_for_session(session_id).await {
            match plan.unit_seed.clone() {
                Some(seed) => {
                    let unit_record = record
                        .unit_id
                        .as_deref()
                        .and_then(|unit_id| reconciler.unit_record(unit_id));
                    return Arc::new(ReattachedCodexAppServerRuntime::with_unit(
                        record,
                        unit_record,
                        Arc::clone(store),
                        seed,
                    ));
                }
                // A row with a native main is stopped only through its unit:
                // the seedless tree kill never reaches a native behind an
                // exited launcher. Refused (the row stays for the next boot,
                // nothing is signalled); this plan spawns.
                None if record.main_pid.is_some() => refuse_seedless_claim(&record),
                None => {
                    return Arc::new(ReattachedCodexAppServerRuntime::new(
                        record,
                        Arc::clone(store),
                    ))
                }
            }
        }
    }
    match plan.unit_seed.clone() {
        Some(seed) => Arc::new(SpawnedCodexAppServerRuntime::with_context_and_seed(
            plan.sidecar_context.clone(),
            seed,
        )),
        None => Arc::new(SpawnedCodexAppServerRuntime::with_context(
            plan.sidecar_context.clone(),
        )),
    }
}

/// Logs a seedless plan's refused claim of a row that names a native main.
fn refuse_seedless_claim(record: &CodexSidecarRecord) {
    tracing::warn!(
        target: "freshell_codex::runtime_select",
        event = "codex_seedless_claim_refused",
        unit_id = record.unit_id.as_deref().unwrap_or(""),
        provider = "codex",
        session_id = record.session_id.as_deref().unwrap_or(""),
        terminal_id = record.terminal_id.as_deref().unwrap_or(""),
        operation_id = "",
        ownership_id = %record.ownership_id,
        main_pid = record.main_pid.unwrap_or(0),
        "codex_seedless_claim_refused: a sidecar with a native main is reattached only \
         inside its unit; the record stays for the next boot and this plan spawns"
    );
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::launch_plan::{plan_codex_launch, CodexLaunchPlanInput};
    use crate::sidecar_test_support::{spawn_verified_record, store_in, unit_record};
    use freshell_containment::{StopMode, StopReason, UnitId};

    /// A row carrying a native main is stopped only through its unit: the
    /// seedless reattach's tree kill never reaches a native behind an exited
    /// launcher. A seedless plan that claims such a row refuses it and
    /// spawns; the row stays on disk for the next boot and nothing is
    /// signalled.
    #[tokio::test]
    async fn a_seedless_plan_never_reattaches_a_row_with_a_native_main() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = store_in(&dir);
        let unit_id = UnitId::mint();
        let (mut child, record) = spawn_verified_record("t-v2", unit_id.as_str());
        store.write(&record).expect("write record");
        let (reconciler, report) = SidecarReconciler::boot_reconcile_with_units(
            Arc::clone(&store),
            &[unit_record(unit_id.as_str(), true)],
        );
        assert_eq!(report.held, 1, "{report:?}");
        let reconciler = Arc::new(reconciler);
        let plan = plan_codex_launch(&CodexLaunchPlanInput {
            resume_session_id: Some("t-v2"),
            ..Default::default()
        })
        .expect("resume plan");
        assert!(plan.unit_seed.is_none(), "a seedless plan");

        let runtime = select_codex_runtime(Some(&reconciler), Some(&store), &plan).await;
        // A seedless reattach runtime's stop would remove the row; an
        // un-started spawn runtime's stop touches nothing.
        assert!(runtime
            .stop(StopMode::Force, StopReason::StartCancelled, "test".into())
            .await
            .is_none());
        assert_eq!(
            store.load_all(),
            vec![record],
            "the row stays for the next boot"
        );
        assert_eq!(
            child.0.try_wait().expect("try_wait own child"),
            None,
            "nothing is signalled"
        );
    }
}

//! View-intent titles are names; the supervisor never invents one.
use super::*;

/// Name reliability (Task 8, D6): a view intent requested without a title
/// stays untitled on both durable write paths (the launch's automatic
/// primary and an upserted view), instead of the old "Recovered <X>
/// agent" provider label that clients then wrote over real tab names.
#[tokio::test]
async fn view_intent_without_title_stays_empty() {
    use crate::admission::AdmissionPolicy;
    use crate::registry::LaunchPreparation;
    use freshell_runtime_protocol::{RequestId, RuntimeProfile, UpsertViewIntentRequest};

    let dir = tempfile::tempdir().unwrap();
    let registry = Registry::open(dir.path(), None).unwrap();
    let soul = SoulId::new();
    registry
        .prepare_launch(LaunchPreparation {
            soul_id: soul.clone(),
            provider: "opencode".into(),
            provider_store_id: "store".into(),
            native_session_id: None,
            creation_seed_ref: "seed".into(),
            request_id: RequestId::new(),
            payload_digest: "untitled".into(),
            requested_limits: RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 64 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 32,
            },
            profile: RuntimeProfile::Custom,
            project_key: "test-project".into(),
            fixture: None,
            terminal: None,
            fresh_agent: None,
            view_intent: Some(ViewIntentRequest::default()),
            admission: AdmissionPolicy::default(),
        })
        .await
        .unwrap();

    let snapshot = registry.inventory_snapshot().await.unwrap();
    let automatic = snapshot
        .view_intents
        .iter()
        .find(|intent| intent.soul_id == soul && intent.kind == ViewIntentKind::AutomaticPrimary)
        .expect("the launch records its automatic primary view");
    assert_eq!(automatic.title, "");

    let explicit = registry
        .upsert_view_intent(UpsertViewIntentRequest {
            soul_id: soul.clone(),
            view_id: None,
            intent: ViewIntentRequest {
                kind: ViewIntentKind::Explicit,
                preferred_tab_id: Some("tab-explicit".into()),
                preferred_pane_id: Some("pane-explicit".into()),
                title: Some("   ".into()),
                ..ViewIntentRequest::default()
            },
            expected_revision: None,
            expected_soul_intent_revision: 1,
            expected_control_epoch: None,
        })
        .await
        .unwrap();
    assert_eq!(explicit.title, "");

    // A real title still passes through untouched.
    let named = registry
        .upsert_view_intent(UpsertViewIntentRequest {
            soul_id: soul,
            view_id: Some(explicit.view_id.clone()),
            intent: ViewIntentRequest {
                kind: ViewIntentKind::Explicit,
                preferred_tab_id: Some("tab-explicit".into()),
                preferred_pane_id: Some("pane-explicit".into()),
                title: Some("Billing bug".into()),
                ..ViewIntentRequest::default()
            },
            expected_revision: Some(explicit.revision),
            expected_soul_intent_revision: 1,
            expected_control_epoch: None,
        })
        .await
        .unwrap();
    assert_eq!(named.title, "Billing bug");
}

//! Live serialization fixture for the TypeScript managed-runtime consumer.
//! Uses the production DTOs; it is not a provider qualification receipt.
use freshell_runtime_protocol::{
    IncarnationId, NativeIdentityObservation, NativeIdentitySource, RuntimeInventorySnapshot,
    RuntimeReadiness, RuntimeView,
};
use serde_json::json;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let observation = NativeIdentityObservation {
        native_session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".into(),
        incarnation_id: IncarnationId::parse("incarnation-wire")?,
        launch_nonce: "launch-wire".into(),
        evidence_revision: 1,
        source: NativeIdentitySource::ClaudeNativeEvent,
        evidence_digest: "a".repeat(64),
    };
    let mut soul: RuntimeView = serde_json::from_value(json!({
        "soulId":"soul-wire", "incarnationId":"incarnation-wire",
        "launchState":"running", "cleanupState":"none", "intentRevision":1,
        "executionGeneration":1, "desiredState":"running", "recoveryState":"live",
        "durabilityState":"unknown", "allocationState":"allocated", "provider":"claude",
        "nativeSessionId":observation.native_session_id, "evidenceRevision":1,
        "successfulRecoveriesInWindow":0
    }))?;
    let legacy = soul.clone();
    soul.native_identity_observation = Some(observation.clone());
    let readiness: RuntimeReadiness = serde_json::from_value(json!({
        "inventoryRevision":1, "initialScanState":"pending", "blockedSubsystems":[],
        "startupRecoveryConcurrencyLimit":1, "startupRecoveryPeak":0
    }))?;
    let inventory = RuntimeInventorySnapshot {
        revision: 1,
        readiness: readiness.clone(),
        souls: vec![soul.clone()],
        view_intents: vec![],
        pending_projection_count: 0,
    };
    println!(
        "{}",
        serde_json::to_string(&json!({
            "observation":observation, "inventory":inventory, "legacy":legacy,
            "detail":{"revision":1,"readiness":readiness,"soul":soul,"viewIntents":[],"actualUsage":null}
        }))?
    );
    Ok(())
}

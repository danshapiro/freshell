use super::*;
use freshell_runtime_protocol::{DockerDaemonId, RecoveryBlockReason};

async fn initial_source_with_unadmitted_refusal(
) -> (tempfile::TempDir, Registry, SoulId, IncarnationId) {
    let root = tempfile::tempdir().unwrap();
    let registry = Registry::open(root.path().join("registry"), None).unwrap();
    let soul = SoulId::new();
    let prepared =
        crate::registry::tests::materialize_fresh_runtime(&registry, soul.clone(), root.path())
            .await;
    let context = registry.recovery_context(soul.clone()).await.unwrap();
    registry
        .mark_recovery_blocked(
            soul.clone(),
            None,
            RecoveryBlockReason::StoreUnreadable,
            Vec::new(),
            context.write_fence(),
        )
        .await
        .unwrap();
    registry
        .refuse_blocked_unadmitted_input(
            soul.clone(),
            RequestId::parse("unadmitted-before-replan").unwrap(),
            b"unsent input",
            b"null",
        )
        .await
        .unwrap()
        .expect("the new input must be refused");
    let observation = serde_json::to_string(&InitialAuthVolumeObservation::Absent {
        daemon_id: DockerDaemonId::new(),
    })
    .unwrap();
    let conn = Connection::open(registry.database_path()).unwrap();
    conn.execute(
        "UPDATE souls SET provider='opencode',native_session_id=NULL WHERE soul_id=?1",
        [soul.as_str()],
    )
    .unwrap();
    conn.execute(
        "UPDATE commands SET state='provider_inputs_changed' WHERE soul_id=?1",
        [soul.as_str()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO provider_input_preparations (soul_id,reservation_id,creation_seed_ref,provider,image_ref,host_binary_path,host_binary_sha256,intent_revision,observation) VALUES (?1,'owned-reservation',?2,'opencode','sha256:fixture','/fixture/host','fixture',1,?3)",
        params![soul.as_str(), context.creation_seed_ref, observation],
    )
    .unwrap();
    drop(conn);
    (root, registry, soul, prepared.incarnation_id)
}

fn add_queued_input(conn: &Connection, soul: &SoulId, incarnation: &IncarnationId) {
    conn.execute(
        "INSERT INTO input_commands (soul_id,request_id,payload_digest,protected_payload,incarnation_id,state,created_at,updated_at) VALUES (?1,'real-queued-input','fixture',X'00',?2,'queued',1,1)",
        params![soul.as_str(), incarnation.as_str()],
    )
    .unwrap();
}

#[tokio::test]
async fn unadmitted_refusal_preserves_rejected_initial_source_reuse() {
    let (_root, registry, soul, incarnation) = initial_source_with_unadmitted_refusal().await;
    let conn = Connection::open(registry.database_path()).unwrap();
    conn.execute(
        "UPDATE incarnations SET launch_state='stopped' WHERE incarnation_id=?1",
        [incarnation.as_str()],
    )
    .unwrap();
    assert!(initial_or_rejected_creation(&conn, &soul).unwrap());
    add_queued_input(&conn, &soul, &incarnation);
    assert!(!initial_or_rejected_creation(&conn, &soul).unwrap());
}

#[tokio::test]
async fn unadmitted_refusal_preserves_rejected_initial_source_observation() {
    let (_root, registry, soul, incarnation) = initial_source_with_unadmitted_refusal().await;
    let conn = Connection::open(registry.database_path()).unwrap();
    conn.execute(
        "UPDATE incarnations SET launch_state='starting',provider_preparation_pending=0 WHERE incarnation_id=?1",
        [incarnation.as_str()],
    )
    .unwrap();
    conn.execute(
        "UPDATE provider_input_preparations SET consumed=1,bound_incarnation_id=?1 WHERE soul_id=?2",
        params![incarnation.as_str(), soul.as_str()],
    )
    .unwrap();
    assert!(rejected_initial_observation(&conn, &incarnation).is_ok());
    add_queued_input(&conn, &soul, &incarnation);
    assert!(rejected_initial_observation(&conn, &incarnation).is_err());
}

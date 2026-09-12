use super::*;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

#[test]
fn legacy_machine_ids_are_imported_exactly_and_survive_a_restart() {
    let home = tempfile::tempdir().unwrap();
    let candidates = vec![
        LegacyMachineCandidate::new("legacy-registry-id", "Desktop", 10),
        LegacyMachineCandidate::new("legacy-snapshot-id", "Desktop", 20),
    ];

    let store = MachineStore::open(
        Some(home.path().join(".freshell").join("machines")),
        candidates,
    )
    .expect("legacy identities import");
    let initial = store.list();
    assert_eq!(
        initial
            .iter()
            .map(|machine| machine.id.as_str())
            .collect::<Vec<_>>(),
        vec!["legacy-snapshot-id", "legacy-registry-id"],
        "legacy IDs are machine IDs, never rewritten UUIDs"
    );
    assert_eq!(initial[0].label, "Desktop 2");
    assert_eq!(initial[1].label, "Desktop");

    drop(store);
    let reopened = MachineStore::open(
        Some(home.path().join(".freshell").join("machines")),
        Vec::new(),
    )
    .expect("durable machine directory reloads");
    assert_eq!(
        reopened
            .list()
            .iter()
            .map(|machine| machine.id.as_str())
            .collect::<Vec<_>>(),
        vec!["legacy-snapshot-id", "legacy-registry-id"]
    );
}

#[test]
fn creates_server_minted_ids_and_deduplicates_requested_labels() {
    let store = MachineStore::open(None, Vec::new()).expect("in-memory store");
    let first = store.create("Windows device").expect("first machine");
    let second = store.create(" Windows   device ").expect("second machine");

    assert!(uuid::Uuid::parse_str(&first.id).is_ok(), "{}", first.id);
    assert!(uuid::Uuid::parse_str(&second.id).is_ok(), "{}", second.id);
    assert_ne!(first.id, second.id);
    assert_eq!(first.label, "Windows device");
    assert_eq!(second.label, "Windows device 2");

    let renamed = store.rename(&second.id, "Desk").expect("rename machine");
    assert_eq!(renamed.label, "Desk");
    assert!(renamed.last_seen_at >= renamed.created_at);
}

#[test]
fn tab_sync_resolution_returns_the_canonical_label_and_updates_last_seen_at() {
    let store = MachineStore::open(
        None,
        vec![LegacyMachineCandidate::new("legacy-machine", "Desktop", 1)],
    )
    .expect("in-memory store");
    let before = store.list().pop().expect("imported machine");

    let label = store
        .resolve_for_tab_sync("legacy-machine")
        .expect("directory read")
        .expect("legacy machine remains known");
    let after = store.list().pop().expect("machine remains present");

    assert_eq!(label, "Desktop");
    assert!(
        after.last_seen_at > before.last_seen_at,
        "an accepted tab-sync identity lookup records fresh activity"
    );
}

#[test]
fn duplicate_legacy_sources_keep_the_exact_id_and_newest_real_label() {
    let store = MachineStore::open(
        None,
        vec![
            LegacyMachineCandidate::new("legacy-machine", "Old compact label", 10),
            LegacyMachineCandidate::new("legacy-machine", "Most recent snapshot label", 20),
        ],
    )
    .expect("in-memory store");

    assert_eq!(
        store.list(),
        vec![Machine {
            id: "legacy-machine".to_string(),
            label: "Most recent snapshot label".to_string(),
            created_at: 10,
            last_seen_at: 20,
        }]
    );
}

#[test]
fn later_legacy_imports_never_override_a_persisted_machine_rename() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".freshell").join("machines");
    let initial = MachineStore::open(
        Some(root.clone()),
        vec![LegacyMachineCandidate::new(
            "legacy-machine",
            "Old label",
            10,
        )],
    )
    .unwrap();
    let renamed = initial.rename("legacy-machine", "Chosen label").unwrap();
    drop(initial);

    let reopened = MachineStore::open(
        Some(root),
        vec![LegacyMachineCandidate::new(
            "legacy-machine",
            "Newer snapshot label",
            20,
        )],
    )
    .unwrap();
    let machine = reopened.list().pop().unwrap();
    assert_eq!(machine.id, "legacy-machine");
    assert_eq!(machine.label, "Chosen label");
    assert_eq!(machine.created_at, 10);
    assert!(machine.last_seen_at >= renamed.last_seen_at);
}

#[test]
fn recovers_a_valid_backup_without_losing_the_machine_directory_to_a_corrupt_primary() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join(".freshell").join("machines");
    let store = MachineStore::open(Some(root.clone()), Vec::new()).unwrap();
    let first = store.create("Primary desktop").unwrap();
    let _second = store.create("Garage server").unwrap();
    drop(store);

    let state_path = root.join("v1").join("state.json");
    let backup_path = root.join("v1").join("state.json.bak");
    assert!(state_path.is_file());
    assert!(
        backup_path.is_file(),
        "the previous durable state is retained"
    );
    std::fs::write(&state_path, b"{not valid json").unwrap();

    let recovered = MachineStore::open(Some(root.clone()), Vec::new()).unwrap();
    let machines = recovered.list();
    assert_eq!(machines.len(), 1, "recovery uses the last valid backup");
    assert_eq!(machines[0].id, first.id);
    assert!(
        std::fs::read_to_string(&state_path)
            .unwrap()
            .contains(&first.id),
        "the recovered state is atomically restored as the new primary"
    );
    assert!(
        std::fs::read_dir(root.join("v1"))
            .unwrap()
            .flatten()
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("state.json.corrupt-")),
        "the unreadable primary is preserved for diagnosis"
    );
}

#[test]
fn imports_ids_from_compact_registry_and_snapshot_directories_without_rekeying() {
    let home = tempfile::tempdir().unwrap();
    let compact_root = home.path().join("tabs-registry");
    let snapshots = home.path().join("tabs-snapshots");
    let durable = freshell_ws::tabs_store::DurableTabsStore::open(
        &compact_root,
        freshell_ws::tabs_store_model::default_caps(),
        1,
    )
    .unwrap();
    let compact_tabs = freshell_ws::tabs::TabsRegistry::with_durable_store(durable, None);
    compact_tabs
        .replace_client_snapshot(
            "server",
            "legacy-compact-id",
            "Desktop",
            "client-compact",
            1,
            vec![test_record("legacy-compact-id:tab", 1)],
        )
        .unwrap();

    let snapshot_tabs = freshell_ws::tabs::TabsRegistry::with_persist_dir(snapshots.clone());
    snapshot_tabs
        .replace_client_snapshot(
            "server",
            "legacy-snapshot-id",
            "Garage server",
            "client-snapshot",
            1,
            vec![test_record("legacy-snapshot-id:tab", 2)],
        )
        .unwrap();
    let snapshot_dir =
        snapshots.join(freshell_ws::tabs_persist::encode_device_id("legacy-snapshot-id").unwrap());
    assert!(
        snapshot_dir.is_dir(),
        "fixture must use the real snapshot layout"
    );
    let snapshot_files_before = snapshot_file_bytes(&snapshot_dir);

    let candidates = legacy_machine_candidates(&compact_tabs, Some(&snapshots)).unwrap();
    let ids: Vec<_> = candidates
        .iter()
        .map(|candidate| candidate.id.as_str())
        .collect();
    assert!(ids.contains(&"legacy-compact-id"), "{ids:?}");
    assert!(ids.contains(&"legacy-snapshot-id"), "{ids:?}");

    let store = MachineStore::open(Some(home.path().join("machines")), candidates).unwrap();
    let machine_ids: Vec<_> = store.list().into_iter().map(|machine| machine.id).collect();
    assert!(machine_ids.contains(&"legacy-compact-id".to_string()));
    assert!(machine_ids.contains(&"legacy-snapshot-id".to_string()));
    assert!(
        snapshot_dir.is_dir(),
        "migration must not move snapshot directories"
    );
    assert_eq!(
        snapshot_file_bytes(&snapshot_dir),
        snapshot_files_before,
        "machine migration must not rewrite immutable snapshot generations"
    );
}

#[tokio::test]
async fn machine_routes_expose_the_create_list_and_rename_contract() {
    let store = MachineStore::open(None, Vec::new()).unwrap();
    let app = router(MachinesState {
        auth_token: std::sync::Arc::new("token".to_string()),
        store,
    });

    let (status, _) = machine_request(app.clone(), Method::GET, "/api/machines", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, first) = machine_request(
        app.clone(),
        Method::POST,
        "/api/machines",
        Some(json!({ "label": "Windows device" })),
        Some("token"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let first_machine = &first["machine"];
    assert!(uuid::Uuid::parse_str(first_machine["id"].as_str().unwrap()).is_ok());
    assert_eq!(first_machine["label"], "Windows device");
    assert!(first_machine["createdAt"].is_i64() || first_machine["createdAt"].is_u64());
    assert!(first_machine["lastSeenAt"].is_i64() || first_machine["lastSeenAt"].is_u64());

    let (status, second) = machine_request(
        app.clone(),
        Method::POST,
        "/api/machines",
        Some(json!({ "label": "Windows device" })),
        Some("token"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["machine"]["label"], "Windows device 2");

    let (status, list) = machine_request(
        app.clone(),
        Method::GET,
        "/api/machines",
        None,
        Some("token"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["machines"].as_array().unwrap().len(), 2);

    let id = second["machine"]["id"].as_str().unwrap();
    let (status, deduplicated) = machine_request(
        app.clone(),
        Method::PATCH,
        &format!("/api/machines/{id}"),
        Some(json!({ "label": "Windows device" })),
        Some("token"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(deduplicated["machine"]["id"], id);
    assert_eq!(deduplicated["machine"]["label"], "Windows device 2");

    let (status, renamed) = machine_request(
        app,
        Method::PATCH,
        &format!("/api/machines/{id}"),
        Some(json!({ "label": "Garage server" })),
        Some("token"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(renamed["machine"]["id"], id);
    assert_eq!(renamed["machine"]["label"], "Garage server");
}

fn snapshot_file_bytes(dir: &std::path::Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_file())
                .map(|_| {
                    let path = entry.path();
                    (
                        entry.file_name().to_string_lossy().into_owned(),
                        std::fs::read(path).unwrap(),
                    )
                })
        })
        .collect()
}

fn test_record(tab_key: &str, updated_at: i64) -> serde_json::Value {
    json!({
        "tabKey": tab_key,
        "tabId": tab_key,
        "tabName": "work",
        "status": "open",
        "revision": 1,
        "updatedAt": updated_at,
        "createdAt": updated_at,
        "paneCount": 1,
        "titleSetByUser": false,
        "panes": [],
    })
}

async fn machine_request(
    app: axum::Router,
    method: Method,
    uri: &str,
    body: Option<serde_json::Value>,
    token: Option<&str>,
) -> (StatusCode, serde_json::Value) {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        request = request.header("x-auth-token", token);
    }
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = app.oneshot(request.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    )
}

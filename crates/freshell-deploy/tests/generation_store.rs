#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use freshell_deploy::{
    DeployError, DeployPort, DeploymentLock, Generation, GenerationManifest, GenerationStage,
    LiveReceipt, Store, StorePaths,
};
use tempfile::TempDir;

fn checkout() -> TempDir {
    let root = tempfile::tempdir().expect("temporary checkout");
    fs::write(root.path().join(".git"), "gitdir: fixture\n").expect("worktree marker");
    root
}

fn source_tree(parent: &Path, marker: &str) -> PathBuf {
    let root = parent.join(format!("source-{marker}"));
    fs::create_dir(&root).expect("source root");
    fs::create_dir(root.join("client")).expect("client dir");
    fs::write(root.join("client/index.html"), marker).expect("client file");
    fs::write(root.join("freshell-server"), format!("binary-{marker}")).expect("server file");
    fs::set_permissions(
        root.join("freshell-server"),
        fs::Permissions::from_mode(0o755),
    )
    .expect("server mode");
    symlink("client/index.html", root.join("entry-link")).expect("relative link");
    root
}

fn store(root: &Path, port: u16) -> Store {
    Store::open(root, DeployPort::new(port).expect("valid port")).expect("open store")
}

fn import_tree(store: &Store, source: &Path) -> freshell_deploy::Result<Generation> {
    store.lock()?.import_tree(source)
}

fn begin_generation(store: &Store) -> freshell_deploy::Result<GenerationStage> {
    store.lock()?.begin_generation()
}

fn select_generation(store: &Store, id: &str) -> freshell_deploy::Result<()> {
    store.lock()?.select_generation(id)
}

fn write_live(store: &Store, receipt: &LiveReceipt) -> freshell_deploy::Result<()> {
    store.lock()?.write_live(receipt)
}

fn remove_generation(store: &Store, id: &str) -> freshell_deploy::Result<()> {
    store.lock()?.remove_generation(id)
}

#[test]
fn rejects_invalid_ports_before_creating_store_paths() {
    for invalid in ["", "0", "00", "03", "65536", "-1", "+1", " 3002", "3002 "] {
        assert!(
            DeployPort::parse(invalid).is_err(),
            "{invalid:?} must be rejected"
        );
    }
    assert_eq!(
        DeployPort::parse("3002").expect("canonical port").get(),
        3002
    );
    assert!(serde_json::from_str::<DeployPort>("0").is_err());
}

#[test]
fn rejects_relative_symlinked_and_unsafe_checkout_roots() {
    assert!(matches!(
        StorePaths::new(Path::new("relative"), DeployPort::new(3002).unwrap()),
        Err(DeployError::UnsafeCheckout(_))
    ));
    assert!(matches!(
        StorePaths::new(Path::new("/"), DeployPort::new(3002).unwrap()),
        Err(DeployError::UnsafeCheckout(_))
    ));

    let fixture = checkout();
    let link_parent = tempfile::tempdir().expect("link parent");
    let link = link_parent.path().join("checkout-link");
    symlink(fixture.path(), &link).expect("checkout symlink");
    assert!(matches!(
        StorePaths::new(&link, DeployPort::new(3002).unwrap()),
        Err(DeployError::UnsafeCheckout(_))
    ));
}

#[test]
fn rejects_a_symlink_in_the_authoritative_store_path() {
    let fixture = checkout();
    let elsewhere = tempfile::tempdir().expect("elsewhere");
    symlink(elsewhere.path(), fixture.path().join(".freshell-deploy")).expect("store symlink");

    assert!(matches!(
        Store::open(fixture.path(), DeployPort::new(3002).unwrap()),
        Err(DeployError::UnsafeStorePath(_))
    ));
}

#[test]
fn rejects_preexisting_store_directories_that_are_not_private_and_owned() {
    let fixture = checkout();
    let store_root = fixture.path().join(".freshell-deploy");
    fs::create_dir(&store_root).expect("preexisting store root");
    fs::set_permissions(&store_root, fs::Permissions::from_mode(0o755))
        .expect("permissive store mode");

    assert!(matches!(
        Store::open(fixture.path(), DeployPort::new(3002).unwrap()),
        Err(DeployError::UnsafeStorePath(path)) if path == store_root
    ));
}

#[test]
fn generation_publication_is_exclusive_and_never_hardlinks_build_output() {
    let fixture = checkout();
    let source = source_tree(fixture.path(), "one");
    let store = store(fixture.path(), 3311);

    let published = import_tree(&store, &source).expect("first publication");
    let second = import_tree(&store, &source).expect_err("same id is exclusive");
    assert!(matches!(second, DeployError::GenerationExists(id) if id == published.id));

    let source_meta = fs::metadata(source.join("client/index.html")).unwrap();
    let stored_meta =
        fs::metadata(published.path.join("client/index.html")).expect("stored client");
    assert_ne!(
        (source_meta.dev(), source_meta.ino()),
        (stored_meta.dev(), stored_meta.ino()),
        "generation files must not be hardlinks to mutable build output"
    );
    fs::write(source.join("client/index.html"), "mutated build").expect("mutate source");
    assert_eq!(
        fs::read_to_string(published.path.join("client/index.html")).unwrap(),
        "one"
    );
}

#[test]
fn import_stages_beside_generations_so_cross_device_sources_are_copied() {
    let fixture = checkout();
    let store = store(fixture.path(), 3312);
    let source_parent = if Path::new("/dev/shm").is_dir() {
        tempfile::Builder::new()
            .prefix("freshell-deploy-source-")
            .tempdir_in("/dev/shm")
            .unwrap_or_else(|_| tempfile::tempdir().expect("fallback source parent"))
    } else {
        tempfile::tempdir().expect("source parent")
    };
    let source = source_tree(source_parent.path(), "cross-device");

    let published = import_tree(&store, &source).expect("cross-device import");

    assert_eq!(
        store.staging_parent(),
        store.paths().generations_dir(),
        "publication temporaries must be siblings of final generations"
    );
    assert_eq!(
        fs::read_to_string(published.path.join("client/index.html")).unwrap(),
        "cross-device"
    );
    assert!(
        source.exists(),
        "an import copies; it never renames the source"
    );
}

#[test]
fn verification_rejects_digest_mismatch() {
    let fixture = checkout();
    let source = source_tree(fixture.path(), "digest");
    let store = store(fixture.path(), 3313);
    let published = import_tree(&store, &source).expect("publication");
    fs::set_permissions(
        published.path.join("client/index.html"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    fs::write(published.path.join("client/index.html"), "corrupt").unwrap();
    fs::set_permissions(
        published.path.join("client/index.html"),
        fs::Permissions::from_mode(0o444),
    )
    .unwrap();

    assert!(matches!(
        store.verify_generation(&published.id),
        Err(DeployError::DigestMismatch { .. })
    ));
}

#[test]
fn verification_rejects_mode_mismatch() {
    let fixture = checkout();
    let source = source_tree(fixture.path(), "mode");
    let store = store(fixture.path(), 3314);
    let published = import_tree(&store, &source).expect("publication");
    let server = published.path.join("freshell-server");
    fs::set_permissions(&server, fs::Permissions::from_mode(0o755)).unwrap();

    assert!(matches!(
        store.verify_generation(&published.id),
        Err(DeployError::ModeMismatch { .. })
    ));
}

#[test]
fn verification_rejects_a_writable_authoritative_manifest() {
    let fixture = checkout();
    let source = source_tree(fixture.path(), "manifest-mode");
    let store = store(fixture.path(), 3320);
    let published = import_tree(&store, &source).expect("publication");
    let manifest = published.path.join("manifest.json");
    fs::set_permissions(&manifest, fs::Permissions::from_mode(0o644)).unwrap();

    assert!(matches!(
        store.verify_generation(&published.id),
        Err(DeployError::ModeMismatch {
            expected: 0o444,
            actual: 0o644,
            ..
        })
    ));
}

#[test]
fn verification_rejects_a_writable_generation_root() {
    let fixture = checkout();
    let source = source_tree(fixture.path(), "root-mode");
    let store = store(fixture.path(), 3323);
    let published = import_tree(&store, &source).expect("publication");
    fs::set_permissions(&published.path, fs::Permissions::from_mode(0o700)).unwrap();

    assert!(matches!(
        store.verify_generation(&published.id),
        Err(DeployError::ModeMismatch {
            expected: 0o500,
            actual: 0o700,
            ..
        })
    ));
}

#[test]
fn strict_manifest_rejects_unknown_duplicate_and_unsafe_paths() {
    let unknown = br#"{"schemaVersion":"1","generationId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entries":[],"extra":true}"#;
    assert!(matches!(
        GenerationManifest::from_json(unknown),
        Err(DeployError::InvalidManifest(_))
    ));

    let duplicate = br#"{"schemaVersion":"1","generationId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","generationId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","entries":[]}"#;
    assert!(matches!(
        GenerationManifest::from_json(duplicate),
        Err(DeployError::InvalidManifest(_))
    ));

    let unsafe_path = br#"{"schemaVersion":"1","generationId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","entries":[{"path":"../escape","type":"file","mode":292,"symlinkTarget":null,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]}"#;
    assert!(matches!(
        GenerationManifest::from_json(unsafe_path),
        Err(DeployError::InvalidManifest(_))
    ));
}

#[test]
fn import_refuses_to_overwrite_a_source_manifest_path() {
    let fixture = checkout();
    let source = source_tree(fixture.path(), "reserved-manifest");
    fs::write(source.join("manifest.json"), "operator-owned").unwrap();
    let store = store(fixture.path(), 3321);

    assert!(matches!(
        import_tree(&store, &source),
        Err(DeployError::InvalidManifest(message)) if message.contains("reserved")
    ));
}

#[test]
fn deployment_lock_excludes_concurrent_writer_and_releases_on_drop() {
    let fixture = checkout();
    let store = store(fixture.path(), 3315);
    let first = DeploymentLock::try_acquire(store.paths()).expect("first lock");
    assert!(matches!(
        DeploymentLock::try_acquire(store.paths()),
        Err(DeployError::LockBusy(_))
    ));
    drop(first);
    DeploymentLock::try_acquire(store.paths()).expect("lock after drop");
}

#[test]
fn deployment_lock_rejects_a_preexisting_non_private_file() {
    let fixture = checkout();
    let store = store(fixture.path(), 3325);
    fs::write(store.paths().lock_file(), "").expect("preexisting lock");
    fs::set_permissions(store.paths().lock_file(), fs::Permissions::from_mode(0o644))
        .expect("permissive lock mode");

    assert!(matches!(
        DeploymentLock::try_acquire(store.paths()),
        Err(DeployError::UnsafeStorePath(path)) if path == store.paths().lock_file()
    ));
}

#[test]
fn current_pointer_switch_is_atomic_for_concurrent_readers() {
    let fixture = checkout();
    let store = Arc::new(store(fixture.path(), 3316));
    let first = import_tree(&store, &source_tree(fixture.path(), "first")).unwrap();
    let second = import_tree(&store, &source_tree(fixture.path(), "second")).unwrap();
    select_generation(&store, &first.id).expect("initial selection");

    let stop = Arc::new(AtomicBool::new(false));
    let reader_store = Arc::clone(&store);
    let reader_stop = Arc::clone(&stop);
    let first_id = first.id.clone();
    let second_id = second.id.clone();
    let reader = std::thread::spawn(move || {
        while !reader_stop.load(Ordering::Relaxed) {
            let selected = reader_store
                .selected_generation_id()
                .expect("atomic pointer must always be readable")
                .expect("selection exists");
            assert!(selected == first_id || selected == second_id);
        }
    });

    for index in 0..100 {
        let id = if index % 2 == 0 {
            &second.id
        } else {
            &first.id
        };
        select_generation(&store, id).expect("pointer switch");
    }
    stop.store(true, Ordering::Relaxed);
    reader.join().expect("reader");
    assert_eq!(
        store.selected_generation_id().unwrap().as_deref(),
        Some(first.id.as_str())
    );
    let temporary_pointer_count = fs::read_dir(store.paths().port_root())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains("current.tmp"))
        .count();
    assert_eq!(temporary_pointer_count, 0);
}

#[test]
fn live_receipt_keeps_selected_and_running_server_generation_ids_separate() {
    let fixture = checkout();
    let store = store(fixture.path(), 3317);
    let running = import_tree(&store, &source_tree(fixture.path(), "running")).unwrap();
    let selected = import_tree(&store, &source_tree(fixture.path(), "selected")).unwrap();
    select_generation(&store, &selected.id).unwrap();
    write_live(
        &store,
        &LiveReceipt::new(selected.id.clone(), Some(running.id.clone()), false, None),
    )
    .expect("write live receipt");

    let receipt = store.read_live().expect("read live").expect("live receipt");
    assert_eq!(receipt.selected_generation_id, selected.id);
    assert_eq!(
        receipt.running_server_generation_id.as_deref(),
        Some(running.id.as_str())
    );
}

#[test]
fn cleanup_refuses_the_distinct_still_running_server_generation() {
    let fixture = checkout();
    let store = store(fixture.path(), 3322);
    let running = import_tree(&store, &source_tree(fixture.path(), "running-retained")).unwrap();
    let selected = import_tree(&store, &source_tree(fixture.path(), "selected-retained")).unwrap();
    select_generation(&store, &selected.id).unwrap();
    write_live(
        &store,
        &LiveReceipt::new(selected.id.clone(), Some(running.id.clone()), false, None),
    )
    .unwrap();

    assert!(matches!(
        remove_generation(&store, &running.id),
        Err(DeployError::RunningGeneration(id)) if id == running.id
    ));
    store.verify_generation(&running.id).unwrap();
}

#[test]
fn cleanup_refuses_an_inconsistent_live_receipt_and_current_pointer() {
    let fixture = checkout();
    let store = store(fixture.path(), 3324);
    let selected =
        import_tree(&store, &source_tree(fixture.path(), "selected-consistent")).unwrap();
    let running = import_tree(&store, &source_tree(fixture.path(), "running-consistent")).unwrap();
    let obsolete =
        import_tree(&store, &source_tree(fixture.path(), "obsolete-consistent")).unwrap();
    select_generation(&store, &selected.id).unwrap();
    write_live(
        &store,
        &LiveReceipt::new(selected.id.clone(), Some(running.id), false, None),
    )
    .unwrap();
    let mut live: serde_json::Value =
        serde_json::from_slice(&fs::read(store.paths().live_receipt()).unwrap()).unwrap();
    live["selectedGenerationId"] = serde_json::Value::String(obsolete.id.clone());
    fs::write(
        store.paths().live_receipt(),
        serde_json::to_vec(&live).unwrap(),
    )
    .unwrap();

    assert!(matches!(
        remove_generation(&store, &obsolete.id),
        Err(DeployError::InvalidReceipt(message)) if message.contains("current")
    ));
    store.verify_generation(&obsolete.id).unwrap();
}

#[test]
fn cleanup_refuses_to_remove_a_generation_with_any_unmanifested_path() {
    let fixture = checkout();
    let store = store(fixture.path(), 3318);
    let published = import_tree(&store, &source_tree(fixture.path(), "cleanup")).unwrap();
    fs::set_permissions(&published.path, fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(published.path.join("operator-notes"), "do not delete").unwrap();
    fs::set_permissions(&published.path, fs::Permissions::from_mode(0o500)).unwrap();

    assert!(matches!(
        remove_generation(&store, &published.id),
        Err(DeployError::UnmanifestedPath(path)) if path.ends_with("operator-notes")
    ));
    assert!(published.path.exists());
    assert!(published.path.join("operator-notes").exists());
}

#[test]
fn cleanup_refuses_when_the_authoritative_receipt_set_is_missing() {
    let fixture = checkout();
    let store = store(fixture.path(), 3326);
    let selected =
        import_tree(&store, &source_tree(fixture.path(), "selected-no-receipts")).unwrap();
    let obsolete =
        import_tree(&store, &source_tree(fixture.path(), "obsolete-no-receipts")).unwrap();
    select_generation(&store, &selected.id).unwrap();

    assert!(matches!(
        remove_generation(&store, &obsolete.id),
        Err(DeployError::InvalidReceipt(message)) if message.contains("authoritative")
    ));
    store.verify_generation(&obsolete.id).unwrap();
}

#[test]
fn abandoned_stage_cleanup_also_refuses_any_unmanifested_path() {
    let fixture = checkout();
    let store = store(fixture.path(), 3319);
    let mut stage = begin_generation(&store).unwrap();
    stage
        .write_bytes(Path::new("known"), b"manifested", 0o644)
        .unwrap();
    stage.seal().unwrap();
    let stage_path = stage.path().to_path_buf();
    fs::set_permissions(&stage_path, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(stage_path.join("operator-notes"), "do not delete").unwrap();

    drop(stage);

    assert!(
        stage_path.join("operator-notes").exists(),
        "an abandoned stage with an unmanifested path must be retained for inspection"
    );
}

#[test]
fn abandoned_stage_cleanup_never_follows_a_replaced_stage_root_symlink() {
    let fixture = checkout();
    let store = store(fixture.path(), 3327);
    let mut stage = begin_generation(&store).unwrap();
    stage
        .write_bytes(Path::new("known"), b"manifested", 0o644)
        .unwrap();
    stage.seal().unwrap();
    let stage_path = stage.path().to_path_buf();
    let moved_path = stage_path.with_file_name("operator-owned-stage-target");
    fs::rename(&stage_path, &moved_path).unwrap();
    symlink(&moved_path, &stage_path).unwrap();

    drop(stage);

    assert_eq!(
        fs::read(moved_path.join("known")).unwrap(),
        b"manifested",
        "drop cleanup must never traverse a replaced stage root"
    );
    assert!(moved_path.join("manifest.json").is_file());
}

#[test]
fn publication_rereads_the_sealed_root_and_authoritative_manifest() {
    let fixture = checkout();
    let store = store(fixture.path(), 3328);
    let locked = store.lock().unwrap();
    let mut stage = locked.begin_generation().unwrap();
    stage
        .write_bytes(Path::new("known"), b"manifested", 0o644)
        .unwrap();
    stage.seal().unwrap();
    let stage_path = stage.path().to_path_buf();
    let manifest_path = stage_path.join("manifest.json");
    fs::set_permissions(&manifest_path, fs::Permissions::from_mode(0o644)).unwrap();
    fs::write(&manifest_path, b"{}\n").unwrap();
    fs::set_permissions(&manifest_path, fs::Permissions::from_mode(0o444)).unwrap();

    assert!(matches!(
        locked.publish(stage),
        Err(DeployError::InvalidManifest(_))
    ));
    assert!(
        stage_path.exists(),
        "a changed sealed tree is retained rather than published or cleaned"
    );
}

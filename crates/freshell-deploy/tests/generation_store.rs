#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use freshell_deploy::{
    DeployError, DeployPort, DeploymentLock, FileIdentity, Generation, GenerationManifest,
    GenerationStage, ListenerIdentity, LiveReceipt, ProcessIdentity, RuntimeProvenance, Store,
    StorePaths,
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
    fs::create_dir(root.join("server")).expect("server dir");
    fs::write(
        root.join("server/freshell-server"),
        format!("binary-{marker}"),
    )
    .expect("server file");
    fs::set_permissions(
        root.join("server/freshell-server"),
        fs::Permissions::from_mode(0o755),
    )
    .expect("server mode");
    for directory in [
        "extensions",
        "dist/server/mcp",
        "claude-sidecar",
        "node_modules",
    ] {
        fs::create_dir_all(root.join(directory)).unwrap();
    }
    fs::write(root.join("dist/server/mcp/server.js"), "export {}").unwrap();
    fs::write(root.join("claude-sidecar/index.mjs"), "export {}").unwrap();
    fs::write(root.join("package.json"), "{}").unwrap();
    fs::write(root.join("package-lock.json"), "{}").unwrap();
    symlink("client/index.html", root.join("entry-link")).expect("relative link");
    root
}

fn running_identity(generation: &Generation, port: u16) -> ProcessIdentity {
    let path = |relative: &str| generation.path.join(relative).display().to_string();
    ProcessIdentity {
        pid: 42_424,
        kernel_boot_id: "11111111-2222-3333-4444-555555555555".to_string(),
        start_time_ticks: "123456789".to_string(),
        executable: FileIdentity::from_path(&generation.path.join("server/freshell-server"))
            .unwrap(),
        listener: ListenerIdentity {
            port: DeployPort::new(port).unwrap(),
            socket_inode: "991122".to_string(),
            owner_pid: 42_424,
            network_namespace: "net:[4026533111]".to_string(),
        },
        cwd: generation.path.display().to_string(),
        argv0: "freshell-server".to_string(),
        argument_count: 1,
        effective_uid: unsafe { libc::geteuid() },
        runtime: RuntimeProvenance {
            client_dir: generation
                .path
                .parent()
                .and_then(Path::parent)
                .unwrap()
                .join("current/client")
                .display()
                .to_string(),
            extensions_dir: path("extensions"),
            dist_server_dir: path("dist/server"),
            mcp_entry: path("dist/server/mcp/server.js"),
            claude_sidecar_entry: path("claude-sidecar/index.mjs"),
            node_executable: "/usr/bin/node".to_string(),
            package_json: path("package.json"),
            package_lock: path("package-lock.json"),
            production_node_modules: path("node_modules"),
        },
    }
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

fn prune_generations(
    store: &Store,
    retain_unprotected: usize,
) -> freshell_deploy::Result<Vec<String>> {
    store.lock()?.prune_generations(retain_unprotected)
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
fn import_rejects_either_direction_of_store_containment_before_staging() {
    let fixture = checkout();
    let store = store(fixture.path(), 3327);
    let before = fs::read_dir(store.paths().generations_dir())
        .unwrap()
        .count();

    for source in [fixture.path(), store.paths().port_root()] {
        assert!(matches!(
            import_tree(&store, source),
            Err(DeployError::UnsafeStorePath(path)) if path == fs::canonicalize(source).unwrap()
        ));
        assert_eq!(
            fs::read_dir(store.paths().generations_dir())
                .unwrap()
                .count(),
            before,
            "a rejected recursive import must not create a stage"
        );
    }
}

#[test]
fn stage_copy_rejects_a_canonical_source_inside_the_store() {
    let fixture = checkout();
    let store = store(fixture.path(), 3331);
    let source = store.paths().store_root().join("runtime-source");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("index.html"), "store-contained source").unwrap();
    let mut stage = begin_generation(&store).unwrap();

    assert!(matches!(
        stage.copy_tree(&source, Path::new("client")),
        Err(DeployError::UnsafeStorePath(path)) if path == fs::canonicalize(&source).unwrap()
    ));
    assert!(!stage.path().join("client").exists());
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
    let server = published.path.join("server/freshell-server");
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
        &LiveReceipt::new(
            selected.id.clone(),
            Some(running.id.clone()),
            false,
            Some(running_identity(&running, 3317)),
        ),
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
    let obsolete = import_tree(&store, &source_tree(fixture.path(), "obsolete-retained")).unwrap();
    select_generation(&store, &selected.id).unwrap();
    write_live(
        &store,
        &LiveReceipt::new(
            selected.id.clone(),
            Some(running.id.clone()),
            false,
            Some(running_identity(&running, 3322)),
        ),
    )
    .unwrap();

    assert!(matches!(
        remove_generation(&store, &running.id),
        Err(DeployError::RunningGeneration(id)) if id == running.id
    ));
    store.verify_generation(&running.id).unwrap();
    assert_eq!(prune_generations(&store, 0).unwrap(), vec![obsolete.id]);
    store.verify_generation(&selected.id).unwrap();
    store.verify_generation(&running.id).unwrap();
}

#[test]
fn retention_bounds_complete_unprotected_generations() {
    let fixture = checkout();
    let store = store(fixture.path(), 3331);
    let generations = (0..6)
        .map(|index| {
            import_tree(
                &store,
                &source_tree(fixture.path(), &format!("retention-{index}")),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    let selected = generations.last().unwrap();
    select_generation(&store, &selected.id).unwrap();
    write_live(
        &store,
        &LiveReceipt::new(selected.id.clone(), None, false, None),
    )
    .unwrap();

    let removed = prune_generations(&store, 2).unwrap();
    assert_eq!(removed.len(), 3);
    assert!(store.verify_generation(&selected.id).is_ok());
    let complete_generations = fs::read_dir(store.paths().generations_dir())
        .unwrap()
        .filter_map(|entry| {
            let entry = entry.unwrap();
            (!entry.file_name().to_string_lossy().starts_with(".stage-")).then_some(entry)
        })
        .count();
    assert_eq!(
        complete_generations, 3,
        "selected plus the two newest unprotected generations are retained"
    );
}

#[test]
fn live_receipt_rejects_a_process_claiming_an_unrelated_running_generation() {
    let fixture = checkout();
    let store = store(fixture.path(), 3328);
    let actual = import_tree(&store, &source_tree(fixture.path(), "actual-running")).unwrap();
    let claimed = import_tree(&store, &source_tree(fixture.path(), "claimed-running")).unwrap();
    select_generation(&store, &claimed.id).unwrap();

    assert!(matches!(
        write_live(
            &store,
            &LiveReceipt::new(
                claimed.id.clone(),
                Some(claimed.id.clone()),
                false,
                Some(running_identity(&actual, 3328)),
            ),
        ),
        Err(DeployError::InvalidReceipt(message))
            if message.contains("executable") || message.contains("cwd")
    ));
    assert!(store.read_live().unwrap().is_none());
}

#[test]
fn live_receipt_binds_generation_root_cwd_and_runtime_provenance() {
    let fixture = checkout();
    let store = store(fixture.path(), 3330);
    let generation = import_tree(&store, &source_tree(fixture.path(), "bound-runtime")).unwrap();
    select_generation(&store, &generation.id).unwrap();

    let mut wrong_cwd = running_identity(&generation, 3330);
    wrong_cwd.cwd = fixture.path().display().to_string();
    assert!(matches!(
        write_live(
            &store,
            &LiveReceipt::new(
                generation.id.clone(),
                Some(generation.id.clone()),
                false,
                Some(wrong_cwd),
            ),
        ),
        Err(DeployError::InvalidReceipt(message)) if message.contains("cwd")
    ));

    let mut wrong_runtime = running_identity(&generation, 3330);
    wrong_runtime.runtime.client_dir = fixture
        .path()
        .join("unrelated-client")
        .display()
        .to_string();
    assert!(matches!(
        write_live(
            &store,
            &LiveReceipt::new(
                generation.id.clone(),
                Some(generation.id.clone()),
                false,
                Some(wrong_runtime),
            ),
        ),
        Err(DeployError::InvalidReceipt(message)) if message.contains("provenance")
    ));
}

#[test]
fn cleanup_fails_closed_if_a_stored_live_process_generation_binding_is_forged() {
    let fixture = checkout();
    let store = store(fixture.path(), 3329);
    let actual = import_tree(&store, &source_tree(fixture.path(), "actual-forged")).unwrap();
    let claimed = import_tree(&store, &source_tree(fixture.path(), "claimed-forged")).unwrap();
    let obsolete = import_tree(&store, &source_tree(fixture.path(), "obsolete-forged")).unwrap();
    select_generation(&store, &claimed.id).unwrap();
    write_live(
        &store,
        &LiveReceipt::new(
            claimed.id.clone(),
            Some(actual.id.clone()),
            false,
            Some(running_identity(&actual, 3329)),
        ),
    )
    .unwrap();
    let mut forged: serde_json::Value =
        serde_json::from_slice(&fs::read(store.paths().live_receipt()).unwrap()).unwrap();
    forged["runningServerGenerationId"] = serde_json::Value::String(claimed.id.clone());
    fs::write(
        store.paths().live_receipt(),
        serde_json::to_vec(&forged).unwrap(),
    )
    .unwrap();

    assert!(matches!(
        remove_generation(&store, &obsolete.id),
        Err(DeployError::InvalidReceipt(message))
            if message.contains("executable") || message.contains("cwd")
    ));
    store.verify_generation(&obsolete.id).unwrap();
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
        &LiveReceipt::new(
            selected.id.clone(),
            Some(running.id.clone()),
            false,
            Some(running_identity(&running, 3324)),
        ),
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
fn cleanup_does_not_require_a_legacy_receipt_for_a_managed_fresh_store() {
    let fixture = checkout();
    let store = store(fixture.path(), 3326);
    let selected =
        import_tree(&store, &source_tree(fixture.path(), "selected-no-receipts")).unwrap();
    let obsolete =
        import_tree(&store, &source_tree(fixture.path(), "obsolete-no-receipts")).unwrap();
    select_generation(&store, &selected.id).unwrap();

    write_live(
        &store,
        &LiveReceipt::new(selected.id.clone(), None, false, None),
    )
    .unwrap();
    remove_generation(&store, &obsolete.id).unwrap();
    assert!(matches!(
        store.verify_generation(&obsolete.id),
        Err(DeployError::GenerationMissing(id)) if id == obsolete.id
    ));
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
fn unsealed_controller_owned_stage_is_removed_on_drop() {
    let fixture = checkout();
    let store = store(fixture.path(), 3332);
    let mut stage = begin_generation(&store).unwrap();
    stage
        .write_bytes(Path::new("partial/nested"), b"partial assembly", 0o644)
        .unwrap();
    let stage_path = stage.path().to_path_buf();

    drop(stage);

    assert!(
        !stage_path.exists(),
        "a failed pre-seal assembly must not leak its private staging closure"
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

use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use freshell_deploy::{
    assemble_generation, inspect_bootstrap_status, BootstrapStatus, ControllerCommand,
    DeployCommand, FileIdentity, LaunchAttemptReceipt, LaunchAttemptReceiptStore, LaunchClaim,
    LaunchExecutorIdentity, LaunchLane, LiveReceipt, NodePrerequisite, ServerAssemblySources,
    Store, UpdateMode,
};

const GENERATION: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn executable(path: &Path) -> FileIdentity {
    fs::write(path, b"fixture executable").unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    FileIdentity::from_path(path).unwrap()
}

fn claim(root: &Path, claim_id: &str, pid: u32) -> LaunchClaim {
    let executable_path = root.join("server");
    let executable = if executable_path.exists() {
        FileIdentity::from_path(&executable_path).unwrap()
    } else {
        executable(&executable_path)
    };
    LaunchClaim {
        schema_version: "1".to_string(),
        claim_id: claim_id.to_string(),
        transaction_id: "transaction".to_string(),
        nonce: "nonce".to_string(),
        attempt_id: "target-gated-0".to_string(),
        receipt_file: root.join("launch-target-gated-0.json"),
        lane: LaunchLane::TargetGated,
        generation_id: GENERATION.to_string(),
        port: freshell_deploy::DeployPort::new(43_127).unwrap(),
        executor: LaunchExecutorIdentity {
            pid,
            kernel_boot_id: "11111111-2222-3333-4444-555555555555".to_string(),
            start_time_ticks: pid.to_string(),
            executable,
            cwd: root.display().to_string(),
            effective_uid: unsafe { libc::geteuid() },
        },
    }
}

#[test]
fn launch_receipt_claim_is_create_new_and_returns_the_single_durable_owner() {
    let fixture = tempfile::tempdir().unwrap();
    let path = fixture.path().join("launch-target-gated-0.json");
    let store = LaunchAttemptReceiptStore::new(&path).unwrap();
    let first = claim(fixture.path(), "first", 7101);
    let second = claim(fixture.path(), "second", 7102);

    assert_eq!(
        store.claim(&first).unwrap(),
        LaunchAttemptReceipt::Owned {
            claim: first.clone()
        }
    );
    assert_eq!(
        store.claim(&second).unwrap(),
        LaunchAttemptReceipt::Owned {
            claim: first.clone()
        },
        "a losing helper observes the existing owner and must not execute"
    );
    assert_eq!(
        store.read().unwrap(),
        Some(LaunchAttemptReceipt::Owned { claim: first })
    );
}

#[test]
fn only_the_exact_owner_can_publish_definitely_not_started() {
    let fixture = tempfile::tempdir().unwrap();
    let path = fixture.path().join("launch-target-gated-0.json");
    let store = LaunchAttemptReceiptStore::new(&path).unwrap();
    let first = claim(fixture.path(), "first", 7201);
    let second = claim(fixture.path(), "second", 7202);
    store.claim(&first).unwrap();

    assert!(store.mark_definitely_not_started(&second).is_err());
    assert_eq!(
        store.mark_definitely_not_started(&first).unwrap(),
        LaunchAttemptReceipt::DefinitelyNotStarted {
            claim: first.clone()
        }
    );
    assert_eq!(
        store.claim(&first).unwrap(),
        LaunchAttemptReceipt::DefinitelyNotStarted { claim: first },
        "terminal launch evidence is monotonic"
    );
}

#[test]
fn launch_receipts_reject_symlinks_wrong_modes_and_malformed_json() {
    let fixture = tempfile::tempdir().unwrap();
    let target = fixture.path().join("target");
    fs::write(&target, b"{}\n").unwrap();
    let link = fixture.path().join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(LaunchAttemptReceiptStore::new(&link)
        .unwrap()
        .read()
        .is_err());

    let malformed = fixture.path().join("malformed");
    fs::write(&malformed, b"{}\n").unwrap();
    fs::set_permissions(&malformed, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(LaunchAttemptReceiptStore::new(&malformed)
        .unwrap()
        .read()
        .is_err());

    let writable = fixture.path().join("writable");
    fs::write(&writable, b"{}\n").unwrap();
    fs::set_permissions(&writable, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(LaunchAttemptReceiptStore::new(&writable)
        .unwrap()
        .read()
        .is_err());
}

fn parse(arguments: &[&str]) -> freshell_deploy::Result<ControllerCommand> {
    ControllerCommand::parse(arguments.iter().map(OsString::from))
}

#[test]
fn controller_parser_rejects_duplicate_unknown_and_noncanonical_options() {
    for arguments in [
        vec![
            "bootstrap-status",
            "--checkout",
            "/tmp/a",
            "--checkout",
            "/tmp/a",
            "--port",
            "43127",
        ],
        vec![
            "bootstrap-status",
            "--checkout",
            "/tmp/a",
            "--port",
            "043127",
        ],
        vec!["bootstrap-status", "--checkout", "/tmp/a", "--port", "0"],
        vec![
            "bootstrap-status",
            "--checkout",
            "/tmp/a",
            "--port",
            "65536",
        ],
        vec![
            "bootstrap-status",
            "--checkout",
            "/tmp/a",
            "--port",
            "43127",
            "--wat",
            "x",
        ],
        vec![
            "deploy",
            "--checkout",
            "/tmp/a",
            "--port",
            "43127",
            "--mode",
            "wat",
        ],
        vec![
            "start-current",
            "--checkout",
            "/tmp/a",
            "--port",
            "43127",
            "extra",
        ],
    ] {
        assert!(
            parse(&arguments).is_err(),
            "unexpectedly accepted {arguments:?}"
        );
    }
}

#[test]
fn controller_parser_models_each_wrapper_command_without_optional_ambiguity() {
    assert!(matches!(
        parse(&[
            "bootstrap-status",
            "--checkout",
            "/tmp/a",
            "--port",
            "43127"
        ])
        .unwrap(),
        ControllerCommand::BootstrapStatus { .. }
    ));
    assert!(matches!(
        parse(&["start-current", "--checkout", "/tmp/a", "--port", "43127"]).unwrap(),
        ControllerCommand::StartCurrent { restart: false, .. }
    ));
    assert!(matches!(
        parse(&["restart-current", "--checkout", "/tmp/a", "--port", "43127"]).unwrap(),
        ControllerCommand::StartCurrent { restart: true, .. }
    ));
    assert!(matches!(
        parse(&["stop-current", "--checkout", "/tmp/a", "--port", "43127"]).unwrap(),
        ControllerCommand::StopCurrent { .. }
    ));
}

#[test]
fn production_binary_routes_strict_controller_commands() {
    let fixture = tempfile::tempdir().unwrap();
    let checkout = fixture.path().join("checkout");
    fs::create_dir(&checkout).unwrap();
    fs::write(checkout.join(".git"), "gitdir: /tmp/fixture.git\n").unwrap();
    let binary = env!("CARGO_BIN_EXE_freshell-deploy");

    let status = Command::new(binary)
        .args([
            "bootstrap-status",
            "--checkout",
            checkout.to_str().unwrap(),
            "--port",
            "43127",
        ])
        .output()
        .unwrap();
    assert!(status.status.success());
    assert_eq!(
        String::from_utf8(status.stdout).unwrap(),
        "capture-required\n"
    );

    let malformed = Command::new(binary)
        .args([
            "bootstrap-status",
            "--checkout",
            checkout.to_str().unwrap(),
            "--port",
            "43127",
            "--port",
            "43127",
        ])
        .output()
        .unwrap();
    assert_eq!(malformed.status.code(), Some(2));
}

#[test]
fn deployment_modes_require_exact_component_sources() {
    let base = [
        "deploy",
        "--checkout",
        "/tmp/a",
        "--port",
        "43127",
        "--node-executable",
        "/usr/bin/node",
        "--node-version",
        "v22.0.0",
    ];

    let client = base
        .iter()
        .copied()
        .chain(["--mode", "client-only", "--client-dir", "/tmp/client"])
        .collect::<Vec<_>>();
    assert!(parse(&client).is_ok());

    let missing_client = base
        .iter()
        .copied()
        .chain(["--mode", "client-only"])
        .collect::<Vec<_>>();
    assert!(parse(&missing_client).is_err());

    let server = base
        .iter()
        .copied()
        .chain([
            "--mode",
            "server",
            "--server-executable",
            "/tmp/server",
            "--controller-executable",
            "/tmp/controller",
            "--extensions-dir",
            "/tmp/extensions",
            "--dist-server-dir",
            "/tmp/dist-server",
            "--mcp-entry-relative",
            "mcp/server.js",
            "--claude-sidecar-dir",
            "/tmp/sidecar",
            "--claude-sidecar-entry-relative",
            "index.mjs",
            "--package-json",
            "/tmp/package.json",
            "--package-lock",
            "/tmp/package-lock.json",
            "--node-modules",
            "/tmp/node_modules",
        ])
        .collect::<Vec<_>>();
    assert!(parse(&server).is_ok());

    let full = server
        .iter()
        .map(|value| if *value == "server" { "full" } else { *value })
        .chain(["--client-dir", "/tmp/client"])
        .collect::<Vec<_>>();
    assert!(parse(&full).is_ok());

    let server_with_client = server
        .iter()
        .copied()
        .chain(["--client-dir", "/tmp/client"])
        .collect::<Vec<_>>();
    assert!(parse(&server_with_client).is_err());
}

fn write(path: impl AsRef<Path>, bytes: impl AsRef<[u8]>) {
    let path = path.as_ref();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn make_executable(path: impl AsRef<Path>, label: &str) {
    let path = path.as_ref();
    write(path, format!("#!/bin/sh\n# {label}\n"));
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn runtime_tree(root: &Path, label: &str, node: &Path) {
    write(root.join("client/index.html"), format!("client {label}\n"));
    write(root.join("client/assets/prior.js"), b"prior asset\n");
    write(root.join("client/deployment-compatibility.json"), b"{}\n");
    make_executable(root.join("server/freshell-server"), label);
    make_executable(root.join("controller/freshell-deploy"), "controller");
    write(root.join("extensions/fixture.json"), b"{}\n");
    write(root.join("dist/server/index.js"), b"export {}\n");
    write(root.join("dist/server/mcp/server.js"), b"export {}\n");
    write(root.join("claude-sidecar/index.mjs"), b"process.exit(0)\n");
    write(root.join("claude-sidecar/package.json"), b"{}\n");
    write(root.join("claude-sidecar/package-lock.json"), b"{}\n");
    write(root.join("package.json"), b"{}\n");
    write(root.join("package-lock.json"), b"{}\n");
    write(
        root.join("node_modules/fixture-package/package.json"),
        b"{}\n",
    );
    let descriptor = serde_json::json!({
        "schemaVersion": "1",
        "controllerExecutable": "controller/freshell-deploy",
        "runtime": {
            "serverExecutable": "server/freshell-server",
            "clientDir": "client",
            "extensionsDir": "extensions",
            "distServerDir": "dist/server",
            "mcpEntry": "dist/server/mcp/server.js",
            "claudeSidecarEntry": "claude-sidecar/index.mjs",
            "packageJson": "package.json",
            "packageLock": "package-lock.json",
            "productionNodeModules": "node_modules"
        },
        "node": {
            "executable": node,
            "version": "v22.0.0"
        }
    });
    write(
        root.join("deployment.json"),
        format!("{}\n", serde_json::to_string(&descriptor).unwrap()),
    );
}

struct AssemblyFixture {
    _temp: tempfile::TempDir,
    checkout: PathBuf,
    store: Store,
    prior_id: String,
    node: PathBuf,
    sources: PathBuf,
}

fn assembly_fixture() -> AssemblyFixture {
    let temp = tempfile::tempdir().unwrap();
    let checkout = temp.path().join("checkout");
    fs::create_dir(&checkout).unwrap();
    fs::write(checkout.join(".git"), "gitdir: /tmp/fixture.git\n").unwrap();
    let node = temp.path().join("node");
    make_executable(&node, "node");
    let prior = temp.path().join("prior");
    fs::create_dir(&prior).unwrap();
    runtime_tree(&prior, "prior", &node);
    let store = Store::open(&checkout, freshell_deploy::DeployPort::new(43_127).unwrap()).unwrap();
    let locked = store.lock().unwrap();
    let generation = locked.import_tree(&prior).unwrap();
    locked.select_generation(&generation.id).unwrap();
    drop(locked);
    let sources = temp.path().join("sources");
    fs::create_dir(&sources).unwrap();
    AssemblyFixture {
        _temp: temp,
        checkout,
        store,
        prior_id: generation.id,
        node,
        sources,
    }
}

#[test]
fn bootstrap_status_requires_complete_receipts_and_recognizes_managed_state() {
    let fixture = assembly_fixture();
    assert!(inspect_bootstrap_status(&fixture.store).is_err());
    let locked = fixture.store.lock().unwrap();
    locked
        .write_live(&LiveReceipt::new(
            fixture.prior_id.clone(),
            None,
            false,
            None,
        ))
        .unwrap();
    drop(locked);
    assert_eq!(
        inspect_bootstrap_status(&fixture.store).unwrap(),
        BootstrapStatus::Managed
    );
}

fn client_command(fixture: &AssemblyFixture, client: &Path) -> DeployCommand {
    DeployCommand {
        checkout: fixture.checkout.clone(),
        port: freshell_deploy::DeployPort::new(43_127).unwrap(),
        mode: UpdateMode::ClientOnly,
        client_dir: Some(client.to_path_buf()),
        server: None,
        node: NodePrerequisite {
            executable: fixture.node.clone(),
            version: "v22.0.0".to_string(),
        },
    }
}

fn server_sources(fixture: &AssemblyFixture, label: &str) -> ServerAssemblySources {
    let root = fixture.sources.join(label);
    make_executable(root.join("freshell-server"), label);
    make_executable(root.join("freshell-deploy"), "controller");
    write(
        root.join("extensions/fixture/freshell.json"),
        br#"{"name":"fixture"}"#,
    );
    write(
        root.join("extensions/fixture/build.txt"),
        format!("{label}\n"),
    );
    write(root.join("dist-server/index.js"), format!("{label}\n"));
    write(root.join("dist-server/mcp/server.js"), b"export {}\n");
    write(root.join("sidecar/index.mjs"), b"process.exit(0)\n");
    write(root.join("sidecar/package.json"), b"{}\n");
    write(
        root.join("sidecar/package-lock.json"),
        br#"{"lockfileVersion":3,"packages":{"":{}}}"#,
    );
    write(
        root.join("sidecar/node_modules/forbidden"),
        b"must not copy\n",
    );
    write(
        root.join("package.json"),
        br#"{"dependencies":{"fixture-package":"1.0.0"}}"#,
    );
    let lock = br#"{"lockfileVersion":3,"packages":{"":{"dependencies":{"fixture-package":"1.0.0"}},"node_modules/fixture-package":{"version":"1.0.0"}}}"#;
    write(root.join("package-lock.json"), lock);
    write(
        root.join("node_modules/.package-lock.json"),
        br#"{"lockfileVersion":3,"packages":{"node_modules/fixture-package":{"version":"1.0.0"}}}"#,
    );
    write(
        root.join("node_modules/fixture-package/package.json"),
        br#"{"name":"fixture-package","version":"1.0.0"}"#,
    );
    ServerAssemblySources {
        server_executable: root.join("freshell-server"),
        controller_executable: root.join("freshell-deploy"),
        extensions_dir: root.join("extensions"),
        dist_server_dir: root.join("dist-server"),
        mcp_entry_relative: PathBuf::from("mcp/server.js"),
        claude_sidecar_dir: root.join("sidecar"),
        claude_sidecar_entry_relative: PathBuf::from("index.mjs"),
        package_json: root.join("package.json"),
        package_lock: root.join("package-lock.json"),
        production_node_modules: root.join("node_modules"),
    }
}

#[test]
fn client_only_assembly_reuses_exact_server_closure_and_retains_prior_assets() {
    let fixture = assembly_fixture();
    let client = fixture.sources.join("client");
    write(client.join("index.html"), b"candidate\n");
    write(client.join("assets/candidate.js"), b"candidate asset\n");
    write(client.join("deployment-compatibility.json"), b"{}\n");

    let target = assemble_generation(&fixture.store, &client_command(&fixture, &client)).unwrap();
    assert_ne!(target.id, fixture.prior_id);
    assert_eq!(
        fs::read(target.path.join("client/assets/prior.js")).unwrap(),
        b"prior asset\n"
    );
    assert_eq!(
        fs::read(target.path.join("client/assets/candidate.js")).unwrap(),
        b"candidate asset\n"
    );

    let prior = fixture.store.verify_generation(&fixture.prior_id).unwrap();
    let prior_non_client = prior
        .manifest
        .entries
        .iter()
        .filter(|entry| !entry.path.starts_with("client"))
        .cloned()
        .collect::<Vec<_>>();
    let target_non_client = target
        .manifest
        .entries
        .iter()
        .filter(|entry| !entry.path.starts_with("client"))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(target_non_client, prior_non_client);
}

#[test]
fn client_asset_merge_rejects_same_path_with_different_bytes() {
    let fixture = assembly_fixture();
    let client = fixture.sources.join("client");
    write(client.join("index.html"), b"candidate\n");
    write(client.join("assets/prior.js"), b"different bytes\n");
    write(client.join("deployment-compatibility.json"), b"{}\n");

    let error =
        assemble_generation(&fixture.store, &client_command(&fixture, &client)).unwrap_err();
    assert!(error.to_string().contains("asset"));
    assert_eq!(
        fixture.store.selected_generation_id().unwrap().as_deref(),
        Some(fixture.prior_id.as_str())
    );
}

#[test]
fn client_asset_merge_accepts_same_bytes_before_candidate_modes_are_sealed() {
    let fixture = assembly_fixture();
    let client = fixture.sources.join("client");
    write(client.join("index.html"), b"candidate\n");
    write(client.join("assets/prior.js"), b"prior asset\n");
    write(client.join("deployment-compatibility.json"), b"{}\n");
    assert_eq!(
        fs::symlink_metadata(client.join("assets/prior.js"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o644
    );

    let target = assemble_generation(&fixture.store, &client_command(&fixture, &client))
        .expect("byte-identical candidate and retained assets merge before sealing");

    assert_eq!(
        fs::read(target.path.join("client/assets/prior.js")).unwrap(),
        b"prior asset\n"
    );
    assert_eq!(
        fs::symlink_metadata(target.path.join("client/assets/prior.js"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o444
    );
}

#[test]
fn client_only_rejects_a_different_node_prerequisite() {
    let fixture = assembly_fixture();
    let client = fixture.sources.join("client");
    write(client.join("index.html"), b"candidate\n");
    write(client.join("deployment-compatibility.json"), b"{}\n");
    let other_node = fixture.sources.join("other-node");
    make_executable(&other_node, "node");
    let mut command = client_command(&fixture, &client);
    command.node.executable = other_node;

    let error = assemble_generation(&fixture.store, &command).unwrap_err();
    assert!(error.to_string().contains("Node prerequisite"));
    assert_eq!(
        fixture.store.selected_generation_id().unwrap().as_deref(),
        Some(fixture.prior_id.as_str())
    );
}

#[test]
fn server_only_assembly_reuses_the_selected_client_and_excludes_sidecar_dependencies() {
    let fixture = assembly_fixture();
    let command = DeployCommand {
        checkout: fixture.checkout.clone(),
        port: freshell_deploy::DeployPort::new(43_127).unwrap(),
        mode: UpdateMode::Server,
        client_dir: None,
        server: Some(server_sources(&fixture, "server-next")),
        node: NodePrerequisite {
            executable: fixture.node.clone(),
            version: "v22.0.0".to_string(),
        },
    };
    let target = assemble_generation(&fixture.store, &command).unwrap();
    let prior = fixture.store.verify_generation(&fixture.prior_id).unwrap();
    let prior_client = prior
        .manifest
        .entries
        .iter()
        .filter(|entry| entry.path == "client" || entry.path.starts_with("client/"))
        .cloned()
        .collect::<Vec<_>>();
    let target_client = target
        .manifest
        .entries
        .iter()
        .filter(|entry| entry.path == "client" || entry.path.starts_with("client/"))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(target_client, prior_client);
    assert!(!target.path.join("claude-sidecar/node_modules").exists());
    assert!(target.path.join("node_modules/fixture-package").is_dir());
}

#[test]
fn combined_assembly_uses_only_private_generation_storage() {
    let fixture = assembly_fixture();
    let client = fixture.sources.join("combined-client");
    write(client.join("index.html"), b"combined\n");
    write(client.join("deployment-compatibility.json"), b"{}\n");
    let command = DeployCommand {
        checkout: fixture.checkout.clone(),
        port: freshell_deploy::DeployPort::new(43_127).unwrap(),
        mode: UpdateMode::Full,
        client_dir: Some(client),
        server: Some(server_sources(&fixture, "combined")),
        node: NodePrerequisite {
            executable: fixture.node.clone(),
            version: "v22.0.0".to_string(),
        },
    };
    let target = assemble_generation(&fixture.store, &command).unwrap();
    assert!(target.path.starts_with(
        fixture
            .checkout
            .join(".freshell-deploy/ports/43127/generations")
    ));
    assert!(target.path.join("controller/freshell-deploy").is_file());
    assert!(target.path.join("deployment.json").is_file());
    assert!(!fixture.checkout.join("dist").exists());
    assert!(!fixture.checkout.join("target").exists());
}

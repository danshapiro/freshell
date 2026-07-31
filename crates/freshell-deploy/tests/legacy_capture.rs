#![cfg(unix)]

use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs::{self, File};
use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use freshell_deploy::{
    capture_legacy, CaptureCommand, DeployError, DeployPort, FileIdentity, LegacyCaptureRequest,
    LegacyRuntimeSources, LinuxProcfs, ListenerIdentity, NodePrerequisite, ProcessIdentity,
    ProcessInspector, RealScratchProbe, RuntimeBindings, RuntimeProvenance, ScratchProbe,
    ScratchProbeRequest, Store,
};
use serde_json::json;
use tempfile::TempDir;

const PID: u32 = 41_337;
const PORT: u16 = 34_51;

fn checkout() -> TempDir {
    let root = tempfile::tempdir().expect("temporary checkout");
    fs::write(root.path().join(".git"), "gitdir: fixture\n").expect("worktree marker");
    root
}

#[derive(Clone)]
struct RuntimeFixture {
    sources: LegacyRuntimeSources,
    old_executable: PathBuf,
    replaced_path: PathBuf,
}

fn runtime_fixture(root: &Path) -> RuntimeFixture {
    let artifacts = root.join("artifacts");
    fs::create_dir(&artifacts).unwrap();

    let old_executable = artifacts.join("observed-proc-exe");
    fs::write(&old_executable, b"old deleted executable bytes").unwrap();
    fs::set_permissions(&old_executable, fs::Permissions::from_mode(0o755)).unwrap();
    let replaced_path = artifacts.join("target-release-freshell-server");
    fs::write(&replaced_path, b"new path bytes that are not running").unwrap();
    fs::set_permissions(&replaced_path, fs::Permissions::from_mode(0o755)).unwrap();

    let client_dir = artifacts.join("client");
    fs::create_dir(&client_dir).unwrap();
    fs::write(client_dir.join("index.html"), "legacy client").unwrap();

    let extensions_dir = artifacts.join("extensions");
    fs::create_dir_all(extensions_dir.join("terminal")).unwrap();
    fs::write(
        extensions_dir.join("terminal/freshell.json"),
        r#"{"name":"terminal","version":"1.0.0","label":"Terminal","description":"Fixture terminal","category":"terminal"}"#,
    )
    .unwrap();

    let dist_server_dir = artifacts.join("dist-server");
    fs::create_dir_all(dist_server_dir.join("mcp")).unwrap();
    fs::write(
        dist_server_dir.join("mcp/server.js"),
        "import './tool.js'\n",
    )
    .unwrap();
    fs::write(
        dist_server_dir.join("mcp/tool.js"),
        "export const ok = true\n",
    )
    .unwrap();

    let package_json = artifacts.join("package.json");
    let package_lock = artifacts.join("package-lock.json");
    fs::write(
        &package_json,
        serde_json::to_vec(&json!({
            "name": "freshell",
            "type": "module",
            "dependencies": {
                "production-package": "1.0.0",
                "sidecar-package": "2.0.0",
                "zod": "4.3.6"
            }
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(&package_lock, root_lockfile_bytes()).unwrap();
    let production_node_modules = artifacts.join("node_modules");
    create_root_dependency_closure(&production_node_modules);

    let claude_sidecar_dir = artifacts.join("claude-sidecar");
    fs::create_dir(&claude_sidecar_dir).unwrap();
    fs::write(
        claude_sidecar_dir.join("index.mjs"),
        "import 'sidecar-package'\n",
    )
    .unwrap();
    fs::write(
        claude_sidecar_dir.join("package.json"),
        serde_json::to_vec(&json!({
            "name": "freshell-claude-sidecar",
            "type": "module",
            "dependencies": { "sidecar-package": "2.0.0" }
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        claude_sidecar_dir.join("package-lock.json"),
        sidecar_lockfile_bytes(),
    )
    .unwrap();

    let node_executable = artifacts.join("node");
    fs::write(&node_executable, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&node_executable, fs::Permissions::from_mode(0o755)).unwrap();

    RuntimeFixture {
        sources: LegacyRuntimeSources {
            client_dir,
            extensions_dir,
            dist_server_dir,
            mcp_entry_relative: PathBuf::from("mcp/server.js"),
            claude_sidecar_dir,
            claude_sidecar_entry_relative: PathBuf::from("index.mjs"),
            package_json,
            package_lock,
            production_node_modules,
        },
        old_executable,
        replaced_path,
    }
}

fn root_lockfile_bytes() -> Vec<u8> {
    serde_json::to_vec(&json!({
        "name": "freshell",
        "lockfileVersion": 3,
        "packages": {
            "": {
                "name": "freshell",
                "dependencies": {
                    "production-package": "1.0.0",
                    "sidecar-package": "2.0.0",
                    "zod": "4.3.6"
                }
            },
            "node_modules/production-package": {
                "version": "1.0.0",
                "resolved": "https://registry.invalid/production-package.tgz",
                "integrity": "sha512-production-package"
            },
            "node_modules/sidecar-package": {
                "version": "2.0.0",
                "resolved": "https://registry.invalid/sidecar-package.tgz",
                "integrity": "sha512-sidecar-package"
            },
            "node_modules/zod": {
                "version": "4.3.6",
                "resolved": "https://registry.invalid/zod.tgz",
                "integrity": "sha512-zod-root"
            }
        }
    }))
    .unwrap()
}

fn create_root_dependency_closure(root: &Path) {
    fs::create_dir(root).unwrap();
    fs::write(root.join(".package-lock.json"), root_lockfile_bytes()).unwrap();
    for (package, version) in [
        ("production-package", "1.0.0"),
        ("sidecar-package", "2.0.0"),
        ("zod", "4.3.6"),
    ] {
        fs::create_dir(root.join(package)).unwrap();
        fs::write(
            root.join(package).join("package.json"),
            serde_json::to_vec(&json!({"name": package, "version": version})).unwrap(),
        )
        .unwrap();
        fs::write(root.join(package).join("index.js"), "export default true\n").unwrap();
    }
}

fn sidecar_lockfile_bytes() -> Vec<u8> {
    serde_json::to_vec(&json!({
        "name": "freshell-claude-sidecar",
        "lockfileVersion": 3,
        "packages": {
            "": {
                "name": "freshell-claude-sidecar",
                "dependencies": { "sidecar-package": "2.0.0" }
            },
            "node_modules/sidecar-package": {
                "version": "2.0.0"
            },
            "node_modules/zod": {
                "version": "4.4.3",
                "resolved": "https://registry.invalid/zod-sidecar.tgz",
                "integrity": "sha512-zod-sidecar",
                "peer": true
            }
        }
    }))
    .unwrap()
}

fn lockfile_bytes_with_version(name: &str, package: &str, version: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "name": name,
        "lockfileVersion": 3,
        "packages": {
            "": {
                "name": name,
                "dependencies": { (package): version }
            },
            format!("node_modules/{package}"): {
                "version": version,
                "resolved": format!("https://registry.invalid/{package}.tgz"),
                "integrity": format!("sha512-{package}")
            }
        }
    }))
    .unwrap()
}

fn listener(pid: u32) -> ListenerIdentity {
    ListenerIdentity {
        port: DeployPort::new(PORT).unwrap(),
        socket_inode: "991122".to_string(),
        owner_pid: pid,
        network_namespace: "net:[4026533111]".to_string(),
    }
}

fn identity(executable: &Path) -> ProcessIdentity {
    let checkout = executable
        .parent()
        .and_then(Path::parent)
        .expect("executable fixture is under checkout/artifacts");
    ProcessIdentity {
        pid: PID,
        kernel_boot_id: "11111111-2222-3333-4444-555555555555".to_string(),
        start_time_ticks: "90071992547409931234".to_string(),
        executable: FileIdentity::from_path(executable).expect("file identity"),
        listener: listener(PID),
        cwd: checkout.to_str().unwrap().to_string(),
        argv0: "freshell-server".to_string(),
        argument_count: 1,
        effective_uid: unsafe { libc::geteuid() },
        runtime: RuntimeProvenance {
            client_dir: checkout
                .join("artifacts/client")
                .to_str()
                .unwrap()
                .to_string(),
            extensions_dir: checkout
                .join("artifacts/extensions")
                .to_str()
                .unwrap()
                .to_string(),
            dist_server_dir: checkout
                .join("artifacts/dist-server")
                .to_str()
                .unwrap()
                .to_string(),
            mcp_entry: checkout
                .join("artifacts/dist-server/mcp/server.js")
                .to_str()
                .unwrap()
                .to_string(),
            claude_sidecar_entry: checkout
                .join("artifacts/claude-sidecar/index.mjs")
                .to_str()
                .unwrap()
                .to_string(),
            node_executable: checkout
                .join("artifacts/node")
                .to_str()
                .unwrap()
                .to_string(),
            package_json: checkout
                .join("artifacts/package.json")
                .to_str()
                .unwrap()
                .to_string(),
            package_lock: checkout
                .join("artifacts/package-lock.json")
                .to_str()
                .unwrap()
                .to_string(),
            production_node_modules: checkout
                .join("artifacts/node_modules")
                .to_str()
                .unwrap()
                .to_string(),
        },
    }
}

struct FakeProcessInspector {
    listeners: Mutex<VecDeque<ListenerIdentity>>,
    identities: Mutex<VecDeque<ProcessIdentity>>,
    executable: PathBuf,
    live_client: Vec<u8>,
    events: Mutex<Vec<String>>,
}

struct MutatingProcessInspector {
    inner: FakeProcessInspector,
    mutation_path: PathBuf,
    snapshot_count: AtomicUsize,
}

impl MutatingProcessInspector {
    fn after_copy(executable: &Path, mutation_path: PathBuf) -> Self {
        Self {
            inner: FakeProcessInspector::stable(executable),
            mutation_path,
            snapshot_count: AtomicUsize::new(0),
        }
    }
}

impl ProcessInspector for MutatingProcessInspector {
    type Pin = u32;

    fn resolve_listener(&self, port: DeployPort) -> freshell_deploy::Result<ListenerIdentity> {
        self.inner.resolve_listener(port)
    }

    fn open_pidfd(&self, pid: u32) -> freshell_deploy::Result<Self::Pin> {
        self.inner.open_pidfd(pid)
    }

    fn snapshot(
        &self,
        pin: &Self::Pin,
        listener: &ListenerIdentity,
    ) -> freshell_deploy::Result<ProcessIdentity> {
        if self.snapshot_count.fetch_add(1, Ordering::SeqCst) == 2 {
            fs::write(&self.mutation_path, "changed while capture was in progress").unwrap();
        }
        self.inner.snapshot(pin, listener)
    }

    fn open_executable(&self, pin: &Self::Pin) -> freshell_deploy::Result<File> {
        self.inner.open_executable(pin)
    }

    fn read_live_client(&self, port: DeployPort) -> freshell_deploy::Result<Vec<u8>> {
        self.inner.read_live_client(port)
    }
}

impl FakeProcessInspector {
    fn stable(executable: &Path) -> Self {
        Self {
            listeners: Mutex::new(VecDeque::from([listener(PID)])),
            identities: Mutex::new(VecDeque::from([identity(executable)])),
            executable: executable.to_path_buf(),
            live_client: fs::read(executable.parent().unwrap().join("client/index.html")).unwrap(),
            events: Mutex::new(Vec::new()),
        }
    }

    fn with_listener(executable: &Path, listener: ListenerIdentity) -> Self {
        Self {
            listeners: Mutex::new(VecDeque::from([listener])),
            ..Self::stable(executable)
        }
    }

    fn with_listeners(executable: &Path, listeners: Vec<ListenerIdentity>) -> Self {
        Self {
            listeners: Mutex::new(VecDeque::from(listeners)),
            ..Self::stable(executable)
        }
    }

    fn with_identities(executable: &Path, identities: Vec<ProcessIdentity>) -> Self {
        Self {
            identities: Mutex::new(VecDeque::from(identities)),
            ..Self::stable(executable)
        }
    }

    fn with_live_client(executable: &Path, live_client: &[u8]) -> Self {
        Self {
            live_client: live_client.to_vec(),
            ..Self::stable(executable)
        }
    }

    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }
}

impl ProcessInspector for FakeProcessInspector {
    type Pin = u32;

    fn resolve_listener(&self, _port: DeployPort) -> freshell_deploy::Result<ListenerIdentity> {
        self.events.lock().unwrap().push("resolve_listener".into());
        let mut values = self.listeners.lock().unwrap();
        let value = values
            .front()
            .cloned()
            .ok_or_else(|| DeployError::ProcessIdentity("listener unavailable".into()))?;
        if values.len() > 1 {
            values.pop_front();
        }
        Ok(value)
    }

    fn open_pidfd(&self, pid: u32) -> freshell_deploy::Result<Self::Pin> {
        self.events.lock().unwrap().push("open_pidfd".into());
        Ok(pid)
    }

    fn snapshot(
        &self,
        _pin: &Self::Pin,
        _listener: &ListenerIdentity,
    ) -> freshell_deploy::Result<ProcessIdentity> {
        self.events.lock().unwrap().push("snapshot".into());
        let mut values = self.identities.lock().unwrap();
        let value = values
            .front()
            .cloned()
            .ok_or_else(|| DeployError::ProcessIdentity("snapshot unavailable".into()))?;
        if values.len() > 1 {
            values.pop_front();
        }
        Ok(value)
    }

    fn open_executable(&self, _pin: &Self::Pin) -> freshell_deploy::Result<File> {
        self.events.lock().unwrap().push("open_executable".into());
        Ok(File::open(&self.executable)?)
    }

    fn read_live_client(&self, _port: DeployPort) -> freshell_deploy::Result<Vec<u8>> {
        Ok(self.live_client.clone())
    }
}

struct FakeScratchProbe {
    fail: bool,
    requests: Mutex<Vec<ScratchProbeRequest>>,
}

impl FakeScratchProbe {
    fn passing() -> Self {
        Self {
            fail: false,
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl ScratchProbe for FakeScratchProbe {
    fn verify(&self, request: &ScratchProbeRequest) -> freshell_deploy::Result<()> {
        self.requests.lock().unwrap().push(request.clone());
        assert_eq!(request.port, 0);
        assert!(request
            .isolated_home
            .starts_with(request.generation_path.parent().unwrap()));
        assert!(request.server_executable().is_file());
        assert!(request.client_dir().join("index.html").is_file());
        assert!(request.extensions_dir().is_dir());
        assert!(request.claude_sidecar_entry().is_file());
        assert!(request.mcp_entry().is_file());
        assert!(request.generation_path.join("package.json").is_file());
        assert!(request.legacy_mcp_fallback_entry().is_file());
        assert!(request.generation_path.join("node_modules").is_dir());
        assert!(request
            .production_node_modules()
            .join(".package-lock.json")
            .is_file());
        assert!(request
            .production_node_modules()
            .join("sidecar-package/package.json")
            .is_file());
        assert!(
            !request
                .claude_sidecar_entry()
                .parent()
                .unwrap()
                .join("node_modules")
                .exists(),
            "the sidecar must resolve its lock-compatible dependency from generation-root node_modules"
        );
        if self.fail {
            Err(DeployError::LegacyCapture(
                "scratch validation failed".to_string(),
            ))
        } else {
            Ok(())
        }
    }
}

fn request(runtime: &RuntimeFixture) -> LegacyCaptureRequest {
    LegacyCaptureRequest {
        pid_hint: PID,
        port: DeployPort::new(PORT).unwrap(),
        runtime: runtime.sources.clone(),
        node: NodePrerequisite {
            executable: runtime.sources.package_json.parent().unwrap().join("node"),
            version: "v22.18.0".to_string(),
        },
    }
}

#[test]
fn captures_pinned_proc_executable_and_complete_legacy_closure_without_signaling() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    assert_ne!(
        fs::read(&runtime.old_executable).unwrap(),
        fs::read(&runtime.replaced_path).unwrap(),
        "fixture models a replaced or unlinked executable pathname"
    );
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    let inspector = FakeProcessInspector::stable(&runtime.old_executable);
    let probe = FakeScratchProbe::passing();

    let receipt =
        capture_legacy(&store, &request(&runtime), &inspector, &probe).expect("legacy capture");

    assert!(receipt.legacy);
    assert_eq!(receipt.process, identity(&runtime.old_executable));
    assert_eq!(receipt.node.version, "v22.18.0");
    assert_eq!(receipt.launch.cwd, fixture.path().to_str().unwrap());
    assert_eq!(receipt.launch.argv0, "freshell-server");
    let generation = store.verify_generation(&receipt.generation_id).unwrap();
    assert_eq!(
        fs::read(generation.path.join("server/freshell-server")).unwrap(),
        fs::read(&runtime.old_executable).unwrap(),
        "capture must read the pinned /proc executable, not the replaced pathname"
    );
    let copied = fs::metadata(generation.path.join("server/freshell-server")).unwrap();
    assert_ne!(
        (copied.dev().to_string(), copied.ino().to_string()),
        (
            receipt.process.executable.device.clone(),
            receipt.process.executable.inode.clone()
        ),
        "receipt preserves observed process inode separately from copied artifact inode"
    );
    assert!(
        generation.path.join("package.json").is_file(),
        "the pre-binding legacy server discovers package.json from its cwd"
    );
    assert!(
        generation.path.join("dist/server/mcp/server.js").is_file(),
        "the pre-binding legacy server discovers its MCP entry from cwd/dist/server"
    );
    assert!(
        generation.path.join("node_modules").is_dir(),
        "the pre-binding legacy server discovers tsx from cwd/node_modules"
    );
    assert!(
        generation
            .path
            .join("node_modules/sidecar-package/package.json")
            .is_file(),
        "the sidecar resolves its lock-compatible dependency upward from the root closure"
    );
    assert!(
        !generation.path.join("claude-sidecar/node_modules").exists(),
        "capture must not require or fabricate a second sidecar dependency closure"
    );
    assert_eq!(receipt.runtime.package_json, "package.json");
    assert_eq!(receipt.runtime.dist_server_dir, "dist/server");
    assert_eq!(receipt.runtime.production_node_modules, "node_modules");
    assert_eq!(
        store.selected_generation_id().unwrap().as_deref(),
        Some(receipt.generation_id.as_str())
    );
    let live = store.read_live().unwrap().unwrap();
    assert!(live.legacy);
    assert_eq!(live.selected_generation_id, receipt.generation_id);
    assert_eq!(
        live.running_server_generation_id,
        Some(receipt.generation_id.clone())
    );
    assert!(
        inspector
            .events()
            .iter()
            .all(|event| !event.starts_with("pidfd_send_signal")),
        "capture keeps the observed process alive"
    );
    assert_eq!(probe.requests.lock().unwrap().len(), 1);

    let receipt_json = serde_json::to_value(store.read_legacy_capture().unwrap().unwrap()).unwrap();
    assert!(receipt_json.get("compatibility").is_none());
    assert!(receipt_json.get("declaration").is_none());
}

#[test]
fn rejects_stale_pid_hint_when_a_foreign_process_owns_the_requested_port() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    let inspector = FakeProcessInspector::with_listener(&runtime.old_executable, listener(PID + 1));

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &inspector,
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::ProcessIdentity(message)) if message.contains("listener owner")
    ));
    assert!(store.selected_generation_id().unwrap().is_none());
    assert!(store.read_live().unwrap().is_none());
    assert!(store.read_legacy_capture().unwrap().is_none());
    assert!(!inspector.events().contains(&"open_pidfd".to_string()));
}

#[test]
fn rejects_a_listener_identity_for_a_different_port() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    let mut wrong_port = listener(PID);
    wrong_port.port = DeployPort::new(PORT + 1).unwrap();
    let inspector = FakeProcessInspector::with_listener(&runtime.old_executable, wrong_port);

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &inspector,
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::ProcessIdentity(message)) if message.contains("requested port")
    ));
    assert!(!inspector.events().contains(&"open_pidfd".to_string()));
}

#[test]
fn revalidates_boot_process_executable_and_socket_identity_after_copy() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    let stable = identity(&runtime.old_executable);
    let mut changed = stable.clone();
    changed.start_time_ticks = "90071992547409939999".to_string();
    let inspector = FakeProcessInspector::with_identities(
        &runtime.old_executable,
        vec![stable.clone(), stable, changed],
    );

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &inspector,
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::ProcessIdentity(message)) if message.contains("changed")
    ));
    assert!(store.selected_generation_id().unwrap().is_none());
    assert!(store.read_live().unwrap().is_none());
}

#[test]
fn rejects_listener_ownership_transfer_after_copy() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    let stable = listener(PID);
    let mut transferred = stable.clone();
    transferred.socket_inode = "991123".to_string();
    let inspector = FakeProcessInspector::with_listeners(
        &runtime.old_executable,
        vec![stable.clone(), stable, transferred],
    );

    assert!(matches!(
        capture_legacy(&store, &request(&runtime), &inspector, &FakeScratchProbe::passing()),
        Err(DeployError::ProcessIdentity(message)) if message.contains("listener socket identity changed")
    ));
    assert!(store.read_live().unwrap().is_none());
    assert!(store.read_legacy_capture().unwrap().is_none());
}

#[test]
fn rejects_listener_ownership_transfer_after_scratch_probe() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    let stable = listener(PID);
    let mut transferred = stable.clone();
    transferred.owner_pid = PID + 1;
    let inspector = FakeProcessInspector::with_listeners(
        &runtime.old_executable,
        vec![stable.clone(), stable.clone(), stable, transferred],
    );

    assert!(matches!(
        capture_legacy(&store, &request(&runtime), &inspector, &FakeScratchProbe::passing()),
        Err(DeployError::ProcessIdentity(message)) if message.contains("listener socket identity changed")
    ));
    assert!(store.read_live().unwrap().is_none());
    assert!(store.read_legacy_capture().unwrap().is_none());
}

#[test]
fn rejects_a_listener_owner_running_from_a_different_checkout() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    let mut foreign_checkout = identity(&runtime.old_executable);
    foreign_checkout.cwd = "/different/freshell-checkout".to_string();
    let inspector =
        FakeProcessInspector::with_identities(&runtime.old_executable, vec![foreign_checkout]);

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &inspector,
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message)) if message.contains("cwd")
    ));
    assert!(store.selected_generation_id().unwrap().is_none());
}

#[test]
fn rejects_supplied_runtime_that_does_not_match_live_process_provenance() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    for field in [
        "client",
        "extensions",
        "compiled server",
        "MCP entry",
        "Claude sidecar entry",
        "package.json",
        "package-lock.json",
        "Node",
    ] {
        let mut mismatched = identity(&runtime.old_executable);
        let unrelated = fixture
            .path()
            .join(format!("unrelated-{}", field.replace(' ', "-")))
            .display()
            .to_string();
        match field {
            "client" => mismatched.runtime.client_dir = unrelated,
            "extensions" => mismatched.runtime.extensions_dir = unrelated,
            "compiled server" => mismatched.runtime.dist_server_dir = unrelated,
            "MCP entry" => mismatched.runtime.mcp_entry = unrelated,
            "Claude sidecar entry" => mismatched.runtime.claude_sidecar_entry = unrelated,
            "package.json" => mismatched.runtime.package_json = unrelated,
            "package-lock.json" => mismatched.runtime.package_lock = unrelated,
            "Node" => mismatched.runtime.node_executable = unrelated,
            _ => unreachable!(),
        }

        assert!(matches!(
            capture_legacy(
                &store,
                &request(&runtime),
                &FakeProcessInspector::with_identities(&runtime.old_executable, vec![mismatched]),
                &FakeScratchProbe::passing()
            ),
            Err(DeployError::LegacyCapture(message))
                if message.contains(field) && message.contains("live process provenance")
        ));
    }
}

#[test]
fn bootstrap_captures_a_private_production_closure_without_claiming_it_is_the_live_dev_install() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let live_development_install = fixture.path().join("live-development-node_modules");
    fs::create_dir(&live_development_install).unwrap();
    fs::write(
        live_development_install.join("development-only-package"),
        "not part of rollback closure\n",
    )
    .unwrap();
    let mut live = identity(&runtime.old_executable);
    live.runtime.production_node_modules = live_development_install.display().to_string();
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();

    let receipt = capture_legacy(
        &store,
        &request(&runtime),
        &FakeProcessInspector::with_identities(&runtime.old_executable, vec![live]),
        &FakeScratchProbe::passing(),
    )
    .expect("private npm ci closure is the captured rollback dependency closure");

    let generation = store.verify_generation(&receipt.generation_id).unwrap();
    assert!(generation
        .path
        .join("node_modules/production-package")
        .is_dir());
    assert!(!generation
        .path
        .join("node_modules/development-only-package")
        .exists());
}

#[test]
fn rejects_supplied_client_that_differs_from_live_served_bytes() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::with_live_client(
                &runtime.old_executable,
                b"different live client"
            ),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message)) if message.contains("bytes served")
    ));
}

#[test]
fn legacy_capture_rejects_a_runtime_directory_inside_its_store_before_copying() {
    let fixture = checkout();
    let mut runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    let store_client = store.paths().store_root().join("runtime-client");
    fs::create_dir(&store_client).unwrap();
    fs::write(store_client.join("index.html"), "legacy client").unwrap();
    runtime.sources.client_dir = store_client.clone();
    let mut live = identity(&runtime.old_executable);
    live.runtime.client_dir = fs::canonicalize(&store_client)
        .unwrap()
        .display()
        .to_string();

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::with_identities(&runtime.old_executable, vec![live]),
            &FakeScratchProbe::passing(),
        ),
        Err(DeployError::UnsafeStorePath(path)) if path == fs::canonicalize(&store_client).unwrap()
    ));
    assert!(store.selected_generation_id().unwrap().is_none());
    assert!(store.read_live().unwrap().is_none());
    assert!(store.read_legacy_capture().unwrap().is_none());
}

#[test]
fn requires_every_runtime_member_and_lockfile_derived_production_dependencies() {
    type SourceMutation = Box<dyn Fn(&mut LegacyRuntimeSources)>;
    let required: Vec<(&str, SourceMutation)> = vec![
        (
            "client",
            Box::new(|sources| sources.client_dir.push("missing")),
        ),
        (
            "extensions",
            Box::new(|sources| sources.extensions_dir.push("missing")),
        ),
        (
            "compiled server",
            Box::new(|sources| sources.dist_server_dir.push("missing")),
        ),
        (
            "MCP entry",
            Box::new(|sources| sources.mcp_entry_relative = PathBuf::from("mcp/missing.js")),
        ),
        (
            "Claude sidecar",
            Box::new(|sources| sources.claude_sidecar_dir.push("missing")),
        ),
        (
            "sidecar entry",
            Box::new(|sources| {
                sources.claude_sidecar_entry_relative = PathBuf::from("missing.mjs")
            }),
        ),
        (
            "package manifest",
            Box::new(|sources| sources.package_json.push("missing")),
        ),
        (
            "lockfile",
            Box::new(|sources| sources.package_lock.push("missing")),
        ),
        (
            "production dependencies",
            Box::new(|sources| sources.production_node_modules.push("missing")),
        ),
    ];

    for (name, mutate) in required {
        let fixture = checkout();
        let runtime = runtime_fixture(fixture.path());
        let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
        let mut bad_request = request(&runtime);
        mutate(&mut bad_request.runtime);
        let result = capture_legacy(
            &store,
            &bad_request,
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing(),
        );
        assert!(result.is_err(), "missing {name} must fail closed");
        assert!(store.selected_generation_id().unwrap().is_none(), "{name}");
        assert!(store.read_live().unwrap().is_none(), "{name}");
    }

    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    fs::write(
        runtime
            .sources
            .production_node_modules
            .join(".package-lock.json"),
        lockfile_bytes_with_version("freshell", "unexpected-package", "9.0.0"),
    )
    .unwrap();
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message)) if message.contains("lockfile")
    ));

    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let empty_extensions = fixture.path().join("empty-extensions");
    fs::create_dir(&empty_extensions).unwrap();
    let mut empty_request = request(&runtime);
    empty_request.runtime.extensions_dir = empty_extensions;
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    assert!(matches!(
        capture_legacy(
            &store,
            &empty_request,
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message)) if message.contains("extensions")
    ));

    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    fs::write(
        runtime.sources.dist_server_dir.join("mcp/alternate.js"),
        "export const alternate = true\n",
    )
    .unwrap();
    fs::remove_file(runtime.sources.dist_server_dir.join("mcp/server.js")).unwrap();
    let mut alternate_request = request(&runtime);
    alternate_request.runtime.mcp_entry_relative = PathBuf::from("mcp/alternate.js");
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    assert!(matches!(
        capture_legacy(
            &store,
            &alternate_request,
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message))
            if message.contains("pre-binding legacy MCP fallback")
    ));

    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    fs::create_dir(runtime.sources.claude_sidecar_dir.join("node_modules")).unwrap();
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message))
            if message.contains("single root production dependency closure")
    ));

    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let mut mismatched_lock: serde_json::Value =
        serde_json::from_slice(&sidecar_lockfile_bytes()).unwrap();
    mismatched_lock["packages"]["node_modules/sidecar-package"]["version"] = json!("9.0.0");
    fs::write(
        runtime.sources.claude_sidecar_dir.join("package-lock.json"),
        serde_json::to_vec(&mismatched_lock).unwrap(),
    )
    .unwrap();
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message))
            if message.contains("mismatched sidecar direct version")
    ));
}

#[test]
fn requires_every_non_optional_production_lock_entry_and_physical_package() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    fs::write(
        runtime
            .sources
            .production_node_modules
            .join(".package-lock.json"),
        serde_json::to_vec(&json!({
            "name": "freshell",
            "lockfileVersion": 3,
            "packages": { "": { "name": "freshell" } }
        }))
        .unwrap(),
    )
    .unwrap();
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message))
            if message.contains("production dependency closure")
                && message.contains("production-package")
    ));

    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    fs::remove_dir_all(
        runtime
            .sources
            .production_node_modules
            .join("production-package"),
    )
    .unwrap();
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message))
            if message.contains("physical package") && message.contains("production-package")
    ));

    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    fs::create_dir(
        runtime
            .sources
            .production_node_modules
            .join("unlisted-package"),
    )
    .unwrap();
    fs::write(
        runtime
            .sources
            .production_node_modules
            .join("unlisted-package/package.json"),
        r#"{"name":"unlisted-package","version":"1.0.0"}"#,
    )
    .unwrap();
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message))
            if message.contains("physical package") && message.contains("unlisted-package")
    ));

    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    fs::write(
        runtime
            .sources
            .production_node_modules
            .join("production-package/package.json"),
        r#"{"name":"production-package","version":"9.9.9"}"#,
    )
    .unwrap();
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message))
            if message.contains("physical package metadata")
                && message.contains("production-package")
    ));

    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let package = runtime
        .sources
        .production_node_modules
        .join("production-package");
    let target = runtime
        .sources
        .production_node_modules
        .join("production-target");
    fs::rename(&package, &target).unwrap();
    symlink("production-target", &package).unwrap();
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message))
            if message.contains("link semantics") && message.contains("production-package")
    ));

    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let hidden_path = runtime
        .sources
        .production_node_modules
        .join(".package-lock.json");
    let mut hidden: serde_json::Value =
        serde_json::from_slice(&fs::read(&hidden_path).unwrap()).unwrap();
    hidden["packages"]["node_modules/dev-only"] = json!({
        "version": "1.0.0",
        "dev": true
    });
    fs::write(&hidden_path, serde_json::to_vec(&hidden).unwrap()).unwrap();
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message))
            if message.contains("dev-only")
    ));
}

#[test]
fn runtime_sources_that_change_during_capture_are_rejected_including_manifest_named_files() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let mutation_path = runtime.sources.client_dir.join("manifest.json");
    fs::write(&mutation_path, "{\"version\":\"before\"}\n").unwrap();
    let inspector =
        MutatingProcessInspector::after_copy(&runtime.old_executable, mutation_path.clone());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &inspector,
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message))
            if message.contains("runtime closure changed during capture")
    ));
    assert_eq!(
        fs::read_to_string(mutation_path).unwrap(),
        "changed while capture was in progress"
    );
    assert!(store.read_live().unwrap().is_none());
    assert!(store.read_legacy_capture().unwrap().is_none());
    assert!(store.selected_generation_id().unwrap().is_none());
}

#[test]
fn capture_port_must_match_the_store_namespace_before_process_inspection() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT + 1).unwrap()).unwrap();
    let inspector = FakeProcessInspector::stable(&runtime.old_executable);

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &inspector,
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message)) if message.contains("store port")
    ));
    assert!(
        inspector.events().is_empty(),
        "a namespace mismatch must fail before inspecting or pinning a process"
    );
}

#[test]
fn node_prerequisite_must_satisfy_the_legacy_bare_node_command() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let alternate = runtime
        .sources
        .package_json
        .parent()
        .unwrap()
        .join("node-v22");
    fs::copy(
        runtime.sources.package_json.parent().unwrap().join("node"),
        &alternate,
    )
    .unwrap();
    fs::set_permissions(&alternate, fs::Permissions::from_mode(0o755)).unwrap();
    let mut bad_request = request(&runtime);
    bad_request.node.executable = alternate;
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();

    assert!(matches!(
        capture_legacy(
            &store,
            &bad_request,
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message))
            if message.contains("bare `node`")
    ));
}

#[test]
fn scratch_probe_failure_leaves_selection_and_receipts_untouched() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    let probe = FakeScratchProbe {
        fail: true,
        requests: Mutex::new(Vec::new()),
    };

    assert!(capture_legacy(
        &store,
        &request(&runtime),
        &FakeProcessInspector::stable(&runtime.old_executable),
        &probe
    )
    .is_err());
    assert!(store.selected_generation_id().unwrap().is_none());
    assert!(store.read_live().unwrap().is_none());
    assert!(store.read_legacy_capture().unwrap().is_none());
}

#[test]
fn captured_runtime_bindings_preserve_validated_explicit_entry_paths() {
    let fixture = checkout();
    let mut runtime = runtime_fixture(fixture.path());
    fs::write(
        runtime.sources.dist_server_dir.join("mcp/alternate.js"),
        "export const alternate = true\n",
    )
    .unwrap();
    runtime.sources.mcp_entry_relative = PathBuf::from("mcp/alternate.js");
    fs::write(
        runtime.sources.claude_sidecar_dir.join("alternate.mjs"),
        "process.stdin.resume()\n",
    )
    .unwrap();
    runtime.sources.claude_sidecar_entry_relative = PathBuf::from("alternate.mjs");
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    let mut live_identity = identity(&runtime.old_executable);
    live_identity.runtime.mcp_entry = runtime
        .sources
        .dist_server_dir
        .join("mcp/alternate.js")
        .display()
        .to_string();
    live_identity.runtime.claude_sidecar_entry = runtime
        .sources
        .claude_sidecar_dir
        .join("alternate.mjs")
        .display()
        .to_string();

    let receipt = capture_legacy(
        &store,
        &request(&runtime),
        &FakeProcessInspector::with_identities(&runtime.old_executable, vec![live_identity]),
        &FakeScratchProbe::passing(),
    )
    .unwrap();

    assert_eq!(receipt.runtime.mcp_entry, "dist/server/mcp/alternate.js");
    assert_eq!(
        receipt.runtime.claude_sidecar_entry,
        "claude-sidecar/alternate.mjs"
    );
}

#[test]
fn capture_reconciles_each_matching_bootstrap_prefix_but_refuses_a_different_adoption() {
    for retained_prefix in ["generation", "legacy", "current", "live"] {
        let fixture = checkout();
        let runtime = runtime_fixture(fixture.path());
        let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
        let first = capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing(),
        )
        .unwrap();

        if retained_prefix != "live" {
            fs::remove_file(store.paths().live_receipt()).unwrap();
        }
        if !matches!(retained_prefix, "current" | "live") {
            fs::remove_file(store.paths().current_pointer()).unwrap();
        }
        if retained_prefix == "generation" {
            fs::remove_file(store.paths().legacy_receipt()).unwrap();
        }

        let recovered = capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing(),
        )
        .expect("matching bootstrap prefix must be retryable");
        assert_eq!(recovered, first, "{retained_prefix}");
        assert_eq!(
            store.selected_generation_id().unwrap().as_deref(),
            Some(first.generation_id.as_str()),
            "{retained_prefix}"
        );
        assert_eq!(
            store
                .read_live()
                .unwrap()
                .unwrap()
                .running_server_generation_id
                .as_deref(),
            Some(first.generation_id.as_str()),
            "{retained_prefix}"
        );
    }

    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    let first = capture_legacy(
        &store,
        &request(&runtime),
        &FakeProcessInspector::stable(&runtime.old_executable),
        &FakeScratchProbe::passing(),
    )
    .unwrap();
    fs::write(runtime.sources.client_dir.join("index.html"), "different").unwrap();

    assert!(matches!(
        capture_legacy(
            &store,
            &request(&runtime),
            &FakeProcessInspector::stable(&runtime.old_executable),
            &FakeScratchProbe::passing()
        ),
        Err(DeployError::LegacyCapture(message))
            if message.contains("already completed") || message.contains("adoption")
    ));
    assert_eq!(
        store.read_legacy_capture().unwrap().unwrap().generation_id,
        first.generation_id
    );
}

#[test]
fn cleanup_keeps_the_original_legacy_recovery_generation() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    let legacy = capture_legacy(
        &store,
        &request(&runtime),
        &FakeProcessInspector::stable(&runtime.old_executable),
        &FakeScratchProbe::passing(),
    )
    .unwrap();

    let source = fixture.path().join("new-generation");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("server"), "new").unwrap();
    let locked = store.lock().unwrap();
    let current = locked.import_tree(&source).unwrap();
    locked.select_generation(&current.id).unwrap();
    locked
        .write_live(&freshell_deploy::LiveReceipt::new(
            current.id.clone(),
            None,
            false,
            None,
        ))
        .unwrap();

    assert!(
        locked.remove_generation(&legacy.generation_id).is_err(),
        "legacy.json is a recovery anchor even after current advances"
    );
    store.verify_generation(&legacy.generation_id).unwrap();
}

#[test]
fn legacy_recovery_receipt_is_create_once_and_idempotent_only_when_identical() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    let receipt = capture_legacy(
        &store,
        &request(&runtime),
        &FakeProcessInspector::stable(&runtime.old_executable),
        &FakeScratchProbe::passing(),
    )
    .unwrap();
    let locked = store.lock().unwrap();

    locked.write_legacy_capture(&receipt).unwrap();
    let mut replacement = receipt.clone();
    replacement.node.version = "v99.0.0".to_string();
    assert!(matches!(
        locked.write_legacy_capture(&replacement),
        Err(DeployError::InvalidReceipt(message)) if message.contains("immutable")
    ));
    assert_eq!(store.read_legacy_capture().unwrap(), Some(receipt));
}

#[test]
fn strict_legacy_receipt_rejects_an_invalid_nested_listener_port() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    capture_legacy(
        &store,
        &request(&runtime),
        &FakeProcessInspector::stable(&runtime.old_executable),
        &FakeScratchProbe::passing(),
    )
    .unwrap();
    let receipt_path = store.paths().legacy_receipt();
    let mut receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(receipt_path).unwrap()).unwrap();
    receipt["process"]["listener"]["port"] = json!(0);
    fs::write(receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();

    assert!(matches!(
        store.read_legacy_capture(),
        Err(DeployError::InvalidReceipt(message)) if message.contains("port")
    ));
}

#[test]
fn legacy_live_binding_must_match_authoritative_legacy_process_exactly() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let store = Store::open(fixture.path(), DeployPort::new(PORT).unwrap()).unwrap();
    capture_legacy(
        &store,
        &request(&runtime),
        &FakeProcessInspector::stable(&runtime.old_executable),
        &FakeScratchProbe::passing(),
    )
    .unwrap();
    let mut live: serde_json::Value =
        serde_json::from_slice(&fs::read(store.paths().live_receipt()).unwrap()).unwrap();
    live["processIdentity"]["runtime"]["clientDir"] =
        serde_json::Value::String(fixture.path().join("forged-client").display().to_string());
    fs::write(
        store.paths().live_receipt(),
        serde_json::to_vec(&live).unwrap(),
    )
    .unwrap();

    assert!(matches!(
        store.read_live(),
        Err(DeployError::InvalidReceipt(message)) if message.contains("legacy.json")
    ));
}

#[test]
fn linux_proc_fixture_maps_exact_listening_socket_inode_to_one_pid() {
    let proc = tempfile::tempdir().unwrap();
    fs::create_dir_all(proc.path().join("net")).unwrap();
    fs::write(
        proc.path().join("net/tcp"),
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
         0: 0100007F:0D7B 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 991122\n",
    )
    .unwrap();
    fs::write(proc.path().join("net/tcp6"), "").unwrap();
    fs::create_dir_all(proc.path().join(format!("{PID}/fd"))).unwrap();
    fs::create_dir_all(proc.path().join(format!("{PID}/ns"))).unwrap();
    symlink("socket:[991122]", proc.path().join(format!("{PID}/fd/9"))).unwrap();
    symlink(
        "net:[4026533111]",
        proc.path().join(format!("{PID}/ns/net")),
    )
    .unwrap();

    let resolved = LinuxProcfs::with_root(proc.path())
        .resolve_listener(DeployPort::new(PORT).unwrap())
        .expect("listener owner");

    assert_eq!(resolved, listener(PID));
}

#[test]
fn exact_pid_listener_resolution_ignores_unrelated_uninspectable_processes() {
    let proc = tempfile::tempdir().unwrap();
    fs::create_dir_all(proc.path().join("net")).unwrap();
    fs::write(
        proc.path().join("net/tcp"),
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
         0: 0100007F:0D7B 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 991122\n",
    )
    .unwrap();
    fs::write(proc.path().join("net/tcp6"), "").unwrap();
    fs::create_dir_all(proc.path().join(format!("{PID}/fd"))).unwrap();
    fs::create_dir_all(proc.path().join(format!("{PID}/ns"))).unwrap();
    symlink("socket:[991122]", proc.path().join(format!("{PID}/fd/9"))).unwrap();
    symlink(
        "net:[4026533111]",
        proc.path().join(format!("{PID}/ns/net")),
    )
    .unwrap();
    fs::create_dir(proc.path().join("160")).unwrap();
    fs::write(
        proc.path().join("160/fd"),
        "an unrelated process whose descriptors cannot be enumerated",
    )
    .unwrap();

    let resolved = LinuxProcfs::with_root(proc.path())
        .resolve_listener_for_pid(DeployPort::new(PORT).unwrap(), PID)
        .expect("exact hinted listener owner");

    assert_eq!(resolved, listener(PID));
}

#[test]
fn recorded_listener_continuity_fails_closed_when_process_socket_ownership_cannot_be_proved() {
    let proc = tempfile::tempdir().unwrap();
    fs::create_dir_all(proc.path().join("net")).unwrap();
    fs::write(
        proc.path().join("net/tcp"),
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
         0: 0100007F:0D7B 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 991122\n",
    )
    .unwrap();
    fs::write(proc.path().join("net/tcp6"), "").unwrap();
    fs::create_dir_all(proc.path().join(format!("{PID}/ns"))).unwrap();
    fs::write(
        proc.path().join(format!("{PID}/fd")),
        "the established process is no longer ptrace-inspectable",
    )
    .unwrap();
    symlink(
        "net:[4026533111]",
        proc.path().join(format!("{PID}/ns/net")),
    )
    .unwrap();
    let expected = listener(PID);

    let error = LinuxProcfs::with_root(proc.path())
        .resolve_recorded_listener(&expected)
        .expect_err("recorded pid must still prove ownership of the listener socket");

    assert!(
        error
            .to_string()
            .contains(&format!("cannot inspect expected pid {PID} fd directory")),
        "{error}"
    );
}

#[test]
fn linux_proc_fixture_rejects_ambiguous_reuseport_listener_inodes() {
    let proc = tempfile::tempdir().unwrap();
    fs::create_dir_all(proc.path().join("net")).unwrap();
    fs::write(
        proc.path().join("net/tcp"),
        "  sl  local_address rem_address st tx rx tr tm retr uid timeout inode\n\
         0: 0100007F:0D7B 00000000:0000 0A 0:0 00:0 0 1000 0 991122\n\
         1: 0100007F:0D7B 00000000:0000 0A 0:0 00:0 0 1000 0 991123\n",
    )
    .unwrap();
    fs::write(proc.path().join("net/tcp6"), "").unwrap();

    assert!(matches!(
        LinuxProcfs::with_root(proc.path())
            .resolve_listener(DeployPort::new(PORT).unwrap()),
        Err(DeployError::ProcessIdentity(message)) if message.contains("ambiguous")
    ));
}

#[test]
#[ignore = "Docker-only helper for the actual /proc capture test"]
fn live_listener_helper() {
    require_destructive_test_sandbox();
    let port: u16 = std::env::var("FRESHELL_DEPLOY_TEST_PORT")
        .expect("helper port")
        .parse()
        .expect("numeric helper port");
    let ready =
        PathBuf::from(std::env::var_os("FRESHELL_DEPLOY_TEST_READY").expect("helper ready path"));
    let listener = std::net::TcpListener::bind(("127.0.0.1", port)).expect("bind helper listener");
    fs::write(ready, "ready\n").expect("publish helper readiness");
    for stream in listener.incoming() {
        let mut stream = stream.expect("accept helper request");
        use std::io::Read as _;
        let mut request = [0_u8; 1024];
        let _ = stream.read(&mut request).unwrap();
        let client = fs::read(
            PathBuf::from(std::env::var_os("FRESHELL_CLIENT_DIR").unwrap()).join("index.html"),
        )
        .unwrap();
        use std::io::Write as _;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            client.len()
        )
        .unwrap();
        stream.write_all(&client).unwrap();
    }
}

#[test]
#[ignore = "Docker-only: executes and terminates real Node and scratch-server processes"]
fn real_scratch_probe_executes_the_complete_captured_closure() {
    require_destructive_test_sandbox();

    let fixture = tempfile::tempdir().unwrap();
    let generation = fixture.path().join("generation");
    let home = fixture.path().join("home");
    for directory in [
        "server",
        "client",
        "extensions/terminal",
        "dist/server/mcp",
        "claude-sidecar",
        "node_modules",
    ] {
        fs::create_dir_all(generation.join(directory)).unwrap();
    }
    fs::create_dir(&home).unwrap();
    fs::write(generation.join("client/index.html"), b"real scratch client").unwrap();
    fs::write(
        generation.join("extensions/terminal/freshell.json"),
        r#"{"name":"terminal"}"#,
    )
    .unwrap();
    fs::write(
        generation.join("package.json"),
        r#"{"name":"scratch","type":"module"}"#,
    )
    .unwrap();
    fs::write(generation.join("package-lock.json"), "{}").unwrap();
    fs::write(
        generation.join("dist/server/mcp/server.js"),
        "export const scratch = true;\n",
    )
    .unwrap();
    fs::write(
        generation.join("claude-sidecar/index.mjs"),
        "import readline from 'node:readline';\n\
         const rl=readline.createInterface({input:process.stdin});\n\
         rl.once('line',()=>{rl.close();process.exit(0)});\n",
    )
    .unwrap();

    let python = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|directory| directory.join("python3"))
        .find(|candidate| candidate.is_file())
        .expect("python3 in Docker image");
    let server = generation.join("server/freshell-server");
    let source = format!("#!{}\n", python.display())
        + r#"import http.server,json,os,socketserver
class Handler(http.server.BaseHTTPRequestHandler):
  protocol_version='HTTP/1.1'
  def log_message(self,*args): pass
  def do_GET(self):
    if self.path == '/api/health':
      body=b'{"app":"freshell","ok":true,"ready":true}'
    elif self.path == '/':
      body=open(os.path.join(os.environ['FRESHELL_CLIENT_DIR'],'index.html'),'rb').read()
    elif self.path == '/api/extensions':
      body=b'[{"name":"terminal"}]'
    else:
      self.send_response(404); self.end_headers(); return
    self.send_response(200); self.send_header('Content-Length',str(len(body)))
    self.end_headers(); self.wfile.write(body)
server=socketserver.TCPServer((os.environ['FRESHELL_BIND_HOST'],0),Handler)
address='{}:{}'.format(*server.server_address)
receipt={'schemaVersion':'1','nonce':os.environ['FRESHELL_DEPLOY_NONCE'],
 'actualAddress':address,'pid':os.getpid(),'bootId':'fixture-boot',
 'instanceId':'fixture-instance',
 'serverProcessGenerationId':os.environ['FRESHELL_DEPLOY_GENERATION_ID'],
 'serverComponentVersion':'fixture-version','buildCommit':'fixture-commit'}
open(os.environ['FRESHELL_DEPLOY_READY_FILE'],'w').write(json.dumps(receipt))
server.serve_forever()
"#;
    fs::write(&server, source).unwrap();
    fs::set_permissions(&server, fs::Permissions::from_mode(0o755)).unwrap();

    let node = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|directory| directory.join("node"))
        .find(|candidate| candidate.is_file())
        .map(|candidate| fs::canonicalize(candidate).unwrap())
        .expect("node in Docker image");
    let version = std::process::Command::new(&node)
        .arg("--version")
        .output()
        .unwrap();
    assert!(version.status.success());
    let request = ScratchProbeRequest {
        generation_path: generation.clone(),
        generation_id: "a".repeat(64),
        isolated_home: home.clone(),
        port: 0,
        runtime: RuntimeBindings {
            server_executable: "server/freshell-server".to_string(),
            client_dir: "client".to_string(),
            extensions_dir: "extensions".to_string(),
            dist_server_dir: "dist/server".to_string(),
            mcp_entry: "dist/server/mcp/server.js".to_string(),
            claude_sidecar_entry: "claude-sidecar/index.mjs".to_string(),
            package_json: "package.json".to_string(),
            package_lock: "package-lock.json".to_string(),
            production_node_modules: "node_modules".to_string(),
        },
        node: NodePrerequisite {
            executable: node,
            version: String::from_utf8(version.stdout)
                .unwrap()
                .trim()
                .to_string(),
        },
    };

    RealScratchProbe::default()
        .verify(&request)
        .expect("real scratch closure");
    let ready: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("ready.json")).unwrap()).unwrap();
    let pid = ready["pid"].as_u64().unwrap();
    assert!(
        !Path::new(&format!("/proc/{pid}")).exists(),
        "successful validation must terminate and reap its scratch server"
    );

    fs::write(
        generation.join("extensions/terminal/freshell.json"),
        r#"{"name":"different"}"#,
    )
    .unwrap();
    fs::remove_file(home.join("ready.json")).unwrap();
    let error = RealScratchProbe::default().verify(&request).unwrap_err();
    assert!(error.to_string().contains("extension registry"), "{error}");
    let failed_ready: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join("ready.json")).unwrap()).unwrap();
    let failed_pid = failed_ready["pid"].as_u64().unwrap();
    assert!(
        !Path::new(&format!("/proc/{failed_pid}")).exists(),
        "an early HTTP validation failure must still terminate and reap its scratch server"
    );
}

#[test]
#[ignore = "Docker-only: compiles, executes, and terminates a real fallback listener"]
fn actual_proc_capture_uses_binary_compile_fallbacks_instead_of_launch_cwd() {
    require_destructive_test_sandbox();

    struct ChildCleanup(Option<std::process::Child>);

    impl Drop for ChildCleanup {
        fn drop(&mut self) {
            if let Some(child) = self.0.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let compiled = fixture.path().join("compiled-source");
    for directory in [
        "crates/freshell-server",
        "crates/freshell-freshagent",
        "crates/freshell-claude-sidecar",
        "dist/client",
    ] {
        fs::create_dir_all(compiled.join(directory)).unwrap();
    }
    fs::write(
        compiled.join("crates/freshell-server/Cargo.toml"),
        "[package]\nname = \"freshell-server\"\n",
    )
    .unwrap();
    fs::write(
        compiled.join("dist/client/index.html"),
        "compiled client closure",
    )
    .unwrap();
    for file in ["index.mjs", "package.json", "package-lock.json"] {
        fs::copy(
            runtime.sources.claude_sidecar_dir.join(file),
            compiled.join("crates/freshell-claude-sidecar").join(file),
        )
        .unwrap();
    }
    fs::write(
        compiled.join("crates/freshell-claude-sidecar/index.mjs"),
        "import 'sidecar-package'; // compiled sidecar closure\n",
    )
    .unwrap();

    fs::create_dir_all(fixture.path().join("dist/client")).unwrap();
    fs::write(
        fixture.path().join("dist/client/index.html"),
        "launch-cwd decoy client",
    )
    .unwrap();
    symlink(
        &runtime.sources.dist_server_dir,
        fixture.path().join("dist/server"),
    )
    .unwrap();
    fs::create_dir_all(fixture.path().join("crates/freshell-claude-sidecar")).unwrap();
    fs::write(
        fixture
            .path()
            .join("crates/freshell-claude-sidecar/index.mjs"),
        "launch-cwd decoy sidecar",
    )
    .unwrap();
    for (source, destination) in [
        (
            runtime.sources.package_json.as_path(),
            fixture.path().join("package.json"),
        ),
        (
            runtime.sources.package_lock.as_path(),
            fixture.path().join("package-lock.json"),
        ),
        (
            runtime.sources.production_node_modules.as_path(),
            fixture.path().join("node_modules"),
        ),
    ] {
        symlink(source, destination).unwrap();
    }

    let source = fixture.path().join("fallback-listener.rs");
    fs::write(
        &source,
        r#"use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;

const SERVER_MANIFEST: &str = env!("CARGO_MANIFEST_DIR");
const SIDECAR: &str = concat!(
    env!("FRESHELL_FRESHAGENT_MANIFEST_DIR"),
    "/../freshell-claude-sidecar/index.mjs"
);

fn main() {
    fs::metadata(SIDECAR).unwrap();
    let port: u16 = std::env::var("FRESHELL_DEPLOY_TEST_PORT").unwrap().parse().unwrap();
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    fs::write(std::env::var_os("FRESHELL_DEPLOY_TEST_READY").unwrap(), "ready\n").unwrap();
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        let mut request = [0_u8; 1024];
        let _ = stream.read(&mut request).unwrap();
        let client = fs::read(Path::new(SERVER_MANIFEST).join("../../dist/client/index.html")).unwrap();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            client.len()
        ).unwrap();
        stream.write_all(&client).unwrap();
    }
}
"#,
    )
    .unwrap();
    let listener_executable = fixture.path().join("fallback-listener");
    let compile = std::process::Command::new("rustc")
        .arg(&source)
        .arg("-o")
        .arg(&listener_executable)
        .env(
            "CARGO_MANIFEST_DIR",
            compiled.join("crates/freshell-server"),
        )
        .env(
            "FRESHELL_FRESHAGENT_MANIFEST_DIR",
            compiled.join("crates/freshell-freshagent"),
        )
        .status()
        .expect("run rustc in Docker");
    assert!(compile.success());

    let port = {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    };
    let ready = fixture.path().join("fallback-listener-ready");
    let child = std::process::Command::new(&listener_executable)
        .current_dir(fixture.path())
        .env("FRESHELL_DEPLOY_TEST_PORT", port.to_string())
        .env("FRESHELL_DEPLOY_TEST_READY", &ready)
        .env("FRESHELL_EXTENSIONS_DIR", &runtime.sources.extensions_dir)
        .env(
            "FRESHELL_CLAUDE_NODE",
            runtime.sources.package_json.parent().unwrap().join("node"),
        )
        .env(
            "FRESHELL_MCP_SERVER_ENTRY",
            runtime
                .sources
                .dist_server_dir
                .join(&runtime.sources.mcp_entry_relative),
        )
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut child = ChildCleanup(Some(child));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !ready.is_file() && std::time::Instant::now() < deadline {
        assert!(child.0.as_mut().unwrap().try_wait().unwrap().is_none());
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(ready.is_file());

    let store = Store::open(fixture.path(), DeployPort::new(port).unwrap()).unwrap();
    let mut live_request = request(&runtime);
    live_request.pid_hint = child.0.as_ref().unwrap().id();
    live_request.port = DeployPort::new(port).unwrap();
    live_request.runtime.client_dir = compiled.join("dist/client");
    live_request.runtime.claude_sidecar_dir = compiled.join("crates/freshell-claude-sidecar");
    let receipt = capture_legacy(
        &store,
        &live_request,
        &LinuxProcfs::default(),
        &FakeScratchProbe::passing(),
    )
    .expect("capture compile-time fallback closure");

    let generation = store.verify_generation(&receipt.generation_id).unwrap();
    assert_eq!(
        fs::read_to_string(generation.path.join("client/index.html")).unwrap(),
        "compiled client closure"
    );
    assert_eq!(
        fs::read_to_string(generation.path.join("claude-sidecar/index.mjs")).unwrap(),
        "import 'sidecar-package'; // compiled sidecar closure\n"
    );
    assert!(child.0.as_mut().unwrap().try_wait().unwrap().is_none());
}

#[test]
#[ignore = "Docker-only: spawns, unlinks, and kills a real listener process"]
fn actual_proc_capture_pins_the_unlinked_listener_executable() {
    require_destructive_test_sandbox();

    struct ChildCleanup(Option<std::process::Child>);

    impl Drop for ChildCleanup {
        fn drop(&mut self) {
            if let Some(child) = self.0.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    fs::create_dir(fixture.path().join("dist")).unwrap();
    symlink(
        &runtime.sources.dist_server_dir,
        fixture.path().join("dist/server"),
    )
    .unwrap();
    symlink(
        &runtime.sources.package_json,
        fixture.path().join("package.json"),
    )
    .unwrap();
    symlink(
        &runtime.sources.package_lock,
        fixture.path().join("package-lock.json"),
    )
    .unwrap();
    symlink(
        &runtime.sources.production_node_modules,
        fixture.path().join("node_modules"),
    )
    .unwrap();
    let listener_executable = fixture.path().join("freshell-listener");
    fs::copy(std::env::current_exe().unwrap(), &listener_executable).unwrap();
    fs::set_permissions(&listener_executable, fs::Permissions::from_mode(0o755)).unwrap();
    let expected_executable =
        FileIdentity::from_path(&listener_executable).expect("pre-unlink executable identity");
    let port = {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    };
    let ready = fixture.path().join("listener-ready");
    let child = std::process::Command::new(&listener_executable)
        .args([
            "--ignored",
            "--exact",
            "live_listener_helper",
            "--test-threads=1",
        ])
        .current_dir(fixture.path())
        .env("FRESHELL_DEPLOY_TEST_PORT", port.to_string())
        .env("FRESHELL_DEPLOY_TEST_READY", &ready)
        .env("FRESHELL_CLIENT_DIR", &runtime.sources.client_dir)
        .env("FRESHELL_EXTENSIONS_DIR", &runtime.sources.extensions_dir)
        .env(
            "FRESHELL_CLAUDE_SIDECAR",
            runtime
                .sources
                .claude_sidecar_dir
                .join(&runtime.sources.claude_sidecar_entry_relative),
        )
        .env(
            "FRESHELL_CLAUDE_NODE",
            runtime.sources.package_json.parent().unwrap().join("node"),
        )
        .env(
            "FRESHELL_MCP_SERVER_ENTRY",
            runtime
                .sources
                .dist_server_dir
                .join(&runtime.sources.mcp_entry_relative),
        )
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn listener helper");
    let mut child = ChildCleanup(Some(child));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !ready.is_file() && std::time::Instant::now() < deadline {
        assert!(
            child.0.as_mut().unwrap().try_wait().unwrap().is_none(),
            "listener helper exited before readiness"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(ready.is_file(), "listener helper readiness timed out");

    fs::remove_file(&listener_executable).unwrap();
    fs::write(&listener_executable, b"replacement path bytes").unwrap();
    fs::set_permissions(&listener_executable, fs::Permissions::from_mode(0o755)).unwrap();
    assert_ne!(
        fs::read(&listener_executable).unwrap(),
        fs::read(format!("/proc/{}/exe", child.0.as_ref().unwrap().id())).unwrap()
    );

    let store = Store::open(fixture.path(), DeployPort::new(port).unwrap()).unwrap();
    let mut live_request = request(&runtime);
    live_request.pid_hint = child.0.as_ref().unwrap().id();
    live_request.port = DeployPort::new(port).unwrap();
    let receipt = capture_legacy(
        &store,
        &live_request,
        &LinuxProcfs::default(),
        &FakeScratchProbe::passing(),
    )
    .expect("actual /proc capture");

    assert_eq!(receipt.process.executable, expected_executable);
    assert_eq!(receipt.process.listener.owner_pid, live_request.pid_hint);
    assert_eq!(receipt.process.listener.port, live_request.port);
    assert_eq!(receipt.process.cwd, fixture.path().to_str().unwrap());
    assert!(
        child.0.as_mut().unwrap().try_wait().unwrap().is_none(),
        "capture must keep the observed listener alive"
    );
    let generation = store.verify_generation(&receipt.generation_id).unwrap();
    assert_eq!(
        fs::read(generation.path.join("server/freshell-server")).unwrap(),
        fs::read(format!("/proc/{}/exe", live_request.pid_hint)).unwrap()
    );
}

const DESTRUCTIVE_SANDBOX_SENTINEL: &str = "FRESHELL_DESTRUCTIVE_TEST_SANDBOX";

fn destructive_sandbox_enabled(value: Option<&std::ffi::OsStr>) -> bool {
    value == Some(std::ffi::OsStr::new("1"))
}

fn require_destructive_test_sandbox() {
    assert!(
        destructive_sandbox_enabled(std::env::var_os(DESTRUCTIVE_SANDBOX_SENTINEL).as_deref()),
        "this process/signal test must run through scripts/sandbox-test.sh"
    );
}

#[test]
fn actual_process_test_requires_the_exact_sandbox_sentinel() {
    assert!(!destructive_sandbox_enabled(None));
    assert!(!destructive_sandbox_enabled(Some(std::ffi::OsStr::new(
        "true"
    ))));
    assert!(destructive_sandbox_enabled(Some(std::ffi::OsStr::new("1"))));
}

#[test]
fn capture_command_parser_requires_explicit_nonduplicated_runtime_inputs() {
    let fixture = checkout();
    let runtime = runtime_fixture(fixture.path());
    let pid_file = fixture.path().join("legacy.pid");
    fs::write(&pid_file, PID.to_string()).unwrap();
    let args = vec![
        "capture".into(),
        "--checkout".into(),
        fixture.path().as_os_str().to_owned(),
        "--port".into(),
        PORT.to_string().into(),
        "--pid-file".into(),
        pid_file.as_os_str().to_owned(),
        "--client-dir".into(),
        runtime.sources.client_dir.as_os_str().to_owned(),
        "--extensions-dir".into(),
        runtime.sources.extensions_dir.as_os_str().to_owned(),
        "--dist-server-dir".into(),
        runtime.sources.dist_server_dir.as_os_str().to_owned(),
        "--mcp-entry-relative".into(),
        runtime.sources.mcp_entry_relative.as_os_str().to_owned(),
        "--claude-sidecar-dir".into(),
        runtime.sources.claude_sidecar_dir.as_os_str().to_owned(),
        "--claude-sidecar-entry-relative".into(),
        runtime
            .sources
            .claude_sidecar_entry_relative
            .as_os_str()
            .to_owned(),
        "--package-json".into(),
        runtime.sources.package_json.as_os_str().to_owned(),
        "--package-lock".into(),
        runtime.sources.package_lock.as_os_str().to_owned(),
        "--node-modules".into(),
        runtime
            .sources
            .production_node_modules
            .as_os_str()
            .to_owned(),
        "--node-executable".into(),
        runtime
            .sources
            .package_json
            .parent()
            .unwrap()
            .join("node")
            .into_os_string(),
        "--node-version".into(),
        "v22.18.0".into(),
    ];

    let parsed = CaptureCommand::parse(args.clone()).expect("complete capture command");
    assert_eq!(parsed.port, DeployPort::new(PORT).unwrap());
    assert_eq!(parsed.pid_hint().unwrap(), PID);
    assert_eq!(
        parsed.runtime.mcp_entry_relative,
        PathBuf::from("mcp/server.js")
    );

    let mut duplicate = args;
    duplicate.extend([OsString::from("--port"), OsString::from(PORT.to_string())]);
    assert!(matches!(
        CaptureCommand::parse(duplicate),
        Err(DeployError::LegacyCapture(message)) if message.contains("duplicate")
    ));
    assert!(CaptureCommand::parse(vec!["capture".into(), "--port".into(), "0".into()]).is_err());
}

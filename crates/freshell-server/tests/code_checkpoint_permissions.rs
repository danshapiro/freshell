#![cfg(all(unix, feature = "managed-runtime-v1"))]

//! Black-box permission and publication proof for automatic code snapshots.
//! Run only through `scripts/sandbox-test.sh --runtime-suite --checkpoint-fixture
//! "cargo test -p freshell-server --features managed-runtime-v1 --locked --test
//! code_checkpoint_permissions"`; the trusted entrypoint creates the root-owned
//! unreadable sentinels and this test observes them only as the sandbox user.

use std::ffi::OsString;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

const AUTH_TOKEN: &str = "checkpoint-fixture-auth-marker-do-not-log";
const OUTGOING_MARKER: &str = "checkpoint-fixture-outgoing-text-do-not-log";

struct OwnedServer(Option<Child>);

impl OwnedServer {
    fn start(port: u16, home: &Path, log_dir: &Path, path: Option<OsString>) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_freshell-server"));
        command
            .env("PORT", port.to_string())
            .env("AUTH_TOKEN", AUTH_TOKEN)
            .env("FRESHELL_HOME", home)
            .env("HOME", home)
            .env("FRESHELL_LOG_DIR", log_dir)
            .env("FRESHELL_BIND_HOST", "127.0.0.1")
            .env("FRESHELL_DISABLE_WSL_PORT_FORWARD", "1")
            .env_remove("FRESHELL_MANAGED_RUNTIME_V1");
        if let Some(path) = path {
            command.env("PATH", path);
        }
        let child = command
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the compiled Freshell server as the restricted fixture user");
        Self(Some(child))
    }

    fn child_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("server child is still owned")
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

struct GitBarrierCleanup {
    pid_path: PathBuf,
    release_path: PathBuf,
    wrapper_path: PathBuf,
    wrapper_dir: PathBuf,
}

impl Drop for GitBarrierCleanup {
    fn drop(&mut self) {
        if let (Ok(raw_pid), Ok(wrapper)) = (
            fs::read_to_string(&self.pid_path),
            self.wrapper_path.to_str().ok_or(()),
        ) {
            if let Ok(pid) = raw_pid.trim().parse::<i32>() {
                let command_line = fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
                if String::from_utf8_lossy(&command_line).contains(wrapper) {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
        }
        let _ = fs::write(&self.release_path, "release\n");
        let _ = fs::remove_dir_all(&self.wrapper_dir);
    }
}

impl Drop for OwnedServer {
    fn drop(&mut self) {
        self.stop();
    }
}

fn fixture_root() -> PathBuf {
    let root = std::env::var_os("FRESHELL_CHECKPOINT_FIXTURE_ROOT")
        .map(PathBuf::from)
        .expect("run via --runtime-suite --checkpoint-fixture");
    assert_eq!(root, PathBuf::from("/tmp/freshell-checkpoint-fixture"));
    root
}

fn effective_capabilities() -> u64 {
    let status = fs::read_to_string("/proc/self/status").expect("read process status");
    let line = status
        .lines()
        .find(|line| line.starts_with("CapEff:"))
        .expect("CapEff line exists");
    u64::from_str_radix(line.split_whitespace().nth(1).unwrap(), 16).unwrap()
}

async fn wait_for_health(port: u16, child: &mut Child) {
    let client = Client::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().expect("poll owned server") {
            panic!("server exited before health became ready: {status}");
        }
        if client
            .get(format!("http://127.0.0.1:{port}/api/health"))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("server did not become healthy on loopback port {port}");
}

fn allocate_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("read local port").port()
}

async fn post_json(client: &Client, url: &str, body: Value) -> (StatusCode, Value) {
    let response = client
        .post(url)
        .header("x-auth-token", AUTH_TOKEN)
        .json(&body)
        .send()
        .await
        .expect("checkpoint HTTP request completes");
    let status = response.status();
    let value = response.json().await.expect("checkpoint response is JSON");
    (status, value)
}

fn workspace_intent(path: &Path) -> Value {
    json!({ "path": path, "provenance": "directory-picker" })
}

async fn list_workspace(client: &Client, base: &str, cwd: &Path, workspace: &Path) -> Vec<Value> {
    // The closed fixture uses fixed slash-only paths without query delimiters;
    // formatting avoids enabling reqwest's optional query feature solely here.
    let url = format!(
        "{base}/api/fresh-agent/checkpoints?cwd={}&workspacePath={}&workspaceProvenance=directory-picker",
        cwd.display(),
        workspace.display(),
    );
    let response = client
        .get(url)
        .header("x-auth-token", AUTH_TOKEN)
        .send()
        .await
        .expect("checkpoint list request completes");
    assert_eq!(response.status(), StatusCode::OK);
    response.json::<Value>().await.unwrap()["checkpoints"]
        .as_array()
        .unwrap()
        .clone()
}

fn shadow_repo(home: &Path, workspace: &Path) -> PathBuf {
    let canonical = fs::canonicalize(workspace).expect("workspace canonical path");
    let digest = format!("{:x}", Sha1::digest(canonical.to_string_lossy().as_bytes()));
    home.join(".freshell")
        .join("checkpoints")
        .join(format!("{}.git", &digest[..16]))
}

fn run_git(args: &[&str], cwd: &Path) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("start Git fixture command");
    assert!(
        output.status.success(),
        "Git fixture command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn denied_file_read(path: &Path) {
    let error = fs::File::open(path).expect_err("restricted source file must not be readable");
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
}

#[tokio::test]
async fn restricted_checkpoint_routes_preserve_complete_targets_and_log_correlated_failures() {
    let root = fixture_root();
    assert_ne!(unsafe { libc::geteuid() }, 0, "fixture must run as UID B");
    assert_eq!(
        effective_capabilities(),
        0,
        "fixture user must have no capabilities"
    );

    let home = root.join("home");
    let storage = root.join("storage");
    let project = root.join("project");
    let private_file_ignored = project.join("private-file.ignored");
    let private_file = project.join("private-file");
    let private_dir_ignored = project.join("private-dir.ignored");
    let private_dir = project.join("private-dir");
    let ignore_text = fs::read_to_string(project.join(".gitignore")).unwrap();
    assert!(ignore_text
        .lines()
        .any(|line| line == "private-file.ignored"));
    assert!(ignore_text
        .lines()
        .any(|line| line == "private-dir.ignored/"));

    denied_file_read(&private_file_ignored);
    assert_eq!(
        fs::read_dir(&private_dir_ignored)
            .expect_err("restricted directory must not be traversable")
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    let private_file_mode = fs::symlink_metadata(&private_file_ignored).unwrap();
    let private_dir_mode = fs::symlink_metadata(&private_dir_ignored).unwrap();
    assert_eq!(private_file_mode.uid(), 0);
    assert_eq!(private_file_mode.mode() & 0o777, 0o600);
    assert_eq!(private_dir_mode.uid(), 0);
    assert_eq!(private_dir_mode.mode() & 0o777, 0o700);

    // B can change eligibility only by same-parent rename; ownership and mode
    // remain those prepared by the trusted root initializer.
    fs::rename(&private_file_ignored, &private_file).unwrap();
    denied_file_read(&private_file);
    fs::rename(&private_file, &private_file_ignored).unwrap();
    fs::rename(&private_dir_ignored, &private_dir).unwrap();
    assert_eq!(
        fs::read_dir(&private_dir)
            .expect_err("renamed restricted directory remains non-traversable")
            .kind(),
        std::io::ErrorKind::PermissionDenied
    );
    fs::rename(&private_dir, &private_dir_ignored).unwrap();
    let file_after_rename = fs::symlink_metadata(&private_file_ignored).unwrap();
    let dir_after_rename = fs::symlink_metadata(&private_dir_ignored).unwrap();
    assert_eq!(
        (file_after_rename.uid(), file_after_rename.mode() & 0o777),
        (0, 0o600)
    );
    assert_eq!(
        (dir_after_rename.uid(), dir_after_rename.mode() & 0o777),
        (0, 0o700)
    );

    fs::write(project.join("main.rs"), "before\n").unwrap();
    fs::write(project.join("run.sh"), "#!/bin/sh\necho before\n").unwrap();
    fs::set_permissions(project.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    std::os::unix::fs::symlink("main.rs", project.join("main-link")).unwrap();
    run_git(&["init", "-q"], &project);
    let outer_status_before = run_git(&["status", "--porcelain"], &project);

    fs::create_dir_all(storage.join("logs")).unwrap();
    let port = allocate_port();
    let mut server = OwnedServer::start(port, &home, &storage.join("logs"), None);
    wait_for_health(port, server.child_mut()).await;

    let client = Client::new();
    let base = format!("http://127.0.0.1:{port}");
    let checkpoints_url = format!("{base}/api/fresh-agent/checkpoints");

    // HOME is launch/routing cwd only when no separate workspace intent is
    // present. It must not create a home-keyed checkpoint store.
    let (home_status, home_error) = post_json(
        &client,
        &checkpoints_url,
        json!({ "cwd": home, "label": OUTGOING_MARKER, "requestId": "send-home-refused" }),
    )
    .await;
    assert_eq!(home_status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(home_error["code"], "workspace_unavailable");
    assert!(!home.join(".freshell/checkpoints").exists());

    let (create_status, created) = post_json(
        &client,
        &checkpoints_url,
        json!({
            "cwd": home,
            "workspace": workspace_intent(&project),
            "label": "readable git snapshot",
            "requestId": "send-initial-success",
        }),
    )
    .await;
    assert_eq!(
        create_status,
        StatusCode::OK,
        "{created}; logs {}",
        fs::read_to_string(storage.join("logs/rust-server.jsonl")).unwrap()
    );
    let checkpoint_id = created["id"].as_str().unwrap().to_string();
    assert_eq!(
        created["workspace"]["path"],
        project.to_string_lossy().as_ref()
    );

    fs::write(project.join("main.rs"), "after\n").unwrap();
    fs::write(project.join("run.sh"), "#!/bin/sh\necho after\n").unwrap();
    fs::set_permissions(project.join("run.sh"), fs::Permissions::from_mode(0o644)).unwrap();
    fs::remove_file(project.join("main-link")).unwrap();
    std::os::unix::fs::symlink("run.sh", project.join("main-link")).unwrap();

    let (restore_status, restore_body) = post_json(
        &client,
        &format!("{base}/api/fresh-agent/checkpoints/restore"),
        json!({
            "cwd": home,
            "workspace": workspace_intent(&project),
            "id": checkpoint_id,
        }),
    )
    .await;
    assert_eq!(restore_status, StatusCode::OK, "{restore_body}");
    assert_eq!(
        fs::read_to_string(project.join("main.rs")).unwrap(),
        "before\n"
    );
    assert_eq!(
        fs::metadata(project.join("run.sh")).unwrap().mode() & 0o777,
        0o755
    );
    assert_eq!(
        fs::read_link(project.join("main-link")).unwrap(),
        Path::new("main.rs")
    );

    let outer_status_after = run_git(&["status", "--porcelain"], &project);
    assert_eq!(outer_status_before, outer_status_after);

    // Make a previously ignored, root-owned private file eligible. Git itself
    // may report the denial during `add`; the route must reject publication
    // with a stable, safe reason and leave the previous complete target valid.
    fs::rename(&private_file_ignored, &private_file).unwrap();
    let (file_failure_status, file_failure) = post_json(
        &client,
        &checkpoints_url,
        json!({
            "cwd": home,
            "workspace": workspace_intent(&project),
            "label": OUTGOING_MARKER,
            "requestId": "send-private-file",
        }),
    )
    .await;
    assert_ne!(file_failure_status, StatusCode::OK);
    let file_failure_log = fs::read_to_string(storage.join("logs/rust-server.jsonl"))
        .unwrap()
        .lines()
        .filter(|line| line.contains("send-private-file"))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(
        file_failure["code"], "checkpoint_path_unreadable",
        "response {file_failure}; correlated log {file_failure_log}"
    );
    fs::rename(&private_file, &private_file_ignored).unwrap();

    fs::rename(&private_dir_ignored, &private_dir).unwrap();
    let (dir_failure_status, dir_failure) = post_json(
        &client,
        &checkpoints_url,
        json!({
            "cwd": home,
            "workspace": workspace_intent(&project),
            "label": OUTGOING_MARKER,
            "requestId": "send-private-dir",
        }),
    )
    .await;
    assert_ne!(dir_failure_status, StatusCode::OK);
    assert_eq!(dir_failure["code"], "checkpoint_path_unreadable");
    fs::rename(&private_dir, &private_dir_ignored).unwrap();

    let previous = list_workspace(&client, &base, &home, &project).await;
    assert_eq!(previous.len(), 1);
    assert_eq!(previous[0]["id"], checkpoint_id);
    assert_eq!(
        previous[0]["workspace"]["path"],
        project.to_string_lossy().as_ref()
    );

    // A real metadata-store read failure happens after the new Git commit
    // object is created. Its orphan is not published and cannot be restored.
    let git_dir = shadow_repo(&home, &project);
    let metadata_path = git_dir.join("freshell-checkpoint-metadata.json");
    let metadata_backup = git_dir.join("freshell-checkpoint-metadata.json.fixture-backup");
    assert!(metadata_path.is_file());
    fs::rename(&metadata_path, &metadata_backup).unwrap();
    fs::create_dir(&metadata_path).unwrap();
    let (storage_failure_status, storage_failure) = post_json(
        &client,
        &checkpoints_url,
        json!({
            "cwd": home,
            "workspace": workspace_intent(&project),
            "label": OUTGOING_MARKER,
            "requestId": "send-storage-failure",
        }),
    )
    .await;
    assert_eq!(storage_failure_status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(storage_failure["code"], "checkpoint_capture_failed");
    fs::remove_dir(&metadata_path).unwrap();
    fs::rename(&metadata_backup, &metadata_path).unwrap();

    let fsck = run_git(
        &[
            "--git-dir",
            git_dir.to_str().unwrap(),
            "fsck",
            "--full",
            "--no-reflogs",
        ],
        &root,
    );
    let orphan_id = fsck
        .lines()
        .find_map(|line| {
            let mut words = line.split_whitespace();
            let relation = words.next()?;
            let kind = words.next()?;
            let id = words.next()?;
            ((relation == "dangling" || relation == "unreachable") && kind == "commit")
                .then(|| id.to_string())
        })
        .expect("failed metadata publication left an inspectable orphan commit");
    let (orphan_restore_status, _) = post_json(
        &client,
        &format!("{base}/api/fresh-agent/checkpoints/restore"),
        json!({ "cwd": home, "workspace": workspace_intent(&project), "id": orphan_id }),
    )
    .await;
    assert_eq!(orphan_restore_status, StatusCode::BAD_REQUEST);
    assert_eq!(
        list_workspace(&client, &base, &home, &project).await.len(),
        1
    );

    // Once the owned storage obstruction is removed, the same workspace can
    // publish a later complete checkpoint without exposing the orphan.
    fs::write(project.join("main.rs"), "after repaired capture\n").unwrap();
    let (repaired_status, repaired_entry) = post_json(
        &client,
        &checkpoints_url,
        json!({
            "cwd": home,
            "workspace": workspace_intent(&project),
            "label": "capture after repair",
            "requestId": "send-after-repair",
        }),
    )
    .await;
    assert_eq!(repaired_status, StatusCode::OK, "{repaired_entry}");
    let repaired_list = list_workspace(&client, &base, &home, &project).await;
    assert_eq!(repaired_list.len(), 2);
    assert!(repaired_list
        .iter()
        .any(|entry| entry["id"] == repaired_entry["id"]));
    fs::write(project.join("main.rs"), "changed after repaired capture\n").unwrap();
    let (repaired_restore_status, repaired_restore_body) = post_json(
        &client,
        &format!("{base}/api/fresh-agent/checkpoints/restore"),
        json!({
            "cwd": home,
            "workspace": workspace_intent(&project),
            "id": repaired_entry["id"],
        }),
    )
    .await;
    assert_eq!(
        repaired_restore_status,
        StatusCode::OK,
        "{repaired_restore_body}"
    );
    assert_eq!(
        fs::read_to_string(project.join("main.rs")).unwrap(),
        "after repaired capture\n"
    );

    // A separately selected non-Git directory also uses the complete snapshot
    // route while HOME remains only the launch cwd.
    let non_git = root.join("non-git");
    fs::create_dir(&non_git).unwrap();
    fs::write(non_git.join("one.txt"), "one-before\n").unwrap();
    fs::write(non_git.join("two.txt"), "two-before\n").unwrap();
    let (non_git_status, non_git_entry) = post_json(
        &client,
        &checkpoints_url,
        json!({
            "cwd": home,
            "workspace": workspace_intent(&non_git),
            "label": "non-git scope",
            "requestId": "send-non-git",
        }),
    )
    .await;
    assert_eq!(non_git_status, StatusCode::OK, "{non_git_entry}");
    fs::write(non_git.join("one.txt"), "one-after\n").unwrap();
    fs::write(non_git.join("two.txt"), "two-after\n").unwrap();
    let (non_git_restore_status, _) = post_json(
        &client,
        &format!("{base}/api/fresh-agent/checkpoints/restore"),
        json!({
            "cwd": home,
            "workspace": workspace_intent(&non_git),
            "id": non_git_entry["id"],
        }),
    )
    .await;
    assert_eq!(non_git_restore_status, StatusCode::OK);
    assert_eq!(
        fs::read_to_string(non_git.join("one.txt")).unwrap(),
        "one-before\n"
    );
    assert_eq!(
        fs::read_to_string(non_git.join("two.txt")).unwrap(),
        "two-before\n"
    );

    let logs = fs::read_to_string(storage.join("logs/rust-server.jsonl")).unwrap();
    let events = logs
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("each log line is JSON"))
        .collect::<Vec<_>>();
    for send_request_id in [
        "send-private-file",
        "send-private-dir",
        "send-storage-failure",
    ] {
        let event = events
            .iter()
            .find(|event| {
                event["event"] == "code_checkpoint.failed"
                    && event["send_request_id"] == send_request_id
            })
            .unwrap_or_else(|| panic!("missing correlated failure event for {send_request_id}"));
        assert!(
            event["request_id"].as_str().is_some(),
            "HTTP request span is retained"
        );
        assert_eq!(event["workspace"], project.to_string_lossy().as_ref());
        assert!(event["stage"].as_str().is_some());
        assert!(event["operation"].as_str().is_some());
        assert!(event["cause"].as_str().is_some());
    }
    for send_request_id in ["send-private-file", "send-private-dir"] {
        let event = events
            .iter()
            .find(|event| {
                event["event"] == "code_checkpoint.failed"
                    && event["send_request_id"] == send_request_id
            })
            .unwrap();
        assert_eq!(event["stage"], "readability");
        assert_eq!(event["filesystem_kind"], "PermissionDenied");
        assert!(event["cause"]
            .as_str()
            .unwrap()
            .contains("Permission denied"));
        let path = event["path"].as_str().unwrap();
        assert!(!path.is_empty());
        let expected_path = if send_request_id == "send-private-file" {
            "private-file"
        } else {
            "private-dir"
        };
        assert!(
            path == expected_path || path.starts_with(&format!("{expected_path}/")),
            "expected the path of the eligible unreadable source, got {path}"
        );
    }
    assert!(!logs.contains(OUTGOING_MARKER));
    assert!(!logs.contains(AUTH_TOKEN));

    // Private source permissions remain untouched even after eligible-name
    // transitions and all route operations.
    let final_private_file = fs::symlink_metadata(private_file_ignored).unwrap();
    let final_private_dir = fs::symlink_metadata(private_dir_ignored).unwrap();
    assert_eq!(
        (final_private_file.uid(), final_private_file.mode() & 0o777),
        (0, 0o600)
    );
    assert_eq!(
        (final_private_dir.uid(), final_private_dir.mode() & 0o777),
        (0, 0o700)
    );

    server.stop();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn dropped_checkpoint_http_request_kills_git_before_publication() {
    let root = fixture_root();
    assert_ne!(unsafe { libc::geteuid() }, 0, "fixture must run as UID B");
    assert_eq!(effective_capabilities(), 0);

    let home = root.join("cancel-home");
    let storage = root.join("cancel-storage");
    let project = root.join("cancel-project");
    let executable_tmp = std::env::var_os("FRESHELL_TEST_EXECUTABLE_TMP_DIR")
        .map(PathBuf::from)
        .expect("runtime sandbox provides an executable fixture directory");
    let wrapper_dir = executable_tmp.join(format!("checkpoint-git-wrapper-{}", std::process::id()));
    let barrier_dir = root.join("cancel-git-barrier");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(storage.join("logs")).unwrap();
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(&wrapper_dir).unwrap();
    fs::create_dir_all(&barrier_dir).unwrap();
    fs::write(
        project.join("source.txt"),
        "must never publish after abort\n",
    )
    .unwrap();
    run_git(&["init", "-q"], &project);

    let pid_path = barrier_dir.join("git-add.pid");
    let started_path = barrier_dir.join("git-add.started");
    let release_path = barrier_dir.join("git-add.release");
    let calls_path = barrier_dir.join("git.calls");
    let real_git = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|directory| directory.join("git"))
        .find(|candidate| candidate.is_file())
        .expect("sandbox PATH contains real Git");
    let wrapper = format!(
        "#!/bin/sh\n\
         if [ \"$1\" = \"--version\" ]; then echo WRAPPED; exit 0; fi\n\
         target=0\n\
         add=0\n\
         printf '%s\\n' \"$*\" >> {}\n\
         for arg do\n\
           case \"$arg\" in\n\
             --work-tree=*) case \"$arg\" in *cancel-project) target=1 ;; esac ;;\n\
             add) add=1 ;;\n\
           esac\n\
         done\n\
         if [ \"$target\" -eq 1 ] && [ \"$add\" -eq 1 ]; then\n\
           printf '%s\\n' \"$$\" > {}\n\
           printf '%s\\n' started > {}\n\
           while [ ! -e {} ]; do :; done\n\
         fi\n\
         exec {} \"$@\"\n",
        calls_path.display(),
        pid_path.display(),
        started_path.display(),
        release_path.display(),
        real_git.display(),
    );
    let wrapper_path = wrapper_dir.join("git");
    let _barrier_cleanup = GitBarrierCleanup {
        pid_path: pid_path.clone(),
        release_path: release_path.clone(),
        wrapper_path: wrapper_path.clone(),
        wrapper_dir: wrapper_dir.clone(),
    };
    fs::write(&wrapper_path, wrapper).unwrap();
    fs::set_permissions(&wrapper_path, fs::Permissions::from_mode(0o755)).unwrap();

    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let server_path = std::env::join_paths(
        std::iter::once(wrapper_dir.clone()).chain(std::env::split_paths(&original_path)),
    )
    .unwrap();
    let wrapper_probe = Command::new("git")
        .arg("--version")
        .env("PATH", &server_path)
        .output()
        .expect("resolve the test Git wrapper from the server PATH");
    assert_eq!(
        String::from_utf8_lossy(&wrapper_probe.stdout).trim(),
        "WRAPPED",
        "server PATH resolves git to the barrier wrapper"
    );
    let port = allocate_port();
    let mut server = OwnedServer::start(port, &home, &storage.join("logs"), Some(server_path));
    wait_for_health(port, server.child_mut()).await;
    let server_pid = server.child_mut().id();
    let server_environment = fs::read(format!("/proc/{server_pid}/environ")).unwrap();
    let path_entry = server_environment
        .split(|byte| *byte == 0)
        .find(|entry| entry.starts_with(b"PATH="))
        .expect("server process has PATH");
    assert!(
        String::from_utf8_lossy(path_entry).contains(&wrapper_dir.display().to_string()),
        "server PATH includes test barrier directory: {}",
        String::from_utf8_lossy(path_entry)
    );

    let body = json!({
        "cwd": home,
        "workspace": workspace_intent(&project),
        "label": "aborted capture",
        "requestId": "send-aborted-capture",
    })
    .to_string();
    let request = format!(
        "POST /api/fresh-agent/checkpoints HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nX-Auth-Token: {AUTH_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect to checkpoint route");
    stream
        .write_all(request.as_bytes())
        .await
        .expect("send complete checkpoint request");

    let deadline = Instant::now() + Duration::from_secs(10);
    while !started_path.exists() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        started_path.exists(),
        "Git add reached the controlled barrier; Git calls were {}; server logs were {}",
        fs::read_to_string(&calls_path).unwrap_or_default(),
        fs::read_to_string(storage.join("logs/rust-server.jsonl")).unwrap_or_default()
    );
    let git_pid = fs::read_to_string(&pid_path)
        .unwrap()
        .trim()
        .parse::<i32>()
        .unwrap();

    // Closing the actual HTTP connection drops the Axum handler future while
    // Git is still blocked before it can write this request's private index.
    drop(stream);
    let stopped_deadline = Instant::now() + Duration::from_secs(5);
    while linux_process_state(git_pid).is_some_and(|state| state != 'Z')
        && Instant::now() < stopped_deadline
    {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        linux_process_state(git_pid).is_none_or(|state| state == 'Z'),
        "Git child {git_pid} must stop executing after the HTTP request is dropped"
    );

    let client = Client::new();
    let base = format!("http://127.0.0.1:{port}");
    let checkpoints = list_workspace(&client, &base, &home, &project).await;
    assert!(checkpoints.is_empty(), "aborted capture is not published");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let later_checkpoints = list_workspace(&client, &base, &home, &project).await;
    assert!(
        later_checkpoints.is_empty(),
        "aborted capture does not publish after the cancellation settles"
    );

    // Release only after the no-publication assertion so a failed test cannot
    // leave the controlled child spinning in the disposable container.
    fs::write(&release_path, "release\n").unwrap();
    server.stop();
}

#[cfg(target_os = "linux")]
fn linux_process_state(pid: i32) -> Option<char> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let (_, fields) = stat.rsplit_once(") ")?;
    fields.chars().next()
}

//! Disposable Docker proof for the managed OpenCode stage and provider-reader
//! contract. This test uses only a synthetic database and auto-removed
//! containers; it never mounts a real provider store or Freshell service path.

use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Command, Stdio},
};

use freshell_runtime_protocol::{
    opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeTransferChunk,
    OpenCodeTransferDescriptor, OpenCodeTransferFile, MAX_OPENCODE_TRANSFER_CHUNK_BYTES,
};
use freshell_sessions::opencode_transfer::{
    export_exact_session, ExportOptions, HostOpenCodeInventory,
};
use freshell_supervisor::opencode_transfer::{OpenCodeTransferStaging, StagingLimits};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

const PROVIDER_UID: u32 = 65_534;
const PROVIDER_GID: u32 = 0;
const PROVIDER_HOME: &str = "/home/freshell/provider";
const OPENCODE_DB: &str = "/home/freshell/provider/.local/share/opencode/opencode.db";
const MAX_TEST_PAYLOAD_BYTES: u64 = 4 * 1024 * 1024;
const BODY_SENTINEL: &str = "SYNTHETIC_ONLY_OPENCODE_CONVERSATION_BODY";

#[test]
fn managed_image_mounts_exact_stage_read_only_and_provider_uid_imports_and_reads() {
    let image_name = std::env::var("FRESHELL_OPENCODE_DOCKER_IMAGE")
        .expect("set FRESHELL_OPENCODE_DOCKER_IMAGE to the pinned managed runtime image");
    let image_ref = docker_image_id(&image_name);
    let root = tempfile::Builder::new()
        .prefix("freshell-opencode-docker-contract-")
        .tempdir_in("/var/tmp")
        .expect("create isolated Docker contract directory");
    let workspace = root.path().join("workspace");
    let provider_home = root.path().join("provider-home");
    let stage_root = root.path().join("stage-root");
    let source_database = root.path().join("source.sqlite");
    let extraction = root.path().join("extraction");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&provider_home).unwrap();
    fs::set_permissions(&workspace, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&provider_home, fs::Permissions::from_mode(0o777)).unwrap();

    let descriptor = create_synthetic_bundle(
        &source_database,
        &workspace,
        &extraction,
        &stage_root,
        &image_ref,
    );
    let stage = stage_root
        .join("opencode-transfers")
        .join(format!("{}.ready", descriptor.transfer_id));
    assert!(descriptor.total_bytes <= MAX_TEST_PAYLOAD_BYTES);
    fs::set_permissions(&stage, fs::Permissions::from_mode(0o500)).unwrap();

    let mut stage_probe = docker_base(&image_ref, &stage, &provider_home, &workspace);
    let stage_probe = stage_probe
        .arg("/bin/sh")
        .arg("-ec")
        .arg(
            "test -r /run/freshell-opencode-transfer/entry-0000.bin; \
             ! /usr/bin/setpriv --reuid 65534 --regid 0 --clear-groups --no-new-privs -- \
               test -r /run/freshell-opencode-transfer/entry-0000.bin; \
             if touch /run/freshell-opencode-transfer/unlisted; then exit 43; fi; \
             test ! -e /host-unrelated-provider-data",
        )
        .output()
        .expect("run disposable stage mount proof");
    assert!(
        stage_probe.status.success(),
        "stage access proof failed: {}",
        String::from_utf8_lossy(&stage_probe.stderr)
    );

    let import_output = run_provider_helper(
        &image_ref,
        &stage,
        &provider_home,
        &workspace,
        "opencode-import-worker",
        &descriptor,
        Some(&stage.join("entry-0000.bin")),
    );
    let import_receipt: serde_json::Value = serde_json::from_slice(&import_output)
        .expect("provider-UID importer should return receipt JSON");
    assert_eq!(import_receipt["providerUid"], serde_json::Value::Null);
    assert_eq!(import_receipt["rootSessionId"], "ses_docker_contract");
    assert!(import_receipt.get("providerUid").is_none());
    assert!(!String::from_utf8_lossy(&import_output).contains(BODY_SENTINEL));

    let reader_output = run_provider_helper(
        &image_ref,
        &stage,
        &provider_home,
        &workspace,
        "opencode-reader-probe",
        &descriptor,
        None,
    );
    let reader_receipt: serde_json::Value = serde_json::from_slice(&reader_output)
        .expect("provider-UID read-only probe should return receipt JSON");
    assert_eq!(reader_receipt["providerUid"], PROVIDER_UID);
    assert_eq!(reader_receipt["providerGid"], PROVIDER_GID);
    assert_eq!(reader_receipt["home"], PROVIDER_HOME);
    assert_eq!(reader_receipt["opencodeDb"], OPENCODE_DB);
    assert_eq!(reader_receipt["cwd"], workspace.to_string_lossy().as_ref());
    assert_eq!(reader_receipt["rowCount"], 3);
    assert!(!String::from_utf8_lossy(&reader_output).contains(BODY_SENTINEL));

    remove_provider_owned_files(&image_ref, &provider_home, &stage, &workspace);
}

fn create_synthetic_bundle(
    source_database: &Path,
    workspace: &Path,
    extraction: &Path,
    staging_root: &Path,
    target_image_ref: &str,
) -> OpenCodeTransferDescriptor {
    let source = Connection::open(source_database).unwrap();
    source
        .execute_batch(freshell_sessions::opencode_transfer::pinned_destination_schema_sql())
        .unwrap();
    for migration in freshell_sessions::opencode_transfer::pinned_destination_migration_ids() {
        source
            .execute(
                "INSERT INTO migration (id,time_completed) VALUES (?1,0)",
                [migration],
            )
            .unwrap();
    }
    source
        .execute(
            "INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES (?1,?2,1,1,'{}')",
            params!["project-one", workspace.to_string_lossy()],
        )
        .unwrap();
    source
        .execute(
            "INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?1,?2,?3,?4,?5,?6,1,1)",
            params![
                "ses_docker_contract",
                "project-one",
                "synthetic-slug",
                workspace.to_string_lossy(),
                "synthetic title",
                "1.18.21"
            ],
        )
        .unwrap();
    source
        .execute(
            "INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?1,?2,1,1,?3)",
            params![
                "msg_one",
                "ses_docker_contract",
                format!(r#"{{"text":"{BODY_SENTINEL}"}}"#)
            ],
        )
        .unwrap();
    drop(source);

    let snapshot = export_exact_session(
        &HostOpenCodeInventory::new(source_database.to_path_buf())
            .with_trusted_mount_for_selected_session(workspace.to_path_buf()),
        "ses_docker_contract",
        ExportOptions::new(extraction.to_path_buf()),
    )
    .unwrap();
    let mut payload = snapshot.open_payload().unwrap();
    let mut payload_bytes = Vec::new();
    std::io::copy(&mut payload, &mut payload_bytes).unwrap();
    let payload_sha256 = hex::encode(Sha256::digest(&payload_bytes));
    let manifest_json = serde_json::to_string(snapshot.manifest()).unwrap();
    let files = vec![OpenCodeTransferFile {
        index: 0,
        relative_path: "payload.json".into(),
        size_bytes: payload_bytes.len() as u64,
        sha256: payload_sha256,
    }];
    let mut descriptor = OpenCodeTransferDescriptor {
        transfer_id: "transfer-opencode-docker-contract".into(),
        provider: "opencode".into(),
        source_store_id: snapshot.manifest().source_store_id.clone(),
        root_session_id: "ses_docker_contract".into(),
        source_generation: snapshot.manifest().generation.clone(),
        provider_schema: snapshot.manifest().provider_schema.clone(),
        source_schema_fingerprint: snapshot.manifest().source_schema_fingerprint.clone(),
        migration_journal_fingerprint: snapshot.manifest().migration_journal_fingerprint.clone(),
        destination_store_id: "soul-opencode-docker-contract".into(),
        destination_database_path: ".local/share/opencode/opencode.db".into(),
        target_image_ref: target_image_ref.into(),
        target_build_receipt: opencode_target_build_receipt(target_image_ref, "opencode-1.18.21"),
        incarnation_id: "incarnation-opencode-docker-contract".into(),
        manifest_json,
        total_bytes: payload_bytes.len() as u64,
        bundle_sha256: String::new(),
        files,
    };
    descriptor.bundle_sha256 =
        opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
    descriptor.validate().unwrap();

    let staging = OpenCodeTransferStaging::new(staging_root, StagingLimits::production()).unwrap();
    let attempt_id = "dddddddddddddddddddddddddddddddd";
    staging.begin(&descriptor, attempt_id, u64::MAX).unwrap();
    for (sequence, bytes) in payload_bytes
        .chunks(MAX_OPENCODE_TRANSFER_CHUNK_BYTES)
        .enumerate()
    {
        let offset = sequence * MAX_OPENCODE_TRANSFER_CHUNK_BYTES;
        staging
            .write_chunk(&OpenCodeTransferChunk {
                transfer_id: descriptor.transfer_id.clone(),
                attempt_id: attempt_id.into(),
                sequence: sequence as u64,
                file_index: 0,
                offset: offset as u64,
                data: bytes.to_vec(),
                sha256: hex::encode(Sha256::digest(bytes)),
            })
            .unwrap();
    }
    let ready = staging
        .finalize(&descriptor.transfer_id, attempt_id)
        .unwrap();
    assert_eq!(
        freshell_agent_runtime::opencode_transfer::verify_staged_bundle(&descriptor, &ready)
            .unwrap(),
        ready.join("entry-0000.bin")
    );
    descriptor
}

fn docker_image_id(image_name: &str) -> String {
    let output = Command::new("docker")
        .args(["image", "inspect", "--format", "{{.Id}}", image_name])
        .output()
        .expect("docker CLI is available");
    assert!(
        output.status.success(),
        "managed runtime image is unavailable: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("docker image id is UTF-8")
        .trim()
        .to_string()
}

fn docker_base(image_ref: &str, stage: &Path, home: &Path, workspace: &Path) -> Command {
    let mut command = Command::new("docker");
    command
        .args([
            "run",
            "--rm",
            "-i",
            "--read-only",
            "--network",
            "none",
            "--cap-drop",
            "ALL",
            "--cap-add",
            "CHOWN",
            "--cap-add",
            "SETGID",
            "--cap-add",
            "SETUID",
            "--security-opt",
            "no-new-privileges:true",
            "--pids-limit",
            "32",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=128m",
            "--tmpfs",
            "/run/opencode-tmp:rw,exec,nosuid,nodev,size=64m,mode=1777",
            "--tmpfs",
            "/run/freshell-private:rw,noexec,nosuid,nodev,size=16m,mode=0700",
        ])
        .arg("--mount")
        .arg(format!(
            "type=bind,src={},dst=/run/freshell-opencode-transfer,readonly",
            stage.display()
        ))
        .arg("--mount")
        .arg(format!(
            "type=bind,src={},dst={PROVIDER_HOME}",
            home.display()
        ))
        .arg("--mount")
        .arg(format!(
            "type=bind,src={},dst={}",
            workspace.display(),
            workspace.display()
        ))
        .arg("--mount")
        .arg(format!(
            "type=bind,src={},dst=/runtime/freshell-session-host,readonly",
            env!("CARGO_BIN_EXE_freshell-session-host")
        ))
        .arg("--workdir")
        .arg(workspace)
        .arg("--env")
        .arg(format!("HOME={PROVIDER_HOME}"))
        .arg("--env")
        .arg(format!("XDG_DATA_HOME={PROVIDER_HOME}/.local/share"))
        .arg("--env")
        .arg(format!("XDG_CONFIG_HOME={PROVIDER_HOME}/.config"))
        .arg("--env")
        .arg(format!("OPENCODE_DB={OPENCODE_DB}"))
        .arg(image_ref);
    command
}

fn run_provider_helper(
    image_ref: &str,
    stage: &Path,
    home: &Path,
    workspace: &Path,
    worker: &str,
    descriptor: &OpenCodeTransferDescriptor,
    payload_path: Option<&Path>,
) -> Vec<u8> {
    let mut command = docker_base(image_ref, stage, home, workspace);
    command
        .arg("/usr/bin/setpriv")
        .arg("--reuid")
        .arg(PROVIDER_UID.to_string())
        .arg("--regid")
        .arg(PROVIDER_GID.to_string())
        .arg("--clear-groups")
        .arg("--no-new-privs")
        .arg("--")
        .arg("/runtime/freshell-session-host")
        .arg(worker)
        .arg("--workspace-root")
        .arg(workspace)
        .arg("--expected-cwd")
        .arg(workspace)
        .arg("--provider-uid")
        .arg(PROVIDER_UID.to_string())
        .arg("--provider-gid")
        .arg(PROVIDER_GID.to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().expect("start provider identity helper");
    {
        let mut input = child.stdin.take().expect("helper stdin");
        let encoded = serde_json::to_vec(descriptor).unwrap();
        input
            .write_all(&(encoded.len() as u32).to_be_bytes())
            .and_then(|_| input.write_all(&encoded))
            .expect("write bounded transfer descriptor frame");
        if let Some(payload_path) = payload_path {
            let payload = fs::read(payload_path).expect("read synthetic staged payload");
            input
                .write_all(&payload)
                .expect("stream payload to importer");
        }
    }
    let output = child.wait_with_output().expect("provider helper settles");
    assert!(
        output.status.success(),
        "provider helper failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn remove_provider_owned_files(image_ref: &str, home: &Path, stage: &Path, workspace: &Path) {
    let output = docker_base(image_ref, stage, home, workspace)
        .arg("/usr/bin/setpriv")
        .arg("--reuid")
        .arg(PROVIDER_UID.to_string())
        .arg("--regid")
        .arg(PROVIDER_GID.to_string())
        .arg("--clear-groups")
        .arg("--no-new-privs")
        .arg("--")
        .arg("/bin/rm")
        .arg("-rf")
        .arg("--")
        .arg("/home/freshell/provider/.local")
        .output()
        .expect("remove synthetic provider-owned files inside disposable runtime");
    assert!(output.status.success());
}

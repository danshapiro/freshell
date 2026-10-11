//! Fixed transfer stages for the private owner-side restoration validator.
//! No provider process, prompt, resume, shell, or arbitrary SQL interface.

use freshell_agent_runtime::opencode_transfer::{
    import_bundle_payload, import_bundle_payload_with_capacity, verify_current_store,
    verify_installed_store, DestinationCapacityProvider, FilesystemCapacityProvider,
    InstalledStoreReaderContext,
};
use freshell_runtime_protocol::{
    opencode_target_build_receipt, opencode_transfer_bundle_digest, OpenCodeTransferDescriptor,
    OpenCodeTransferFile, OPENCODE_TRANSFER_DESTINATION_DB,
};
use freshell_sessions::opencode_transfer::{
    export_exact_session, qualify_existing_snapshot, ExportOptions, HostOpenCodeInventory,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StageRequest {
    candidate_sha: String,
    image_digest: String,
    source_database: PathBuf,
    root_session_id: String,
    extraction_root: PathBuf,
    workspace_path: PathBuf,
    descriptor_file: PathBuf,
    payload_file: PathBuf,
    destination_store_id: String,
    destination_database: PathBuf,
    provider_home: PathBuf,
    provider_uid: u32,
    provider_gid: u32,
    receipt_file: PathBuf,
    #[serde(default)]
    current_projection: bool,
    #[serde(default)]
    source_snapshot: Option<SourceSnapshotBinding>,
    #[serde(default)]
    import_capacity_ceiling_bytes: Option<u64>,
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceSnapshotBinding {
    canonical_original_database: PathBuf,
    original_default_database: PathBuf,
    source_store_id: String,
    snapshot_sha256: String,
    snapshot_bytes: u64,
    roots: Vec<SourceRootBinding>,
    workspaces: Vec<PathBuf>,
}

#[derive(Clone, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceRootBinding {
    root_session_id: String,
    graph_digest: String,
}

type StageError = Box<dyn std::error::Error>;

struct ImportCapacityCeiling(u64);
impl DestinationCapacityProvider for ImportCapacityCeiling {
    fn available_bytes(&self, directory: &Path) -> std::io::Result<u64> {
        FilesystemCapacityProvider
            .available_bytes(directory)
            .map(|actual| actual.min(self.0))
    }
}

fn private_file(path: &Path) -> Result<(), StageError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || !path.is_absolute() {
        return Err("private regular absolute file required".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || metadata.uid() != unsafe { libc::geteuid() } {
            return Err("private file ownership or permissions differ".into());
        }
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), StageError> {
    if !path.is_absolute() {
        return Err("absolute output required".into());
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn run() -> Result<(), StageError> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    run_with_arguments(&args)
}

fn run_with_arguments(args: &[String]) -> Result<(), StageError> {
    if args.len() != 4 || args[0] != "--stage" || args[2] != "--request-file" {
        return Err("required fixed stage and private request file".into());
    }
    private_file(Path::new(&args[3]))?;
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Requests {
        Single(Box<StageRequest>),
        Batch(Vec<StageRequest>),
    }
    let (requests, complete_batch) = match serde_json::from_reader(File::open(&args[3])?)? {
        Requests::Single(request) => (vec![*request], false),
        Requests::Batch(requests) if args[1] == "export" => (requests, true),
        Requests::Batch(_) => return Err("only fixed export accepts a batch".into()),
    };
    run_requests(&args[1], &requests, complete_batch)
}

fn run_requests(
    stage: &str,
    requests: &[StageRequest],
    complete_batch: bool,
) -> Result<(), StageError> {
    let first = requests
        .first()
        .ok_or("nonempty fixed request batch required")?;
    for request in requests {
        validate_request(request)?;
    }
    if complete_batch {
        let binding = first
            .source_snapshot
            .as_ref()
            .ok_or("source-bound export batch required")?;
        let requested = requests
            .iter()
            .map(|request| &request.root_session_id)
            .collect::<std::collections::BTreeSet<_>>();
        let selected = binding
            .roots
            .iter()
            .map(|root| &root.root_session_id)
            .collect::<std::collections::BTreeSet<_>>();
        if stage != "export"
            || requested.len() != requests.len()
            || requested != selected
            || requests.iter().any(|request| {
                request.source_database != first.source_database
                    || request.source_snapshot != first.source_snapshot
                    || request.candidate_sha != first.candidate_sha
                    || request.image_digest != first.image_digest
            })
        {
            return Err("complete exact same-source candidate-bound export batch required".into());
        }
    }
    let prepared = if stage == "export" {
        Some(prepare_export_inventory(first)?)
    } else {
        None
    };
    for request in requests {
        let result = run_request(stage, request, prepared.as_ref())?;
        println!("{}", result);
    }
    Ok(())
}

fn validate_request(request: &StageRequest) -> Result<(), StageError> {
    if [
        &request.source_database,
        &request.extraction_root,
        &request.workspace_path,
        &request.descriptor_file,
        &request.payload_file,
        &request.destination_database,
        &request.provider_home,
        &request.receipt_file,
    ]
    .iter()
    .any(|path| !path.is_absolute())
        || request.source_database == request.destination_database
    {
        return Err("distinct source/destination and exact absolute stage paths required".into());
    }
    let valid_hex = |value: &str, length: usize| {
        value.len() == length
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    };
    if !valid_hex(&request.candidate_sha, 40)
        || !request
            .image_digest
            .strip_prefix("sha256:")
            .is_some_and(|digest| valid_hex(digest, 64))
    {
        return Err("candidate and immutable image required".into());
    }
    Ok(())
}

fn prepare_export_inventory(request: &StageRequest) -> Result<HostOpenCodeInventory, StageError> {
    Ok(if let Some(binding) = &request.source_snapshot {
        private_file(&request.source_database)?;
        // Real provenance comes from the configured host inventory,
        // independently of the manifest's claimed source path/ID.
        let mut original = HostOpenCodeInventory::from_process_environment_discovering_channels()?;
        if original.declared_default_database() != binding.original_default_database {
            return Err("declared source datahome differs from configured host inventory".into());
        }
        for workspace in &binding.workspaces {
            original = original.with_trusted_mount_for_selected_session(workspace.clone());
        }
        let roots = binding
            .roots
            .iter()
            .map(|root| root.root_session_id.clone())
            .collect::<Vec<_>>();
        let qualified = qualify_existing_snapshot(
            &original,
            &roots,
            &request.source_database,
            ExportOptions::new(request.extraction_root.clone()),
        )?;
        if qualified.receipt().source_store_id != binding.source_store_id
            || qualified.receipt().canonical_source_database != binding.canonical_original_database
            || qualified.receipt().snapshot_sha256 != binding.snapshot_sha256
            || qualified.receipt().snapshot_bytes != binding.snapshot_bytes
        {
            return Err("independent source/snapshot binding differs".into());
        }
        let inventory = qualified.inventory();
        for root in &binding.roots {
            let exported = export_exact_session(
                &inventory,
                &root.root_session_id,
                ExportOptions::new(request.extraction_root.clone()),
            )?;
            if exported.manifest().generation != root.graph_digest {
                return Err("current source root differs from independent preflight".into());
            }
        }
        inventory
    } else {
        HostOpenCodeInventory::new(request.source_database.clone())
            .with_trusted_mount_for_selected_session(request.workspace_path.clone())
    })
}

fn run_request(
    stage: &str,
    request: &StageRequest,
    prepared: Option<&HostOpenCodeInventory>,
) -> Result<serde_json::Value, StageError> {
    validate_request(request)?;
    let receipt = match stage {
        "export" => {
            let inventory = prepared.ok_or("qualified export preparation required")?;
            let snapshot = export_exact_session(
                inventory,
                &request.root_session_id,
                ExportOptions::new(request.extraction_root.clone()),
            )?;
            let manifest = snapshot.manifest();
            let mut payload = snapshot.open_payload()?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut destination = options.open(&request.payload_file)?;
            std::io::copy(&mut payload, &mut destination)?;
            destination.sync_all()?;
            let files = vec![OpenCodeTransferFile {
                index: 0,
                relative_path: "payload.json".into(),
                size_bytes: manifest.payload_bytes,
                sha256: manifest.payload_sha256.clone(),
            }];
            let manifest_json = serde_json::to_string(manifest)?;
            let mut descriptor = OpenCodeTransferDescriptor {
                transfer_id: format!("rehearsal-{}", &manifest.generation[..32]),
                provider: "opencode".into(),
                source_store_id: manifest.source_store_id.clone(),
                root_session_id: manifest.root_session_id.clone(),
                source_generation: manifest.generation.clone(),
                provider_schema: manifest.provider_schema.clone(),
                source_schema_fingerprint: manifest.source_schema_fingerprint.clone(),
                migration_journal_fingerprint: manifest.migration_journal_fingerprint.clone(),
                destination_store_id: request.destination_store_id.clone(),
                destination_database_path: OPENCODE_TRANSFER_DESTINATION_DB.into(),
                target_image_ref: request.image_digest.clone(),
                target_build_receipt: opencode_target_build_receipt(
                    &request.image_digest,
                    &manifest.provider_schema,
                ),
                incarnation_id: format!("rehearsal-{}", &request.candidate_sha[..16]),
                manifest_json,
                files,
                total_bytes: manifest.payload_bytes,
                bundle_sha256: String::new(),
            };
            descriptor.bundle_sha256 =
                opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files);
            descriptor.validate().map_err(|error| error.message)?;
            write_private(&request.descriptor_file, &serde_json::to_vec(&descriptor)?)?;
            json!({"stage":"export", "rootSessionId":manifest.root_session_id, "sourceStoreId":manifest.source_store_id, "graphDigest":manifest.generation, "rowCount":manifest.row_count,"assetCount":manifest.assets.len(),"savedSnapshotSummary":freshell_sessions::opencode_transfer::saved_snapshot_summary(manifest),"payloadBytes":manifest.payload_bytes,"descriptorReference":request.descriptor_file})
        }
        "import" | "read" => {
            private_file(&request.descriptor_file)?;
            private_file(&request.payload_file)?;
            let descriptor: OpenCodeTransferDescriptor =
                serde_json::from_reader(File::open(&request.descriptor_file)?)?;
            if descriptor.root_session_id != request.root_session_id
                || descriptor.target_image_ref != request.image_digest
                || descriptor.destination_store_id != request.destination_store_id
            {
                return Err("exact descriptor binding differs".into());
            }
            if stage == "import" {
                let imported = if let Some(ceiling) = request.import_capacity_ceiling_bytes {
                    import_bundle_payload_with_capacity(
                        &descriptor,
                        File::open(&request.payload_file)?,
                        &request.destination_database,
                        &request.workspace_path,
                        &ImportCapacityCeiling(ceiling),
                    )?
                } else {
                    import_bundle_payload(
                        &descriptor,
                        File::open(&request.payload_file)?,
                        &request.destination_database,
                        &request.workspace_path,
                    )?
                };
                json!({"stage":"import","rootSessionId":imported.root_session_id,"rowCount":imported.row_count,"assetCount":imported.asset_count,"structuralSha256":imported.structural_sha256,"savedSnapshotSummary":imported.saved_snapshot_summary})
            } else {
                let data_home = request.provider_home.join(".local/share");
                let config_home = request.provider_home.join(".config");
                let context = InstalledStoreReaderContext {
                    database_path: &request.destination_database,
                    workspace_root: &request.workspace_path,
                    provider_uid: request.provider_uid,
                    provider_gid: request.provider_gid,
                    home: &request.provider_home,
                    xdg_data_home: &data_home,
                    xdg_config_home: &config_home,
                    cwd: &request.workspace_path,
                };
                if request.current_projection {
                    #[cfg(unix)]
                    if unsafe { libc::geteuid() } != context.provider_uid
                        || unsafe { libc::getegid() } != context.provider_gid
                    {
                        return Err("current reader provider identity differs".into());
                    }
                    if context.database_path != data_home.join("opencode/opencode.db") {
                        return Err("current reader provider environment differs".into());
                    }
                    let evidence = verify_current_store(
                        &descriptor,
                        context.database_path,
                        context.workspace_root,
                    )?;
                    json!({"stage":"read","projection":"current","rootSessionId":evidence.root_session_id,"rowCount":evidence.row_count,"assetCount":evidence.asset_count,"evidenceGeneration":evidence.evidence_generation,"savedSnapshotSummary":evidence.saved_snapshot_summary})
                } else {
                    let readable = verify_installed_store(&descriptor, &context)?;
                    json!({"stage":"read","projection":"baseline","rootSessionId":readable.root_session_id,"rowCount":readable.row_count,"assetCount":readable.asset_count,"structuralSha256":readable.structural_sha256,"providerUid":readable.provider_uid,"providerGid":readable.provider_gid,"savedSnapshotSummary":readable.saved_snapshot_summary})
                }
            }
        }
        _ => return Err("unsupported fixed stage".into()),
    };
    let result = json!({"status":"complete","candidateSha":request.candidate_sha,"imageDigest":request.image_digest,"evidence":receipt});
    write_private(&request.receipt_file, &serde_json::to_vec(&result)?)?;
    Ok(result)
}

fn main() {
    if let Err(error) = run() {
        let args = std::env::args().skip(1).collect::<Vec<_>>();
        if args.len() == 4
            && args[2] == "--request-file"
            && private_file(Path::new(&args[3])).is_ok()
        {
            if let Some(parent) = Path::new(&args[3]).parent() {
                let diagnostic = parent.join(format!(
                    "{}-error.json",
                    Path::new(&args[3])
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                ));
                let _ = write_private(&diagnostic, &serde_json::to_vec(&json!({"severity":"error","event":"opencode.rehearsal.stage_refused","detail":error.to_string()})).unwrap_or_default());
            }
        }
        eprintln!("{{\"severity\":\"error\",\"event\":\"opencode.rehearsal.stage_refused\",\"reasonCode\":\"fixed_stage_failed\"}}");
        std::process::exit(1);
    }
}

#[test]
#[cfg(target_os = "linux")]
fn durable_souls_export_stage_qualifies_one_current_source_for_complete_batch() {
    const CHILD: &str = "FRESHELL_TEST_EXPORT_STAGE_BATCH_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "durable_souls_export_stage_qualifies_one_current_source_for_complete_batch",
                "--exact",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let base = directory.path();
    let workspace = base.join("workspace");
    fs::create_dir(&workspace).unwrap();
    let source_path = base.join("opencode.db");
    let source = rusqlite::Connection::open(&source_path).unwrap();
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
    source.execute("INSERT INTO project (id,worktree,time_created,time_updated,sandboxes) VALUES ('project-batch',?1,1,1,'{}')", [workspace.to_str().unwrap()]).unwrap();
    let roots = vec!["ses_first".to_string(), "ses_second".to_string()];
    for root in roots
        .iter()
        .chain(std::iter::once(&"ses_unselected".to_string()))
    {
        source.execute("INSERT INTO session (id,project_id,slug,directory,title,version,time_created,time_updated) VALUES (?1,'project-batch',?1,?2,?1,'1.18.21',1,1)", rusqlite::params![root,workspace.to_str().unwrap()]).unwrap();
        let text = if root == "ses_unselected" {
            "x".repeat(32 * 1024 * 1024)
        } else {
            format!("complete selected history {root}")
        };
        source.execute("INSERT INTO message (id,session_id,time_created,time_updated,data) VALUES (?1,?2,1,1,?3)", rusqlite::params![format!("msg_{root}"),root,serde_json::json!({"text":text}).to_string()]).unwrap();
    }
    drop(source);
    // Environment is isolated in this exact test child, with no provider run.
    std::env::set_var("OPENCODE_DB", &source_path);
    std::env::set_var("XDG_DATA_HOME", base);
    let inventory = HostOpenCodeInventory::from_process_environment_discovering_channels()
        .unwrap()
        .with_trusted_mount_for_selected_session(workspace.clone());
    let snapshot_path = base.join("private.sqlite");
    let qualified = freshell_sessions::opencode_transfer::capture_qualified_snapshot(
        &inventory,
        &roots,
        &snapshot_path,
        ExportOptions::new(base.join("initial-capture")),
    )
    .unwrap();
    let binding = SourceSnapshotBinding {
        canonical_original_database: source_path.clone(),
        original_default_database: inventory.declared_default_database().to_path_buf(),
        source_store_id: qualified.receipt().source_store_id.clone(),
        snapshot_sha256: qualified.receipt().snapshot_sha256.clone(),
        snapshot_bytes: qualified.receipt().snapshot_bytes,
        roots: roots
            .iter()
            .map(|root| SourceRootBinding {
                root_session_id: root.clone(),
                graph_digest: export_exact_session(
                    &qualified.inventory(),
                    root,
                    ExportOptions::new(base.join("initial-exports")),
                )
                .unwrap()
                .manifest()
                .generation
                .clone(),
            })
            .collect(),
        workspaces: vec![workspace.clone()],
    };
    let requests = roots
        .iter()
        .enumerate()
        .map(|(index, root)| StageRequest {
            candidate_sha: "a".repeat(40),
            image_digest: format!("sha256:{}", "b".repeat(64)),
            source_database: snapshot_path.clone(),
            root_session_id: root.clone(),
            extraction_root: base.join("extractions"),
            workspace_path: workspace.clone(),
            descriptor_file: base.join(format!("descriptor-{index}.json")),
            payload_file: base.join(format!("payload-{index}.json")),
            destination_store_id: format!("store-{index}"),
            destination_database: base.join(format!("destination-{index}.db")),
            provider_home: base.join("provider"),
            provider_uid: 65534,
            provider_gid: 0,
            receipt_file: base.join(format!("receipt-{index}.json")),
            current_projection: false,
            source_snapshot: Some(binding.clone()),
            import_capacity_ceiling_bytes: None,
        })
        .collect::<Vec<_>>();
    let read_bytes = || {
        fs::read_to_string("/proc/self/io")
            .unwrap()
            .lines()
            .find_map(|line| line.strip_prefix("rchar: "))
            .unwrap()
            .parse::<u64>()
            .unwrap()
    };
    let original_before = fs::read(&source_path).unwrap();
    let request_file = base.join("export-batch-request.json");
    write_private(&request_file, &serde_json::to_vec(&requests).unwrap()).unwrap();
    let start = read_bytes();
    run_with_arguments(&[
        "--stage".into(),
        "export".into(),
        "--request-file".into(),
        request_file.to_str().unwrap().into(),
    ])
    .unwrap();
    let actual = read_bytes() - start;
    for request in &requests {
        let descriptor: OpenCodeTransferDescriptor =
            serde_json::from_reader(File::open(&request.descriptor_file).unwrap()).unwrap();
        assert_eq!(descriptor.source_store_id, binding.source_store_id);
        assert_eq!(
            descriptor.source_generation,
            binding
                .roots
                .iter()
                .find(|root| root.root_session_id == request.root_session_id)
                .unwrap()
                .graph_digest
        );
        let payload: serde_json::Value =
            serde_json::from_reader(File::open(&request.payload_file).unwrap()).unwrap();
        assert_eq!(payload["root_session_id"], request.root_session_id);
        assert!(payload.to_string().contains(&format!(
            "complete selected history {}",
            request.root_session_id
        )));
        assert!(!payload.to_string().contains("ses_unselected"));
    }
    let budget = 4 * binding.snapshot_bytes + 16 * 1024 * 1024;
    eprintln!("{{\"severity\":\"info\",\"event\":\"opencode.test.export_batch_reads\",\"readBytes\":{actual},\"budgetBytes\":{budget}}}");
    assert!(actual < budget, "actual fixed export batch read {actual} bytes; budget {budget} bytes permits one source qualification, not one per root");
    assert_eq!(fs::read(&source_path).unwrap(), original_before);
    for fault in [
        "duplicate",
        "wrong-root",
        "candidate",
        "source-path",
        "source-binding",
        "missing-root",
    ] {
        let mut invalid = requests.clone();
        match fault {
            "duplicate" => invalid[1].root_session_id = invalid[0].root_session_id.clone(),
            "wrong-root" => invalid[1].root_session_id = "ses_unselected".into(),
            "candidate" => invalid[1].candidate_sha = "c".repeat(40),
            "source-path" => invalid[1].source_database = source_path.clone(),
            "source-binding" => {
                invalid[1].source_snapshot.as_mut().unwrap().source_store_id = "d".repeat(64)
            }
            "missing-root" => invalid.truncate(1),
            _ => unreachable!(),
        }
        assert!(
            run_requests("export", &invalid, true)
                .unwrap_err()
                .to_string()
                .contains("complete exact same-source"),
            "must refuse {fault} before source preparation or outputs"
        );
    }
    let source = rusqlite::Connection::open(&source_path).unwrap();
    source.execute("UPDATE message SET data='{\"text\":\"changed original source\"}' WHERE session_id='ses_first'", []).unwrap();
    drop(source);
    assert!(
        prepare_export_inventory(&requests[0])
            .unwrap_err()
            .to_string()
            .contains("root closure"),
        "a supplied private copy cannot mask actual current source drift"
    );
}

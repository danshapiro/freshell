//! Privileged Linux identity-boundary regression.
//!
//! Run explicitly in the capability-enabled disposable test container:
//! `cargo test -p freshell-session-host --features provider-identity-boundary-tests --test provider_identity_boundary`

#[cfg(not(target_os = "linux"))]
compile_error!("provider identity boundary test requires Linux setpriv and capabilities");

use freshell_agent_runtime::ProviderStoreProbe;
use freshell_runtime_protocol::{
    AllocationState, DurablePosition, EvidenceStoreState, IdentityProvenance, ProviderSessionRef,
    RecoveryBlockReason, ResumeSpec, RESUME_SPEC_SCHEMA_VERSION,
};
use std::{
    ffi::CString,
    fs,
    io::Write,
    os::unix::{ffi::OsStrExt, fs::MetadataExt, fs::PermissionsExt},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const PROVIDER_UID: u32 = 65_534;
const PROVIDER_GID: u32 = 0;
const WORKER_TIMEOUT: Duration = Duration::from_secs(45);
const PRIVATE_UNRELATED_ROLLOUT: &[u8] =
    b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"unrelated-session\"}}\n";

#[test]
fn provider_worker_reads_private_store_and_root_without_dac_is_blocked() {
    assert_eq!(
        unsafe { libc::geteuid() },
        0,
        "run in the privileged test container"
    );
    assert_required_capabilities();
    assert!(
        Path::new("/usr/bin/setpriv").is_file(),
        "the privileged test container must provide setpriv"
    );

    let fixture = tempfile::tempdir().expect("create provider-home fixture");
    fs::set_permissions(fixture.path(), fs::Permissions::from_mode(0o755))
        .expect("make fixture parent traversable");
    let provider_home = fixture.path().join("provider");
    let codex_home = provider_home.join(".codex");
    let sessions = codex_home.join("sessions");
    fs::create_dir_all(&sessions).expect("create private Codex session tree");
    let rollout = sessions.join("unrelated.jsonl");
    fs::write(&rollout, PRIVATE_UNRELATED_ROLLOUT).expect("write synthetic Codex rollout");

    for directory in [&provider_home, &codex_home, &sessions] {
        set_owner(directory, PROVIDER_UID, PROVIDER_GID);
        set_mode(directory, 0o700);
        let metadata = fs::symlink_metadata(directory).expect("inspect private directory");
        assert_eq!(
            metadata.uid(),
            PROVIDER_UID,
            "private directory owner differs"
        );
        assert_eq!(
            metadata.gid(),
            PROVIDER_GID,
            "private directory group differs"
        );
        assert_eq!(metadata.permissions().mode() & 0o777, 0o700);
    }
    set_owner(&rollout, PROVIDER_UID, PROVIDER_GID);
    set_mode(&rollout, 0o600);
    let rollout_metadata = fs::symlink_metadata(&rollout).expect("inspect private rollout");
    assert_eq!(
        rollout_metadata.uid(),
        PROVIDER_UID,
        "rollout owner differs"
    );
    assert_eq!(
        rollout_metadata.gid(),
        PROVIDER_GID,
        "rollout group differs"
    );
    assert_eq!(rollout_metadata.permissions().mode() & 0o777, 0o600);

    let spec = resume_spec(&provider_home);
    let provider_probe = run_provider_probe_worker(&provider_home, &spec, false);
    let (evidence, negative_paths) = match provider_probe {
        ProviderStoreProbe::DefinitivelyUnavailable {
            evidence,
            store_state: EvidenceStoreState::PresentReadable,
            negative_paths,
            ..
        } => (evidence, negative_paths),
        _ => panic!("provider UID 65534:GID 0 did not complete the full readable-store probe"),
    };
    let census_reference = evidence
        .iter()
        .find(|reference| reference.starts_with("nativeAbsenceCensus=v2:"))
        .expect("provider-identity probe should return a complete generation census");
    let census: serde_json::Value = serde_json::from_str(
        census_reference
            .strip_prefix("nativeAbsenceCensus=v2:")
            .expect("native census prefix"),
    )
    .expect("decode provider generation census");
    assert_eq!(census["provider"].as_str(), Some("codex"));
    assert_eq!(
        census["store"].as_str(),
        Some(spec.provider_session.provider_store_id.as_str())
    );
    assert_eq!(
        census["nativeId"].as_str(),
        Some(spec.provider_session.native_session_id.as_str())
    );
    assert_eq!(
        census["evidenceRevision"].as_u64(),
        Some(spec.evidence_revision)
    );
    assert_eq!(
        census["providerHome"].as_str(),
        Some(spec.provider_home.as_str())
    );
    assert_eq!(
        census["inspectedHome"].as_str(),
        Some(spec.provider_home.as_str())
    );
    let generation = census["generation"]
        .as_str()
        .expect("provider census generation hash");
    assert_eq!(generation.len(), 64);
    assert!(generation
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    assert_eq!(negative_paths.len(), 2);
    assert!(negative_paths.iter().all(|path| {
        path.evidence_refs
            .iter()
            .any(|reference| reference == census_reference)
    }));

    let root_without_dac_probe = run_provider_probe_worker(&provider_home, &spec, true);
    assert!(
        matches!(
            root_without_dac_probe,
            ProviderStoreProbe::Blocked {
                reason: RecoveryBlockReason::StoreUnreadable,
                ..
            }
        ),
        "root without DAC capabilities unexpectedly traversed the private provider home"
    );
}

fn assert_required_capabilities() {
    const CAP_CHOWN: u64 = 1 << 0;
    const CAP_DAC_OVERRIDE: u64 = 1 << 1;
    const CAP_FOWNER: u64 = 1 << 3;
    const CAP_SETGID: u64 = 1 << 6;
    const CAP_SETUID: u64 = 1 << 7;
    const CAP_SETPCAP: u64 = 1 << 8;
    let required =
        CAP_CHOWN | CAP_DAC_OVERRIDE | CAP_FOWNER | CAP_SETGID | CAP_SETUID | CAP_SETPCAP;
    let effective = fs::read_to_string("/proc/self/status")
        .expect("read process capabilities")
        .lines()
        .find_map(|line| line.strip_prefix("CapEff:"))
        .and_then(|value| u64::from_str_radix(value.trim(), 16).ok())
        .expect("parse process capabilities");
    assert_eq!(
        effective & required,
        required,
        "privileged test container lacks capabilities required to set up the UID boundary"
    );
}

fn set_owner(path: &Path, uid: u32, gid: u32) {
    let path = CString::new(path.as_os_str().as_bytes()).expect("encode fixture path");
    assert_eq!(
        unsafe { libc::chown(path.as_ptr(), uid as libc::uid_t, gid as libc::gid_t) },
        0,
        "set fixture ownership"
    );
}

fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("set fixture permissions");
}

fn run_provider_probe_worker(
    provider_home: &Path,
    spec: &ResumeSpec,
    drop_dac_capabilities: bool,
) -> ProviderStoreProbe {
    let mut command = Command::new("/usr/bin/setpriv");
    if drop_dac_capabilities {
        command.args(["--reuid", "0", "--regid", "0", "--clear-groups"]);
        command.arg("--bounding-set=-dac_override,-dac_read_search");
    } else {
        command
            .arg("--reuid")
            .arg(PROVIDER_UID.to_string())
            .arg("--regid")
            .arg(PROVIDER_GID.to_string())
            .arg("--clear-groups");
    }
    command.arg("--no-new-privs").arg("--");
    if drop_dac_capabilities {
        command
            .arg("/bin/sh")
            .arg("-c")
            .arg("caps=$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status); [ -n \"$caps\" ] || exit 70; [ $((0x$caps & 6)) -eq 0 ] || exit 71; exec \"$@\"")
            .arg("provider-probe-no-dac")
            .arg(env!("CARGO_BIN_EXE_freshell-session-host"));
    } else {
        command.arg(env!("CARGO_BIN_EXE_freshell-session-host"));
    }
    let mut child = command
        .arg("provider-probe-worker")
        .arg("--provider-home")
        .arg(provider_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start provider probe worker");

    let payload = serde_json::to_vec(spec).expect("encode synthetic resume request");
    let Some(mut stdin) = child.stdin.take() else {
        stop_and_reap(&mut child);
        panic!("provider probe worker has no request pipe");
    };
    if stdin.write_all(&payload).is_err() {
        drop(stdin);
        stop_and_reap(&mut child);
        panic!("write synthetic provider probe request");
    }
    drop(stdin);

    wait_for_worker(&mut child);
    let output = child
        .wait_with_output()
        .expect("collect bounded provider probe output");
    assert!(
        output.status.success(),
        "provider probe worker exited unsuccessfully (code {:?})",
        output.status.code()
    );
    serde_json::from_slice(&output.stdout).expect("decode provider probe result")
}

fn wait_for_worker(child: &mut Child) {
    let deadline = Instant::now() + WORKER_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                stop_and_reap(child);
                panic!("provider probe worker exceeded its bounded test deadline");
            }
            Err(_) => {
                stop_and_reap(child);
                panic!("could not wait for provider probe worker");
            }
        }
    }
}

fn stop_and_reap(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn resume_spec(provider_home: &Path) -> ResumeSpec {
    ResumeSpec {
        claude_fork: None,
        schema_version: RESUME_SPEC_SCHEMA_VERSION,
        provider_session: ProviderSessionRef {
            provider: "codex".into(),
            provider_store_id: "provider-identity-boundary-store".into(),
            native_session_id: "expected-session-not-present".into(),
        },
        mode: "freshcodex".into(),
        runtime_variant: "codex-app-server".into(),
        fixture_transport: None,
        opencode_adoption_baseline: None,
        program: "freshell-session-host fresh-agent".into(),
        resume_argv: Vec::new(),
        provider_home: provider_home.display().to_string(),
        provider_volume: None,
        cwd: "/workspace".into(),
        workspace_path: "/workspace".into(),
        project_key: Some("provider-identity-boundary".into()),
        runtime_profile: None,
        environment: Default::default(),
        model: Some("test-model".into()),
        reasoning_effort: Some("low".into()),
        permission_mode: None,
        image_ref: None,
        provider_version: Some("test".into()),
        credential_references: Vec::new(),
        identity_provenance: IdentityProvenance::FixtureObserved,
        durable_position: DurablePosition::default(),
        checkpoint_references: Vec::new(),
        creation_seed_ref: "provider-identity-boundary-seed".into(),
        checkpoint_revision: 0,
        allocation_state: AllocationState::VerifiedDurable,
        evidence_revision: 1,
        never_dispatched: false,
    }
}

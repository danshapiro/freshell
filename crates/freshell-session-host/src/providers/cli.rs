use freshell_agent_runtime::{probe_provider_store, ProviderStoreProbe};
use freshell_runtime_protocol::ResumeSpec;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Child,
};

const PROVIDER_STORE_PROBE_TIMEOUT: Duration = Duration::from_secs(45);

pub async fn probe_as_provider(
    resume_spec: &ResumeSpec,
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<ProviderStoreProbe, String> {
    let payload = serde_json::to_vec(resume_spec)
        .map_err(|_| "provider recovery probe request is invalid".to_string())?;
    let executable = std::env::current_exe()
        .map_err(|_| "provider recovery probe executable is unavailable".to_string())?;
    let mut child = provider_command(&executable, run_as_uid, run_as_gid);
    child
        .arg("provider-probe-worker")
        .arg("--provider-home")
        .arg(&resume_spec.provider_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let child = child
        .spawn()
        .map_err(|_| "provider recovery probe could not start".to_string())?;
    let output = run_probe_worker_child(child, &payload, PROVIDER_STORE_PROBE_TIMEOUT).await?;
    serde_json::from_slice(&output)
        .map_err(|_| "provider recovery probe returned an invalid response".to_string())
}

async fn run_probe_worker_child(
    mut child: Child,
    payload: &[u8],
    deadline: Duration,
) -> Result<Vec<u8>, String> {
    // A timed out or cancelled worker remains owned here and is killed on drop.
    let result = tokio::time::timeout(deadline, async {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "provider recovery probe input is unavailable".to_string())?;
        stdin
            .write_all(payload)
            .await
            .map_err(|_| "provider recovery probe input failed".to_string())?;
        drop(stdin);
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "provider recovery probe output is unavailable".to_string())?;
        let mut output = Vec::new();
        let (read_result, status_result) =
            tokio::join!(stdout.read_to_end(&mut output), child.wait());
        read_result.map_err(|_| "provider recovery probe output failed".to_string())?;
        let status =
            status_result.map_err(|_| "provider recovery probe could not be reaped".to_string())?;
        if !status.success() {
            return Err("provider recovery probe worker failed".to_string());
        }
        Ok(output)
    })
    .await;

    match result {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => {
            kill_and_reap(&mut child).await;
            Err(error)
        }
        Err(_) => {
            kill_and_reap(&mut child).await;
            Err("provider recovery probe timed out".to_string())
        }
    }
}

async fn kill_and_reap(child: &mut Child) {
    let _ = child.start_kill();
    let _ = child.wait().await;
}

pub(super) fn provider_command(
    executable: &Path,
    run_as_uid: u32,
    run_as_gid: u32,
) -> tokio::process::Command {
    // Fixture hosts already run as their intended workload uid/gid and have no
    // SETGID capability. Calling `setpriv --clear-groups` in that case fails
    // before the read-only probe starts. Real managed terminals target the
    // provider uid and therefore take the capability-scoped setpriv path.
    let current_uid = unsafe { libc::geteuid() };
    let current_gid = unsafe { libc::getegid() };
    if needs_privilege_drop(run_as_uid, run_as_gid, current_uid, current_gid) {
        let mut command = tokio::process::Command::new("/usr/bin/setpriv");
        command
            .arg("--reuid")
            .arg(run_as_uid.to_string())
            .arg("--regid")
            .arg(run_as_gid.to_string())
            .arg("--clear-groups")
            .arg("--no-new-privs")
            .arg("--")
            .arg(executable);
        command
    } else {
        tokio::process::Command::new(executable)
    }
}

pub fn run_probe_worker(args: &[String]) -> Result<(), String> {
    let provider_home = required_arg(args, "--provider-home")?;
    let resume_spec: ResumeSpec = serde_json::from_reader(std::io::stdin())
        .map_err(|error| format!("decode recovery probe request: {error}"))?;
    if resume_spec.provider_home != provider_home {
        return Err("recovery probe provider-home mismatch".into());
    }
    let result = probe_provider_store(Path::new(&provider_home), &resume_spec);
    serde_json::to_writer(std::io::stdout(), &result)
        .map_err(|error| format!("encode recovery probe response: {error}"))?;
    Ok(())
}

fn required_arg(args: &[String], name: &str) -> Result<String, String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
        .ok_or_else(|| format!("missing {name}"))
}

fn needs_privilege_drop(
    run_as_uid: u32,
    run_as_gid: u32,
    current_uid: libc::uid_t,
    current_gid: libc::gid_t,
) -> bool {
    run_as_uid != current_uid || run_as_gid != current_gid
}

#[cfg(test)]
mod tests {
    use super::{needs_privilege_drop, run_probe_worker_child};
    use freshell_agent_runtime::{probe_provider_store, ProviderStoreProbe};
    use freshell_runtime_protocol::{
        AllocationState, DurablePosition, EvidenceStoreState, IdentityProvenance,
        ProviderSessionRef, ResumeSpec, RESUME_SPEC_SCHEMA_VERSION,
    };
    use std::{fs, process::Stdio, time::Duration};
    use tokio::process::Command;

    #[test]
    fn fixture_probe_skips_impossible_same_identity_setgroups() {
        assert!(!needs_privilege_drop(0, 0, 0, 0));
        assert!(needs_privilege_drop(65_534, 0, 0, 0));
    }

    #[test]
    fn full_probe_reads_a_valid_unrelated_codex_rollout_as_the_current_user() {
        let fixture = tempfile::tempdir().expect("create provider-home fixture");
        let provider_home = fixture.path().join("provider");
        let sessions = provider_home.join(".codex").join("sessions");
        fs::create_dir_all(&sessions).expect("create Codex session tree");
        fs::write(
            sessions.join("unrelated.jsonl"),
            b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"unrelated-session\"}}\n",
        )
        .expect("write synthetic unrelated rollout");

        let spec = resume_spec(&provider_home);
        let probe = probe_provider_store(&provider_home, &spec);
        assert!(
            matches!(
                probe,
                ProviderStoreProbe::DefinitivelyUnavailable {
                    store_state: EvidenceStoreState::PresentReadable,
                    ..
                }
            ),
            "full Codex probe did not classify the readable unrelated rollout"
        );
    }

    #[cfg(all(unix, target_os = "linux"))]
    #[tokio::test]
    async fn timed_out_probe_worker_is_killed_and_reaped() {
        let mut command = Command::new("/bin/sleep");
        command
            .arg("30")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = command.spawn().expect("start sleeping worker");
        let pid = child.id().expect("sleeping worker pid") as libc::pid_t;

        let result =
            run_probe_worker_child(child, b"probe request", Duration::from_millis(100)).await;
        assert_eq!(result.unwrap_err(), "provider recovery probe timed out");
        let mut status = 0;
        assert_eq!(
            unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) },
            -1
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD),
            "timed-out worker should already be reaped"
        );
    }

    #[cfg(all(unix, target_os = "linux"))]
    #[tokio::test]
    async fn cancelled_probe_worker_is_killed_and_reaped() {
        let mut command = Command::new("/bin/sleep");
        command
            .arg("30")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = command.spawn().expect("start sleeping worker");
        let pid = child.id().expect("sleeping worker pid") as libc::pid_t;

        let task = tokio::spawn(run_probe_worker_child(
            child,
            b"probe request",
            Duration::from_secs(30),
        ));
        tokio::time::sleep(Duration::from_millis(50)).await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());

        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let mut status = 0;
                let waited = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
                if waited == pid
                    || (waited == -1
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD))
                {
                    break;
                }
                assert_eq!(waited, 0, "wait for provider probe child");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled worker was not reaped");
    }

    fn resume_spec(provider_home: &std::path::Path) -> ResumeSpec {
        ResumeSpec {
            claude_fork: None,
            schema_version: RESUME_SPEC_SCHEMA_VERSION,
            provider_session: ProviderSessionRef {
                provider: "codex".into(),
                provider_store_id: "provider-identity-test-store".into(),
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
            project_key: Some("provider-identity-test".into()),
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
            creation_seed_ref: "provider-identity-test-seed".into(),
            checkpoint_revision: 0,
            allocation_state: AllocationState::VerifiedDurable,
            evidence_revision: 1,
            never_dispatched: false,
        }
    }
}

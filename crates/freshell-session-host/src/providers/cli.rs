use freshell_agent_runtime::{probe_provider_store, ProviderStoreProbe};
use freshell_runtime_protocol::ResumeSpec;
use std::{path::Path, process::Stdio};
use tokio::io::AsyncWriteExt;

pub async fn probe_as_provider(
    resume_spec: &ResumeSpec,
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<ProviderStoreProbe, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    // Fixture hosts already run as their intended workload uid/gid and have no
    // SETGID capability. Calling `setpriv --clear-groups` in that case fails
    // before the read-only probe starts. Real managed terminals target the
    // provider uid and therefore take the capability-scoped setpriv path.
    let current_uid = unsafe { libc::geteuid() };
    let current_gid = unsafe { libc::getegid() };
    let mut child = if needs_privilege_drop(run_as_uid, run_as_gid, current_uid, current_gid) {
        let mut command = tokio::process::Command::new("/usr/bin/setpriv");
        command
            .arg("--reuid")
            .arg(run_as_uid.to_string())
            .arg("--regid")
            .arg(run_as_gid.to_string())
            .arg("--clear-groups")
            .arg("--no-new-privs")
            .arg("--")
            .arg(&executable);
        command
    } else {
        tokio::process::Command::new(&executable)
    };
    child
        .arg("provider-probe-worker")
        .arg("--provider-home")
        .arg(&resume_spec.provider_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = child
        .spawn()
        .map_err(|error| format!("spawn provider recovery probe: {error}"))?;
    let payload = serde_json::to_vec(resume_spec).map_err(|error| error.to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "provider recovery probe has no stdin".to_string())?;
    stdin
        .write_all(&payload)
        .await
        .map_err(|error| format!("write provider recovery probe: {error}"))?;
    drop(stdin);
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("wait for provider recovery probe: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "provider recovery probe exited {:?}: {stderr}",
            output.status.code()
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("decode provider recovery probe: {error}"))
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
    use super::needs_privilege_drop;

    #[test]
    fn fixture_probe_skips_impossible_same_identity_setgroups() {
        assert!(!needs_privilege_drop(0, 0, 0, 0));
        assert!(needs_privilege_drop(65_534, 0, 0, 0));
    }
}

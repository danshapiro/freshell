use super::cli;
use freshell_agent_runtime::ProviderStoreProbe;
use freshell_codex::{
    launch_lifecycle::{CodexLaunchSidecar, CodexTerminalLaunchManager, LaunchClass},
    launch_plan::{
        codex_remote_args, CodexLaunchPlanInput, CodexSidecarLaunchContext,
        CODEX_INITIAL_LAUNCH_ATTEMPTS,
    },
    remote_proxy::RemoteProxyEvent,
};
use freshell_freshagent::session_lease::CondemnedRuntimeIdentity;
#[cfg(target_os = "linux")]
use freshell_freshagent::session_lease::{
    kill_and_confirm_recorded_tree_dead, record_condemned_runtime_identity,
};
use freshell_runtime_protocol::{ResumeSpec, TerminalLaunchSpec};
use std::sync::Arc;
use tokio::sync::mpsc;

/// Retire only a sidecar identity already owned by this host invocation.
/// Run under the provider uid so private /proc evidence and signals retain
/// their normal permissions; the host gains no DAC or KILL capability.
pub async fn cleanup_sidecar(
    recorded: CondemnedRuntimeIdentity,
    uid: u32,
    gid: u32,
) -> Result<bool, String> {
    use tokio::io::AsyncWriteExt;
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let mut child = cli::provider_command(std::path::Path::new("/usr/bin/timeout"), uid, gid)
        .args(["--kill-after=1s", "5s"])
        .arg(executable)
        .args([
            "codex-owned-cleanup",
            "--uid",
            &uid.to_string(),
            "--gid",
            &gid.to_string(),
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("run owned Codex cleanup: {error}"))?;
    let payload = owned_cleanup_payload(&recorded)?;
    let mut input = child
        .stdin
        .take()
        .ok_or("owned Codex cleanup has no input")?;
    input
        .write_all(&payload)
        .await
        .map_err(|error| error.to_string())?;
    drop(input);
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "owned Codex cleanup exited {:?}",
            output.status.code()
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("decode owned Codex cleanup: {error}"))
}

fn owned_cleanup_payload(recorded: &CondemnedRuntimeIdentity) -> Result<Vec<u8>, String> {
    serde_json::to_vec(recorded).map_err(|error| error.to_string())
}

async fn confirm_owned_cleanup_input(input: impl std::io::Read) -> Result<bool, String> {
    let request: CondemnedRuntimeIdentity = serde_json::from_reader(input.take(16 * 1024))
        .map_err(|_| "invalid owned Codex cleanup request")?;
    Ok(confirm_owned_cleanup(request).await)
}

pub async fn run_owned_cleanup(args: &[String]) -> Result<(), String> {
    let identity = |key: &str| {
        args.windows(2)
            .find(|pair| pair[0] == key)
            .and_then(|pair| pair[1].parse::<u32>().ok())
            .ok_or_else(|| format!("missing cleanup identity {key}"))
    };
    if unsafe { libc::geteuid() } != identity("--uid")?
        || unsafe { libc::getegid() } != identity("--gid")?
    {
        return Err("owned Codex cleanup identity mismatch".into());
    }
    let confirmed = confirm_owned_cleanup_input(std::io::stdin()).await?;
    serde_json::to_writer(std::io::stdout(), &confirmed)
        .map_err(|error| format!("encode owned Codex cleanup: {error}"))
}

async fn confirm_owned_cleanup(request: CondemnedRuntimeIdentity) -> bool {
    #[cfg(target_os = "linux")]
    {
        use freshell_codex::durability::CODEX_SIDECAR_OWNERSHIP_ENV;
        let mut request = request;
        if !request.capture_complete {
            return false;
        }
        let Some(expected_start) = request.start_time else {
            return false;
        };
        if request.pid == 0
            || request.pid > i32::MAX as u32
            || request
                .ownership_id
                .strip_prefix("codex-sidecar-")
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
                .is_none()
        {
            return false;
        }
        if let Some(observed) = freshell_codex::sidecar_store::proc_starttime(request.pid as i32) {
            if observed != expected_start {
                return false;
            }
            let Ok(environment) = std::fs::read(format!("/proc/{}/environ", request.pid)) else {
                return false;
            };
            let needle = freshell_codex::durability::ownership_needle(&request.ownership_id);
            if !environment
                .split(|byte| *byte == 0)
                .any(|entry| entry == needle.as_bytes())
            {
                return false;
            }
        }
        // The host may have another uid. Observe under the provider identity
        // before any signal, retaining every original member and coverage gap.
        let observed = record_condemned_runtime_identity(
            request.pid,
            CODEX_SIDECAR_OWNERSHIP_ENV,
            &request.ownership_id,
        );
        if observed
            .start_time
            .is_some_and(|start| start != expected_start)
        {
            return false;
        }
        request.capture_complete &= observed.capture_complete;
        for member in observed.tree {
            if !request.tree.contains(&member) {
                request.tree.push(member);
            }
        }
        kill_and_confirm_recorded_tree_dead(&request, CODEX_SIDECAR_OWNERSHIP_ENV).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = request;
        false
    }
}

/// Inspect the native recorder under its owner, without starting or resuming
/// Codex and without giving the host access to the private provider HOME.
pub async fn naming_rollout(
    home: String,
    thread_id: String,
    uid: u32,
    gid: u32,
) -> Result<Option<std::path::PathBuf>, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let output = cli::provider_command(std::path::Path::new("/usr/bin/timeout"), uid, gid)
        .args(["--kill-after=1s", "5s"])
        .arg(executable)
        .args([
            "codex-naming-proof",
            "--codex-home",
            &home,
            "--thread-id",
            &thread_id,
        ])
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|error| format!("run Codex naming proof: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Codex naming proof exited {:?}",
            output.status.code()
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("decode Codex naming proof: {error}"))
}

pub fn run_naming_proof(args: &[String]) -> Result<(), String> {
    let argument = |key: &str| {
        args.windows(2)
            .find(|pair| pair[0] == key)
            .map(|pair| pair[1].as_str())
            .ok_or_else(|| format!("missing {key}"))
    };
    let rollout = freshell_codex::durability::locate_thread_rollout_in_home(
        std::path::Path::new(argument("--codex-home")?),
        argument("--thread-id")?,
    );
    serde_json::to_writer(std::io::stdout(), &rollout)
        .map_err(|error| format!("encode Codex naming proof: {error}"))
}

pub struct PreparedCodexLaunch {
    pub sidecar: Arc<CodexLaunchSidecar>,
    pub events: mpsc::UnboundedReceiver<RemoteProxyEvent>,
    pub remote_args: [String; 4],
}

pub async fn prepare(
    terminal: &TerminalLaunchSpec,
    child_secret_env: &std::collections::BTreeMap<String, String>,
) -> Result<PreparedCodexLaunch, String> {
    if terminal.mode != "codex" {
        return Err("Codex launch adapter received another provider".into());
    }
    let input = CodexLaunchPlanInput {
        cwd: Some(&terminal.cwd),
        resume_session_id: terminal.resume_session_id.as_deref(),
        model: terminal.provider_model.as_deref(),
        sandbox: terminal.provider_sandbox.as_deref(),
        approval_policy: terminal.provider_permission_mode.as_deref(),
        // The managed session host owns the sidecar inside the soul enclosure.
        // It has no web-owned MCP context to inherit, so use the explicit
        // empty launch context rather than silently reintroducing web state.
        sidecar_context: CodexSidecarLaunchContext {
            provider_exec_profile: true,
            config_args: terminal
                .provider_launch_context
                .as_ref()
                .and_then(|context| {
                    if let freshell_runtime_protocol::ProviderPreparation::Codex {
                        sidecar_args,
                        ..
                    } = &context.preparation
                    {
                        Some(sidecar_args.clone())
                    } else {
                        None
                    }
                })
                .unwrap_or_default(),
            env: child_secret_env.clone(),
        },
    };
    let launch = CodexTerminalLaunchManager::global()
        .plan_create_with_retry_uncancellable(
            &input,
            CODEX_INITIAL_LAUNCH_ATTEMPTS,
            LaunchClass::Interactive,
        )
        .await
        .map_err(|error| error.to_string())?;
    let remote_args = codex_remote_args(&launch.remote_ws_url)
        .map_err(|error| format!("invalid Codex proxy URL: {error:?}"))?;
    Ok(PreparedCodexLaunch {
        sidecar: launch.sidecar,
        events: launch.events,
        remote_args,
    })
}

pub async fn probe(
    spec: &ResumeSpec,
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<ProviderStoreProbe, String> {
    if spec.provider_session.provider != "codex" {
        return Err("Codex recovery adapter received another provider".into());
    }
    cli::probe_as_provider(spec, run_as_uid, run_as_gid).await
}

#[cfg(all(test, target_os = "linux"))]
mod cleanup_tests {
    use super::*;

    #[tokio::test]
    async fn owned_cleanup_preserves_the_original_reparented_descendant() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let tag = format!("codex-sidecar-{}", uuid::Uuid::new_v4());
        // Both readiness acknowledgements precede the next command. The
        // descendant becomes unreadable only after the complete record exists.
        let mut parent = tokio::process::Command::new("python3")
            .args([
                "-c",
                r#"
import ctypes, os, sys, time
commands_r, commands_w = os.pipe()
acks_r, acks_w = os.pipe()
descendant = os.fork()
if descendant == 0:
    os.close(commands_w)
    os.close(acks_r)
    os.write(acks_w, b'R')
    assert os.read(commands_r, 1) == b'H'
    assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0
    os.write(acks_w, b'H')
    time.sleep(300)
    os._exit(0)
os.close(commands_r)
os.close(acks_w)
assert os.read(acks_r, 1) == b'R'
print(descendant, flush=True)
assert sys.stdin.readline() == 'hide\n'
os.write(commands_w, b'H')
assert os.read(acks_r, 1) == b'H'
print('hidden', flush=True)
assert sys.stdin.readline() == 'exit\n'
os._exit(0)
"#,
            ])
            .env(
                freshell_codex::durability::CODEX_SIDECAR_OWNERSHIP_ENV,
                &tag,
            )
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = parent.id().unwrap();
        let mut commands = parent.stdin.take().unwrap();
        let mut replies = BufReader::new(parent.stdout.take().unwrap()).lines();
        let descendant: i32 = replies.next_line().await.unwrap().unwrap().parse().unwrap();
        let original = record_condemned_runtime_identity(
            pid,
            freshell_codex::durability::CODEX_SIDECAR_OWNERSHIP_ENV,
            &tag,
        );
        assert!(original.capture_complete);
        assert!(original.start_time.is_some());
        assert!(original
            .tree
            .iter()
            .any(|(member, _)| *member == pid as i32));
        assert!(original
            .tree
            .iter()
            .any(|(member, _)| *member == descendant));
        commands.write_all(b"hide\n").await.unwrap();
        assert_eq!(
            replies.next_line().await.unwrap().as_deref(),
            Some("hidden")
        );
        assert_eq!(
            std::fs::read(format!("/proc/{descendant}/environ"))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::PermissionDenied,
        );
        commands.write_all(b"exit\n").await.unwrap();
        assert!(parent.wait().await.unwrap().success());
        let status = std::fs::read_to_string(format!("/proc/{descendant}/status")).unwrap();
        let ppid = status
            .lines()
            .find_map(|line| line.strip_prefix("PPid:"))
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        assert_ne!(ppid, pid, "the original descendant has actually reparented");

        // Exercise the same encoder and stdin parser used by the provider
        // helper, rather than asserting serialized field names.
        let payload = owned_cleanup_payload(&original).unwrap();
        let confirmed = confirm_owned_cleanup_input(payload.as_slice())
            .await
            .unwrap();
        let descendant_still_live =
            freshell_codex::sidecar_store::proc_starttime(descendant).is_some();
        // Close the fixture even when the regression returns a false proof.
        assert!(
            kill_and_confirm_recorded_tree_dead(
                &original,
                freshell_codex::durability::CODEX_SIDECAR_OWNERSHIP_ENV,
            )
            .await
        );
        assert!(
            confirmed,
            "cleanup must confirm the same complete original tree"
        );
        assert!(
            !descendant_still_live,
            "cleanup confirmed while an original recorded descendant was still live"
        );
    }

    #[tokio::test]
    async fn owned_cleanup_refuses_incomplete_original_without_signaling() {
        let tag = format!("codex-sidecar-{}", uuid::Uuid::new_v4());
        let mut child = tokio::process::Command::new("sleep")
            .arg("60")
            .env(
                freshell_codex::durability::CODEX_SIDECAR_OWNERSHIP_ENV,
                &tag,
            )
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let original = record_condemned_runtime_identity(
            child.id().unwrap(),
            freshell_codex::durability::CODEX_SIDECAR_OWNERSHIP_ENV,
            &tag,
        );
        assert!(original.capture_complete && original.start_time.is_some());
        let legacy = serde_json::to_vec(&serde_json::json!({
            "pid":original.pid,"startTime":original.start_time,"ownershipId":original.ownership_id,
        }))
        .unwrap();
        let legacy_rejected = confirm_owned_cleanup_input(legacy.as_slice())
            .await
            .is_err();
        let legacy_signaled = child.try_wait().unwrap().is_some();
        let mut incomplete = original.clone();
        incomplete.capture_complete = false;
        let payload = owned_cleanup_payload(&incomplete).unwrap();
        let confirmed = confirm_owned_cleanup_input(payload.as_slice())
            .await
            .unwrap();
        let signaled = child.try_wait().unwrap().is_some();
        assert!(
            kill_and_confirm_recorded_tree_dead(
                &original,
                freshell_codex::durability::CODEX_SIDECAR_OWNERSHIP_ENV,
            )
            .await
        );
        child.wait().await.unwrap();
        assert!(
            legacy_rejected,
            "missing original tree/completeness must reject the legacy request"
        );
        assert!(
            !legacy_signaled,
            "legacy input must not signal the live occupant"
        );
        assert!(
            !confirmed,
            "an incomplete original record cannot become a complete fresh capture"
        );
        assert!(
            !signaled,
            "incomplete original evidence must not signal its live occupant"
        );
    }

    #[tokio::test]
    async fn task010_owned_cleanup_rejects_unknown_and_stale_identity_before_signaling() {
        let tag = format!("codex-sidecar-{}", uuid::Uuid::new_v4());
        let mut child = tokio::process::Command::new("sleep")
            .arg("60")
            .env(
                freshell_codex::durability::CODEX_SIDECAR_OWNERSHIP_ENV,
                &tag,
            )
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let start = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let env = std::fs::read(format!("/proc/{pid}/environ")).unwrap_or_default();
                if env.split(|byte| *byte == 0).any(|entry| {
                    entry == freshell_codex::durability::ownership_needle(&tag).as_bytes()
                }) {
                    break freshell_codex::sidecar_store::proc_starttime(pid as i32).unwrap();
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        for (start_time, ownership_id) in [
            (None, tag.clone()),
            (Some(start + 1), tag.clone()),
            (
                Some(start),
                format!("codex-sidecar-{}", uuid::Uuid::new_v4()),
            ),
        ] {
            assert!(
                !confirm_owned_cleanup(CondemnedRuntimeIdentity {
                    pid,
                    start_time,
                    ownership_id,
                    tree: vec![(pid as i32, start)],
                    capture_complete: true,
                })
                .await
            );
            assert!(
                child.try_wait().unwrap().is_none(),
                "unknown or stale identity must not signal even this test's child"
            );
        }
        assert!(
            confirm_owned_cleanup(CondemnedRuntimeIdentity {
                pid,
                start_time: Some(start),
                ownership_id: tag,
                tree: vec![(pid as i32, start)],
                capture_complete: true,
            })
            .await
        );
        assert!(!child.wait().await.unwrap().success());
    }
}

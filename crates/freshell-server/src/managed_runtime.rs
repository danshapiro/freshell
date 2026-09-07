#![cfg(feature = "managed-runtime-v1")]

use freshell_runtime_client::RuntimeClient;
use freshell_runtime_protocol::{
    LaunchRequest, ProviderBootstrapFile, RequestId, RuntimeLimits, RuntimeProfile, SoulId,
    StopOutcome, TerminalLaunchSpec,
};
use freshell_terminal::registry::{
    ManagedOutputChunk, ManagedOutputRead, ManagedTerminalController, ManagedTerminalDescriptor,
    ManagedTerminalFuture, ManagedTerminalLaunch,
};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};

#[derive(Clone)]
pub struct ServerManagedRuntimeController {
    client: RuntimeClient,
}

impl ServerManagedRuntimeController {
    pub async fn from_env() -> Result<Option<Arc<dyn ManagedTerminalController>>, String> {
        if std::env::var("FRESHELL_MANAGED_RUNTIME_V1").ok().as_deref() != Some("1") {
            return Ok(None);
        }
        let socket = std::env::var("FRESHELL_RUNTIME_CONTROL_SOCKET").map_err(|_| {
            "FRESHELL_MANAGED_RUNTIME_V1=1 requires FRESHELL_RUNTIME_CONTROL_SOCKET".to_string()
        })?;
        let secret = std::env::var("FRESHELL_RUNTIME_CONTROL_SECRET_FILE").map_err(|_| {
            "FRESHELL_MANAGED_RUNTIME_V1=1 requires FRESHELL_RUNTIME_CONTROL_SECRET_FILE"
                .to_string()
        })?;
        let client = RuntimeClient::from_secret_file(socket, secret)
            .await
            .map_err(|e| format!("managed runtime client: {e}"))?;
        client
            .health()
            .await
            .map_err(|e| format!("managed runtime supervisor health: {e}"))?;
        Ok(Some(Arc::new(Self { client })))
    }
}

impl ManagedTerminalController for ServerManagedRuntimeController {
    fn launch<'a>(
        &'a self,
        request: ManagedTerminalLaunch,
    ) -> ManagedTerminalFuture<'a, Result<ManagedTerminalDescriptor, String>> {
        Box::pin(async move {
            let create_key = request
                .create_request_id
                .as_deref()
                .unwrap_or(&request.terminal_id);
            let soul_id = stable_soul_id(create_key)?;
            let cwd = canonical_cwd(request.spec.cwd.as_deref())?;
            let workspace = workspace_root(&cwd);
            let git_common_dir = git_common_dir(&workspace);
            let project_key = stable_project_key(&workspace);
            // Phase 2 persists the launch spec in the supervisor registry.
            // Persist ONLY an explicit non-secret allowlist — never the web
            // server's resolved child environment wholesale (which can carry
            // AUTH_TOKEN, provider API keys, cloud credentials, proxy creds, ...).
            let mut env = managed_env_allowlist(&request.env);
            // Provider state belongs to this soul's Docker volume, not the web
            // server's inherited HOME. These paths are inside the workload.
            env.insert("HOME".into(), "/home/freshell/provider".into());
            env.insert(
                "CLAUDE_HOME".into(),
                "/home/freshell/provider/.claude".into(),
            );
            env.insert(
                "CLAUDE_CONFIG_DIR".into(),
                "/home/freshell/provider/.claude".into(),
            );
            env.insert("CODEX_HOME".into(), "/home/freshell/provider/.codex".into());
            env.insert(
                "XDG_DATA_HOME".into(),
                "/home/freshell/provider/.local/share".into(),
            );
            env.insert(
                "XDG_CONFIG_HOME".into(),
                "/home/freshell/provider/.config".into(),
            );
            let launch = LaunchRequest {
                soul_id: soul_id.clone(),
                provider: request.mode.clone(),
                provider_store_id: soul_id.to_string(),
                creation_seed_ref: create_key.to_string(),
                limits: RuntimeLimits {
                    cpu_milli: 2000,
                    memory_bytes: 4 * 1024 * 1024 * 1024,
                    swap_bytes: 0,
                    pids_max: 512,
                },
                profile: RuntimeProfile::DefaultAgent,
                project_key: project_key.clone(),
                native_session_id: request.resume_session_id.clone(),
                fixture: None,
                terminal: Some(TerminalLaunchSpec {
                    terminal_id: request.terminal_id.clone(),
                    stream_id: request.stream_id.clone(),
                    mode: request.mode.clone(),
                    program: request.spec.program,
                    // Phase 2's managed provider has no durable Freshell MCP
                    // tool-router yet. The legacy --mcp-config file is web-owned
                    // temporary state and its child server needs FRESHELL_TOKEN;
                    // carrying either across this boundary would reintroduce a
                    // web dependency and persist a credential. Phase 3 replaces
                    // this with the scoped durable tool router.
                    args: managed_provider_args(&request.mode, request.spec.args),
                    env,
                    cwd: cwd.to_string_lossy().into_owned(),
                    cols: request.spec.cols,
                    rows: request.spec.rows,
                    project_key,
                    workspace_path: workspace.to_string_lossy().into_owned(),
                    git_common_dir: git_common_dir.map(|p| p.to_string_lossy().into_owned()),
                    create_request_id: request.create_request_id.clone(),
                    resume_session_id: request.resume_session_id.clone(),
                    provider_bootstrap_files: provider_bootstrap_files(&request.mode)?,
                }),
                expected_control_epoch: None,
            };
            let request_id = stable_request_id(create_key)?;
            let result = self
                .client
                .launch(request_id, launch)
                .await
                .map_err(|e| e.to_string())?;
            Ok(ManagedTerminalDescriptor {
                soul_id: result.view.soul_id.to_string(),
                incarnation_id: result.view.incarnation_id.to_string(),
                terminal_id: request.terminal_id,
                stream_id: request.stream_id,
                mode: request.mode,
                cwd: cwd.to_string_lossy().into_owned(),
                resume_session_id: request.resume_session_id,
                create_request_id: request.create_request_id,
            })
        })
    }

    fn input<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
        data: String,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let soul = SoulId::parse(terminal.soul_id).map_err(|e| e.to_string())?;
            self.client
                .input(RequestId::new(), soul, data)
                .await
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    fn resize<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
        cols: u16,
        rows: u16,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let soul = SoulId::parse(terminal.soul_id).map_err(|e| e.to_string())?;
            self.client
                .resize(soul, cols, rows)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn stop<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
    ) -> ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let soul = SoulId::parse(terminal.soul_id).map_err(|e| e.to_string())?;
            match self.client.stop(soul).await.map_err(|e| e.to_string())? {
                StopOutcome::VerifiedEmpty => Ok(()),
                other => Err(format!(
                    "managed runtime stop not verified empty: {other:?}"
                )),
            }
        })
    }

    fn read_output<'a>(
        &'a self,
        terminal: ManagedTerminalDescriptor,
        after_seq: i64,
        max_bytes: u64,
    ) -> ManagedTerminalFuture<'a, Result<ManagedOutputRead, String>> {
        Box::pin(async move {
            let soul = SoulId::parse(terminal.soul_id).map_err(|e| e.to_string())?;
            let output = self
                .client
                .read_output(soul.clone(), after_seq.max(0) as u64, max_bytes)
                .await
                .map_err(|e| e.to_string())?;
            if output.exited {
                match self.client.stop(soul).await.map_err(|e| e.to_string())? {
                    StopOutcome::VerifiedEmpty => {}
                    other => {
                        return Err(format!(
                            "provider exited but managed enclosure stop was not verified empty: {other:?}"
                        ))
                    }
                }
            }
            Ok(ManagedOutputRead {
                reset_required: output.reset_required,
                truncated: output.truncated,
                retained_from_seq: output.retained_from_seq.min(i64::MAX as u64) as i64,
                head_seq: output.head_seq.min(i64::MAX as u64) as i64,
                exit_code: output.exited.then_some(output.exit_code.unwrap_or(0)),
                chunks: output
                    .frames
                    .into_iter()
                    .map(|frame| ManagedOutputChunk {
                        seq_start: frame.seq_start.min(i64::MAX as u64) as i64,
                        seq_end: frame.seq_end.min(i64::MAX as u64) as i64,
                        data: frame.data,
                    })
                    .collect(),
            })
        })
    }
}

fn managed_env_allowlist(
    source: &std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    const ALLOWED: &[&str] = &[
        "PATH",
        "SHELL",
        "TERM",
        "COLORTERM",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "FRESHELL",
        "FRESHELL_TERMINAL_ID",
        "FRESHELL_TAB_ID",
        "FRESHELL_PANE_ID",
        "PROMPT_TOOLKIT_NO_CPR",
    ];
    source
        .iter()
        .filter(|(key, _)| ALLOWED.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn managed_provider_args(mode: &str, args: Vec<String>) -> Vec<String> {
    if mode != "claude" {
        return args;
    }
    let mut out = Vec::with_capacity(args.len());
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--mcp-config" && index + 1 < args.len() {
            index += 2;
            continue;
        }
        out.push(args[index].clone());
        index += 1;
    }
    out
}

fn provider_bootstrap_files(mode: &str) -> Result<Vec<ProviderBootstrapFile>, String> {
    if mode != "claude" {
        return Ok(Vec::new());
    }
    let explicit = std::env::var("FRESHELL_MANAGED_CLAUDE_CREDENTIAL_FILE")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let candidate = explicit
        .clone()
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("CLAUDE_CONFIG_DIR")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .map(|dir| dir.join(".credentials.json"))
        })
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .map(|home| home.join(".claude").join(".credentials.json"))
        });
    let Some(candidate) = candidate else {
        return Ok(Vec::new());
    };
    if !candidate.is_file() {
        if explicit.is_some() {
            return Err(format!(
                "FRESHELL_MANAGED_CLAUDE_CREDENTIAL_FILE is not a readable file: {}",
                candidate.display()
            ));
        }
        return Ok(Vec::new());
    }
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|error| format!("canonicalize Claude credential reference: {error}"))?;
    Ok(vec![ProviderBootstrapFile {
        source_path: canonical.to_string_lossy().into_owned(),
        provider_relative_path: ".claude/.credentials.json".to_string(),
    }])
}

fn stable_soul_id(key: &str) -> Result<SoulId, String> {
    SoulId::parse(format!("soul-terminal-{}", stable_hex(key))).map_err(|e| e.to_string())
}
fn stable_request_id(key: &str) -> Result<RequestId, String> {
    RequestId::parse(format!("request-terminal-{}", stable_hex(key))).map_err(|e| e.to_string())
}
fn stable_project_key(path: &Path) -> String {
    format!("project-{}", stable_hex(&path.to_string_lossy()))
}
fn stable_hex(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))[..32].to_string()
}

fn canonical_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    let path = cwd
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir().map_err(|e| e.to_string())?);
    let path =
        std::fs::canonicalize(&path).map_err(|e| format!("managed cwd {}: {e}", path.display()))?;
    if !path.is_dir() {
        return Err(format!(
            "managed cwd is not a directory: {}",
            path.display()
        ));
    }
    Ok(path)
}

fn workspace_root(cwd: &Path) -> PathBuf {
    git_stdout(cwd, &["rev-parse", "--show-toplevel"])
        .and_then(|raw| std::fs::canonicalize(raw.trim()).ok())
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| cwd.to_path_buf())
}

fn git_common_dir(workspace: &Path) -> Option<PathBuf> {
    let raw = git_stdout(workspace, &["rev-parse", "--git-common-dir"])?;
    let raw = PathBuf::from(raw.trim());
    let candidate = if raw.is_absolute() {
        raw
    } else {
        workspace.join(raw)
    };
    std::fs::canonicalize(candidate).ok().filter(|p| p.is_dir())
}

fn git_stdout(cwd: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_env_drops_server_and_provider_secrets() {
        let source = [
            ("PATH", "/usr/local/bin:/usr/bin"),
            ("TERM", "xterm-256color"),
            ("FRESHELL_TERMINAL_ID", "t1"),
            ("FRESHELL_TOKEN", "web-secret"),
            ("AUTH_TOKEN", "web-secret-2"),
            ("ANTHROPIC_API_KEY", "provider-secret"),
            ("CLAUDE_CODE_OAUTH_TOKEN", "provider-oauth"),
            ("AWS_SECRET_ACCESS_KEY", "cloud-secret"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
        let filtered = managed_env_allowlist(&source);
        assert_eq!(
            filtered.get("PATH").map(String::as_str),
            Some("/usr/local/bin:/usr/bin")
        );
        assert_eq!(
            filtered.get("FRESHELL_TERMINAL_ID").map(String::as_str),
            Some("t1")
        );
        for key in [
            "FRESHELL_TOKEN",
            "AUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            assert!(!filtered.contains_key(key), "secret key leaked: {key}");
        }
    }

    #[test]
    fn managed_claude_strips_web_bound_mcp_tempfile_only() {
        let args = vec![
            "--settings".into(),
            "{}".into(),
            "--mcp-config".into(),
            "/tmp/freshell-mcp/t1.json".into(),
            "--session-id".into(),
            "s1".into(),
        ];
        assert_eq!(
            managed_provider_args("claude", args),
            vec!["--settings", "{}", "--session-id", "s1"]
        );
    }
}

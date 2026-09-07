#![cfg(feature = "managed-runtime-v1")]

use freshell_runtime_client::RuntimeClient;
use freshell_runtime_protocol::{
    LaunchRequest, LaunchState, ProviderBootstrapFile, RequestId, RuntimeLimits, RuntimeProfile,
    RuntimeView, SoulId, StopOutcome, TerminalLaunchSpec,
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
            let (run_as_uid, run_as_gid) = (MANAGED_PROVIDER_UID, MANAGED_PROVIDER_GID);
            let git_common_dir = git_common_dir(&workspace);
            let project_key = stable_project_key(&workspace);
            let inventory = self.client.inventory().await.map_err(|e| e.to_string())?;
            if let Some(view) = reusable_running_view(&inventory, &soul_id, &request.terminal_id)? {
                return Ok(ManagedTerminalDescriptor {
                    soul_id: view.soul_id.to_string(),
                    incarnation_id: view.incarnation_id.to_string(),
                    terminal_id: request.terminal_id,
                    stream_id: request.stream_id,
                    mode: request.mode,
                    cwd: cwd.to_string_lossy().into_owned(),
                    resume_session_id: request.resume_session_id,
                    create_request_id: request.create_request_id,
                });
            }
            // Phase 2 persists the launch spec in the supervisor registry.
            // Persist ONLY an explicit non-secret allowlist — never the web
            // server's resolved child environment wholesale (which can carry
            // AUTH_TOKEN, provider API keys, cloud credentials, proxy creds, ...).
            let env = managed_provider_env(&request.mode, &request.env);
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
                    run_as_uid,
                    run_as_gid,
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
                native_session_id: output.native_session_id,
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

fn reusable_running_view(
    views: &[RuntimeView],
    soul_id: &SoulId,
    terminal_id: &str,
) -> Result<Option<RuntimeView>, String> {
    let matching: Vec<&RuntimeView> = views
        .iter()
        .filter(|view| &view.soul_id == soul_id)
        .collect();
    if matching.is_empty() {
        return Ok(None);
    }
    let running: Vec<&RuntimeView> = matching
        .iter()
        .copied()
        .filter(|view| view.launch_state == LaunchState::Running)
        .collect();
    if running.len() != 1 {
        return Err(format!(
            "managed soul {} exists but has {} running incarnations; refusing a replacement launch",
            soul_id.as_str(),
            running.len()
        ));
    }
    let view = running[0];
    if view.terminal_id.as_deref() != Some(terminal_id) {
        return Err(format!(
            "managed soul {} is already bound to terminal {:?}, not {terminal_id}",
            soul_id.as_str(),
            view.terminal_id
        ));
    }
    Ok(Some(view.clone()))
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

fn managed_provider_env(
    mode: &str,
    source: &std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    let mut env = managed_env_allowlist(source);
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
    if mode == "opencode" {
        env.insert("TMPDIR".into(), "/run/opencode-tmp".into());
        // The legacy inline OpenCode config may contain credential-shaped
        // values. Never persist it in supervisor state. Phase 2 carries only
        // the invariant Freshell needs for safe conversation rollback.
        env.insert(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"snapshot":false,"autoupdate":false}"#.to_string(),
        );
    }
    env
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
    let (explicit_key, fallbacks): (&str, Vec<PathBuf>) = match mode {
        "claude" => {
            let mut paths = Vec::new();
            if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
                if !dir.trim().is_empty() {
                    paths.push(PathBuf::from(dir).join(".credentials.json"));
                }
            }
            if let Ok(home) = std::env::var("HOME") {
                if !home.trim().is_empty() {
                    paths.push(
                        PathBuf::from(home)
                            .join(".claude")
                            .join(".credentials.json"),
                    );
                }
            }
            ("FRESHELL_MANAGED_CLAUDE_CREDENTIAL_FILE", paths)
        }
        "opencode" => {
            let mut paths = Vec::new();
            if let Ok(data) = std::env::var("XDG_DATA_HOME") {
                if !data.trim().is_empty() {
                    paths.push(PathBuf::from(data).join("opencode").join("auth.json"));
                }
            }
            if let Ok(home) = std::env::var("HOME") {
                if !home.trim().is_empty() {
                    paths.push(
                        PathBuf::from(home)
                            .join(".local")
                            .join("share")
                            .join("opencode")
                            .join("auth.json"),
                    );
                }
            }
            ("FRESHELL_MANAGED_OPENCODE_AUTH_FILE", paths)
        }
        _ => return Ok(Vec::new()),
    };

    if let Ok(explicit) = std::env::var(explicit_key) {
        if !explicit.trim().is_empty() {
            return provider_bootstrap_files_from_candidate(mode, Some(PathBuf::from(explicit)))
                .map_err(|error| format!("{explicit_key}: {error}"));
        }
    }
    let candidate = fallbacks.into_iter().find(|path| path.is_file());
    provider_bootstrap_files_from_candidate(mode, candidate)
}

fn provider_bootstrap_files_from_candidate(
    mode: &str,
    candidate: Option<PathBuf>,
) -> Result<Vec<ProviderBootstrapFile>, String> {
    let Some(candidate) = candidate else {
        return Ok(Vec::new());
    };
    if !candidate.is_file() {
        return Err(format!("not a readable file: {}", candidate.display()));
    }
    let provider_relative_path = match mode {
        "claude" => ".claude/.credentials.json",
        "opencode" => ".local/share/opencode/auth.json",
        _ => return Ok(Vec::new()),
    };
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|error| format!("canonicalize provider bootstrap reference: {error}"))?;
    Ok(vec![ProviderBootstrapFile {
        source_path: canonical.to_string_lossy().into_owned(),
        provider_relative_path: provider_relative_path.to_string(),
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

const MANAGED_PROVIDER_UID: u32 = 65_534;
const MANAGED_PROVIDER_GID: u32 = 0;

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
    fn running_soul_is_reused_before_launch_payload_rehash_and_mismatches_fail_closed() {
        let soul = SoulId::parse("soul-terminal-test").unwrap();
        let running = freshell_runtime_protocol::RuntimeView {
            soul_id: soul.clone(),
            incarnation_id: freshell_runtime_protocol::IncarnationId::new(),
            launch_state: freshell_runtime_protocol::LaunchState::Running,
            cleanup_state: freshell_runtime_protocol::CleanupState::None,
            intent_revision: 1,
            container_id: Some("a".repeat(64)),
            host_boot_id: Some(freshell_runtime_protocol::HostBootId::new()),
            execution_generation: 1,
            effective_limits: None,
            terminal_id: Some("terminal-stable".into()),
            project_key: Some("project-test".into()),
            profile: Some(RuntimeProfile::DefaultAgent),
        };
        let reused =
            reusable_running_view(std::slice::from_ref(&running), &soul, "terminal-stable")
                .unwrap()
                .expect("running soul should be reused");
        assert_eq!(reused.incarnation_id, running.incarnation_id);

        assert!(
            reusable_running_view(std::slice::from_ref(&running), &soul, "terminal-other").is_err()
        );
        let mut stopped = running;
        stopped.launch_state = freshell_runtime_protocol::LaunchState::Stopped;
        assert!(reusable_running_view(&[stopped], &soul, "terminal-stable").is_err());
    }

    #[test]
    fn managed_opencode_env_uses_soul_state_and_drops_host_config_paths() {
        let source = [
            ("PATH", "/usr/local/bin:/usr/bin"),
            ("OPENCODE_CONFIG_CONTENT", r#"{"secret":"do-not-persist"}"#),
            (
                "OPENCODE_TUI_CONFIG",
                "/home/user/.freshell/opencode/tui.json",
            ),
            ("OPENCODE_API_KEY", "provider-secret"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
        let env = managed_provider_env("opencode", &source);
        assert_eq!(
            env.get("HOME").map(String::as_str),
            Some("/home/freshell/provider")
        );
        assert_eq!(
            env.get("XDG_DATA_HOME").map(String::as_str),
            Some("/home/freshell/provider/.local/share")
        );
        assert_eq!(
            env.get("XDG_CONFIG_HOME").map(String::as_str),
            Some("/home/freshell/provider/.config")
        );
        assert_eq!(
            env.get("OPENCODE_CONFIG_CONTENT").map(String::as_str),
            Some(r#"{"snapshot":false,"autoupdate":false}"#)
        );
        assert_eq!(
            env.get("TMPDIR").map(String::as_str),
            Some("/run/opencode-tmp")
        );
        assert!(!env.contains_key("OPENCODE_TUI_CONFIG"));
        assert!(!env.contains_key("OPENCODE_API_KEY"));
        assert!(!env.values().any(|value| value.contains("do-not-persist")));
    }

    #[test]
    fn opencode_bootstrap_reference_targets_soul_auth_store_without_persisting_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let auth = dir.path().join("auth.json");
        std::fs::write(&auth, r#"{"opencode":{"key":"secret-bytes"}}"#).unwrap();
        let files = provider_bootstrap_files_from_candidate("opencode", Some(auth)).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].provider_relative_path,
            ".local/share/opencode/auth.json"
        );
        assert!(!files[0].source_path.contains("secret-bytes"));
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

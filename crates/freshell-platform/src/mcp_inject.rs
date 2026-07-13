//! MCP config injection — the IO port of `server/mcp/config-writer.ts`
//! (`port/machine/specs/cli-argv-fidelity.md` §3.2).
//!
//! Per-mode injection (`generateMcpInjection`, `cw:252-423`):
//! * `claude`  — tmp JSON config file (0o600, pretty-2-space) + `--mcp-config <path>`
//! * `codex`   — inline TOML `-c` pair (no temp file)
//! * `gemini`  — same tmp JSON file, injected via **env**
//!   (`GEMINI_CLI_SYSTEM_DEFAULTS_PATH`) — the ONLY env-returning branch
//! * `kimi`    — same tmp JSON file + `--mcp-config-file <path>`
//! * `opencode`— locked merge of `<cwd>/.opencode/opencode.json` + sidecar
//!   refcount; zero argv/env contribution
//!
//! plus `cleanupMcpConfig` (`cw:429-512`), wired to terminal exit AND failed
//! spawn (`terminal-registry.ts:1491,1605`).
//!
//! ## U1 decision (spec §5) — the injected MCP server command
//!
//! The reference injects `node` + args resolved from the **Node repo layout**
//! (`buildMcpServerCommandArgs`, `cw:89-107`). The Rust port ships no MCP
//! server of its own, so this port adopts **option (a)**: resolve the SAME
//! Node-repo layout — repo root found by walking up from the process cwd
//! looking for a `package.json` with `"name": "freshell"` (the reference walks
//! from `server/mcp/`; both resolve the same root when the server runs from
//! the repo checkout, which is the deployment under test) — and inject the
//! reference-identical `node --import <root>/node_modules/tsx/dist/loader.mjs
//! <root>/server/mcp/server.ts` (dev) or `<root>/dist/server/mcp/server.js`
//! (production build present + `NODE_ENV=production`). When `tsx` cannot be
//! resolved the reference-exact error is raised (`cw:72-79`). The golden tests
//! inject [`McpRuntime::server_command_args`] as a seam, so they remain valid
//! under any future re-decision (e.g. a Rust MCP server binary).

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::spawn::{McpInjection, ProviderTarget};

/// An MCP injection failure. `message` carries the reference-exact `Error.message`
/// where one exists (`cw` throw sites); IO failures carry the OS error text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpInjectError {
    pub message: String,
}

impl McpInjectError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for McpInjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for McpInjectError {}

/// One element of the MCP server command args, tagged so the win32/WSL path
/// conversion (`cw:91-96`) applies only to path elements (the reference
/// converts `resolveRepoPath`/`resolveDependencyForPlatform` results, never
/// the literal `--import` flag).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpServerArg {
    Literal(String),
    Path(String),
}

/// The environment seam for the config writer: tmp dir (`os.tmpdir()`), WSL
/// detection (`cw:45-51`), `wslpath -w` conversion (`cw:57-70`), and the MCP
/// server command args (U1 seam — `cw:89-107`).
pub trait McpRuntime {
    /// `os.tmpdir()`.
    fn tmp_dir(&self) -> PathBuf;
    /// `isWslEnvironment()` (`cw:45-51`): linux && (WSL_DISTRO_NAME || WSL_INTEROP || WSLENV).
    fn is_wsl_environment(&self) -> bool;
    /// `convertToWindowsPath` (`cw:57-70`): `wslpath -w`, 3s timeout, input on failure.
    /// Callers must pre-gate on [`Self::is_wsl_environment`] (as the reference does
    /// via `needsWinPaths`).
    fn convert_to_windows_path(&self, linux_path: &str) -> String;
    /// The host-form MCP server command args (pre-conversion) — `cw:89-107`
    /// minus the `needsWinPaths` mapping, which [`build_mcp_server_command_args`]
    /// applies.
    fn server_command_args(&self) -> Result<Vec<McpServerArg>, McpInjectError>;
}

/// The live runtime (see the module-level U1 decision).
pub struct RealMcpRuntime;

impl McpRuntime for RealMcpRuntime {
    fn tmp_dir(&self) -> PathBuf {
        std::env::temp_dir()
    }

    fn is_wsl_environment(&self) -> bool {
        if !cfg!(target_os = "linux") {
            return false;
        }
        ["WSL_DISTRO_NAME", "WSL_INTEROP", "WSLENV"]
            .iter()
            .any(|k| std::env::var(k).map(|v| !v.is_empty()).unwrap_or(false))
    }

    fn convert_to_windows_path(&self, linux_path: &str) -> String {
        convert_to_windows_path_live(linux_path)
    }

    fn server_command_args(&self) -> Result<Vec<McpServerArg>, McpInjectError> {
        let repo_root = find_repo_root();
        let built = repo_root.join("dist/server/mcp/server.js");
        let node_env_production = std::env::var("NODE_ENV")
            .map(|v| v == "production")
            .unwrap_or(false);
        if node_env_production && built.is_file() {
            return Ok(vec![McpServerArg::Path(built.to_string_lossy().into_owned())]);
        }
        // `require.resolve('tsx')` resolves the package export "." →
        // `./dist/loader.mjs` (rev 2 pin vs node_modules/tsx/package.json).
        let tsx = repo_root.join("node_modules/tsx/dist/loader.mjs");
        if !tsx.is_file() {
            return Err(McpInjectError::new(
                "Unable to resolve MCP dependency \"tsx\". Ensure project dependencies are installed.",
            ));
        }
        Ok(vec![
            McpServerArg::Literal("--import".to_string()),
            McpServerArg::Path(tsx.to_string_lossy().into_owned()),
            McpServerArg::Path(
                repo_root
                    .join("server/mcp/server.ts")
                    .to_string_lossy()
                    .into_owned(),
            ),
        ])
    }
}

/// `findRepoRoot` (`cw:21-32`): walk up (max 5) looking for a `package.json`
/// with `"name": "freshell"`; fallback to the starting dir (the reference falls
/// back to its own repo root — for this port the process cwd is the deployment
/// anchor, see the U1 note).
fn find_repo_root() -> PathBuf {
    let start = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut dir = start.clone();
    for _ in 0..5 {
        let pkg = dir.join("package.json");
        if let Ok(text) = std::fs::read_to_string(&pkg) {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                if value.get("name").and_then(|n| n.as_str()) == Some("freshell") {
                    return dir;
                }
            }
        }
        match dir.parent() {
            Some(parent) => dir = parent.to_path_buf(),
            None => break,
        }
    }
    start
}

/// `convertToWindowsPath`'s exec half: `wslpath -w <path>` with a 3s timeout,
/// falling back to the input on any failure (`cw:57-70`).
fn convert_to_windows_path_live(linux_path: &str) -> String {
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    let child = Command::new("wslpath")
        .arg("-w")
        .arg(linux_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(child) = child else {
        return linux_path.to_string();
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(output)) if output.status.success() => {
            let trimmed = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if trimmed.is_empty() {
                linux_path.to_string()
            } else {
                trimmed
            }
        }
        // Failure or timeout (the reader thread reaps the child either way).
        _ => linux_path.to_string(),
    }
}

/// `buildMcpServerCommandArgs(platform)` (`cw:89-107`): the runtime's host-form
/// args with the `needsWinPaths` conversion applied to path elements when
/// `platform === 'windows' && isWslEnvironment()`.
pub fn build_mcp_server_command_args(
    rt: &dyn McpRuntime,
    target: ProviderTarget,
) -> Result<Vec<String>, McpInjectError> {
    let needs_win_paths = target == ProviderTarget::Windows && rt.is_wsl_environment();
    Ok(rt
        .server_command_args()?
        .into_iter()
        .map(|arg| match arg {
            McpServerArg::Literal(s) => s,
            McpServerArg::Path(p) => {
                if needs_win_paths {
                    rt.convert_to_windows_path(&p)
                } else {
                    p
                }
            }
        })
        .collect())
}

/// `tomlEscape` (`cw:142-144`): wrap in `"` with `\` → `\\` and `"` → `\"`.
pub fn toml_escape(value: &str) -> String {
    format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    )
}

/// The codex inline-TOML `-c` pair (`cw:264-275`): elements tomlEscape'd and
/// joined with `", "` (comma + space, `cw:267`). Pure — exposed so the argv
/// goldens can drive it with the §4 `MCP_UNIX` seam.
pub fn codex_inline_toml_args(server_args: &[String]) -> Vec<String> {
    let toml_args = server_args
        .iter()
        .map(|a| toml_escape(a))
        .collect::<Vec<_>>()
        .join(", ");
    vec![
        "-c".to_string(),
        format!("mcp_servers.freshell.command={}", toml_escape("node")),
        "-c".to_string(),
        format!("mcp_servers.freshell.args=[{toml_args}]"),
    ]
}

fn tmp_file_path(rt: &dyn McpRuntime, terminal_id: &str) -> PathBuf {
    rt.tmp_dir().join("freshell-mcp").join(format!("{terminal_id}.json"))
}

/// Write a file with `JSON.stringify(value, null, 2)` bytes at mode 0o600
/// (mode applied at creation, matching `fs.writeFileSync`'s `mode` option).
fn write_json_0600(path: &Path, value: &serde_json::Value) -> Result<(), McpInjectError> {
    let bytes = serde_json::to_string_pretty(value)
        .map_err(|e| McpInjectError::new(e.to_string()))?;
    write_string_0600(path, &bytes)
}

fn write_string_0600(path: &Path, contents: &str) -> Result<(), McpInjectError> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts
        .open(path)
        .map_err(|e| McpInjectError::new(e.to_string()))?;
    f.write_all(contents.as_bytes())
        .map_err(|e| McpInjectError::new(e.to_string()))
}

/// `writeMcpConfigFile` (`cw:117-137`): write the tmp JSON config (always to
/// the host tmp dir), return the path — UNC-converted when the agent is a
/// Windows process on a WSL host.
fn write_mcp_config_file(
    rt: &dyn McpRuntime,
    terminal_id: &str,
    target: ProviderTarget,
) -> Result<String, McpInjectError> {
    let file_path = tmp_file_path(rt, terminal_id);
    if let Some(dir) = file_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| McpInjectError::new(e.to_string()))?;
    }
    let server_args = build_mcp_server_command_args(rt, target)?;
    let config = serde_json::json!({
        "mcpServers": {
            "freshell": {
                "command": "node",
                "args": server_args,
            }
        }
    });
    write_json_0600(&file_path, &config)?;
    let path_str = file_path.to_string_lossy().into_owned();
    if target == ProviderTarget::Windows && rt.is_wsl_environment() {
        return Ok(rt.convert_to_windows_path(&path_str));
    }
    Ok(path_str)
}

// ---------------------------------------------------------------------------
// OpenCode sidecar tracking (`cw:146-241`)
// ---------------------------------------------------------------------------

fn opencode_config_path(cwd: &str) -> PathBuf {
    Path::new(cwd).join(".opencode").join("opencode.json")
}

fn opencode_sidecar_path(cwd: &str) -> PathBuf {
    Path::new(cwd).join(".opencode").join(".freshell-mcp-state.json")
}

fn opencode_lock_path(cwd: &str) -> PathBuf {
    Path::new(cwd).join(".opencode").join(".freshell-mcp-state.lock")
}

/// `acquireLock` (`cw:178-214`): O_EXCL create; stale (>30s mtime) locks are
/// removed; 5 retries with a ~100ms wait; then the reference-exact throw.
/// Returns whether THIS call acquired the lock (release is gated on it,
/// mirroring the `_lockAcquired` module flag).
fn acquire_lock(cwd: &str) -> Result<bool, McpInjectError> {
    let lock_path = opencode_lock_path(cwd);
    if let Some(dir) = lock_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    const MAX_RETRIES: u32 = 5;
    for _ in 0..MAX_RETRIES {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        match opts.open(&lock_path) {
            Ok(mut f) => {
                let _ = f.write_all(std::process::id().to_string().as_bytes());
                return Ok(true);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                // Stale (> 30 seconds old)?
                if let Ok(meta) = std::fs::metadata(&lock_path) {
                    if let Ok(modified) = meta.modified() {
                        if modified
                            .elapsed()
                            .map(|d| d.as_millis() > 30_000)
                            .unwrap_or(false)
                        {
                            let _ = std::fs::remove_file(&lock_path);
                            continue;
                        }
                    }
                }
                // Brief wait for a non-stale lock (the reference busy-waits 100ms).
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(McpInjectError::new(e.to_string())),
        }
    }
    Err(McpInjectError::new(format!(
        "Failed to acquire lock at {} after {} retries. Another process may be holding it. Check for stale lock files.",
        lock_path.display(),
        MAX_RETRIES
    )))
}

/// `releaseLock` (`cw:220-229`): only removes the lock this call acquired.
fn release_lock(cwd: &str, acquired: bool) {
    if acquired {
        let _ = std::fs::remove_file(opencode_lock_path(cwd));
    }
}

fn read_sidecar(cwd: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(opencode_sidecar_path(cwd)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_sidecar(cwd: &str, sidecar: &serde_json::Value) -> Result<(), McpInjectError> {
    write_json_0600(&opencode_sidecar_path(cwd), sidecar)
}

/// The opencode branch of `generateMcpInjection` (`cw:287-415`): locked merge
/// of `<cwd>/.opencode/opencode.json` + sidecar refcount. Zero argv/env.
fn opencode_inject(
    rt: &dyn McpRuntime,
    cwd: Option<&str>,
    target: ProviderTarget,
) -> Result<McpInjection, McpInjectError> {
    let Some(cwd) = cwd.filter(|c| !c.is_empty()) else {
        return Err(McpInjectError::new(
            "Cannot inject MCP config for OpenCode: cwd is required to write project-local .opencode/opencode.json but was not provided.",
        ));
    };
    if !Path::new(cwd).exists() {
        return Err(McpInjectError::new(format!(
            "Cannot inject MCP config for OpenCode: cwd directory does not exist: {cwd}. Verify the terminal working directory is correct.",
        )));
    }

    let config_path = opencode_config_path(cwd);
    let dir_path = config_path.parent().expect("config path has parent").to_path_buf();

    let acquired = acquire_lock(cwd)?;
    let result = (|| -> Result<(), McpInjectError> {
        let dir_exists = dir_path.exists();
        let file_exists = config_path.exists();

        // Read existing config or start fresh (inside the lock).
        let mut existing_config = serde_json::Value::Object(serde_json::Map::new());
        if file_exists {
            let text = std::fs::read_to_string(&config_path)
                .map_err(|e| McpInjectError::new(e.to_string()))?;
            let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|_| {
                McpInjectError::new(format!(
                    "Cannot inject MCP config: existing {} contains malformed JSON. Please fix or remove the file manually, then retry.",
                    config_path.display()
                ))
            })?;
            if !parsed.is_object() {
                let found = match &parsed {
                    serde_json::Value::Null => "null",
                    serde_json::Value::Array(_) => "array",
                    serde_json::Value::Bool(_) => "boolean",
                    serde_json::Value::Number(_) => "number",
                    serde_json::Value::String(_) => "string",
                    serde_json::Value::Object(_) => unreachable!(),
                };
                return Err(McpInjectError::new(format!(
                    "Cannot inject MCP config: existing {} is not a valid object (found {found}). Expected a JSON object like {{\"mcp\": {{...}}}}. Please fix or remove the file manually, then retry.",
                    config_path.display()
                )));
            }
            existing_config = parsed;
            // `mcp` must be an object if present (`cw:355-362`).
            if let Some(mcp) = existing_config.get("mcp") {
                if !mcp.is_null() && !mcp.is_object() {
                    let found = match mcp {
                        serde_json::Value::Array(_) => "array",
                        serde_json::Value::Bool(_) => "boolean",
                        serde_json::Value::Number(_) => "number",
                        serde_json::Value::String(_) => "string",
                        _ => "unknown",
                    };
                    return Err(McpInjectError::new(format!(
                        "Cannot inject MCP config: the \"mcp\" field in {} is not a valid object (found {found}). Expected \"mcp\" to be an object like {{\"freshell\": {{...}}}}. Please fix or remove the file manually, then retry.",
                        config_path.display()
                    )));
                }
            }
        }

        let existing_sidecar = read_sidecar(cwd);

        // User-managed detection (`cw:368-376`).
        let pre_existing_freshell = existing_config
            .get("mcp")
            .and_then(|m| m.get("freshell"))
            .map(|f| !f.is_null())
            .unwrap_or(false);
        let user_managed = pre_existing_freshell
            && match &existing_sidecar {
                None => true,
                Some(sc) => sc.get("createdEntry").and_then(|v| v.as_bool()) == Some(false),
            };

        if !user_managed {
            let server_args = build_mcp_server_command_args(rt, target)?;
            let obj = existing_config.as_object_mut().expect("validated object");
            if !obj.get("mcp").map(|m| m.is_object()).unwrap_or(false) {
                obj.insert("mcp".to_string(), serde_json::json!({}));
            }
            let mut command = vec![serde_json::Value::String("node".to_string())];
            command.extend(server_args.into_iter().map(serde_json::Value::String));
            obj.get_mut("mcp")
                .and_then(|m| m.as_object_mut())
                .expect("mcp object")
                .insert(
                    "freshell".to_string(),
                    serde_json::json!({
                        "type": "local",
                        "command": command,
                    }),
                );
            if !dir_exists {
                std::fs::create_dir_all(&dir_path)
                    .map_err(|e| McpInjectError::new(e.to_string()))?;
            }
            write_json_0600(&config_path, &existing_config)?;
        } else if !dir_exists {
            std::fs::create_dir_all(&dir_path).map_err(|e| McpInjectError::new(e.to_string()))?;
        }

        let created_entry = !pre_existing_freshell;

        // Update sidecar (`cw:400-409`).
        let sidecar = match existing_sidecar {
            Some(mut sc) => {
                let ref_count = sc.get("refCount").and_then(|v| v.as_i64()).unwrap_or(0);
                if let Some(obj) = sc.as_object_mut() {
                    obj.insert("refCount".to_string(), serde_json::json!(ref_count + 1));
                }
                sc
            }
            None => serde_json::json!({
                "managedKey": "freshell",
                "refCount": 1,
                "createdDir": !dir_exists,
                "createdFile": !file_exists,
                "createdEntry": created_entry,
            }),
        };
        write_sidecar(cwd, &sidecar)
    })();
    release_lock(cwd, acquired);
    result?;

    Ok(McpInjection::default())
}

/// `generateMcpInjection` (`cw:252-423`) — ALL FIVE modes (spec §3.2 / success
/// criterion 7); `shell` and unknown modes contribute nothing.
pub fn generate_mcp_injection(
    rt: &dyn McpRuntime,
    mode: &str,
    terminal_id: &str,
    cwd: Option<&str>,
    target: ProviderTarget,
) -> Result<McpInjection, McpInjectError> {
    match mode {
        "claude" => {
            let file_path = write_mcp_config_file(rt, terminal_id, target)?;
            Ok(McpInjection {
                args: vec!["--mcp-config".to_string(), file_path],
                env: BTreeMap::new(),
            })
        }
        "codex" => {
            let server_args = build_mcp_server_command_args(rt, target)?;
            Ok(McpInjection {
                args: codex_inline_toml_args(&server_args),
                env: BTreeMap::new(),
            })
        }
        "gemini" => {
            let file_path = write_mcp_config_file(rt, terminal_id, target)?;
            let mut env = BTreeMap::new();
            env.insert("GEMINI_CLI_SYSTEM_DEFAULTS_PATH".to_string(), file_path);
            Ok(McpInjection {
                args: vec![],
                env,
            })
        }
        "kimi" => {
            let file_path = write_mcp_config_file(rt, terminal_id, target)?;
            Ok(McpInjection {
                args: vec!["--mcp-config-file".to_string(), file_path],
                env: BTreeMap::new(),
            })
        }
        "opencode" => opencode_inject(rt, cwd, target),
        _ => Ok(McpInjection::default()),
    }
}

/// `cleanupMcpConfig` (`cw:429-448`): best-effort tmp-file unlink (claude/
/// gemini/kimi) + opencode sidecar-refcounted config cleanup. Called on
/// terminal exit AND failed spawn (`tr:1491,1605`).
pub fn cleanup_mcp_config(rt: &dyn McpRuntime, terminal_id: &str, mode: &str, cwd: Option<&str>) {
    let tmp_path = tmp_file_path(rt, terminal_id);
    if tmp_path.exists() {
        let _ = std::fs::remove_file(&tmp_path);
    }
    if mode == "opencode" {
        if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
            cleanup_opencode(cwd);
        }
    }
}

/// `cleanupOpenCode` (`cw:450-512`) — best-effort throughout.
fn cleanup_opencode(cwd: &str) {
    let Ok(acquired) = acquire_lock(cwd) else {
        return;
    };
    let _ = (|| -> Result<(), McpInjectError> {
        let Some(sidecar) = read_sidecar(cwd) else {
            return Ok(()); // No sidecar = user-managed; don't touch.
        };
        let ref_count = sidecar.get("refCount").and_then(|v| v.as_i64()).unwrap_or(0);
        if ref_count > 1 {
            let mut updated = sidecar.clone();
            if let Some(obj) = updated.as_object_mut() {
                obj.insert("refCount".to_string(), serde_json::json!(ref_count - 1));
            }
            return write_sidecar(cwd, &updated);
        }

        let config_path = opencode_config_path(cwd);
        let sidecar_path = opencode_sidecar_path(cwd);

        // Pre-existing user entry: never remove it (`cw:470-474`).
        if sidecar.get("createdEntry").and_then(|v| v.as_bool()) == Some(false) {
            let _ = std::fs::remove_file(&sidecar_path);
            return Ok(());
        }

        let config_read = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
        let Some(mut config) = config_read else {
            // Config read failed — just clean up the sidecar (`cw:502-505`).
            let _ = std::fs::remove_file(&sidecar_path);
            return Ok(());
        };
        if let Some(mcp) = config.get_mut("mcp").and_then(|m| m.as_object_mut()) {
            mcp.remove("freshell");
        }
        // `config.mcp ? Object.keys(config.mcp) : []` (`cw:484`) — JS semantics:
        // falsy (missing/null/false/0/"") → []; object/array → own keys; a TRUTHY
        // string → per-UTF-16-unit index keys (verified live in node); truthy
        // number/bool → []. The inject path rejects non-object `mcp`, so the
        // non-object arms are reachable only via external tampering — pinned
        // anyway for byte-fidelity.
        let remaining_mcp_keys = match config.get("mcp") {
            None | Some(serde_json::Value::Null) => 0,
            Some(serde_json::Value::Object(m)) => m.len(),
            Some(serde_json::Value::Array(a)) => a.len(),
            Some(serde_json::Value::String(s)) => s.encode_utf16().count(),
            Some(_) => 0, // number/bool: truthy or falsy, Object.keys(...) is []
        };
        let other_top_level_keys = config
            .as_object()
            .map(|o| o.keys().filter(|k| *k != "mcp").count())
            .unwrap_or(0);
        let created_file = sidecar.get("createdFile").and_then(|v| v.as_bool()) == Some(true);

        if remaining_mcp_keys == 0 && other_top_level_keys == 0 && created_file {
            let _ = std::fs::remove_file(&config_path);
            let _ = std::fs::remove_file(&sidecar_path);
            if sidecar.get("createdDir").and_then(|v| v.as_bool()) == Some(true) {
                if let Some(dir) = config_path.parent() {
                    let _ = std::fs::remove_dir(dir); // may not be empty
                }
            }
        } else {
            write_json_0600(&config_path, &config)?;
            let _ = std::fs::remove_file(&sidecar_path);
        }
        Ok(())
    })();
    release_lock(cwd, acquired);
}

// ===========================================================================
// Tests — §4 goldens G-G1/G-K1/G-X4/G-W1 + opencode merge/refcount/cleanup
// integration (temp dirs), per spec success criteria 4 and 7.
// ===========================================================================
#[cfg(test)]
#[path = "mcp_inject_tests.rs"]
mod tests;

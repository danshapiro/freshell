//! Integration tests for [`crate::mcp_inject`] — §4 goldens G-G1/G-K1/G-X4/G-W1
//! + the opencode merge/refcount/cleanup lifecycle (spec success criteria 4 and 7).
//! Split out to respect the campaign's ≤1K-lines-per-file limit.

use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static SCRATCH_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A unique scratch dir under the OS temp dir (removed on drop).
struct Scratch(PathBuf);
impl Scratch {
    fn new(tag: &str) -> Self {
        let n = SCRATCH_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-mcp-inject-test-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        Scratch(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn str(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Fake runtime with §4-convention values.
struct FakeRt {
    tmp: PathBuf,
    wsl: bool,
    args: Vec<McpServerArg>,
}
impl McpRuntime for FakeRt {
    fn tmp_dir(&self) -> PathBuf {
        self.tmp.clone()
    }
    fn is_wsl_environment(&self) -> bool {
        self.wsl
    }
    fn convert_to_windows_path(&self, linux_path: &str) -> String {
        // Deterministic wslpath -w stand-in: /repo/... → \\wsl.localhost\Ubuntu\repo\...
        format!(
            "\\\\wsl.localhost\\Ubuntu{}",
            linux_path.replace('/', "\\")
        )
    }
    fn server_command_args(&self) -> Result<Vec<McpServerArg>, McpInjectError> {
        Ok(self.args.clone())
    }
}

fn mcp_unix_args() -> Vec<McpServerArg> {
    vec![
        McpServerArg::Literal("--import".to_string()),
        McpServerArg::Path("/repo/node_modules/tsx/dist/loader.mjs".to_string()),
        McpServerArg::Path("/repo/server/mcp/server.ts".to_string()),
    ]
}

fn fake_rt(tmp: &Path, wsl: bool) -> FakeRt {
    FakeRt {
        tmp: tmp.to_path_buf(),
        wsl,
        args: mcp_unix_args(),
    }
}

#[test]
fn claude_writes_tmp_json_0600_pretty_two_space() {
    let scratch = Scratch::new("claude");
    let rt = fake_rt(scratch.path(), false);
    let inj =
        generate_mcp_injection(&rt, "claude", "term1", None, ProviderTarget::Unix).unwrap();
    let expected_path = scratch.path().join("freshell-mcp/term1.json");
    assert_eq!(
        inj.args,
        vec![
            "--mcp-config".to_string(),
            expected_path.to_string_lossy().into_owned()
        ]
    );
    assert!(inj.env.is_empty());
    let written = std::fs::read_to_string(&expected_path).unwrap();
    let expected_json = "{\n  \"mcpServers\": {\n    \"freshell\": {\n      \"command\": \"node\",\n      \"args\": [\n        \"--import\",\n        \"/repo/node_modules/tsx/dist/loader.mjs\",\n        \"/repo/server/mcp/server.ts\"\n      ]\n    }\n  }\n}";
    assert_eq!(written, expected_json);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&expected_path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

/// G-G1 — gemini env-only injection.
#[test]
fn g_g1_gemini_env_only_injection() {
    let scratch = Scratch::new("gemini");
    let rt = fake_rt(scratch.path(), false);
    let inj =
        generate_mcp_injection(&rt, "gemini", "term1", None, ProviderTarget::Unix).unwrap();
    assert!(inj.args.is_empty());
    let expected_path = scratch.path().join("freshell-mcp/term1.json");
    assert_eq!(
        inj.env.get("GEMINI_CLI_SYSTEM_DEFAULTS_PATH").map(String::as_str),
        Some(expected_path.to_string_lossy().as_ref())
    );
    assert!(expected_path.is_file());
}

/// G-K1 — kimi `--mcp-config-file` (not claude's `--mcp-config`).
#[test]
fn g_k1_kimi_mcp_config_file_flag() {
    let scratch = Scratch::new("kimi");
    let rt = fake_rt(scratch.path(), false);
    let inj = generate_mcp_injection(&rt, "kimi", "term1", None, ProviderTarget::Unix).unwrap();
    let expected_path = scratch.path().join("freshell-mcp/term1.json");
    assert_eq!(
        inj.args,
        vec![
            "--mcp-config-file".to_string(),
            expected_path.to_string_lossy().into_owned()
        ]
    );
    assert!(inj.env.is_empty());
}

/// G-X4 — codex win32-target via WSL host: UNC-converted, tomlEscape'd pair.
#[test]
fn g_x4_codex_windows_target_on_wsl_unc_toml() {
    let scratch = Scratch::new("codexwsl");
    let rt = fake_rt(scratch.path(), true);
    let inj =
        generate_mcp_injection(&rt, "codex", "term1", None, ProviderTarget::Windows).unwrap();
    assert_eq!(inj.args[0], "-c");
    assert_eq!(inj.args[1], "mcp_servers.freshell.command=\"node\"");
    assert_eq!(inj.args[2], "-c");
    assert_eq!(
        inj.args[3],
        "mcp_servers.freshell.args=[\"--import\", \"\\\\\\\\wsl.localhost\\\\Ubuntu\\\\repo\\\\node_modules\\\\tsx\\\\dist\\\\loader.mjs\", \"\\\\\\\\wsl.localhost\\\\Ubuntu\\\\repo\\\\server\\\\mcp\\\\server.ts\"]"
    );
}

/// Codex unix-target on WSL: NO conversion (`needsWinPaths` false).
#[test]
fn codex_unix_target_on_wsl_keeps_host_paths() {
    let scratch = Scratch::new("codexunix");
    let rt = fake_rt(scratch.path(), true);
    let inj =
        generate_mcp_injection(&rt, "codex", "term1", None, ProviderTarget::Unix).unwrap();
    assert_eq!(
        inj.args[3],
        "mcp_servers.freshell.args=[\"--import\", \"/repo/node_modules/tsx/dist/loader.mjs\", \"/repo/server/mcp/server.ts\"]"
    );
}

/// G-W1's injection half — native-Windows host + `target='unix'` (the WSL
/// branch): NO conversion gate fires (`isWslEnvironment()` false), so the
/// HOST-FORM (Windows) paths ride into the unix-target args verbatim —
/// faithful reference wart (spec §2.6).
#[test]
fn g_w1_native_windows_host_unix_target_keeps_windows_paths() {
    let scratch = Scratch::new("gw1");
    let rt = FakeRt {
        tmp: scratch.path().to_path_buf(),
        wsl: false, // native Windows host: isWslEnvironment() is false
        args: vec![
            McpServerArg::Literal("--import".to_string()),
            McpServerArg::Path("C:\\repo\\node_modules\\tsx\\dist\\loader.mjs".to_string()),
            McpServerArg::Path("C:\\repo\\server\\mcp\\server.ts".to_string()),
        ],
    };
    let inj =
        generate_mcp_injection(&rt, "codex", "term1", None, ProviderTarget::Unix).unwrap();
    assert_eq!(
        inj.args[3],
        "mcp_servers.freshell.args=[\"C:\\\\repo\\\\node_modules\\\\tsx\\\\dist\\\\loader.mjs\", \"C:\\\\repo\\\\server\\\\mcp\\\\server.ts\"]"
            .replace("args=[\"C", "args=[\"--import\", \"C")
    );
}

/// Claude windows-target on WSL host returns the UNC-converted path.
#[test]
fn claude_windows_target_on_wsl_returns_unc_path() {
    let scratch = Scratch::new("claudewsl");
    let rt = fake_rt(scratch.path(), true);
    let inj =
        generate_mcp_injection(&rt, "claude", "term1", None, ProviderTarget::Windows).unwrap();
    assert_eq!(inj.args[0], "--mcp-config");
    assert!(inj.args[1].starts_with("\\\\wsl.localhost\\Ubuntu"));
    assert!(inj.args[1].ends_with("term1.json"));
}

/// shell/unknown modes contribute nothing.
#[test]
fn shell_and_unknown_modes_are_empty() {
    let scratch = Scratch::new("none");
    let rt = fake_rt(scratch.path(), false);
    for mode in ["shell", "mystery"] {
        let inj =
            generate_mcp_injection(&rt, mode, "term1", None, ProviderTarget::Unix).unwrap();
        assert_eq!(inj, McpInjection::default());
    }
}

/// Opencode error goldens (G-O4's cw half): missing + nonexistent cwd.
#[test]
fn opencode_cwd_errors() {
    let scratch = Scratch::new("occwd");
    let rt = fake_rt(scratch.path(), false);
    let err = generate_mcp_injection(&rt, "opencode", "term1", None, ProviderTarget::Unix)
        .unwrap_err();
    assert!(err.message.contains("cwd is required"), "{}", err.message);
    let missing = scratch.path().join("does-not-exist");
    let err2 = generate_mcp_injection(
        &rt,
        "opencode",
        "term1",
        Some(missing.to_string_lossy().as_ref()),
        ProviderTarget::Unix,
    )
    .unwrap_err();
    assert!(
        err2.message.contains("cwd directory does not exist"),
        "{}",
        err2.message
    );
}

/// Opencode fresh merge: config + sidecar created; refcount across two
/// spawns; cleanup decrements then removes everything it created.
#[test]
fn opencode_merge_refcount_and_cleanup_lifecycle() {
    let scratch = Scratch::new("oclife");
    let ws = Scratch::new("oclife-ws");
    let rt = fake_rt(scratch.path(), false);
    let cwd = ws.str();

    // Spawn 1: creates dir/file/entry, refCount 1.
    let inj =
        generate_mcp_injection(&rt, "opencode", "t1", Some(&cwd), ProviderTarget::Unix)
            .unwrap();
    assert_eq!(inj, McpInjection::default());
    let config_path = opencode_config_path(&cwd);
    let config: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(
        config["mcp"]["freshell"]["type"],
        serde_json::json!("local")
    );
    assert_eq!(
        config["mcp"]["freshell"]["command"],
        serde_json::json!([
            "node",
            "--import",
            "/repo/node_modules/tsx/dist/loader.mjs",
            "/repo/server/mcp/server.ts"
        ])
    );
    let sidecar = read_sidecar(&cwd).unwrap();
    assert_eq!(sidecar["refCount"], serde_json::json!(1));
    assert_eq!(sidecar["createdEntry"], serde_json::json!(true));
    assert_eq!(sidecar["createdFile"], serde_json::json!(true));
    // Lock released.
    assert!(!opencode_lock_path(&cwd).exists());

    // Spawn 2: refCount 2.
    generate_mcp_injection(&rt, "opencode", "t2", Some(&cwd), ProviderTarget::Unix).unwrap();
    assert_eq!(read_sidecar(&cwd).unwrap()["refCount"], serde_json::json!(2));

    // Cleanup 1: decrement only.
    cleanup_mcp_config(&rt, "t2", "opencode", Some(&cwd));
    assert_eq!(read_sidecar(&cwd).unwrap()["refCount"], serde_json::json!(1));
    assert!(config_path.exists());

    // Cleanup 2: created-by-freshell file with only the freshell entry —
    // file + sidecar removed. The `.opencode` DIR remains (empty): the
    // reference's `fs.rmdirSync` runs while the lock file still exists
    // (releaseLock is in the `finally`, `cw:490-495,506-509`), so the
    // rmdir always fails ENOTEMPTY and is swallowed — faithful wart.
    cleanup_mcp_config(&rt, "t1", "opencode", Some(&cwd));
    assert!(!config_path.exists());
    assert!(!opencode_sidecar_path(&cwd).exists());
    let dir = config_path.parent().unwrap();
    assert!(dir.exists(), "reference leaves the empty .opencode dir behind");
    assert_eq!(std::fs::read_dir(dir).unwrap().count(), 0, "dir is empty");
}

/// Pre-existing user-managed `mcp.freshell` entries are left untouched by
/// inject AND cleanup (`cw:368-394,470-474`).
#[test]
fn opencode_user_managed_entry_untouched() {
    let scratch = Scratch::new("ocuser");
    let ws = Scratch::new("ocuser-ws");
    let rt = fake_rt(scratch.path(), false);
    let cwd = ws.str();
    let config_path = opencode_config_path(&cwd);
    std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
    let user_config = "{\n  \"mcp\": {\n    \"freshell\": {\n      \"type\": \"local\",\n      \"command\": [\n        \"my-own-server\"\n      ]\n    }\n  }\n}";
    std::fs::write(&config_path, user_config).unwrap();

    generate_mcp_injection(&rt, "opencode", "t1", Some(&cwd), ProviderTarget::Unix).unwrap();
    // Config untouched; sidecar tracks createdEntry=false.
    assert_eq!(std::fs::read_to_string(&config_path).unwrap(), user_config);
    let sidecar = read_sidecar(&cwd).unwrap();
    assert_eq!(sidecar["createdEntry"], serde_json::json!(false));

    cleanup_mcp_config(&rt, "t1", "opencode", Some(&cwd));
    // Entry still present; sidecar removed.
    assert_eq!(std::fs::read_to_string(&config_path).unwrap(), user_config);
    assert!(!opencode_sidecar_path(&cwd).exists());
}

/// Merge preserves other config keys; cleanup rewrites without freshell.
#[test]
fn opencode_merge_preserves_other_keys_and_cleanup_rewrites() {
    let scratch = Scratch::new("ocother");
    let ws = Scratch::new("ocother-ws");
    let rt = fake_rt(scratch.path(), false);
    let cwd = ws.str();
    let config_path = opencode_config_path(&cwd);
    std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
    std::fs::write(
        &config_path,
        "{\n  \"theme\": \"dark\",\n  \"mcp\": {\n    \"other\": {\n      \"type\": \"local\"\n    }\n  }\n}",
    )
    .unwrap();

    generate_mcp_injection(&rt, "opencode", "t1", Some(&cwd), ProviderTarget::Unix).unwrap();
    let merged: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(merged["theme"], serde_json::json!("dark"));
    assert!(merged["mcp"]["other"].is_object());
    assert!(merged["mcp"]["freshell"].is_object());
    // Key order preserved: theme before mcp (JS object insertion order).
    let text = std::fs::read_to_string(&config_path).unwrap();
    assert!(text.find("\"theme\"").unwrap() < text.find("\"mcp\"").unwrap());

    cleanup_mcp_config(&rt, "t1", "opencode", Some(&cwd));
    let after: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert_eq!(after["theme"], serde_json::json!("dark"));
    assert!(after["mcp"]["other"].is_object());
    assert!(after["mcp"].get("freshell").is_none());
    assert!(!opencode_sidecar_path(&cwd).exists());
}

/// Malformed / non-object / bad-mcp configs raise the reference errors.
#[test]
fn opencode_invalid_existing_config_errors() {
    let scratch = Scratch::new("ocbad");
    let rt = fake_rt(scratch.path(), false);
    let cases = [
        ("not json {", "contains malformed JSON"),
        ("[1,2]", "is not a valid object (found array)"),
        ("null", "is not a valid object (found null)"),
        ("42", "is not a valid object (found number)"),
        ("{\"mcp\": \"nope\"}", "\"mcp\" field"),
    ];
    for (contents, expected) in cases {
        let ws = Scratch::new("ocbad-ws");
        let cwd = ws.str();
        let config_path = opencode_config_path(&cwd);
        std::fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        std::fs::write(&config_path, contents).unwrap();
        let err =
            generate_mcp_injection(&rt, "opencode", "t1", Some(&cwd), ProviderTarget::Unix)
                .unwrap_err();
        assert!(
            err.message.contains(expected),
            "contents {contents:?}: {}",
            err.message
        );
        // Lock must have been released even on the error path.
        assert!(!opencode_lock_path(&cwd).exists());
    }
}

/// Failed-spawn parity: cleanup after a claude injection removes the tmp
/// file (`tr:1605`).
#[test]
fn cleanup_removes_claude_tmp_file() {
    let scratch = Scratch::new("cleanup");
    let rt = fake_rt(scratch.path(), false);
    generate_mcp_injection(&rt, "claude", "term9", None, ProviderTarget::Unix).unwrap();
    let path = scratch.path().join("freshell-mcp/term9.json");
    assert!(path.is_file());
    cleanup_mcp_config(&rt, "term9", "claude", None);
    assert!(!path.exists());
}

/// A held (fresh) lock blocks; a stale lock is broken.
#[test]
fn lock_contention_and_stale_lock() {
    let ws = Scratch::new("lock-ws");
    let cwd = ws.str();
    let lock_path = opencode_lock_path(&cwd);
    std::fs::create_dir_all(lock_path.parent().unwrap()).unwrap();
    std::fs::write(&lock_path, "999999").unwrap();
    // Fresh foreign lock → 5 retries then the reference-exact error.
    let err = acquire_lock(&cwd).unwrap_err();
    assert!(
        err.message.contains("Failed to acquire lock at") && err.message.contains("after 5 retries"),
        "{}",
        err.message
    );
    // Make it stale (mtime > 30s ago) → broken and re-acquired.
    let old = filetime_set_old(&lock_path);
    assert!(old, "failed to age the lock file");
    assert!(acquire_lock(&cwd).unwrap());
    release_lock(&cwd, true);
}

/// Age a file's mtime by touching it with an old timestamp (no external
/// crates: uses `std::fs::File::set_times` where available, else `utimes`
/// via the `touch -d`-free fallback of rewriting metadata is unavailable —
/// so use `set_modified` (Rust 1.75+)).
fn filetime_set_old(path: &Path) -> bool {
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
    let f = std::fs::OpenOptions::new().write(true).open(path);
    match f {
        Ok(f) => f.set_modified(old).is_ok(),
        Err(_) => false,
    }
}

/// U1 ratification condition (council 2026-07-13): outside any freshell repo
/// checkout with no tsx installed, the REAL runtime raises the reference-exact
/// `resolveDependencyPath` error prefix (`cw:72-79`) instead of silently
/// injecting a bogus path.
#[test]
fn real_runtime_tsx_unresolvable_raises_reference_error() {
    let scratch = Scratch::new("tsxmissing");
    let prev = std::env::current_dir().unwrap();
    // Serialize against other cwd-sensitive tests via a best-effort chdir guard.
    std::env::set_current_dir(scratch.path()).unwrap();
    let result = RealMcpRuntime.server_command_args();
    std::env::set_current_dir(prev).unwrap();
    let err = result.unwrap_err();
    assert_eq!(
        err.message,
        "Unable to resolve MCP dependency \"tsx\". Ensure project dependencies are installed."
    );
}

//! §4 golden argv tests (`port/machine/specs/cli-argv-fidelity.md`) for
//! [`crate::cli_launch`] — split out to respect the ≤1K-lines-per-file limit.

use super::*;
use crate::detect::HostOs;
use crate::spawn::{build_windows_cli_spawn_spec, quote_powershell_literal, ShellType};

/// `CLAUDE_SETTINGS_UNIX` (§4 conventions) — exact compact-JSON bytes.
const CLAUDE_SETTINGS_UNIX: &str = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"sh -lc \"printf '\\a' > /dev/tty 2>/dev/null || true\""}]}]}}"#;

/// `CLAUDE_SETTINGS_WIN` — compact JSON of the windows bell string
/// (`'\\.\CONOUT$'` appears in JSON as `'\\\\.\\CONOUT$'`).
const CLAUDE_SETTINGS_WIN: &str = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"$bell=[char]7; $ok=$false; try {[System.IO.File]::AppendAllText('\\\\.\\CONOUT$', [string]$bell); $ok=$true} catch {}; if (-not $ok) { try {[Console]::Out.Write($bell); $ok=$true} catch {} }; if (-not $ok) { try {[Console]::Error.Write($bell)} catch {} }\""}]}]}}"#;

/// Dev-mode MCP server args (`MCP_UNIX`, §4 conventions).
const MCP_UNIX: &[&str] = &[
    "--import",
    "/repo/node_modules/tsx/dist/loader.mjs",
    "/repo/server/mcp/server.ts",
];

struct MapEnv(BTreeMap<String, String>);
impl crate::Env for MapEnv {
    fn get(&self, key: &str) -> Option<String> {
        self.0.get(key).cloned()
    }
}
fn env_of(pairs: &[(&str, &str)]) -> MapEnv {
    MapEnv(
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    )
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

/// The shipped manifests, compiled exactly as `server/index.ts:231-255`.
fn specs() -> Vec<CliCommandSpec> {
    vec![
        CliCommandSpec {
            name: "claude".into(),
            label: "Claude CLI".into(),
            env_var: Some("CLAUDE_CMD".into()),
            default_cmd: "claude".into(),
            resume_args: Some(s(&["--resume", "{{sessionId}}"])),
            create_session_args: Some(s(&["--session-id", "{{sessionId}}"])),
            permission_mode_args: Some(s(&["--permission-mode", "{{permissionMode}}"])),
            ..Default::default()
        },
        CliCommandSpec {
            name: "codex".into(),
            label: "Codex CLI".into(),
            env_var: Some("CODEX_CMD".into()),
            default_cmd: "codex".into(),
            resume_args: Some(s(&["resume", "{{sessionId}}"])),
            model_args: Some(s(&["--model", "{{model}}"])),
            sandbox_args: Some(s(&["--sandbox", "{{sandbox}}"])),
            ..Default::default()
        },
        CliCommandSpec {
            name: "opencode".into(),
            label: "OpenCode".into(),
            env_var: Some("OPENCODE_CMD".into()),
            default_cmd: "opencode".into(),
            resume_args: Some(s(&["--session", "{{sessionId}}"])),
            model_args: Some(s(&["--model", "{{model}}"])),
            ..Default::default()
        },
    ]
}

fn claude_inputs<'a>(injection: McpInjection) -> CliLaunchInputs<'a> {
    CliLaunchInputs {
        mode: "claude",
        target: ProviderTarget::Unix,
        resume_session_id: None,
        launch_intent: LaunchIntent::Resume,
        permission_mode: Some("default"),
        model: None,
        sandbox: None,
        codex_remote_ws_url: None,
        opencode_server: None,
        mcp_injection: injection,
    }
}

fn claude_mcp_unix() -> McpInjection {
    McpInjection {
        args: s(&["--mcp-config", "/tmp/freshell-mcp/term1.json"]),
        env: BTreeMap::new(),
    }
}

fn codex_mcp_unix() -> McpInjection {
    McpInjection {
        args: crate::mcp_inject::codex_inline_toml_args(&s(MCP_UNIX)),
        env: BTreeMap::new(),
    }
}

/// Pins the exact byte-level notification constants (U3 executed proof).
#[test]
fn claude_settings_json_bytes_are_pinned() {
    assert_eq!(claude_settings_json(ProviderTarget::Unix), CLAUDE_SETTINGS_UNIX);
    assert_eq!(claude_settings_json(ProviderTarget::Windows), CLAUDE_SETTINGS_WIN);
}

/// G-C1 — claude, linux, fresh, defaults — RESOLVER-LEVEL ONLY (the live path
/// always preallocates a session id; the live fresh golden is G-C3).
#[test]
fn g_c1_claude_linux_fresh_defaults_resolver_level() {
    let launch =
        resolve_coding_cli_command(&specs(), &claude_inputs(claude_mcp_unix()), &env_of(&[]))
            .unwrap()
            .unwrap();
    assert_eq!(launch.command, "claude");
    assert_eq!(
        launch.args,
        vec![
            "--settings".to_string(),
            CLAUDE_SETTINGS_UNIX.to_string(),
            "--mcp-config".to_string(),
            "/tmp/freshell-mcp/term1.json".to_string(),
        ]
    );
    assert!(launch.env.is_empty());
}

/// G-C2 — claude, linux, resume + permissionMode=plan.
#[test]
fn g_c2_claude_resume_permission_mode_plan() {
    let mut inputs = claude_inputs(claude_mcp_unix());
    inputs.resume_session_id = Some("0f9a3b1c-1111-2222-3333-444455556666");
    inputs.permission_mode = Some("plan");
    let launch = resolve_coding_cli_command(&specs(), &inputs, &env_of(&[]))
        .unwrap()
        .unwrap();
    assert_eq!(
        launch.args,
        vec![
            "--settings".to_string(),
            CLAUDE_SETTINGS_UNIX.to_string(),
            "--mcp-config".to_string(),
            "/tmp/freshell-mcp/term1.json".to_string(),
            "--permission-mode".to_string(),
            "plan".to_string(),
            "--resume".to_string(),
            "0f9a3b1c-1111-2222-3333-444455556666".to_string(),
        ]
    );
}

/// G-C3 — claude, linux, start-intent — THE live fresh-claude golden.
#[test]
fn g_c3_claude_start_intent_session_id() {
    let mut inputs = claude_inputs(claude_mcp_unix());
    inputs.resume_session_id = Some("0f9a3b1c-1111-2222-3333-444455556666");
    inputs.launch_intent = LaunchIntent::Start;
    let launch = resolve_coding_cli_command(&specs(), &inputs, &env_of(&[]))
        .unwrap()
        .unwrap();
    assert_eq!(
        launch.args,
        vec![
            "--settings".to_string(),
            CLAUDE_SETTINGS_UNIX.to_string(),
            "--mcp-config".to_string(),
            "/tmp/freshell-mcp/term1.json".to_string(),
            "--session-id".to_string(),
            "0f9a3b1c-1111-2222-3333-444455556666".to_string(),
        ]
    );
}

/// G-C4 — claude, native win32 (target=windows), fresh, defaults; plus the
/// full flattened powershell-branch golden.
#[test]
fn g_c4_claude_native_windows_target() {
    let mut inputs = claude_inputs(McpInjection {
        args: s(&[
            "--mcp-config",
            "C:\\Users\\u\\AppData\\Local\\Temp\\freshell-mcp\\term1.json",
        ]),
        env: BTreeMap::new(),
    });
    inputs.target = ProviderTarget::Windows;
    let launch = resolve_coding_cli_command(&specs(), &inputs, &env_of(&[]))
        .unwrap()
        .unwrap();
    assert_eq!(
        launch.args,
        vec![
            "--settings".to_string(),
            CLAUDE_SETTINGS_WIN.to_string(),
            "--mcp-config".to_string(),
            "C:\\Users\\u\\AppData\\Local\\Temp\\freshell-mcp\\term1.json".to_string(),
        ]
    );

    // Full flattened powershell-branch golden (tr:1237-1244).
    let spec = build_windows_cli_spawn_spec(
        &launch,
        ShellType::Powershell,
        HostOs::Windows,
        false,
        Some("C:\\ws"),
        &env_of(&[]),
        &BTreeMap::new(),
        None,
        None,
    );
    assert_eq!(spec.program, "powershell.exe");
    let expected_invocation = format!(
        "Set-Location -LiteralPath 'C:\\ws'; & 'claude' '--settings' {} '--mcp-config' 'C:\\Users\\u\\AppData\\Local\\Temp\\freshell-mcp\\term1.json'",
        quote_powershell_literal(CLAUDE_SETTINGS_WIN)
    );
    assert_eq!(
        spec.args,
        vec![
            "-NoLogo".to_string(),
            "-NoExit".to_string(),
            "-Command".to_string(),
            expected_invocation,
        ]
    );
    // quotePowerShellLiteral doubled the settings' single quotes around the
    // JSON-escaped CONOUT$ device path.
    assert!(spec.args[3].contains(r"''\\\\.\\CONOUT$''"));
}

fn codex_inputs<'a>(injection: McpInjection) -> CliLaunchInputs<'a> {
    CliLaunchInputs {
        mode: "codex",
        target: ProviderTarget::Unix,
        resume_session_id: None,
        launch_intent: LaunchIntent::Resume,
        permission_mode: None,
        model: None,
        sandbox: None,
        codex_remote_ws_url: None,
        opencode_server: None,
        mcp_injection: injection,
    }
}

/// G-X1 — codex, linux, live path, fresh.
#[test]
fn g_x1_codex_live_fresh() {
    let mut inputs = codex_inputs(codex_mcp_unix());
    inputs.codex_remote_ws_url = Some("ws://127.0.0.1:45012/codex");
    let launch = resolve_coding_cli_command(&specs(), &inputs, &env_of(&[]))
        .unwrap()
        .unwrap();
    assert_eq!(launch.command, "codex");
    assert_eq!(
        launch.args,
        vec![
            "--remote".to_string(),
            "ws://127.0.0.1:45012/codex".to_string(),
            "-c".to_string(),
            "features.apps=false".to_string(),
            "-c".to_string(),
            "tui.notification_method=bel".to_string(),
            "-c".to_string(),
            "tui.notifications=['agent-turn-complete']".to_string(),
            "-c".to_string(),
            r#"mcp_servers.freshell.command="node""#.to_string(),
            "-c".to_string(),
            r#"mcp_servers.freshell.args=["--import", "/repo/node_modules/tsx/dist/loader.mjs", "/repo/server/mcp/server.ts"]"#.to_string(),
        ]
    );
}

/// G-X2 — codex, linux, live path, resume: G-X1 args + resume pair last.
#[test]
fn g_x2_codex_live_resume() {
    let mut fresh = codex_inputs(codex_mcp_unix());
    fresh.codex_remote_ws_url = Some("ws://127.0.0.1:45012/codex");
    let mut expected = resolve_coding_cli_command(&specs(), &fresh, &env_of(&[]))
        .unwrap()
        .unwrap()
        .args;
    expected.push("resume".to_string());
    expected.push("thread-abc123".to_string());

    let mut inputs = codex_inputs(codex_mcp_unix());
    inputs.codex_remote_ws_url = Some("ws://127.0.0.1:45012/codex");
    inputs.resume_session_id = Some("thread-abc123");
    let launch = resolve_coding_cli_command(&specs(), &inputs, &env_of(&[]))
        .unwrap()
        .unwrap();
    assert_eq!(launch.args, expected);
}

/// G-X3 — codex, NO app-server (direct/unit path), model+sandbox set.
#[test]
fn g_x3_codex_no_app_server_model_sandbox() {
    let mut inputs = codex_inputs(codex_mcp_unix());
    inputs.model = Some("gpt-5.1-codex");
    inputs.sandbox = Some("workspace-write");
    let launch = resolve_coding_cli_command(&specs(), &inputs, &env_of(&[]))
        .unwrap()
        .unwrap();
    assert_eq!(
        launch.args,
        vec![
            "-c".to_string(),
            "tui.notification_method=bel".to_string(),
            "-c".to_string(),
            "tui.notifications=['agent-turn-complete']".to_string(),
            "-c".to_string(),
            r#"mcp_servers.freshell.command="node""#.to_string(),
            "-c".to_string(),
            r#"mcp_servers.freshell.args=["--import", "/repo/node_modules/tsx/dist/loader.mjs", "/repo/server/mcp/server.ts"]"#.to_string(),
            "--model".to_string(),
            "gpt-5.1-codex".to_string(),
            "--sandbox".to_string(),
            "workspace-write".to_string(),
        ]
    );
}

/// Success criterion 2: an ALL-segments case — remote + provider + base +
/// settings + resume, in exactly that order.
#[test]
fn all_segments_ordering_is_enforced() {
    let mut all_specs = specs();
    // Give codex a synthetic base arg so every segment is non-empty.
    all_specs
        .iter_mut()
        .find(|sp| sp.name == "codex")
        .unwrap()
        .base_args = s(&["--base-flag"]);
    let mut inputs = codex_inputs(codex_mcp_unix());
    inputs.codex_remote_ws_url = Some("ws://127.0.0.1:1/x");
    inputs.model = Some("m1");
    inputs.sandbox = Some("sb1");
    inputs.resume_session_id = Some("sid1");
    let launch = resolve_coding_cli_command(&all_specs, &inputs, &env_of(&[]))
        .unwrap()
        .unwrap();
    let a = &launch.args;
    let pos = |needle: &str| a.iter().position(|x| x == needle).unwrap();
    assert!(pos("--remote") < pos("tui.notification_method=bel"));
    assert!(pos("tui.notification_method=bel") < pos("--base-flag"));
    assert!(pos("--base-flag") < pos("--model"));
    assert!(pos("--model") < pos("--sandbox"));
    assert!(pos("--sandbox") < pos("resume"));
    assert_eq!(&a[a.len() - 2..], &["resume".to_string(), "sid1".to_string()]);
}

fn opencode_inputs<'a>() -> CliLaunchInputs<'a> {
    CliLaunchInputs {
        mode: "opencode",
        target: ProviderTarget::Unix,
        resume_session_id: None,
        launch_intent: LaunchIntent::Resume,
        permission_mode: None,
        model: None,
        sandbox: None,
        codex_remote_ws_url: None,
        opencode_server: Some(("127.0.0.1", 51234)),
        mcp_injection: McpInjection::default(),
    }
}

/// G-O1 — opencode, linux, fresh, explicit model.
#[test]
fn g_o1_opencode_fresh_explicit_model() {
    let mut inputs = opencode_inputs();
    inputs.model = Some("anthropic/claude-sonnet-4-5");
    let launch = resolve_coding_cli_command(&specs(), &inputs, &env_of(&[]))
        .unwrap()
        .unwrap();
    assert_eq!(
        launch.args,
        vec![
            "--hostname".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            "51234".to_string(),
            "--model".to_string(),
            "anthropic/claude-sonnet-4-5".to_string(),
        ]
    );
    assert!(launch.env.is_empty());
}

/// G-O2 — opencode, fresh, no model, `GEMINI_API_KEY=k1` (env-key default
/// model + GOOGLE_GENERATIVE_AI_API_KEY override).
#[test]
fn g_o2_opencode_gemini_key_default_model_and_env_override() {
    let launch = resolve_coding_cli_command(
        &specs(),
        &opencode_inputs(),
        &env_of(&[("GEMINI_API_KEY", "k1")]),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        launch.args,
        vec![
            "--hostname".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            "51234".to_string(),
            "--model".to_string(),
            "google/gemini-3-pro-preview".to_string(),
        ]
    );
    assert_eq!(
        launch.env.get("GOOGLE_GENERATIVE_AI_API_KEY").map(String::as_str),
        Some("k1")
    );
}

/// Opencode env-key default fallbacks: OPENAI, ANTHROPIC, none.
#[test]
fn opencode_env_key_model_fallbacks() {
    let l1 = resolve_coding_cli_command(
        &specs(),
        &opencode_inputs(),
        &env_of(&[("OPENAI_API_KEY", "x")]),
    )
    .unwrap()
    .unwrap();
    assert!(l1.args.contains(&"openai/gpt-5".to_string()));
    let l2 = resolve_coding_cli_command(
        &specs(),
        &opencode_inputs(),
        &env_of(&[("ANTHROPIC_API_KEY", "x")]),
    )
    .unwrap()
    .unwrap();
    assert!(l2.args.contains(&"anthropic/claude-sonnet-4-5".to_string()));
    let l3 = resolve_coding_cli_command(&specs(), &opencode_inputs(), &env_of(&[]))
        .unwrap()
        .unwrap();
    assert_eq!(l3.args, s(&["--hostname", "127.0.0.1", "--port", "51234"]));
}

/// G-O3 — opencode, resume: model suppressed even when configured.
#[test]
fn g_o3_opencode_resume_suppresses_model() {
    let mut inputs = opencode_inputs();
    inputs.resume_session_id = Some("ses_abc");
    inputs.model = Some("openai/gpt-5");
    let launch =
        resolve_coding_cli_command(&specs(), &inputs, &env_of(&[("OPENAI_API_KEY", "x")]))
            .unwrap()
            .unwrap();
    assert_eq!(
        launch.args,
        vec![
            "--hostname".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            "51234".to_string(),
            "--session".to_string(),
            "ses_abc".to_string(),
        ]
    );
}

/// G-O4 — opencode error goldens: missing/invalid endpoint.
#[test]
fn g_o4_opencode_endpoint_errors() {
    for endpoint in [
        None,
        Some(("127.0.0.1", 0)),
        Some(("127.0.0.1", 70000)),
        Some(("localhost", 1234)),
    ] {
        let mut inputs = opencode_inputs();
        inputs.opencode_server = endpoint;
        let err = resolve_coding_cli_command(&specs(), &inputs, &env_of(&[])).unwrap_err();
        assert_eq!(
            err.message(),
            "OpenCode launch requires an allocated localhost control endpoint."
        );
    }
}

/// G-W2 — codex wsUrl validation goldens (two distinct messages).
#[test]
fn g_w2_codex_ws_url_validation() {
    let cases = [
        (
            "wss://127.0.0.1:1/x",
            "Codex launch requires a loopback app-server websocket URL.",
        ),
        (
            "ws://localhost:1/x",
            "Codex launch requires a loopback app-server websocket URL.",
        ),
        (
            "not-a-url",
            "Codex launch requires a valid loopback app-server websocket URL.",
        ),
    ];
    for (url, expected) in cases {
        let mut inputs = codex_inputs(codex_mcp_unix());
        inputs.codex_remote_ws_url = Some(url);
        let err = resolve_coding_cli_command(&specs(), &inputs, &env_of(&[])).unwrap_err();
        assert_eq!(err.message(), expected, "url: {url}");
    }
}

/// Start-intent without createSessionArgs throws (`tr:310-313`) — codex.
#[test]
fn start_intent_without_create_session_args_throws() {
    let mut inputs = codex_inputs(codex_mcp_unix());
    inputs.resume_session_id = Some("sid");
    inputs.launch_intent = LaunchIntent::Start;
    let err = resolve_coding_cli_command(&specs(), &inputs, &env_of(&[])).unwrap_err();
    assert_eq!(
        err.message(),
        "Fresh Codex CLI launch requires createSessionArgs support."
    );
}

/// `command = env[envVar] || defaultCommand` (truthy: empty override ignored).
#[test]
fn env_var_command_override() {
    let launch = resolve_coding_cli_command(
        &specs(),
        &claude_inputs(claude_mcp_unix()),
        &env_of(&[("CLAUDE_CMD", "/opt/claude-shim")]),
    )
    .unwrap()
    .unwrap();
    assert_eq!(launch.command, "/opt/claude-shim");
    let launch2 = resolve_coding_cli_command(
        &specs(),
        &claude_inputs(claude_mcp_unix()),
        &env_of(&[("CLAUDE_CMD", "")]),
    )
    .unwrap()
    .unwrap();
    assert_eq!(launch2.command, "claude");
}

/// Shell + unregistered modes resolve to None (caller decides the surface).
#[test]
fn shell_and_unknown_modes_resolve_none() {
    let mut shell_inputs = claude_inputs(McpInjection::default());
    shell_inputs.mode = "shell";
    assert_eq!(
        resolve_coding_cli_command(&specs(), &shell_inputs, &env_of(&[])).unwrap(),
        None
    );
    let mut unknown_inputs = claude_inputs(McpInjection::default());
    unknown_inputs.mode = "not-a-cli";
    assert_eq!(
        resolve_coding_cli_command(&specs(), &unknown_inputs, &env_of(&[])).unwrap(),
        None
    );
}

/// The resume template substitutes first-occurrence-only (`index.ts:250-251`),
/// the compiled templates replace-all (`index.ts:100`) — rev 2.1 pin.
#[test]
fn template_substitution_semantics_split() {
    assert_eq!(
        apply_resume_template(&s(&["--x", "{{sessionId}}-{{sessionId}}"]), "S"),
        s(&["--x", "S-{{sessionId}}"])
    );
    assert_eq!(
        apply_template_all(&s(&["--x", "{{model}}-{{model}}"]), "{{model}}", "M"),
        s(&["--x", "M-M"])
    );
}

/// Gemini env-only injection survives to the launch env (G-G1's resolver half).
#[test]
fn gemini_env_injection_passes_through_command_env() {
    let mut all_specs = specs();
    all_specs.push(CliCommandSpec {
        name: "gemini".into(),
        label: "Gemini".into(),
        env_var: Some("GEMINI_CMD".into()),
        default_cmd: "gemini".into(),
        ..Default::default()
    });
    let mut env_map = BTreeMap::new();
    env_map.insert(
        "GEMINI_CLI_SYSTEM_DEFAULTS_PATH".to_string(),
        "/tmp/freshell-mcp/term1.json".to_string(),
    );
    let mut inputs = claude_inputs(McpInjection {
        args: vec![],
        env: env_map,
    });
    inputs.mode = "gemini";
    let launch = resolve_coding_cli_command(&all_specs, &inputs, &env_of(&[]))
        .unwrap()
        .unwrap();
    assert!(launch.args.is_empty());
    assert_eq!(
        launch.env.get("GEMINI_CLI_SYSTEM_DEFAULTS_PATH").map(String::as_str),
        Some("/tmp/freshell-mcp/term1.json")
    );
}

/// G-X0 — the ACTUAL SHIPPED codex live-path argv under deviation DEV-0006
/// (spec §5 U2): `codex_remote_ws_url = None`, no model/sandbox (stripped on the
/// live path), fresh. Pins the deviation's precise byte shape so a future
/// refactor cannot half-emit the `--remote` pair unnoticed (council condition,
/// 2026-07-13). When the codex app-server plan is wired into terminal.create,
/// this golden is REPLACED by G-X1 as the live-path shape.
#[test]
fn g_x0_codex_shipped_deviation_shape_dev_0006() {
    let launch = resolve_coding_cli_command(&specs(), &codex_inputs(codex_mcp_unix()), &env_of(&[]))
        .unwrap()
        .unwrap();
    assert_eq!(launch.command, "codex");
    assert_eq!(
        launch.args,
        vec![
            "-c".to_string(),
            "tui.notification_method=bel".to_string(),
            "-c".to_string(),
            "tui.notifications=['agent-turn-complete']".to_string(),
            "-c".to_string(),
            r#"mcp_servers.freshell.command="node""#.to_string(),
            "-c".to_string(),
            r#"mcp_servers.freshell.args=["--import", "/repo/node_modules/tsx/dist/loader.mjs", "/repo/server/mcp/server.ts"]"#.to_string(),
        ]
    );
    assert!(launch.env.is_empty());
}

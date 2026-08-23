//! §4 golden argv tests (`port/machine/specs/cli-argv-fidelity.md`) for
//! [`crate::cli_launch`] — split out to respect the ≤1K-lines-per-file limit.

use super::*;
use crate::detect::HostOs;
use crate::spawn::{build_windows_cli_spawn_spec, quote_powershell_literal, ShellType};

/// `CLAUDE_SETTINGS_UNIX` (§4 conventions) — exact compact-JSON bytes:
/// `SessionStart` (session-id signal file hook, P4) then `Stop` (bell).
const CLAUDE_SETTINGS_UNIX: &str = r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"sh -lc 'd=\"$HOME/.freshell/session-signals/claude\"; n=$(date +%s%N 2>/dev/null); case \"$n\" in *[!0-9]*|\"\") n=\"$(date +%s)000000000\";; esac; f=\"$d/${FRESHELL_TERMINAL_ID:-unknown}__$n-$$\"; mkdir -p \"$d\" && cat > \"$f.tmp\" && mv \"$f.tmp\" \"$f.json\"' 2>/dev/null || true"}]}],"Stop":[{"hooks":[{"type":"command","command":"sh -lc \"printf '\\a' > /dev/tty 2>/dev/null || true\""}]}]}}"#;

/// `CLAUDE_SETTINGS_WIN` — compact JSON: `SessionStart` (signal file hook,
/// `\` appears in JSON as `\\`) then `Stop` (the windows bell string;
/// `'\\.\CONOUT$'` appears in JSON as `'\\\\.\\CONOUT$'`).
const CLAUDE_SETTINGS_WIN: &str = r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"try { $tid = if ($env:FRESHELL_TERMINAL_ID) { $env:FRESHELL_TERMINAL_ID } else { 'unknown' }; $d = Join-Path $env:USERPROFILE '.freshell\\session-signals\\claude'; New-Item -ItemType Directory -Force -Path $d | Out-Null; $f = Join-Path $d ($tid + '__' + [DateTime]::UtcNow.Ticks); [System.IO.File]::WriteAllText($f + '.tmp', [Console]::In.ReadToEnd()); Move-Item -Force ($f + '.tmp') ($f + '.json') } catch {}\""}]}],"Stop":[{"hooks":[{"type":"command","command":"powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"$bell=[char]7; $ok=$false; try {[System.IO.File]::AppendAllText('\\\\.\\CONOUT$', [string]$bell); $ok=$true} catch {}; if (-not $ok) { try {[Console]::Out.Write($bell); $ok=$true} catch {} }; if (-not $ok) { try {[Console]::Error.Write($bell)} catch {} }\""}]}]}}"#;

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
        opencode_rebind_tui_config: None,
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
    assert_eq!(
        claude_settings_json(ProviderTarget::Unix),
        CLAUDE_SETTINGS_UNIX
    );
    assert_eq!(
        claude_settings_json(ProviderTarget::Windows),
        CLAUDE_SETTINGS_WIN
    );
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
        opencode_rebind_tui_config: None,
    }
}

/// G-X1 — codex, linux, live path, fresh. THE live-path pin since the S5.e
/// flag flip (DEV-0006 closed): managed launches feed `codex_remote_ws_url`,
/// so this is the shape every default codex create resolves to. (G-X0, the
/// shipped-deviation no-remote shape, was retired at the flip.)
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
    assert!(launch.env.is_empty()); // folded from retired G-X0 (S5.e)
}

/// G-X2 — codex, linux, live path, resume: G-X1 args + resume pair last.
/// Live-path pin since the S5.e flip.
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
    assert_eq!(
        &a[a.len() - 2..],
        &["resume".to_string(), "sid1".to_string()]
    );
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
        opencode_rebind_tui_config: None,
    }
}

/// The expected `OPENCODE_TUI_CONFIG` value the goldens pin: built with the
/// PURE `opencode_plugin::tui_config_path` helper (no fs I/O, no installer
/// call — the file-install behavior is pinned by `opencode_plugin`'s own
/// unit tests; the goldens stay hermetic).
fn golden_rebind_tui_config() -> String {
    crate::opencode_plugin::tui_config_path(std::path::Path::new("/golden-home"))
        .display()
        .to_string()
}

/// G-O1 — opencode, linux, fresh, explicit model. Also pins the rebind
/// injection: `OPENCODE_TUI_CONFIG` lands in the env and argv stays
/// byte-identical to the pre-rebind shape (the injection is env-ONLY).
#[test]
fn g_o1_opencode_fresh_explicit_model() {
    let expected_tui_config = golden_rebind_tui_config();
    let mut inputs = opencode_inputs();
    inputs.model = Some("anthropic/claude-sonnet-4-5");
    inputs.opencode_rebind_tui_config = Some(expected_tui_config.clone());
    let launch = resolve_coding_cli_command(&specs(), &inputs, &env_of(&[]))
        .unwrap()
        .unwrap();
    // Byte-identical argv: `--hostname/--port/--model` only, no rebind args.
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
    // Env-only injection: exactly the one key.
    assert_eq!(
        launch.env.get("OPENCODE_TUI_CONFIG").map(String::as_str),
        Some(expected_tui_config.as_str())
    );
    assert_eq!(launch.env.len(), 1);
}

/// G-O2 — opencode, fresh, no model, `GEMINI_API_KEY=k1` — no `--model` is
/// injected (kata 7mtf: the retired env-key heuristic guessed
/// `google/gemini-3-pro-preview`, which outranked opencode's own MRU model);
/// the `GOOGLE_GENERATIVE_AI_API_KEY` env aliasing still applies.
#[test]
fn g_o2_opencode_gemini_key_no_model_with_env_override() {
    let expected_tui_config = golden_rebind_tui_config();
    let mut inputs = opencode_inputs();
    inputs.opencode_rebind_tui_config = Some(expected_tui_config.clone());
    let launch =
        resolve_coding_cli_command(&specs(), &inputs, &env_of(&[("GEMINI_API_KEY", "k1")]))
            .unwrap()
            .unwrap();
    assert_eq!(
        launch.args,
        vec![
            "--hostname".to_string(),
            "127.0.0.1".to_string(),
            "--port".to_string(),
            "51234".to_string(),
        ]
    );
    assert_eq!(
        launch
            .env
            .get("GOOGLE_GENERATIVE_AI_API_KEY")
            .map(String::as_str),
        Some("k1")
    );
    // The rebind injection coexists with the opencode env overrides.
    assert_eq!(
        launch.env.get("OPENCODE_TUI_CONFIG").map(String::as_str),
        Some(expected_tui_config.as_str())
    );
}

/// Kata 7mtf regression — the retired env-key heuristic: a FRESH opencode
/// spawn with NO explicit model must emit no `--model` flag no matter which
/// provider API keys are present. The heuristic sniffed
/// Google/OpenAI/Anthropic keys in the merged `{ parent ∪ commandEnv }` view
/// and injected `google/gemini-3-pro-preview` / `openai/gpt-5` /
/// `anthropic/claude-sonnet-4-5`, which outranked opencode's own MRU model
/// state in every spawned pane. Sweep: no keys, each single key, all keys at
/// once (parent env), and every key delivered through the manifest's
/// `base_env` (the commandEnv half of the merge — the heuristic read the
/// merged view, so both halves of the sweep are load-bearing).
#[test]
fn opencode_fresh_without_explicit_model_never_injects_env_key_model() {
    const PROVIDER_KEYS: [&str; 5] = [
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
    ];
    /// The exact bytes the heuristic used to inject — pinned so the test
    /// names the regression, not just "some flag".
    const GUESSED_MODELS: [&str; 3] = [
        "google/gemini-3-pro-preview",
        "openai/gpt-5",
        "anthropic/claude-sonnet-4-5",
    ];
    let endpoint_only_argv = s(&["--hostname", "127.0.0.1", "--port", "51234"]);
    let assert_no_model = |launch: &CliLaunch, case: &str| {
        assert_eq!(
            launch.args, endpoint_only_argv,
            "{case}: fresh opencode without an explicit model must emit endpoint-only argv",
        );
        assert!(
            !launch.args.iter().any(|a| a == "--model"),
            "{case}: no --model flag allowed"
        );
        for guessed in GUESSED_MODELS {
            assert!(
                !launch.args.iter().any(|a| a == guessed),
                "{case}: heuristic model {guessed} must not appear"
            );
        }
    };

    let mut cases: Vec<(String, Vec<(&str, &str)>)> =
        vec![("no provider keys".to_string(), Vec::new())];
    for key in PROVIDER_KEYS {
        cases.push((format!("only {key}"), vec![(key, "k")]));
    }
    cases.push((
        "every provider key".to_string(),
        PROVIDER_KEYS.map(|k| (k, "k")).to_vec(),
    ));
    for (case, pairs) in cases {
        let launch = resolve_coding_cli_command(&specs(), &opencode_inputs(), &env_of(&pairs))
            .unwrap()
            .unwrap();
        assert_no_model(&launch, &case);
    }

    // commandEnv half of the merged view: provider keys arriving via
    // `spec.base_env` must likewise not produce a model.
    for key in PROVIDER_KEYS {
        let mut all_specs = specs();
        all_specs
            .iter_mut()
            .find(|sp| sp.name == "opencode")
            .unwrap()
            .base_env
            .insert(key.to_string(), "k".to_string());
        let launch = resolve_coding_cli_command(&all_specs, &opencode_inputs(), &env_of(&[]))
            .unwrap()
            .unwrap();
        assert_no_model(&launch, &format!("{key} via base_env"));
    }
}

/// Kata 7mtf passthrough pin: an EXPLICIT model still emits `--model` even
/// with every provider key in the env, and a RESUME emits no `--model` even
/// with an explicit model requested (both pre-existing rules; they must
/// survive the heuristic's removal).
#[test]
fn opencode_model_flag_only_from_explicit_model_on_fresh_launch() {
    let all_keys: Vec<(&str, &str)> = [
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
    ]
    .map(|k| (k, "k"))
    .to_vec();

    // Explicit model + armed env → exact `--model` pair.
    let mut fresh = opencode_inputs();
    fresh.model = Some("provider/model");
    let launch = resolve_coding_cli_command(&specs(), &fresh, &env_of(&all_keys))
        .unwrap()
        .unwrap();
    assert_eq!(
        launch.args,
        s(&[
            "--hostname",
            "127.0.0.1",
            "--port",
            "51234",
            "--model",
            "provider/model"
        ]),
        "explicit model must pass through unchanged with an armed env"
    );

    // Resume + armed env (no explicit model) → no model args at all.
    let mut resume = opencode_inputs();
    resume.resume_session_id = Some("ses_regress");
    let launch = resolve_coding_cli_command(&specs(), &resume, &env_of(&all_keys))
        .unwrap()
        .unwrap();
    assert_eq!(
        launch.args,
        s(&[
            "--hostname",
            "127.0.0.1",
            "--port",
            "51234",
            "--session",
            "ses_regress"
        ]),
        "resume must stay model-free with an armed env"
    );
}

/// G-O3 — opencode, resume: model suppressed even when configured. Rebind
/// injection applies to resumes/restores identically (env-only).
#[test]
fn g_o3_opencode_resume_suppresses_model() {
    let expected_tui_config = golden_rebind_tui_config();
    let mut inputs = opencode_inputs();
    inputs.resume_session_id = Some("ses_abc");
    inputs.model = Some("openai/gpt-5");
    inputs.opencode_rebind_tui_config = Some(expected_tui_config.clone());
    let launch = resolve_coding_cli_command(&specs(), &inputs, &env_of(&[("OPENAI_API_KEY", "x")]))
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
    assert_eq!(
        launch.env.get("OPENCODE_TUI_CONFIG").map(String::as_str),
        Some(expected_tui_config.as_str())
    );
}

/// Rebind skip (a) — the user already set `OPENCODE_TUI_CONFIG` in the
/// process env: a path var cannot be merged, so the resolver must NOT
/// inject at all (the user's raw process-env value passes through to the
/// PTY untouched; no freshell files are forced on the pane).
#[test]
fn opencode_rebind_skips_when_user_tui_config_set() {
    let mut inputs = opencode_inputs();
    inputs.opencode_rebind_tui_config = Some(golden_rebind_tui_config());
    let launch = resolve_coding_cli_command(
        &specs(),
        &inputs,
        &env_of(&[("OPENCODE_TUI_CONFIG", "/their/tui.json")]),
    )
    .unwrap()
    .unwrap();
    assert!(!launch.env.contains_key("OPENCODE_TUI_CONFIG"));
}

/// Rebind skip (b) — the `FRESHELL_OPENCODE_REBIND` kill switch set to `0`
/// or `false` in the merged env skips injection (inverted
/// `merged_env_truthy`-style semantics; opencode self-updates in place, so
/// one env var + a pane restart disables the feature without a release).
#[test]
fn opencode_rebind_kill_switch_skips_injection() {
    for value in ["0", "false"] {
        let mut inputs = opencode_inputs();
        inputs.opencode_rebind_tui_config = Some(golden_rebind_tui_config());
        let launch = resolve_coding_cli_command(
            &specs(),
            &inputs,
            &env_of(&[("FRESHELL_OPENCODE_REBIND", value)]),
        )
        .unwrap()
        .unwrap();
        assert!(
            !launch.env.contains_key("OPENCODE_TUI_CONFIG"),
            "kill switch value: {value}"
        );
    }
}

/// Rebind skip (c) — no precomputed install: the IO layer passes `None`
/// (unresolvable home or install failure) and the resolver injects nothing.
#[test]
fn opencode_rebind_none_input_skips_injection() {
    let inputs = opencode_inputs(); // opencode_rebind_tui_config: None
    let launch = resolve_coding_cli_command(&specs(), &inputs, &env_of(&[]))
        .unwrap()
        .unwrap();
    assert!(!launch.env.contains_key("OPENCODE_TUI_CONFIG"));
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
        launch
            .env
            .get("GEMINI_CLI_SYSTEM_DEFAULTS_PATH")
            .map(String::as_str),
        Some("/tmp/freshell-mcp/term1.json")
    );
}

// ===========================================================================
// Batch E — Amplifier terminal mode. `extensions/amplifier/freshell.json`
// (legacy commit 5aca24c0 "feat: add Amplifier as a freshell CLI agent" —
// content ported by value; NOT reachable from this branch's frozen ancestry,
// see `amplifier_manifest_matches_legacy_cli_block` below) is a plain
// extension-manifest CLI, same shape as gemini/kimi: no model/sandbox/
// permissionMode support, so it gets the same generic resolver treatment —
// `provider_args`/`settings_args` stay empty and only `base_env` +
// `resume_args` + the `envVar` override apply.
fn amplifier_spec() -> CliCommandSpec {
    let mut base_env = BTreeMap::new();
    base_env.insert("PROMPT_TOOLKIT_NO_CPR".to_string(), "1".to_string());
    CliCommandSpec {
        name: "amplifier".into(),
        label: "Amplifier".into(),
        env_var: Some("AMPLIFIER_CMD".into()),
        default_cmd: "amplifier".into(),
        resume_args: Some(s(&["session", "resume", "--full-history", "{{sessionId}}"])),
        base_env,
        ..Default::default()
    }
}

fn amplifier_inputs<'a>(resume_session_id: Option<&'a str>) -> CliLaunchInputs<'a> {
    CliLaunchInputs {
        mode: "amplifier",
        target: ProviderTarget::Unix,
        resume_session_id,
        launch_intent: LaunchIntent::Resume,
        permission_mode: None,
        model: None,
        sandbox: None,
        codex_remote_ws_url: None,
        opencode_server: None,
        mcp_injection: McpInjection::default(),
        opencode_rebind_tui_config: None,
    }
}

/// G-A1 — amplifier, fresh launch (no resume id): base command, no args
/// (no notification/provider_args special-case, matching gemini/kimi), the
/// manifest's `PROMPT_TOOLKIT_NO_CPR` env carried through, manifest label.
#[test]
fn g_a1_amplifier_fresh_launch_matches_manifest() {
    let mut all_specs = specs();
    all_specs.push(amplifier_spec());
    let launch = resolve_coding_cli_command(&all_specs, &amplifier_inputs(None), &env_of(&[]))
        .unwrap()
        .unwrap();
    assert_eq!(launch.command, "amplifier");
    assert!(launch.args.is_empty());
    assert_eq!(
        launch.env.get("PROMPT_TOOLKIT_NO_CPR").map(String::as_str),
        Some("1")
    );
    assert_eq!(launch.label, "Amplifier");
}

/// G-A2 — amplifier full-history resume: `["session", "resume",
/// "--full-history", "<sessionId>"]` from the manifest's `resumeArgs`
/// template (first-occurrence substitution, rev 2.1 pin).
#[test]
fn g_a2_amplifier_resume_appends_resume_args() {
    let mut all_specs = specs();
    all_specs.push(amplifier_spec());
    let launch = resolve_coding_cli_command(
        &all_specs,
        &amplifier_inputs(Some("sess-123")),
        &env_of(&[]),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        launch.args,
        vec![
            "session".to_string(),
            "resume".to_string(),
            "--full-history".to_string(),
            "sess-123".to_string(),
        ]
    );
}

/// G-A3 — `AMPLIFIER_CMD` env override wins over the manifest's default
/// command (`spec.envVar && env[...] || spec.defaultCommand`).
#[test]
fn g_a3_amplifier_env_var_override() {
    let mut all_specs = specs();
    all_specs.push(amplifier_spec());
    let launch = resolve_coding_cli_command(
        &all_specs,
        &amplifier_inputs(None),
        &env_of(&[("AMPLIFIER_CMD", "/custom/amplifier")]),
    )
    .unwrap()
    .unwrap();
    assert_eq!(launch.command, "/custom/amplifier");
}

/// Builds the amplifier spec + inputs with the given `launch_intent` /
/// `resume_session_id` and runs the resolver — the shared shape of the G-A4
/// intent goldens. Flattens the mode-match `Option` (the amplifier spec is
/// always pushed, so `Some` is guaranteed on the `Ok` path).
fn resolve_amplifier_golden_with_intent(
    launch_intent: LaunchIntent,
    resume_session_id: Option<&str>,
) -> Result<CliLaunch, CliLaunchError> {
    let mut all_specs = specs();
    all_specs.push(amplifier_spec());
    let inputs = CliLaunchInputs {
        launch_intent,
        ..amplifier_inputs(resume_session_id)
    };
    resolve_coding_cli_command(&all_specs, &inputs, &env_of(&[]))
        .map(|launch| launch.expect("amplifier spec is present"))
}

/// G-A4 (launcher-assigned amplifier identity): the amplifier spec has
/// resumeArgs ONLY — `LaunchIntent::Start` with a preallocated session id
/// is a hard StartIntentUnsupported error. The WS/REST pre-create paths
/// therefore keep `LaunchIntent::Resume` for fresh amplifier panes
/// (`amplifier session resume --full-history <uuid>` of the pre-created stub
/// IS the fresh launch). This golden pins that requirement so a future "make
/// amplifier look like claude" refactor fails loudly here instead of at
/// runtime.
#[test]
fn g_a4_amplifier_start_intent_without_create_session_args_is_rejected() {
    let err = resolve_amplifier_golden_with_intent(
        LaunchIntent::Start,
        Some("11111111-2222-3333-4444-555555555555"),
    )
    .unwrap_err();
    assert!(
        format!("{err:?}").contains("StartIntentUnsupported")
            || format!("{err}").contains("createSessionArgs"),
        "expected StartIntentUnsupported, got: {err:?}"
    );
}

/// G-A4b: with Resume intent the SAME inputs resolve to
/// `amplifier session resume --full-history <id>` (the manifest resumeArgs
/// template).
#[test]
fn g_a4b_amplifier_resume_intent_with_preallocated_id_resolves_resume_argv() {
    let cli = resolve_amplifier_golden_with_intent(
        LaunchIntent::Resume,
        Some("11111111-2222-3333-4444-555555555555"),
    )
    .unwrap();
    assert_eq!(
        cli.args,
        vec![
            "session",
            "resume",
            "--full-history",
            "11111111-2222-3333-4444-555555555555",
        ]
    );
}

/// The amplifier extension manifest (`extensions/amplifier/freshell.json`) is
/// the single source of truth for its launch behavior — this crate never
/// hardcodes a `CliCommandSpec` for it; `freshell-server`'s
/// `ExtensionRegistry::cli_command_specs()` (`crates/freshell-server/src/
/// extensions.rs:246-267`) compiles the manifest's `cli` block into exactly
/// the [`amplifier_spec`] shape above (mirroring `server/index.ts:231-255`
/// for every other shipped CLI). Before this manifest file existed, this test
/// failed on the missing-file `read_to_string` error (verified RED: `find
/// extensions -iname '*amplifier*'` returned nothing in this branch prior to
/// this commit — the manifest content itself is from legacy commit 5aca24c0
/// "feat: add Amplifier as a freshell CLI agent" on `origin/main`, which is
/// NOT reachable from this branch's frozen ancestry). Pins the manifest
/// against silent drift now that it exists.
#[test]
fn amplifier_manifest_matches_legacy_cli_block() {
    let manifest_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../extensions/amplifier/freshell.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .unwrap_or_else(|e| panic!("missing amplifier manifest at {manifest_path:?}: {e}"));
    let json: serde_json::Value = serde_json::from_str(&raw).expect("manifest must be valid JSON");
    assert_eq!(json["name"], "amplifier");
    assert_eq!(json["category"], "cli");
    let cli = &json["cli"];
    assert_eq!(cli["command"], "amplifier");
    assert_eq!(cli["envVar"], "AMPLIFIER_CMD");
    assert_eq!(
        cli["resumeArgs"],
        serde_json::json!(["session", "resume", "--full-history", "{{sessionId}}"])
    );
    assert_eq!(
        cli["env"],
        serde_json::json!({ "PROMPT_TOOLKIT_NO_CPR": "1" })
    );
}

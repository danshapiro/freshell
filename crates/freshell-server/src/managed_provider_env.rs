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

pub(super) fn managed_provider_env(
    mode: &str,
    source: &std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    let mut env = managed_env_allowlist(source);
    // Never persist the web host's PATH into a pinned workload image. It may
    // contain host-only homes, version-manager shims, or credential helpers.
    env.insert("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into());
    // Temporary files belong to the workload's bounded mount, not the web host.
    env.insert("TMPDIR".into(), "/tmp".into());
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
    env.insert(
        "AMPLIFIER_HOME".into(),
        "/home/freshell/provider/.amplifier".into(),
    );
    env.insert(
        "FRESHELL_AMPLIFIER_HOME".into(),
        "/home/freshell/provider/.amplifier".into(),
    );
    if mode == "opencode" {
        env.insert("TMPDIR".into(), "/run/opencode-tmp".into());
        if let Some(value) = source
            .get("FRESHELL_OPENCODE_REBIND")
            .filter(|value| matches!(value.as_str(), "0" | "false"))
        {
            env.insert("FRESHELL_OPENCODE_REBIND".into(), value.clone());
        }
        // Arbitrary inline JSON can carry credentials in values such as MCP
        // command arguments. It is staged beside the private incarnation grant,
        // never serialized into the supervisor's durable launch environment.
        if let Some(permission) = source
            .get("FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION")
            .map(String::as_str)
            .filter(|value| matches!(*value, "ask" | "allow" | "deny"))
        {
            env.insert(
                "FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION".into(),
                permission.into(),
            );
        }
    }
    env
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
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert_eq!(
            env.get("TMPDIR").map(String::as_str),
            Some("/run/opencode-tmp")
        );
        assert!(!env.contains_key("OPENCODE_TUI_CONFIG"));
        assert!(!env.contains_key("OPENCODE_API_KEY"));
        assert!(!env.values().any(|value| value.contains("do-not-persist")));
    }

    #[test]
    fn managed_opencode_inline_plugin_configuration_is_child_only() {
        let source = std::collections::BTreeMap::from([
            (
                "OPENCODE_CONFIG_CONTENT".into(),
                r#"{"plugin":["file:///workspace/plugin.ts"],"snapshot":true,"maxTokens":8192}"#
                    .into(),
            ),
            ("FRESHELL_OPENCODE_REBIND".into(), "0".into()),
        ]);
        let env = managed_provider_env("opencode", &source);
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert_eq!(
            env.get("FRESHELL_OPENCODE_REBIND").map(String::as_str),
            Some("0")
        );
    }

    #[test]
    fn managed_opencode_does_not_filter_inline_json_by_field_name() {
        let source = std::collections::BTreeMap::from([(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"plugin":["file:///workspace/plugin.ts"],"provider":{"apiKey":"raw-secret","model":"ordinary-model"}}"#.into(),
        )]);
        let env = managed_provider_env("opencode", &source);
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert!(!env.values().any(|value| value.contains("raw-secret")));
    }

    #[test]
    fn managed_opencode_never_persists_nested_inline_secret_values() {
        let source = std::collections::BTreeMap::from([(
            "OPENCODE_CONFIG_CONTENT".into(),
            r#"{"mcp":{"vendor":{"type":"local","command":["tool","--token","nested-secret-byte"]}},"provider":{"endpoint":"https://nested-secret-byte.example"}}"#.into(),
        )]);
        let env = managed_provider_env("opencode", &source);
        let serialized = serde_json::to_string(&env).unwrap();
        assert!(!serialized.contains("nested-secret-byte"));
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
    }

    #[test]
    fn managed_opencode_permission_policy_is_sanitized_and_persistable() {
        for allowed in ["ask", "allow", "deny"] {
            let source = std::collections::BTreeMap::from([(
                "FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION".to_string(),
                allowed.to_string(),
            )]);
            let env = managed_provider_env("opencode", &source);
            assert_eq!(
                env.get("FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION")
                    .map(String::as_str),
                Some(allowed)
            );
        }

        let source = std::collections::BTreeMap::from([(
            "FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION".to_string(),
            "ask-with-secret-text".to_string(),
        )]);
        let env = managed_provider_env("opencode", &source);
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert!(!env.values().any(|value| value.contains("secret-text")));
    }

    #[test]
    fn managed_opencode_bash_policy_preserves_other_ordinary_permissions() {
        let source = std::collections::BTreeMap::from([
            (
                "OPENCODE_CONFIG_CONTENT".into(),
                r#"{"permission":{"read":"allow"}}"#.into(),
            ),
            (
                "FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION".into(),
                "ask".into(),
            ),
        ]);
        let env = managed_provider_env("opencode", &source);
        assert!(!env.contains_key("OPENCODE_CONFIG_CONTENT"));
        assert_eq!(
            env.get("FRESHELL_MANAGED_OPENCODE_BASH_PERMISSION")
                .map(String::as_str),
            Some("ask")
        );
    }

    const TEMP_CHILD: &str = "FRESHELL_TEST_MANAGED_TEMP_CHILD";

    fn run_temp_child_if_requested() -> bool {
        let Ok(expected_parent) = std::env::var(TEMP_CHILD) else {
            return false;
        };
        // Use the same default-tempdir operation as exact-resume config refresh.
        let stage = tempfile::tempdir().expect("create staging directory in the child namespace");
        assert_eq!(
            stage.path().parent(),
            Some(std::path::Path::new(&expected_parent))
        );
        let path = stage.path().to_path_buf();
        let config = path.join("provider-config.json");
        std::fs::write(&config, b"temporary provider configuration").unwrap();
        assert_eq!(
            std::fs::read(&config).unwrap(),
            b"temporary provider configuration"
        );
        stage.close().unwrap();
        assert!(!path.exists(), "staging directory must be cleaned up");
        println!("temporary staging operation completed");
        true
    }

    fn temp_child(test: &str, env: &std::collections::BTreeMap<String, String>, parent: &str) {
        let (_, test) = test.split_once("::").unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .env_clear()
            .envs(env)
            .env(TEMP_CHILD, parent)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "child staging operation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout)
            .contains("temporary staging operation completed"));
    }

    #[test]
    fn managed_tempdir_is_writable_without_the_outer_host_temp_mount() {
        if run_temp_child_if_requested() {
            return;
        }
        let fixture = tempfile::tempdir().unwrap();
        let outside = std::env::var("FRESHELL_TEST_OUTER_TMPDIR").unwrap_or_else(|_| {
            fixture
                .path()
                .join("outer-host-only")
                .to_string_lossy()
                .into_owned()
        });
        assert!(
            !std::path::Path::new(&outside).exists(),
            "outer host path must be absent in this namespace"
        );
        let source = std::collections::BTreeMap::from([("TMPDIR".into(), outside)]);
        for mode in ["codex", "claude", "amplifier", "shell"] {
            temp_child(
                concat!(
                    module_path!(),
                    "::managed_tempdir_is_writable_without_the_outer_host_temp_mount"
                ),
                &managed_provider_env(mode, &source),
                "/tmp",
            );
        }
    }

    #[test]
    fn ordinary_child_keeps_its_requested_temporary_directory() {
        if run_temp_child_if_requested() {
            return;
        }
        let outer = tempfile::tempdir().unwrap();
        let path = outer.path().to_string_lossy().into_owned();
        let source = std::collections::BTreeMap::from([("TMPDIR".into(), path.clone())]);
        temp_child(
            concat!(
                module_path!(),
                "::ordinary_child_keeps_its_requested_temporary_directory"
            ),
            &source,
            &path,
        );
    }
}

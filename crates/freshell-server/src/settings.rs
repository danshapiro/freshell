//! Default `ServerSettings` modeling + the isolated-HOME config overlay.
//!
//! Ground truth is `port/oracle/fixtures/handshake-transcript.json` (a real
//! `settings.updated` payload captured from the ORIGINAL node server), which the
//! `handshake_settings` test pins byte-for-byte. Cross-checked against
//! `shared/settings.ts#createDefaultServerSettings`.
//!
//! The single field the oracle's isolated boot changes from the pure default is
//! `network.configured` (the E2E `TestServer` pre-seeds
//! `<HOME>/.freshell/config.json` with `network:{configured:true,host:'127.0.0.1'}`
//! so the setup wizard is bypassed). [`load_server_settings`] reproduces that by
//! overlaying the persisted `settings.network` — exactly what
//! `configStore.getSettings()` returns to the original's handshake provider.

use std::path::Path;

use freshell_protocol::{
    DefaultNewPane, ExternalEditor, NetworkHost, ServerSettings, SettingsAi, SettingsCodingCli,
    SettingsEditor, SettingsExtensions, SettingsFreshAgent, SettingsLogging, SettingsNetwork,
    SettingsPanes, SettingsSafety, SettingsSidebar, SettingsTerminal,
};
use serde_json::json;

/// The default server-settings tree, 1:1 with
/// `shared/settings.ts#createDefaultServerSettings()`.
///
/// Notes on the two fields that look "computed":
/// * `codingCli.knownProviders` is `[]` — the original seeds it from the set of
///   CLI *extensions* discovered at boot; the oracle's isolated runtime root
///   ships no `extensions/` dir, so that set is empty (see `server/index.ts`
///   knownProviders migration).
/// * `network.configured` defaults to `false` here and is overlaid to `true` by
///   [`load_server_settings`] when the isolated config pre-seeds it.
pub fn default_server_settings() -> ServerSettings {
    ServerSettings {
        ai: SettingsAi {
            gemini_api_key: None,
            title_prompt: None,
        },
        coding_cli: SettingsCodingCli {
            enabled_providers: vec!["claude".to_string(), "codex".to_string(), "opencode".to_string()],
            mcp_server: true,
            providers: json!({ "claude": { "permissionMode": "default" }, "codex": {} }),
            known_providers: Some(Vec::new()),
        },
        editor: SettingsEditor {
            external_editor: ExternalEditor::Auto,
            custom_editor_command: None,
        },
        extensions: SettingsExtensions {
            disabled: Vec::new(),
        },
        fresh_agent: SettingsFreshAgent {
            default_plugins: Vec::new(),
            enabled: false,
            providers: json!({}),
            initial_setup_done: None,
        },
        logging: SettingsLogging { debug: false },
        network: SettingsNetwork {
            configured: false,
            host: NetworkHost::Loopback,
        },
        panes: SettingsPanes {
            default_new_pane: DefaultNewPane::Ask,
        },
        safety: SettingsSafety {
            auto_kill_idle_minutes: 15,
        },
        sidebar: SettingsSidebar {
            auto_generate_titles: true,
            exclude_first_chat_must_start: false,
            exclude_first_chat_substrings: Vec::new(),
        },
        terminal: SettingsTerminal { scrollback: 10000 },
        allowed_file_paths: None,
        default_cwd: None,
    }
}

/// Default settings, overlaid with the persisted `settings.network` from
/// `<home>/.freshell/config.json` (if present). Mirrors the network slice of
/// `mergeServerSettings(defaults, persisted)` for the handshake — the only slice
/// the oracle's pre-seeded config touches. Any read/parse error degrades to the
/// pure default (matching the original's tolerant config load).
pub fn load_server_settings(home: Option<&Path>) -> ServerSettings {
    let mut settings = default_server_settings();

    let Some(home) = home else {
        return settings;
    };
    let config_path = home.join(".freshell").join("config.json");
    let Ok(text) = std::fs::read_to_string(&config_path) else {
        return settings;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return settings;
    };

    if let Some(network) = value.pointer("/settings/network") {
        if let Some(configured) = network.get("configured").and_then(|v| v.as_bool()) {
            settings.network.configured = configured;
        }
        if let Some(host) = network.get("host").and_then(|v| v.as_str()) {
            settings.network.host = match host {
                "0.0.0.0" => NetworkHost::AllInterfaces,
                _ => NetworkHost::Loopback,
            };
        }
    }

    settings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_network_is_unconfigured_loopback() {
        let s = default_server_settings();
        assert_eq!(s.network.configured, false);
        assert_eq!(s.network.host, NetworkHost::Loopback);
    }

    #[test]
    fn config_overlay_sets_configured_true() {
        let dir = std::env::temp_dir().join(format!("freshell-settings-test-{}", std::process::id()));
        let freshell = dir.join(".freshell");
        std::fs::create_dir_all(&freshell).unwrap();
        std::fs::write(
            freshell.join("config.json"),
            r#"{"version":1,"settings":{"network":{"configured":true,"host":"127.0.0.1"}}}"#,
        )
        .unwrap();

        let s = load_server_settings(Some(&dir));
        assert_eq!(s.network.configured, true);
        assert_eq!(s.network.host, NetworkHost::Loopback);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_config_degrades_to_default() {
        let s = load_server_settings(Some(Path::new("/nonexistent-freshell-home-xyz")));
        assert_eq!(s.network.configured, false);
    }

    /// The real acceptance for the settings model: default settings + the
    /// isolated-boot network overlay must serialize BYTE-FOR-BYTE to the
    /// `settings.updated` payload captured from the ORIGINAL node server. If the
    /// original's default tree ever shifts, this fails loudly (a fidelity gap),
    /// not silently under the live oracle.
    #[test]
    fn default_plus_network_overlay_matches_captured_fixture() {
        // The committed real capture: crates/freshell-server -> repo root.
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../port/oracle/fixtures/handshake-transcript.json");
        let text = std::fs::read_to_string(&fixture_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", fixture_path.display()));
        let fixture: serde_json::Value = serde_json::from_str(&text).unwrap();

        let expected_settings = fixture["transcript"]
            .as_array()
            .and_then(|entries| {
                entries
                    .iter()
                    .find(|m| m["type"] == "settings.updated")
                    .map(|m| m["parsed"]["settings"].clone())
            })
            .expect("fixture has a settings.updated message");

        // Reproduce the oracle's isolated boot: pre-seed the network config the
        // E2E TestServer writes, then load settings exactly as the server does.
        let dir = std::env::temp_dir()
            .join(format!("freshell-fixture-test-{}", std::process::id()));
        let freshell = dir.join(".freshell");
        std::fs::create_dir_all(&freshell).unwrap();
        std::fs::write(
            freshell.join("config.json"),
            r#"{"version":1,"settings":{"network":{"configured":true,"host":"127.0.0.1"}}}"#,
        )
        .unwrap();

        let actual = serde_json::to_value(load_server_settings(Some(&dir))).unwrap();
        std::fs::remove_dir_all(&dir).ok();

        assert_eq!(
            actual, expected_settings,
            "Rust default settings + network overlay must equal the captured original settings"
        );
    }
}

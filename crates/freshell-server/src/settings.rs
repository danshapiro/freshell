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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_network_is_unconfigured_loopback() {
        let s = default_server_settings();
        assert_eq!(s.network.configured, false);
        assert_eq!(s.network.host, NetworkHost::Loopback);
    }
}

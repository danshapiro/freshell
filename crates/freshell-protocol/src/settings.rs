//! `ServerSettings` — the payload of the `settings.updated` server message.
//!
//! A closed, deeply-nested tree. `providers` maps are `Record<string, unknown>`
//! and are modeled as `serde_json::Value`; every other field is typed exactly
//! per the frozen schema.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DefaultNewPane {
    Shell,
    Ask,
    Browser,
    Editor,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExternalEditor {
    Custom,
    Code,
    Auto,
    Cursor,
}

/// Network bind host (`127.0.0.1` loopback or `0.0.0.0` all-interfaces).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NetworkHost {
    #[serde(rename = "127.0.0.1")]
    Loopback,
    #[serde(rename = "0.0.0.0")]
    AllInterfaces,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingsLogging {
    pub debug: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSafety {
    pub auto_kill_idle_minutes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingsTerminal {
    pub scrollback: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPanes {
    pub default_new_pane: DefaultNewPane,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSidebar {
    pub auto_generate_titles: bool,
    pub exclude_first_chat_must_start: bool,
    pub exclude_first_chat_substrings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsAi {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gemini_api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_prompt: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsCodingCli {
    pub enabled_providers: Vec<String>,
    pub mcp_server: bool,
    /// `Record<string, ProviderConfig>`.
    pub providers: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_providers: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsEditor {
    pub external_editor: ExternalEditor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_editor_command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFreshAgent {
    pub default_plugins: Vec<String>,
    pub enabled: bool,
    /// `Record<string, ProviderConfig>`.
    pub providers: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_setup_done: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingsExtensions {
    pub disabled: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingsNetwork {
    pub configured: bool,
    pub host: NetworkHost,
}

/// The full server settings object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSettings {
    pub ai: SettingsAi,
    pub coding_cli: SettingsCodingCli,
    pub editor: SettingsEditor,
    pub extensions: SettingsExtensions,
    pub fresh_agent: SettingsFreshAgent,
    pub logging: SettingsLogging,
    pub network: SettingsNetwork,
    pub panes: SettingsPanes,
    pub safety: SettingsSafety,
    pub sidebar: SettingsSidebar,
    pub terminal: SettingsTerminal,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allowed_file_paths: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_cwd: Option<String>,
}

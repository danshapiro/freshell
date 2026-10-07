//! Accepted ordinary Claude source origins. Payloads remain in private files.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Durable argv names this owned selection; its source and declaring origin
/// are recorded in the private accepted manifest, never as raw settings JSON.
pub const MANAGED_SETTINGS_ARGUMENT: &str = ".freshell/claude-selected-settings";

pub fn selected_settings_argument(args: &[String]) -> Option<&str> {
    let mut selected = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--settings" {
            selected = args.get(index + 1).map(String::as_str);
            index += 2;
        } else {
            if let Some(value) = args[index].strip_prefix("--settings=") {
                selected = Some(value);
            }
            index += 1;
        }
    }
    selected
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeInputManifest {
    pub version: u8,
    pub original_home: PathBuf,
    pub cwd: PathBuf,
    pub workspace: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_root: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_file: Option<PathBuf>,
    #[serde(default = "default_setting_sources")]
    pub setting_sources: Vec<ClaudeSettingSource>,
    pub plugin_dirs: Vec<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeSettingSource {
    User,
    Project,
    Local,
}

impl ClaudeSettingSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Project => "project",
            Self::Local => "local",
        }
    }
}

pub fn parse_setting_sources(value: &str) -> Result<Vec<ClaudeSettingSource>, &'static str> {
    if value.len() > 1024 * 1024 || value.chars().any(char::is_control) {
        return Err("Claude setting-sources argument profile exceeded");
    }
    let mut enabled = [false; 3];
    if !value.is_empty() {
        for source in value.split(',') {
            match source.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}') {
                "user" => enabled[0] = true,
                "project" => enabled[1] = true,
                "local" => enabled[2] = true,
                _ => return Err(
                    "Claude setting-sources accepts only user, project, local or an empty selector",
                ),
            }
        }
    }
    Ok(default_setting_sources()
        .into_iter()
        .enumerate()
        .filter_map(|(index, source)| enabled[index].then_some(source))
        .collect())
}

pub fn default_setting_sources() -> Vec<ClaudeSettingSource> {
    vec![
        ClaudeSettingSource::User,
        ClaudeSettingSource::Project,
        ClaudeSettingSource::Local,
    ]
}
impl ClaudeInputManifest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1
            || self.plugin_dirs.len() > crate::provider_input_profiles::MAX_SOURCE_EVENTS
            || self.setting_sources.len() > 3
            || self
                .setting_sources
                .iter()
                .enumerate()
                .any(|(index, source)| self.setting_sources[..index].contains(source))
        {
            return Err("accepted Claude discovery context profile exceeded");
        }
        for path in [&self.original_home, &self.cwd, &self.workspace]
            .into_iter()
            .chain(self.config_root.iter())
            .chain(self.settings_file.iter())
            .chain(&self.plugin_dirs)
        {
            if !path.is_absolute()
                || path.as_os_str().len() > 64 * 1024
                || path.to_string_lossy().chars().any(char::is_control)
            {
                return Err("accepted Claude discovery source path is invalid");
            }
        }
        Ok(())
    }
    pub fn runtime_path(&self, logical: &Path) -> PathBuf {
        if let Some(root) = &self.config_root {
            if let Ok(relative) = logical.strip_prefix(root) {
                return Path::new("/home/freshell/provider/.claude").join(relative);
            }
        }
        crate::codex_inputs::runtime_path(&self.original_home, logical)
    }
    pub fn config_root(&self) -> PathBuf {
        self.config_root
            .clone()
            .unwrap_or_else(|| self.original_home.join(".claude"))
    }
}

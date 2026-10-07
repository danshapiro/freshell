//! Accepted ordinary Claude source origins. Payloads remain in private files.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeInputManifest {
    pub version: u8,
    pub original_home: PathBuf,
    pub cwd: PathBuf,
    pub workspace: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_root: Option<PathBuf>,
    pub plugin_dirs: Vec<PathBuf>,
}
impl ClaudeInputManifest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1
            || self.plugin_dirs.len() > crate::provider_input_profiles::MAX_SOURCE_EVENTS
        {
            return Err("accepted Claude discovery context profile exceeded");
        }
        for path in [&self.original_home, &self.cwd, &self.workspace]
            .into_iter()
            .chain(self.config_root.iter())
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

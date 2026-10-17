//! Accepted original Amplifier origins; payloads remain in private stage files.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AmplifierInputManifest {
    pub version: u8,
    pub original_home: PathBuf,
    pub cwd: PathBuf,
    pub workspace: PathBuf,
}
impl AmplifierInputManifest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1 {
            return Err("accepted Amplifier source manifest version unsupported");
        }
        for path in [&self.original_home, &self.cwd, &self.workspace] {
            if !path.is_absolute()
                || path.as_os_str().len() > 64 * 1024
                || path.to_string_lossy().chars().any(char::is_control)
            {
                return Err("accepted Amplifier discovery source path is invalid");
            }
        }
        Ok(())
    }
    pub fn runtime_path(&self, logical: &Path) -> PathBuf {
        crate::codex_inputs::runtime_path(&self.original_home, logical)
    }
}

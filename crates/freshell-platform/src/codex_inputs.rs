//! Accepted native Codex discovery context. Source contents stay in private
//! stage files; only the finite native source controls travel in metadata.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodexInputManifest {
    pub version: u8,
    pub original_home: PathBuf,
    pub cwd: PathBuf,
    pub codex_home: PathBuf,
    pub named_profile: Option<String>,
}
impl CodexInputManifest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.version != 1
            || [&self.original_home, &self.cwd, &self.codex_home]
                .iter()
                .any(|path| {
                    !path.is_absolute()
                        || path.as_os_str().len() > 64 * 1024
                        || path.to_string_lossy().chars().any(char::is_control)
                })
            || self
                .named_profile
                .as_ref()
                .is_some_and(|name| !valid_profile(name))
        {
            return Err("accepted Codex discovery context is invalid");
        }
        Ok(())
    }
    pub fn runtime_path(&self, logical: &Path) -> PathBuf {
        logical
            .strip_prefix(&self.codex_home)
            .map(|relative| self.runtime_home().join(relative))
            .unwrap_or_else(|_| runtime_path(&self.original_home, logical))
    }
    pub fn runtime_home(&self) -> PathBuf {
        PathBuf::from("/home/freshell/provider/.codex")
    }
}
pub fn valid_profile(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}
pub fn runtime_path(original_home: &Path, logical: &Path) -> PathBuf {
    logical
        .strip_prefix(original_home)
        .map(|relative| Path::new("/home/freshell/provider").join(relative))
        .unwrap_or_else(|_| logical.to_path_buf())
}

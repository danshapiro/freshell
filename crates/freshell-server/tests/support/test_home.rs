//! A temporary home for a test server. Every server boot selects its
//! agent-pane containment for the state root `<home>/.freshell`, and on a host
//! with a systemd user manager the selection probe leaves that state root's
//! namespace slice (`freshell-n<ns>.slice`) in the user manager: implicit
//! slices are never collected. Dropping the home stops that slice (a no-op
//! on hosts without one) before the directory is removed.
#![allow(dead_code)]

use std::path::Path;

pub struct TestHome(Option<tempfile::TempDir>);

impl TestHome {
    pub fn new() -> std::io::Result<Self> {
        tempfile::tempdir().map(|dir| Self(Some(dir)))
    }

    pub fn path(&self) -> &Path {
        self.0.as_ref().expect("the home is live").path()
    }
}

/// The containment crate's rule: `freshell-n` + the first 8 bytes of the
/// SHA-256 of the canonical state root, in hex.
fn namespace_slice(state_root: &Path) -> String {
    use sha2::{Digest, Sha256};
    let canonical = std::fs::canonicalize(state_root).unwrap_or_else(|_| state_root.to_path_buf());
    let digest = Sha256::digest(canonical.as_os_str().as_encoded_bytes());
    let ns: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("freshell-n{ns}.slice")
}

impl Drop for TestHome {
    fn drop(&mut self) {
        let state_root = self.path().join(".freshell");
        if state_root.exists() {
            let _ = std::process::Command::new("systemctl")
                .args(["--user", "stop", &namespace_slice(&state_root)])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        drop(self.0.take());
    }
}

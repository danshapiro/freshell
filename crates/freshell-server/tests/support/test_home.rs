//! A temporary home for a test server. Every server boot selects its
//! agent-pane containment for the state root `<home>/.freshell`; on a host
//! with a systemd user manager, a server that created an agent-pane unit
//! leaves that state root's namespace slice (`freshell-n<ns>.slice`) in the
//! user manager: implicit slices are never collected. Dropping the home stops
//! that slice (a no-op on hosts without one) before the directory is removed.
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

impl Drop for TestHome {
    /// Stops the state root's namespace slice (the containment crate's own
    /// naming rule, within its command deadline), then removes the home.
    fn drop(&mut self) {
        let state_root = self.path().join(".freshell");
        if state_root.exists() {
            freshell_containment::testing::stop_namespace_slice(&state_root);
        }
        drop(self.0.take());
    }
}

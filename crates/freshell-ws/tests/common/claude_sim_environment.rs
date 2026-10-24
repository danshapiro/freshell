//! An isolated production-sidecar environment for tests with custom WS wiring.
//! SDK recording and shutdown live at the query boundary; no wire frames are faked.

use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct ClaudeSimEnvironment {
    dir: PathBuf,
}

impl ClaudeSimEnvironment {
    pub fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("freshell-claude-sdk-{}", uuid::Uuid::new_v4()));
        for child in ["home", "workspace", "tmp"] {
            std::fs::create_dir_all(dir.join(child)).unwrap();
        }
        std::fs::write(dir.join("active"), "").unwrap();
        Self { dir }
    }

    pub fn workspace(&self) -> PathBuf {
        self.dir.join("workspace")
    }

    pub fn config_dir(&self) -> PathBuf {
        self.dir.join("home/.claude")
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// A saved conversation in the native JSONL format, for cold-resume tests.
    pub fn seed_transcript(&self, id: &str) {
        self.seed_transcript_at(id, &self.workspace());
    }

    pub fn seed_transcript_at(&self, id: &str, cwd: &Path) {
        let project = self.config_dir().join("projects/fixture");
        std::fs::create_dir_all(&project).unwrap();
        let row = serde_json::json!({
            "type":"user", "sessionId":id, "uuid":uuid::Uuid::new_v4().to_string(),
            "parentUuid":null, "cwd":cwd, "isSidechain":false,
            "message":{"role":"user", "content":[{"type":"text", "text":"saved conversation"}]}
        });
        std::fs::write(project.join(format!("{id}.jsonl")), format!("{row}\n")).unwrap();
    }

    pub fn environment(&self) -> Vec<(String, String)> {
        let adapter = super::claude_rig::repo_root()
            .join("test/integration/providers/claude-sdk-for-rust-runtime.mjs");
        vec![
            (
                "HOME".into(),
                self.dir.join("home").to_string_lossy().into(),
            ),
            ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
            (
                "TMPDIR".into(),
                self.dir.join("tmp").to_string_lossy().into(),
            ),
            (
                "CLAUDE_CONFIG_DIR".into(),
                self.dir.join("home/.claude").to_string_lossy().into(),
            ),
            (
                "FRESHELL_CLAUDE_SDK_QUERY_MODULE".into(),
                freshell_platform::opencode_plugin::plugin_file_spec(&adapter),
            ),
            (
                "FRESHELL_CLAUDE_SIM_LEDGER".into(),
                self.dir.join("ledger.jsonl").to_string_lossy().into(),
            ),
            ("FRESHELL_CLAUDE_SIM_TIME_SCALE".into(), "0.01".into()),
            (
                "FRESHELL_TEST_CLAUDE_RUNTIME_GUARD".into(),
                self.dir.join("active").to_string_lossy().into(),
            ),
        ]
    }

    pub fn rows(&self, kind: &str) -> Vec<Value> {
        std::fs::read_to_string(self.dir.join("ledger.jsonl"))
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("simulator row"))
            .filter(|row| row["kind"] == kind)
            .collect()
    }
}

impl Drop for ClaudeSimEnvironment {
    fn drop(&mut self) {
        // The shared SDK adapter closes its query when the guard ends or this
        // unique directory disappears; cleanup never needs a PID signal.
        let _ = std::fs::write(self.dir.join("active.stop"), "");
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

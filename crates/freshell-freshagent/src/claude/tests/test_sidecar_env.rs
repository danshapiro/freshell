//! The production sidecar over the contract-tested CLI simulator.

use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

const KEYS: &[&str] = &[
    "FRESHELL_CLAUDE_SIDECAR",
    "FRESHELL_CLAUDE_NODE",
    "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
    "FRESHELL_TEST_CLAUDE_SPAWN_LOG",
    "FRESHELL_TEST_CLAUDE_INTERRUPT_LOG",
    "FRESHELL_TEST_CLAUDE_RESPOND_LOG",
    "FRESHELL_TEST_CLAUDE_DEFER_CREATE_MS",
    "FRESHELL_TEST_CLAUDE_FAIL_CREATE",
    "FRESHELL_TEST_CLAUDE_RUNTIME_GUARD",
    "FRESHELL_TEST_CLAUDE_REJECT_MODEL",
    "FRESHELL_TEST_CLAUDE_REJECT_EFFORT",
    "FRESHELL_CLAUDE_SIM_PROGRAM",
    "FRESHELL_CLAUDE_SIM_TIME_SCALE",
    "FRESHELL_CLAUDE_SIM_LEDGER",
    "CLAUDE_CONFIG_DIR",
];

pub(super) struct ClaudeTestRuntime {
    pub(super) dir: PathBuf,
    spawn_log: PathBuf,
    interrupt_log: PathBuf,
    respond_log: PathBuf,
    previous: Vec<(&'static str, Option<OsString>)>,
}

impl ClaudeTestRuntime {
    pub(super) fn install() -> Self {
        Self::install_with_knobs(None, false)
    }

    pub(super) fn install_with_knobs(defer_create_ms: Option<u64>, fail_create: bool) -> Self {
        let previous = KEYS
            .iter()
            .map(|&key| (key, std::env::var_os(key)))
            .collect();
        let dir = std::env::temp_dir().join(format!(
            "freshell-claude-test-runtime-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create runtime fixture directory");
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap();
        let spawn_log = dir.join("query-options.jsonl");
        let interrupt_log = dir.join("interrupt.log");
        let respond_log = dir.join("requests.jsonl");
        for file in [&spawn_log, &interrupt_log, &respond_log] {
            std::fs::write(file, "").unwrap();
        }
        let guard = dir.join("active");
        std::fs::write(&guard, "").unwrap();
        std::env::set_var(
            "FRESHELL_CLAUDE_SIDECAR",
            root.join("crates/freshell-claude-sidecar/index.mjs"),
        );
        std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
        std::env::set_var(
            "FRESHELL_CLAUDE_SDK_QUERY_MODULE",
            root.join("test/integration/providers/claude-sdk-for-rust-runtime.mjs"),
        );
        std::env::set_var("FRESHELL_TEST_CLAUDE_SPAWN_LOG", &spawn_log);
        std::env::set_var("FRESHELL_TEST_CLAUDE_INTERRUPT_LOG", &interrupt_log);
        std::env::set_var("FRESHELL_TEST_CLAUDE_RESPOND_LOG", &respond_log);
        std::env::set_var("FRESHELL_TEST_CLAUDE_RUNTIME_GUARD", &guard);
        std::env::set_var("FRESHELL_CLAUDE_SIM_LEDGER", dir.join("sim-ledger.jsonl"));
        std::env::set_var("FRESHELL_CLAUDE_SIM_TIME_SCALE", "0.01");
        std::env::set_var("CLAUDE_CONFIG_DIR", dir.join("claude"));
        // Most runtime unit tests inspect an accepted, still-running turn.
        std::env::set_var(
            "FRESHELL_CLAUDE_SIM_PROGRAM",
            json!({"rules":[{"on":"msg:prompt", "emit":[{"kind":"hang"}]}]}).to_string(),
        );
        match defer_create_ms {
            Some(ms) => std::env::set_var("FRESHELL_TEST_CLAUDE_DEFER_CREATE_MS", ms.to_string()),
            None => std::env::remove_var("FRESHELL_TEST_CLAUDE_DEFER_CREATE_MS"),
        }
        if fail_create {
            std::env::set_var("FRESHELL_TEST_CLAUDE_FAIL_CREATE", "1");
        } else {
            std::env::remove_var("FRESHELL_TEST_CLAUDE_FAIL_CREATE");
        }
        for key in [
            "FRESHELL_TEST_CLAUDE_REJECT_MODEL",
            "FRESHELL_TEST_CLAUDE_REJECT_EFFORT",
        ] {
            std::env::remove_var(key);
        }
        Self {
            dir,
            spawn_log,
            interrupt_log,
            respond_log,
            previous,
        }
    }

    pub(super) fn spawn_log_path(&self) -> &Path {
        &self.spawn_log
    }

    pub(super) async fn create_request(&self) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(row) = self.query_rows().first() {
                return row["options"].clone();
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "query never reached the SDK"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn query_rows(&self) -> Vec<Value> {
        rows(&self.spawn_log)
    }

    pub(super) fn spawn_count(&self) -> usize {
        self.query_rows().len()
    }

    pub(super) fn interrupt_log_contents(&self) -> String {
        std::fs::read_to_string(&self.interrupt_log).unwrap_or_default()
    }

    pub(super) async fn respond_log_frames(&self, min: usize) -> Vec<Value> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let frames = rows(&self.respond_log);
            if frames.len() >= min {
                return frames;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "sidecar stdin never received {min} frame(s): {frames:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

fn rows(file: &Path) -> Vec<Value> {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("fixture JSONL row"))
        .collect()
}

impl Drop for ClaudeTestRuntime {
    fn drop(&mut self) {
        let _ = std::fs::write(self.dir.join("active.stop"), "");
        let _ = std::fs::remove_file(self.dir.join("active"));
        // The SDK watcher also treats this unique directory disappearing as
        // shutdown, so deleting it cannot lose the sentinel notification.
        let _ = std::fs::remove_dir_all(&self.dir);
        for (key, value) in &self.previous {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

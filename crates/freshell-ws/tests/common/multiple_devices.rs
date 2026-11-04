//! Shared protocol helpers for Freshagent multi-device attach tests.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::claude_rig::RigConnection;

pub const FRESH_AGENT_RECONCILIATION_CAPABILITY: &str = "freshAgentReconciliationV1";

pub static PROVIDER_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const PROVIDER_ENV_KEYS: [&str; 14] = [
    "CODEX_HOME",
    "CODEX_CMD",
    "FAKE_CODEX_APP_SERVER_BEHAVIOR",
    "FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES",
    "OPENCODE_CMD",
    "FRESHELL_FAKE_PROVIDER",
    "FRESHELL_FAKE_LEDGER",
    "FRESHELL_FAKE_EVENTS",
    "FRESHELL_FAKE_PROGRAM",
    "FRESHELL_FAKE_OPENCODE_HTTP_AUDIT",
    "FRESHELL_FAKE_OPENCODE_PROMPT_RELEASE_PATH",
    "FRESHELL_FAKE_OPENCODE_TRANSIENT_FAILURE_SESSION_ID",
    "FRESHELL_CLAUDE_SIM_FAIL_RESUME_PATH",
    "FRESHELL_CLAUDE_SIM_HOLD_PROMPT_GATE_PATH",
];

/// Installs isolated provider processes for the real two-socket WS rig. Codex and
/// OpenCode use the repository's existing provider fixtures with per-run gates/audits.
pub struct ProviderFixtureEnv {
    previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
    root: tempfile::TempDir,
    pub claude_prompt_release: PathBuf,
    pub claude_resume_failure: PathBuf,
    pub codex_turn_release: PathBuf,
    pub codex_audit: PathBuf,
    pub codex_turn_audit: PathBuf,
    pub opencode_release: PathBuf,
    pub opencode_audit: PathBuf,
    pub opencode_launch_audit: PathBuf,
    pub opencode_events: PathBuf,
}

impl ProviderFixtureEnv {
    pub fn install() -> Self {
        let root = tempfile::Builder::new()
            .prefix("freshell-multiple-devices-providers-")
            .tempdir()
            .expect("create provider fixture directory");
        let claude_prompt_release = root.path().join("claude-prompt-release");
        let claude_resume_failure = root.path().join("claude-resume-failure");
        let codex_turn_release = root.path().join("codex-turn-release");
        let codex_audit = root.path().join("codex-operations.jsonl");
        let codex_turn_audit = root.path().join("codex-turns.jsonl");
        let codex_home = root.path().join("codex-home");
        let opencode_release = root.path().join("opencode-turn-release");
        let opencode_audit = root.path().join("opencode-requests.jsonl");
        let opencode_launch_audit = root.path().join("opencode-launches.jsonl");
        let opencode_events = root.path().join("opencode-events.jsonl");
        std::fs::create_dir_all(&codex_home).expect("create isolated Codex home");
        let codex_fixture = super::claude_rig::repo_root()
            .join("test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs");
        let behavior = json!({
            "threadStartThreadId": "thread_multidevice",
            "recordTurns": true,
            "liveTranscript": true,
            "waitForTurnReleasePath": codex_turn_release,
            "appendThreadOperationLogPath": codex_audit,
            "appendTurnOperationLogPath": codex_turn_audit,
            "overrides": {
                "thread/resume": { "error": { "code": -32001, "message": "Thread not found" } }
            },
            "threadResumeErrorsById": {
                "thread_attach_failure": { "code": -32000, "message": "Temporary app-server failure" }
            },
        });
        let previous = PROVIDER_ENV_KEYS
            .iter()
            .map(|key| (*key, std::env::var_os(key)))
            .collect();
        std::env::set_var("CODEX_HOME", &codex_home);
        std::env::set_var("CODEX_CMD", format!("node {}", codex_fixture.display()));
        std::env::set_var("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior.to_string());
        std::env::set_var("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1");
        let opencode_fixture = super::claude_rig::repo_root()
            .join("test/e2e-browser/fixtures/providers/fake-opencode-server.mjs");
        let opencode_wrapper = root.path().join("fake-opencode-wrapper");
        std::fs::write(
            &opencode_wrapper,
            format!(
                "#!/bin/sh\nexec node '{}' \"$@\"\n",
                opencode_fixture.display()
            ),
        )
        .expect("write the OpenCode fixture launcher");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&opencode_wrapper, std::fs::Permissions::from_mode(0o755))
                .expect("make the OpenCode fixture launcher executable");
        }
        std::env::set_var("OPENCODE_CMD", &opencode_wrapper);
        std::env::set_var("FRESHELL_FAKE_PROVIDER", "opencode-server");
        std::env::set_var("FRESHELL_FAKE_LEDGER", &opencode_launch_audit);
        std::env::set_var("FRESHELL_FAKE_EVENTS", &opencode_events);
        std::env::set_var(
            "FRESHELL_FAKE_PROGRAM",
            json!({ "sessionId": "ses_multidevice" }).to_string(),
        );
        std::env::set_var("FRESHELL_FAKE_OPENCODE_HTTP_AUDIT", &opencode_audit);
        std::env::set_var(
            "FRESHELL_FAKE_OPENCODE_PROMPT_RELEASE_PATH",
            &opencode_release,
        );
        std::env::set_var(
            "FRESHELL_FAKE_OPENCODE_TRANSIENT_FAILURE_SESSION_ID",
            "ses_multidevice_attach_failure",
        );
        Self {
            previous,
            root,
            claude_prompt_release,
            claude_resume_failure,
            codex_turn_release,
            codex_audit,
            codex_turn_audit,
            opencode_release,
            opencode_audit,
            opencode_launch_audit,
            opencode_events,
        }
    }

    pub fn release(&self, path: &Path) {
        std::fs::write(path, "released").expect("release provider turn gate");
    }

    pub async fn wait_for_jsonl(
        &self,
        path: &Path,
        what: &str,
        predicate: impl Fn(&Value) -> bool,
    ) -> Value {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        loop {
            if let Ok(raw) = std::fs::read_to_string(path) {
                for line in raw.lines().filter(|line| !line.trim().is_empty()) {
                    let row: Value =
                        serde_json::from_str(line).expect("provider audit row is JSON");
                    if predicate(&row) {
                        return row;
                    }
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "missing provider audit row: {what}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    pub fn jsonl_count(&self, path: &Path, predicate: impl Fn(&Value) -> bool) -> usize {
        std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str::<Value>(line).expect("provider audit row is JSON"))
            .filter(predicate)
            .count()
    }
}

impl Drop for ProviderFixtureEnv {
    fn drop(&mut self) {
        for (key, value) in self.previous.drain(..) {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
        let _ = &self.root;
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderMode {
    Freshclaude,
    Kilroy,
    Freshcodex,
    Freshopencode,
}

impl ProviderMode {
    pub fn provider(self) -> &'static str {
        match self {
            Self::Freshclaude | Self::Kilroy => "claude",
            Self::Freshcodex => "codex",
            Self::Freshopencode => "opencode",
        }
    }

    pub fn session_type(self) -> &'static str {
        match self {
            Self::Freshclaude => "freshclaude",
            Self::Kilroy => "kilroy",
            Self::Freshcodex => "freshcodex",
            Self::Freshopencode => "freshopencode",
        }
    }

    pub fn attach_failure_session_id(self) -> &'static str {
        match self {
            Self::Freshclaude | Self::Kilroy => "00000000-0000-4000-8000-000000000099",
            Self::Freshcodex => "thread_attach_failure",
            Self::Freshopencode => "ses_multidevice_attach_failure",
        }
    }

    pub const ALL: [Self; 4] = [
        Self::Freshclaude,
        Self::Kilroy,
        Self::Freshcodex,
        Self::Freshopencode,
    ];
}

pub async fn create_mode(
    connection: &mut RigConnection,
    mode: ProviderMode,
    request_id: &str,
) -> String {
    let start = connection.frames.len();
    connection
        .send(json!({
            "type": "freshAgent.create",
            "requestId": request_id,
            "viewId": format!("create-view-{request_id}"),
            "provider": mode.provider(),
            "sessionType": mode.session_type(),
            "cwd": connection.workspace().to_string_lossy(),
        }))
        .await;
    let created = connection
        .wait_for_since(start, "provider session create", |frame| {
            frame["type"] == "freshAgent.created" && frame["requestId"] == request_id
        })
        .await;
    created["sessionId"]
        .as_str()
        .expect("created session has an id")
        .to_string()
}

pub async fn send_mode_text(
    connection: &mut RigConnection,
    mode: ProviderMode,
    session_id: &str,
    request_id: &str,
    text: &str,
) {
    connection
        .send(json!({
            "type": "freshAgent.send",
            "provider": mode.provider(),
            "sessionType": mode.session_type(),
            "sessionId": session_id,
            "requestId": request_id,
            "text": text,
        }))
        .await;
}

pub fn owner_pair_for(
    connection: &RigConnection,
    provider: &str,
    session_id: &str,
) -> Option<(u64, u64)> {
    connection.frames.iter().rev().find_map(|frame| {
        (frame["type"] == "session.runtimeOwner"
            && frame["provider"] == provider
            && frame["sessionId"] == session_id)
            .then(|| Some((frame["epoch"].as_u64()?, frame["generation"].as_u64()?)))
            .flatten()
    })
}

pub fn attach_request(
    provider: &str,
    session_type: &str,
    session_id: &str,
    view_id: &str,
    request_id: &str,
) -> Value {
    json!({
        "type": "freshAgent.attach",
        "provider": provider,
        "sessionType": session_type,
        "sessionId": session_id,
        "sessionRef": { "provider": provider, "sessionId": session_id },
        "viewId": view_id,
        "requestId": request_id,
    })
}

pub fn fenced_attach_request(
    mode: ProviderMode,
    session_id: &str,
    view_id: &str,
    request_id: &str,
    fence: Option<(u64, u64)>,
) -> Value {
    let mut request = attach_request(
        mode.provider(),
        mode.session_type(),
        session_id,
        view_id,
        request_id,
    );
    if let Some((epoch, generation)) = fence {
        request["observedEpoch"] = json!(epoch);
        request["observedGeneration"] = json!(generation);
    }
    request
}

/// Legacy event-shaped attach from a newer client that has a view id but has
/// not opted in to correlated attach outcomes.
pub fn legacy_attach_request(
    provider: &str,
    session_type: &str,
    session_id: &str,
    view_id: &str,
) -> Value {
    json!({
        "type": "freshAgent.attach",
        "provider": provider,
        "sessionType": session_type,
        "sessionId": session_id,
        "sessionRef": { "provider": provider, "sessionId": session_id },
        "viewId": view_id,
    })
}

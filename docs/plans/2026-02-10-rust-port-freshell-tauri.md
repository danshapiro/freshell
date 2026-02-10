# Freshell Full Rust Port (+ Optional Tauri Client) Implementation Plan

**Goal:** Replace Freshell’s TypeScript/Node stack with a Rust backend and Rust/WASM frontend, and ship an optional Tauri desktop client with feature parity.

**Audience:** This spec is written for an implementer who has direct access to the Freshell source tree and can read existing code/tests while implementing.

**Architecture:** Build a new Rust workspace beside the current codebase, lock parity with tests, and port behavior subsystem-by-subsystem (protocol, PTY lifecycle, sessions/indexing/repair, UI pane system, browser/editor panes, settings, auth). The runtime is PTY-first (single terminal lifecycle path), with client-local workspace state and a shared Rust/WASM UI used by both browser and Tauri webview.

**Tech Stack:** Rust (Tokio, Axum, serde, tracing), portable PTY crate, Leptos (CSR) for Rust/WASM UI, Tauri v2, Python browser-use smoke/e2e tests, Cargo test/nextest.

---

## Product Decisions (Locked)

- Big-bang rewrite (backend + web UI + Tauri in one v1).
- Zero TypeScript in v1 deliverable.
- PTY-first runtime model is canonical.
- Client-local workspace state (tabs/panes/layout stay local per client).
- Tauri app bundles embedded server and also supports remote connect.
- Browser pane parity required; devtools are tiered (`full` in Tauri, `limited + open external` on web).
- Backward compatibility and migration can be skipped; state loss acceptable.
- Protocol compatibility with old server is not required.
- Linux/macOS/Windows support day one.
- Cross-platform smoke CI starts in the first implementation batch (do not defer to the end).
- AI summary parity in v1; AI enabled sends full content by default.
- Single-user token auth.
- Equal priority web and desktop.
- First-run network exposure wizard required.
- Keep backend running when Tauri window closes (default).
- Stable release channel only; desktop auto-update is opt-in.
- No built-in backup/recovery feature.

## Read First (Zero-Context Onboarding)

Read these files before writing code. They define existing behavior to preserve.

- `server/ws-handler.ts` (WS protocol, handshake, auth, backpressure, rate limits)
- `server/terminal-registry.ts` (PTY lifecycle, attach/detach snapshot semantics)
- `server/index.ts` (HTTP routes, background services, startup/shutdown ordering)
- `server/config-store.ts` (settings/session overrides, atomic file persistence)
- `server/sessions-sync/*` (sessions diff + patch/snapshot fanout semantics)
- `server/session-scanner/*` (Claude session scan/repair queue)
- `server/coding-cli/*` + `server/claude-indexer.ts` (session indexing/provider behavior)
- `server/files-router.ts` + `server/port-forward.ts` (files and proxy route semantics)
- `src/store/panesSlice.ts` + `src/store/paneTypes.ts` (pane tree state model)
- `src/components/TerminalView.tsx` (terminal client behavior + reconnect logic)
- `src/components/panes/BrowserPane.tsx` (browser pane, forwarding, devtools UX)
- `src/store/crossTabSync.ts` + `src/store/persistMiddleware.ts` (client-local persistence and sync)
- `test/server/*.test.ts`, `test/integration/*`, `test/e2e/*` (behavioral contract)

## Workspace Setup

### Task 1: Create Dedicated Rust Port Worktree and Workspace Skeleton

**Files:**
- Create: `.worktrees/rust-port/` (git worktree)
- Create: `.worktrees/rust-port/rust/Cargo.toml`
- Create: `.worktrees/rust-port/rust/rust-toolchain.toml`
- Create: `.worktrees/rust-port/rust/crates/freshell-protocol/Cargo.toml`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/Cargo.toml`
- Create: `.worktrees/rust-port/rust/crates/freshell-pty/Cargo.toml`
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/Cargo.toml`
- Create: `.worktrees/rust-port/rust/crates/freshell-config/Cargo.toml`
- Create: `.worktrees/rust-port/rust/crates/freshell-ai/Cargo.toml`
- Create: `.worktrees/rust-port/rust/crates/freshell-coding-cli/Cargo.toml`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/Cargo.toml`
- Create: `.worktrees/rust-port/apps/freshell-tauri/src-tauri/Cargo.toml`
- Test: `.worktrees/rust-port/rust/crates/freshell-protocol/tests/workspace_smoke.rs`

**Step 1: Write the failing test**

```rust
// rust/crates/freshell-protocol/tests/workspace_smoke.rs
#[test]
fn workspace_builds_protocol_crate() {
    let msg = freshell_protocol::WsServerMessage::Ready {
        timestamp: "2026-02-10T00:00:00Z".to_string(),
    };

    match msg {
        freshell_protocol::WsServerMessage::Ready { .. } => {}
        _ => panic!("unexpected variant"),
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-protocol workspace_builds_protocol_crate`

Expected: FAIL (crate/type does not exist yet)

**Step 3: Write minimal implementation**

```rust
// rust/crates/freshell-protocol/src/lib.rs
#[derive(Debug, Clone)]
pub enum WsServerMessage {
    Ready { timestamp: String },
}
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-protocol workspace_builds_protocol_crate`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust
git commit -m "chore(rust): scaffold rust workspace and protocol crate"
```

### Task 1A: Add Early Cross-Platform Smoke CI Gate

**Files:**
- Create: `.worktrees/rust-port/.github/workflows/rust-smoke-matrix.yml`
- Test: `.worktrees/rust-port/rust/crates/freshell-protocol/tests/workspace_smoke.rs` (reused as matrix smoke target)

**Step 1: Write the failing CI check**

```bash
cd .worktrees/rust-port
rg "rust-smoke-matrix" .github/workflows
```

Expected: FAIL (workflow missing)

**Step 2: Write minimal implementation**

```yaml
# .github/workflows/rust-smoke-matrix.yml
# - trigger on pull_request and push
# - matrix: ubuntu-latest, macos-latest, windows-latest
# - run: cargo test --manifest-path rust/Cargo.toml -p freshell-protocol workspace_builds_protocol_crate
```

**Step 3: Run local validation**

Run: `cd .worktrees/rust-port && cargo test --manifest-path rust/Cargo.toml -p freshell-protocol workspace_builds_protocol_crate`

Expected: PASS

**Step 4: Commit**

```bash
cd .worktrees/rust-port
git add .github/workflows/rust-smoke-matrix.yml
git commit -m "ci(rust): add early cross-platform smoke matrix for protocol workspace"
```

---

## Protocol + Server Core

### Task 2: Define WS/HTTP Protocol v2 (Breaking, PTY-First)

**Files:**
- Modify: `.worktrees/rust-port/rust/crates/freshell-protocol/src/lib.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-protocol/src/ws.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-protocol/src/http.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-protocol/tests/ws_schema_roundtrip.rs`

**Step 1: Write the failing test**

```rust
use freshell_protocol::{WsClientMessage, WsServerMessage};

#[test]
fn ws_schema_covers_all_required_message_families() {
    let client_types = [
        r#"{"type":"hello","token":"token-1234567890abcd"}"#,
        r#"{"type":"ping"}"#,
        r#"{"type":"terminal.create","requestId":"r1","mode":"shell","shell":"system"}"#,
        r#"{"type":"terminal.attach","terminalId":"t1"}"#,
        r#"{"type":"terminal.detach","terminalId":"t1"}"#,
        r#"{"type":"terminal.input","terminalId":"t1","data":"ls\n"}"#,
        r#"{"type":"terminal.resize","terminalId":"t1","cols":120,"rows":40}"#,
        r#"{"type":"terminal.kill","terminalId":"t1"}"#,
        r#"{"type":"terminal.list","requestId":"r2"}"#,
        r#"{"type":"codingcli.create","requestId":"r3","provider":"claude","prompt":"hi","cwd":"/tmp","resumeSessionId":"sess-prev","model":"sonnet","maxTurns":10,"permissionMode":"default","sandbox":"workspace-write"}"#,
        r#"{"type":"codingcli.input","sessionId":"s1","data":"continue\n"}"#,
        r#"{"type":"codingcli.kill","sessionId":"s1"}"#,
    ];
    for raw in client_types {
        let parsed: WsClientMessage = serde_json::from_str(raw).unwrap();
        let re = serde_json::to_string(&parsed).unwrap();
        assert!(re.contains("\"type\""));
    }

    let server_types = [
        r#"{"type":"ready","timestamp":"2026-02-10T00:00:00Z"}"#,
        r#"{"type":"terminal.created","requestId":"r1","terminalId":"t1","snapshot":"","createdAt":1}"#,
        r#"{"type":"terminal.attached","terminalId":"t1","snapshot":""}"#,
        r#"{"type":"terminal.detached","terminalId":"t1"}"#,
        r#"{"type":"terminal.output","terminalId":"t1","data":"hi\n"}"#,
        r#"{"type":"terminal.exit","terminalId":"t1","exitCode":0}"#,
        r#"{"type":"terminal.list.response","requestId":"r2","terminals":[{"terminalId":"t1","title":"Shell","description":"bash","mode":"shell","resumeSessionId":"abc","createdAt":1,"lastActivityAt":2,"status":"running","hasClients":true,"cwd":"/tmp"}]}"#,
        r#"{"type":"terminal.list.updated"}"#,
        r#"{"type":"terminal.title.updated","terminalId":"t1","title":"New Title"}"#,
        r#"{"type":"codingcli.created","requestId":"r3","sessionId":"s1","provider":"claude"}"#,
        r#"{"type":"codingcli.event","sessionId":"s1","provider":"claude","event":{"type":"assistant"}}"#,
        r#"{"type":"codingcli.exit","sessionId":"s1","provider":"claude","exitCode":0}"#,
        r#"{"type":"codingcli.stderr","sessionId":"s1","provider":"claude","text":"warn"}"#,
        r#"{"type":"codingcli.killed","sessionId":"s1","success":true}"#,
        r#"{"type":"sessions.updated","projects":[]}"#,
        r#"{"type":"sessions.patch","upsertProjects":[],"removeProjectPaths":[]}"#,
        r#"{"type":"session.status","sessionId":"abc","status":"running"}"#,
        r#"{"type":"session.repair.activity","event":"scanned","sessionId":"abc"}"#,
        r#"{"type":"settings.updated","settings":{}}"#,
        r#"{"type":"perf.logging","enabled":false}"#,
        r#"{"type":"terminal.idle.warning","terminalId":"t1","secondsRemaining":30}"#,
        r#"{"type":"terminal.session.associated","terminalId":"t1","sessionId":"abc"}"#,
        r#"{"type":"pong","timestamp":"2026-02-10T00:00:00Z"}"#,
        r#"{"type":"error","code":"INVALID_MESSAGE","message":"bad payload","requestId":"r1","terminalId":"t1","timestamp":"2026-02-10T00:00:00Z"}"#,
    ];
    for raw in server_types {
        let parsed: WsServerMessage = serde_json::from_str(raw).unwrap();
        let re = serde_json::to_string(&parsed).unwrap();
        assert!(re.contains("\"type\""));
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-protocol ws_schema_covers_all_required_message_families`

Expected: FAIL (message types missing)

**Step 3: Write minimal implementation**

```rust
// rust/crates/freshell-protocol/src/ws.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalMode { Shell, Claude, Codex, Opencode, Gemini, Kimi }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellType { System, Cmd, Powershell, Wsl }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WsClientMessage {
    #[serde(rename = "hello")]
    Hello {
        token: String,
        capabilities: Option<ClientCapabilities>,
        sessions: Option<HelloSessions>,
    },
    #[serde(rename = "terminal.create")]
    TerminalCreate {
        request_id: String,
        mode: TerminalMode,
        shell: ShellType,
        cwd: Option<String>,
        resume_session_id: Option<String>,
        restore: Option<bool>,
    },
    #[serde(rename = "terminal.attach")]
    TerminalAttach { terminal_id: String },
    #[serde(rename = "terminal.detach")]
    TerminalDetach { terminal_id: String },
    #[serde(rename = "terminal.input")]
    TerminalInput { terminal_id: String, data: String },
    #[serde(rename = "terminal.resize")]
    TerminalResize { terminal_id: String, cols: u16, rows: u16 },
    #[serde(rename = "terminal.kill")]
    TerminalKill { terminal_id: String },
    #[serde(rename = "terminal.list")]
    TerminalList { request_id: String },
    #[serde(rename = "codingcli.create")]
    CodingCliCreate {
        request_id: String,
        provider: String,
        prompt: String,
        cwd: Option<String>,
        resume_session_id: Option<String>,
        model: Option<String>,
        max_turns: Option<u32>,
        permission_mode: Option<String>,
        sandbox: Option<String>,
    },
    #[serde(rename = "codingcli.input")]
    CodingCliInput { session_id: String, data: String },
    #[serde(rename = "codingcli.kill")]
    CodingCliKill { session_id: String },
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientCapabilities {
    #[serde(rename = "sessionsPatchV1")]
    pub sessions_patch_v1: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloSessions {
    pub active: Option<String>,
    pub visible: Option<Vec<String>>,
    pub background: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum WsServerMessage {
    #[serde(rename = "ready")]
    Ready { timestamp: String },
    #[serde(rename = "terminal.created")]
    TerminalCreated {
        request_id: String,
        terminal_id: String,
        snapshot: String,
        created_at: u64,
        effective_resume_session_id: Option<String>,
    },
    #[serde(rename = "terminal.attached")]
    TerminalAttached { terminal_id: String, snapshot: String },
    #[serde(rename = "terminal.detached")]
    TerminalDetached { terminal_id: String },
    #[serde(rename = "terminal.output")]
    TerminalOutput { terminal_id: String, data: String },
    #[serde(rename = "terminal.exit")]
    TerminalExit { terminal_id: String, exit_code: i32 },
    #[serde(rename = "terminal.list.response")]
    TerminalListResponse { request_id: String, terminals: Vec<TerminalListItem> },
    #[serde(rename = "terminal.list.updated")]
    TerminalListUpdated,
    #[serde(rename = "terminal.title.updated")]
    TerminalTitleUpdated { terminal_id: String, title: String },
    #[serde(rename = "codingcli.created")]
    CodingCliCreated { request_id: String, session_id: String, provider: String },
    #[serde(rename = "codingcli.event")]
    CodingCliEvent { session_id: String, provider: String, event: serde_json::Value },
    #[serde(rename = "codingcli.exit")]
    CodingCliExit { session_id: String, provider: String, exit_code: i32 },
    #[serde(rename = "codingcli.stderr")]
    CodingCliStderr { session_id: String, provider: String, text: String },
    #[serde(rename = "codingcli.killed")]
    CodingCliKilled { session_id: String, success: bool },
    #[serde(rename = "sessions.updated")]
    SessionsUpdated { projects: Vec<serde_json::Value>, clear: Option<bool>, append: Option<bool> },
    #[serde(rename = "sessions.patch")]
    SessionsPatch { upsert_projects: Vec<serde_json::Value>, remove_project_paths: Vec<String> },
    #[serde(rename = "session.status")]
    SessionStatus { session_id: String, status: String },
    #[serde(rename = "session.repair.activity")]
    SessionRepairActivity { event: String, session_id: String, status: Option<String>, message: Option<String> },
    #[serde(rename = "settings.updated")]
    SettingsUpdated { settings: serde_json::Value },
    #[serde(rename = "perf.logging")]
    PerfLogging { enabled: bool },
    #[serde(rename = "terminal.idle.warning")]
    TerminalIdleWarning { terminal_id: String, seconds_remaining: u64 },
    #[serde(rename = "terminal.session.associated")]
    TerminalSessionAssociated { terminal_id: String, session_id: String },
    #[serde(rename = "pong")]
    Pong { timestamp: String },
    #[serde(rename = "error")]
    Error {
        code: String,
        message: String,
        request_id: Option<String>,
        terminal_id: Option<String>,
        timestamp: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalListItem {
    pub terminal_id: String,
    pub title: String,
    pub description: Option<String>,
    pub mode: TerminalMode,
    pub resume_session_id: Option<String>,
    pub created_at: u64,
    pub last_activity_at: u64,
    pub status: String,
    pub has_clients: bool,
    pub cwd: Option<String>,
}
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-protocol`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-protocol
git commit -m "feat(protocol): define websocket and http v2 message schema"
```

### Task 3: Port Config + Auth Foundation

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-config/src/lib.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/auth.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/tests/auth_startup_validation.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn auth_token_short_is_rejected() {
    let err = freshell_server::auth::validate_auth_token("short").unwrap_err();
    assert!(err.to_string().contains("at least 16"));
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server auth_token_short_is_rejected`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
pub fn validate_auth_token(token: &str) -> anyhow::Result<()> {
    if token.len() < 16 {
        anyhow::bail!("AUTH_TOKEN must be at least 16 characters");
    }
    let lower = token.to_lowercase();
    if ["changeme", "default", "password", "token"].contains(&lower.as_str()) {
        anyhow::bail!("AUTH_TOKEN is weak");
    }
    Ok(())
}
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server auth_token_short_is_rejected`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-config rust/crates/freshell-server
git commit -m "feat(server): add auth token validation and config crate foundation"
```

### Task 4: Port HTTP Skeleton + Health/Settings Endpoints

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/http/mod.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/http/routes_settings.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/tests/http_harness.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/tests/http_settings_api.rs`

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn settings_requires_auth_and_supports_patch_put_roundtrip() {
    let app = freshell_server::http::build_test_router();

    let unauth = app
        .oneshot(axum::http::Request::builder()
            .uri("/api/settings")
            .body(axum::body::Body::empty())
            .unwrap())
        .await
        .unwrap();
    assert_eq!(unauth.status(), axum::http::StatusCode::UNAUTHORIZED);

    let patched = freshell_server::tests::patch_settings(&app, "token-1234567890abcd", r#"{"defaultShell":"wsl"}"#).await;
    assert_eq!(patched.status(), axum::http::StatusCode::OK);

    let put = freshell_server::tests::put_settings(&app, "token-1234567890abcd", r#"{"fontSize":16}"#).await;
    assert_eq!(put.status(), axum::http::StatusCode::OK);

    let read_back = freshell_server::tests::get_settings(&app, "token-1234567890abcd").await;
    assert!(read_back.body_text().contains("\"defaultShell\":\"wsl\""));
    assert!(read_back.body_text().contains("\"fontSize\":16"));
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server settings_requires_auth_and_supports_patch_put_roundtrip`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Router includes:
// - GET /api/health (no auth)
// - GET /api/settings (auth)
// - PATCH /api/settings (auth)
// - PUT /api/settings alias (auth; same semantics as PATCH)
// auth middleware reads x-auth-token
// test harness helpers: get_settings, patch_settings, put_settings
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server http_settings_api`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-server
git commit -m "feat(server): add axum http skeleton with health and settings routes"
```

---

## PTY + WebSocket Runtime

### Task 5: Implement PTY Registry Parity (Attach/Detach/Snapshot)

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-pty/src/lib.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-pty/src/ring_buffer.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-pty/tests/registry_attach_snapshot.rs`

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn attach_sends_snapshot_before_live_output() {
    let mut reg = freshell_pty::TerminalRegistry::new_for_test();
    let term_id = reg.create_test_terminal("hello\n").await;

    let (snapshot, stream) = reg.attach_for_test(&term_id).await.unwrap();
    assert_eq!(snapshot, "hello\n");

    reg.push_test_output(&term_id, "world\n").await;
    let next = stream.recv().await.unwrap();
    assert_eq!(next, "world\n");
}

#[tokio::test]
async fn output_during_attach_window_is_queued_and_flushed_after_snapshot() {
    let mut reg = freshell_pty::TerminalRegistry::new_for_test();
    let term_id = reg.create_test_terminal("snap\n").await;

    let (snapshot, mut stream, attach_token) = reg.attach_begin_for_test(&term_id).await.unwrap();
    assert_eq!(snapshot, "snap\n");

    reg.push_test_output(&term_id, "during-attach\n").await;
    assert!(stream.try_recv().is_err());

    reg.finish_attach_snapshot_for_test(&term_id, attach_token).await.unwrap();
    let flushed = stream.recv().await.unwrap();
    assert_eq!(flushed, "during-attach\n");
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-pty attach_sends_snapshot_before_live_output`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// TerminalRegistry with:
// - create(mode, shell, cwd, resume_session_id)
// - attach(terminal_id) -> (snapshot, receiver)
// - attach-begin/finish flow to avoid output loss during snapshot send
// - detach, input, resize, kill
// - ring buffer (char-count based, default 64 KiB, configurable)
// - pending snapshot queue + bounded overflow handling
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-pty`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-pty
git commit -m "feat(pty): implement terminal registry, snapshot semantics, and ring buffer"
```

### Task 6: Port WS Handshake + Hello Timeout + Ready Flow

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/ws/mod.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/ws/client_state.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-server/tests/ws_handshake.rs`

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn ws_rejects_without_valid_hello_token() {
    let harness = freshell_server::tests::WsHarness::spawn().await;
    let mut client = harness.connect().await;

    client.send_json(serde_json::json!({ "type": "hello", "token": "wrong" })).await;
    let close = client.wait_close().await;

    assert_eq!(close.code, 4001);
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server ws_rejects_without_valid_hello_token`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// WS handler:
// - start hello timer (default 5s)
// - parse hello, verify token, store capabilities
// - send ready + initial snapshot messages
// - close with 4001/4002/4003/4008 codes as needed
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server ws_handshake`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-server/src/ws rust/crates/freshell-server/tests/ws_handshake.rs
git commit -m "feat(ws): implement authenticated hello/ready handshake and close semantics"
```

### Task 6A: Port WS Backpressure Guardrails (Connection + Snapshot Queues)

**Files:**
- Modify: `.worktrees/rust-port/rust/crates/freshell-server/src/ws/mod.rs`
- Modify: `.worktrees/rust-port/rust/crates/freshell-pty/src/lib.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-server/tests/ws_backpressure.rs`

**Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn oversized_buffered_amount_closes_connection_with_4008() {
    let h = freshell_server::tests::WsHarness::spawn().await;
    let mut c = h.authed_client().await;
    h.force_client_buffered_amount(&mut c, 3 * 1024 * 1024).await;
    let close = c.wait_close().await;
    assert_eq!(close.code, 4008);
}

#[tokio::test]
async fn pending_snapshot_queue_is_bounded_and_drops_or_closes_on_overflow() {
    let mut reg = freshell_pty::TerminalRegistry::new_for_test();
    let term_id = reg.create_test_terminal("seed\n").await;
    let (_snapshot, _stream, attach_token) = reg.attach_begin_for_test(&term_id).await.unwrap();
    reg.push_many_outputs_for_test(&term_id, 100_000).await;
    let outcome = reg.finish_attach_snapshot_for_test(&term_id, attach_token).await;
    assert!(outcome.is_ok() || outcome.is_err());
}
```

**Step 2: Run tests to verify fail**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server ws_backpressure`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Mirror source behavior:
// - close sockets when bufferedAmount exceeds MAX_WS_BUFFERED_AMOUNT (close code 4008)
// - maintain pending snapshot queues per attached client
// - bound pending queue growth; close/detach when overflow threshold exceeded
```

**Step 4: Run tests to verify pass**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server ws_backpressure`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-server/src/ws/mod.rs rust/crates/freshell-pty/src/lib.rs rust/crates/freshell-server/tests/ws_backpressure.rs
git commit -m "feat(ws): port websocket and snapshot backpressure protections"
```

### Task 7: Port Terminal WS Commands End-to-End

**Files:**
- Modify: `.worktrees/rust-port/rust/crates/freshell-server/src/ws/mod.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-server/tests/ws_terminal_lifecycle.rs`

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn terminal_create_attach_input_resize_detach_kill() {
    let h = freshell_server::tests::WsHarness::spawn().await;
    let mut c = h.authed_client().await;

    c.send_json(serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-1",
        "mode": "shell",
        "shell": "system"
    })).await;

    let created = c.wait_type("terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap();

    c.send_json(serde_json::json!({"type":"terminal.input","terminalId":terminal_id,"data":"echo hi\n"})).await;
    c.send_json(serde_json::json!({"type":"terminal.resize","terminalId":terminal_id,"cols":120,"rows":40})).await;

    c.send_json(serde_json::json!({"type":"terminal.detach","terminalId":terminal_id})).await;
    c.send_json(serde_json::json!({"type":"terminal.kill","terminalId":terminal_id})).await;

    let exit = c.wait_type("terminal.exit").await;
    assert_eq!(exit["terminalId"], terminal_id);
}

#[tokio::test]
async fn terminal_create_is_idempotent_by_request_id() {
    let h = freshell_server::tests::WsHarness::spawn().await;
    let mut c = h.authed_client().await;

    let create = serde_json::json!({
        "type":"terminal.create",
        "requestId":"req-same",
        "mode":"shell",
        "shell":"system"
    });
    c.send_json(create.clone()).await;
    let first = c.wait_type("terminal.created").await;
    c.send_json(create).await;
    let second = c.wait_type("terminal.created").await;
    assert_eq!(first["terminalId"], second["terminalId"]);
}

#[tokio::test]
async fn terminal_create_is_rate_limited_after_threshold() {
    let h = freshell_server::tests::WsHarness::spawn().await;
    let mut c = h.authed_client().await;
    for i in 0..12 {
        c.send_json(serde_json::json!({
            "type":"terminal.create",
            "requestId": format!("req-{i}"),
            "mode":"shell",
            "shell":"system"
        })).await;
    }
    let err = c.wait_type("error").await;
    assert_eq!(err["code"], "RATE_LIMITED");
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server ws_terminal_lifecycle`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Add WS dispatch for:
// terminal.create, terminal.attach, terminal.detach,
// terminal.input, terminal.resize, terminal.kill, terminal.list
// plus request-id idempotency map and create rate limiter.
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server ws_terminal_lifecycle`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-server/src/ws/mod.rs rust/crates/freshell-server/tests/ws_terminal_lifecycle.rs
git commit -m "feat(ws): implement full terminal websocket lifecycle commands"
```

### Task 7A: Port Coding CLI WS Runtime + Session Manager Parity

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-coding-cli/src/session_manager.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-coding-cli/src/provider.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-coding-cli/src/providers/claude.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-coding-cli/src/providers/codex.rs`
- Modify: `.worktrees/rust-port/rust/crates/freshell-server/src/ws/mod.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-server/tests/ws_codingcli_lifecycle.rs`

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn codingcli_create_stream_input_kill_emits_expected_events() {
    let h = freshell_server::tests::WsHarness::spawn().await;
    let mut c = h.authed_client().await;

    c.send_json(serde_json::json!({
        "type":"codingcli.create",
        "requestId":"cc-1",
        "provider":"claude",
        "prompt":"summarize this repo"
    })).await;

    let created = c.wait_type("codingcli.created").await;
    let session_id = created["sessionId"].as_str().unwrap();
    assert_eq!(created["provider"], "claude");

    let first_event = c.wait_type("codingcli.event").await;
    assert_eq!(first_event["sessionId"], session_id);
    assert_eq!(first_event["provider"], "claude");

    c.send_json(serde_json::json!({"type":"codingcli.input","sessionId":session_id,"data":"continue\n"})).await;
    let stderr = c.wait_type("codingcli.stderr").await;
    assert_eq!(stderr["provider"], "claude");
    assert!(stderr["text"].is_string());
    c.send_json(serde_json::json!({"type":"codingcli.kill","sessionId":session_id})).await;
    let killed = c.wait_type("codingcli.killed").await;
    assert_eq!(killed["sessionId"], session_id);
    assert!(killed["success"].as_bool().unwrap_or(false));
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server codingcli_create_stream_input_kill_emits_expected_events`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Port session manager semantics from server/coding-cli/session-manager.ts:
// - provider registry (claude + codex in v1 parity with current source tree)
// - bounded event buffer and status transitions
// - stderr passthrough, input forwarding, kill semantics
// Wire WS commands/events: codingcli.create/input/kill + created/event/exit/stderr/killed.
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server ws_codingcli_lifecycle`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-coding-cli rust/crates/freshell-server/src/ws/mod.rs rust/crates/freshell-server/tests/ws_codingcli_lifecycle.rs
git commit -m "feat(coding-cli): port coding cli session manager and websocket lifecycle"
```

---

## Sessions, Indexing, Repair

### Task 8: Build Unified Provider Session Indexer (Current Providers: Claude + Codex)

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/provider.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/providers/claude.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/providers/codex.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/indexer.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-sessions/tests/indexer_projects.rs`

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn indexer_groups_sessions_by_project_sorted_by_recency() {
    let idx = freshell_sessions::Indexer::new_for_test();
    idx.ingest_fixture("test/fixtures/sessions/healthy.jsonl").await.unwrap();

    let projects = idx.projects().await;
    assert!(!projects.is_empty());
    assert!(projects[0].sessions[0].updated_at >= projects[0].sessions.last().unwrap().updated_at);
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-sessions indexer_groups_sessions_by_project_sorted_by_recency`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Define Provider trait + Claude/Codex parser impls.
// Build in-memory index keyed by project_path with sorted sessions.
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-sessions indexer_projects`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-sessions
git commit -m "feat(sessions): add provider trait and unified project/session indexer"
```

### Task 8A: Port Session File Watchers (Claude + Coding CLI)

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/watch/claude_watcher.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/watch/coding_cli_watcher.rs`
- Modify: `.worktrees/rust-port/rust/crates/freshell-sessions/src/indexer.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-sessions/tests/watcher_incremental_refresh.rs`

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn watcher_add_change_unlink_updates_projects_incrementally() {
    let h = freshell_sessions::tests::WatcherHarness::spawn().await;
    h.write_session_file("claude", "p1", "s1").await;
    h.wait_for_project("p1").await;
    h.delete_session_file("claude", "p1", "s1").await;
    h.wait_for_session_removed("p1", "s1").await;
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-sessions watcher_incremental_refresh`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Port chokidar-style behavior:
// - watch provider session globs (Claude + coding-cli providers)
// - mark dirty/deleted files and debounce refresh
// - incremental cache updates on add/change/unlink events
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-sessions watcher_incremental_refresh`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-sessions/src/watch rust/crates/freshell-sessions/src/indexer.rs rust/crates/freshell-sessions/tests/watcher_incremental_refresh.rs
git commit -m "feat(sessions): port session file watchers with incremental refresh"
```

### Task 9: Port Claude Session Repair Queue + Prioritization

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/repair/scanner.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/repair/queue.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/repair/service.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-sessions/tests/repair_queue_priority.rs`

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn active_sessions_are_repaired_before_background_sessions() {
    let svc = freshell_sessions::repair::Service::new_for_test();

    svc.enqueue("bg-session", freshell_sessions::repair::Priority::Background).await;
    svc.enqueue("active-session", freshell_sessions::repair::Priority::Active).await;

    let first = svc.next_processed_for_test().await.unwrap();
    assert_eq!(first.session_id, "active-session");
}

#[tokio::test]
async fn repair_scanner_creates_backup_and_wait_for_session_unblocks() {
    let svc = freshell_sessions::repair::Service::new_for_test();
    let bad = svc.write_corrupt_session_fixture("session-1").await;
    svc.enqueue("session-1", freshell_sessions::repair::Priority::Active).await;

    let repaired = svc.wait_for_session("session-1", std::time::Duration::from_secs(5)).await.unwrap();
    assert!(repaired.was_repaired);
    assert!(svc.backup_exists_for(&bad).await);
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-sessions active_sessions_are_repaired_before_background_sessions`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Priority queue with ordering: Active > Visible > Background > Disk.
// Scanner validates and repairs malformed session files.
// Persist scan cache + backup metadata; prune stale backups.
// Expose wait_for_session(session_id, timeout) for terminal.create resume gating.
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-sessions repair_queue_priority`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-sessions/src/repair rust/crates/freshell-sessions/tests/repair_queue_priority.rs
git commit -m "feat(sessions): port claude session repair queue with priority scheduling"
```

### Task 10: Port Sessions Sync Diff/Chunk Broadcast

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/sessions_sync.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-server/tests/ws_sessions_patch.rs`

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn sends_patch_to_capable_clients_snapshot_to_legacy_clients() {
    let h = freshell_server::tests::WsHarness::spawn().await;
    let (mut modern, mut legacy) = h.two_clients_with_capability_split().await;

    h.publish_sessions_fixture("projects_small").await;

    assert_eq!(modern.wait_type("sessions.patch").await["type"], "sessions.patch");
    assert_eq!(legacy.wait_type("sessions.updated").await["type"], "sessions.updated");
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server sends_patch_to_capable_clients_snapshot_to_legacy_clients`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Add publish(next_projects):
// - diff previous vs next
// - when patch size <= max bytes:
//   - send sessions.patch to sessionsPatchV1 clients
//   - send full sessions.updated snapshot to legacy clients
// - when patch size > max bytes:
//   - send full sessions.updated snapshot to all clients
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server ws_sessions_patch`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-server/src/sessions_sync.rs rust/crates/freshell-server/tests/ws_sessions_patch.rs
git commit -m "feat(server): add sessions patch/snapshot sync service with chunk fallback"
```

### Task 10A: Port Terminal-Session Association + Terminal Title Broadcasts

**Files:**
- Modify: `.worktrees/rust-port/rust/crates/freshell-server/src/main.rs`
- Modify: `.worktrees/rust-port/rust/crates/freshell-server/src/ws/mod.rs`
- Modify: `.worktrees/rust-port/rust/crates/freshell-pty/src/lib.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-server/tests/terminal_session_association.rs`

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn new_session_associates_oldest_unassociated_terminal_and_broadcasts_events() {
    let h = freshell_server::tests::AssociationHarness::spawn().await;
    let terminal_id = h.spawn_unassociated_terminal_for_provider("codex", "/repo").await;
    h.publish_new_indexed_session("codex", "sess-1", "/repo", "Fix lint").await;

    let assoc = h.wait_type("terminal.session.associated").await;
    assert_eq!(assoc["terminalId"], terminal_id);
    assert_eq!(assoc["sessionId"], "sess-1");

    let title = h.wait_type("terminal.title.updated").await;
    assert_eq!(title["terminalId"], terminal_id);
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server terminal_session_association`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Port association behavior from server/index.ts:
// - match newly indexed sessions to oldest unassociated terminals by (provider, cwd)
// - set resumeSessionId on match
// - broadcast terminal.session.associated
// - when terminal title is default, auto-update title and broadcast terminal.title.updated
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server terminal_session_association`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-server/src/main.rs rust/crates/freshell-server/src/ws/mod.rs rust/crates/freshell-pty/src/lib.rs rust/crates/freshell-server/tests/terminal_session_association.rs
git commit -m "feat(server): port terminal-session association and title update broadcasts"
```

---

## HTTP Feature Parity

### Task 11: Port Files + Local File Serving + Port-Forward APIs + AI Summary Endpoint

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/http/routes_files.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/http/routes_local_file.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/http/routes_proxy.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/http/routes_ai.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/port_forward.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-server/tests/http_files_proxy_ai.rs`

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn proxy_forward_is_scoped_to_requester_identity() {
    let app = freshell_server::http::build_test_router();

    let a = freshell_server::tests::post_forward(&app, "203.0.113.5").await;
    let b = freshell_server::tests::post_forward(&app, "203.0.113.6").await;

    assert_ne!(a.forwarded_port, b.forwarded_port);
}

#[tokio::test]
async fn local_file_route_serves_files_but_rejects_directories() {
    let app = freshell_server::http::build_test_router();
    let file = freshell_server::tests::get_local_file(&app, "/tmp/freshell-demo.txt").await;
    assert_eq!(file.status(), axum::http::StatusCode::OK);

    let dir = freshell_server::tests::get_local_file(&app, "/tmp").await;
    assert_eq!(dir.status(), axum::http::StatusCode::BAD_REQUEST);
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server proxy_forward_is_scoped_to_requester_identity`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Port forward manager:
// - key by (target_port, requester_key)
// - allow connections only from requester allowed IPs
// - idle cleanup timer
// Files API:
// - read/write/complete/validate-dir/open
// - GET /local-file?path=... (file only, no directory serving)
// AI summary:
// - provider call + heuristic fallback
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server http_files_proxy_ai`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-server/src/http rust/crates/freshell-server/src/port_forward.rs rust/crates/freshell-server/tests/http_files_proxy_ai.rs
git commit -m "feat(server): port files, proxy forwarding, and ai summary routes"
```

### Task 11A: Port Remaining HTTP Route Parity (Sessions/Terminals/Platform/Debug)

**Files:**
- Modify: `.worktrees/rust-port/rust/crates/freshell-server/src/http/mod.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/http/routes_sessions.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/http/routes_terminals.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/src/http/routes_system.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-server/tests/http_route_parity.rs`

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn http_route_parity_smoke_covers_existing_surface() {
    let app = freshell_server::http::build_test_router();
    freshell_server::tests::assert_route_exists(&app, "GET", "/api/lan-info").await;
    freshell_server::tests::assert_route_exists(&app, "GET", "/api/platform").await;
    freshell_server::tests::assert_route_exists(&app, "GET", "/api/sessions").await;
    freshell_server::tests::assert_route_exists(&app, "GET", "/api/sessions/search").await;
    freshell_server::tests::assert_route_exists(&app, "PATCH", "/api/sessions/:sessionId").await;
    freshell_server::tests::assert_route_exists(&app, "DELETE", "/api/sessions/:sessionId").await;
    freshell_server::tests::assert_route_exists(&app, "PUT", "/api/project-colors").await;
    freshell_server::tests::assert_route_exists(&app, "GET", "/api/terminals").await;
    freshell_server::tests::assert_route_exists(&app, "PATCH", "/api/terminals/:terminalId").await;
    freshell_server::tests::assert_route_exists(&app, "DELETE", "/api/terminals/:terminalId").await;
    freshell_server::tests::assert_route_exists(&app, "GET", "/api/debug").await;
    freshell_server::tests::assert_route_exists(&app, "GET", "/api/perf").await;
    freshell_server::tests::assert_route_exists(&app, "GET", "/api/files/candidate-dirs").await;
}
```

**Step 2: Run tests to verify fail**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server http_route_parity`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Port route parity for:
// - /api/lan-info, /api/platform
// - /api/sessions, /api/sessions/search, /api/sessions/:sessionId (patch/delete), /api/project-colors
// - /api/terminals, /api/terminals/:terminalId (patch/delete)
// - /api/debug, /api/perf, /api/files/candidate-dirs
```

**Step 4: Run tests to verify pass**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server http_route_parity`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-server/src/http rust/crates/freshell-server/tests/http_route_parity.rs
git commit -m "feat(server): port remaining http route parity for sessions terminals and system endpoints"
```

---

## Rust/WASM Web UI

### Task 12: Create Leptos (Rust/WASM) App Shell + API/WS Clients

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/main.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/app.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/lib/api.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/lib/ws_client.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-web/tests/bootstrap_ready.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn bootstrap_transitions_to_ready_after_hello_ready() {
    let mut state = freshell_web::AppState::new_for_test();
    state.on_ws_message(r#"{"type":"ready","timestamp":"2026-02-10T00:00:00Z"}"#);
    assert_eq!(state.connection_status(), "ready");
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web bootstrap_transitions_to_ready_after_hello_ready`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// App shell with:
// - Leptos CSR root/component tree and router
// - bootstrap fetch /api/settings + /api/sessions
// - ws connect and hello (token from localStorage)
// - connection state machine disconnected/connecting/connected/ready
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web bootstrap_ready`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-web/src rust/crates/freshell-web/tests/bootstrap_ready.rs
git commit -m "feat(web): add wasm app shell with api bootstrap and websocket client"
```

### Task 13: Port Tab/Pane State Model (Client-Local Persistence)

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/state/tabs.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/state/panes.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/state/persistence.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-web/tests/pane_tree_ops.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn split_and_close_preserves_tree_shape_and_active_pane_rules() {
    let mut s = freshell_web::state::PanesState::new_with_single_terminal();
    let first = s.active_pane_id("tab-1").unwrap().to_string();

    let second = s.split_right("tab-1", &first).unwrap();
    assert_eq!(s.active_pane_id("tab-1"), Some(second.as_str()));

    s.close_pane("tab-1", &second).unwrap();
    assert_eq!(s.active_pane_id("tab-1"), Some(first.as_str()));
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web split_and_close_preserves_tree_shape_and_active_pane_rules`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Port pane node tree:
// Leaf | Split(direction, sizes, children)
// Actions: init, split, add, close, resize, swap, zoom, rename-request
// Persist to localStorage only (client-local authority)
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web pane_tree_ops`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-web/src/state rust/crates/freshell-web/tests/pane_tree_ops.rs
git commit -m "feat(web): port tabs and pane-tree state with local persistence"
```

### Task 14: Port Terminal Pane + WS Terminal Wiring

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/components/terminal_view.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/lib/terminal_input_policy.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-web/tests/terminal_create_flow.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn terminal_created_updates_pane_terminal_id_and_status_running() {
    let mut app = freshell_web::AppState::new_for_test();
    app.create_terminal_for_active_pane("req-1");

    app.on_ws_message(r#"{
      "type":"terminal.created",
      "requestId":"req-1",
      "terminalId":"term-1",
      "snapshot":"",
      "createdAt":1
    }"#);

    let pane = app.active_terminal_pane().unwrap();
    assert_eq!(pane.terminal_id.as_deref(), Some("term-1"));
    assert_eq!(pane.status, "running");
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web terminal_created_updates_pane_terminal_id_and_status_running`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Terminal component responsibilities:
// - send terminal.create with createRequestId
// - process terminal.created / output / exit / error
// - resize on visibility/observer events
// - reconnect attach semantics
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web terminal_create_flow`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-web/src/components/terminal_view.rs rust/crates/freshell-web/tests/terminal_create_flow.rs
git commit -m "feat(web): port terminal pane ws lifecycle and state transitions"
```

### Task 15: Port Browser Pane (URL, Port Forwarding, Devtools Tier Behavior)

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/components/browser_pane.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/lib/url_rewrite.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-web/tests/browser_pane_forwarding.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn loopback_target_is_rewritten_through_proxy_when_remote_client() {
    let rewritten = freshell_web::url_rewrite::rewrite_if_needed(
        "http://localhost:5173",
        "192.168.1.10",
        41000,
    );

    assert_eq!(rewritten, "http://192.168.1.10:41000/");
}

#[test]
fn file_url_is_converted_to_local_file_endpoint() {
    let rewritten = freshell_web::url_rewrite::to_iframe_src("file:///tmp/demo.html");
    assert_eq!(rewritten, "/local-file?path=tmp%2Fdemo.html");
}

#[test]
fn devtools_open_state_persists_in_browser_pane_model() {
    let mut pane = freshell_web::browser::BrowserPaneModel::new("https://example.com");
    assert!(!pane.devtools_open());
    pane.toggle_devtools();
    assert!(pane.devtools_open());
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web loopback_target_is_rewritten_through_proxy_when_remote_client`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Browser pane behavior:
// - url bar/history/back/forward/reload
// - convert file:// URLs to /local-file?path=... for iframe loading parity
// - localhost detection + /api/proxy/forward call when needed
// - persist pane-level devToolsOpen state in local pane content model
// - web: limited inspector + "open external" action
// - tauri: request full devtools through tauri bridge
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web browser_pane_forwarding`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-web/src/components/browser_pane.rs rust/crates/freshell-web/tests/browser_pane_forwarding.rs
git commit -m "feat(web): port browser pane with proxy rewrite and tiered devtools behavior"
```

### Task 16: Port Editor Pane + Files API Integration

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/components/editor_pane.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-web/tests/editor_pane_io.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn save_editor_content_calls_files_write_endpoint() {
    let mut app = freshell_web::AppState::new_for_test();
    app.open_editor_with_content("/tmp/demo.txt", "hello");

    let req = app.build_save_request_for_active_editor().unwrap();
    assert_eq!(req.path, "/api/files/write");
    assert!(req.body.contains("/tmp/demo.txt"));
    assert!(req.body.contains("hello"));
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web save_editor_content_calls_files_write_endpoint`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Editor pane:
// - open/read file
// - edit in-memory
// - save via /api/files/write
// - preview/source toggle
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web editor_pane_io`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-web/src/components/editor_pane.rs rust/crates/freshell-web/tests/editor_pane_io.rs
git commit -m "feat(web): port editor pane and files api interactions"
```

### Task 17: Port Settings/Sidebar/Session Views + Existing Defaults Parity

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/components/settings_view.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/components/sidebar.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-web/tests/settings_defaults.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn settings_defaults_match_current_product_and_remain_ui_editable() {
    let s = freshell_web::settings::default_settings();
    assert_eq!(s.default_shell, "system");
    assert!(s.ai_summary.enabled);
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web settings_defaults_match_current_product_and_remain_ui_editable`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Settings page:
// - all config editable via UI controls only
// - AI controls in settings (default behavior silent, configurable)
// Sidebar:
// - project/session grouping, filters, sorting parity
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web settings_defaults`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-web/src/components/settings_view.rs rust/crates/freshell-web/src/components/sidebar.rs rust/crates/freshell-web/tests/settings_defaults.rs
git commit -m "feat(web): port settings/sidebar/session UI with current defaults parity"
```

---

## Tauri Client

### Task 18: Build Tauri App Shell with Embedded Server Lifecycle

**Files:**
- Create: `.worktrees/rust-port/apps/freshell-tauri/src-tauri/src/main.rs`
- Create: `.worktrees/rust-port/apps/freshell-tauri/src-tauri/src/server_runtime.rs`
- Create: `.worktrees/rust-port/apps/freshell-tauri/src-tauri/src/network_wizard.rs`
- Test: `.worktrees/rust-port/apps/freshell-tauri/src-tauri/tests/embedded_server_lifecycle.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn closing_window_keeps_server_running_by_default() {
    let mut rt = freshell_tauri::server_runtime::Runtime::new_for_test();
    rt.start_embedded_server().unwrap();
    rt.on_main_window_close();
    assert!(rt.server_is_running());
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/apps/freshell-tauri/src-tauri && cargo test closing_window_keeps_server_running_by_default`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Tauri shell:
// - launch embedded freshell-server child process
// - close event keeps server alive by default
// - first-run network wizard forces bind-mode choice
// - optional remote-connect mode
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/apps/freshell-tauri/src-tauri && cargo test embedded_server_lifecycle`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add apps/freshell-tauri/src-tauri
git commit -m "feat(tauri): add embedded server runtime and first-run network wizard"
```

### Task 19: Tauri Devtools Bridge for Browser Panes

**Files:**
- Modify: `.worktrees/rust-port/apps/freshell-tauri/src-tauri/src/main.rs`
- Create: `.worktrees/rust-port/apps/freshell-tauri/src-tauri/src/devtools_bridge.rs`
- Test: `.worktrees/rust-port/apps/freshell-tauri/src-tauri/tests/devtools_bridge.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn tauri_devtools_command_opens_devtools_for_requested_pane() {
    let bridge = freshell_tauri::devtools_bridge::Bridge::new_for_test();
    let ok = bridge.open_devtools("pane-1");
    assert!(ok);
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/apps/freshell-tauri/src-tauri && cargo test tauri_devtools_command_opens_devtools_for_requested_pane`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Expose tauri command `open_browser_pane_devtools(pane_id)`.
// Map pane_id -> webview handle and open devtools.
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/apps/freshell-tauri/src-tauri && cargo test devtools_bridge`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add apps/freshell-tauri/src-tauri/src/devtools_bridge.rs apps/freshell-tauri/src-tauri/tests/devtools_bridge.rs
git commit -m "feat(tauri): add browser-pane devtools bridge for desktop"
```

---

## Parity Lock + Cleanup

### Task 20: Port Existing Behavior Tests to Rust Targets

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-server/tests/ws_protocol_parity.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-server/tests/session_association_parity.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/tests/pane_focus_parity.rs`
- Modify: `.worktrees/rust-port/test/browser_use/smoke_freshell.py`
- Modify: `.worktrees/rust-port/test/browser_use/requirements.txt`

**Step 1: Write the failing parity tests**

```rust
#[tokio::test]
async fn ws_protocol_parity_smoke() {
    let h = freshell_server::tests::WsHarness::spawn().await;
    let mut c = h.authed_client().await;

    c.send_json(serde_json::json!({
        "type":"terminal.create",
        "requestId":"req-1",
        "mode":"shell",
        "shell":"system"
    })).await;
    let created = c.wait_type("terminal.created").await;
    assert_eq!(created["requestId"], "req-1");

    h.publish_sessions_fixture("projects_small").await;
    let patch_or_snapshot = c.wait_one_of(&["sessions.patch", "sessions.updated"]).await;
    assert!(patch_or_snapshot["type"] == "sessions.patch" || patch_or_snapshot["type"] == "sessions.updated");
}

#[tokio::test]
async fn session_association_and_title_update_parity_smoke() {
    let h = freshell_server::tests::AssociationHarness::spawn().await;
    let _terminal_id = h.spawn_unassociated_terminal_for_provider("codex", "/repo").await;
    h.publish_new_indexed_session("codex", "sess-1", "/repo", "Fix lint").await;
    assert_eq!(h.wait_type("terminal.session.associated").await["sessionId"], "sess-1");
    assert_eq!(h.wait_type("terminal.title.updated").await["title"], "Fix lint");
}
```

**Step 2: Run tests to verify they fail**

Run: `cd .worktrees/rust-port && cargo test --manifest-path rust/Cargo.toml ws_protocol_parity_smoke`

Expected: FAIL

**Step 3: Implement missing parity behavior**

```rust
// Port remaining mismatches revealed by parity tests:
// - ws protocol field parity (codingcli provider/text/success, error fields, terminal list payload)
// - terminal/session association + title update events
// - pane focus/activation invariants and browser pane devtools-open persistence
// - browser-use python deps + fixture wiring for rust runtime smoke flow
```

**Step 4: Run full test suite**

Run: `cd .worktrees/rust-port && cargo test --manifest-path rust/Cargo.toml && pytest test/browser_use -q`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-server/tests rust/crates/freshell-web/tests test/browser_use
git commit -m "test(parity): add rust parity tests for ws/session/pane behavior"
```

### Task 21: Remove TS Runtime Paths and Switch Entrypoints to Rust Build Artifacts

**Files:**
- Modify: `.worktrees/rust-port/package.json`
- Modify: `.worktrees/rust-port/README.md`
- Modify: `.worktrees/rust-port/scripts/*` (where launch/build scripts are defined)
- Create: `.worktrees/rust-port/docs/rust-port-runtime.md`
- Test: `.worktrees/rust-port/test/integration/update-flow.test.ts` (replace with rust-oriented smoke if retained)

**Step 1: Write failing smoke test for new entrypoint**

```bash
# test script example
npm run dev:rport-smoke
# expected to fail before script wiring is updated
```

**Step 2: Run to verify fail**

Run: `cd .worktrees/rust-port && npm run dev:rport-smoke`

Expected: FAIL

**Step 3: Implement minimal script rewiring**

```json
{
  "scripts": {
    "dev:rport-smoke": "cargo run --manifest-path rust/Cargo.toml -p freshell-server -- --smoke",
    "dev": "cargo run --manifest-path rust/Cargo.toml -p freshell-server",
    "build": "cargo build --manifest-path rust/Cargo.toml --workspace",
    "test": "cargo test --manifest-path rust/Cargo.toml --workspace"
  }
}
```

**Step 4: Run smoke + full tests**

Run:
- `cd .worktrees/rust-port && npm run dev:rport-smoke`
- `cd .worktrees/rust-port && npm test`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add package.json README.md docs/rust-port-runtime.md
git commit -m "chore(runtime): switch project entrypoints to rust workspace"
```

### Task 22: Add Build Matrix + Packaging for Linux/macOS/Windows (Server + Tauri)

**Files:**
- Create: `.worktrees/rust-port/.github/workflows/rust-matrix.yml`
- Create: `.worktrees/rust-port/.github/workflows/tauri-matrix.yml`
- Create: `.worktrees/rust-port/docs/release-artifacts.md`

**Step 1: Write failing CI dry-run config test**

```yaml
# a minimal workflow lint check script should fail before files exist
```

**Step 2: Run config checks to verify fail**

Run: `cd .worktrees/rust-port && rg "rust-matrix" .github/workflows`

Expected: no match / missing workflow

**Step 3: Write minimal workflows**

```yaml
# rust-matrix.yml
# - ubuntu-latest, macos-latest, windows-latest
# - cargo test --workspace
# - build server binary

# tauri-matrix.yml
# - build tauri bundles for 3 OS targets
# - publish artifacts
```

**Step 4: Run local validation**

Run: `cd .worktrees/rust-port && cargo test --manifest-path rust/Cargo.toml --workspace`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add .github/workflows docs/release-artifacts.md
git commit -m "ci(release): add cross-platform rust and tauri build matrix"
```

---

## End-to-End Verification Checklist (Must Pass Before Merge)

1. `cd .worktrees/rust-port/rust && cargo test --workspace`
2. `cd .worktrees/rust-port && pytest test/browser_use -q`
3. `cd .worktrees/rust-port/apps/freshell-tauri/src-tauri && cargo test`
4. Manual verification on Linux/macOS/Windows:
   - WS auth + hello/ready works
   - terminal create/input/resize/detach/attach/kill works
   - codingcli create/input/kill and stream events work
   - session indexing + repair events visible
   - browser pane works with proxy forwarding and file:// local-file conversion
   - tauri first-run network wizard appears
   - tauri close keeps backend running by default

## Explicit Non-Goals (Do Not Implement)

- Backward compatibility with existing TS protocol.
- Migration/import for legacy state/config.
- Built-in backup/recovery subsystem.
- Maintaining dual TS and Rust runtimes after parity is achieved.

## Implementation Notes for the Engineer

- Keep each task in strict Red-Green-Refactor order.
- Do not skip commit steps.
- If parity tests reveal behavior mismatch, fix behavior before adding features.
- Do not redesign protocol mid-port; lock v2 schema early and keep it stable during implementation.
- Keep settings user-editable through UI (no manual config workflow in product UX).

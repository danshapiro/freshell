# Freshell Full Rust Port (+ Optional Tauri Client) Implementation Plan

**Goal:** Replace Freshell’s TypeScript/Node stack with a Rust backend and Rust/WASM frontend, and ship an optional Tauri desktop client with feature parity.

**Audience:** This spec is written for an implementer who has direct access to the Freshell source tree and can read existing code/tests while implementing.

**Architecture:** Build a new Rust workspace beside the current codebase, lock parity with tests, and port behavior subsystem-by-subsystem (protocol, PTY lifecycle, sessions/indexing/repair, UI pane system, browser/editor panes, settings, auth). The runtime is PTY-first (single terminal lifecycle path), with client-local workspace state and a shared Rust/WASM UI used by both browser and Tauri webview.

**Tech Stack:** Rust (Tokio, Axum, serde, tracing), portable PTY crate, Leptos (CSR) for Rust/WASM UI, wasm-bindgen JS interop shims for xterm.js + Monaco, Tauri v2, Python browser-use smoke/e2e tests, Cargo test/nextest.

---

## Product Decisions (Locked)

- Single-release parity cutover (backend + web UI + Tauri ship together in v1), implemented incrementally on a feature branch.
- Zero TypeScript application/runtime code in v1 deliverable; allow minimal plain-JS interop shims where required for JS libraries (xterm.js and Monaco).
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
- `server/config-store.ts` (settings/session overrides, atomic file persistence, single-writer mutex/queue semantics for write serialization)
- `server/sessions-sync/*` (sessions diff + patch/snapshot fanout semantics)
- `server/session-scanner/*` (Claude session scan/repair queue)
- `server/coding-cli/*` + `server/claude-indexer.ts` (session indexing/provider behavior)
- `server/files-router.ts` + `server/port-forward.ts` (files and proxy route semantics)
- `src/store/panesSlice.ts` + `src/store/paneTypes.ts` (pane tree state model)
- `src/components/TerminalView.tsx` (terminal client behavior + reconnect logic)
- `src/components/panes/BrowserPane.tsx` (browser pane, forwarding, devtools UX)
- `src/store/persistMiddleware.ts` (localStorage persistence writes for tabs/panes/workspace state)
- `src/store/crossTabSync.ts` (cross-tab propagation via storage/broadcast events; separate from persistence)
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
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum WsServerMessage {
    Ready { timestamp: String },
}
// Keep this enum as the protocol root type; Task 2 extends it rather than replacing it.
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
- Create: `.worktrees/rust-port/rust/crates/freshell-protocol/tests/ci_matrix_declared.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-protocol/tests/workspace_smoke.rs` (reused as matrix smoke target)

**Step 1: Write the failing CI check**

```rust
use std::fs;
use std::path::PathBuf;

#[test]
fn rust_smoke_matrix_workflow_exists_and_targets_three_oses() {
    let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    while !root.join(".git").exists() {
        root = root.parent().expect("repo root not found").to_path_buf();
    }
    let p = root.join(".github/workflows/rust-smoke-matrix.yml");
    let text = fs::read_to_string(&p).expect("workflow must exist");
    assert!(text.contains("ubuntu-latest"));
    assert!(text.contains("macos-latest"));
    assert!(text.contains("windows-latest"));
    assert!(text.contains("workspace_builds_protocol_crate"));
}
```

Expected: FAIL (workflow missing, test cannot read workflow file)

**Step 2: Write minimal implementation**

```yaml
# .github/workflows/rust-smoke-matrix.yml
# - trigger on pull_request and push
# - matrix: ubuntu-latest, macos-latest, windows-latest
# - run: cargo test --manifest-path rust/Cargo.toml -p freshell-protocol workspace_builds_protocol_crate
```

**Step 3: Run local validation**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-protocol rust_smoke_matrix_workflow_exists_and_targets_three_oses`

Expected: PASS

**Step 4: Commit**

```bash
cd .worktrees/rust-port
git add .github/workflows/rust-smoke-matrix.yml rust/crates/freshell-protocol/tests/ci_matrix_declared.rs
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
    // Editor pane remains HTTP-only (/api/files/*); no editor.* WS message family is expected.
    let client_types = [
        r#"{"type":"hello","token":"token-1234567890abcd","capabilities":{"sessionsPatchV1":true,"terminalAttachChunkV1":true}}"#,
        r#"{"type":"hello","capabilities":{"sessionsPatchV1":true}}"#,
        r#"{"type":"ping"}"#,
        r#"{"type":"terminal.create","requestId":"r1","mode":"shell","shell":"system"}"#,
        r#"{"type":"terminal.attach","terminalId":"t1"}"#,
        r#"{"type":"terminal.detach","terminalId":"t1"}"#,
        r#"{"type":"terminal.input","terminalId":"t1","data":"ls\n"}"#,
        r#"{"type":"terminal.resize","terminalId":"t1","cols":120,"rows":40}"#,
        r#"{"type":"terminal.kill","terminalId":"t1"}"#,
        r#"{"type":"terminal.list","requestId":"r2"}"#,
        r#"{"type":"terminal.meta.list","requestId":"r2m"}"#,
        r#"{"type":"codingcli.create","requestId":"r3","provider":"claude","prompt":"hi","cwd":"/tmp","resumeSessionId":"sess-prev","model":"sonnet","maxTurns":10,"permissionMode":"default","sandbox":"workspace-write"}"#,
        r#"{"type":"codingcli.create","requestId":"r4","provider":"codex","prompt":"hi"}"#,
        r#"{"type":"codingcli.input","sessionId":"s1","data":"continue\n"}"#,
        r#"{"type":"codingcli.kill","sessionId":"s1"}"#,
    ];
    for raw in client_types {
        let parsed: WsClientMessage = serde_json::from_str(raw).unwrap();
        let re = serde_json::to_string(&parsed).unwrap();
        assert!(re.contains("\"type\""));
    }
    let key_shape = serde_json::to_value(WsClientMessage::TerminalCreate {
        request_id: "shape-1".to_string(),
        mode: TerminalMode::Shell,
        shell: ShellType::System,
        cwd: None,
        resume_session_id: None,
        restore: None,
    }).unwrap();
    assert!(key_shape.get("requestId").is_some());
    assert!(key_shape.get("request_id").is_none());

    let server_types = [
        r#"{"type":"ready","timestamp":"2026-02-10T00:00:00Z"}"#,
        r#"{"type":"terminal.created","requestId":"r1","terminalId":"t1","snapshot":"","createdAt":1,"effectiveResumeSessionId":"sess-prev"}"#,
        r#"{"type":"terminal.created","requestId":"r1b","terminalId":"t2","snapshotChunked":true,"createdAt":2}"#,
        r#"{"type":"terminal.attached","terminalId":"t1","snapshot":"hello\n"}"#,
        r#"{"type":"terminal.attached.start","terminalId":"t1","totalCodeUnits":12,"totalChunks":2}"#,
        r#"{"type":"terminal.attached.chunk","terminalId":"t1","chunk":"hello\n"}"#,
        r#"{"type":"terminal.attached.end","terminalId":"t1","totalCodeUnits":12,"totalChunks":2}"#,
        r#"{"type":"terminal.detached","terminalId":"t1"}"#,
        r#"{"type":"terminal.output","terminalId":"t1","data":"hi\n"}"#,
        r#"{"type":"terminal.exit","terminalId":"t1","exitCode":0}"#,
        r#"{"type":"terminal.meta.updated","upsert":[{"terminalId":"t1","cwd":"/tmp","checkoutRoot":"/tmp","repoRoot":"/tmp","displaySubdir":".","branch":"main","isDirty":false,"provider":"codex","sessionId":"sess-1","tokenUsage":{"inputTokens":1,"outputTokens":2,"cachedTokens":0,"totalTokens":3,"contextTokens":0,"modelContextWindow":200000,"compactThresholdTokens":180000,"compactPercent":1},"updatedAt":2}],"remove":[]}"#,
        r#"{"type":"terminal.meta.list.response","requestId":"r2m","terminals":[{"terminalId":"t1","cwd":"/tmp","checkoutRoot":"/tmp","repoRoot":"/tmp","displaySubdir":".","branch":"main","isDirty":false,"provider":"codex","sessionId":"sess-1","tokenUsage":{"inputTokens":1,"outputTokens":2,"cachedTokens":0,"totalTokens":3,"contextTokens":0,"modelContextWindow":200000,"compactThresholdTokens":180000,"compactPercent":1},"updatedAt":2}]}"#,
        r#"{"type":"terminal.list.response","requestId":"r2","terminals":[{"terminalId":"t1","title":"Shell","description":"bash","mode":"shell","resumeSessionId":"abc","createdAt":1,"lastActivityAt":2,"status":"running","hasClients":true,"cwd":"/tmp"}]}"#,
        r#"{"type":"terminal.list.updated"}"#,
        r#"{"type":"terminal.title.updated","terminalId":"t1","title":"New Title"}"#,
        r#"{"type":"codingcli.created","requestId":"r3","sessionId":"s1","provider":"claude"}"#,
        r#"{"type":"codingcli.event","sessionId":"s1","provider":"claude","event":{"type":"assistant"}}"#,
        r#"{"type":"codingcli.exit","sessionId":"s1","provider":"claude","exitCode":0}"#,
        r#"{"type":"codingcli.stderr","sessionId":"s1","provider":"claude","text":"warn"}"#,
        r#"{"type":"codingcli.killed","sessionId":"s1","success":true}"#,
        r#"{"type":"sessions.updated","projects":[]}"#,
        r#"{"type":"sessions.updated","projects":[],"clear":true,"append":false}"#,
        r#"{"type":"sessions.patch","upsertProjects":[],"removeProjectPaths":[]}"#,
        r#"{"type":"session.status","sessionId":"abc","status":"healthy","chainDepth":2}"#,
        r#"{"type":"session.repair.activity","event":"scanned","sessionId":"abc","status":"healthy","chainDepth":2,"orphanCount":0}"#,
        r#"{"type":"settings.updated","settings":{}}"#,
        r#"{"type":"perf.logging","enabled":false}"#,
        r#"{"type":"terminal.idle.warning","terminalId":"t1","killMinutes":180,"warnMinutes":5,"lastActivityAt":1739145600000}"#,
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
pub enum TerminalMode {
    #[serde(rename = "shell")]
    Shell,
    #[serde(rename = "claude")]
    Claude,
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "opencode")]
    Opencode,
    #[serde(rename = "gemini")]
    Gemini,
    #[serde(rename = "kimi")]
    Kimi,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellType { System, Cmd, Powershell, Wsl }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodingCliProvider { Claude, Codex, Opencode, Gemini, Kimi }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode { Default, Plan, AcceptEdits, BypassPermissions }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode { ReadOnly, WorkspaceWrite, DangerFullAccess }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidMessage,
    UnknownMessage,
    RateLimited,
    InvalidTerminalId,
    InvalidSessionId,
    PtySpawnFailed,
    FileWatcherError,
    NotAuthenticated,
    InternalError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionHealthStatus { Healthy, Corrupted, Repaired }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WsClientMessage {
    #[serde(rename = "hello")]
    Hello {
        token: Option<String>,
        capabilities: Option<ClientCapabilities>,
        sessions: Option<HelloSessions>,
    },
    #[serde(rename = "terminal.create")]
    TerminalCreate {
        #[serde(rename = "requestId")]
        request_id: String,
        mode: TerminalMode,
        shell: ShellType,
        cwd: Option<String>,
        #[serde(rename = "resumeSessionId")]
        resume_session_id: Option<String>,
        restore: Option<bool>,
    },
    #[serde(rename = "terminal.attach")]
    TerminalAttach { #[serde(rename = "terminalId")] terminal_id: String },
    #[serde(rename = "terminal.detach")]
    TerminalDetach { #[serde(rename = "terminalId")] terminal_id: String },
    #[serde(rename = "terminal.input")]
    TerminalInput { #[serde(rename = "terminalId")] terminal_id: String, data: String },
    #[serde(rename = "terminal.resize")]
    TerminalResize { #[serde(rename = "terminalId")] terminal_id: String, cols: u16, rows: u16 },
    #[serde(rename = "terminal.kill")]
    TerminalKill { #[serde(rename = "terminalId")] terminal_id: String },
    #[serde(rename = "terminal.list")]
    TerminalList { #[serde(rename = "requestId")] request_id: String },
    #[serde(rename = "terminal.meta.list")]
    TerminalMetaList { #[serde(rename = "requestId")] request_id: String },
    #[serde(rename = "codingcli.create")]
    CodingCliCreate {
        #[serde(rename = "requestId")]
        request_id: String,
        provider: CodingCliProvider,
        prompt: String,
        cwd: Option<String>,
        #[serde(rename = "resumeSessionId")]
        resume_session_id: Option<String>,
        model: Option<String>,
        #[serde(rename = "maxTurns")]
        max_turns: Option<u32>,
        #[serde(rename = "permissionMode")]
        permission_mode: Option<PermissionMode>,
        sandbox: Option<SandboxMode>,
    },
    #[serde(rename = "codingcli.input")]
    CodingCliInput { #[serde(rename = "sessionId")] session_id: String, data: String },
    #[serde(rename = "codingcli.kill")]
    CodingCliKill { #[serde(rename = "sessionId")] session_id: String },
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientCapabilities {
    #[serde(rename = "sessionsPatchV1")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sessions_patch_v1: Option<bool>,
    #[serde(rename = "terminalAttachChunkV1")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_attach_chunk_v1: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloSessions {
    pub active: Option<String>,
    pub visible: Option<Vec<String>>,
    pub background: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WsServerMessage {
    #[serde(rename = "ready")]
    Ready { timestamp: String },
    #[serde(rename = "terminal.created")]
    TerminalCreated {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "terminalId")]
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        snapshot: Option<String>,
        #[serde(rename = "snapshotChunked")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        snapshot_chunked: Option<bool>,
        #[serde(rename = "createdAt")]
        created_at: u64,
        #[serde(rename = "effectiveResumeSessionId")]
        effective_resume_session_id: Option<String>,
    },
    #[serde(rename = "terminal.attached")]
    TerminalAttached { #[serde(rename = "terminalId")] terminal_id: String, snapshot: String },
    #[serde(rename = "terminal.attached.start")]
    TerminalAttachedStart {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        #[serde(rename = "totalCodeUnits")]
        total_code_units: usize,
        #[serde(rename = "totalChunks")]
        total_chunks: usize,
    },
    #[serde(rename = "terminal.attached.chunk")]
    TerminalAttachedChunk { #[serde(rename = "terminalId")] terminal_id: String, chunk: String },
    #[serde(rename = "terminal.attached.end")]
    TerminalAttachedEnd {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        #[serde(rename = "totalCodeUnits")]
        total_code_units: usize,
        #[serde(rename = "totalChunks")]
        total_chunks: usize,
    },
    #[serde(rename = "terminal.detached")]
    TerminalDetached { #[serde(rename = "terminalId")] terminal_id: String },
    #[serde(rename = "terminal.output")]
    TerminalOutput { #[serde(rename = "terminalId")] terminal_id: String, data: String },
    #[serde(rename = "terminal.exit")]
    TerminalExit { #[serde(rename = "terminalId")] terminal_id: String, #[serde(rename = "exitCode")] exit_code: i32 },
    #[serde(rename = "terminal.meta.updated")]
    TerminalMetaUpdated { upsert: Vec<TerminalMetaRecord>, remove: Vec<String> },
    #[serde(rename = "terminal.meta.list.response")]
    TerminalMetaListResponse { #[serde(rename = "requestId")] request_id: String, terminals: Vec<TerminalMetaRecord> },
    #[serde(rename = "terminal.list.response")]
    TerminalListResponse { #[serde(rename = "requestId")] request_id: String, terminals: Vec<TerminalListItem> },
    #[serde(rename = "terminal.list.updated")]
    TerminalListUpdated,
    #[serde(rename = "terminal.title.updated")]
    TerminalTitleUpdated { #[serde(rename = "terminalId")] terminal_id: String, title: String },
    #[serde(rename = "codingcli.created")]
    CodingCliCreated {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        provider: CodingCliProvider,
    },
    #[serde(rename = "codingcli.event")]
    CodingCliEvent { #[serde(rename = "sessionId")] session_id: String, provider: CodingCliProvider, event: serde_json::Value },
    #[serde(rename = "codingcli.exit")]
    CodingCliExit {
        #[serde(rename = "sessionId")]
        session_id: String,
        provider: CodingCliProvider,
        #[serde(rename = "exitCode")]
        exit_code: i32,
    },
    #[serde(rename = "codingcli.stderr")]
    CodingCliStderr { #[serde(rename = "sessionId")] session_id: String, provider: CodingCliProvider, text: String },
    #[serde(rename = "codingcli.killed")]
    CodingCliKilled { #[serde(rename = "sessionId")] session_id: String, success: bool },
    #[serde(rename = "sessions.updated")]
    SessionsUpdated {
        projects: Vec<serde_json::Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        clear: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        append: Option<bool>,
    },
    #[serde(rename = "sessions.patch")]
    SessionsPatch {
        #[serde(rename = "upsertProjects")]
        upsert_projects: Vec<serde_json::Value>,
        #[serde(rename = "removeProjectPaths")]
        remove_project_paths: Vec<String>,
    },
    #[serde(rename = "session.status")]
    SessionStatus {
        #[serde(rename = "sessionId")]
        session_id: String,
        status: SessionHealthStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "chainDepth")]
        chain_depth: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "orphansFixed")]
        orphans_fixed: Option<u64>,
    },
    #[serde(rename = "session.repair.activity")]
    SessionRepairActivity {
        event: String,
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<SessionHealthStatus>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "chainDepth")]
        chain_depth: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "orphanCount")]
        orphan_count: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "orphansFixed")]
        orphans_fixed: Option<u64>,
    },
    #[serde(rename = "settings.updated")]
    SettingsUpdated { settings: serde_json::Value },
    #[serde(rename = "perf.logging")]
    PerfLogging { enabled: bool },
    #[serde(rename = "terminal.idle.warning")]
    TerminalIdleWarning {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        #[serde(rename = "killMinutes")]
        kill_minutes: u64,
        #[serde(rename = "warnMinutes")]
        warn_minutes: u64,
        #[serde(rename = "lastActivityAt")]
        last_activity_at: u64,
    },
    #[serde(rename = "terminal.session.associated")]
    TerminalSessionAssociated {
        #[serde(rename = "terminalId")]
        terminal_id: String,
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(rename = "pong")]
    Pong { timestamp: String },
    #[serde(rename = "error")]
    Error {
        code: ErrorCode,
        message: String,
        #[serde(rename = "requestId")]
        request_id: Option<String>,
        #[serde(rename = "terminalId")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMetaRecord {
    pub terminal_id: String,
    pub cwd: Option<String>,
    pub checkout_root: Option<String>,
    pub repo_root: Option<String>,
    pub display_subdir: Option<String>,
    pub branch: Option<String>,
    pub is_dirty: Option<bool>,
    pub provider: Option<CodingCliProvider>,
    pub session_id: Option<String>,
    pub token_usage: Option<TokenUsageSummary>,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageSummary {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_tokens: u64,
    pub total_tokens: u64,
    pub context_tokens: Option<u64>,
    pub model_context_window: Option<u64>,
    pub compact_threshold_tokens: Option<u64>,
    // Must remain in 0..=100 (match source schema validation).
    pub compact_percent: Option<u8>,
}
```

Also implement a single outbound WS serializer in `freshell-server` so every server frame, including `terminal.output`, is emitted from `WsServerMessage` instead of ad-hoc JSON payloads.
Attach compatibility rule: emit `terminal.attached` for non-chunk-capable clients (and small-snapshot fast path), and `terminal.attached.start/chunk/end` for chunk-capable large snapshots.
In the protocol tests, add explicit key-name assertions for `requestId`, `terminalId`, `resumeSessionId`, and `lastActivityAt` to ensure camelCase wire keys stay correct.
Prefer explicit per-field `#[serde(rename = "...")]` on enum variants so wire keys stay stable across serde versions.

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

#[test]
fn auth_token_weak_common_value_is_rejected() {
    let err = freshell_server::auth::validate_auth_token("passwordpassword").unwrap_err();
    assert!(err.to_string().contains("weak"));
}

#[test]
fn auth_token_valid_value_is_accepted() {
    let ok = freshell_server::auth::validate_auth_token("token-1234567890abcd");
    assert!(ok.is_ok());
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

In the same task, scaffold `freshell-config` with full `UserConfig` parity:
- `settings`, `sessionOverrides`, `terminalOverrides`, `projectColors`, `recentDirectories`
- atomic write via temp file + rename with Windows retry/backoff behavior for EPERM/EACCES/EBUSY

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
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::Value;
use tower::ServiceExt;

#[tokio::test]
async fn settings_requires_auth_and_supports_patch_put_roundtrip() {
    let app = freshell_server::http::build_test_router();

    let unauth = app.clone()
        .oneshot(Request::builder()
            .method("GET")
            .uri("/api/settings")
            .body(Body::empty())
            .unwrap())
        .await
        .unwrap();
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);

    let patched = app.clone()
        .oneshot(Request::builder()
            .method("PATCH")
            .uri("/api/settings")
            .header("x-auth-token", "token-1234567890abcd")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"defaultShell":"wsl"}"#))
            .unwrap())
        .await
        .unwrap();
    assert_eq!(patched.status(), StatusCode::OK);

    let put = app.clone()
        .oneshot(Request::builder()
            .method("PUT")
            .uri("/api/settings")
            .header("x-auth-token", "token-1234567890abcd")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"fontSize":16}"#))
            .unwrap())
        .await
        .unwrap();
    assert_eq!(put.status(), StatusCode::OK);

    let read_back = app
        .oneshot(Request::builder()
            .method("GET")
            .uri("/api/settings")
            .header("x-auth-token", "token-1234567890abcd")
            .body(Body::empty())
            .unwrap())
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&to_bytes(read_back.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["defaultShell"], "wsl");
    assert_eq!(body["fontSize"], 16);
}

#[tokio::test]
async fn api_routes_are_rate_limited_per_ip() {
    let app = freshell_server::http::build_test_router_with_rate_limit_for_test(3, 60_000);
    for _ in 0..3 {
        let ok = app.clone()
            .oneshot(Request::builder().method("GET").uri("/api/health").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
    }
    let throttled = app
        .oneshot(Request::builder().method("GET").uri("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(throttled.status(), StatusCode::TOO_MANY_REQUESTS);
}
// Test harness uses 3/60s for determinism; production parity remains 300/60s.
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
// - /api/* request-rate middleware parity (default 300 requests / 60 seconds, test-configurable)
// - trust-proxy configuration parity so requester IPs are correct behind reverse proxies
// auth middleware reads x-auth-token
// config writes are serialized through a single-writer async mutex to preserve atomic file semantics.
// settings update side effects must mirror source behavior:
// - apply debug logging toggle at runtime
// - propagate safety/scrollback changes into terminal registry settings
// - trigger session index refreshes where settings impact indexing behavior
// optional harness helpers can be added later; this test should compile/run with only tower::ServiceExt and axum primitives.
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
async fn attach_emits_chunked_snapshot_frames_before_live_output() {
    let mut reg = freshell_pty::TerminalRegistry::new_for_test();
    let term_id = reg.create_test_terminal("hello\nworld\n").await;

    let mut stream = reg
        .attach_stream_for_test_with_capabilities(&term_id, true)
        .await
        .unwrap();
    let start = stream.recv().await.unwrap();
    assert_eq!(start["type"], "terminal.attached.start");
    let first_chunk = stream.recv().await.unwrap();
    assert_eq!(first_chunk["type"], "terminal.attached.chunk");
    let end = stream.recv().await.unwrap();
    assert_eq!(end["type"], "terminal.attached.end");

    reg.push_test_output(&term_id, "world\n").await;
    let live = stream.recv().await.unwrap();
    assert_eq!(live["type"], "terminal.output");
    assert_eq!(live["data"], "world\n");
}

#[tokio::test]
async fn attach_legacy_or_small_snapshot_uses_terminal_attached_variant() {
    let mut reg = freshell_pty::TerminalRegistry::new_for_test();
    let term_id = reg.create_test_terminal("tiny\n").await;

    let mut stream = reg
        .attach_stream_for_test_with_capabilities(&term_id, false)
        .await
        .unwrap();
    let attached = stream.recv().await.unwrap();
    assert_eq!(attached["type"], "terminal.attached");
    assert_eq!(attached["terminalId"], term_id);
}

#[tokio::test]
async fn output_during_attach_window_is_queued_and_flushed_after_snapshot() {
    let mut reg = freshell_pty::TerminalRegistry::new_for_test();
    let term_id = reg.create_test_terminal("snap\n").await;

    let (mut stream, attach_token) = reg.attach_begin_for_test(&term_id).await.unwrap();

    reg.push_test_output(&term_id, "during-attach\n").await;
    reg.assert_no_live_output_before_attach_end_for_test(&mut stream).await;

    reg.finish_attach_snapshot_for_test(&term_id, attach_token).await.unwrap();
    let flushed = stream.recv().await.unwrap();
    assert_eq!(flushed["type"], "terminal.output");
    assert_eq!(flushed["data"], "during-attach\n");
}

#[tokio::test]
async fn registry_enforces_max_running_and_exited_terminal_limits() {
    let mut reg = freshell_pty::TerminalRegistry::new_for_test_with_limits(2, 1);
    let t1 = reg.create_test_terminal("a\n").await;
    let t2 = reg.create_test_terminal("b\n").await;
    let err = reg.try_create_test_terminal("c\n").await.unwrap_err();
    assert!(err.to_string().contains("MAX_TERMINALS"));

    reg.mark_test_terminal_exited_for_test(&t1).await;
    reg.mark_test_terminal_exited_for_test(&t2).await;
    assert_eq!(reg.exited_terminal_count_for_test(), 1);
}

#[tokio::test]
async fn detached_idle_terminal_warns_then_autokills() {
    let mut reg = freshell_pty::TerminalRegistry::new_for_test();
    reg.set_idle_policy_for_test(180, 5);
    let term_id = reg.create_test_terminal("idle\n").await;
    reg.detach_all_clients_for_test(&term_id).await;
    reg.set_last_activity_minutes_ago_for_test(&term_id, 176).await;
    reg.enforce_idle_kills_for_test().await;
    let warn = reg.take_idle_warning_for_test().unwrap();
    assert_eq!(warn["terminalId"], term_id);
    reg.set_last_activity_minutes_ago_for_test(&term_id, 181).await;
    reg.enforce_idle_kills_for_test().await;
    assert_eq!(reg.status_for_test(&term_id), "exited");
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-pty attach_emits_chunked_snapshot_frames_before_live_output`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// TerminalRegistry with:
// - create(mode, shell, cwd, resume_session_id)
// - chunked attach protocol: terminal.attached.start/chunk/end
// - fallback attach protocol: terminal.attached for non-chunk-capable clients (and small-snapshot fast path)
// - attach-begin/finish flow to avoid output loss during snapshot send
// - detach, input, resize, kill
// - ring buffer sized by character count (minimum floor 64 * 1024 chars, not bytes)
// - scrollback chars derived from settings.scrollback lines using approx 200 chars/line, then clamped to [64 * 1024, 2 * 1024 * 1024]
// - with default settings (5000 lines), effective default capacity is ~1_000_000 chars after conversion/clamp
// - support env overrides for max scrollback chars where parity source does
// - enforce MAX_TERMINALS (default 50) and MAX_EXITED_TERMINALS (default 200) with exited-terminal reaping
// - pending snapshot queue + bounded overflow handling
// - negotiated chunking via hello.capabilities.terminalAttachChunkV1
// - idle monitor parity: 30s poll, detached-only warnings, warnBeforeKillMinutes + autoKillIdleMinutes behavior
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

#[tokio::test]
async fn ws_closes_with_4009_on_server_shutdown() {
    let harness = freshell_server::tests::WsHarness::spawn().await;
    let mut client = harness.authed_client().await;
    harness.trigger_shutdown_for_test().await;
    let close = client.wait_close().await;
    assert_eq!(close.code, 4009);
}

#[tokio::test]
async fn ws_closes_with_4002_when_hello_timeout_expires() {
    let harness = freshell_server::tests::WsHarness::spawn_with_hello_timeout_ms(50).await;
    let mut client = harness.connect().await;
    let close = client.wait_close().await;
    assert_eq!(close.code, 4002);
}

#[tokio::test]
async fn ws_closes_with_4003_when_max_connections_is_exceeded() {
    let harness = freshell_server::tests::WsHarness::spawn_with_max_connections(1).await;
    let _first = harness.connect().await;
    let mut second = harness.connect().await;
    let close = second.wait_close().await;
    assert_eq!(close.code, 4003);
}

#[tokio::test]
async fn ws_keepalive_ping_closes_stale_connection_without_pong() {
    let harness = freshell_server::tests::WsHarness::spawn().await;
    let mut client = harness.authed_client().await;
    harness.disable_client_pong_for_test(&mut client).await;
    let close = client.wait_close().await;
    assert_eq!(close.code, 1006);
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server ws_rejects_without_valid_hello_token`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// WS handler:
// - start hello timer (default 5s)
// - parse hello, verify token, store capabilities (sessionsPatchV1 + terminalAttachChunkV1)
// - send ready + initial snapshot messages
// - protocol-level ping interval (30s) with liveness tracking; terminate stale sockets
// - close with 4001/4002/4003/4008/4009 codes as needed (auth/hello-timeout/max-connections/backpressure/shutdown)
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
    h.force_client_buffered_amount(&mut c, (2 * 1024 * 1024) + 1).await;
    let close = c.wait_close().await;
    assert_eq!(close.code, 4008);
}

#[tokio::test]
async fn pending_snapshot_queue_closes_attach_on_overflow_when_policy_requires_it() {
    let mut reg = freshell_pty::TerminalRegistry::new_for_test_with_overflow_policy(
        freshell_pty::OverflowPolicy::CloseAttachOnOverflow,
    );
    let term_id = reg.create_test_terminal("seed\n").await;
    let (_stream, attach_token) = reg.attach_begin_for_test(&term_id).await.unwrap();
    reg.push_many_outputs_for_test(&term_id, 100_000).await;
    let outcome = reg.finish_attach_snapshot_for_test(&term_id, attach_token).await;
    assert!(matches!(
        outcome,
        Err(freshell_pty::AttachFinishError::SnapshotQueueOverflow { .. })
    ));
}
```

**Step 2: Run tests to verify fail**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server ws_backpressure`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Mirror source behavior:
// - close sockets when bufferedAmount exceeds MAX_WS_BUFFERED_AMOUNT (2 MiB, close code 4008)
// - maintain pending snapshot queues per attached client
// - bound pending queue growth with MAX_PENDING_SNAPSHOT_CHARS default 512 * 1024
// - close/detach when overflow threshold exceeded
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
    for i in 0..10 {
        c.send_json(serde_json::json!({
            "type":"terminal.create",
            "requestId": format!("req-{i}"),
            "mode":"shell",
            "shell":"system"
        })).await;
        let ok = c.wait_type("terminal.created").await;
        assert_eq!(ok["requestId"].as_str().unwrap(), format!("req-{i}"));
    }
    c.send_json(serde_json::json!({
        "type":"terminal.create",
        "requestId":"req-10",
        "mode":"shell",
        "shell":"system"
    })).await;
    let err = c.wait_type("error").await;
    assert_eq!(err["code"], "RATE_LIMITED");
}

#[tokio::test]
async fn terminal_create_restore_requests_bypass_rate_limit() {
    let h = freshell_server::tests::WsHarness::spawn().await;
    let mut c = h.authed_client().await;
    for i in 0..20 {
        c.send_json(serde_json::json!({
            "type":"terminal.create",
            "requestId": format!("restore-{i}"),
            "mode":"shell",
            "shell":"system",
            "restore": true
        })).await;
    }
    let err = c.try_wait_type("error").await;
    assert!(err.is_none());
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server ws_terminal_lifecycle`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Add WS dispatch for:
// terminal.create, terminal.attach, terminal.detach,
// terminal.input, terminal.resize, terminal.kill, terminal.list, terminal.meta.list
// plus request-id idempotency map and create rate limiter (default 10 terminal.create messages per 10s window;
// env-configurable via TERMINAL_CREATE_RATE_LIMIT and TERMINAL_CREATE_RATE_WINDOW_MS).
// restore=true requests bypass create rate limiting (parity behavior).
// all outbound events must be sent through a typed send_ws(WsServerMessage) helper (no raw JSON bypasses).
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
- Create: `.worktrees/rust-port/rust/crates/freshell-coding-cli/src/providers/opencode.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-coding-cli/src/providers/gemini.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-coding-cli/src/providers/kimi.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-coding-cli/src/provider_contract.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-coding-cli/tests/provider_contracts_doc.rs`
- Create: `.worktrees/rust-port/docs/provider-contracts.md`
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

#[test]
fn provider_contract_doc_defines_non_legacy_provider_behavior() {
    let doc = std::fs::read_to_string("docs/provider-contracts.md").unwrap();
    for provider in ["opencode", "gemini", "kimi"] {
        assert!(doc.contains(provider));
    }
    assert!(doc.contains("command name"));
    assert!(doc.contains("event stream shape"));
    assert!(doc.contains("stderr mapping"));
    assert!(doc.contains("kill semantics"));
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server codingcli_create_stream_input_kill_emits_expected_events`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Port session manager semantics from server/coding-cli/session-manager.ts:
// - provider registry (claude/codex/opencode/gemini/kimi in v1 protocol parity)
// - bounded event buffer and status transitions
// - stderr passthrough, input forwarding, kill semantics
// - providers unavailable on host return deterministic typed errors without crashing runtime
// Provider contract source:
// - claude/codex: parity from existing provider implementations in server/coding-cli/providers/*
// - opencode/gemini/kimi: explicit contract doc + golden fixtures in docs/provider-contracts.md and provider_contract.rs
//   (binary command names from CODING_CLI_COMMANDS, required env/cwd wiring, stream event shape,
//    stderr text field, kill semantics, unavailable-binary behavior)
// - docs/provider-contracts.md must include runnable fixture transcripts for create/input/kill per provider.
// Wire WS commands/events: codingcli.create/input/kill + created/event/exit/stderr/killed.
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server ws_codingcli_lifecycle`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-coding-cli rust/crates/freshell-server/src/ws/mod.rs rust/crates/freshell-server/tests/ws_codingcli_lifecycle.rs docs/provider-contracts.md
git commit -m "feat(coding-cli): port coding cli session manager and websocket lifecycle"
```

---

## Sessions, Indexing, Repair

### Task 8: Build Unified Provider Session Indexer (Claude/Codex/Opencode/Gemini/Kimi)

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/provider.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/providers/claude.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/providers/codex.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/providers/opencode.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/providers/gemini.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/providers/kimi.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-sessions/src/indexer.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-sessions/tests/indexer_projects.rs`

**Step 1: Write the failing test**

```rust
#[tokio::test]
async fn indexer_groups_sessions_by_project_sorted_by_recency() {
    let idx = freshell_sessions::Indexer::new_for_test();
    let fixture = freshell_sessions::tests::fixture_path("test/fixtures/sessions/healthy.jsonl");
    idx.ingest_fixture(&fixture).await.unwrap();

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
// Define Provider trait + parser impls for claude/codex/opencode/gemini/kimi.
// Build in-memory index keyed by project_path with sorted sessions.
// For providers without legacy on-disk formats in current TS source (opencode/gemini/kimi),
// use canonical event/session JSONL shape defined in docs/provider-contracts.md.
// Resolve fixture paths via CARGO_MANIFEST_DIR-aware helper so tests run from crate directories.
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

#[tokio::test]
async fn large_snapshot_is_chunked_with_clear_then_append_flags() {
    let h = freshell_server::tests::WsHarness::spawn().await;
    let mut legacy = h.legacy_client_without_patch_capability().await;
    h.publish_sessions_fixture("projects_very_large").await;

    let first = legacy.wait_type("sessions.updated").await;
    assert_eq!(first["clear"], true);
    let second = legacy.wait_type("sessions.updated").await;
    assert_eq!(second["append"], true);
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server sends_patch_to_capable_clients_snapshot_to_legacy_clients`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Add publish(next_projects):
// - diff previous vs next
// - compute serialized patch payload bytes (JSON wire size)
// - when serialized patch size <= 500 * 1024 bytes (MAX_WS_CHUNK_BYTES default):
//   - send sessions.patch to sessionsPatchV1 clients
//   - send full sessions.updated snapshot to legacy clients
// - when patch size > 500 * 1024 bytes:
//   - send full sessions.updated snapshot to all clients
//   - chunk oversized snapshots into multiple sessions.updated frames:
//     first frame includes clear=true, subsequent frames include append=true
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
async fn files_read_write_and_directory_errors_match_existing_contract() {
    let h = freshell_server::tests::HttpHarness::spawn().await;
    let temp = tempfile::tempdir().unwrap();
    let file_path = temp.path().join("nested").join("note.txt");
    let file_path_str = file_path.to_string_lossy().to_string();

    h.post_json("/api/files/write", serde_json::json!({
        "path": file_path_str,
        "content": "hello"
    })).await.assert_status(200);

    let read = h.get_json(&format!("/api/files/read?path={}", urlencoding::encode(&file_path_str)))
        .await
        .assert_status(200)
        .json();
    assert_eq!(read["content"], "hello");
    assert!(read["size"].is_number());
    assert!(read["modifiedAt"].is_string());

    let dir_read = h.get_json(&format!("/api/files/read?path={}", urlencoding::encode(temp.path().to_string_lossy().as_ref())))
        .await;
    assert_eq!(dir_read.status(), axum::http::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn files_complete_validate_and_open_routes_match_existing_semantics() {
    let h = freshell_server::tests::HttpHarness::spawn().await;
    let temp = tempfile::tempdir().unwrap();
    let src_dir = temp.path().join("src");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::write(src_dir.join("index.ts"), "").unwrap();
    std::fs::write(temp.path().join("package.json"), "{}").unwrap();

    let complete = h.get_json(&format!(
        "/api/files/complete?prefix={}&dirs=true",
        urlencoding::encode(temp.path().to_string_lossy().as_ref())
    )).await.assert_status(200).json();
    assert!(complete["suggestions"].as_array().unwrap().iter().all(|v| v["isDirectory"] == true));

    let validate = h.post_json("/api/files/validate-dir", serde_json::json!({
        "path": src_dir.to_string_lossy().to_string()
    })).await.assert_status(200).json();
    assert_eq!(validate["valid"], true);

    let open = h.post_json("/api/files/open", serde_json::json!({
        "path": src_dir.join("index.ts").to_string_lossy().to_string()
    })).await;
    assert_eq!(open.status(), axum::http::StatusCode::OK);
}

#[tokio::test]
async fn ai_summary_falls_back_to_heuristic_and_missing_terminal_is_404() {
    let h = freshell_server::tests::HttpHarness::spawn_with_ai_disabled().await;
    let terminal_id = h.spawn_terminal_with_buffer("line one\nline two\n").await;

    let summary = h.post_json(
        &format!("/api/ai/terminals/{terminal_id}/summary"),
        serde_json::json!({})
    ).await.assert_status(200).json();
    assert_eq!(summary["source"], "heuristic");
    assert!(summary["description"].as_str().unwrap().len() > 0);

    h.post_json("/api/ai/terminals/missing/summary", serde_json::json!({}))
        .await
        .assert_status(404);
}

#[tokio::test]
async fn local_file_route_serves_temp_files_but_rejects_directories() {
    let h = freshell_server::tests::HttpHarness::spawn().await;
    let temp = tempfile::tempdir().unwrap();
    let file_path = temp.path().join("freshell-demo.txt");
    std::fs::write(&file_path, "demo").unwrap();

    let file = h.get(&format!(
        "/local-file?path={}",
        urlencoding::encode(file_path.to_string_lossy().as_ref())
    )).await;
    assert_eq!(file.status(), axum::http::StatusCode::OK);

    let dir = h.get(&format!(
        "/local-file?path={}",
        urlencoding::encode(temp.path().to_string_lossy().as_ref())
    )).await;
    assert_eq!(dir.status(), axum::http::StatusCode::BAD_REQUEST);
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-server http_files_proxy_ai`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Port forward manager:
// - key by (target_port, requester_key)
// - allow connections only from requester allowed IPs
// - deduplicate concurrent forward() calls per (target_port, requester_key)
// - reuse existing forward for repeat requests and idle-cleanup stale entries
// Files API:
// - GET /api/files/read?path=... -> {content,size,modifiedAt}, 400 for directory, 404 for ENOENT
// - POST /api/files/write {path,content} -> create parent dirs, return {success,modifiedAt}
// - GET /api/files/complete?prefix=...&dirs=true|1 -> dirs-first sort, cap at 20, support ~ expansion
// - POST /api/files/validate-dir {path} -> {valid,resolvedPath}
// - POST /api/files/open {path,reveal?} -> platform launcher (explorer/open/xdg-open), detached child
// - GET /local-file?path=... serves files only (no directory serving, no auth requirement)
// AI summary:
// - 404 when terminal missing
// - provider call + deterministic heuristic fallback when AI disabled/fails
// - return {description, source: "ai" | "heuristic"}
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
    freshell_server::tests::assert_route_exists(&app, "POST", "/api/perf").await;
    freshell_server::tests::assert_route_exists(&app, "POST", "/api/logs/client").await;
    freshell_server::tests::assert_route_exists(&app, "POST", "/api/ai/terminals/:terminalId/summary").await;
    freshell_server::tests::assert_route_exists(&app, "POST", "/api/proxy/forward").await;
    freshell_server::tests::assert_route_exists(&app, "DELETE", "/api/proxy/forward/:port").await;
    freshell_server::tests::assert_route_exists(&app, "GET", "/api/files/candidate-dirs").await;
}

#[tokio::test]
async fn perf_toggle_and_debug_endpoint_match_runtime_behavior() {
    let h = freshell_server::tests::HttpWsHarness::spawn().await;
    h.post_json("/api/perf", r#"{"enabled":true}"#).await.assert_status(200);
    assert_eq!(h.ws_client().wait_type("perf.logging").await["enabled"], true);
    let debug = h.get("/api/debug").await.assert_status(200).json();
    assert!(debug["connections"].is_number() || debug["terminals"].is_array());
}

#[tokio::test]
async fn sessions_search_and_project_colors_match_validation_behavior() {
    let h = freshell_server::tests::HttpHarness::spawn().await;

    h.get("/api/sessions/search?tier=title")
        .await
        .assert_status(400);

    h.put_json("/api/project-colors", serde_json::json!({"projectPath":"/repo"}))
        .await
        .assert_status(400);

    h.put_json("/api/project-colors", serde_json::json!({"projectPath":"/repo","color":"#22c55e"}))
        .await
        .assert_status(200);
}

#[tokio::test]
async fn terminals_patch_updates_live_registry_and_emits_list_updated() {
    let h = freshell_server::tests::HttpWsHarness::spawn().await;
    let terminal_id = h.spawn_terminal_for_test().await;
    let mut ws = h.ws_client().await;

    h.patch_json(
        &format!("/api/terminals/{terminal_id}"),
        serde_json::json!({"titleOverride":"  New title  ","descriptionOverride":"desc"})
    ).await.assert_status(200);

    assert_eq!(ws.wait_type("terminal.list.updated").await["type"], "terminal.list.updated");
    let list = h.get("/api/terminals").await.assert_status(200).json();
    let updated = list.as_array().unwrap().iter().find(|t| t["terminalId"] == terminal_id).unwrap();
    assert_eq!(updated["title"], "New title");
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
// - /api/debug, /api/perf (POST), /api/ai/terminals/:terminalId/summary (POST)
// - /api/logs/client (POST), /api/proxy/forward (POST), /api/proxy/forward/:port (DELETE), /api/files/candidate-dirs
// - /api/perf must apply debug/perf toggle and broadcast perf.logging over WS
// - /api/debug must return runtime state snapshot for diagnostics
// - /api/sessions/search preserves validation semantics (bad query => 400 with details)
// - /api/project-colors requires both projectPath and color
// - /api/terminals PATCH mutates live registry title/description and broadcasts terminal.list.updated
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

### Task 12A: Add JS Interop Bridges for xterm.js and Monaco

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/js/terminal_bridge.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/js/editor_bridge.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/js/xterm_bridge.js`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/js/monaco_bridge.js`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/js/interop_contract.test.js`
- Test: `.worktrees/rust-port/rust/crates/freshell-web/tests/js_bridge_contract.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn js_bridge_contract_exposes_terminal_and_editor_mount_hooks() {
    let contract = freshell_web::js::bridge_contract_for_test();
    assert!(contract.contains("mountXterm"));
    assert!(contract.contains("xtermWrite"));
    assert!(contract.contains("mountMonaco"));
    assert!(contract.contains("monacoSetValue"));
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web js_bridge_contract_exposes_terminal_and_editor_mount_hooks`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// JS interop layer:
// - wasm-bindgen wrappers for xterm.js mount/write/resize/dispose
// - wasm-bindgen wrappers for Monaco mount/get/set/dispose
// - plain JS bridge modules (no TypeScript) as stable boundary
// - node:test interop contract tests for JS bridge functions
// - deterministic no-op test doubles for non-browser unit tests
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web js_bridge_contract`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-web/src/js rust/crates/freshell-web/js rust/crates/freshell-web/tests/js_bridge_contract.rs
git commit -m "feat(web): add wasm-bindgen interop bridges for xterm and monaco"
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
// Pane content kinds: terminal | browser | editor | picker
// Actions parity (all reducers): initLayout, resetLayout, splitPane, addPane, closePane,
// setActivePane, resizePanes, resizeMultipleSplits, resetSplit, swapSplit, replacePane,
// updatePaneContent, removeLayout, hydratePanes, updatePaneTitle, requestPaneRename,
// clearPaneRenameRequest, toggleZoom.
// Persisted state must include paneTitles + paneTitleSetByUser maps.
// hydratePanes must use smart terminal merge logic (createRequestId/terminalId/resumeSessionId aware),
// not naive overwrite.
// Persist to localStorage only (client-local authority), with editor-buffer stripping handled in persistence layer.
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

### Task 13A: Port Cross-Tab Sync (BroadcastChannel + Storage Event)

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/state/cross_tab_sync.rs`
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/state/persist_broadcast.rs`
- Test: `.worktrees/rust-port/rust/crates/freshell-web/tests/cross_tab_sync.rs`

**Step 1: Write the failing test**

```rust
#[test]
fn pane_state_change_in_one_tab_propagates_to_second_tab_context() {
    let mut a = freshell_web::tests::TabContext::new("tab-a");
    let mut b = freshell_web::tests::TabContext::new("tab-b");
    a.enable_cross_tab_sync();
    b.enable_cross_tab_sync();

    a.dispatch_split_right("tab-1");
    b.process_pending_cross_tab_events();

    assert_eq!(a.snapshot(), b.snapshot());
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web pane_state_change_in_one_tab_propagates_to_second_tab_context`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Port cross-tab sync behavior from src/store/crossTabSync.ts + src/store/persistBroadcast.ts:
// - publish persisted workspace mutations to BroadcastChannel when available
// - fallback to storage events when BroadcastChannel unavailable
// - ignore self-originated events via sender-id tagging
// - debounce/merge updates to avoid event storms
// - support skipPersist metadata to prevent hydration write-loops
// - flush pending persistence on visibilitychange/pagehide/beforeunload
// - preserve smart terminal merge behavior during cross-tab hydration
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web cross_tab_sync`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-web/src/state/cross_tab_sync.rs rust/crates/freshell-web/src/state/persist_broadcast.rs rust/crates/freshell-web/tests/cross_tab_sync.rs
git commit -m "feat(web): port broadcast and storage-event cross-tab workspace sync"
```

### Task 14: Port Terminal Pane + WS Terminal Wiring

**Files:**
- Create: `.worktrees/rust-port/rust/crates/freshell-web/src/components/terminal_view.rs`
- Modify: `.worktrees/rust-port/rust/crates/freshell-web/src/js/terminal_bridge.rs`
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
// - process terminal.created / terminal.attached / attached.start / attached.chunk / attached.end / output / exit / error
// - render terminal via xterm.js bridge from Task 12A
// - resize on visibility/observer events
// - reconnect attach semantics
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web terminal_create_flow`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-web/src/components/terminal_view.rs rust/crates/freshell-web/src/js/terminal_bridge.rs rust/crates/freshell-web/tests/terminal_create_flow.rs
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
//   (strip leading slash then encodeURIComponent to match current BrowserPane behavior)
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
- Modify: `.worktrees/rust-port/rust/crates/freshell-web/src/js/editor_bridge.rs`
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
// - render text editor via Monaco bridge from Task 12A
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web editor_pane_io`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add rust/crates/freshell-web/src/components/editor_pane.rs rust/crates/freshell-web/src/js/editor_bridge.rs rust/crates/freshell-web/tests/editor_pane_io.rs
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
    assert_eq!(s.theme, "system");
    assert_eq!(s.terminal.font_size, 16);
    assert_eq!(s.safety.auto_kill_idle_minutes, 180);
    assert_eq!(s.panes.default_new_pane, "ask");
    assert!(s.coding_cli.enabled_providers.contains(&CodingCliProvider::Claude));
    assert!(s.coding_cli.enabled_providers.contains(&CodingCliProvider::Codex));
}
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/rust-port/rust && cargo test -p freshell-web settings_defaults_match_current_product_and_remain_ui_editable`

Expected: FAIL

**Step 3: Write minimal implementation**

```rust
// Settings page:
// - all config editable via UI controls only
// - cover existing settings sections: terminal (including fontFamily/theme/scrollback), uiScale,
//   safety, sidebar (including recency-pinned sort mode), panes (including iconsOnTabs/defaultNewPane),
//   codingCli (enabledProviders + provider-level model/sandbox/permission/cwd options)
// - provider picker/options must derive from codingCli.enabledProviders so non-default providers
//   (opencode/gemini/kimi) appear when enabled
// - include config surfaces backed by UserConfig outside settings where UI touches them:
//   sessionOverrides, terminalOverrides, projectColors, recentDirectories
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
// - launch embedded freshell-server in-process via Rust crate API (single binary runtime model)
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
- Modify: `.worktrees/rust-port/test/browser_use/*.py` (rewrite flows to new Leptos DOM/a11y labels)
- Modify: `.worktrees/rust-port/test/browser_use/requirements.txt`

**Step 1: Write the failing parity tests**

```rust
#[tokio::test]
async fn ws_protocol_parity_smoke() {
    let h = freshell_server::tests::WsHarness::spawn().await;
    let (mut chunk_capable, mut legacy) = h.two_clients_with_attach_capability_split().await;

    chunk_capable.send_json(serde_json::json!({
        "type":"terminal.create",
        "requestId":"req-1",
        "mode":"shell",
        "shell":"system"
    })).await;
    let created = chunk_capable.wait_type("terminal.created").await;
    assert_eq!(created["requestId"], "req-1");
    let terminal_id = created["terminalId"].as_str().unwrap();

    chunk_capable.send_json(serde_json::json!({"type":"terminal.attach","terminalId":terminal_id})).await;
    assert_eq!(chunk_capable.wait_type("terminal.attached.start").await["terminalId"], terminal_id);
    assert_eq!(chunk_capable.wait_type("terminal.attached.chunk").await["terminalId"], terminal_id);
    assert_eq!(chunk_capable.wait_type("terminal.attached.end").await["terminalId"], terminal_id);

    legacy.send_json(serde_json::json!({"type":"terminal.attach","terminalId":terminal_id})).await;
    assert_eq!(legacy.wait_type("terminal.attached").await["terminalId"], terminal_id);

    chunk_capable.send_json(serde_json::json!({"type":"terminal.meta.list","requestId":"meta-1"})).await;
    assert_eq!(chunk_capable.wait_type("terminal.meta.list.response").await["requestId"], "meta-1");

    h.publish_sessions_fixture("projects_small").await;
    let patch_or_snapshot = chunk_capable.wait_one_of(&["sessions.patch", "sessions.updated"]).await;
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
// - rewrite browser-use flows for the new Leptos DOM while keeping semantic roles/labels stable
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
- Delete or archive: `.worktrees/rust-port/src/`, `.worktrees/rust-port/server/`, `.worktrees/rust-port/test/{client,server,integration,e2e}/` (TS runtime/test surfaces)
- Remove obsolete TS toolchain files once no longer referenced (`tsconfig*.json`, Vite config, TS-only lint config sections)
- Create: `.worktrees/rust-port/docs/rust-port-runtime.md`
- Create: `.worktrees/rust-port/test/rust_runtime_smoke.sh`

**Step 1: Write failing smoke test for new entrypoint**

```bash
# test/rust_runtime_smoke.sh
# assert rust server starts, serves /api/health, then exits cleanly
bash test/rust_runtime_smoke.sh
# expected to fail before script wiring is updated
```

**Step 2: Run to verify fail**

Run: `cd .worktrees/rust-port && bash test/rust_runtime_smoke.sh`

Expected: FAIL

**Step 3: Implement minimal script rewiring + TS runtime removal**

```json
{
  "scripts": {
    "dev:rport-smoke": "bash test/rust_runtime_smoke.sh",
    "dev": "cargo run --manifest-path rust/Cargo.toml -p freshell-server",
    "build": "cargo build --manifest-path rust/Cargo.toml --workspace",
    "test": "cargo test --manifest-path rust/Cargo.toml --workspace",
    "test:js-interop": "node --test rust/crates/freshell-web/js/*.test.js"
  }
}
```

```text
Also in this task:
- remove TS runtime directories/files listed above (or move under docs/archive/ts-runtime/ if historical retention is required)
- remove stale npm-only runtime deps no longer needed after xterm/monaco interop shims are pinned
- regenerate or remove JS lockfiles so they match the post-cutover package manifest
- ensure no command in README/scripts points to Node server entrypoints
- wire static frontend serving in rust runtime: serve compiled Leptos/WASM artifacts (HTML/JS/WASM/CSS) plus SPA fallback route in browser mode
```

**Step 4: Run smoke + full tests**

Run:
- `cd .worktrees/rust-port && bash test/rust_runtime_smoke.sh`
- `cd .worktrees/rust-port && npm run test:js-interop`
- `cd .worktrees/rust-port && npm test`

Expected: PASS

**Step 5: Commit**

```bash
cd .worktrees/rust-port
git add package.json README.md scripts docs/rust-port-runtime.md test/rust_runtime_smoke.sh
git add -A src server test/client test/server test/integration test/e2e tsconfig*.json
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
2. `cd .worktrees/rust-port && bash test/rust_runtime_smoke.sh`
3. `cd .worktrees/rust-port && pytest test/browser_use -q`
4. `cd .worktrees/rust-port/apps/freshell-tauri/src-tauri && cargo test`
5. Manual verification on Linux/macOS/Windows:
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

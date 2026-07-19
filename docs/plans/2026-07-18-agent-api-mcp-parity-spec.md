# Agent-API + MCP Parity for the Rust Tauri Port — Implementer-Ready Spec

- **Date:** 2026-07-18
- **Branch/HEAD:** `feat/rust-tauri-port` @ `f53196a4`
- **Frozen reference:** `server/`, `shared/`, `src/` (the legacy TypeScript implementation — DO NOT edit; port from it)
- **Status:** Read-only investigation → implementable spec. No production code changed by this document.
- **Goal:** Give an **external AI agent (Amplifier, over MCP)** full programmatic control of the Rust Freshell server — create panes (any mode, with `cwd`/`resumeSessionId`), send keys, capture, wait-for — so the agent can drive QA automation and the user's "open my sessions" ask against the Rust port exactly as it does against the legacy Node server.

---

## 1. Context & Problem Statement

The legacy Node server exposes two coupled surfaces:

1. **Agent-API** — a REST router (`server/agent-api/router.ts`, 1785 lines) that mutates the live tab/pane layout and terminal registry, and broadcasts a `ui.command` WebSocket frame that connected browser clients **fold into their Redux store** to materialize the tab/pane. This is what makes "an API call opens a real tab in my browser" work.
2. **MCP** — a thin **stdio** JSON-RPC server (`server/mcp/`) exposing a single `freshell` tool with `{action, params}` dispatch. Every action is a thin wrapper that calls the Agent-API over HTTP using `FRESHELL_URL` + `FRESHELL_TOKEN` from the environment.

The Rust port currently implements **only the OpenCode fresh-agent slice** of the Agent-API (create/send/capture/rename, and only for `agent="opencode"`), and has **no MCP surface at all**. An external Amplifier agent therefore cannot drive the Rust server.

This spec enumerates the full legacy surface with `file:line` anchors, measures the Rust delta, and orders the build so the QA lever (create → send-keys → capture → wait-for, plus MCP transport) lands first.

### The QA lever in one sentence
Because the legacy MCP server is a **transport-agnostic thin HTTP wrapper**, the moment the Rust server serves the REST Agent-API with the same shapes + `x-auth-token` auth, the **existing Node MCP stdio binary** can drive the Rust server unmodified — Amplifier spawns it with `FRESHELL_URL` pointed at the Rust port. That makes REST parity (Slice 1) the highest-leverage work, and MCP (Slice 2) a small wrapper/re-point.

---

## 2. Legacy Agent-API — Full Route Surface (legacy-exact)

**Auth:** every route requires the `x-auth-token` header (constant-time compare; `httpAuthMiddleware`). The Rust freshagent crate already mirrors this at `crates/freshell-freshagent/src/lib.rs:957` (`authorized`).

**Response envelopes** (`server/agent-api/response.ts`, mirrored in Rust at `lib.rs:965-992`):
- `ok(data, message)` → `{ status:'ok', data, message }` HTTP 200
- `approx(data, message)` → `{ status:'approx', data, message }` HTTP 200 (degraded / deadline-missed)
- `fail(message)` → `{ status:'error', message }` at an error status

**Router mount:** `createAgentApiRouter(...)` returns an Express `Router`; mounted under `/api`. All paths below are relative to `/api`.

### 2.1 Tab routes

| Method & Path | router.ts | Request body / query | Response `data` | ui.command emitted |
|---|---|---|---|---|
| `POST /tabs` | `695` | `{ name?, mode?, shell?, cwd?, browser?, editor?, resumeSessionId?, permissionMode?, model?, sandbox?, sessionRef?, agent?, effort? }` | `{ tabId, paneId, terminalId? }` | `tab.create` |
| `POST /tabs/:id/select` | `834` | — | `selectTab` result | `tab.select` |
| `PATCH /tabs/:id` | `840` | `{ name }` | `renameTab` result | `tab.rename` |
| `DELETE /tabs/:id` | `851` | — | `closeTab` result | `tab.close` |
| `GET /tabs/has` | `857` | `?target=` | `{ exists }` | — |
| `POST /tabs/next` | `863` | — | `selectNextTab` result | `tab.select` |
| `POST /tabs/prev` | `871` | — | `selectPrevTab` result | `tab.select` |
| `GET /tabs` | `879` | — | `{ tabs, activeTabId }` | — |
| `GET /layout/snapshot` | `885` | `?tabId=` | normalized snapshot `{ tabs, activeTabId, layouts, activePane, paneTitles, paneTitleSetByUser }` | — |

**`POST /tabs` behavior (the load-bearing route)** — three mutually-exclusive shapes:
- `agent` string present → delegates to `createFreshAgentPane` (rich-agent path; `router.ts:546`, `698-709`). Params consumed: `agent, cwd, model, name, effort`.
- `browser` truthy → `paneContent = { kind:'browser', url, devToolsOpen:false }` (`721`).
- `editor` truthy → `paneContent = { kind:'editor', filePath, language:null, readOnly:false, content:'', viewMode:'source', wordWrap:true }` (`723`).
- otherwise **terminal**: `effectiveMode = mode||'shell'`; resolve provider settings + Codex launch plan (`resolveSpawnProviderSettings`, `148`); `registry.create({ mode, shell, cwd, resumeSessionId, providerSettings, envContext:{tabId,paneId} })` (`744`); attach `{ kind:'terminal', terminalId, status:'running', mode, shell, sessionRef?|resumeSessionId?, initialCwd }` (`762`).
- On any failure: cleanup the created terminal/tab (`cleanupFailedCodexCreate` + `closeTab`) and return the mapped error status (`agentRouteErrorStatus`, `54`). **Atomic rollback is part of the contract.**
- `sessionRef` is sanitized via `sanitizeSessionRef` (shared/session-contract); Codex requires a structured `sessionRef` (raw `resumeSessionId` for codex is rejected — mirrored in MCP `rejectRawCodexResume`).

### 2.2 Pane routes

| Method & Path | router.ts | Request body / query | Response `data` | ui.command emitted |
|---|---|---|---|---|
| `GET /panes` | `898` | `?tabId=` | `{ panes }` | — |
| `GET /panes/:id/capture` | `904` | `?S=&J=&e=` | `text/plain` transcript/buffer | — |
| `GET /panes/:id/wait-for` | `959` | `?pattern=&stable=&exit=&prompt=&T=`(timeout) | `{ matched, reason? }` | — |
| `POST /panes/:id/split` | `1250` | `{ direction?, mode?, shell?, cwd?, browser?, editor?, resumeSessionId?, sessionRef?, agent?, model?, effort? }` | `{ paneId, terminalId? }` | `pane.split` |
| `PATCH /panes/:id` | `1396` | `{ name }` | `renamePane` result (+ `tabRenamed`) | `pane.rename` |
| `POST /panes/:id/close` | `1429` | — | `closePane` result | `pane.close` |
| `POST /panes/:id/select` | `1439` | `{ tabId? }` | `selectPane` result | `pane.select` |
| `POST /panes/:id/resize` | `1452` | `{ x?, y?, sizes?[2] }` | `resizePane` result | `pane.resize` |
| `POST /panes/:id/swap` | `1526` | `{ target|otherId }` | `swapPane` result | `pane.swap` |
| `POST /panes/:id/respawn` | `1546` | `{ mode?, shell?, cwd?, resumeSessionId?, sessionRef? }` | `{ terminalId }` | `pane.attach` |
| `POST /panes/:id/attach` | `1619` | `{ terminalId, sessionRef?, mode?, shell? }` | `{ terminalId }` | `pane.attach` |
| `POST /panes/:id/navigate` | `1654` | `{ url }` | — | `pane.attach` (browser content) |
| `POST /panes/:id/send-keys` | `1669` | `{ data|keys|text, sessionRef?, waitForCodexIdentity?, timeout? }` | terminal: `{ terminalId }`; fresh-agent: `{ paneId, sessionId, submittedTurnId, sessionRef, status }` | — |

**Capture semantics (`904`):** `S` = start line, `J` = join wrapped lines, `e` = include ANSI. Fresh-agent panes render the transcript (`renderFreshAgentTranscript`); terminal panes render the scrollback buffer (`renderCapture`); editor panes render buffer content; other kinds → 422 "use screenshot-pane".

**Wait-for semantics (`959`):** fresh-agent panes poll `getSnapshot().status === 'idle'`; terminal panes run `waitForMatch` over the rendered buffer against `pattern` (regex), `stable` (N seconds of no output), `exit`, or `prompt`. `T` = timeout seconds (default 30). Non-match at deadline → `approx({matched:false},'timeout')`.

**Send-keys semantics (`1669`):** fresh-agent panes call `runtimeManager.send(locator, {text, settings})` then **block until idle** (`waitForFreshAgentIdle`, up to `FRESH_AGENT_SEND_IDLE_TIMEOUT_MS = 600_000`), and on materialization persist the durable session + broadcast `freshAgent.session.materialized` (`1734`). Terminal panes normalize input (`normalizeTerminalInputPayload`) and `sendTerminalInput(registry, terminalId, data, { expectedSessionRef, waitForCodexIdentity })`; `waitForCodexIdentity` gates on Codex durable identity.

### 2.3 Command-execution routes

| Method & Path | router.ts | Request body | Response `data` |
|---|---|---|---|
| `POST /run` | `1154` | `{ command, name?, mode?, shell?, cwd?, capture?, detached?, timeout? }` | `{ terminalId, tabId, paneId, output? }` |
| `POST /screenshots` | `1070` | `{ scope:'pane'\|'tab'\|'view', paneId?, tabId?, name? }` | screenshot result (round-trips through client `ui.command{screenshot.capture}`) |

`POST /run` **always creates a new tab/pane** (`1179`), emits `ui.command{tab.create}` (`1201`), sends `command` (with a sentinel when `capture`), and if `capture && !detached` waits for the sentinel and returns trimmed `output`.

### 2.4 The `ui.command` client-materialization mechanism (critical)

This is how a server-side REST call makes a tab/pane appear in every connected browser.

1. **Server emit:** `wsHandler.broadcastUiCommand({ command, payload })` → `this.broadcast({ type:'ui.command', ...command })`
   - Definition: `server/ws-handler.ts:3658-3659`; `broadcast()` at `3641` fans out to every connected socket.
2. **Wire frame (shared contract):** `shared/ws-protocol.ts:748`
   ```ts
   export type UiCommandMessage = { type: 'ui.command'; command: string; payload?: unknown }
   ```
   (part of the `ServerMessage` union at `ws-protocol.ts:962`).
3. **Client fold:** `src/lib/ui-commands.ts:68` `handleUiCommand(msg, dispatch)` switches on `msg.command` and dispatches Redux actions:

| `command` | Client Redux dispatch (`ui-commands.ts`) |
|---|---|
| `tab.create` | `addTab(...)` + `initLayout({tabId,paneId,content})` (`79-108`) |
| `tab.select` | `setActiveTab(id)` (`109`) |
| `tab.rename` | `applyTabRename(...)` (`111`) |
| `tab.close` | `closeTab(id)` (`113`) |
| `pane.split` | `splitPane({tabId,paneId,direction,newContent,newPaneId})` (`115`) |
| `pane.close` | `closePaneWithCleanup(...)` (`123`) |
| `pane.select` | `setActiveTab` + `setActivePane(...)` (`125`) |
| `pane.rename` | `applyPaneRename(...)` (`128`) |
| `pane.attach` | `updatePaneContent({tabId,paneId,content})` (`134`) |
| `pane.resize` | `resizePanes({tabId,splitId,sizes})` (`136`) |
| `pane.swap` | `swapPanes({tabId,paneId,otherId})` (`138`) |
| `screenshot.capture` | async capture → replies `ui.screenshot.result` (`22-66`) |

**Rust status of this mechanism:** the frame type already exists — `freshell-protocol` `ServerMessage::UiCommand(UiCommand{ command:String, payload:Option<Value> })` at `crates/freshell-protocol/src/server_messages.rs:928` (camelCase serde), broadcast onto the shared `tokio::sync::broadcast` bus that `freshell-ws` fans out. The OpenCode create path already emits `ui.command{tab.create}` (`freshell-freshagent/src/lib.rs:1065`). **The wire + broadcast plumbing is done; only the additional commands/payload shapes and the client-fold parity remain** (the Rust port serves the frozen `src/` client, so `handleUiCommand` fold logic is already correct — the Rust server just has to emit the same commands with the same payloads).

### 2.5 CLI client as shape documentation

`server/cli/` (`index.ts` 31 KB, `args.ts`, `keys.ts`, `targets.ts`, `send-keys-args.ts`) is the reference consumer. Notable: `translateKeys` (`server/cli/keys.ts`) converts key tokens (`ENTER`, `C-c`, …) to bytes; `targets.ts:68` defines the ambiguous-title resolution the MCP mirrors. Use the CLI as an oracle for request/response shapes and target-resolution rules; it needs no Rust port itself.

---

## 3. Legacy MCP — Transport, Schema, Auth, Relationship

### 3.1 Transport & lifecycle
- **Entry:** `server/mcp/server.ts`. Uses `@modelcontextprotocol/sdk` `McpServer` + **`StdioServerTransport`** (stdio JSON-RPC). One tool registered: `freshell`. Hard rule: **no `console.log`** — it corrupts the stdio channel (`server.ts:7`).
- **Spawned per-terminal** as a child process by each coding-CLI agent. `server/mcp/config-writer.ts` injects the per-agent config: Claude `--mcp-config <file>`, Codex `-c mcp_servers.freshell.*` TOML, Gemini `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`, Kimi `--mcp-config-file`, OpenCode `<cwd>/.opencode/opencode.json`. Command is always `node <dist|tsx> server/mcp/server.js|ts` (`buildMcpServerCommandArgs`, `config-writer.ts:89`).

### 3.2 Tool schema (advertised)
`server/mcp/freshell-tool.ts`:
```ts
INPUT_SCHEMA = {
  action: z.string(),                              // e.g. new-tab, send-keys, capture-pane, wait-for
  params: z.record(z.string(), z.unknown()).optional(),  // { target, name, mode, direction, keys, url, scope, ... }
}
```
`ACTION_PARAMS` (`freshell-tool.ts:258-292`) is the per-action required/optional allow-list. Key rows:
- `new-tab`: opt `name, mode, shell, cwd, browser, editor, resume, sessionRef, prompt, agent, model, effort`
- `split-pane`: opt `target, direction, mode, shell, cwd, browser, editor, resume, sessionRef, agent, model, effort`
- `send-keys`: opt `target, keys, literal, sessionRef`
- `capture-pane`: opt `target, S, J, e`
- `wait-for`: opt `target, pattern, stable, exit, prompt, timeout`
- `run`: req `command`; opt `capture, detached, timeout, name, cwd`
- plus `list-tabs, select-tab, kill-tab, rename-tab, has-tab, next-tab, prev-tab, list-panes, select-pane, rename-pane, kill-pane, resize-pane, swap-pane, respawn-pane, summarize, display, list-terminals, attach, open-browser, navigate, screenshot, list-sessions, search-sessions, lan-info, fresh-send, health, help` + tmux aliases (`new-window→new-tab`, `split-window→split-pane`, …).

### 3.3 Auth & relationship to Agent-API
- `server/mcp/http-client.ts`: reads `FRESHELL_URL` (default `http://localhost:3001`) and `FRESHELL_TOKEN`; sends `x-auth-token` header; unwraps the `{status,data,message}` envelope.
- **`routeAction` is a thin dispatcher** (`freshell-tool.ts:579-908`): every action maps to one/few REST calls (e.g. `new-tab → POST /api/tabs (+ send-keys for prompt)`, `send-keys → resolve target then POST /api/panes/:id/send-keys`, `capture-pane → GET /api/panes/:id/capture`, `wait-for → GET /api/panes/:id/wait-for`). Target resolution (`resolveTabTarget`/`resolvePaneTarget`, `163-227`) itself uses `GET /api/tabs` + `GET /api/panes`. Caller identity comes from `FRESHELL_TAB_ID`/`FRESHELL_PANE_ID` env (`131-137`).

**Conclusion:** MCP holds no business logic. It is a stdio front-end to the REST Agent-API. Porting the REST surface unblocks MCP with either (a) reusing the existing Node stdio binary pointed at the Rust port, or (b) a small Rust stdio wrapper.

### 3.4 Drift check (frozen `server/` vs `origin/main`)
The frozen worktree's `server/mcp/` is **behind `origin/main` by 2 commits** (verified via `git log`/`git diff --stat`):
- `5aca24c0 feat: add Amplifier as a freshell CLI agent`
- `1b44c6fa fix(mcp): follow session-directory pagination in list/search-sessions`
- Diff stat: `freshell-tool.ts (+56/-3)`, `config-writer.ts (+7)`.

**Implication:** port MCP from `origin/main` (not the frozen tree) for `list-sessions`/`search-sessions` pagination and the Amplifier-CLI-agent wiring, OR explicitly scope those out and track as a follow-up. Flag this to the checklist reconciliation (`docs/plans/2026-07-18-checklist-reconciliation.md`).

---

## 4. Rust Port — Current State & Delta

### 4.1 What exists today
`crates/freshell-freshagent` — OpenCode-only fresh-agent slice. Router (`src/lib.rs:935`):
```rust
Router::new()
    .route("/api/tabs", post(create_tab))                    // agent="opencode" ONLY; else 400 "unknown agent" (lib.rs:1020)
    .route("/api/panes/{id}", patch(rename_pane))            // lib.rs:1092
    .route("/api/panes/{id}/send-keys", post(send_keys))     // cold-start serve, drive one turn, resolve on idle (lib.rs:1163)
    .route("/api/panes/{id}/capture", get(capture))          // render transcript (lib.rs:1321)
```
Plus sibling slices (do **not** add general tab/pane routes):
- `snapshot.rs` — `GET /api/fresh-agent/threads/{sessionType}/{provider}/{threadId}`
- `codex.rs` / `claude.rs` — `FreshCodexState`/`FreshClaudeState` (app-server / SDK bridges) + `PATCH /api/settings` fresh-clients toggle
- `opencode_ws.rs` — the OpenCode WS runtime backing `send_keys`

Server wiring: `crates/freshell-server/src/main.rs:574-575` merges `freshell_freshagent::router` + `snapshot::router`. Other REST routers exist for terminals/sessions/files/screenshots/etc. (`freshell-server/src/*.rs`) but **none implement the Agent-API tab/pane orchestration**.

**AGENT-08 e2e reference:** the OpenCode continuity tests drive REST `send-keys` on an opencode pane via the `send_keys` route above; specs at `test/e2e-browser/specs/opencode-restart-recovery.spec.ts`, `freshopencode-restart-recovery.spec.ts`, `agent-continuity-matrix.spec.ts`.

### 4.2 Delta to full legacy parity

| Surface | Legacy | Rust today | Delta |
|---|---|---|---|
| `POST /tabs` terminal modes (shell/claude/codex/gemini/kimi) | ✅ `router.ts:695` | ❌ (opencode agent only) | **BUILD** — terminal registry create + provider settings + Codex launch plan |
| `POST /tabs` browser/editor | ✅ | ❌ | **BUILD** |
| `POST /tabs` other rich agents (claude/codex/kilroy) | ✅ | ❌ (opencode only) | **BUILD** (wire to existing `FreshClaudeState`/`FreshCodexState`) |
| Tab list/select/rename/delete/has/next/prev | ✅ | ❌ | **BUILD** |
| `GET /layout/snapshot`, `GET /panes` | ✅ | ❌ | **BUILD** |
| `GET /panes/:id/capture` (terminal) | ✅ | ⚠️ transcript only (fresh-agent) | **EXTEND** to terminal buffers/editor |
| `GET /panes/:id/wait-for` | ✅ (terminal + fresh-agent) | ❌ | **BUILD** |
| `POST /panes/:id/split` | ✅ all content | ❌ | **BUILD** |
| pane close/select/resize/swap/respawn/attach/navigate | ✅ | ❌ (only `PATCH` rename) | **BUILD** |
| `POST /panes/:id/send-keys` (terminal) | ✅ | ⚠️ fresh-agent opencode only | **EXTEND** to terminals + other agents |
| `POST /run`, `POST /screenshots` | ✅ | ❌ / ⚠️(screenshots router exists) | **BUILD** / wire |
| `ui.command` frame + broadcast | ✅ | ✅ (`server_messages.rs:928`) | **REUSE** — emit remaining commands/payloads |
| MCP stdio server + `freshell` tool | ✅ `server/mcp/` | ❌ **none** | **BUILD or re-point Node binary** |

**Bottom line:** the Rust port has the auth, envelope, `ui.command` frame, broadcast bus, and the OpenCode fresh-agent slice. Everything else in the Agent-API — the entire terminal/browser/editor tab+pane orchestration and all of MCP — is missing. The delta is large but mechanical, and the frozen `src/` client already folds every `ui.command`, so server-side emission is the only client-facing work.

---

## 5. Checklist Mapping (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`)

The surface maps almost entirely to **P1 "Tab, pane, CLI, and MCP automation" (AUTO-01…AUTO-14)** plus a few P0 rich-agent IDs. Acceptance text (quoted):

- **AUTO-01 — Make `ui.layout.sync` authoritative** (`:363`): "Replace the OpenCode-only shadow layout with the real connected UI layout shared by browser, REST, CLI, and MCP." PW-RUST: "Create, rename, reorder, select, split, resize, and close content only through the visible UI, then fetch the layout snapshot and assert exact tab IDs/order, pane tree/ratios, titles, content, active tab, and active pane."
- **AUTO-02 — Complete provider-neutral tab creation** (`:366`): "Create shell, every terminal provider, browser, editor, and every rich-agent tab with cwd/model/effort/url/file options and atomic rollback on failure." PW-RUST parameterizes `POST /api/tabs` over every content type and forces each launcher to fail once (no empty tab / live record / child process left).
- **AUTO-03 — tab list, select, rename, delete, exists, next, previous** (`:369`): "Preserve order, selection, title rules, and owned-resource cleanup."
- **AUTO-04 — layout snapshot and pane listing** (`:372`): "Return the exact current layout with provider/session/terminal identities and the legacy tab-ID filter."
- **AUTO-05 — pane split for every content type with rollback** (`:375`).
- **AUTO-06 — pane rename, close, select, resize, swap, respawn** (`:378`): "Preserve stable pane IDs where the legacy route contract requires them… do not invent a pane-replace REST route."
- **AUTO-07 — attach-existing-terminal with identity checks** (`:381`).
- **AUTO-08 — browser-pane navigation** (`:384`).
- **AUTO-09 — pane send and capture with type-correct semantics** (`:387`): "Send text/control sequences to terminal panes, plain prompts to rich agents, and keep Editor capture-only."
- **AUTO-10 — wait-for** (`:390`): "Support text/regex, prompt, exit, rich-agent idle/waiting, timeout, and cancellation without matching another pane."
- **AUTO-11 — legacy `/api/run`** (`:393`): "Always create a new tab/pane… do not claim existing-pane execution, arbitrary env/input, or a real exit status that legacy never returned."
- **AUTO-13 — Complete every registered Freshell MCP command against Rust** (`:399`): "Generate the acceptance inventory from the actual registered tool definitions so a new or renamed command cannot escape coverage." PW-RUST: "Generate a table from the registered MCP definitions, have a deterministic fake agent call every row against a visible layout, and assert tool result plus DOM/API/process effect."
- **AUTO-14 — Target automation and screenshots to the correct client window** (`:402`).

P0 rich-agent IDs touched by the send/capture/create parity:
- **AGENT-01 — provider-neutral create/send** (`:283`) through "the same browser WebSocket and REST orchestration paths."
- **AGENT-08 — Preserve OpenCode continuity** (`:305`) — already implemented by the Rust `send_keys` route; PW-RUST `PW-RUST` at `:306` ("Send three prompts through REST/MCP to one OpenCode pane and assert one durable ID"). This spec must not regress it.
- **AGENT-13 — legacy command-execution and diff APIs** (`:321`) — overlaps `/api/run` (AUTO-11).
- **AGENT-20 — standalone `/api/fresh-agent/send`** (`:343`).
- **AGENT-22 — Materialize OpenCode placeholder identities exactly once** (`:349`) — the `send-keys` materialization edge.
- **AGENT-15 — Inject Freshell MCP tools into rich Claude and other providers** (`:328`) — the MCP `config-writer` per-agent injection.

---

## 6. QA-Lever Design — How Amplifier Consumes It

### 6.1 Transport & auth constraints
- Legacy MCP transport is **stdio only** (no SSE / streamable-http). The MCP process is a **child spawned by the client**; it talks REST to `FRESHELL_URL` with `x-auth-token: FRESHELL_TOKEN`.
- For a localhost Rust server this is ideal: no network listener for MCP, auth is the same token the Rust server already validates (`lib.rs:957`). The token is the value from the server's `.env` (`AUTH_TOKEN`).

### 6.2 Amplifier MCP client config
Amplifier registers a stdio MCP server. Example `.amplifier/mcp.json` (or equivalent MCP client config), pointing the **existing Node MCP binary** at the Rust port:
```jsonc
{
  "mcpServers": {
    "freshell": {
      "command": "node",
      "args": ["/path/to/freshell/dist/server/mcp/server.js"],   // or: node --import tsx server/mcp/server.ts (dev)
      "env": {
        "FRESHELL_URL": "http://localhost:3001",                 // the RUST server's REST port
        "FRESHELL_TOKEN": "<AUTH_TOKEN from the rust server's .env>"
      }
    }
  }
}
```
This is the **zero-Rust-MCP** path: once Slice 1 lands, the Node stdio binary drives the Rust server unchanged. Slice 2 optionally replaces it with a native Rust stdio wrapper (same tool schema) so the Rust server ships self-contained with no Node dependency.

### 6.3 Smoke workflow (the acceptance the lever must satisfy)
```
1. new-tab { mode:"amplifier"|"claude"|"shell", cwd:"/home/dan/code/freshell", resumeSessionId:"<id>" }
        → returns { tabId, paneId, terminalId }, and a REAL tab appears in the browser (via ui.command{tab.create})
2. wait-for { target:paneId, stable:5, timeout:120 }   → resolves when the pane goes quiet/idle
3. capture-pane { target:paneId, S:-200 }               → returns transcript/scrollback text
4. assert: transcript contains the resumed session's expected content
```
For the user's "open my sessions" ask: `list-sessions` / `search-sessions` (the `origin/main` paginated versions) to find durable IDs, then `new-tab { resumeSessionId }` per session.

---

## 7. Implementation Slices (ordered by value)

### Slice 1 — REST QA core (unblocks the lever + "open my sessions")
Highest leverage: the moment these land, the existing Node MCP binary can drive the Rust server end-to-end.
1. **`POST /api/tabs` full shape** — terminal modes (shell/claude/codex/gemini/kimi) via the terminal registry + provider settings + Codex launch plan; browser/editor content; keep the existing opencode-agent path; **atomic rollback** on failure; emit `ui.command{tab.create}` with the full payload (`router.ts:775-789`). Route the other rich agents (claude/codex/kilroy) into the existing `FreshClaudeState`/`FreshCodexState`.
2. **`POST /api/panes/:id/send-keys` (terminal)** — extend the current fresh-agent-only handler to terminal panes: normalize input, `waitForCodexIdentity`, `expectedSessionRef`. (Fresh-agent path already correct.)
3. **`GET /api/panes/:id/capture` (terminal/editor)** — extend beyond transcript to terminal scrollback + editor buffer with `S/J/e`.
4. **`GET /api/panes/:id/wait-for`** — terminal (`pattern`/`stable`/`exit`/`prompt`/`T`) + fresh-agent idle; pane isolation; `approx` on timeout.
5. **Read routes for target resolution** — `GET /api/tabs`, `GET /api/panes`, `GET /api/layout/snapshot` (MCP target resolution depends on these).

### Slice 2 — MCP transport
6. Ship the QA lever wiring: document + provide the `.amplifier/mcp.json` pointing the Node binary at the Rust port (from `origin/main`, to get session-directory pagination). Optionally implement a native Rust stdio MCP wrapper mirroring `INPUT_SCHEMA` + `ACTION_PARAMS` + `routeAction`, so no Node dependency ships.

### Slice 3 — Full Agent-API parity (the rest)
7. Tab: `select`, `rename` (PATCH), `delete`, `has`, `next`, `prev`.
8. Pane: `split` (all content types + rollback), `close`, `select`, `resize`, `swap`, `respawn`, `attach`, `navigate`.
9. `POST /api/run` (always-new-tab command execution).
10. `POST /api/screenshots` wiring to the existing screenshots router + `ui.command{screenshot.capture}` round-trip.
11. Emit the remaining `ui.command` variants (`tab.*`, `pane.*`) with legacy-exact payloads.

---

## 8. Test Plan

### 8.1 Route/unit tests (Rust, per handler)
For each ported route, an axum handler test asserting: auth rejection (401 without token), success envelope shape (`ok`/`approx`/`fail`), and the emitted `ui.command` (assert a frame lands on the broadcast bus with the exact `command` + payload keys). Mirror the frozen `router.ts` behavior table in §2.
- `POST /tabs`: terminal / browser / editor / opencode-agent / claude-agent; force launcher failure → assert rollback (no orphan tab/terminal).
- `send-keys`: terminal input written; fresh-agent turn → idle; Codex identity gate.
- `capture`: terminal scrollback with `S/J/e`; editor buffer; fresh-agent transcript; non-capturable kind → 422.
- `wait-for`: pattern match, `stable`, timeout→`approx`, pane isolation, invalid regex → error.
- `split`/`resize`/`swap`/`close`/`select`/`rename`/`respawn`/`attach`/`navigate`: envelope + `ui.command`.
- `run`: new tab created, capture sentinel round-trip, detached path.

### 8.2 One end-to-end: tab materializes in a REAL browser client via `ui.command`
Playwright (PW-RUST style, in `test/e2e-browser/specs/`): open a browser client against the Rust server, `POST /api/tabs {mode:'shell'}` via `page.request` with the auth token, and assert **the new tab + terminal pane appear in the DOM/layout** (folded from `ui.command{tab.create}`), then `GET /api/layout/snapshot` agrees with the visible hierarchy. This proves the server→`ui.command`→client-fold path end-to-end (§2.4). Extend to `pane.split`/`pane.close` for the layout-sync assertions AUTO-01/06 require.

### 8.3 One MCP smoke
With the Node MCP binary configured against the Rust port (§6.2): drive `new-tab → wait-for → capture-pane` for a shell (or opencode) pane and assert the tool results + the visible tab. This is the AUTO-13 acceptance in miniature and the AGENT-08 continuity guard (`send` three prompts, assert one durable ID) once the opencode path is exercised through MCP.

---

## 9. Risks

1. **Terminal registry coupling.** `POST /tabs` terminal mode depends on the terminal registry, provider-settings resolution, and the Codex app-server launch planner. The Rust port has terminals (`freshell-server/src/terminals.rs`) but the Agent-API create path must integrate with the same registry the WS `terminal.create` path uses — mismatched terminal lifecycle would leak PTYs (50-PTY limit). Verify shared ownership before building.
2. **`ui.command` payload fidelity.** The frozen `src/` client folds exact payload keys (§2.4). Any drift in a payload field (e.g. omitting `paneContent` vs `terminalId`) silently fails to materialize. Tests must assert payload keys, not just the command name.
3. **MCP drift vs `origin/main`.** Porting from the frozen tree would ship stale `list-sessions`/`search-sessions` (no pagination) and miss the Amplifier-CLI-agent wiring. Port MCP from `origin/main`.
4. **Codex identity gating.** `waitForCodexIdentity` / raw-resume rejection is subtle (`rejectRawCodexResume`, structured `sessionRef` required). Getting this wrong breaks Codex resume. Mirror the legacy guards exactly.
5. **Blocking send-keys timeout.** Fresh-agent `send-keys` blocks up to 600 s waiting for idle. Under MCP-driven QA this can stall the agent; ensure the `timeout` param is honored and returns `approx`.
6. **Screenshot round-trip.** `POST /screenshots` depends on a connected client to fulfill `ui.command{screenshot.capture}` and reply `ui.screenshot.result`. Headless/no-client scenarios must fail explicitly, not hang.

## 10. NOT-to-build fences (explicit scope guards)

- **Do NOT edit `server/`, `shared/`, or `src/`.** They are the frozen porting reference. The Rust port serves the same `src/` client.
- **Do NOT invent a pane-replace REST route.** Client-side content replacement is synchronized through `ui.layout.sync`/`AUTO-01`, per AUTO-06 (`:378`).
- **Do NOT add streaming or child-cancellation to `/api/run`.** Legacy returns a bounded buffered result; streaming is a separate product change, not parity (AGENT-13 `:321`, AUTO-11 `:393`).
- **Do NOT claim a real exit status for `/api/run`.** Legacy never returned one (AUTO-11).
- **Do NOT broadcast rich-agent content globally.** Isolate OpenCode by durable ID + cwd route (AGENT-16 `:331`, AGENT-23 `:352`).
- **Do NOT add new MCP actions or rename existing ones.** Parity means the exact registered `freshell` tool schema (`ACTION_PARAMS`); coverage is generated from the real definitions (AUTO-13).
- **Do NOT expose MCP over a network socket.** Transport stays stdio; auth stays `x-auth-token` on the REST hop.
- **Do NOT regress AGENT-08 OpenCode continuity** (one durable ID per pane across REST/MCP sends).

---

## Appendix A — Legacy `file:line` anchor index

- Agent-API router: `server/agent-api/router.ts` (routes at `695, 834, 840, 851, 857, 863, 871, 879, 885, 898, 904, 959, 1070, 1154, 1250, 1396, 1429, 1439, 1452, 1526, 1546, 1619, 1654, 1669`).
- `ui.command` server emit: `server/ws-handler.ts:3658`; wire type: `shared/ws-protocol.ts:748`; client fold: `src/lib/ui-commands.ts:68`.
- MCP: `server/mcp/server.ts` (stdio), `server/mcp/freshell-tool.ts` (schema+routeAction), `server/mcp/http-client.ts` (auth), `server/mcp/config-writer.ts` (per-agent injection).
- Rust port: `crates/freshell-freshagent/src/lib.rs` (router `935`, create `1009`/reject `1020`, rename `1092`, send-keys `1163`, capture `1321`, auth `957`, envelopes `965`); protocol `crates/freshell-protocol/src/server_messages.rs:928`; server wiring `crates/freshell-server/src/main.rs:574`.
- Checklist: `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` (AUTO-01…AUTO-14 `:361-403`; AGENT-01/08/13/15/20/22/23).

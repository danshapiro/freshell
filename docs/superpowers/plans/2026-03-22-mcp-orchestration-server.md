# MCP Orchestration Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken per-agent skill/plugin injection system with a single MCP server that all code agents (Claude Code, Codex, Gemini, Kimi, OpenCode) connect to automatically when spawned by Freshell.

**Architecture:** A lightweight MCP server (`server/mcp/server.ts`) exposes a single `freshell` tool with action dispatch (obra pattern). At terminal spawn time, Freshell writes a per-agent MCP config and injects it via CLI flags or environment variables. The MCP server uses the Freshell REST API (same as the existing CLI at `server/cli/`) to execute commands. This replaces the broken `--plugin-dir` (Claude), `-c skills.config` (Codex), and missing injection for Gemini/Kimi/OpenCode.

**Tech Stack:** `@modelcontextprotocol/sdk` (v1.27+), `zod`, Node.js stdio transport, Freshell REST API

---

**Execution note:** Use @trycycle-executing and keep the red-green-refactor order below. Execute in `/home/user/code/freshell/.worktrees/mcp-orchestration`.

## User-Visible Target

After this lands:

- Every coding CLI (Claude Code, Codex, Gemini, Kimi, OpenCode) spawned by Freshell automatically has a `freshell` MCP tool available without any user configuration.
- Agents can call `freshell({action: "help"})` to discover available commands, then use actions like `new-tab`, `split-pane`, `send-keys`, `capture-pane`, `screenshot`, etc. -- the same commands available via the existing CLI, but without requiring Bash tool approval for each call.
- The MCP tool replaces broken skill/plugin injection: Claude Code no longer gets `--plugin-dir` (broken symlink on WSL), Codex no longer gets `-c skills.config=[...]` (silently ignored TOML array syntax), and Gemini/Kimi/OpenCode gain orchestration capability they never had.
- Shell-mode terminals are unaffected -- no MCP injection for plain shells.
- The existing CLI fallback path continues to work; agents that happen to be running outside Freshell or inside the repo itself can still use the CLI via `npx tsx server/cli/index.ts`.
- Temp MCP config files are cleaned up when terminals exit.
- The MCP tool instructions in `server/mcp/freshell-tool.ts` become the canonical orchestration reference, with CLI examples retained inside the tool help text.

## Contracts And Invariants

1. **One mega-tool, not many.** The MCP server exposes exactly one tool named `freshell` with an `action` + `params` input schema. This follows the obra pattern for progressive disclosure: the tool description teaches the agent what actions exist, and the `help` action provides a full reference. Adding 30+ individual MCP tools would bloat every agent's context window.

2. **Environment-based context inheritance.** The MCP server process is spawned by the agent (not by Freshell). It inherits `FRESHELL_URL`, `FRESHELL_TOKEN`, `FRESHELL_TERMINAL_ID`, `FRESHELL_TAB_ID`, and `FRESHELL_PANE_ID` from the agent's environment (already injected by `TerminalRegistry.create()`). The MCP server reads these at startup to know which Freshell instance and terminal context it belongs to.

3. **REST API as the single source of truth.** The MCP server calls the same `/api/*` endpoints as the existing CLI. It does not import server internals, access the Redux store, or use WebSocket. This is a hard boundary: `server/mcp/` only depends on `server/mcp/http-client.ts` for Freshell interaction.

4. **No stdout corruption.** MCP stdio transport uses stdin/stdout for JSON-RPC. The MCP server must never use `console.log()`. Debug output uses `console.error()` only.

5. **Per-agent config injection is idempotent and isolated.** Each `generateMcpInjection()` call produces config that only adds the `freshell` MCP server. It does not modify the agent's existing MCP config (uses additive `--mcp-config` for Claude, `-c` overrides for Codex, env-based defaults for Gemini, additive `--mcp-config-file` for Kimi, and read-merge-write to project-local `.opencode/opencode.json` for OpenCode). OpenCode injection writes to the project-local config file (not the global `~/.config/opencode/config.json`), preserving per-terminal isolation. The project-local path is resolved from the terminal's cwd.

6. **Temp file cleanup on terminal exit.** When a terminal exits, its MCP config temp file (if any) is deleted. Files live in `os.tmpdir()/freshell-mcp/` with the terminal ID as filename. This is best-effort; the OS cleans `/tmp` on reboot as a backstop.

7. **Bell notification hooks are preserved.** The existing Claude `--settings` hooks (Stop hook with bell command) and Codex `-c tui.notification_method=bel` args are retained. MCP injection is additive to notification args, not a replacement.

8. **Dev/production detection for MCP server command.** When `process.env.NODE_ENV === 'production'`, the config uses `node <repoRoot>/dist/server/mcp/server.js`. Otherwise, it uses `node --import <repoRoot>/node_modules/tsx/dist/esm/index.mjs <repoRoot>/server/mcp/server.ts`. All paths are absolute, resolved from `import.meta.url` in `server/mcp/config-writer.ts`. The `--import` path must be absolute (not bare `tsx/esm`) because the MCP server process runs in the agent's cwd, not the repo root.

9. **Dead code removal is complete.** After MCP injection replaces skill/plugin injection: `claudePluginArgs()`, `codexOrchestrationSkillArgs()`, `codexSkillsDir()`, `encodeTomlString()`, `firstExistingPath()`, `firstExistingPaths()`, and all associated constants (`DEFAULT_FRESHELL_ORCHESTRATION_SKILL_DIR`, `LEGACY_FRESHELL_ORCHESTRATION_SKILL_DIR`, `DEFAULT_FRESHELL_DEMO_SKILL_DIR`, `LEGACY_FRESHELL_DEMO_SKILL_DIR`, `DEFAULT_FRESHELL_CLAUDE_PLUGIN_DIR`, `LEGACY_FRESHELL_CLAUDE_PLUGIN_DIR`, `DEFAULT_CODEX_HOME`) are removed from `terminal-registry.ts`. The orphaned `server/spawn-spec.ts` is deleted. In the follow-up safe cleanup, `SdkBridge.DEFAULT_PLUGIN_CANDIDATES` is removed, the legacy orchestration plugin/skill wrapper files are deleted, and agent-chat panes rely on MCP for Freshell orchestration while still allowing explicit plugin arrays for unrelated Claude SDK bundles.

10. **Test assertions update cleanly.** The existing `expectClaudeTurnCompleteArgs()` and `expectCodexTurnCompleteArgs()` test helpers in `terminal-registry.test.ts` are replaced with MCP-aware equivalents. The canonical orchestration docs coverage lives in `test/unit/server/mcp/freshell-tool.test.ts`; no separate standalone doc test remains.

## Root Cause Summary

- **Claude Code:** `--plugin-dir` pointed at a legacy Freshell orchestration wrapper whose pointer file was brittle on WSL (`core.symlinks=false`), so plugin-based orchestration was an unreliable transport.
- **Codex:** `-c skills.config=[{path=..., enabled=true}]` attempts TOML array-of-tables syntax via the `-c` dotted-path flag. The `-c` flag parses the value as TOML, but a TOML inline array containing inline tables with embedded paths is fragile and silently fails depending on Codex's TOML parser version.
- **Gemini/Kimi/OpenCode:** `providerNotificationArgs()` returns `[]` for these modes -- no orchestration injection attempted at all.

## Strategy Gate

**Chosen approach:** Single MCP server with per-agent config injection at spawn time.

- MCP is the only cross-agent protocol supported by all five target agents. Using it eliminates the need to maintain five different injection mechanisms (plugin dirs, skill configs, env vars, none, none).
- The obra pattern (one mega-tool with action dispatch) is proven for agentic MCP tools and keeps the per-agent context overhead to ~900 tokens for the tool description.
- Using the existing REST API as the backend means zero new server-side coupling. The MCP server is a thin translation layer.
- Per-agent config injection at spawn time (rather than global config modification) ensures isolation between terminals and avoids mutating the user's agent configs.

**Rejected approaches:**

- **Fix each injection mechanism individually:** Would require debugging WSL symlinks for Claude plugins, TOML array syntax for Codex skills, and inventing new mechanisms for Gemini/Kimi/OpenCode. Five bugs in five different systems vs. one clean replacement.
- **Global MCP config modification:** Writing to `~/.claude/settings.json`, `~/.codex/config.toml`, etc. at Freshell startup. Rejected because it mutates user configs, doesn't support per-terminal context, and requires cleanup on server shutdown. Per-terminal temp files are cleaner.
- **Multiple MCP tools instead of one mega-tool:** Would expose 30+ tools (one per CLI command), bloating every agent's tool list and context window. The obra pattern is specifically designed to avoid this.
- **WebSocket-based MCP transport instead of REST API:** The MCP server could connect to Freshell via WebSocket for real-time events. Rejected because the REST API already covers all needed commands, and WebSocket would add complexity for features not in scope (live output streaming to the MCP tool).
- **Shared library between CLI and MCP server:** Extracting common action-routing logic into a shared module. Rejected because the CLI uses positional args + flags while MCP uses structured JSON -- the parsing layers are fundamentally different and sharing would create coupling without real DRY benefit.

**Codex injection detail:** Verified experimentally that `-c 'mcp_servers.freshell.command="node"' -c 'mcp_servers.freshell.args=[...]'` works with Codex's `-c` flag. The value is parsed as TOML, and simple string/array values parse correctly (unlike the TOML array-of-tables that broke `skills.config`). This was confirmed by running `codex -c 'mcp_servers.freshell.command="echo"' -c 'mcp_servers.freshell.args=["hello"]' mcp list` and seeing the server appear.

**OpenCode injection detail:** OpenCode reads config from `~/.config/opencode/config.json` (global) and `.opencode/opencode.json` (project-local). It does not support `OPENCODE_CONFIG` as an env var. The plan writes to the project-local config file `.opencode/opencode.json` (resolved from the terminal's cwd), merging the `freshell` MCP entry with any existing config. This preserves the per-terminal isolation invariant — the global config is never mutated. The config writer reads-then-merges to avoid overwriting existing MCP servers. Cleanup on terminal exit removes the `freshell` key from the project-local config (or deletes the file if it was created by Freshell and contains only the freshell entry).

**Gemini injection detail:** Gemini CLI does not have `--mcp-config`. The documented approach is `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` env var, which points to a JSON file with system-level defaults (merged with user settings). The file format is the standard `{"mcpServers": {...}}` shape. Verified by examining Gemini CLI's settings loading order.

No user decision is required.

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `server/mcp/server.ts` | MCP server entry point: creates `McpServer`, registers the `freshell` tool, connects via `StdioServerTransport`. ~30 lines. |
| `server/mcp/freshell-tool.ts` | Tool definition: `TOOL_DESCRIPTION` (progressive disclosure), `INSTRUCTIONS` (mental model), `INPUT_SCHEMA`, `executeAction()` (action router to REST API). Core file. |
| `server/mcp/http-client.ts` | Minimal HTTP client for Freshell REST API. Reads `FRESHELL_URL`/`FRESHELL_TOKEN` from env. Mirrors the existing pattern from `server/cli/http.ts` and `server/cli/config.ts`. |
| `server/mcp/config-writer.ts` | `generateMcpInjection(mode, terminalId, cwd?)`: returns `{ args: string[], env: Record<string, string> }` per agent. `cleanupMcpConfig(terminalId, mode?, cwd?)`: deletes temp file on terminal exit (OpenCode: also cleans sidecar). |
| `test/unit/server/mcp/http-client.test.ts` | Unit tests for config resolution and HTTP request building. |
| `test/unit/server/mcp/freshell-tool.test.ts` | Unit tests for action routing, tool description, error handling, and help output. |
| `test/unit/server/mcp/config-writer.test.ts` | Unit tests for per-agent config generation and temp file cleanup. |
| `test/unit/server/mcp/server.test.ts` | Unit tests for MCP server initialization, tool registration, and transport connection. |

### Modified Files

| File | Change |
|------|--------|
| `package.json` | Add `@modelcontextprotocol/sdk` dependency |
| `server/terminal-registry.ts` | (1) Import `generateMcpInjection` and `cleanupMcpConfig` from `./mcp/config-writer.js`. (2) Thread `terminalId` and `cwd` through `buildSpawnSpec()` → `resolveCodingCliCommand()` → `providerNotificationArgs()`, where `generateMcpInjection()` is called and its args/env are merged into the existing call chain (MCP args flow through the same pipeline as notification args, correctly placed inside any shell wrapping). (3) Add `cleanupMcpConfig()` in `onExit`, `kill()`, and spawn-failure catch. (4) Remove dead code: `claudePluginArgs()`, `codexOrchestrationSkillArgs()`, `codexSkillsDir()`, `encodeTomlString()`, `firstExistingPath()`, `firstExistingPaths()`, and associated constants. (5) Update `providerNotificationArgs()` to remove plugin/skill calls (keep bell hooks). |
| `test/unit/server/terminal-registry.test.ts` | Replace `expectClaudeTurnCompleteArgs()` and `expectCodexTurnCompleteArgs()` helpers with MCP-aware equivalents. Add test cases for Gemini, Kimi, OpenCode MCP injection. |
| `server/sdk-bridge.ts` | Remove the default legacy orchestration plugin fallback while preserving explicit plugin arrays, and rely on MCP for Freshell orchestration in agent-chat panes. |
| `server/mcp/freshell-tool.ts` | Keep the canonical orchestration instructions and `help` text aligned with the `freshell` MCP surface. |

### Files to Delete

| File | Reason |
|------|--------|
| `server/spawn-spec.ts` | Orphaned duplicate of `buildSpawnSpec()` -- nothing imports it at runtime (verified: only referenced in docs/plans). |
| `legacy Freshell orchestration plugin wrapper` | Legacy Claude-only orchestration wrapper replaced by MCP for both terminals and agent-chat panes. |
| `legacy Freshell orchestration wrapper` | Replaced by the canonical MCP tool instructions in `server/mcp/freshell-tool.ts`. |
| `legacy Codex orchestration pointer` | No longer used for orchestration. |
| `obsolete standalone orchestration doc test` | Coverage lives in `test/unit/server/mcp/freshell-tool.test.ts`. |

**Note:** The follow-up safe cleanup removes the remaining orchestration wrapper files after `SdkBridge` stops defaulting them.

---

## MCP Config Injection Per Agent

Each agent has a different mechanism for accepting MCP server configuration at spawn time. All formats were verified experimentally.

| Agent | Mechanism | Config Format | Verified |
|-------|-----------|---------------|----------|
| **Claude Code** | `--mcp-config /tmp/freshell-mcp/{id}.json` (additive) | `{"mcpServers":{"freshell":{"command":"node","args":[...]}}}` | `claude --help` confirms `--mcp-config <configs...>` accepts JSON files |
| **Codex** | `-c 'mcp_servers.freshell.command="node"'` `-c 'mcp_servers.freshell.args=[...]'` | TOML values via `-c` flag | `codex -c 'mcp_servers.freshell.command="echo"' -c 'mcp_servers.freshell.args=["hello"]' mcp list` shows the server |
| **Gemini** | `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` env var pointing to temp JSON file | `{"mcpServers":{"freshell":{"command":"node","args":[...]}}}` | Gemini CLI docs; no `--mcp-config` flag exists |
| **Kimi** | `--mcp-config-file /tmp/freshell-mcp/{id}.json` | `{"mcpServers":{"freshell":{"command":"node","args":[...]}}}` | `kimi --help` confirms both `--mcp-config-file FILE` and `--mcp-config TEXT` |
| **OpenCode** | Read-merge-write to project-local `.opencode/opencode.json` (in terminal cwd) | `{"mcp":{"freshell":{"type":"local","command":["node","..."]}}}` | OpenCode reads `.opencode/opencode.json` (project-local) and `~/.config/opencode/config.json` (global); we use project-local to preserve per-terminal isolation. Note OpenCode format differs (`mcp` not `mcpServers`, `command` is a string array, needs `type: "local"`) |

The MCP server command itself is always:
```
node --import /absolute/path/to/freshell/node_modules/tsx/dist/esm/index.mjs /absolute/path/to/freshell/server/mcp/server.ts     # dev mode
node /absolute/path/to/freshell/dist/server/mcp/server.js                                                                        # production
```
**Important:** The `--import` path must be absolute (not `tsx/esm`) because the MCP server process runs in the agent's cwd, not the Freshell repo. Bare `tsx/esm` would fail to resolve outside the repo's `node_modules`.

The MCP server inherits `FRESHELL_URL` and `FRESHELL_TOKEN` from the agent's environment (already injected by Freshell into every spawned terminal).

---

## Tasks

### Task 1: Install `@modelcontextprotocol/sdk` dependency

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install the SDK**

```bash
cd /home/user/code/freshell/.worktrees/mcp-orchestration && npm install @modelcontextprotocol/sdk
```

- [ ] **Step 2: Verify installation**

```bash
cd /home/user/code/freshell/.worktrees/mcp-orchestration && node --input-type=module -e "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'; console.log('OK:', typeof McpServer)"
```
Expected: `OK: function`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add @modelcontextprotocol/sdk dependency for MCP orchestration server"
```

---

### Task 2: MCP HTTP Client

The MCP server needs to call the Freshell REST API. This is a minimal HTTP client that reads config from environment variables (same pattern as `server/cli/config.ts` and `server/cli/http.ts`).

**Justification for a separate client rather than importing `server/cli/http.ts`:** The CLI's `resolveConfig()` reads `~/.freshell/cli.json` as a fallback, which the MCP server doesn't need (it always gets config from env vars). The MCP client also handles agent API response envelopes (unwrapping `{ status, data }` → `data`). Keeping them separate avoids coupling the MCP server to the CLI's config resolution.

**Error handling two-layer design:** The HTTP client layer throws on non-OK responses (same as `server/cli/http.ts`). The tool layer (`executeAction()` in `freshell-tool.ts`) catches those exceptions and wraps them into structured JSON with recovery hints: `{ error: "...", hint: "Check that Freshell server is running..." }`. This separation keeps the HTTP client simple and reusable while letting the tool layer provide agent-friendly error messages.

**Files:**
- Create: `server/mcp/http-client.ts`
- Create: `test/unit/server/mcp/http-client.test.ts`

- [ ] **Step 1: Write failing tests for HTTP client**

Tests must cover:
1. `resolveConfig()` reads `FRESHELL_URL` and `FRESHELL_TOKEN` from environment
2. `resolveConfig()` defaults to `http://localhost:3001` when `FRESHELL_URL` not set
3. `createApiClient().get()` sends `x-auth-token` header when token is set
4. `createApiClient().get()` returns parsed JSON for JSON responses
5. `createApiClient().get()` throws on non-ok response with error details
6. `createApiClient().post()` sends JSON body with content-type header

Use `vi.stubGlobal('fetch', ...)` to mock fetch. Use `vi.resetModules()` + dynamic import pattern to isolate env var reads (same pattern as other env-dependent tests in this repo).

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test:vitest -- --run test/unit/server/mcp/http-client.test.ts
```
Expected: FAIL -- module `server/mcp/http-client.js` does not exist

- [ ] **Step 3: Implement HTTP client**

`server/mcp/http-client.ts` exports:
- `resolveConfig(): { url: string, token: string }` -- reads from `process.env.FRESHELL_URL` / `process.env.FRESHELL_TOKEN`, defaults to `http://localhost:3001` / `''`
- `createApiClient(config?)` -- returns `{ get, post, patch, delete }` methods that call `fetch()` with appropriate headers and error handling. Must handle both JSON responses (parse and unwrap `{ status, data }` envelopes from the agent API) and `text/plain` responses (return as string — used by `capture-pane`).

Mirror the structure of `server/cli/http.ts` but simpler (no config file fallback).

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

---

### Task 3: Freshell MCP Tool -- Action Router and Progressive Disclosure

This is the core of the MCP server: a single `freshell` tool that routes actions to REST API calls. The tool description teaches the agent what's available (obra pattern).

**Files:**
- Create: `server/mcp/freshell-tool.ts`
- Create: `test/unit/server/mcp/freshell-tool.test.ts`

- [ ] **Step 1: Write failing tests for action routing**

Tests must cover:
1. **Tab actions:** `new-tab` calls `POST /api/tabs`, `list-tabs` calls `GET /api/tabs`, `kill-tab` calls `DELETE /api/tabs/:id`, `rename-tab` calls `PATCH /api/tabs/:id`, `select-tab` calls `POST /api/tabs/:id/select`, `has-tab` calls `GET /api/tabs/has?target=...`, `next-tab` calls `POST /api/tabs/next`, `prev-tab` calls `POST /api/tabs/prev`
2. **Pane actions:** `split-pane` calls `POST /api/panes/:id/split`, `list-panes` calls `GET /api/panes`, `select-pane` calls `POST /api/panes/:id/select`, `rename-pane` calls `PATCH /api/panes/:id`, `kill-pane` calls `POST /api/panes/:id/close`, `resize-pane` calls `POST /api/panes/:id/resize`, `swap-pane` calls `POST /api/panes/:id/swap`, `respawn-pane` calls `POST /api/panes/:id/respawn`
3. **Terminal I/O:** `send-keys` calls `POST /api/panes/:id/send-keys`, `capture-pane` calls `GET /api/panes/:id/capture`, `wait-for` calls `GET /api/panes/:id/wait-for`, `run` calls `POST /api/run` with `{ command, capture?, detached?, timeout?, name?, cwd? }` (mirrors the existing CLI `run` command), `summarize` calls `POST /api/ai/terminals/:terminalId/summary` (the AI summary endpoint, not a pane endpoint), `display` performs client-side format-string expansion (fetches `GET /api/tabs` + `GET /api/panes` to resolve the target, then expands tokens like `#S` → tab name, `#P` → pane id — same logic as the CLI's `handleDisplay`), `list-terminals` calls `GET /api/terminals`, `attach` calls `POST /api/panes/:id/attach` with `terminalId`
4. **Browser:** `open-browser` calls `POST /api/tabs` with browser URL, `navigate` calls `POST /api/panes/:id/navigate`
5. **Screenshot:** `screenshot` calls `POST /api/screenshots` with `{ scope, name, paneId?, tabId? }`. The `name` field is **required** by the API (screenshot-path.ts throws "name required" if empty); if the MCP tool receives no `name` param, it defaults to `"screenshot"`. The MCP tool resolves the `target` param to the correct ID field: for `scope='pane'`, resolves target to `paneId` (required by the API); for `scope='tab'`, resolves target to `tabId` (required by the API); for `scope='view'`, no ID needed. If `target` is a tab title, the MCP tool resolves it to a tab ID via `GET /api/tabs` first (same as CLI's `resolveTabTarget`).
6. **Session:** `list-sessions` calls `GET /api/session-directory?priority=visible`, `search-sessions` calls `GET /api/session-directory?priority=visible&query=...`
7. **Info:** `lan-info` calls `GET /api/lan-info`
8. **Meta:** `health` calls `GET /api/health`, `help` returns full command reference text
8. **Error handling:** unknown action returns `{ error: "Unknown action '...'. Run action 'help' for available commands." }`, missing required param returns `{ error: "...", hint: "..." }`, API error returns `{ error: "...", hint: "Check that Freshell server is running..." }`
9. **Tool description:** `TOOL_DESCRIPTION` is a non-empty string mentioning key actions, `INSTRUCTIONS` is a non-empty string mentioning Freshell

Use `vi.mock('../../../../server/mcp/http-client.js', ...)` to provide a mock API client. (Note: test files under `test/unit/server/mcp/` are 4 levels deep from the repo root, so server imports need `../../../../server/`.)

The REST API endpoints are derived from reading `server/cli/index.ts` (the existing CLI) which maps CLI commands to HTTP calls. The MCP tool must cover the same command set.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement the freshell tool**

Create `server/mcp/freshell-tool.ts` with:

1. **`TOOL_DESCRIPTION`** -- compact description for the tool definition (~800 tokens). Contains:
   - What Freshell is (one sentence)
   - The action dispatch pattern with example
   - Key actions grouped by category (tab, pane, terminal I/O, screenshot, session)
   - Common parameter names (`target`, `name`, `mode`, `direction`, `keys`, `url`, `scope`)
   - Notes on target resolution (tab ID or title, pane ID or index). **Target resolution is implemented in the MCP tool** (not deferred to the API): `resolveTabTarget(target)` fetches `GET /api/tabs` and matches by ID or title (same as CLI's `resolveTabTarget`), `resolvePaneTarget(target)` fetches panes and matches by ID, index, or active pane. Tests must cover title-based tab resolution.

2. **`INSTRUCTIONS`** -- for the MCP server `instructions` field. Contains:
   - Mental model (tabs contain pane trees, panes contain terminals)
   - Environment setup (FRESHELL_URL/TOKEN already set)
   - Key workflow patterns (new-tab -> send-keys -> wait-for -> capture-pane)

3. **`executeAction(action, params)`** -- routes actions to REST API calls:
   - Tab actions: `new-tab`, `list-tabs`, `select-tab`, `kill-tab`, `rename-tab`, `next-tab`, `prev-tab`, `has-tab`
   - Pane actions: `split-pane`, `list-panes`, `select-pane`, `rename-pane`, `kill-pane`, `resize-pane`, `swap-pane`, `respawn-pane`
   - Terminal I/O: `send-keys`, `capture-pane`, `wait-for`, `run`, `summarize`, `display` (displays formatted info like pane title, session, dimensions), `list-terminals` (lists all terminal processes), `attach` (attaches a terminal to a pane)
   - Browser: `open-browser`, `navigate`
   - Screenshot: `screenshot`
   - Session: `list-sessions`, `search-sessions`
   - Info: `lan-info` (shows LAN access info)
   - Meta: `health`, `help`
   - Unknown: returns `{ error: "Unknown action '...'. Run action 'help' for available commands.", hint: "..." }`
   - API errors: catches and wraps with `{ error: "...", hint: "Check that the Freshell server is running and FRESHELL_URL/FRESHELL_TOKEN are set correctly." }`

4. **`INPUT_SCHEMA`** -- exported Zod-compatible schema object for the tool input:
   ```typescript
   {
     action: z.string().describe("Command: help, new-tab, list-tabs, split-pane, send-keys, capture-pane, screenshot, ..."),
     params: z.record(z.string(), z.unknown()).optional().describe("Named parameters for the action. Common: target, name, mode, direction, keys, url, scope"),
   }
   ```

**Parameter mapping convention:** The MCP tool accepts camelCase or kebab-case parameter names and normalizes them.

**`send-keys` supports two modes** (matching the CLI's `-l`/`--literal` flag):
- **Token mode** (default): `{ target: "p1", keys: ["ls", "ENTER"] }` — `keys` is an array of tokens. Each token is checked against the keymap from `server/cli/keys.ts`: `ENTER` → `\r`, `C-C` → `\x03`, `C-D` → `\x04`, `ESCAPE` → `\x1b`, `TAB` → `\t`, `BSPACE` → `\x7f`, `UP`/`DOWN`/`LEFT`/`RIGHT` → ANSI escape sequences, `SPACE` → ` `, and `C-<letter>` → control character. Unrecognized tokens pass through literally. This uses `translateKeys()` from `server/cli/keys.js`.
- **Literal mode**: `{ target: "p1", keys: "echo hello world\n", literal: true }` — `keys` is a raw string sent directly as `data` without any token translation. Use this for natural-language prompts, multi-word strings, or anything where whitespace splitting would mangle the input.

When `keys` is a string and `literal` is not true, it is treated as a single token (not split on whitespace) for backwards compatibility. The `help` action documents both modes.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

---

### Task 4: MCP Server Entry Point

The stdio MCP server that registers the freshell tool and connects via stdin/stdout.

**Files:**
- Create: `server/mcp/server.ts`
- Create: `test/unit/server/mcp/server.test.ts`

- [ ] **Step 1: Write failing tests for server initialization**

Tests must cover:
1. Creates `McpServer` with name `"freshell"` and version from package.json
2. Passes `INSTRUCTIONS` as the server instructions
3. Registers exactly one tool named `"freshell"` with the correct description and input schema
4. The tool handler calls `executeAction()` and wraps the result in MCP content format
5. Connects via `StdioServerTransport`

Mock `@modelcontextprotocol/sdk/server/mcp.js` and `@modelcontextprotocol/sdk/server/stdio.js` to capture registration calls. Mock `server/mcp/freshell-tool.js` to isolate from tool implementation.

**Important:** The server file has a top-level `await server.connect(transport)` which executes on import. Tests must mock the SDK before importing the server module.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement MCP server**

```typescript
// server/mcp/server.ts
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { TOOL_DESCRIPTION, INSTRUCTIONS, executeAction } from './freshell-tool.js'

// Resolve package.json relative to repo root (works in both src/ and dist/ layouts).
// In dev:  server/mcp/server.ts  → ../../package.json
// In prod: dist/server/mcp/server.js → ../../../package.json
// findPackageJson walks up from __dirname until it finds package.json.
function findPackageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf-8'))
      if (pkg.name === 'freshell') return pkg.version
    } catch { /* not found, keep walking */ }
    dir = dirname(dir)
  }
  return '0.0.0'
}

const server = new McpServer(
  { name: 'freshell', version: findPackageVersion() },
  { instructions: INSTRUCTIONS },
)

server.registerTool(
  'freshell',
  {
    description: TOOL_DESCRIPTION,
    inputSchema: {
      action: z.string().describe(
        'Command: help, new-tab, list-tabs, select-tab, kill-tab, rename-tab, '
        + 'split-pane, list-panes, select-pane, kill-pane, send-keys, capture-pane, '
        + 'wait-for, screenshot, run, health, ...',
      ),
      params: z.record(z.string(), z.unknown()).optional().describe(
        'Named parameters for the action. Common: target, name, mode, direction, keys, url, scope',
      ),
    },
  },
  async ({ action, params }) => {
    const result = await executeAction(action, params as Record<string, unknown> | undefined)
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
```

**Critical:** No `console.log()` -- it corrupts the stdio JSON-RPC channel. Use `console.error()` for debug output only.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Smoke test the MCP server (automated in test)**

Add a process-level smoke test to `test/unit/server/mcp/server.test.ts`:
- Spawn the real `server/mcp/server.ts` as a child process via `child_process.spawn('node', ['--import', tsxLoaderPath, serverPath])`
- Send JSON-RPC `initialize` on stdin
- Assert the stdout response contains `"name":"freshell"` and the tool `"freshell"` is registered
- Verify `console.log` was not called (no stdout corruption — only JSON-RPC frames)
- Kill the child process on test cleanup

Also add a **per-provider config generation verification** as a separate test file `test/unit/server/mcp/config-writer-paths.test.ts` (NOT in the main config-writer.test.ts, which mocks `fs`). This test uses the **real filesystem** (no `fs` mocking) to catch path resolution bugs:
- For each of the 5 agent modes (`claude`, `codex`, `gemini`, `kimi`, `opencode`), import `generateMcpInjection` from the real module (with `os.tmpdir` mocked to a test temp dir for safe temp file creation), generate the MCP injection, and verify:
  - The MCP server command is `"node"` (bare, resolved via PATH — no absolute path assertion)
  - The `--import` path (for dev mode) points to an existing file (absolute path to `tsx/dist/esm/index.mjs` in repo `node_modules/`) — verified via `fs.existsSync` on the real filesystem
  - The server.ts source path exists (absolute path to `server/mcp/server.ts`) — verified via `fs.existsSync` on the real filesystem
  - Clean up any temp files created during the test
- This is a separate file precisely because it needs real `fs` access while the main config-writer tests mock `fs` fully

- [ ] **Step 6: Commit**

---

### Task 5: MCP Config Writer

Generates per-agent MCP config for spawn-time injection. Each agent has its own format and injection mechanism.

**Files:**
- Create: `server/mcp/config-writer.ts`
- Create: `test/unit/server/mcp/config-writer.test.ts`

- [ ] **Step 1: Write failing tests**

Tests must cover:

**Per-agent injection:**
1. `claude` mode: returns `{ args: ['--mcp-config', '/tmp/freshell-mcp/term-abc.json'], env: {} }`, writes valid JSON with `mcpServers.freshell.command` = `"node"`
2. `codex` mode: returns `{ args: ['-c', 'mcp_servers.freshell.command="node"', '-c', 'mcp_servers.freshell.args=[...]'], env: {} }`, no temp file written
3. `gemini` mode: returns `{ args: [], env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: '/tmp/freshell-mcp/term-ghi.json' } }`, writes valid JSON with `mcpServers.freshell`
4. `kimi` mode: returns `{ args: ['--mcp-config-file', '/tmp/freshell-mcp/term-jkl.json'], env: {} }`, writes valid JSON with `mcpServers.freshell`
5. `opencode` mode: reads existing `.opencode/opencode.json` (project-local, in terminal cwd), merges `mcp.freshell` entry, writes back. Returns `{ args: [], env: {} }`. Preserves existing MCP servers in the config. Does NOT write to `~/.config/opencode/config.json` (global).
6. `shell` mode: returns `{ args: [], env: {} }`, no temp file written
7. Unknown mode: returns `{ args: [], env: {} }`, no temp file written

**Cleanup:**
8. `cleanupMcpConfig('term-abc')` deletes `/tmp/freshell-mcp/term-abc.json` if it exists
9. `cleanupMcpConfig('nonexistent')` does not throw
10a. `cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')` removes `freshell` key from `.opencode/opencode.json` in the given cwd when sidecar refcount reaches 0, preserving other MCP entries
10b. `cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')` deletes `.opencode/opencode.json`, sidecar, and `.opencode/` dir when freshell entry was the only content and sidecar indicates Freshell created the dir
10c. `cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')` does NOT remove `freshell` key when no sidecar file exists (user-managed entry)
10d. When two terminals share the same cwd, cleanup after the first terminal decrements sidecar refcount but does not remove the config; cleanup after the second terminal removes it
10e. `generateMcpInjection('opencode', ...)` writes only standard OpenCode config fields to `opencode.json` (no `_freshellManaged` or other custom keys)

**Dev/production detection:**
10. When `process.env.NODE_ENV === 'production'`, config uses `node` + `[builtPath]` (absolute path to `dist/server/mcp/server.js`)
11. When `NODE_ENV` is not `'production'`, config uses `node` + `['--import', absoluteTsxLoaderPath, srcPath]` (absolute paths to tsx ESM loader and `server/mcp/server.ts`)

Mock `fs` for file operations. For OpenCode tests, mock both `readFileSync` (to simulate existing config) and `writeFileSync` (to capture merged output).

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement config writer**

`server/mcp/config-writer.ts` exports:
- `generateMcpInjection(mode: string, terminalId: string, cwd?: string): { args: string[], env: Record<string, string> }` -- generates per-agent config (cwd needed for OpenCode project-local config)
- `cleanupMcpConfig(terminalId: string, mode?: string, cwd?: string): void` -- deletes temp config file; for OpenCode, also removes the `freshell` entry from project-local `.opencode/opencode.json`

Key implementation details:
- Resolves absolute paths from `import.meta.url` (ESM `__dirname` equivalent)
- Uses `fs.mkdirSync(tmpDir, { recursive: true })` for the temp directory
- Writes temp files with `mode: 0o600` (owner-only read/write)
- **OpenCode special handling:** reads existing `.opencode/opencode.json` (project-local, resolved from the terminal's cwd passed as a parameter), parses JSON, merges `mcp.freshell` into the `mcp` object, writes back. If the file doesn't exist, creates the directory and file with just the freshell entry. The `generateMcpInjection()` signature accepts an optional `cwd` parameter for this purpose. Ownership tracking uses a **sidecar file** (`<cwd>/.opencode/.freshell-mcp-state.json`) — NOT in-band keys in `opencode.json` — to avoid injecting unknown fields that could break OpenCode's schema parser. The sidecar stores: `{ managedKey: "freshell", refCount: N, createdDir: boolean, createdFile: boolean }`. On inject, the sidecar is created/updated with incremented refcount. On cleanup, the sidecar's refcount is decremented; when it reaches 0, the `freshell` key is removed from `opencode.json` and the sidecar is deleted. If the sidecar indicates Freshell created the `.opencode/` dir and no other config remains, both `opencode.json` and the directory are removed. If no sidecar exists at cleanup time (indicating a user-managed `freshell` entry), cleanup skips that key entirely.
- **Codex special handling:** no temp file -- injects via `-c` flags. The TOML value for `args` must be a TOML array literal: `'mcp_servers.freshell.args=["--import", "/absolute/path/to/node_modules/tsx/dist/esm/index.mjs", "/absolute/path/to/server/mcp/server.ts"]'` (absolute paths, not bare `tsx/esm`)

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

---

### Task 6: Integrate MCP Injection into Terminal Registry and Remove Dead Code

Replace the broken `providerNotificationArgs()` / `claudePluginArgs()` / `codexOrchestrationSkillArgs()` with MCP config injection, and clean up all dead code in a single task.

**Justification for combining integration and cleanup:** The dead code (plugin/skill injection functions) is replaced by MCP injection. Removing it in the same task as integrating MCP ensures there's no intermediate state where both old and new injection coexist. The test changes reference the new behavior, so the old test helpers must be replaced in the same commit.

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `test/unit/server/terminal-registry.test.ts`
- Delete: `server/spawn-spec.ts`
- Modify: `server/sdk-bridge.ts`
- Modify: `test/unit/server/sdk-bridge.test.ts`

- [ ] **Step 1: Update existing tests to expect MCP injection**

In `test/unit/server/terminal-registry.test.ts`:

Replace `expectClaudeTurnCompleteArgs()`:
```typescript
function expectClaudeMcpArgs(args: string[]) {
  // MCP config must be injected
  expect(args).toContain('--mcp-config')
  const configIndex = args.indexOf('--mcp-config')
  expect(args[configIndex + 1]).toContain('freshell-mcp')
  // Bell hook must still be present via --settings
  const command = getClaudeStopHookCommand(args)
  expect(command).toContain("printf '\\a'")
  // Old plugin-dir must NOT be present
  expect(args).not.toContain('--plugin-dir')
}
```

Replace `expectCodexTurnCompleteArgs()`:
```typescript
function expectCodexMcpArgs(args: string[]) {
  // Bell notification still present
  expect(args).toContain('-c')
  expect(args).toContain('tui.notification_method=bel')
  // MCP server config instead of skills.config
  const mcpArg = args.find(a => a.includes('mcp_servers.freshell'))
  expect(mcpArg).toBeDefined()
  // Old skills.config must NOT be present
  const skillsArg = args.find(a => a.startsWith('skills.config='))
  expect(skillsArg).toBeUndefined()
}
```

Add new test cases for gemini, kimi, opencode modes verifying MCP injection is present (these modes currently have no orchestration injection).

- [ ] **Step 2: Run tests to verify the old tests fail (red phase)**

```bash
npm run test:vitest -- --run test/unit/server/terminal-registry.test.ts
```
Expected: FAIL -- new expectations don't match old implementation

- [ ] **Step 3: Modify `terminal-registry.ts`**

Changes:
1. Add import: `import { generateMcpInjection, cleanupMcpConfig } from './mcp/config-writer.js'`
2. Remove dead constants: `DEFAULT_FRESHELL_ORCHESTRATION_SKILL_DIR`, `LEGACY_FRESHELL_ORCHESTRATION_SKILL_DIR`, `DEFAULT_FRESHELL_DEMO_SKILL_DIR`, `LEGACY_FRESHELL_DEMO_SKILL_DIR`, `DEFAULT_FRESHELL_CLAUDE_PLUGIN_DIR`, `LEGACY_FRESHELL_CLAUDE_PLUGIN_DIR`, `DEFAULT_CODEX_HOME`
3. Remove dead functions: `firstExistingPath()`, `firstExistingPaths()`, `codexSkillsDir()`, `codexOrchestrationSkillArgs()`, `claudePluginArgs()`, `encodeTomlString()`
4. Update `providerNotificationArgs()`: remove `...codexOrchestrationSkillArgs()` from codex branch and `...claudePluginArgs()` from claude branch. Keep bell notification hooks.
5. Add MCP cleanup in **four** paths:
   - In `ptyProc.onExit()` handler: `cleanupMcpConfig(terminalId, opts.mode, cwd)`
   - In `kill()` method: `cleanupMcpConfig(terminalId, term.mode, term.cwd)` (before `term.status = 'exited'`). Note: `kill()` sets status to `'exited'` before the PTY fires its `onExit` callback, which causes `onExit` to early-return. Without this, MCP config cleanup would be skipped for explicit kills.
   - In `remove()` method: cleanup is handled transitively via the `kill()` call.
   - **Spawn failure:** Wrap the `pty.spawn(...)` call in a try/catch. If spawn throws, immediately call `cleanupMcpConfig(terminalId, opts.mode, cwd)` to clean up the temp files/sidecar that were created by `generateMcpInjection()` before the spawn attempt, then rethrow. This prevents config file leaks when PTY spawn fails.

   The terminal record already stores `mode` and `cwd`, so these values are available in all exit paths.

**Injection approach (verified by reading `buildSpawnSpec()`):**

On Unix (the common case for coding CLIs), `buildSpawnSpec()` calls `resolveCodingCliCommand()` which calls `providerNotificationArgs(mode, target)`. The result flows through: `providerNotificationArgs()` -> `providerArgs` variable -> `[...providerArgs, ...baseArgs, ...settingsArgs, ...sessionArgs]` -> returned as `cli.args` -> used in `{ file: cli.command, args: cli.args }`. There is no shell wrapping on Unix for coding CLIs; they're spawned directly via `pty.spawn(command, args)`.

On WSL/Windows, the CLI is invoked as `wsl.exe --exec cli.command ...cli.args` or via PowerShell/cmd wrapping. Either way, `cli.args` (including notification args) are inside the wrapping.

Therefore, MCP args **must** flow through the `providerNotificationArgs()` -> `resolveCodingCliCommand()` -> `buildSpawnSpec()` pipeline to end up in the right place (inside any shell wrapping). MCP env vars must be merged into the `commandEnv` that `resolveCodingCliCommand()` already builds. **Do NOT append args after `buildSpawnSpec()` returns** — that would place them outside Windows wrapper commands and break CLI invocation semantics.

**Concrete changes to the call chain:**

1. Change `providerNotificationArgs()` signature from `(mode, target)` to `(mode, target, terminalId, cwd?)`. Change return type from `string[]` to `{ args: string[], env: Record<string, string> }`.

2. Inside `providerNotificationArgs()`, call `generateMcpInjection(mode, terminalId, cwd)` and merge the result:
   ```typescript
   function providerNotificationArgs(mode: TerminalMode, target: ProviderTarget, terminalId: string, cwd?: string): { args: string[], env: Record<string, string> } {
     const mcpInjection = generateMcpInjection(mode, terminalId, cwd)
     if (mode === 'codex') {
       return {
         args: ['-c', 'tui.notification_method=bel', '-c', "tui.notifications=['agent-turn-complete']", ...mcpInjection.args],
         env: mcpInjection.env,
       }
     }
     if (mode === 'claude') {
       // ... bell hook settings as before ...
       return { args: ['--settings', JSON.stringify(settings), ...mcpInjection.args], env: mcpInjection.env }
     }
     return { args: mcpInjection.args, env: mcpInjection.env }
   }
   ```

3. Update `resolveCodingCliCommand()` to accept `terminalId` and `cwd`, pass them to `providerNotificationArgs()`, and merge the returned env into `commandEnv`:
   ```typescript
   function resolveCodingCliCommand(mode, resumeSessionId, launchSessionId, target, providerSettings, terminalId, cwd?) {
     // ...
     const notification = providerNotificationArgs(mode, target, terminalId, cwd)
     const providerArgs = notification.args
     const commandEnv = { ...(spec.env || {}), ...notification.env }
     // ... rest unchanged, uses providerArgs as before ...
   }
   ```

4. Add `terminalId` as an 8th parameter to `buildSpawnSpec()` (cwd is already the 2nd parameter and flows through):
   ```typescript
   export function buildSpawnSpec(mode, cwd, shell, resumeSessionId?, providerSettings?, envOverrides?, launchSessionId?, terminalId?: string)
   ```
   This is already at 7 params; adding an 8th is not ideal but matches the existing style. The call chain is: `TerminalRegistry.create()` passes `terminalId` to `buildSpawnSpec()`, which passes both `terminalId` and `cwd` to `resolveCodingCliCommand()`, which passes them to `providerNotificationArgs()`. The `cwd` is needed for OpenCode's project-local config.

5. Update the call site in `TerminalRegistry.create()` to pass `terminalId`:
   ```typescript
   const { file, args, env, cwd: procCwd } = buildSpawnSpec(
     opts.mode, cwd, opts.shell || 'system',
     resumeForSpawn, opts.providerSettings,
     baseEnv, launchSessionId, terminalId,
   )
   ```

This keeps all "extra injection for this agent mode" in `providerNotificationArgs()`, preserves the existing args-flow through `resolveCodingCliCommand()` -> `buildSpawnSpec()`, and correctly places MCP args inside any shell wrapping.

- [ ] **Step 4: Delete orphaned files**

```bash
rm server/spawn-spec.ts
```

Verify `spawn-spec.ts` has no runtime imports first:
```bash
grep -r "from.*spawn-spec\|import.*spawn-spec\|require.*spawn-spec" server/ src/ shared/ --include='*.ts' --include='*.tsx'
```
Expected: no matches

**Note:** The later safe cleanup deletes the legacy orchestration plugin wrapper after `SdkBridge` stops defaulting it.

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm run test:vitest -- --run test/unit/server/terminal-registry.test.ts
```

- [ ] **Step 6: Run full test suite to check for regressions**

```bash
npm test
```
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: replace broken skill/plugin injection with MCP orchestration server

Replace claudePluginArgs(), codexOrchestrationSkillArgs(), and empty
Gemini/Kimi/OpenCode injection with a single MCP server that all five
agents connect to at spawn time.

Remove dead code: server/spawn-spec.ts and associated helper functions
and constants from terminal-registry.ts. Plugin directory retained for
SdkBridge agent-chat sessions."
```

---

### Task 7: Keep MCP Tool Instructions Canonical

The canonical orchestration reference now lives in `server/mcp/freshell-tool.ts`. Keep its `INSTRUCTIONS` and `HELP_TEXT` aligned with the supported MCP surface.

**Files:**
- Modify: `server/mcp/freshell-tool.ts`

- [ ] **Step 1: Update the `freshell` MCP tool instructions and help text**

Ensure the tool description, instructions, and `help` output cover:
- preferred use of the `freshell` MCP tool
- CLI examples only as fallback guidance
- concrete rename examples and caller-target defaults where supported

- [ ] **Step 2: Verify the canonical MCP help/instruction test still passes**

```bash
npm run test:vitest -- --config vitest.server.config.ts --run test/unit/server/mcp/freshell-tool.test.ts
```
Expected: PASS

- [ ] **Step 3: Run full test suite one final time**

```bash
npm run check
```
Expected: Typecheck + all tests pass

- [ ] **Step 4: Commit**

```bash
git add server/mcp/freshell-tool.ts test/unit/server/mcp/freshell-tool.test.ts
git commit -m "docs: keep freshell MCP tool instructions canonical"
```

---

## Post-Implementation Notes

### What's NOT in this plan (intentional deferrals)

1. **Extension manifest `mcpArgs` field** -- The injection is currently hardcoded in `config-writer.ts` per agent. Making it declarative via the manifest schema is a follow-up. The current approach works and is simpler; we can make it extensible when a sixth agent needs it.

2. **MCP server build step** -- The server currently runs via `node --import <absolute-path-to-tsx/dist/esm/index.mjs>` in dev mode (per invariant #8). Adding it to `npm run build:server` so it compiles to `dist/server/mcp/server.js` for production is a follow-up. The `tsconfig.server.json` already includes `server/**/*`, so the build should work automatically.

3. **Full agent E2E tests** -- Testing that a real Claude/Codex session picks up the MCP server and successfully calls actions requires spawning real agents with API keys. This is deferred to a follow-up. **Integration coverage within this plan (satisfies the "e2e" part of AGENTS.md for this change):**
   - **Task 4 smoke test:** Spawns the real MCP server as a child process, sends JSON-RPC `initialize` via stdin, verifies tool registration in the response. This is a real process-level integration test — not a mock.
   - **Task 6 integration tests:** Validate the full `generateMcpInjection()` → `providerNotificationArgs()` → `resolveCodingCliCommand()` → `buildSpawnSpec()` pipeline produces correct args/env for each of the 5 agent modes. Verifies the complete injection path end-to-end.
   - **Task 6 cleanup tests:** Validate that `kill()` and `onExit()` both trigger `cleanupMcpConfig()`, covering the two terminal-exit code paths.

   Together these tests cover every integration boundary except the agent-side MCP client handshake (which requires API keys and real agent binaries — a separate follow-up with manual verification).

4. **Demo skill injection** -- The current code also injects/disables the demo-creation skill for Codex. The MCP approach could carry a second tool or expose demo actions. Deferred because it's orthogonal to the core orchestration replacement.

5. **OpenCode orphaned config entries** -- OpenCode uses project-local `.opencode/opencode.json` which is cleaned up on terminal exit (the `freshell` MCP entry is removed). If Freshell crashes without cleanup, the orphaned entry is harmless (the MCP server will fail to connect). No special shutdown hook needed.

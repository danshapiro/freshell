# MCP Orchestration Server -- Test Plan

> Companion to `2026-03-22-mcp-orchestration-server.md`. Provides every test file, case name, and assertion an implementer needs to write.

---

## Test Infrastructure Notes

- **Vitest configs:** Unit server tests run under `vitest.server.config.ts` (node environment). The include pattern is `test/unit/server/**/*.test.ts` plus `test/server/**/*.test.ts`.
- **Mocking patterns:** The codebase uses `vi.mock(...)` with factory functions and `vi.hoisted(...)` for mock objects needed before module loading. `vi.stubGlobal('fetch', ...)` is used for HTTP mocking. `vi.resetModules()` + dynamic import isolates env var reads.
- **Existing helpers:** `test/unit/server/terminal-registry.test.ts` mocks `fs`, `node-pty`, and `server/logger`. New MCP tests should follow the same mock-first pattern.
- **API response envelopes:** The agent API (`server/agent-api/router.ts`) wraps responses in `{ status, data?, message? }` envelopes (see `server/agent-api/response.ts`). The MCP HTTP client (`http-client.ts`) must handle envelope unwrapping — either by returning `response.data` when the envelope has a `data` field, or by returning the full response and letting the tool layer unwrap. The freshell-tool tests should mock return values matching what the HTTP client actually delivers after unwrapping. If the HTTP client unwraps envelopes, tool tests mock unwrapped payloads; if not, tool tests must mock full envelopes and the tool code must unwrap.
- **File placement:** All new test files go under `test/unit/server/mcp/` to match the source directory at `server/mcp/`.
- **Run command:** `npm run test:vitest -- --run test/unit/server/mcp/` for the new MCP tests, `npm run test:vitest -- --run test/unit/server/terminal-registry.test.ts` for modified tests.
- **No real-agent e2e tests** (spawning Claude/Codex/etc. with API keys is deferred to manual verification). However, there IS a process-level smoke test (Task 4) that spawns the real MCP server as a child process and validates JSON-RPC initialization, and integration-level tests (Task 6) that validate the full injection pipeline for all 5 agent modes.

---

## Test Files Overview

| Test File | Status | Source File Under Test |
|-----------|--------|----------------------|
| `test/unit/server/mcp/http-client.test.ts` | **New** | `server/mcp/http-client.ts` |
| `test/unit/server/mcp/freshell-tool.test.ts` | **New** | `server/mcp/freshell-tool.ts` |
| `test/unit/server/mcp/server.test.ts` | **New** | `server/mcp/server.ts` |
| `test/unit/server/mcp/config-writer.test.ts` | **New** | `server/mcp/config-writer.ts` |
| `test/unit/server/terminal-registry.test.ts` | **Modified** | `server/terminal-registry.ts` |

---

## File 1: `test/unit/server/mcp/http-client.test.ts`

**Source:** `server/mcp/http-client.ts`
**Category:** Unit
**Mocking strategy:** `vi.stubGlobal('fetch', mockFetch)` for HTTP calls. `vi.resetModules()` + dynamic `import()` to isolate `process.env` reads between tests.

### Test Cases

#### `describe('resolveConfig')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 1 | `reads FRESHELL_URL and FRESHELL_TOKEN from environment` | Set `process.env.FRESHELL_URL = 'http://myhost:4000'` and `process.env.FRESHELL_TOKEN = 'abc123'`. Call `resolveConfig()`. Expect `{ url: 'http://myhost:4000', token: 'abc123' }`. |
| 2 | `defaults to http://localhost:3001 when FRESHELL_URL not set` | Delete `process.env.FRESHELL_URL`, delete `process.env.FRESHELL_TOKEN`. Call `resolveConfig()`. Expect `url` to be `'http://localhost:3001'` and `token` to be `''` (empty string). |
| 3 | `defaults token to empty string when FRESHELL_TOKEN not set` | Set `process.env.FRESHELL_URL = 'http://host:3001'`, delete `process.env.FRESHELL_TOKEN`. Call `resolveConfig()`. Expect `token` to be `''`. |

#### `describe('createApiClient')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 4 | `get() sends x-auth-token header when token is set` | Create client with `{ url: 'http://localhost:3001', token: 'mytoken' }`. Call `client.get('/api/health')`. Assert `fetch` was called with headers containing `'x-auth-token': 'mytoken'`. |
| 5 | `get() omits x-auth-token header when token is empty` | Create client with `{ url: 'http://localhost:3001', token: '' }`. Call `client.get('/api/health')`. Assert `fetch` was called and the headers object does NOT contain `'x-auth-token'`. |
| 6 | `get() returns parsed JSON for JSON responses` | Mock `fetch` to return `Response` with `Content-Type: application/json` body `{ ok: true }`. Call `client.get('/api/health')`. Expect result to deep-equal `{ ok: true }`. |
| 7 | `get() throws on non-ok response with error details` | Mock `fetch` to return `Response` with status 500, body `{ error: 'Internal error' }`. Call `client.get('/api/health')`. Expect it to throw, and the error to have a `.status` of 500 and message containing `'Internal error'`. |
| 8 | `post() sends JSON body with content-type header` | Mock `fetch` to return OK. Call `client.post('/api/tabs', { name: 'Test' })`. Assert `fetch` was called with method `'POST'`, body `JSON.stringify({ name: 'Test' })`, and header `'Content-Type': 'application/json'`. |
| 9 | `patch() sends correct method and body` | Mock `fetch` to return OK. Call `client.patch('/api/tabs/t1', { name: 'New' })`. Assert `fetch` was called with method `'PATCH'`. |
| 10 | `delete() sends correct method` | Mock `fetch` to return OK. Call `client.delete('/api/tabs/t1')`. Assert `fetch` was called with method `'DELETE'`. |
| 11 | `correctly joins base URL and path` | Create client with `{ url: 'http://localhost:3001/' }` (trailing slash). Call `client.get('/api/health')`. Assert `fetch` URL is `'http://localhost:3001/api/health'` (no double slash). |
| 12 | `get() unwraps agent API envelope when response has data field` | Mock `fetch` to return `Response` with JSON `{ status: 'ok', data: { tabs: [] } }`. Call `client.get('/api/tabs')`. Expect result to deep-equal `{ tabs: [] }` (the unwrapped `data` field, not the full envelope). This ensures the HTTP client handles the `{ status, data, message }` envelope used by `server/agent-api/response.ts`. |
| 13 | `get() returns full response when no data field present` | Mock `fetch` to return `Response` with JSON `{ ok: true }` (no `data` wrapper). Call `client.get('/api/health')`. Expect result to deep-equal `{ ok: true }`. |
| 14 | `get() returns text for text/plain responses` | Mock `fetch` to return `Response` with `Content-Type: text/plain` and body `'terminal output'`. Call `client.get('/api/panes/p1/capture')`. Expect result to be the string `'terminal output'` (not parsed as JSON). This is used by the `capture-pane` action. |

---

## File 2: `test/unit/server/mcp/freshell-tool.test.ts`

**Source:** `server/mcp/freshell-tool.ts`
**Category:** Unit
**Mocking strategy:** `vi.mock('../../../../server/mcp/http-client.js', ...)` to provide a mock API client that records calls. (Note: test files under `test/unit/server/mcp/` are 4 levels deep from repo root, so server imports need `../../../../server/`.) The mock `createApiClient()` returns an object with `get`, `post`, `patch`, `delete` methods implemented as `vi.fn()` returning resolved promises.

### Setup

```typescript
const mockClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('../../../../server/mcp/http-client.js', () => ({
  resolveConfig: () => ({ url: 'http://localhost:3001', token: 'test' }),
  createApiClient: () => mockClient,
}))
```

### Test Cases

#### `describe('TOOL_DESCRIPTION and INSTRUCTIONS')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 1 | `TOOL_DESCRIPTION is a non-empty string mentioning key actions` | `expect(TOOL_DESCRIPTION).toBeTruthy()`. Expect it to contain `'new-tab'`, `'send-keys'`, `'capture-pane'`, `'screenshot'`. |
| 2 | `INSTRUCTIONS is a non-empty string mentioning Freshell` | `expect(INSTRUCTIONS).toBeTruthy()`. Expect it to contain `'Freshell'` (case-insensitive). |
| 3 | `INPUT_SCHEMA has action and params fields` | `expect(INPUT_SCHEMA).toHaveProperty('action')`. `expect(INPUT_SCHEMA).toHaveProperty('params')`. |

#### `describe('executeAction -- tab actions')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 4 | `new-tab calls POST /api/tabs with name and mode` | `mockClient.post.mockResolvedValue({ id: 't1' })`. Call `executeAction('new-tab', { name: 'Work', mode: 'claude' })`. Assert `mockClient.post` called with `'/api/tabs'` and body containing `{ name: 'Work', mode: 'claude' }`. |
| 5 | `list-tabs calls GET /api/tabs` | `mockClient.get.mockResolvedValue({ tabs: [] })`. Call `executeAction('list-tabs')`. Assert `mockClient.get` called with `'/api/tabs'`. |
| 6 | `select-tab calls POST /api/tabs/:id/select` | `mockClient.post.mockResolvedValue({ ok: true })`. Call `executeAction('select-tab', { target: 't1' })`. Assert `mockClient.post` called with path containing `'/api/tabs/t1/select'`. |
| 7 | `kill-tab calls DELETE /api/tabs/:id` | `mockClient.delete.mockResolvedValue({ ok: true })`. Call `executeAction('kill-tab', { target: 't1' })`. Assert `mockClient.delete` called with path containing `'/api/tabs/t1'`. |
| 8 | `rename-tab calls PATCH /api/tabs/:id` | `mockClient.patch.mockResolvedValue({ ok: true })`. Call `executeAction('rename-tab', { target: 't1', name: 'New Name' })`. Assert `mockClient.patch` called with path containing `'/api/tabs/t1'` and body containing `{ name: 'New Name' }`. |
| 9 | `has-tab calls GET /api/tabs/has?target=...` | `mockClient.get.mockResolvedValue({ exists: true })`. Call `executeAction('has-tab', { target: 'Work' })`. Assert `mockClient.get` called with path matching `/api/tabs/has\?target=Work/`. |
| 10 | `next-tab calls POST /api/tabs/next` | `mockClient.post.mockResolvedValue({ ok: true })`. Call `executeAction('next-tab')`. Assert `mockClient.post` called with `'/api/tabs/next'`. |
| 11 | `prev-tab calls POST /api/tabs/prev` | `mockClient.post.mockResolvedValue({ ok: true })`. Call `executeAction('prev-tab')`. Assert `mockClient.post` called with `'/api/tabs/prev'`. |

#### `describe('executeAction -- pane actions')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 12 | `split-pane calls POST /api/panes/:id/split with direction` | Call `executeAction('split-pane', { target: 'p1', direction: 'vertical' })`. Assert `mockClient.post` called with path containing `'/api/panes/p1/split'` and body containing `{ direction: 'vertical' }`. |
| 13 | `list-panes calls GET /api/panes` | Call `executeAction('list-panes')`. Assert `mockClient.get` called with `'/api/panes'`. |
| 14 | `list-panes with tab target calls GET /api/panes?tabId=...` | Call `executeAction('list-panes', { target: 't1' })`. Assert `mockClient.get` called with path matching `/api/panes\?tabId=t1/`. |
| 15 | `select-pane calls POST /api/panes/:id/select` | Call `executeAction('select-pane', { target: 'p1' })`. Assert `mockClient.post` called with path containing `'/api/panes/p1/select'`. |
| 16 | `rename-pane calls PATCH /api/panes/:id` | Call `executeAction('rename-pane', { target: 'p1', name: 'My Pane' })`. Assert `mockClient.patch` called with path containing `'/api/panes/p1'` and body containing `{ name: 'My Pane' }`. |
| 17 | `kill-pane calls POST /api/panes/:id/close` | Call `executeAction('kill-pane', { target: 'p1' })`. Assert `mockClient.post` called with path containing `'/api/panes/p1/close'`. |
| 18 | `resize-pane calls POST /api/panes/:id/resize with x/y or sizes` | Call `executeAction('resize-pane', { target: 'p1', x: 60 })`. Assert `mockClient.post` called with path containing `'/api/panes/p1/resize'` and body containing `{ x: 60 }`. (API accepts `x`, `y` as percentages 1-99, or `sizes` as a `[n, m]` tuple.) |
| 19 | `swap-pane calls POST /api/panes/:id/swap with target body` | Call `executeAction('swap-pane', { target: 'p1', with: 'p2' })`. Assert `mockClient.post` called with path containing `'/api/panes/p1/swap'` and body containing `{ target: 'p2' }` (API accepts `target` or `otherId` — see `server/agent-api/router.ts:756`). |
| 20 | `respawn-pane calls POST /api/panes/:id/respawn` | Call `executeAction('respawn-pane', { target: 'p1' })`. Assert `mockClient.post` called with path containing `'/api/panes/p1/respawn'`. |

#### `describe('executeAction -- terminal I/O')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 21 | `send-keys in token mode translates key tokens via translateKeys()` | Call `executeAction('send-keys', { target: 'p1', keys: ['ls', 'ENTER'] })`. Assert `mockClient.post` called with `'/api/panes/p1/send-keys'` and body containing `{ data: 'ls\r' }` (ENTER → `\r` via translateKeys from `server/cli/keys.ts`). |
| 21b | `send-keys in literal mode sends raw string without translation` | Call `executeAction('send-keys', { target: 'p1', keys: 'echo hello world\n', literal: true })`. Assert `mockClient.post` called with `'/api/panes/p1/send-keys'` and body containing `{ data: 'echo hello world\n' }` (raw, no splitting or token translation). |
| 21c | `send-keys with string keys and no literal flag treats as single token` | Call `executeAction('send-keys', { target: 'p1', keys: 'ENTER' })`. Assert `mockClient.post` called with body containing `{ data: '\r' }` (single-token translation for backwards compat). |
| 22 | `capture-pane calls GET /api/panes/:id/capture and returns plain text` | `mockClient.get.mockResolvedValue('terminal output')`. Call `executeAction('capture-pane', { target: 'p1' })`. Assert `mockClient.get` called with path containing `'/api/panes/p1/capture'`. Assert result contains the captured text. (Note: the API returns `text/plain`, not JSON — the HTTP client must handle this content type.) |
| 23 | `wait-for calls GET /api/panes/:id/wait-for with pattern` | `mockClient.get.mockResolvedValue({ matched: true })`. Call `executeAction('wait-for', { target: 'p1', pattern: '\\$' })`. Assert `mockClient.get` called with path matching `/api/panes/p1/wait-for/`. |
| 24 | `run calls POST /api/run with command and options` | `mockClient.post.mockResolvedValue({ output: 'ok', exitCode: 0 })`. Call `executeAction('run', { command: 'npm test', capture: true })`. Assert `mockClient.post` called with `'/api/run'` and body containing `{ command: 'npm test', capture: true }`. |
| 25 | `summarize resolves pane to terminalId and calls POST /api/ai/terminals/:terminalId/summary` | Mock `mockClient.get` to return `{ tabs: [...] }` for `GET /api/tabs` and `{ panes: [{ id: 'p1', terminalId: 'term-1' }] }` for `GET /api/panes` (matching `resolvePaneTarget()` pattern from CLI). Call `executeAction('summarize', { target: 'p1' })`. Assert `mockClient.post` called with path matching `/api/ai/terminals/term-1/summary`. |

#### `describe('executeAction -- additional terminal I/O')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 25a | `display resolves pane target and formats string` | Mock `mockClient.get` to return tabs/panes data (matching `resolvePaneTarget()` pattern). Call `executeAction('display', { target: 'p1', format: '#S:#P' })`. Assert result contains formatted output with tab name and pane ID. (This is client-side format-string expansion, same as CLI's `handleDisplay`.) |
| 25b | `list-terminals calls GET /api/terminals` | `mockClient.get.mockResolvedValue({ terminals: [] })`. Call `executeAction('list-terminals')`. Assert `mockClient.get` called with `'/api/terminals'`. |
| 25c | `attach calls POST /api/panes/:id/attach with terminalId` | `mockClient.post.mockResolvedValue({ ok: true })`. Call `executeAction('attach', { target: 'p1', terminalId: 'term-1' })`. Assert `mockClient.post` called with path containing `'/api/panes/p1/attach'` and body containing `{ terminalId: 'term-1' }`. |
| 25d | `lan-info calls GET /api/lan-info` | `mockClient.get.mockResolvedValue({ addresses: [] })`. Call `executeAction('lan-info')`. Assert `mockClient.get` called with `'/api/lan-info'`. |

#### `describe('executeAction -- browser')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 26 | `open-browser calls POST /api/tabs with browser URL` | Call `executeAction('open-browser', { url: 'https://example.com' })`. Assert `mockClient.post` called with `'/api/tabs'` and body containing `{ browser: 'https://example.com' }`. |
| 27 | `navigate calls POST /api/panes/:id/navigate` | Call `executeAction('navigate', { target: 'p1', url: 'https://example.com' })`. Assert `mockClient.post` called with path containing `'/api/panes/p1/navigate'`. |

#### `describe('executeAction -- screenshot')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 28 | `screenshot with scope=pane resolves target to paneId and includes name` | Call `executeAction('screenshot', { scope: 'pane', target: 'p1', name: 'test' })`. Assert `mockClient.post` called with `'/api/screenshots'` and body containing `{ scope: 'pane', paneId: 'p1', name: 'test' }` (NOT `target` — target is resolved to `paneId`). |
| 28b | `screenshot with scope=tab resolves target to tabId` | Call `executeAction('screenshot', { scope: 'tab', target: 't1', name: 'test' })`. Assert `mockClient.post` called with `'/api/screenshots'` and body containing `{ scope: 'tab', tabId: 't1', name: 'test' }`. |
| 28c | `screenshot with scope=tab resolves tab title to tabId` | Mock `mockClient.get` to return `{ tabs: [{ id: 't1', name: 'Work' }] }` for `GET /api/tabs`. Call `executeAction('screenshot', { scope: 'tab', target: 'Work', name: 'test' })`. Assert `mockClient.post` called with body containing `{ scope: 'tab', tabId: 't1' }`. |
| 28d | `screenshot with scope=view sends no ID` | Call `executeAction('screenshot', { scope: 'view', name: 'test' })`. Assert `mockClient.post` called with `'/api/screenshots'` and body containing `{ scope: 'view', name: 'test' }` without `paneId` or `tabId`. |
| 28e | `screenshot defaults name to "screenshot" when not provided` | Call `executeAction('screenshot', { scope: 'pane', target: 'p1' })`. Assert `mockClient.post` called with body containing `{ name: 'screenshot' }`. (`name` is required by the API; MCP tool provides a default.) |

#### `describe('executeAction -- session')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 29 | `list-sessions calls GET /api/session-directory with priority=visible` | Call `executeAction('list-sessions')`. Assert `mockClient.get` called with path matching `/api/session-directory\?.*priority=visible/`. (`priority` is required by the API schema.) |
| 30 | `search-sessions calls GET /api/session-directory with query and priority` | Call `executeAction('search-sessions', { query: 'test' })`. Assert `mockClient.get` called with path matching `/api/session-directory.*priority=visible.*query=test/` (or both params in either order). |

#### `describe('executeAction -- meta')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 31 | `health calls GET /api/health` | Call `executeAction('health')`. Assert `mockClient.get` called with `'/api/health'`. |
| 32 | `help returns full command reference text` | Call `executeAction('help')`. Expect result to be an object (not an error) containing text that mentions `'new-tab'`, `'send-keys'`, `'capture-pane'`. |

#### `describe('executeAction -- error handling')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 33 | `unknown action returns error with hint` | Call `executeAction('nonexistent-action')`. Expect result to have an `error` field containing `"Unknown action 'nonexistent-action'"` and a suggestion to run `'help'`. |
| 34 | `missing required param returns error with hint` | Call `executeAction('kill-tab', {})` (no target). Expect result to have an `error` field. |
| 35 | `API error wraps with recovery hint` | `mockClient.get.mockRejectedValue(new Error('ECONNREFUSED'))`. Call `executeAction('health')`. Expect result to have an `error` field and a `hint` mentioning the Freshell server. |

---

## File 3: `test/unit/server/mcp/server.test.ts`

**Source:** `server/mcp/server.ts`
**Category:** Unit
**Mocking strategy:** Mock `@modelcontextprotocol/sdk/server/mcp.js` and `@modelcontextprotocol/sdk/server/stdio.js` using `vi.mock()` to capture registration calls. Mock `server/mcp/freshell-tool.js` to isolate from tool implementation. **Critical:** The server module has a top-level `await server.connect(transport)` that executes on import, so mocks must be in place before the module is dynamically imported.

### Setup

```typescript
const mockRegisterTool = vi.fn()
const mockConnect = vi.fn()
const mockMcpServer = vi.hoisted(() => vi.fn().mockReturnValue({
  registerTool: mockRegisterTool,
  connect: mockConnect,
}))
const mockStdioTransport = vi.hoisted(() => vi.fn())

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: mockMcpServer,
}))
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: mockStdioTransport,
}))
vi.mock('../../../../server/mcp/freshell-tool.js', () => ({
  TOOL_DESCRIPTION: 'Test tool description',
  INSTRUCTIONS: 'Test instructions',
  executeAction: vi.fn().mockResolvedValue({ ok: true }),
}))
```

### Test Cases

#### `describe('MCP server initialization')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 1 | `creates McpServer with name "freshell"` | After dynamic import of `server/mcp/server.ts`, assert `mockMcpServer` was called with first arg containing `{ name: 'freshell' }`. |
| 2 | `passes INSTRUCTIONS as server instructions` | Assert `mockMcpServer` second arg contains `{ instructions: 'Test instructions' }`. |
| 3 | `registers exactly one tool named "freshell"` | Assert `mockRegisterTool` was called exactly once. First arg of that call should be `'freshell'`. |
| 4 | `tool registration includes correct description` | Assert second arg of `mockRegisterTool` call has `description` matching `'Test tool description'`. |
| 5 | `tool registration includes inputSchema with action and params` | Assert second arg of `mockRegisterTool` call has `inputSchema` object with `action` and `params` keys. |
| 6 | `tool handler calls executeAction and wraps result in MCP content format` | Extract the handler (third arg to `mockRegisterTool`). Call it with `{ action: 'health', params: {} }`. Assert it returns `{ content: [{ type: 'text', text: ... }] }` where `text` is JSON-stringified result. |
| 7 | `connects via StdioServerTransport` | Assert `mockConnect` was called once. Assert `mockStdioTransport` was instantiated. |

#### `describe('MCP server process-level smoke test')`

This is a real child-process integration test (not mocked). It spawns the actual MCP server and validates JSON-RPC initialization.

| # | Test Name | Asserts |
|---|-----------|---------|
| 8 | `spawns real MCP server and responds to JSON-RPC initialize` | Spawn `server/mcp/server.ts` as a child process via `child_process.spawn('node', ['--import', tsxLoaderPath, serverPath])` with `FRESHELL_URL` and `FRESHELL_TOKEN` env vars. Send JSON-RPC `initialize` request on stdin. Assert stdout response contains `"name":"freshell"` and the tool list includes `"freshell"`. Kill the child process on test cleanup. |
| 9 | `MCP server does not write to stdout outside JSON-RPC` | Using the same child process from test 8, verify that all stdout output is valid JSON-RPC frames (no stray `console.log` corruption). |

---

## File 4: `test/unit/server/mcp/config-writer.test.ts`

**Source:** `server/mcp/config-writer.ts`
**Category:** Unit
**Mocking strategy:** Mock `fs` (for `writeFileSync`, `readFileSync`, `mkdirSync`, `unlinkSync`, `existsSync`, `statSync`) and `os` (for `tmpdir`, `homedir`). Mock `import.meta.url` resolution for path computation (or use `vi.mock` to control resolved paths).

### Setup Notes

- The config writer detects dev vs production mode via `process.env.NODE_ENV === 'production'` (matching implementation plan invariant #8). Tests should set/clear `process.env.NODE_ENV` to control this, using `vi.resetModules()` + dynamic import for isolation.
- For OpenCode tests, mock `readFileSync` to return existing config and `writeFileSync` to capture merged output.
- All tests should set a controlled `os.tmpdir()` return value (e.g., `/tmp`) and `os.homedir()` return value (e.g., `/home/testuser`).

### Test Cases

#### `describe('generateMcpInjection -- per-agent config')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 1 | `claude mode: returns args with --mcp-config pointing to temp file` | Call `generateMcpInjection('claude', 'term-abc')`. Expect result `args` to contain `'--mcp-config'` followed by a path matching `/freshell-mcp\/term-abc\.json$/`. Expect `env` to be `{}`. |
| 2 | `claude mode: temp file contains valid JSON with mcpServers.freshell.command` | Call `generateMcpInjection('claude', 'term-abc')`. Assert `fs.writeFileSync` was called. Parse the written JSON. Expect it to have `mcpServers.freshell.command` equal to `'node'`. Expect `mcpServers.freshell.args` to be an array. |
| 3 | `codex mode: returns args with -c flags for MCP server config` | Call `generateMcpInjection('codex', 'term-def')`. Expect result `args` to include `-c` flags. Expect at least one arg to contain `'mcp_servers.freshell.command'`. Expect `env` to be `{}`. |
| 4 | `codex mode: does not write a temp file` | Call `generateMcpInjection('codex', 'term-def')`. Assert `fs.writeFileSync` was NOT called (or not called with a path containing `freshell-mcp`). |
| 5 | `gemini mode: returns env with GEMINI_CLI_SYSTEM_DEFAULTS_PATH` | Call `generateMcpInjection('gemini', 'term-ghi')`. Expect `args` to be `[]`. Expect `env` to have `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` matching `/freshell-mcp\/term-ghi\.json$/`. |
| 6 | `gemini mode: temp file contains valid JSON with mcpServers.freshell` | Call `generateMcpInjection('gemini', 'term-ghi')`. Parse the written JSON. Expect `mcpServers.freshell` to exist. |
| 7 | `kimi mode: returns args with --mcp-config-file pointing to temp file` | Call `generateMcpInjection('kimi', 'term-jkl')`. Expect `args` to contain `'--mcp-config-file'` followed by a path matching `/freshell-mcp\/term-jkl\.json$/`. Expect `env` to be `{}`. |
| 8 | `kimi mode: temp file contains valid JSON with mcpServers.freshell` | Call `generateMcpInjection('kimi', 'term-jkl')`. Parse the written JSON. Expect `mcpServers.freshell` to exist. |
| 9 | `opencode mode: reads existing config and merges freshell entry` | Mock `fs.readFileSync` to return `JSON.stringify({ mcp: { existing: { type: 'local', command: ['echo'] } } })`. Call `generateMcpInjection('opencode', 'term-mno')`. Assert `fs.writeFileSync` was called. Parse the written JSON. Expect `mcp.existing` to still be present AND `mcp.freshell` to be present with `type: 'local'`. |
| 10 | `opencode mode: creates config if file does not exist` | Mock `fs.readFileSync` to throw ENOENT. Call `generateMcpInjection('opencode', 'term-mno')`. Assert `fs.writeFileSync` was called. Parse the written JSON. Expect `mcp.freshell` to exist. |
| 11 | `opencode mode: returns empty args and env` | Call `generateMcpInjection('opencode', 'term-mno')`. Expect `args` to be `[]`. Expect `env` to be `{}`. |
| 12 | `shell mode: returns empty args and env, no temp file` | Call `generateMcpInjection('shell', 'term-pqr')`. Expect `{ args: [], env: {} }`. Assert `fs.writeFileSync` was NOT called (or not called with MCP-related path). |
| 13 | `unknown mode: returns empty args and env, no temp file` | Call `generateMcpInjection('unknown-mode' as any, 'term-xyz')`. Expect `{ args: [], env: {} }`. |

#### `describe('generateMcpInjection -- dev/production detection')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 14 | `uses built path when NODE_ENV is production` | Set `process.env.NODE_ENV = 'production'`. Call `generateMcpInjection('claude', 'term-prod')`. Parse the written config JSON. Expect `mcpServers.freshell.args` to contain a path ending in `dist/server/mcp/server.js`. Expect NOT to contain `'--import'` or `'tsx'`. |
| 15 | `uses tsx/esm loader path when NODE_ENV is not production` | Set `process.env.NODE_ENV = 'development'` (or delete it). Call `generateMcpInjection('claude', 'term-dev')`. Parse the written config JSON. Expect `mcpServers.freshell.args` to contain `'--import'` and an absolute path to `tsx/dist/esm/index.mjs` and a path ending in `server/mcp/server.ts`. |

#### `describe('cleanupMcpConfig')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 16 | `deletes temp file when it exists` | Mock `fs.existsSync` to return `true` for the temp path. Call `cleanupMcpConfig('term-abc')`. Assert `fs.unlinkSync` was called with path matching `/freshell-mcp\/term-abc\.json$/`. |
| 17 | `does not throw when temp file does not exist` | Mock `fs.existsSync` to return `false`. Expect `cleanupMcpConfig('nonexistent')` not to throw. |
| 18 | `does not throw when unlinkSync fails` | Mock `fs.unlinkSync` to throw. Expect `cleanupMcpConfig('term-abc')` not to throw (best-effort cleanup). |

#### `describe('cleanupMcpConfig -- OpenCode sidecar')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 18a | `opencode cleanup removes freshell key when sidecar refcount reaches 0` | Mock sidecar with `{ refCount: 1 }` and `opencode.json` with `{ mcp: { freshell: {...}, other: {...} } }`. Call `cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')`. Assert `writeFileSync` was called with JSON containing `mcp.other` but NOT `mcp.freshell`. Assert sidecar file was deleted. |
| 18b | `opencode cleanup deletes opencode.json and dir when freshell was only entry and dir was created by Freshell` | Mock sidecar with `{ refCount: 1, createdDir: true, createdFile: true }` and `opencode.json` with `{ mcp: { freshell: {...} } }`. Call `cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')`. Assert `unlinkSync` called for `opencode.json`, sidecar, and `rmdirSync`/`rmSync` called for `.opencode/` dir. |
| 18c | `opencode cleanup skips key removal when no sidecar exists (user-managed)` | Mock `readFileSync` to throw ENOENT for sidecar path. Call `cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')`. Assert `writeFileSync` was NOT called for `opencode.json` (freshell key left intact). |
| 18d | `opencode cleanup decrements refcount when > 1 but does not remove config` | Mock sidecar with `{ refCount: 2 }`. Call `cleanupMcpConfig('term-oc', 'opencode', '/tmp/test-cwd')`. Assert sidecar was rewritten with `{ refCount: 1 }`. Assert `opencode.json` was NOT modified. |
| 18e | `generateMcpInjection for opencode writes no custom keys to opencode.json` | Call `generateMcpInjection('opencode', 'term-test', '/tmp/test-cwd')`. Parse the written `opencode.json`. Assert no keys like `_freshellManaged`, `_freshellCreated`, or any underscore-prefixed keys exist anywhere in the JSON. |

#### `describe('temp file security')`

| # | Test Name | Asserts |
|---|-----------|---------|
| 19 | `temp files are written with mode 0o600` | Call `generateMcpInjection('claude', 'term-sec')`. Assert `fs.writeFileSync` was called with options including `{ mode: 0o600 }`. |
| 20 | `temp directory is created with recursive option` | Call `generateMcpInjection('claude', 'term-dir')`. Assert `fs.mkdirSync` was called with the temp directory path and `{ recursive: true }`. |

---

## File 5: `test/unit/server/terminal-registry.test.ts` (Modified)

**Source:** `server/terminal-registry.ts`
**Category:** Unit
**Change summary:** Replace `expectClaudeTurnCompleteArgs()` and `expectCodexTurnCompleteArgs()` helper functions with MCP-aware equivalents. Add new test cases for gemini, kimi, and opencode MCP injection.

### Helper Replacements

**Remove:** `expectClaudeTurnCompleteArgs()` (currently asserts the legacy orchestration `--plugin-dir`)
**Replace with:** `expectClaudeMcpArgs()`

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

**Remove:** `expectCodexTurnCompleteArgs()` (currently asserts `skills.config=` TOML literal)
**Replace with:** `expectCodexMcpArgs()`

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

**Keep:** `getClaudeStopHookCommand()` (unchanged, still needed by the new helper)

### New Mock Requirement

The `server/mcp/config-writer.js` module must be mocked:

```typescript
vi.mock('../../../server/mcp/config-writer.js', () => ({
  generateMcpInjection: vi.fn((mode: string, terminalId: string, cwd?: string) => {
    if (mode === 'claude' || mode === 'kimi') {
      const flag = mode === 'claude' ? '--mcp-config' : '--mcp-config-file'
      return { args: [flag, `/tmp/freshell-mcp/${terminalId}.json`], env: {} }
    }
    if (mode === 'codex') {
      return { args: ['-c', 'mcp_servers.freshell.command="node"', '-c', 'mcp_servers.freshell.args=["/path/to/server.ts"]'], env: {} }
    }
    if (mode === 'gemini') {
      return { args: [], env: { GEMINI_CLI_SYSTEM_DEFAULTS_PATH: `/tmp/freshell-mcp/${terminalId}.json` } }
    }
    if (mode === 'opencode') {
      return { args: [], env: {} }
    }
    return { args: [], env: {} }
  }),
  cleanupMcpConfig: vi.fn(),
}))
```

### Existing Test Case Modifications

All existing tests that call `expectClaudeTurnCompleteArgs(spec.args)` must switch to calling `expectClaudeMcpArgs(spec.args)`. Based on the codebase grep, these are at approximately lines: 796, 1266, 2648, 3279.

All existing tests that call `expectCodexTurnCompleteArgs(spec.args)` must switch to calling `expectCodexMcpArgs(spec.args)`. These are at approximately lines: 847, 865, 1292, 2663, 2920, 3319.

No test logic changes beyond the helper swap are needed for these existing test cases -- they continue to verify that buildSpawnSpec produces correct args for each mode.

### New Test Cases

#### `describe('buildSpawnSpec MCP injection')` (new describe block)

| # | Test Name | Asserts |
|---|-----------|---------|
| 1 | `gemini mode includes GEMINI_CLI_SYSTEM_DEFAULTS_PATH in env` | Set up platform as linux. Call `buildSpawnSpec('gemini', '/home/user', 'system')`. Expect `spec.env` to include `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` pointing to a freshell-mcp temp file. |
| 2 | `kimi mode includes --mcp-config-file in args` | Set up platform as linux. Call `buildSpawnSpec('kimi', '/home/user', 'system')`. Expect `spec.args` to contain `'--mcp-config-file'`. |
| 3 | `opencode mode passes cwd to generateMcpInjection` | Set up platform as linux. Call `buildSpawnSpec('opencode', '/home/user/project', 'system', undefined, undefined, undefined, undefined, 'term-oc1')`. Verify `generateMcpInjection` was called with `('opencode', 'term-oc1', '/home/user/project')` — the `cwd` param is required for OpenCode's project-local `.opencode/opencode.json` isolation. |
| 4 | `shell mode does not inject MCP config` | Call `buildSpawnSpec('shell', '/home/user', 'system')`. Expect `spec.args` to NOT contain `'--mcp-config'` or `'--mcp-config-file'`. Expect `spec.env` to NOT contain `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`. |
| 5 | `buildSpawnSpec passes terminalId and cwd to generateMcpInjection` | Call `buildSpawnSpec('claude', '/home/user', 'system', undefined, undefined, undefined, undefined, 'term-123')`. Assert `generateMcpInjection` was called with `('claude', 'term-123', '/home/user')` — all three params must be threaded through. |

#### `describe('MCP cleanup on terminal exit')` (new describe block, if TerminalRegistry.create is testable)

| # | Test Name | Asserts |
|---|-----------|---------|
| 6 | `cleanupMcpConfig is called on onExit` | Using the existing mock `node-pty` setup, trigger the `onExit` callback. Assert `cleanupMcpConfig` was called with the terminal ID, mode, and cwd. |
| 6b | `cleanupMcpConfig is called on explicit kill()` | Create a terminal, then call `kill()` on it. Assert `cleanupMcpConfig` was called with the terminal ID, mode, and cwd. (Note: `kill()` sets `status='exited'` before PTY fires `onExit`, causing `onExit` to early-return. Without cleanup in `kill()`, the config would leak.) |
| 6c | `cleanupMcpConfig is called on spawn failure` | Mock `pty.spawn()` to throw. Attempt to create a terminal. Assert `cleanupMcpConfig` was called (preventing temp file leaks from config injection done before spawn). |

#### `describe('dead code removal verification')` (new describe block)

| # | Test Name | Asserts |
|---|-----------|---------|
| 7 | `claude mode does not include --plugin-dir in spawn args` | Call `buildSpawnSpec('claude', ...)`. Assert `spec.args` does NOT contain `'--plugin-dir'`. This verifies `claudePluginArgs()` is no longer called. |
| 8 | `codex mode does not include skills.config in spawn args` | Call `buildSpawnSpec('codex', ...)`. Assert no arg starts with `'skills.config='`. This verifies `codexOrchestrationSkillArgs()` is no longer called. |
| 9 | `spawn-spec.ts is deleted` | Verify via `import()` that `server/spawn-spec.ts` does not resolve (or use a file-existence check in the test). |

---

## File 6: `test/unit/server/mcp/freshell-tool.test.ts` (Expanded instruction coverage)

**Source:** `server/mcp/freshell-tool.ts`
**Category:** Unit
**Status:** The MCP tool is the canonical orchestration reference. Expand the existing help/instructions coverage instead of maintaining a separate standalone doc test.

### New Test Case

| # | Test Name | Asserts |
|---|-----------|---------|
| 1 | `help text documents rename defaults and rename playbook` | Call `executeAction('help')`. Expect the result to mention `rename-tab`, `rename-pane`, omitted-target semantics, and the create/split/rename playbook. |

---

## Coverage Gap Analysis

### Gaps Identified in the Implementation Plan

| Gap | Risk | Recommendation |
|-----|------|----------------|
| **No test for `providerNotificationArgs()` signature change** | The function changes from returning `string[]` to `{ args: string[], env: Record<string, string> }`. All callers must adapt. | Covered by the existing `buildSpawnSpec` tests that call the new `expectClaudeMcpArgs`/`expectCodexMcpArgs` helpers -- the helpers implicitly verify that the args array is correctly structured after the signature change. No additional test needed. |
| **No test for Codex TOML escaping of MCP server args** | The `mcp_servers.freshell.args` value must be a valid TOML array containing absolute paths which may include backslashes on Windows. | Add test case in `config-writer.test.ts` (see #3 above) to verify the TOML string format. The config-writer should produce args like `-c 'mcp_servers.freshell.args=["/path/to/server.ts"]'` with proper escaping. |
| **No test for OpenCode config file merge with malformed existing file** | If `~/.config/opencode/config.json` contains invalid JSON, the merge behavior must be defined. | **Add to config-writer.test.ts:** Test case "opencode mode: handles malformed existing config gracefully" -- mock `readFileSync` to return invalid JSON. Expect either a new config (treating malformed as empty) or a clear error. |
| **No test for version string in McpServer constructor** | Plan says `version: '1.0.0'` but could read from package.json. | Covered by server.test.ts #1. The test should assert the version is a valid semver string. |
| **No integration test for MCP server <-> REST API round-trip** | The MCP server calls real REST endpoints. Unit tests mock the HTTP client. | Intentionally deferred per plan ("E2E tests" section). The REST API is already well-tested by `test/server/api.test.ts`. The thin translation layer in `freshell-tool.ts` is unit-tested. |

### Additional Test Case for Gap Coverage

Add to `test/unit/server/mcp/config-writer.test.ts`:

| # | Test Name | Asserts |
|---|-----------|---------|
| 21 | `opencode mode: handles malformed existing config gracefully` | Mock `fs.readFileSync` to return `'not valid json{'`. Call `generateMcpInjection('opencode', 'term-bad')`. Expect it to either create a fresh config with `mcp.freshell` or return an error (implementation decides), but it must NOT throw an unhandled exception. |

---

## Test Execution Order

The implementation plan uses red-green-refactor TDD. Tests should be written and run in this order:

1. **Task 2:** `test/unit/server/mcp/http-client.test.ts` -- write tests first (red), implement `server/mcp/http-client.ts` (green), refactor
2. **Task 3:** `test/unit/server/mcp/freshell-tool.test.ts` -- write tests first (red), implement `server/mcp/freshell-tool.ts` (green), refactor
3. **Task 4:** `test/unit/server/mcp/server.test.ts` -- write tests first (red), implement `server/mcp/server.ts` (green), refactor
4. **Task 5:** `test/unit/server/mcp/config-writer.test.ts` -- write tests first (red), implement `server/mcp/config-writer.ts` (green), refactor
5. **Task 6:** Modify `test/unit/server/terminal-registry.test.ts` -- update helpers (red), modify `server/terminal-registry.ts` (green), delete dead code, refactor
6. **Task 7:** Optionally expand `test/unit/server/mcp/freshell-tool.test.ts` to cover the canonical MCP help/instruction surface

---

## Total Test Count Summary

| File | New Tests | Modified Tests |
|------|-----------|----------------|
| `http-client.test.ts` | 14 | 0 |
| `freshell-tool.test.ts` | 47 | 0 |
| `server.test.ts` | 9 | 0 |
| `config-writer.test.ts` | 26 | 0 |
| `config-writer-paths.test.ts` | 5 | 0 |
| `terminal-registry.test.ts` | 11 | ~12 (helper swap) |
| **Total** | **114** | **~12** |

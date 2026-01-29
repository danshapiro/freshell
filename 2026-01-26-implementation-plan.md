# Claude Code Session Organizer - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a browser-based web app for managing multiple Claude Code sessions in a tabbed interface with terminal embedding, session history, and AI-powered summaries. Accessible remotely from phone over VPN.

**Architecture:** React frontend with xterm.js terminals connecting via a single multiplexed WebSocket to a Node/Express backend that manages PTY processes. Server-issued terminal IDs enable attach/reattach across connection drops. Server serves frontend in production (same-origin).

**Tech Stack:** React, Vite, TypeScript, Tailwind CSS, shadcn/ui, Redux Toolkit, xterm.js, Express, node-pty, ws, chokidar

**Testing Stack:** Vitest, Testing Library, supertest, superwstest, browser-use (Python)

---

# Product Constraints and Design Decisions

## Supported Operating Systems

- **Windows 11 required for v1** — The shell model (`cmd`, `powershell`, `wsl`) is Windows-centric
- **Cross-platform (future):** If extended to macOS/Linux, normalize shell set:
  - `shell: 'system'` → maps to `/bin/zsh` or `/bin/bash` (via `$SHELL` or fallback)
  - `shell: 'powershell'` → requires PowerShell Core (`pwsh`)
  - `shell: 'wsl'` → Windows only, not available on macOS/Linux
- Tests should select shell by `process.platform` when running cross-platform

## Operating Model

- **Single user**, but **remote access from phone over VPN** (treat as untrusted network)
- App runs on your machine, accessed via IP/hostname from phone
- Backend must be secure enough for LAN/VPN exposure:
  - Auth required for **HTTP + WebSocket**
  - Bind address configurable (not localhost-only by default)
  - Production is **same-origin** (server serves UI + API)

## Core Technical Requirements (Early)

- **WS attach is critical**: terminal sessions must survive connection loss and be reattachable
- **WSL support must be early**: working spawn, correct cwd handling
- Tabs/History/Overview are "product features," but the system must first prove **remote, attachable PTYs**

## Later Requirements

- **Background sessions**: user can close browser, process continues; inactivity timeout → kill
- **Project colors**: random assignment, user-configurable, persisted server-side
- **Terminal appearance**: color themes + font selection + light/dark mode
- **User name changing**
- **Auto-rename (later)** via AI: updates tab name + description automatically
- **Overview changes**: no auto-generation on visit; add **Regenerate** button (descriptions only)
- **History behavior**:
  - Active tabs NOT collapsed
  - Old Claude sessions collapsed by default
  - Delete with confirm; **Shift+Delete bypasses confirmation**
- Keep **Ctrl-B prefix shortcuts** (but only intercept when focus is NOT inside terminal)
- **Mobile UX**: touch targets, virtual keyboard, on-screen navigation buttons

---

# Known Issues and Mitigations

This section documents design decisions to address common pitfalls.

## 1. AUTH_TOKEN Must Be Read Dynamically
**Problem:** Capturing `process.env.AUTH_TOKEN` at module import time breaks tests that mutate the env var and prevents live config reload.
**Solution:** Read `process.env.AUTH_TOKEN` inside `requireAuth()` and `validateWsToken()` on each call.

## 2. PTYs Die with Server Process
**Problem:** `node-pty` terminals die when the Node process dies. "Stop server → restart → terminal reconnects" is impossible.
**Solution:** Manual test should be "drop network / WS reconnect (airplane mode)" not "stop server." Future: split into persistent daemon + web server.

## 3. Reattach Doesn't Preserve Scrollback
**Problem:** After reconnect, user only sees new output.
**Solution:** Implement server-side ring buffer per terminal (configurable size, default 100KB). On `terminal.attach`, send `terminal.snapshot` with buffered output before live streaming.

## 4. Close Tab = Kill vs Detach Semantics
**Problem:** Tab close (Ctrl-B X) calls `terminal.kill`, conflicting with "background sessions."
**Solution:**
- Default close = `terminal.detach` (leave process running)
- Explicit "Kill" action via menu or Shift+Ctrl-B X
- Inactivity timeout cleans up forgotten sessions
- Add `terminal.status` message so UI knows when detached session ends

## 5. React StrictMode Creates Duplicate Terminals
**Problem:** StrictMode double-invokes effects in dev, leaking orphan PTYs.
**Solution:** Add idempotency guard using `clientRef` + server-side dedupe: if `terminal.create` arrives with same `clientRef` within 2 seconds, return existing terminal instead of creating new one.

## 6. ESM/CommonJS Module Mismatch
**Problem:** `__dirname` doesn't exist in ESM; Vite projects often use `"type": "module"`.
**Solution:** Use CommonJS for server (`"module": "CommonJS"` in tsconfig.server.json) OR define `__dirname` properly:
```typescript
import { fileURLToPath } from 'url'
import path from 'path'
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
```

## 7. Production Static Path Resolution
**Problem:** `path.join(__dirname, '../dist')` from `dist/server/index.js` resolves to `dist/dist`.
**Solution:** Resolve from `process.cwd()`:
```typescript
const FRONTEND_DIR = process.env.NODE_ENV === 'production'
  ? path.resolve(process.cwd(), 'dist')
  : path.resolve(__dirname, '../dist')
```

## 8. WSL Support Underspecified
**Problem:** Hardcoding `wsl.exe -d Ubuntu` fails for many machines. `cwd` doesn't set Linux working directory.
**Solution:**
- Detect available distros via `wsl.exe -l -q`
- Use default distro (first in list) or user-configured
- Set cwd inside WSL: `wsl.exe --cd /mnt/c/path` (Windows 10 1903+) or `wsl.exe -e bash -lc "cd /mnt/c/path && exec bash -l"`
- Windows path → WSL path translation: `C:\foo\bar` → `/mnt/c/foo/bar`

## 9. Capabilities Detection Race
**Problem:** Server always sends `{ wsl: true }` even on macOS/Linux. Also, `ready` may be sent before async detection finishes.
**Solution:**
1. Runtime detection at server startup (before accepting connections):
```typescript
async function detectCapabilities() {
  const wsl = process.platform === 'win32' && await commandExists('wsl.exe')
  return { wsl }
}
```
2. In server startup: `await registry.detectCapabilities()` before starting WebSocket server
3. Alternative: Send `ready` with `capabilitiesPending: true`, then push `capabilities.updated` when detection finishes

## 10. Protocol Handshake Not Enforced
**Problem:** Server accepts any message type anytime; `hello` token field unused.
**Solution:** Enforce connection state machine:
- `unauthenticated` → (valid `hello`) → `authenticated` → (`ready` sent) → `ready`
- Reject all messages except `hello` until state is `ready`
- Read token from `hello.token` (not URL query param)

## 11. Auth Token in URL Leaks
**Problem:** `?token=` leaks via browser history, logs, Referer headers.
**Solution:**
- Remove token from URL immediately via `history.replaceState`
- Send token in `hello` message body, not URL
- Set `Referrer-Policy: no-referrer`
- For REST API: `Authorization: Bearer` header only

## 12. Missing Security Headers
**Solution:** Add to Express:
```typescript
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'")
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  next()
})
```
Validate `Origin` header on WebSocket upgrades.

## 13. Fail Closed for Remote Bind
**Problem:** Unauthenticated access allowed when `AUTH_TOKEN` unset with `HOST=0.0.0.0`.
**Solution:** Refuse to start if `HOST` is not loopback and `AUTH_TOKEN` is unset or short (<32 chars):
```typescript
if (!isLoopback(HOST) && (!AUTH_TOKEN || AUTH_TOKEN.length < 32)) {
  console.error('ERROR: AUTH_TOKEN required (min 32 chars) when binding to non-loopback address')
  process.exit(1)
}
```

## 14. Rate Limiting Needed
**Solution:** Add express-rate-limit for auth failures:
```typescript
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
})
app.use('/api', authLimiter)
```
Limit max concurrent WS connections (default 10).

## 15. TerminalRegistry Lifecycle Issues
**Problems:**
- `kill()` sets status `killed`, but `onExit` overwrites to `exited`
- Sessions never removed from map (memory leak)
**Solution:**
- Record `endedReason: 'exit' | 'killed' | 'error'`, don't overwrite in `onExit` if already set
- Implement retention: remove ended sessions after N minutes (default 30), or keep last N (default 100)

## 16. Output Backpressure Not Handled
**Problem:** PTY flood can queue unbounded memory in `ws.send()`.
**Solution:**
- Check `ws.bufferedAmount` before sending
- Drop output if buffer exceeds threshold (1MB), send `terminal.output_dropped` warning
- Consider batching output (accumulate for 16ms, send in batch)

## 17. Message Validation Missing
**Solution:** Validate with zod schema:
```typescript
const TerminalCreateSchema = z.object({
  type: z.literal('terminal.create'),
  shell: z.enum(['cmd', 'powershell', 'wsl']),
  cwd: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  clientRef: z.string().optional(),
})
```
Return structured error for validation failures.

## 18. Request IDs for All Commands
**Solution:** Add `requestId` to all client→server messages; server echoes in response:
```typescript
{ type: 'terminal.create', requestId: 'abc123', ... }
{ type: 'terminal.created', requestId: 'abc123', ... }
{ type: 'error', requestId: 'abc123', code: '...', message: '...' }
```

## 19. Client send() Drops Messages While Connecting
**Problem:** Messages sent before WS is open are lost.
**Solution:** Queue outbound messages until `state === 'connected'` and `ready` received:
```typescript
send(msg: unknown) {
  if (this._state === 'connected' && this.isReady) {
    this.ws?.send(JSON.stringify(msg))
  } else {
    this.pendingMessages.push(msg)
  }
}
// Flush queue after ready received
```

## 20. Keyboard Shortcuts Conflict with Terminal
**Problem:** Global `keydown` steals Ctrl-B even when focus is inside xterm (where users need it for tmux, etc).
**Solution:** Only intercept when focus is NOT inside terminal:
```typescript
const handleKeyDown = (e: KeyboardEvent) => {
  // Don't intercept if focus is inside terminal
  if (document.activeElement?.closest('.xterm')) return
  // ... shortcut handling
}
```

## 21. Mobile UX Not Addressed
**Solution:** Add explicit requirements:
- Responsive sidebar (collapsible on mobile)
- Touch-friendly tab bar with overflow scroll
- On-screen navigation buttons: New Tab / Prev / Next / Close
- Minimum 44px touch targets
- Consider virtual keyboard behavior for terminal input

## 22. Session Path Decoding Is Lossy
**Problem:** Replacing `-` with path separators can't preserve literal hyphens in folder names.
**Solution:** Extract actual project path from `.jsonl` metadata instead of parsing directory name. Session files contain project path in conversation context.

## 23. History "Active Project" Uses tab.cwd
**Problem:** Users `cd` constantly; `tab.cwd` won't reflect actual terminal cwd.
**Solution:** Treat "project" as the initial launch directory (stored as `initialCwd` on tab creation). Label it "Started in:" rather than "Current directory:".

## 24. Overrides Not Wired End-to-End
**Solution:** Implement complete flow:
- `GET /api/sessions` returns merged data (parsed + overrides)
- `PATCH /api/sessions/:id` updates overrides
- `DELETE /api/sessions/:id` sets `deleted: true`
- Watcher applies overrides before broadcasting `sessions.updated`

## 25. ConfigStore Needs Atomic Writes
**Solution:** Write to temp file + rename (atomic on POSIX):
```typescript
async save(config: UserConfig) {
  const tempPath = this.configPath + '.tmp'
  await writeFile(tempPath, JSON.stringify(config, null, 2), { mode: 0o600 })
  await rename(tempPath, this.configPath)
}
```
Set restrictive permissions (0600) for secrets.

## 26. Testing Mocking Issues
**Problem:** `vi.doMock('node-pty')` inside `beforeEach` won't affect already-imported module.
**Solution:** Dependency-inject PTY factory into TerminalRegistry:
```typescript
class TerminalRegistry {
  constructor(private ptyFactory: typeof import('node-pty') = require('node-pty')) {}
  create(options) {
    this.ptyFactory.spawn(...)
  }
}
```
Tests pass mock factory; integration tests use real PTY.

## 27. Browser E2E with LLM Will Be Flaky
**Solution:**
- Use Playwright for deterministic E2E tests (create tab, type, assert output)
- Keep browser-use as separate non-blocking "smoke exploration" suite
- Don't gate CI on LLM-based tests

## 28. Dev/Prod Parity
**Solution:** Document modes clearly:
- **Dev (local)**: Vite on 5173, server on 3001, Vite proxy to server
- **Dev (remote)**: Run `npm run build && npm start` on dev machine, access via IP
- **Production**: Same as dev remote, but with AUTH_TOKEN set

## 29. Logging/Observability
**Solution:** Add structured logging:
```typescript
import pino from 'pino'
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

// Log events
logger.info({ event: 'ws_connect', clientId })
logger.info({ event: 'terminal_create', terminalId, shell, cwd })
logger.warn({ event: 'auth_failed', ip: req.ip })
```
Add `/api/debug` endpoint (auth-protected) returning current sessions, clients, version.

## 30. WSL --cd Support Detection
**Problem:** `--cd` flag requires Windows 10 1903+. Older Windows needs fallback.
**Solution:** Detect at startup:
```typescript
async function detectWslCdSupport(): Promise<boolean> {
  try {
    const { stdout } = await exec('wsl.exe --help')
    return stdout.includes('--cd')
  } catch {
    return false
  }
}

// In create():
if (wslCdSupported) {
  spawn('wsl.exe', ['--cd', wslPath, '-e', shell])
} else {
  spawn('wsl.exe', ['-e', 'bash', '-lc', `cd ${wslPath} && exec bash -l`])
}
```

## 31. WebSocket Origin Validation
**Problem:** Origin header logged but not validated. Reject connections with bad Origin.
**Solution:** Implement at upgrade time:
```typescript
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://localhost:3001',
  // Add production origin
])

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request)
  })
})
```
If origin is missing (some clients), allow only if token is valid.

## 32. Message Size Limits
**Problem:** No cap on WS message size, REST body size, or terminal input.
**Solution:**
```typescript
// Express
app.use(express.json({ limit: '1mb' }))

// WebSocket
const wss = new WebSocketServer({ ..., maxPayload: 1024 * 1024 })

// Terminal input validation
const MAX_INPUT_SIZE = 32 * 1024  // 32KB per message
if (data.length > MAX_INPUT_SIZE) {
  sendError('INPUT_TOO_LARGE', `Input exceeds ${MAX_INPUT_SIZE} bytes`)
  return
}
```

## 33. Backpressure Handling (Revised)
**Problem:** Sending `terminal.output_dropped` when backpressured adds to the buffer.
**Solution:** Stop sending entirely when backpressured:
```typescript
const MAX_BUFFER = 1024 * 1024  // 1MB
let dropWarningsSent = new Set<string>()

function sendToClient(clientId: string, ws: WebSocket, msg: any) {
  if (ws.bufferedAmount > MAX_BUFFER) {
    // Log server-side, don't send warning (adds to backpressure)
    if (!dropWarningsSent.has(clientId)) {
      logger.warn({ event: 'output_dropped', clientId, bufferedAmount: ws.bufferedAmount })
      dropWarningsSent.add(clientId)
    }
    return  // Drop silently
  }
  dropWarningsSent.delete(clientId)
  ws.send(JSON.stringify(msg))
}
```
Alternatively: close connection with code `4008 Backpressure`.

## 34. Ring Buffer Trimming Edge Case
**Problem:** If a single chunk exceeds buffer size, trim loop doesn't remove it.
**Solution:**
```typescript
private trimBuffer(session: TerminalSession) {
  let size = session.outputBuffer.reduce((sum, s) => sum + s.length, 0)
  while (size > this.bufferSize && session.outputBuffer.length > 0) {
    const removed = session.outputBuffer.shift()!
    size -= removed.length
  }
  // If still over (single huge chunk), truncate the last chunk
  if (size > this.bufferSize && session.outputBuffer.length === 1) {
    const chunk = session.outputBuffer[0]
    session.outputBuffer[0] = chunk.slice(-this.bufferSize)
  }
}
```

## 35. Broadcast Through Authenticated Client Registry
**Problem:** `wss.clients.forEach()` sends to unauthenticated sockets.
**Solution:** Maintain authenticated client map:
```typescript
const authenticatedClients = new Map<string, { ws: WebSocket; state: 'ready' }>()

function broadcast(type: string, payload: any) {
  const msg = JSON.stringify({ type, ...payload })
  for (const [clientId, { ws, state }] of authenticatedClients) {
    if (state === 'ready' && ws.readyState === WebSocket.OPEN) {
      ws.send(msg)
    }
  }
}

// Add to map after ready
authenticatedClients.set(clientId, { ws, state: 'ready' })
// Remove on close
ws.on('close', () => authenticatedClients.delete(clientId))
```

## 36. Project Colors Endpoint Path Encoding
**Problem:** `/api/project-colors/:projectPath` fails with slashes in path.
**Solution:** Use JSON body instead:
```typescript
// Instead of: PUT /api/project-colors/:projectPath
// Use: PUT /api/project-colors with body

app.put('/api/project-colors', requireAuth, async (req, res) => {
  const { projectPath, color } = req.body
  if (!projectPath || !color) {
    return res.status(400).json({ error: 'projectPath and color required' })
  }
  await configStore.setProjectColor(projectPath, color)
  res.json({ ok: true })
})
```

## 37. ConfigStore Atomic Write Implementation
**Problem:** `save()` uses plain `writeFile`, not atomic temp+rename.
**Solution:** Implement what the spec says:
```typescript
async save(config: UserConfig) {
  const tempPath = this.configPath + '.tmp'
  const content = JSON.stringify(config, null, 2)

  // Write to temp file with restrictive permissions
  await writeFile(tempPath, content, { mode: 0o600 })

  // Atomic rename (on Windows, may need to delete first)
  if (process.platform === 'win32') {
    await unlink(this.configPath).catch(() => {})  // Ignore if doesn't exist
  }
  await rename(tempPath, this.configPath)
}
```

## 38. Tab Model Needs initialCwd
**Problem:** `tab.cwd` changes when user runs `cd`. Project grouping should use initial directory.
**Solution:** Add `initialCwd` to Tab interface:
```typescript
export interface Tab {
  id: string
  terminalId: string | null
  title: string
  shell: 'cmd' | 'powershell' | 'wsl'
  cwd: string         // Current directory (may change)
  initialCwd: string  // Directory when tab was created (never changes)
  status: 'creating' | 'running' | 'exited'
}

// On addTab:
const tab: Tab = {
  ...action.payload,
  initialCwd: action.payload.cwd,  // Set once, never updated
  status: action.payload.status || 'creating',
}
```
Use `initialCwd` for project grouping in History view.

## 39. Terminal Hidden Tab Sizing
**Problem:** `display: none` on inactive terminals causes xterm measurement failures.
**Solution:** Use offscreen positioning instead of `display: none`:
```typescript
return (
  <div
    ref={containerRef}
    className={`absolute inset-0 ${isActive ? 'visible z-10' : 'invisible z-0'}`}
    style={{ padding: '4px' }}
  />
)
```
Alternative: Only mount active terminal, but keep PTY attachment via `onReconnect`.

## 40. BackgroundSessions Filter Running Only
**Problem:** Shows all detached sessions including killed/exited ones.
**Solution:** Filter by status:
```typescript
const detachedRunning = terminals.filter(t =>
  t.attachedCount === 0 && t.status === 'running'
)
```

## 41. Error Code Taxonomy
**Problem:** Inconsistent error codes across server, client, tests, and docs.
**Solution:** Canonical list (use ONLY these):

| Code | When | HTTP/WS Close |
|------|------|---------------|
| `NOT_AUTHENTICATED` | No hello sent, or hello without valid token | 4001 |
| `INVALID_MESSAGE` | Zod schema validation failure (wrong type/shape) | - |
| `UNKNOWN_MESSAGE` | Unknown message type after auth | - |
| `TERMINAL_NOT_FOUND` | Terminal lookup failed (attach, input, resize, kill) | - |
| `CREATE_FAILED` | PTY spawn failed | - |
| `INPUT_TOO_LARGE` | Terminal input exceeds 32KB limit | - |
| `MAX_CONNECTIONS` | Server at connection limit | 4003 |
| `BACKPRESSURE` | Client can't keep up, connection closed | 4008 |
| `HELLO_TIMEOUT` | Hello not received within 5 seconds | 4002 |

**Client-side handling:**
- On close code 4001 or 4002: stop reconnecting, show auth error
- On close code 4003: show "server busy" message
- On close code 4008: show "connection too slow" warning

All errors include `requestId` if provided in request, plus `terminalId` if applicable.

## 42. Coherent Build/Preview Scripts
**Problem:** `preview` doesn't run `build:server`. `start` expects `dist/server/index.js`.
**Solution:**
```json
{
  "scripts": {
    "build": "npm run build:client && npm run build:server",
    "build:client": "vite build",
    "build:server": "tsc -p tsconfig.server.json",
    "preview": "npm run build && cross-env NODE_ENV=production npm run start",
    "start": "node dist/server/index.js"
  }
}
```
Install `cross-env` for Windows compatibility.

## 43. Shared Types via Zod Schemas
**Problem:** Client and server can drift on message types, shell enums, error codes.
**Solution:** Define schemas once, derive types:
```typescript
// shared/schemas.ts (or common/ folder)
import { z } from 'zod'

export const ShellSchema = z.enum(['cmd', 'powershell', 'wsl'])
export type Shell = z.infer<typeof ShellSchema>

export const ErrorCodeSchema = z.enum([
  'NOT_AUTHENTICATED',
  'INVALID_MESSAGE',
  'UNKNOWN_MESSAGE',
  'TERMINAL_NOT_FOUND',
  'CREATE_FAILED',
  'INPUT_TOO_LARGE',
])
export type ErrorCode = z.infer<typeof ErrorCodeSchema>

export const TerminalCreateSchema = z.object({
  type: z.literal('terminal.create'),
  shell: ShellSchema,
  cwd: z.string(),
  // ...
})
export type TerminalCreateMessage = z.infer<typeof TerminalCreateSchema>
```
Import in both server and client for guaranteed alignment.

## 44. Identity Model Clarification
**Problem:** Multiple IDs exist (`terminalId`, `tab.id`, `sessionId`) without clear ownership.
**Solution:** Document the primary key for each concern:

| Concern | Primary Key | Notes |
|---------|-------------|-------|
| Tab persistence (browser reload) | `tab.id` (client-only) | Stored in localStorage |
| Terminal process lifecycle | `terminalId` (server-issued) | Attached to tab via `tab.terminalId` |
| Claude session history | `sessionId` (from JSONL filename) | Not connected to terminals |
| Project grouping | `tab.initialCwd` or `session.projectPath` | For colors and history grouping |
| User overrides (title, description) | `sessionId` for Claude sessions, `terminalId` for terminals | Stored in config.json |

**Clarifications:**
- "Rename terminal" → updates `tab.title` (client-side only, ephemeral)
- "Rename Claude session" → updates `sessionOverrides[sessionId].titleOverride` (persisted)
- Tab close = detach terminal (terminal keeps running until killed or timeout)
- Tab kill = terminate terminal process

## 45. Claude Session Path Extraction (Non-Lossy)
**Problem:** `parseSessionsIndex()` uses lossy directory name decoding; `extractProjectPathFromSession()` exists but isn't called.
**Solution:** Read project path from JSONL metadata by default:
```typescript
async function parseSessionsIndex(claudeDir: string): Promise<ClaudeSessionRecord[]> {
  const projectDirs = await readdir(join(claudeDir, 'projects'))
  const sessions: ClaudeSessionRecord[] = []

  for (const dirName of projectDirs) {
    const sessionsPath = join(claudeDir, 'projects', dirName)
    const files = await readdir(sessionsPath)

    for (const file of files.filter(f => f.endsWith('.jsonl'))) {
      const sessionId = file.replace('.jsonl', '')
      const fullPath = join(sessionsPath, file)

      // Extract project path from JSONL metadata (first N lines)
      const projectPath = await extractProjectPathFromSession(fullPath)
        || decodeProjectPath(dirName)  // Fallback to lossy decoding

      sessions.push({
        sessionId,
        projectPath,
        lastModified: (await stat(fullPath)).mtime,
      })
    }
  }
  return sessions
}

// Cache extracted paths to avoid repeatedly scanning large files
const projectPathCache = new Map<string, string>()

async function extractProjectPathFromSession(jsonlPath: string): Promise<string | null> {
  if (projectPathCache.has(jsonlPath)) {
    return projectPathCache.get(jsonlPath) || null
  }

  // Read first 10 lines looking for project path
  const lines = await readFirstLines(jsonlPath, 10)
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      // Look for project path in common locations
      if (entry.cwd) {
        projectPathCache.set(jsonlPath, entry.cwd)
        return entry.cwd
      }
      if (entry.projectPath) {
        projectPathCache.set(jsonlPath, entry.projectPath)
        return entry.projectPath
      }
    } catch {
      // Skip invalid JSON lines
    }
  }

  projectPathCache.set(jsonlPath, '')
  return null
}
```

## 46. Origin Validation for Remote Access
**Problem:** Hardcoded origin allowlist doesn't work when HOST=0.0.0.0 (remote access from phone/tablet at different IP).
**Solution:** Compare Origin's host to Host header dynamically instead of using a hardcoded set:
```typescript
function isOriginAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (!origin) return true  // Non-browser clients
  try {
    const originUrl = new URL(origin)
    const expectedHost = hostHeader || `localhost:${PORT}`
    if (originUrl.host === expectedHost) return true
    // Dev mode exceptions...
  } catch { return false }
}
```

## 47. WS Upgrade Handler Must Check /ws Path
**Problem:** Server's upgrade handler accepted any path, not just /ws.
**Solution:** Check pathname before handling upgrade:
```typescript
const url = new URL(request.url || '', `http://${request.headers.host}`)
if (url.pathname !== '/ws') {
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
  socket.destroy()
  return
}
```

## 48. PTY Mock Must Match node-pty API
**Problem:** MockPty used EventEmitter events (`emit('data')`) but node-pty uses `onData()/onExit()` methods returning `{ dispose }`.
**Solution:** Implement mock with correct API:
```typescript
onData(callback: DataCallback): { dispose: () => void } {
  this.dataListeners.push(callback)
  return { dispose: () => { /* remove listener */ } }
}
```

## 49. Command Injection in WSL Path Translation
**Problem:** `exec("wsl.exe wslpath -a \"${windowsPath}\"")` is vulnerable to command injection if path contains backticks or `$()`.
**Solution:** Use `execFile()` with args array:
```typescript
const { stdout } = await promisify(execFile)(
  'wsl.exe',
  ['wslpath', '-a', windowsPath],
  { timeout: 5000 }
)
```

## 50. Error Codes Must Be Canonical
**Problem:** Implementation used ATTACH_FAILED, INPUT_FAILED, RESIZE_FAILED, KILL_FAILED instead of canonical TERMINAL_NOT_FOUND.
**Solution:** Use single error code for all terminal lookup failures:
```typescript
// Before: sendError('ATTACH_FAILED', ...)
// After:  sendError('TERMINAL_NOT_FOUND', 'Terminal not found or not running', ...)
```

## 51. TestTerminal Effect Dependency Array
**Problem:** Effect had `[terminalId]` in deps - when terminal.created fires and sets terminalId, effect re-runs and reinitializes.
**Solution:** Use empty deps `[]` and track terminalId via ref inside effect:
```typescript
const terminalIdRef = useRef<string | null>(null)
useEffect(() => {
  // Use terminalIdRef.current instead of state closure
}, [])  // Empty deps - run once
```

## 52. Initial Prompt Output Lost
**Problem:** PTY may emit initial prompt before UI processes terminal.created, causing lost output.
**Solution:** Send terminal.snapshot immediately after terminal.created:
```typescript
send({ type: 'terminal.created', ... })
const bufferedOutput = registry.getBufferedOutput(session.terminalId)
if (bufferedOutput) {
  send({ type: 'terminal.snapshot', terminalId, data: bufferedOutput })
}
```

## 53. Test Compilation Fixes
**Problem:** Tab tests missing initialCwd, Terminal test asserting wrong class, mock missing methods.
**Solution:**
- Add `initialCwd` to all Tab objects in tests
- Change `toHaveClass('hidden')` → `toHaveClass('invisible')`
- Add `clear()` to xterm mock, `onReconnect()` to ws-client mock

## 54. Tailwind Dark Mode Configuration
**Problem:** Theme toggle won't work without explicit darkMode config.
**Solution:** Add to tailwind.config.js:
```javascript
export default {
  darkMode: ['class'],  // Enable class-based dark mode
  // ...
}
```

## 55. Watcher/wsHandler Race Condition
**Problem:** Watcher may emit before wsHandler is assigned in main().
**Solution:** Start watchers AFTER wsHandler assignment:
```typescript
async function main() {
  // ...
  wsHandler = setupWsHandler(wss, registry)

  // NOW safe to start watcher
  claudeWatcher.on('sessions', (projects) => {
    wsHandler.broadcast('sessions.updated', { projects })
  })
  claudeWatcher.start()

  server.listen(...)
}
```

---

# Architecture

## Data Models

### TerminalSession (Server-side)
```typescript
interface TerminalSession {
  terminalId: string      // Server-issued, random, unguessable
  pid: number
  shell: 'cmd' | 'powershell' | 'wsl'
  cwd: string
  initialCwd: string      // Never changes, used for project identification
  createdAt: Date
  lastActivityAt: Date
  endedAt?: Date          // When status changed from 'running'
  attachedClients: Set<string>  // WebSocket client IDs
  status: 'running' | 'exited' | 'killed'
  endedReason?: 'exit' | 'killed' | 'error'  // Don't overwrite once set
  exitCode?: number
  outputBuffer: string[]  // Ring buffer for scrollback replay
  outputBufferSize: number
}
```

### ClaudeSessionRecord
```typescript
interface ClaudeSessionRecord {
  sessionId: string
  projectPath: string
  lastModified: Date
  // Organizer overrides (stored server-side)
  titleOverride?: string
  descriptionOverride?: string
  colorOverride?: string
  deleted?: boolean  // soft-delete
}
```

### UserConfig (Server-side, ~/.claude-organizer/config.json)
```typescript
interface UserConfig {
  userName: string
  theme: 'light' | 'dark'
  terminalFont: string
  terminalFontSize: number
  terminalTheme: string
  projectColors: Record<string, string>  // projectPath -> color
  sessionOverrides: Record<string, SessionOverrides>
}
```

---

# WebSocket Protocol (Multiplexed, Attach-First)

Single WS per browser session, multiplexed by `terminalId`. All messages support optional `requestId` for client correlation.

## Connection State Machine

```
UNAUTHENTICATED → (hello with valid token) → READY → (messages)
                → (hello with invalid token) → CLOSED
```

**IMPORTANT:** Server rejects all messages except `hello` until state is READY.

## Client → Server

| Message | Payload |
|---------|---------|
| `hello` | `{type:'hello', token, requestId?}` — Token in message body, NOT URL |
| `terminal.create` | `{type:'terminal.create', shell, cwd, cols, rows, clientRef?, requestId?}` |
| `terminal.attach` | `{type:'terminal.attach', terminalId, cols, rows, requestId?}` |
| `terminal.detach` | `{type:'terminal.detach', terminalId, requestId?}` |
| `terminal.input` | `{type:'terminal.input', terminalId, data, requestId?}` |
| `terminal.resize` | `{type:'terminal.resize', terminalId, cols, rows, requestId?}` |
| `terminal.kill` | `{type:'terminal.kill', terminalId, requestId?}` |
| `terminal.list` | `{type:'terminal.list', requestId?}` |

## Server → Client

| Message | Payload |
|---------|---------|
| `ready` | `{type:'ready', requestId?, serverVersion, capabilities:{wsl:boolean}}` |
| `error` | `{type:'error', requestId?, code, message, terminalId?}` |
| `terminal.created` | `{type:'terminal.created', requestId?, terminalId, clientRef?, pid, shell, cwd}` |
| `terminal.output` | `{type:'terminal.output', terminalId, data}` |
| `terminal.exit` | `{type:'terminal.exit', terminalId, exitCode, signal?}` |
| `terminal.attached` | `{type:'terminal.attached', requestId?, terminalId}` |
| `terminal.snapshot` | `{type:'terminal.snapshot', terminalId, data}` — Buffered output replay on attach |
| `terminal.list` | `{type:'terminal.list', requestId?, terminals:[...]}` |

> **Note:** Backpressure is handled by dropping output silently (server-side log only).
> Client will see gaps in output if their connection is too slow.
| `sessions.updated` | `{type:'sessions.updated', projects:[...]}` |
| `settings.updated` | `{type:'settings.updated', settings:{...}}` |

## Attach Semantics

1. On WS reconnect, client sends `hello` with token, server validates and replies `ready`
2. Client re-sends `terminal.attach` for each open tab
3. Server sends `terminal.snapshot` with buffered output (scrollback replay)
4. Server routes PTY output to **current attached clients**, not stale WS objects

## Close vs Detach vs Kill

| Action | Protocol Message | Behavior |
|--------|------------------|----------|
| Tab close (Ctrl-B X) | `terminal.detach` | Process keeps running; can reattach later |
| Tab kill (Ctrl-B Shift-X) | `terminal.kill` | Process terminated immediately |
| Inactivity timeout | Server-side `kill` | Detached sessions cleaned up after N minutes |

---

# Security Model for VPN/Phone Access

1. **Bind host configurable**: `HOST=0.0.0.0` for remote, `HOST=127.0.0.1` for local
2. **Fail closed**: Refuse to start if HOST is non-loopback and AUTH_TOKEN is missing or <32 chars
3. **Auth token required** (`AUTH_TOKEN` env var):
   - REST: `Authorization: Bearer <token>` header
   - WS: Token in `hello` message body (NOT URL query param — URL tokens leak via history/Referer)
4. **Token handling in browser**:
   - Initial URL may include `?token=...` for bookmarkability
   - Token stored in sessionStorage, then removed from URL via `history.replaceState`
   - Never persists token in localStorage (cleared on tab close)
5. **Security headers**: CSP, X-Frame-Options: DENY, X-Content-Type-Options, Referrer-Policy: no-referrer
6. **Rate limiting**: 10 failed auth attempts per 15 minutes, max 10 concurrent WS connections
7. **Production is same-origin**: server serves `/` frontend, API under `/api/*`, WS under `/ws`

---

# Testing Philosophy

## Test Pyramid
- **Unit Tests**: Functions, Redux slices, React components
- **Integration Tests**: Server endpoints, WebSocket protocol, PTY management
- **E2E Tests (Headless)**: Full server stack without browser
- **E2E Tests (Browser - Playwright)**: Deterministic critical path tests - CI-gating
- **E2E Exploration (browser-use)**: LLM-driven smoke tests - non-blocking, advisory only

> **IMPORTANT:** browser-use (LLM) tests are flaky and expensive. Use Playwright for
> deterministic E2E tests that gate CI. Keep browser-use as a separate "exploration suite"
> that runs on-demand and provides advisory feedback, not pass/fail gates.

## Minimal Mocking Policy

| Component | Mock? | Strategy |
|-----------|-------|----------|
| File System | **No** | Use temp directories |
| node-pty | **Via DI** | Inject mock factory in tests, real in integration |
| WebSocket | **No** | Real ws connections |
| Express Server | **No** | Real server on random port |
| Redux Store | **No** | Real store |
| AI/LLM APIs | **Yes** | Mock responses |

> **Note on node-pty mocking:** Use constructor dependency injection, not `vi.mock`.
> The TerminalRegistry constructor accepts an optional `ptyFactory` parameter.

## Test Organization
```
├── src/
│   ├── components/__tests__/
│   ├── store/__tests__/
│   └── lib/__tests__/
├── server/__tests__/
├── test/
│   ├── fixtures/
│   ├── helpers/
│   ├── integration/
│   ├── e2e/           # Playwright - deterministic, CI-gating
│   └── browser/       # browser-use - exploration, non-gating
```

---

# Release Plan

## Release 1 — Remote-capable PTY + WSL + Correct Attach/Reattach

**Purpose:** Prove that from phone over VPN you can authenticate, create terminals, use WSL, and reattach after connection loss.

**Exit Criteria:** Attach works reliably; PTY output routing correct after reconnect; WSL works.

---

### Task 1.1: Initialize Project

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`
- Create: `src/main.tsx`, `src/App.tsx`

**Step 1: Initialize Vite project**
```bash
npm create vite@latest . -- --template react-ts
npm install
```

**Step 2: Verify dev server**
```bash
npm run dev
```
Expected: Server at http://localhost:5173

**Step 3: Commit**
```bash
git add -A && git commit -m "chore: initialize Vite + React + TypeScript"
```

---

### Task 1.2: Add Tailwind CSS + shadcn/ui

**Files:**
- Create: `tailwind.config.js`, `postcss.config.js`
- Modify: `src/index.css`

**Step 1: Install and configure Tailwind**
```bash
npm install -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

**Step 2: Configure content paths in `tailwind.config.js`**
```javascript
/** @type {import('tailwindcss').Config} */
export default {
  // REQUIRED: Enable class-based dark mode for theme toggle to work
  // Without this, dark: variants won't respond to class="dark" on html/body
  darkMode: ['class'],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: { extend: {} },
  plugins: [],
}
```

**Step 3: Add directives to `src/index.css`**
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

**Step 4: Initialize shadcn/ui**
```bash
npx shadcn@latest init
npx shadcn@latest add button
```

**Step 5: Commit**
```bash
git add -A && git commit -m "chore: add Tailwind CSS + shadcn/ui"
```

---

### Task 1.3: Add Testing Infrastructure

**Files:**
- Create: `vitest.config.ts`, `vitest.server.config.ts`
- Create: `test/setup/dom.ts`, `test/setup/server.ts`
- Create: `test/helpers/server.ts`, `test/helpers/ws.ts`, `test/helpers/pty-mock.ts`

**Step 1: Install testing dependencies**
```bash
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom supertest superwstest @types/supertest
```

**Step 2: Create frontend Vitest config (`vitest.config.ts`)**
```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@test': path.resolve(__dirname, './test'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup/dom.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
```

**Step 3: Create server Vitest config (`vitest.server.config.ts`)**
```typescript
import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@test': path.resolve(__dirname, './test'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./test/setup/server.ts'],
    include: ['server/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30000,
  },
})
```

**Step 4: Create DOM test setup (`test/setup/dom.ts`)**
```typescript
import '@testing-library/jest-dom'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(() => cleanup())

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}))

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
})
```

**Step 5: Create server test setup (`test/setup/server.ts`)**
```typescript
import { afterAll, beforeAll } from 'vitest'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

export const TEST_TEMP_DIR = join(tmpdir(), 'claude-organizer-test', process.pid.toString())

beforeAll(async () => {
  await mkdir(TEST_TEMP_DIR, { recursive: true })
  process.env.NODE_ENV = 'test'
  process.env.TEST_TEMP_DIR = TEST_TEMP_DIR
})

afterAll(async () => {
  await rm(TEST_TEMP_DIR, { recursive: true, force: true })
})
```

**Step 6: Create test server helper (`test/helpers/server.ts`)**
```typescript
import express, { Express } from 'express'
import { Server } from 'http'
import { WebSocketServer } from 'ws'
import { AddressInfo } from 'net'

export interface TestServer {
  app: Express
  server: Server
  wss: WebSocketServer
  baseUrl: string
  wsUrl: string
  close: () => Promise<void>
}

export async function createTestServer(
  setup: (app: Express, wss: WebSocketServer) => void
): Promise<TestServer> {
  const app = express()
  const server = app.listen(0) // Random port
  const wss = new WebSocketServer({ server, path: '/ws' })

  setup(app, wss)

  await new Promise<void>(resolve => server.on('listening', resolve))
  const { port } = server.address() as AddressInfo

  return {
    app,
    server,
    wss,
    baseUrl: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}/ws`,
    close: () => new Promise(resolve => {
      wss.close()
      server.close(() => resolve())
    }),
  }
}
```

**Step 7: Create WebSocket test helper (`test/helpers/ws.ts`)**

> **IMPORTANT:** Token is sent in `hello` message body, NOT URL query param.
> The helper optionally auto-sends hello after open for convenience.

```typescript
import WebSocket from 'ws'

export interface WsTestClient {
  ws: WebSocket
  messages: unknown[]
  send: (msg: unknown) => void
  sendHello: (token?: string) => void
  waitForMessage: (predicate: (msg: unknown) => boolean, timeout?: number) => Promise<unknown>
  waitForReady: (timeout?: number) => Promise<unknown>
  close: () => void
}

export interface WsTestClientOptions {
  autoHello?: boolean   // If true, auto-send hello on open (default: false)
  token?: string        // Token to include in hello message
}

export function createWsTestClient(
  url: string,
  options: WsTestClientOptions = {}
): Promise<WsTestClient> {
  return new Promise((resolve, reject) => {
    // NO token in URL - protocol requires hello message body
    const ws = new WebSocket(url)
    const messages: unknown[] = []
    const waiters: Array<{ predicate: (msg: unknown) => boolean; resolve: (msg: unknown) => void }> = []

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      messages.push(msg)

      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].predicate(msg)) {
          waiters[i].resolve(msg)
          waiters.splice(i, 1)
        }
      }
    })

    ws.on('open', () => {
      const client: WsTestClient = {
        ws,
        messages,
        send: (msg) => ws.send(JSON.stringify(msg)),
        sendHello: (token?: string) => {
          ws.send(JSON.stringify({ type: 'hello', token }))
        },
        waitForMessage: (predicate, timeout = 5000) => {
          const existing = messages.find(predicate)
          if (existing) return Promise.resolve(existing)

          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('Timeout waiting for message')), timeout)
            waiters.push({
              predicate,
              resolve: (msg) => {
                clearTimeout(timer)
                res(msg)
              },
            })
          })
        },
        waitForReady: (timeout = 5000) => {
          return client.waitForMessage((m: any) => m.type === 'ready', timeout)
        },
        close: () => ws.close(),
      }

      // Optionally auto-send hello
      if (options.autoHello) {
        client.sendHello(options.token)
      }

      resolve(client)
    })

    ws.on('error', reject)
  })
}
```

**Step 8: Create PTY mock helper (`test/helpers/pty-mock.ts`)**

> **CRITICAL:** node-pty does NOT use EventEmitter events. It uses `onData()` and `onExit()`
> methods that return `{ dispose }` objects. The mock must match this API.

```typescript
import { vi } from 'vitest'

type DataCallback = (data: string) => void
type ExitCallback = (e: { exitCode: number; signal?: number }) => void

export class MockPty {
  pid = 12345
  cols = 80
  rows = 24

  private dataListeners: DataCallback[] = []
  private exitListeners: ExitCallback[] = []

  write = vi.fn((data: string) => {
    // Echo input back as output
    setTimeout(() => this.emitData(data), 10)
  })

  resize = vi.fn((cols: number, rows: number) => {
    this.cols = cols
    this.rows = rows
  })

  kill = vi.fn(() => {
    this.emitExit({ exitCode: 0 })
  })

  clear = vi.fn()

  // node-pty API: onData returns { dispose } not EventEmitter
  onData(callback: DataCallback): { dispose: () => void } {
    this.dataListeners.push(callback)
    return {
      dispose: () => {
        const idx = this.dataListeners.indexOf(callback)
        if (idx !== -1) this.dataListeners.splice(idx, 1)
      }
    }
  }

  // node-pty API: onExit returns { dispose } not EventEmitter
  onExit(callback: ExitCallback): { dispose: () => void } {
    this.exitListeners.push(callback)
    return {
      dispose: () => {
        const idx = this.exitListeners.indexOf(callback)
        if (idx !== -1) this.exitListeners.splice(idx, 1)
      }
    }
  }

  // Test helpers - simulate PTY events
  private emitData(data: string) {
    this.dataListeners.forEach(cb => cb(data))
  }

  private emitExit(e: { exitCode: number; signal?: number }) {
    this.exitListeners.forEach(cb => cb(e))
  }

  simulateOutput(data: string) {
    this.emitData(data)
  }

  simulateExit(code: number, signal?: number) {
    this.emitExit({ exitCode: code, signal })
  }
}

export function createPtyMock() {
  const instances: MockPty[] = []

  return {
    spawn: vi.fn(() => {
      const pty = new MockPty()
      instances.push(pty)
      return pty
    }),
    instances,
    getLastInstance: () => instances[instances.length - 1],
  }
}

// Use real PTY unless MOCK_PTY=true or in CI
export const shouldMockPty = process.env.MOCK_PTY === 'true' || process.env.CI === 'true'
```

**Step 9: Add test scripts to `package.json`**
```json
{
  "scripts": {
    "test": "vitest",
    "test:server": "vitest --config vitest.server.config.ts",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest run --coverage"
  }
}
```

**Step 10: Commit**
```bash
git add -A && git commit -m "chore: add testing infrastructure"
```

---

### Task 1.4: Create Server with Auth + Terminal Registry

**Files:**
- Create: `server/index.ts`
- Create: `server/auth.ts`
- Create: `server/terminal-registry.ts`
- Create: `server/ws-handler.ts`
- Create: `server/__tests__/auth.test.ts`
- Create: `server/__tests__/terminal-registry.test.ts`

**Step 1: Install server dependencies**
```bash
npm install express ws node-pty dotenv zod pino express-rate-limit
npm install -D @types/express @types/ws tsx pino-pretty
```

**Step 2: Create auth middleware (`server/auth.ts`)**
```typescript
import { Request, Response, NextFunction } from 'express'
import { IncomingMessage } from 'http'

// IMPORTANT: Read AUTH_TOKEN dynamically, not at import time
// This allows tests to mutate process.env and supports live config reload
function getAuthToken(): string | undefined {
  return process.env.AUTH_TOKEN
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const AUTH_TOKEN = getAuthToken()  // Read dynamically each call

  if (!AUTH_TOKEN) {
    // No auth configured - allow all (dev mode on loopback only)
    return next()
  }

  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' })
  }

  const token = authHeader.slice(7)
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Invalid token' })
  }

  next()
}

// WS auth: token comes from hello message body, NOT URL query param
// URL tokens leak via browser history, logs, and Referer headers
export function validateWsToken(token: string | undefined): boolean {
  const AUTH_TOKEN = getAuthToken()  // Read dynamically each call

  if (!AUTH_TOKEN) return true  // Dev mode
  return token === AUTH_TOKEN
}

// Called at startup to enforce fail-closed security
export function validateStartupSecurity(host: string): void {
  const AUTH_TOKEN = getAuthToken()

  if (!isLoopback(host)) {
    if (!AUTH_TOKEN) {
      console.error('ERROR: AUTH_TOKEN required when binding to non-loopback address')
      process.exit(1)
    }
    if (AUTH_TOKEN.length < 32) {
      console.error('ERROR: AUTH_TOKEN must be at least 32 characters for remote access')
      process.exit(1)
    }
  }
}
```

**Step 3: Create terminal registry (`server/terminal-registry.ts`)**
```typescript
import * as defaultPty from 'node-pty'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { execSync, execFile } from 'child_process'
import { promisify } from 'util'

// Output buffer for scrollback replay on reattach
const DEFAULT_BUFFER_SIZE = 100 * 1024  // 100KB
const SESSION_RETENTION_MS = 30 * 60 * 1000  // 30 minutes after ended
const MAX_ENDED_SESSIONS = 100

export interface TerminalSession {
  terminalId: string
  pty: defaultPty.IPty
  shell: 'cmd' | 'powershell' | 'wsl'
  cwd: string
  initialCwd: string  // Never changes, used for project identification
  createdAt: Date
  lastActivityAt: Date
  endedAt?: Date
  attachedClients: Set<string>
  status: 'running' | 'exited' | 'killed'
  endedReason?: 'exit' | 'killed' | 'error'  // Don't overwrite once set
  exitCode?: number
  outputBuffer: string[]  // Ring buffer for scrollback
  outputBufferSize: number
  clientRefMap: Map<string, number>  // clientRef -> timestamp for dedupe
}

// Dependency injection for testing
export type PtyFactory = typeof defaultPty

export class TerminalRegistry extends EventEmitter {
  private sessions = new Map<string, TerminalSession>()
  private cleanupInterval: NodeJS.Timeout | null = null
  private capabilities: { wsl: boolean; defaultDistro?: string } | null = null

  constructor(
    private ptyFactory: PtyFactory = defaultPty,
    private bufferSize: number = DEFAULT_BUFFER_SIZE
  ) {
    super()
    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanupEndedSessions(), 60000)
  }

  // Runtime capability detection (called once, cached)
  async detectCapabilities(): Promise<{ wsl: boolean; defaultDistro?: string; wslCdSupported?: boolean }> {
    if (this.capabilities) return this.capabilities

    if (process.platform !== 'win32') {
      this.capabilities = { wsl: false }
      return this.capabilities
    }

    try {
      // Check if WSL is available and get default distro
      const output = execSync('wsl.exe -l -q', { encoding: 'utf8', timeout: 5000 })
      const distros = output.split('\n').map(s => s.trim()).filter(Boolean)

      // Check if --cd flag is supported (Windows 10 1903+)
      let wslCdSupported = false
      try {
        const helpOutput = execSync('wsl.exe --help', { encoding: 'utf8', timeout: 5000 })
        wslCdSupported = helpOutput.includes('--cd')
      } catch {
        // --help failed, assume --cd not supported
      }

      this.capabilities = {
        wsl: distros.length > 0,
        defaultDistro: distros[0] || undefined,
        wslCdSupported,
      }
    } catch {
      this.capabilities = { wsl: false }
    }

    return this.capabilities
  }

  getCapabilities(): { wsl: boolean; defaultDistro?: string; wslCdSupported?: boolean } {
    return this.capabilities || { wsl: false }
  }

  // Convert Windows path to WSL path
  // Prefer wslpath command for robust translation (handles spaces, UNC paths, etc.)
  // SECURITY: Use execFile() with args array, NOT exec() with string interpolation
  // exec("...\"${path}\"...") is COMMAND INJECTION if path contains backticks or $()
  private async windowsToWslPath(windowsPath: string): Promise<string> {
    try {
      // Use execFile for security - path is passed as argument, not interpolated into shell
      const { stdout } = await promisify(execFile)(
        'wsl.exe',
        ['wslpath', '-a', windowsPath],
        { timeout: 5000 }
      )
      return stdout.trim()
    } catch {
      // Fallback to manual translation
      // C:\foo\bar -> /mnt/c/foo/bar
      const match = windowsPath.match(/^([A-Za-z]):\\(.*)$/)
      if (!match) return windowsPath
      const [, drive, rest] = match
      return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`
    }
  }

  async create(options: {
    shell: 'cmd' | 'powershell' | 'wsl'
    cwd: string
    cols: number
    rows: number
    clientRef?: string  // For StrictMode dedupe
  }): Promise<TerminalSession> {
    // StrictMode dedupe: if same clientRef within 2 seconds, return existing
    if (options.clientRef) {
      for (const session of this.sessions.values()) {
        const timestamp = session.clientRefMap.get(options.clientRef)
        if (timestamp && Date.now() - timestamp < 2000) {
          return session  // Return existing instead of creating duplicate
        }
      }
    }

    const terminalId = randomUUID()

    // Determine shell executable and args
    let shellExe: string
    let shellArgs: string[] = []
    let ptyCwd = options.cwd

    switch (options.shell) {
      case 'wsl': {
        shellExe = 'wsl.exe'
        const caps = this.getCapabilities()
        if (caps.defaultDistro) {
          shellArgs = ['-d', caps.defaultDistro]
        }

        // WSL cwd handling: prefer wslpath for robust translation
        const wslPath = await this.windowsToWslPath(options.cwd)

        // Use --cd flag if supported (Windows 10 1903+), otherwise use cd fallback
        if (caps.wslCdSupported) {
          shellArgs.push('--cd', wslPath)
        } else {
          // Fallback: use bash -lc to cd and exec shell
          shellArgs.push('-e', 'bash', '-lc', `cd "${wslPath}" && exec bash -l`)
        }
        ptyCwd = undefined as any  // Don't use Windows cwd for WSL
        break
      }
      case 'powershell':
        shellExe = 'powershell.exe'
        break
      case 'cmd':
      default:
        shellExe = 'cmd.exe'
    }

    const ptyProcess = this.ptyFactory.spawn(shellExe, shellArgs, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: ptyCwd,
      env: process.env as Record<string, string>,
    })

    const session: TerminalSession = {
      terminalId,
      pty: ptyProcess,
      shell: options.shell,
      cwd: options.cwd,
      initialCwd: options.cwd,  // Never changes
      createdAt: new Date(),
      lastActivityAt: new Date(),
      attachedClients: new Set(),
      status: 'running',
      outputBuffer: [],
      outputBufferSize: 0,
      clientRefMap: new Map(),
    }

    // Track clientRef for dedupe
    if (options.clientRef) {
      session.clientRefMap.set(options.clientRef, Date.now())
    }

    ptyProcess.onData((data) => {
      session.lastActivityAt = new Date()

      // Add to ring buffer (track BYTES, not characters - non-ASCII can exceed limit)
      const dataBytes = Buffer.byteLength(data, 'utf8')
      session.outputBuffer.push(data)
      session.outputBufferSize += dataBytes

      // Trim buffer if too large
      while (session.outputBufferSize > this.bufferSize && session.outputBuffer.length > 1) {
        const removed = session.outputBuffer.shift()!
        session.outputBufferSize -= Buffer.byteLength(removed, 'utf8')
      }

      // Edge case: single huge chunk exceeds buffer
      // Truncate to fit (keep only the tail)
      if (session.outputBufferSize > this.bufferSize && session.outputBuffer.length === 1) {
        const chunk = session.outputBuffer[0]
        // Estimate character count to keep (conservative: assume 1 char = 1 byte)
        const excess = session.outputBufferSize - this.bufferSize
        session.outputBuffer[0] = chunk.slice(excess)
        session.outputBufferSize = Buffer.byteLength(session.outputBuffer[0], 'utf8')
      }

      this.emit('output', terminalId, data)
    })

    ptyProcess.onExit(({ exitCode, signal }) => {
      // Don't overwrite status/reason if already set (e.g., by kill())
      if (session.status === 'running') {
        session.status = 'exited'
        session.endedReason = 'exit'
      }
      session.exitCode = exitCode
      session.endedAt = new Date()
      this.emit('exit', terminalId, exitCode, signal)
    })

    this.sessions.set(terminalId, session)
    this.emit('created', session)

    return session
  }

  get(terminalId: string): TerminalSession | undefined {
    return this.sessions.get(terminalId)
  }

  // Get buffered output for replay on reattach
  getBufferedOutput(terminalId: string): string {
    const session = this.sessions.get(terminalId)
    return session?.outputBuffer.join('') || ''
  }

  attach(terminalId: string, clientId: string): boolean {
    const session = this.sessions.get(terminalId)
    if (!session || session.status !== 'running') return false

    session.attachedClients.add(clientId)
    return true
  }

  detach(terminalId: string, clientId: string): void {
    const session = this.sessions.get(terminalId)
    if (session) {
      session.attachedClients.delete(clientId)
    }
  }

  detachAll(clientId: string): void {
    for (const session of this.sessions.values()) {
      session.attachedClients.delete(clientId)
    }
  }

  write(terminalId: string, data: string): boolean {
    const session = this.sessions.get(terminalId)
    if (!session || session.status !== 'running') return false

    session.lastActivityAt = new Date()
    session.pty.write(data)
    return true
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(terminalId)
    if (!session || session.status !== 'running') return false

    session.pty.resize(cols, rows)
    return true
  }

  kill(terminalId: string): boolean {
    const session = this.sessions.get(terminalId)
    if (!session || session.status !== 'running') return false

    session.status = 'killed'
    session.endedReason = 'killed'  // Set before pty.kill() triggers onExit
    session.endedAt = new Date()
    session.pty.kill()
    return true
  }

  list(): TerminalSession[] {
    return Array.from(this.sessions.values())
  }

  listRunning(): TerminalSession[] {
    return this.list().filter(s => s.status === 'running')
  }

  getAttachedClients(terminalId: string): Set<string> {
    return this.sessions.get(terminalId)?.attachedClients ?? new Set()
  }

  // Cleanup ended sessions to prevent memory leak
  private cleanupEndedSessions(): void {
    const now = Date.now()
    const ended = this.list().filter(s => s.status !== 'running')

    // Remove sessions older than retention period
    for (const session of ended) {
      if (session.endedAt && now - session.endedAt.getTime() > SESSION_RETENTION_MS) {
        this.sessions.delete(session.terminalId)
      }
    }

    // Also enforce max count
    const remaining = this.list().filter(s => s.status !== 'running')
    if (remaining.length > MAX_ENDED_SESSIONS) {
      // Sort by endedAt, remove oldest
      remaining.sort((a, b) => (a.endedAt?.getTime() || 0) - (b.endedAt?.getTime() || 0))
      for (let i = 0; i < remaining.length - MAX_ENDED_SESSIONS; i++) {
        this.sessions.delete(remaining[i].terminalId)
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
    // Kill all running sessions
    for (const session of this.sessions.values()) {
      if (session.status === 'running') {
        try { session.pty.kill() } catch {}
      }
    }
    this.sessions.clear()
  }
}
```

**Step 4: Create WebSocket handler (`server/ws-handler.ts`)**
```typescript
import { WebSocketServer, WebSocket } from 'ws'
import { IncomingMessage } from 'http'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { TerminalRegistry } from './terminal-registry'
import { validateWsToken } from './auth'
import { logger } from './logger'

// Max buffer before dropping output
const MAX_WS_BUFFER = 1024 * 1024  // 1MB
const MAX_CONNECTIONS = 10

// Message validation schemas
const HelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().optional(),
  requestId: z.string().optional(),
})

const TerminalCreateSchema = z.object({
  type: z.literal('terminal.create'),
  shell: z.enum(['cmd', 'powershell', 'wsl']),
  cwd: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  clientRef: z.string().optional(),
  requestId: z.string().optional(),
})

const TerminalAttachSchema = z.object({
  type: z.literal('terminal.attach'),
  terminalId: z.string().uuid(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  requestId: z.string().optional(),
})

const TerminalDetachSchema = z.object({
  type: z.literal('terminal.detach'),
  terminalId: z.string().uuid(),
  requestId: z.string().optional(),
})

const TerminalInputSchema = z.object({
  type: z.literal('terminal.input'),
  terminalId: z.string().uuid(),
  data: z.string(),
  requestId: z.string().optional(),
})

const TerminalResizeSchema = z.object({
  type: z.literal('terminal.resize'),
  terminalId: z.string().uuid(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  requestId: z.string().optional(),
})

const TerminalKillSchema = z.object({
  type: z.literal('terminal.kill'),
  terminalId: z.string().uuid(),
  requestId: z.string().optional(),
})

const TerminalListSchema = z.object({
  type: z.literal('terminal.list'),
  requestId: z.string().optional(),
})

// Connection state machine
type ConnectionState = 'unauthenticated' | 'authenticated' | 'ready'

interface ClientState {
  ws: WebSocket
  state: ConnectionState
  clientId: string
}

// Return type includes broadcast function for external use
export interface WsHandler {
  broadcast: (type: string, payload: any) => void
}

export function setupWsHandler(wss: WebSocketServer, registry: TerminalRegistry): WsHandler {
  const clients = new Map<string, ClientState>()

  // Broadcast to authenticated (ready) clients only - prevents sending to unauthenticated sockets
  function broadcast(type: string, payload: any) {
    const msg = JSON.stringify({ type, ...payload })
    for (const [, client] of clients) {
      if (client.state === 'ready' && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg)
      }
    }
  }

  // Validate Origin header on upgrade
  wss.on('headers', (headers, req) => {
    const origin = req.headers.origin
    // In production, validate origin against allowed list
    // For now, log for observability
    logger.debug({ event: 'ws_upgrade', origin, ip: req.socket.remoteAddress })
  })

  // Track clients with active backpressure (to avoid log spam)
  const backpressuredClients = new Set<string>()

  // Route terminal output to attached clients with backpressure handling
  registry.on('output', (terminalId: string, data: string) => {
    const attachedClients = registry.getAttachedClients(terminalId)
    for (const clientId of attachedClients) {
      const client = clients.get(clientId)
      if (!client || client.ws.readyState !== WebSocket.OPEN) continue

      // Backpressure: check buffer before sending
      if (client.ws.bufferedAmount > MAX_WS_BUFFER) {
        // Drop silently, log server-side only (once per client per backpressure window)
        // DON'T send terminal.output_dropped - it worsens the backpressure!
        if (!backpressuredClients.has(clientId)) {
          backpressuredClients.add(clientId)
          logger.warn({
            event: 'output_dropped',
            clientId,
            terminalId,
            bufferedAmount: client.ws.bufferedAmount
          })
        }
        continue
      }

      // Clear backpressure flag when buffer drains
      backpressuredClients.delete(clientId)

      client.ws.send(JSON.stringify({ type: 'terminal.output', terminalId, data }))
    }
  })

  registry.on('exit', (terminalId: string, exitCode: number, signal?: number) => {
    const attachedClients = registry.getAttachedClients(terminalId)
    for (const clientId of attachedClients) {
      const client = clients.get(clientId)
      if (client?.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ type: 'terminal.exit', terminalId, exitCode, signal }))
      }
    }
  })

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Enforce max connections
    if (clients.size >= MAX_CONNECTIONS) {
      logger.warn({ event: 'ws_rejected', reason: 'max_connections' })
      ws.close(4003, 'Max connections exceeded')
      return
    }

    const clientId = randomUUID()
    const clientState: ClientState = {
      ws,
      state: 'unauthenticated',  // Must send hello with valid token first
      clientId,
    }
    clients.set(clientId, clientState)

    logger.info({ event: 'ws_connect', clientId, ip: req.socket.remoteAddress })

    // Hello timeout: prevent connection-slot DoS by clients that never send hello
    const HELLO_TIMEOUT_MS = 5000
    const helloTimeout = setTimeout(() => {
      if (clientState.state === 'unauthenticated') {
        logger.warn({ event: 'hello_timeout', clientId })
        ws.close(4002, 'Hello timeout')
      }
    }, HELLO_TIMEOUT_MS)

    const send = (msg: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg))
      }
    }

    const sendError = (code: string, message: string, requestId?: string, terminalId?: string) => {
      send({ type: 'error', code, message, requestId, terminalId })
    }

    ws.on('message', async (data) => {
      let msg: unknown
      try {
        msg = JSON.parse(data.toString())
      } catch {
        sendError('INVALID_MESSAGE', 'Invalid JSON')
        return
      }

      // Extract type for routing
      const type = (msg as any)?.type
      const requestId = (msg as any)?.requestId

      // State machine enforcement: only allow 'hello' until authenticated
      if (clientState.state === 'unauthenticated') {
        if (type !== 'hello') {
          sendError('NOT_AUTHENTICATED', 'Must send hello first', requestId)
          return
        }

        const parsed = HelloSchema.safeParse(msg)
        if (!parsed.success) {
          sendError('INVALID_MESSAGE', 'Invalid hello message', requestId)
          return
        }

        // Validate token from hello message body (NOT URL)
        if (!validateWsToken(parsed.data.token)) {
          clearTimeout(helloTimeout)  // Clear timeout before closing
          logger.warn({ event: 'ws_auth_failed', clientId })
          sendError('NOT_AUTHENTICATED', 'Invalid token', requestId)
          ws.close(4001, 'Unauthorized')
          return
        }

        // Hello received successfully - clear timeout
        clearTimeout(helloTimeout)

        clientState.state = 'ready'
        const caps = registry.getCapabilities()
        send({
          type: 'ready',
          requestId,
          serverVersion: '1.0.0',
          capabilities: { wsl: caps.wsl },
        })
        logger.info({ event: 'ws_authenticated', clientId })
        return
      }

      // All other messages require ready state
      if (clientState.state !== 'ready') {
        sendError('NOT_READY', 'Connection not ready', requestId)
        return
      }

      switch (type) {
        case 'terminal.create': {
          const parsed = TerminalCreateSchema.safeParse(msg)
          if (!parsed.success) {
            sendError('INVALID_MESSAGE', parsed.error.message, requestId)
            return
          }
          const { shell, cwd, cols, rows, clientRef } = parsed.data

          try {
            // create() is async (WSL path translation may need wslpath call)
            const session = await registry.create({ shell, cwd, cols, rows, clientRef })
            registry.attach(session.terminalId, clientId)
            logger.info({ event: 'terminal_create', clientId, terminalId: session.terminalId, shell, cwd })
            send({
              type: 'terminal.created',
              requestId,
              terminalId: session.terminalId,
              clientRef,
              pid: session.pty.pid,
              shell: session.shell,
              cwd: session.cwd,
            })

            // CRITICAL: Send initial snapshot immediately after created
            // The PTY may have already emitted the shell prompt before the client
            // processes terminal.created. Without this, the initial prompt is lost.
            const bufferedOutput = registry.getBufferedOutput(session.terminalId)
            if (bufferedOutput) {
              send({ type: 'terminal.snapshot', terminalId: session.terminalId, data: bufferedOutput })
            }
          } catch (err) {
            logger.error({ event: 'terminal_create_failed', clientId, error: (err as Error).message })
            sendError('CREATE_FAILED', (err as Error).message, requestId)
          }
          break
        }

        case 'terminal.attach': {
          const parsed = TerminalAttachSchema.safeParse(msg)
          if (!parsed.success) {
            sendError('INVALID_MESSAGE', parsed.error.message, requestId)
            return
          }
          const { terminalId, cols, rows } = parsed.data

          if (registry.attach(terminalId, clientId)) {
            registry.resize(terminalId, cols, rows)
            logger.info({ event: 'terminal_attach', clientId, terminalId })

            // Send buffered output for scrollback replay
            const bufferedOutput = registry.getBufferedOutput(terminalId)
            send({ type: 'terminal.attached', requestId, terminalId })
            if (bufferedOutput) {
              send({ type: 'terminal.snapshot', terminalId, data: bufferedOutput })
            }
          } else {
            sendError('TERMINAL_NOT_FOUND', 'Terminal not found or not running', requestId, terminalId)
          }
          break
        }

        case 'terminal.detach': {
          const parsed = TerminalDetachSchema.safeParse(msg)
          if (!parsed.success) {
            sendError('INVALID_MESSAGE', parsed.error.message, requestId)
            return
          }
          registry.detach(parsed.data.terminalId, clientId)
          logger.info({ event: 'terminal_detach', clientId, terminalId: parsed.data.terminalId })
          break
        }

        case 'terminal.input': {
          const parsed = TerminalInputSchema.safeParse(msg)
          if (!parsed.success) {
            sendError('INVALID_MESSAGE', parsed.error.message, requestId)
            return
          }
          const { terminalId, data: inputData } = parsed.data

          // DoS protection: limit input size per message
          const MAX_INPUT_SIZE = 32 * 1024  // 32KB
          if (inputData.length > MAX_INPUT_SIZE) {
            sendError('INPUT_TOO_LARGE', `Input exceeds ${MAX_INPUT_SIZE} bytes`, requestId, terminalId)
            return
          }

          if (!registry.write(terminalId, inputData)) {
            sendError('TERMINAL_NOT_FOUND', 'Terminal not found or not running', requestId, terminalId)
          }
          break
        }

        case 'terminal.resize': {
          const parsed = TerminalResizeSchema.safeParse(msg)
          if (!parsed.success) {
            sendError('INVALID_MESSAGE', parsed.error.message, requestId)
            return
          }
          const { terminalId, cols, rows } = parsed.data
          if (!registry.resize(terminalId, cols, rows)) {
            sendError('TERMINAL_NOT_FOUND', 'Terminal not found or not running', requestId, terminalId)
          }
          break
        }

        case 'terminal.kill': {
          const parsed = TerminalKillSchema.safeParse(msg)
          if (!parsed.success) {
            sendError('INVALID_MESSAGE', parsed.error.message, requestId)
            return
          }
          const { terminalId } = parsed.data
          if (!registry.kill(terminalId)) {
            sendError('TERMINAL_NOT_FOUND', 'Terminal not found or not running', requestId, terminalId)
          } else {
            logger.info({ event: 'terminal_kill', clientId, terminalId })
          }
          break
        }

        case 'terminal.list': {
          const parsed = TerminalListSchema.safeParse(msg)
          if (!parsed.success) {
            sendError('INVALID_MESSAGE', parsed.error.message, requestId)
            return
          }
          const terminals = registry.list().map(s => ({
            terminalId: s.terminalId,
            shell: s.shell,
            cwd: s.cwd,
            initialCwd: s.initialCwd,
            status: s.status,
            createdAt: s.createdAt.toISOString(),
            attachedCount: s.attachedClients.size,
          }))
          send({ type: 'terminal.list', requestId, terminals })
          break
        }

        default:
          sendError('UNKNOWN_MESSAGE', `Unknown message type: ${type}`, requestId)
      }
    })

    ws.on('close', () => {
      registry.detachAll(clientId)
      clients.delete(clientId)
      logger.info({ event: 'ws_disconnect', clientId })
    })

    ws.on('error', (err) => {
      logger.error({ event: 'ws_error', clientId, error: err.message })
    })
  })

  // Return broadcast function for external use (sessions, settings updates)
  return { broadcast }
}
```

**Step 4b: Create logger (`server/logger.ts`)**
```typescript
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
})
```

**Step 5: Create main server (`server/index.ts`)**

> **IMPORTANT:** Wrap startup in `async main()` because CommonJS doesn't support top-level await.
> Use `noServer: true` for WebSocketServer to avoid double-handling upgrades.

```typescript
import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import path from 'path'
import rateLimit from 'express-rate-limit'
import { TerminalRegistry } from './terminal-registry'
import { setupWsHandler, WsHandler } from './ws-handler'
import { requireAuth, validateStartupSecurity } from './auth'
import { logger } from './logger'

const HOST = process.env.HOST || '127.0.0.1'
const PORT = parseInt(process.env.PORT || '3001', 10)
const DEV_PORT = 5173  // Vite dev server port

// FAIL CLOSED: Validate security before starting
validateStartupSecurity(HOST)

const app = express()
const server = createServer(app)

// noServer: true - we handle upgrades manually for Origin validation
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })  // 1MB max
const registry = new TerminalRegistry()

// Exported for external use (after main() runs)
let wsHandler: WsHandler

// Limit JSON body size (DoS protection)
app.use(express.json({ limit: '1mb' }))

// Security headers - CRITICAL for remote access
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; font-src 'self' data:")
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  next()
})

// Rate limiting for auth failures
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,  // 10 failed attempts per window
  skipSuccessfulRequests: true,
  message: { error: 'Too many failed attempts, try again later' },
})

// Health check (no auth)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' })
})

// Apply rate limiting before auth
app.use('/api', authLimiter)

// All other API routes require auth
app.use('/api', requireAuth)

app.get('/api/terminals', (_req, res) => {
  const terminals = registry.list().map(s => ({
    terminalId: s.terminalId,
    shell: s.shell,
    cwd: s.cwd,
    initialCwd: s.initialCwd,
    status: s.status,
    createdAt: s.createdAt.toISOString(),
    attachedCount: s.attachedClients.size,
  }))
  res.json({ terminals })
})

// Debug endpoint (auth-protected) for troubleshooting
app.get('/api/debug', (_req, res) => {
  const sessions = registry.list().map(s => ({
    terminalId: s.terminalId,
    shell: s.shell,
    status: s.status,
    attachedClients: Array.from(s.attachedClients),
    createdAt: s.createdAt.toISOString(),
    lastActivityAt: s.lastActivityAt.toISOString(),
    outputBufferSize: s.outputBufferSize,
  }))
  res.json({
    version: '1.0.0',
    uptime: process.uptime(),
    sessions,
    capabilities: registry.getCapabilities(),
  })
})

// Serve static frontend in production
// IMPORTANT: Resolve from process.cwd(), not __dirname
// __dirname from dist/server/index.js would incorrectly resolve to dist/server/../dist = dist/dist
if (process.env.NODE_ENV === 'production') {
  const FRONTEND_DIR = path.resolve(process.cwd(), 'dist')
  logger.info({ event: 'serving_static', path: FRONTEND_DIR })
  app.use(express.static(FRONTEND_DIR))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'))
  })
}

// Wrap startup in async main() - CommonJS doesn't support top-level await
async function main() {
  // Detect capabilities BEFORE accepting connections (fixes race condition)
  await registry.detectCapabilities()

  // Origin validation for WebSocket upgrades
  // IMPORTANT: Compare Origin's host to Host header dynamically
  // A hardcoded allowlist doesn't work when HOST=0.0.0.0 (remote access from phone/tablet)
  function isOriginAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
    // No origin header = non-browser client (e.g., curl, scripts) - allow if token valid
    if (!origin) return true

    try {
      const originUrl = new URL(origin)
      // Normalize host header (may include port)
      const expectedHost = hostHeader || `localhost:${PORT}`

      // Allow same-host connections (handles any IP the server binds to)
      if (originUrl.host === expectedHost) return true

      // In dev mode, also allow Vite dev server (different port, same host)
      if (process.env.NODE_ENV !== 'production') {
        const devOrigins = [
          `localhost:${DEV_PORT}`,
          `127.0.0.1:${DEV_PORT}`,
        ]
        // Allow dev server from localhost
        if (devOrigins.includes(originUrl.host)) return true
      }

      return false
    } catch {
      return false  // Malformed origin
    }
  }

  // Manual upgrade handling (noServer: true requires this)
  server.on('upgrade', (request, socket, head) => {
    // IMPORTANT: Only handle /ws path - reject other paths
    const url = new URL(request.url || '', `http://${request.headers.host}`)
    if (url.pathname !== '/ws') {
      logger.warn({ event: 'ws_upgrade_wrong_path', path: url.pathname })
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    const origin = request.headers.origin
    const host = request.headers.host

    // Validate origin against host header
    if (!isOriginAllowed(origin, host)) {
      logger.warn({ event: 'ws_origin_rejected', origin, host })
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  })

  // setupWsHandler returns broadcast function for external use
  wsHandler = setupWsHandler(wss, registry)

  // CRITICAL: Start watchers AFTER wsHandler is assigned to fix race condition
  // If claudeWatcher is used (defined in Task 3.2), start it here:
  // claudeWatcher.on('sessions', (projects) => {
  //   wsHandler.broadcast('sessions.updated', { projects })
  // })
  // claudeWatcher.start().catch((err) => {
  //   logger.error({ event: 'watcher_start_failed', error: err.message })
  // })

  server.listen(PORT, HOST, () => {
    logger.info({ event: 'server_started', host: HOST, port: PORT })
    console.log(`Server running at http://${HOST}:${PORT}`)
    console.log(`WebSocket at ws://${HOST}:${PORT}/ws`)
    const caps = registry.getCapabilities()
    console.log(`Capabilities: WSL=${caps.wsl}${caps.defaultDistro ? ` (${caps.defaultDistro})` : ''}`)
    if (process.env.AUTH_TOKEN) {
      console.log('Authentication enabled')
    } else {
      console.log('Warning: No AUTH_TOKEN set - authentication disabled')
    }
  })
}

main().catch((err) => {
  logger.error({ event: 'startup_failed', error: err.message })
  console.error('Failed to start server:', err)
  process.exit(1)
})

export { app, server, wss, registry, wsHandler }
```

**Step 6: Write auth tests (`server/__tests__/auth.test.ts`)**
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { requireAuth, validateWsToken } from '../auth'
import { Request, Response } from 'express'

describe('Auth', () => {
  const originalEnv = process.env.AUTH_TOKEN

  afterEach(() => {
    process.env.AUTH_TOKEN = originalEnv
  })

  describe('requireAuth middleware', () => {
    it('allows requests when no AUTH_TOKEN configured', () => {
      delete process.env.AUTH_TOKEN
      const req = { headers: {} } as Request
      const res = {} as Response
      const next = vi.fn()

      requireAuth(req, res, next)

      expect(next).toHaveBeenCalled()
    })

    it('rejects requests without auth header when AUTH_TOKEN configured', () => {
      process.env.AUTH_TOKEN = 'secret'
      const req = { headers: {} } as Request
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response
      const next = vi.fn()

      requireAuth(req, res, next)

      expect(res.status).toHaveBeenCalledWith(401)
      expect(next).not.toHaveBeenCalled()
    })

    it('allows requests with valid token', () => {
      process.env.AUTH_TOKEN = 'secret'
      const req = { headers: { authorization: 'Bearer secret' } } as Request
      const res = {} as Response
      const next = vi.fn()

      requireAuth(req, res, next)

      expect(next).toHaveBeenCalled()
    })
  })

  describe('validateWsToken', () => {
    // validateWsToken(token: string | undefined): boolean
    // Token comes from hello message body, NOT URL query param

    it('returns true when no AUTH_TOKEN configured (dev mode)', () => {
      delete process.env.AUTH_TOKEN

      expect(validateWsToken(undefined)).toBe(true)
      expect(validateWsToken('any-token')).toBe(true)
    })

    it('returns false when AUTH_TOKEN set but token is undefined', () => {
      process.env.AUTH_TOKEN = 'secret-token-32-chars-or-more!!'

      expect(validateWsToken(undefined)).toBe(false)
    })

    it('validates matching token', () => {
      process.env.AUTH_TOKEN = 'secret-token-32-chars-or-more!!'

      expect(validateWsToken('secret-token-32-chars-or-more!!')).toBe(true)
    })

    it('rejects non-matching token', () => {
      process.env.AUTH_TOKEN = 'secret-token-32-chars-or-more!!'

      expect(validateWsToken('wrong-token')).toBe(false)
    })
  })
})
```

**Step 7: Write terminal registry tests (`server/__tests__/terminal-registry.test.ts`)**

> **IMPORTANT:** Use constructor dependency injection for the PTY factory.
> `vi.doMock` won't work because the module is already imported at test file load time.

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TerminalRegistry, PtyFactory } from '../terminal-registry'
import { createPtyMock, shouldMockPty } from '@test/helpers/pty-mock'

describe('TerminalRegistry', () => {
  let registry: TerminalRegistry
  let ptyMock: ReturnType<typeof createPtyMock>

  beforeEach(() => {
    // Use dependency injection - pass mock factory to constructor
    ptyMock = createPtyMock()
    registry = new TerminalRegistry(ptyMock as unknown as PtyFactory)
  })

  afterEach(() => {
    registry.destroy()  // Clean up sessions and intervals
  })

  it('creates a terminal session', async () => {
    const session = await registry.create({
      shell: 'cmd',
      cwd: 'C:\\test',
      cols: 80,
      rows: 24,
    })

    expect(session.terminalId).toBeDefined()
    expect(session.shell).toBe('cmd')
    expect(session.status).toBe('running')
    expect(session.initialCwd).toBe('C:\\test')  // New field
    expect(registry.get(session.terminalId)).toBe(session)
    expect(ptyMock.spawn).toHaveBeenCalledOnce()
  })

  it('attaches and detaches clients', async () => {
    const session = await registry.create({
      shell: 'cmd',
      cwd: 'C:\\test',
      cols: 80,
      rows: 24,
    })

    expect(registry.attach(session.terminalId, 'client1')).toBe(true)
    expect(session.attachedClients.has('client1')).toBe(true)

    registry.detach(session.terminalId, 'client1')
    expect(session.attachedClients.has('client1')).toBe(false)
  })

  it('returns false when attaching to non-existent terminal', () => {
    expect(registry.attach('non-existent', 'client1')).toBe(false)
  })

  it('lists all sessions', async () => {
    await registry.create({ shell: 'cmd', cwd: 'C:\\test', cols: 80, rows: 24 })
    await registry.create({ shell: 'powershell', cwd: 'C:\\test', cols: 80, rows: 24 })

    expect(registry.list()).toHaveLength(2)
  })

  it('buffers output for scrollback replay', async () => {
    const session = await registry.create({
      shell: 'cmd',
      cwd: 'C:\\test',
      cols: 80,
      rows: 24,
    })

    // Simulate PTY output
    ptyMock.getLastInstance()?.simulateOutput('Hello world\r\n')

    expect(session.outputBuffer.length).toBeGreaterThan(0)
    expect(registry.getBufferedOutput(session.terminalId)).toContain('Hello world')
  })

  it('deduplicates StrictMode double-creates via clientRef', async () => {
    const session1 = await registry.create({
      shell: 'cmd',
      cwd: 'C:\\test',
      cols: 80,
      rows: 24,
      clientRef: 'tab-123',
    })

    // Second create with same clientRef within 2 seconds should return same session
    const session2 = await registry.create({
      shell: 'cmd',
      cwd: 'C:\\test',
      cols: 80,
      rows: 24,
      clientRef: 'tab-123',
    })

    expect(session1.terminalId).toBe(session2.terminalId)
    expect(ptyMock.spawn).toHaveBeenCalledTimes(1)  // Only one PTY created
  })

  it('sets endedReason correctly on kill vs exit', async () => {
    const session = await registry.create({
      shell: 'cmd',
      cwd: 'C:\\test',
      cols: 80,
      rows: 24,
    })

    registry.kill(session.terminalId)

    expect(session.status).toBe('killed')
    expect(session.endedReason).toBe('killed')  // Set by kill(), not overwritten by onExit
  })

  it('emits output events', async () => {
    const outputHandler = vi.fn()
    registry.on('output', outputHandler)

    const session = await registry.create({
      shell: 'cmd',
      cwd: 'C:\\test',
      cols: 80,
      rows: 24,
    })

    // Simulate PTY output
    ptyMock.getLastInstance()?.simulateOutput('test output')

    expect(outputHandler).toHaveBeenCalledWith(session.terminalId, 'test output')
  })
})

// Separate suite for integration tests with real PTY (local dev only)
describe.skipIf(shouldMockPty)('TerminalRegistry (real PTY)', () => {
  let registry: TerminalRegistry

  beforeEach(() => {
    // Use real node-pty for integration tests
    registry = new TerminalRegistry()
  })

  afterEach(() => {
    registry.destroy()
  })

  it('creates a real terminal and receives output', async () => {
    const outputHandler = vi.fn()
    registry.on('output', outputHandler)

    const session = await registry.create({
      shell: 'cmd',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })

    registry.write(session.terminalId, 'echo hello\r')

    await new Promise(resolve => setTimeout(resolve, 1000))

    expect(outputHandler).toHaveBeenCalled()
  })
})
```

**Step 8: Add server scripts to `package.json`**
```json
{
  "scripts": {
    "dev:server": "tsx watch server/index.ts",
    "build:server": "tsc -p tsconfig.server.json",
    "start": "node dist/server/index.js"
  }
}
```

**Step 9: Create `tsconfig.server.json`**

> **Note:** Using CommonJS module format ensures `__dirname` works correctly in compiled code.
> ESM would require defining `__dirname` manually via `fileURLToPath(import.meta.url)`.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "outDir": "./dist/server",
    "rootDir": "./server",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["server/**/*"]
}
```

**Step 10: Run tests**
```bash
npm run test:server -- --run
```
Expected: All auth and registry tests pass

**Step 11: Commit**
```bash
git add -A && git commit -m "feat: add server with auth and terminal registry"
```

---

### Task 1.5: Integration Tests for WS Protocol

**Files:**
- Create: `test/integration/ws-protocol.test.ts`

**Step 1: Write comprehensive WS protocol tests**

Create `test/integration/ws-protocol.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createTestServer, TestServer } from '@test/helpers/server'
import { createWsTestClient, WsTestClient } from '@test/helpers/ws'
import { TerminalRegistry } from '../../server/terminal-registry'
import { setupWsHandler } from '../../server/ws-handler'

describe('WebSocket Protocol', () => {
  let testServer: TestServer
  let registry: TerminalRegistry
  let client: WsTestClient

  beforeAll(async () => {
    registry = new TerminalRegistry()
    testServer = await createTestServer((app, wss) => {
      setupWsHandler(wss, registry)
    })
  })

  afterAll(async () => {
    await testServer.close()
  })

  beforeEach(async () => {
    client = await createWsTestClient(testServer.wsUrl)
  })

  afterEach(() => {
    client.close()
  })

  describe('hello/ready handshake', () => {
    it('responds with ready after hello (no auth configured)', async () => {
      // Token can be undefined in dev mode (no AUTH_TOKEN env var)
      client.sendHello()

      const msg = await client.waitForReady()
      expect(msg).toMatchObject({
        type: 'ready',
        serverVersion: expect.any(String),
        // capabilities.wsl is boolean (may be false on non-Windows or if WSL not installed)
        capabilities: { wsl: expect.any(Boolean) },
      })
    })

    it('rejects messages before hello', async () => {
      // Send a command without hello first
      client.send({ type: 'terminal.list' })

      const msg = await client.waitForMessage((m: any) => m.type === 'error')
      expect(msg).toMatchObject({
        type: 'error',
        code: 'NOT_AUTHENTICATED',
      })
    })
  })

  describe('terminal.create', () => {
    it('creates a terminal and returns terminalId', async () => {
      client.sendHello()
      await client.waitForReady()

      // NOTE: This test suite is Windows-only (shell enum: cmd, powershell, wsl)
      // Cross-platform support would require 'system' shell type
      client.send({
        type: 'terminal.create',
        shell: 'cmd',  // Windows-only test - see "Supported OS" section
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      })

      const msg = await client.waitForMessage((m: any) => m.type === 'terminal.created')
      expect(msg).toMatchObject({
        type: 'terminal.created',
        terminalId: expect.any(String),
        pid: expect.any(Number),
        shell: expect.any(String),
      })
    })

    it('rejects invalid shell (schema validation error)', async () => {
      client.sendHello()
      await client.waitForReady()

      client.send({
        type: 'terminal.create',
        shell: 'invalid',  // Not in enum
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      })

      const msg = await client.waitForMessage((m: any) => m.type === 'error')
      expect(msg).toMatchObject({
        type: 'error',
        code: 'INVALID_MESSAGE',  // Schema validation errors use INVALID_MESSAGE
        message: expect.stringContaining('shell'),  // Message explains the validation failure
      })
    })
  })

  describe('terminal.attach', () => {
    it('attaches to existing terminal', async () => {
      client.sendHello()
      await client.waitForReady()

      client.send({
        type: 'terminal.create',
        shell: 'cmd',
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      })

      const created = await client.waitForMessage((m: any) => m.type === 'terminal.created') as any

      // Second client attaches
      const client2 = await createWsTestClient(testServer.wsUrl)
      client2.sendHello()
      await client2.waitForReady()

      client2.send({
        type: 'terminal.attach',
        terminalId: created.terminalId,
        cols: 80,
        rows: 24,
      })

      const attached = await client2.waitForMessage((m: any) => m.type === 'terminal.attached')
      expect(attached).toMatchObject({
        type: 'terminal.attached',
        terminalId: created.terminalId,
      })

      client2.close()
    })

    it('fails to attach to non-existent terminal', async () => {
      client.sendHello()
      await client.waitForReady()

      // Use a valid UUID format so it passes schema validation
      // but doesn't exist in the registry (domain error, not schema error)
      client.send({
        type: 'terminal.attach',
        terminalId: '00000000-0000-0000-0000-000000000000',
        cols: 80,
        rows: 24,
      })

      const msg = await client.waitForMessage((m: any) => m.type === 'error')
      expect(msg).toMatchObject({
        type: 'error',
        code: 'TERMINAL_NOT_FOUND',  // Canonical error for all terminal lookup failures
        terminalId: '00000000-0000-0000-0000-000000000000',
      })
    })
  })

  describe('terminal.input/output', () => {
    it('receives output after input', async () => {
      client.sendHello()
      await client.waitForReady()

      client.send({
        type: 'terminal.create',
        shell: 'cmd',
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      })

      const created = await client.waitForMessage((m: any) => m.type === 'terminal.created') as any

      client.send({
        type: 'terminal.input',
        terminalId: created.terminalId,
        data: 'echo hello\r',
      })

      // Should receive output containing "hello"
      const output = await client.waitForMessage(
        (m: any) => m.type === 'terminal.output' && m.data.includes('hello'),
        10000
      )
      expect(output).toBeDefined()
    })
  })

  describe('reattach after disconnect', () => {
    it('terminal survives client disconnect and can be reattached', async () => {
      // Create terminal with first client
      client.sendHello()
      await client.waitForReady()

      client.send({
        type: 'terminal.create',
        shell: 'cmd',
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      })

      const created = await client.waitForMessage((m: any) => m.type === 'terminal.created') as any
      const terminalId = created.terminalId

      // Disconnect first client
      client.close()

      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 100))

      // Terminal should still exist
      const session = registry.get(terminalId)
      expect(session).toBeDefined()
      expect(session?.status).toBe('running')

      // Connect new client and reattach
      const client2 = await createWsTestClient(testServer.wsUrl)
      client2.sendHello()
      await client2.waitForReady()

      client2.send({
        type: 'terminal.attach',
        terminalId,
        cols: 80,
        rows: 24,
      })

      const attached = await client2.waitForMessage((m: any) => m.type === 'terminal.attached')
      expect(attached).toMatchObject({
        type: 'terminal.attached',
        terminalId,
      })

      // Should receive output on new client
      client2.send({
        type: 'terminal.input',
        terminalId,
        data: 'echo reattached\r',
      })

      const output = await client2.waitForMessage(
        (m: any) => m.type === 'terminal.output' && m.data.includes('reattached'),
        10000
      )
      expect(output).toBeDefined()

      client2.close()
    })
  })

  describe('terminal.kill', () => {
    it('kills terminal and receives exit event', async () => {
      client.sendHello()
      await client.waitForReady()

      client.send({
        type: 'terminal.create',
        shell: 'cmd',
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
      })

      const created = await client.waitForMessage((m: any) => m.type === 'terminal.created') as any

      client.send({
        type: 'terminal.kill',
        terminalId: created.terminalId,
      })

      const exit = await client.waitForMessage((m: any) => m.type === 'terminal.exit')
      expect(exit).toMatchObject({
        type: 'terminal.exit',
        terminalId: created.terminalId,
      })
    })
  })
})
```

**Step 2: Run integration tests**
```bash
npm run test:server -- --run test/integration/ws-protocol.test.ts
```
Expected: All tests pass

**Step 3: Commit**
```bash
git add -A && git commit -m "test: add WS protocol integration tests"
```

---

### Task 1.6: Minimal Test UI (Single Terminal)

**Files:**
- Create: `src/lib/ws-client.ts`
- Modify: `src/App.tsx`
- Create: `src/components/TestTerminal.tsx`

**Step 1: Install xterm.js**
```bash
npm install xterm @xterm/addon-fit
```

**Step 2: Create WebSocket client (`src/lib/ws-client.ts`)**

> **IMPORTANT:** Single-path token flow:
> 1. `initializeAuthToken()` is called once on app bootstrap (main.tsx)
> 2. Token is stored only in sessionStorage
> 3. WsClient takes only `url`, always sends `{type:'hello', token}` from sessionStorage
> 4. All `?token=` usage is removed except for the one-time import + history.replaceState

```typescript
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'ready'
type MessageHandler = (msg: unknown) => void
type ReconnectHandler = () => void

const CONNECTION_TIMEOUT_MS = 10000  // 10 seconds to establish connection

// SINGLE source of auth token - sessionStorage only
// NEVER reconstruct from URL after initialization
function getAuthToken(): string | undefined {
  return sessionStorage.getItem('auth-token') || undefined
}

// Called ONCE on app bootstrap (main.tsx) - extracts token from URL, stores in sessionStorage
export function initializeAuthToken(): void {
  const urlParams = new URLSearchParams(window.location.search)
  const urlToken = urlParams.get('token')
  if (urlToken) {
    sessionStorage.setItem('auth-token', urlToken)
    // Remove token from URL to prevent leakage via history/logs/Referer
    urlParams.delete('token')
    const newUrl = urlParams.toString()
      ? `${window.location.pathname}?${urlParams}`
      : window.location.pathname
    window.history.replaceState({}, '', newUrl)
  }
}

export class WsClient {
  private ws: WebSocket | null = null
  private _state: ConnectionState = 'disconnected'
  private messageHandlers: Set<MessageHandler> = new Set()
  private reconnectHandlers: Set<ReconnectHandler> = new Set()
  private pendingMessages: unknown[] = []  // Queue ALL messages until ready
  private intentionalClose = false
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private baseReconnectDelay = 1000
  private wasConnected = false
  private maxQueueSize = 1000  // Prevent unbounded memory if server is gone

  // Takes ONLY url - token is always read from sessionStorage
  constructor(private url: string) {}

  get state(): ConnectionState {
    return this._state
  }

  get isReady(): boolean {
    return this._state === 'ready'
  }

  connect(): Promise<void> {
    if (this._state === 'connected' || this._state === 'connecting' || this._state === 'ready') {
      return Promise.resolve()
    }

    this.intentionalClose = false
    this._state = 'connecting'

    return new Promise((resolve, reject) => {
      let resolved = false
      let connectionTimeout: number | null = null

      const cleanup = () => {
        if (connectionTimeout) {
          clearTimeout(connectionTimeout)
          connectionTimeout = null
        }
      }

      const rejectOnce = (error: Error) => {
        if (!resolved) {
          resolved = true
          cleanup()
          reject(error)
        }
      }

      const resolveOnce = () => {
        if (!resolved) {
          resolved = true
          cleanup()
          resolve()
        }
      }

      // Connection timeout - reject if ready not received in time
      connectionTimeout = window.setTimeout(() => {
        rejectOnce(new Error('Connection timeout: ready not received'))
        this.ws?.close()
      }, CONNECTION_TIMEOUT_MS)

      // IMPORTANT: No token in URL - send in hello message instead
      this.ws = new WebSocket(this.url)

      this.ws.onopen = () => {
        this._state = 'connected'
        this.reconnectAttempts = 0

        // Send hello with token in message body (not URL)
        const token = getAuthToken()
        this.ws?.send(JSON.stringify({ type: 'hello', token }))
        // Don't resolve yet - wait for 'ready'
      }

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)

        // Handle ready message - connection is now fully established
        if (msg.type === 'ready') {
          const isReconnect = this.wasConnected
          this.wasConnected = true
          this._state = 'ready'

          // Flush pending messages
          while (this.pendingMessages.length > 0) {
            const pending = this.pendingMessages.shift()
            this.ws?.send(JSON.stringify(pending))
          }

          // Notify reconnect handlers
          if (isReconnect) {
            this.reconnectHandlers.forEach(handler => handler())
          }

          resolveOnce()
        }

        // Handle auth error
        if (msg.type === 'error' && msg.code === 'NOT_AUTHENTICATED') {
          rejectOnce(new Error('Authentication failed'))
          return
        }

        this.messageHandlers.forEach(handler => handler(msg))
      }

      this.ws.onclose = (event) => {
        const wasConnecting = this._state === 'connecting'
        this._state = 'disconnected'
        this.ws = null

        // Handle auth-related close codes - don't reconnect, surface error clearly
        const AUTH_CLOSE_CODES = [4001, 4002]  // NOT_AUTHENTICATED, HELLO_TIMEOUT
        if (AUTH_CLOSE_CODES.includes(event.code)) {
          this.intentionalClose = true  // Stop reconnect attempts
          rejectOnce(new Error(`Authentication failed (code ${event.code})`))
          return
        }

        // Reject promise if closed while connecting (before ready)
        if (wasConnecting) {
          rejectOnce(new Error('Connection closed before ready'))
        }

        if (!this.intentionalClose) {
          this.scheduleReconnect()
        }
      }

      this.ws.onerror = (error) => {
        if (this._state === 'connecting') {
          rejectOnce(error as unknown as Error)
        }
      }
    })
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached')
      return
    }

    const delay = this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts)
    this.reconnectAttempts++

    setTimeout(() => {
      if (!this.intentionalClose) {
        this.connect().catch(console.error)
      }
    }, delay)
  }

  disconnect() {
    this.intentionalClose = true
    this.ws?.close()
    this.ws = null
    this._state = 'disconnected'
    this.pendingMessages = []
  }

  // RELIABLE send: always queue unless intentionally closed
  // Messages are flushed when transitioning to ready
  send(msg: unknown) {
    if (this.intentionalClose) {
      // Intentionally disconnected - drop message
      return
    }

    if (this._state === 'ready' && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    } else {
      // Queue until ready (handles connecting, connected, and temporary disconnects)
      if (this.pendingMessages.length < this.maxQueueSize) {
        this.pendingMessages.push(msg)
      } else {
        console.warn('WsClient: message queue full, dropping oldest message')
        this.pendingMessages.shift()
        this.pendingMessages.push(msg)
      }
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => this.messageHandlers.delete(handler)
  }

  onReconnect(handler: ReconnectHandler): () => void {
    this.reconnectHandlers.add(handler)
    return () => this.reconnectHandlers.delete(handler)
  }
}

// Singleton instance
let wsClient: WsClient | null = null

// NOTE: getAuthToken() is defined once at the top of this file
// Do NOT duplicate - token is always read from sessionStorage

export function getWsClient(): WsClient {
  if (!wsClient) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    // WsClient takes ONLY url - token is read from sessionStorage in hello message
    wsClient = new WsClient(`${protocol}//${host}/ws`)
  }
  return wsClient
}
```

**Step 3: Create test terminal component (`src/components/TestTerminal.tsx`)**

> **CRITICAL:** The effect must NOT depend on terminalId! When terminal.created fires,
> terminalId changes, which would re-run the effect and reinitialize everything.
> Use a ref to track terminalId within the effect instead.

```typescript
import { useEffect, useRef, useState } from 'react'
import { Terminal } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { getWsClient } from '../lib/ws-client'
import 'xterm/css/xterm.css'

export function TestTerminal() {
  const terminalRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | null>(null)  // Use ref, not state, inside effect
  const [terminalId, setTerminalId] = useState<string | null>(null)  // For display only
  const [status, setStatus] = useState<string>('connecting...')

  useEffect(() => {
    if (!terminalRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Consolas, monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(terminalRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon

    const wsClient = getWsClient()

    const unsubscribe = wsClient.onMessage((msg: any) => {
      switch (msg.type) {
        case 'ready':
          setStatus('ready, creating terminal...')
          wsClient.send({
            type: 'terminal.create',
            shell: 'cmd',
            cwd: import.meta.env.VITE_DEFAULT_CWD || 'C:\\Users',
            cols: term.cols,
            rows: term.rows,
          })
          break

        case 'terminal.created':
          terminalIdRef.current = msg.terminalId  // Update ref
          setTerminalId(msg.terminalId)  // Update state for display
          setStatus(`connected (${msg.shell})`)
          break

        case 'terminal.output':
          // Use ref, not state closure (which would be stale)
          if (msg.terminalId === terminalIdRef.current) {
            term.write(msg.data)
          }
          break

        case 'terminal.exit':
          setStatus(`exited (code: ${msg.exitCode})`)
          break

        case 'error':
          setStatus(`error: ${msg.message}`)
          break
      }
    })

    // Forward terminal input to server
    term.onData((data) => {
      if (terminalIdRef.current) {
        wsClient.send({
          type: 'terminal.input',
          terminalId: terminalIdRef.current,
          data,
        })
      }
    })

    // Handle resize
    const handleResize = () => {
      fitAddon.fit()
      if (terminalIdRef.current) {
        wsClient.send({
          type: 'terminal.resize',
          terminalId: terminalIdRef.current,
          cols: term.cols,
          rows: term.rows,
        })
      }
    }

    window.addEventListener('resize', handleResize)

    wsClient.connect().catch((err) => {
      setStatus(`connection failed: ${err.message}`)
    })

    return () => {
      unsubscribe()
      window.removeEventListener('resize', handleResize)
      term.dispose()
    }
  }, [])  // Empty deps - run once only

  return (
    <div className="h-full flex flex-col">
      <div className="bg-gray-800 px-4 py-2 text-sm text-gray-400">
        Status: {status} {terminalId && `| ID: ${terminalId.slice(0, 8)}...`}
      </div>
      <div ref={terminalRef} className="flex-1" />
    </div>
  )
}
```

**Step 4: Update App.tsx**
```typescript
import { TestTerminal } from './components/TestTerminal'

function App() {
  return (
    <div className="h-screen bg-gray-900 text-white">
      <TestTerminal />
    </div>
  )
}

export default App
```

**Step 5: Configure Vite proxy for dev**

Update `vite.config.ts`:
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
})
```

**Step 6: Test manually**

Terminal 1:
```bash
npm run dev:server
```

Terminal 2:
```bash
npm run dev
```

Open http://localhost:5173 - should see terminal with cmd prompt

**Step 7: Test reconnection (WS drop, NOT server restart)**

> **IMPORTANT:** PTYs die when the Node process dies. This test verifies WS reconnect, not server restart.
> For server restart survival, a future architecture would need a persistent PTY daemon.

1. Open terminal in browser, run a command (e.g., `echo hello`)
2. Toggle airplane mode (or disconnect network adapter)
3. Wait ~5 seconds, reconnect network
4. Terminal should reconnect automatically and show "reconnected" in logs
5. Run another command - output should appear (PTY still alive)
6. **Alternative test:** Use browser DevTools > Network > Offline checkbox

**Step 8: Commit**
```bash
git add -A && git commit -m "feat: add minimal test UI with single terminal"
```

---

### Release 1 Acceptance Tests

**Integration (automated):**
- [x] Create terminal (cmd) → receive output
- [x] Create terminal (wsl) → receive output
- [x] Disconnect WS → terminal continues → reconnect → attach → output resumes
- [x] Resize applied correctly

**Manual remote test:**
1. Set `HOST=0.0.0.0` and `AUTH_TOKEN=your-secret` in `.env`
2. Start server: `npm run dev:server`
3. From phone via VPN: open `http://<your-ip>:3001?token=your-secret`
4. Spawn terminal, run commands
5. Toggle airplane mode briefly
6. Verify terminal still alive after reconnect

**Exit Criteria:**
- [ ] Attach works reliably after reconnect
- [ ] PTY output routes to correct client
- [ ] WSL works (document any cwd caveats)

---

## Release 2 — Multi-Tab UI + Ctrl-B Shortcuts + Production Build

**Purpose:** Prove multi-terminal management with stable WS layer. Production single-origin deployment.

**Exit Criteria:** Multiple tabs work, shortcuts work, production build serves UI + API.

---

### Task 2.1: Add Redux Toolkit for State Management

**Files:**
- Create: `src/store/index.ts`
- Create: `src/store/tabsSlice.ts`
- Create: `src/store/connectionSlice.ts`
- Modify: `src/main.tsx`

**Step 1: Install Redux**
```bash
npm install @reduxjs/toolkit react-redux
```

**Step 2: Create tabs slice (`src/store/tabsSlice.ts`)**
```typescript
import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export interface Tab {
  id: string           // Client-side tab ID
  terminalId: string | null  // Server-issued terminal ID (null until created)
  title: string
  shell: 'cmd' | 'powershell' | 'wsl'
  cwd: string          // Current working directory (may change via cd)
  initialCwd: string   // Directory when tab was created (never changes, for project grouping)
  status: 'creating' | 'running' | 'exited'
}

interface TabsState {
  tabs: Tab[]
  activeTabId: string | null
}

const initialState: TabsState = {
  tabs: [],
  activeTabId: null,
}

export const tabsSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers: {
    addTab: (state, action: PayloadAction<Omit<Tab, 'status' | 'initialCwd'> & { status?: Tab['status'] }>) => {
      const tab: Tab = {
        ...action.payload,
        initialCwd: action.payload.cwd,  // Set once on creation, never changes
        status: action.payload.status || 'creating',
      }
      state.tabs.push(tab)
      state.activeTabId = tab.id
    },

    removeTab: (state, action: PayloadAction<string>) => {
      const index = state.tabs.findIndex(t => t.id === action.payload)
      if (index !== -1) {
        state.tabs.splice(index, 1)
        if (state.activeTabId === action.payload) {
          state.activeTabId = state.tabs[index]?.id ?? state.tabs[index - 1]?.id ?? null
        }
      }
    },

    setActiveTab: (state, action: PayloadAction<string>) => {
      state.activeTabId = action.payload
    },

    updateTab: (state, action: PayloadAction<{ id: string; updates: Partial<Tab> }>) => {
      const tab = state.tabs.find(t => t.id === action.payload.id)
      if (tab) {
        Object.assign(tab, action.payload.updates)
      }
    },

    setTerminalId: (state, action: PayloadAction<{ tabId: string; terminalId: string }>) => {
      const tab = state.tabs.find(t => t.id === action.payload.tabId)
      if (tab) {
        tab.terminalId = action.payload.terminalId
        tab.status = 'running'
      }
    },
  },
})

export const { addTab, removeTab, setActiveTab, updateTab, setTerminalId } = tabsSlice.actions
export default tabsSlice.reducer
```

**Step 3: Create connection slice (`src/store/connectionSlice.ts`)**
```typescript
import { createSlice, PayloadAction } from '@reduxjs/toolkit'

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected'

interface ConnectionState {
  status: ConnectionStatus
  serverVersion: string | null
  capabilities: {
    wsl: boolean
  }
}

const initialState: ConnectionState = {
  status: 'disconnected',
  serverVersion: null,
  capabilities: { wsl: false },
}

export const connectionSlice = createSlice({
  name: 'connection',
  initialState,
  reducers: {
    setConnectionStatus: (state, action: PayloadAction<ConnectionStatus>) => {
      state.status = action.payload
    },

    setServerInfo: (state, action: PayloadAction<{ version: string; capabilities: { wsl: boolean } }>) => {
      state.serverVersion = action.payload.version
      state.capabilities = action.payload.capabilities
    },
  },
})

export const { setConnectionStatus, setServerInfo } = connectionSlice.actions
export default connectionSlice.reducer
```

**Step 4: Create store (`src/store/index.ts`)**
```typescript
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from './tabsSlice'
import connectionReducer from './connectionSlice'

export const store = configureStore({
  reducer: {
    tabs: tabsReducer,
    connection: connectionReducer,
  },
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
```

**Step 5: Create hooks (`src/store/hooks.ts`)**
```typescript
import { useDispatch, useSelector, TypedUseSelectorHook } from 'react-redux'
import type { RootState, AppDispatch } from './index'

export const useAppDispatch: () => AppDispatch = useDispatch
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector
```

**Step 6: Update main.tsx**

> **IMPORTANT:** Call `initializeAuthToken()` ONCE on app bootstrap before any WS connections.

```typescript
import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider } from 'react-redux'
import { store } from './store'
import App from './App'
import { initializeAuthToken } from './lib/ws-client'
import './index.css'

// Extract token from URL, store in sessionStorage, remove from URL
// Must happen before any WS connections are made
initializeAuthToken()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </React.StrictMode>
)
```

**Step 7: Write tabs slice tests (`src/store/__tests__/tabsSlice.test.ts`)**
```typescript
import { describe, it, expect } from 'vitest'
import reducer, { addTab, removeTab, setActiveTab, updateTab, setTerminalId, Tab } from '../tabsSlice'

describe('tabsSlice', () => {
  const initialState = { tabs: [], activeTabId: null }

  it('adds a tab and sets it active', () => {
    // Tab interface requires both cwd and initialCwd
    const tab: Omit<Tab, 'status'> = {
      id: 'tab1',
      terminalId: null,
      title: 'Terminal 1',
      shell: 'cmd',
      cwd: 'C:\\',
      initialCwd: 'C:\\',  // Required field - immutable initial directory
    }

    const state = reducer(initialState, addTab(tab))

    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0].id).toBe('tab1')
    expect(state.tabs[0].status).toBe('creating')
    expect(state.tabs[0].initialCwd).toBe('C:\\')  // Verify initialCwd persisted
    expect(state.activeTabId).toBe('tab1')
  })

  it('removes a tab and updates active', () => {
    const state = {
      tabs: [
        { id: 'tab1', terminalId: 't1', title: 'T1', shell: 'cmd' as const, cwd: 'C:\\', initialCwd: 'C:\\', status: 'running' as const },
        { id: 'tab2', terminalId: 't2', title: 'T2', shell: 'cmd' as const, cwd: 'C:\\', initialCwd: 'C:\\', status: 'running' as const },
      ],
      activeTabId: 'tab1',
    }

    const newState = reducer(state, removeTab('tab1'))

    expect(newState.tabs).toHaveLength(1)
    expect(newState.activeTabId).toBe('tab2')
  })

  it('sets terminal ID and updates status', () => {
    const state = {
      tabs: [{ id: 'tab1', terminalId: null, title: 'T1', shell: 'cmd' as const, cwd: 'C:\\', initialCwd: 'C:\\', status: 'creating' as const }],
      activeTabId: 'tab1',
    }

    const newState = reducer(state, setTerminalId({ tabId: 'tab1', terminalId: 'server-id' }))

    expect(newState.tabs[0].terminalId).toBe('server-id')
    expect(newState.tabs[0].status).toBe('running')
  })
})
```

**Step 8: Run tests**
```bash
npm test -- --run src/store/__tests__/tabsSlice.test.ts
```

**Step 9: Commit**
```bash
git add -A && git commit -m "feat: add Redux store with tabs and connection slices"
```

---

### Task 2.2: Create TabBar Component

**Files:**
- Create: `src/components/TabBar.tsx`
- Create: `src/components/__tests__/TabBar.test.tsx`

**Step 1: Add shadcn components and lucide-react**
```bash
npx shadcn@latest add tabs tooltip
npm install lucide-react
```

**Step 2: Create TabBar component (`src/components/TabBar.tsx`)**

> **Mobile UX:** Horizontal scroll for tab overflow, 44px min touch targets,
> and on-screen navigation buttons for devices without keyboards.

```typescript
import { useAppSelector, useAppDispatch } from '../store/hooks'
import { setActiveTab, removeTab } from '../store/tabsSlice'
import { X, Plus, Terminal, ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { useRef } from 'react'

interface TabBarProps {
  onNewTab: () => void
  onCloseTab?: () => void
}

export function TabBar({ onNewTab, onCloseTab }: TabBarProps) {
  const dispatch = useAppDispatch()
  const { tabs, activeTabId } = useAppSelector(state => state.tabs)
  const connectionStatus = useAppSelector(state => state.connection.status)
  const tabsContainerRef = useRef<HTMLDivElement>(null)

  // Navigate to prev/next tab (for mobile buttons)
  const navigatePrev = () => {
    if (tabs.length < 2 || !activeTabId) return
    const currentIndex = tabs.findIndex(t => t.id === activeTabId)
    const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length
    dispatch(setActiveTab(tabs[prevIndex].id))
  }

  const navigateNext = () => {
    if (tabs.length < 2 || !activeTabId) return
    const currentIndex = tabs.findIndex(t => t.id === activeTabId)
    const nextIndex = (currentIndex + 1) % tabs.length
    dispatch(setActiveTab(tabs[nextIndex].id))
  }

  return (
    <div className="flex items-center bg-gray-800 border-b border-gray-700">
      {/* Mobile prev button - only show when multiple tabs */}
      {tabs.length > 1 && (
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden h-11 w-11 flex-shrink-0"
          onClick={navigatePrev}
        >
          <ChevronLeft className="w-5 h-5" />
        </Button>
      )}

      {/* Scrollable tabs container */}
      <div
        ref={tabsContainerRef}
        className="flex-1 flex items-center overflow-x-auto scrollbar-hide"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        <TooltipProvider>
          {tabs.map(tab => (
            <div
              key={tab.id}
              className={`
                flex items-center gap-2 px-4 py-3 cursor-pointer border-r border-gray-700
                min-h-[44px] flex-shrink-0
                ${tab.id === activeTabId ? 'bg-gray-900 text-white' : 'text-gray-400 hover:bg-gray-700'}
              `}
              onClick={() => dispatch(setActiveTab(tab.id))}
            >
              <Terminal className="w-4 h-4" />
              <span className="max-w-32 truncate">{tab.title}</span>
              {tab.status === 'creating' && (
                <span className="text-xs text-yellow-500">...</span>
              )}
              {tab.status === 'exited' && (
                <span className="text-xs text-red-500">×</span>
              )}
              {/* Close button - larger touch target on mobile */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="ml-1 p-1.5 hover:bg-gray-600 rounded min-w-[28px] min-h-[28px] flex items-center justify-center"
                    onClick={(e) => {
                      e.stopPropagation()
                      dispatch(removeTab(tab.id))
                    }}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Close tab</TooltipContent>
              </Tooltip>
            </div>
          ))}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="ml-2 h-11 w-11 flex-shrink-0"
                onClick={onNewTab}
              >
                <Plus className="w-5 h-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New terminal (Ctrl-B C)</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* Mobile next button - only show when multiple tabs */}
      {tabs.length > 1 && (
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden h-11 w-11 flex-shrink-0"
          onClick={navigateNext}
        >
          <ChevronRight className="w-5 h-5" />
        </Button>
      )}

      {/* Connection status - hidden on very small screens */}
      <div className="hidden sm:block ml-auto px-4 text-xs flex-shrink-0">
        <span className={`
          ${connectionStatus === 'connected' ? 'text-green-500' : ''}
          ${connectionStatus === 'connecting' ? 'text-yellow-500' : ''}
          ${connectionStatus === 'disconnected' ? 'text-red-500' : ''}
        `}>
          {connectionStatus}
        </span>
      </div>
    </div>
  )
}
```

**Step 3: Write TabBar tests (`src/components/__tests__/TabBar.test.tsx`)**
```typescript
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { TabBar } from '../TabBar'
import tabsReducer from '../../store/tabsSlice'
import connectionReducer from '../../store/connectionSlice'

function renderWithStore(ui: React.ReactElement, preloadedState?: any) {
  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      connection: connectionReducer,
    },
    preloadedState,
  })
  return render(<Provider store={store}>{ui}</Provider>)
}

describe('TabBar', () => {
  it('renders tabs', () => {
    renderWithStore(<TabBar onNewTab={() => {}} />, {
      tabs: {
        tabs: [
          { id: '1', terminalId: 't1', title: 'Terminal 1', shell: 'cmd', cwd: 'C:\\', status: 'running' },
        ],
        activeTabId: '1',
      },
      connection: { status: 'connected', serverVersion: null, capabilities: { wsl: false } },
    })

    expect(screen.getByText('Terminal 1')).toBeInTheDocument()
  })

  it('calls onNewTab when plus button clicked', () => {
    const onNewTab = vi.fn()
    renderWithStore(<TabBar onNewTab={onNewTab} />, {
      tabs: { tabs: [], activeTabId: null },
      connection: { status: 'connected', serverVersion: null, capabilities: { wsl: false } },
    })

    fireEvent.click(screen.getByRole('button'))
    expect(onNewTab).toHaveBeenCalled()
  })

  it('shows connection status', () => {
    renderWithStore(<TabBar onNewTab={() => {}} />, {
      tabs: { tabs: [], activeTabId: null },
      connection: { status: 'disconnected', serverVersion: null, capabilities: { wsl: false } },
    })

    expect(screen.getByText('disconnected')).toBeInTheDocument()
  })
})
```

**Step 4: Run tests**
```bash
npm test -- --run src/components/__tests__/TabBar.test.tsx
```

**Step 5: Commit**
```bash
git add -A && git commit -m "feat: add TabBar component"
```

---

### Task 2.3: Create Terminal Component with Tab Integration

**Files:**
- Create: `src/components/Terminal.tsx`
- Create: `src/components/__tests__/Terminal.test.tsx`
- Delete: `src/components/TestTerminal.tsx` (replaced by this component)

**Step 1: Create Terminal component**

Create `src/components/Terminal.tsx`:
```typescript
import { useEffect, useRef, useCallback } from 'react'
import { Terminal as XTerm } from 'xterm'
import { FitAddon } from '@xterm/addon-fit'
import { getWsClient } from '../lib/ws-client'
import { useAppDispatch } from '../store/hooks'
import { setTerminalId, updateTab } from '../store/tabsSlice'
import 'xterm/css/xterm.css'

interface TerminalProps {
  tabId: string
  terminalId: string | null
  shell: 'cmd' | 'powershell' | 'wsl'
  cwd: string
  isActive: boolean
}

export function Terminal({ tabId, terminalId, shell, cwd, isActive }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const terminalIdRef = useRef<string | null>(terminalId)
  const dispatch = useAppDispatch()

  // Keep ref in sync
  terminalIdRef.current = terminalId

  const handleResize = useCallback(() => {
    if (fitAddonRef.current && termRef.current && isActive) {
      fitAddonRef.current.fit()
      if (terminalIdRef.current) {
        getWsClient().send({
          type: 'terminal.resize',
          terminalId: terminalIdRef.current,
          cols: termRef.current.cols,
          rows: termRef.current.rows,
        })
      }
    }
  }, [isActive])

  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Consolas, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Delay fit to ensure container is sized
    requestAnimationFrame(() => fitAddon.fit())

    const wsClient = getWsClient()

    // Handle messages for this terminal
    const unsubscribe = wsClient.onMessage((msg: any) => {
      // Match terminal.created by clientRef (tabId)
      if (msg.type === 'terminal.created' && msg.clientRef === tabId) {
        dispatch(setTerminalId({ tabId, terminalId: msg.terminalId }))
        terminalIdRef.current = msg.terminalId
        return
      }

      if (msg.terminalId !== terminalIdRef.current) return

      switch (msg.type) {
        case 'terminal.output':
          term.write(msg.data)
          break
        case 'terminal.snapshot':
          // Scrollback replay on reattach - clear existing content and write snapshot
          term.clear()
          term.write(msg.data)
          break
        case 'terminal.exit':
          dispatch(updateTab({ id: tabId, updates: { status: 'exited' } }))
          break
        case 'terminal.attached':
          // Successfully reattached - snapshot will follow
          break
        // NOTE: Backpressure is handled server-side by dropping output silently
        // Client may see gaps in output if connection is too slow
      }
    })

    // Handle reconnection - reattach to existing terminal
    const unsubscribeReconnect = wsClient.onReconnect(() => {
      if (terminalIdRef.current) {
        wsClient.send({
          type: 'terminal.attach',
          terminalId: terminalIdRef.current,
          cols: term.cols,
          rows: term.rows,
        })
      }
    })

    // Forward input to server
    const inputDisposable = term.onData((data) => {
      if (terminalIdRef.current) {
        wsClient.send({
          type: 'terminal.input',
          terminalId: terminalIdRef.current,
          data,
        })
      }
    })

    // Create or attach
    if (terminalId) {
      // Reattach to existing terminal
      wsClient.send({
        type: 'terminal.attach',
        terminalId,
        cols: term.cols,
        rows: term.rows,
      })
    } else {
      // Create new terminal with clientRef for correlation
      wsClient.send({
        type: 'terminal.create',
        clientRef: tabId,  // Used to match terminal.created response
        shell,
        cwd,
        cols: term.cols,
        rows: term.rows,
      })
    }

    window.addEventListener('resize', handleResize)

    return () => {
      unsubscribe()
      unsubscribeReconnect()
      inputDisposable.dispose()
      window.removeEventListener('resize', handleResize)

      // IMPORTANT: Send terminal.detach on cleanup to release server attachment
      // This ensures server knows we're no longer attached (prevents stale attachedClients)
      if (terminalIdRef.current) {
        wsClient.send({
          type: 'terminal.detach',
          terminalId: terminalIdRef.current,
        })
      }

      term.dispose()
    }
  }, [tabId, shell, cwd, dispatch, handleResize])

  // Refit when becoming active
  useEffect(() => {
    if (isActive) {
      requestAnimationFrame(() => {
        fitAddonRef.current?.fit()
        termRef.current?.focus()
      })
    }
  }, [isActive])

  // Use visibility instead of display:none to prevent xterm measurement issues
  // Inactive terminals are offscreen but maintain their dimensions
  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 ${isActive ? 'visible z-10' : 'invisible z-0'}`}
      style={{ padding: '4px' }}
    />
  )
}
```

**Step 2: Write Terminal tests**

Create `src/components/__tests__/Terminal.test.tsx`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { Terminal } from '../Terminal'
import tabsReducer from '../../store/tabsSlice'
import connectionReducer from '../../store/connectionSlice'

// Mock xterm
vi.mock('xterm', () => ({
  Terminal: vi.fn().mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
    clear: vi.fn(),  // Used when receiving terminal.snapshot
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    focus: vi.fn(),
    cols: 80,
    rows: 24,
  })),
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    fit: vi.fn(),
  })),
}))

vi.mock('../../lib/ws-client', () => ({
  getWsClient: vi.fn(() => ({
    send: vi.fn(),
    onMessage: vi.fn(() => vi.fn()),  // Returns unsubscribe fn
    onReconnect: vi.fn(() => vi.fn()),  // Returns unsubscribe fn
  })),
}))

function createTestStore(preloadedState?: any) {
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      connection: connectionReducer,
    },
    preloadedState,
  })
}

describe('Terminal', () => {
  it('renders without crashing', () => {
    const store = createTestStore()
    const { container } = render(
      <Provider store={store}>
        <Terminal
          tabId="tab1"
          terminalId={null}
          shell="cmd"
          cwd="C:\\"
          isActive={true}
        />
      </Provider>
    )
    expect(container.firstChild).toBeDefined()
  })

  it('uses visibility:hidden when not active (allows xterm to measure)', () => {
    const store = createTestStore()
    const { container } = render(
      <Provider store={store}>
        <Terminal
          tabId="tab1"
          terminalId={null}
          shell="cmd"
          cwd="C:\\"
          isActive={false}
        />
      </Provider>
    )
    // NOTE: Terminal uses 'invisible' class (visibility:hidden), not 'hidden' (display:none)
    // This allows xterm to measure its container even when not visible
    expect(container.firstChild).toHaveClass('invisible')
  })
})
```

**Step 3: Run tests**
```bash
npm test -- --run src/components/__tests__/Terminal.test.tsx
```

**Step 4: Commit**
```bash
git add -A && git commit -m "feat: add Terminal component with tab integration"
```

---

### Task 2.4: Create Main App Layout with Multi-Tab Support

**Files:**
- Create: `src/lib/api.ts`
- Create: `src/components/AppLayout.tsx`
- Create: `src/hooks/useKeyboardShortcuts.ts`
- Modify: `src/App.tsx`

**Step 0: Create API helper for authenticated requests**

Create `src/lib/api.ts`:
```typescript
// Authenticated fetch wrapper for API calls
// Token is passed via Authorization: Bearer header ONLY
// NEVER use query params for auth - they leak via logs/history/Referer

function getAuthToken(): string | null {
  // Token is stored in sessionStorage by initializeAuthToken() on app bootstrap
  // Never reconstruct from URL here
  return sessionStorage.getItem('auth-token')
}

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const token = getAuthToken()

  const headers = new Headers(options?.headers)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  headers.set('Content-Type', 'application/json')

  return fetch(url, {
    ...options,
    headers,
  })
}

// Convenience methods
export const api = {
  get: (url: string) => apiFetch(url),
  post: (url: string, body: unknown) => apiFetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
  }),
  put: (url: string, body: unknown) => apiFetch(url, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),
  delete: (url: string) => apiFetch(url, { method: 'DELETE' }),
}
```

**Step 1: Create keyboard shortcuts hook**

Create `src/hooks/useKeyboardShortcuts.ts`:
```typescript
import { useEffect, useRef, useCallback } from 'react'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { setActiveTab } from '../store/tabsSlice'

interface ShortcutHandlers {
  onNewTab: () => void
  onCloseTab: () => void
  onDetachTab?: () => void  // Optional: detach instead of kill
}

export function useKeyboardShortcuts({ onNewTab, onCloseTab, onDetachTab }: ShortcutHandlers) {
  const dispatch = useAppDispatch()
  const { tabs, activeTabId } = useAppSelector(state => state.tabs)
  const ctrlBPressed = useRef(false)
  const ctrlBTimeout = useRef<number | null>(null)

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // IMPORTANT: Don't intercept when focus is inside terminal
    // Users need Ctrl-B for tmux, screen, and other terminal programs
    const activeElement = document.activeElement
    if (activeElement?.closest('.xterm')) {
      return  // Let the terminal handle it
    }

    // Ctrl-B prefix mode
    if (e.ctrlKey && e.key === 'b') {
      e.preventDefault()
      ctrlBPressed.current = true

      // Clear after 2 seconds
      if (ctrlBTimeout.current) clearTimeout(ctrlBTimeout.current)
      ctrlBTimeout.current = window.setTimeout(() => {
        ctrlBPressed.current = false
      }, 2000)
      return
    }

    if (!ctrlBPressed.current) return

    ctrlBPressed.current = false
    if (ctrlBTimeout.current) clearTimeout(ctrlBTimeout.current)

    switch (e.key.toLowerCase()) {
      case 'c': // New tab
        e.preventDefault()
        onNewTab()
        break

      case 'x': // Close tab (detach by default, kill with Shift)
        e.preventDefault()
        if (e.shiftKey) {
          onCloseTab()  // Shift+X = kill
        } else if (onDetachTab) {
          onDetachTab()  // X = detach (leave running)
        } else {
          onCloseTab()  // Fallback to close if no detach handler
        }
        break

      case 'd': // Explicit detach (same as X without Shift)
        e.preventDefault()
        if (onDetachTab) {
          onDetachTab()
        }
        break

      case 'n': // Next tab
        e.preventDefault()
        if (tabs.length > 0 && activeTabId) {
          const currentIndex = tabs.findIndex(t => t.id === activeTabId)
          const nextIndex = (currentIndex + 1) % tabs.length
          dispatch(setActiveTab(tabs[nextIndex].id))
        }
        break

      case 'p': // Previous tab
        e.preventDefault()
        if (tabs.length > 0 && activeTabId) {
          const currentIndex = tabs.findIndex(t => t.id === activeTabId)
          const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length
          dispatch(setActiveTab(tabs[prevIndex].id))
        }
        break

      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
      case '9':
        e.preventDefault()
        const index = parseInt(e.key) - 1
        if (tabs[index]) {
          dispatch(setActiveTab(tabs[index].id))
        }
        break
    }
  }, [tabs, activeTabId, dispatch, onNewTab, onCloseTab, onDetachTab])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}
```

**Step 2: Create AppLayout component**

Create `src/components/AppLayout.tsx`:
```typescript
import { useCallback } from 'react'
import { nanoid } from 'nanoid'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { addTab, removeTab } from '../store/tabsSlice'
import { TabBar } from './TabBar'
import { Terminal } from './Terminal'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { getWsClient } from '../lib/ws-client'

export function AppLayout() {
  const dispatch = useAppDispatch()
  const { tabs, activeTabId } = useAppSelector(state => state.tabs)
  const activeTab = tabs.find(t => t.id === activeTabId)

  const handleNewTab = useCallback(() => {
    const id = nanoid()
    dispatch(addTab({
      id,
      terminalId: null,
      title: `Terminal ${tabs.length + 1}`,
      shell: 'cmd',
      cwd: import.meta.env.VITE_DEFAULT_CWD || 'C:\\Users',
    }))
  }, [dispatch, tabs.length])

  // DETACH (default): Leave process running in background, can reattach later
  const handleDetachTab = useCallback(() => {
    if (activeTabId && activeTab?.terminalId) {
      getWsClient().send({
        type: 'terminal.detach',
        terminalId: activeTab.terminalId,
      })
      dispatch(removeTab(activeTabId))
    }
  }, [activeTabId, activeTab, dispatch])

  // KILL (explicit): Terminate process immediately (Shift+X)
  const handleKillTab = useCallback(() => {
    if (activeTabId && activeTab?.terminalId) {
      getWsClient().send({
        type: 'terminal.kill',
        terminalId: activeTab.terminalId,
      })
      dispatch(removeTab(activeTabId))
    }
  }, [activeTabId, activeTab, dispatch])

  useKeyboardShortcuts({
    onNewTab: handleNewTab,
    onCloseTab: handleKillTab,     // Shift+X = kill (explicit)
    onDetachTab: handleDetachTab,  // X = detach (default)
  })

  return (
    <div className="h-screen flex flex-col bg-gray-900 text-white">
      <TabBar onNewTab={handleNewTab} />

      <div className="flex-1 relative">
        {tabs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <p className="text-lg mb-2">No terminals open</p>
              <p className="text-sm">Press <kbd className="px-2 py-1 bg-gray-700 rounded">Ctrl-B C</kbd> to create a new terminal</p>
            </div>
          </div>
        ) : (
          tabs.map(tab => (
            <Terminal
              key={tab.id}
              tabId={tab.id}
              terminalId={tab.terminalId}
              shell={tab.shell}
              cwd={tab.cwd}
              isActive={tab.id === activeTabId}
            />
          ))
        )}
      </div>
    </div>
  )
}
```

**Step 3: Install nanoid**
```bash
npm install nanoid
```

**Step 4: Update App.tsx**
```typescript
import { useEffect } from 'react'
import { useAppDispatch } from './store/hooks'
import { setConnectionStatus, setServerInfo } from './store/connectionSlice'
import { AppLayout } from './components/AppLayout'
import { getWsClient } from './lib/ws-client'

function App() {
  const dispatch = useAppDispatch()

  useEffect(() => {
    const wsClient = getWsClient()

    dispatch(setConnectionStatus('connecting'))

    const unsubscribe = wsClient.onMessage((msg: any) => {
      if (msg.type === 'ready') {
        dispatch(setConnectionStatus('connected'))
        dispatch(setServerInfo({
          version: msg.serverVersion,
          capabilities: msg.capabilities,
        }))
      }
    })

    wsClient.connect().catch(() => {
      dispatch(setConnectionStatus('disconnected'))
    })

    return () => {
      unsubscribe()
    }
  }, [dispatch])

  return <AppLayout />
}

export default App
```

**Step 5: Test manually**

Terminal 1:
```bash
npm run dev:server
```

Terminal 2:
```bash
npm run dev
```

Test:
1. Open http://localhost:5173
2. Press Ctrl-B C to create new tab
3. Press Ctrl-B C again for another tab
4. Press Ctrl-B N to switch to next tab
5. Press Ctrl-B P to switch to previous tab
6. Press Ctrl-B X to close current tab

**Step 6: Commit**
```bash
git add -A && git commit -m "feat: add AppLayout with multi-tab support and Ctrl-B shortcuts"
```

---

### Task 2.5: Add Tab Persistence via Store Middleware

**Files:**
- Create: `src/store/persistMiddleware.ts`
- Modify: `src/store/index.ts`

**Step 1: Create persistence middleware**

Create `src/store/persistMiddleware.ts`:
```typescript
import { Middleware } from '@reduxjs/toolkit'
import { RootState } from './index'

const STORAGE_KEY = 'claude-organizer-tabs'

export const loadPersistedState = (): Partial<RootState> | undefined => {
  try {
    const serialized = localStorage.getItem(STORAGE_KEY)
    if (!serialized) return undefined

    const parsed = JSON.parse(serialized)
    // Restore tabs but reset status to 'creating' since terminals need to reattach
    if (parsed.tabs?.tabs) {
      parsed.tabs.tabs = parsed.tabs.tabs.map((tab: any) => ({
        ...tab,
        status: tab.terminalId ? 'creating' : tab.status,
      }))
    }
    return parsed
  } catch {
    return undefined
  }
}

export const persistMiddleware: Middleware = (store) => (next) => (action) => {
  const result = next(action)

  // Only persist tab-related state
  const state = store.getState() as RootState
  const toPersist = {
    tabs: state.tabs,
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toPersist))
  } catch {
    // Ignore storage errors
  }

  return result
}
```

**Step 2: Update store to use middleware**

Modify `src/store/index.ts`:
```typescript
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from './tabsSlice'
import connectionReducer from './connectionSlice'
import { persistMiddleware, loadPersistedState } from './persistMiddleware'

const preloadedState = loadPersistedState()

export const store = configureStore({
  reducer: {
    tabs: tabsReducer,
    connection: connectionReducer,
  },
  preloadedState,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(persistMiddleware),
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
```

**Step 3: Update Terminal to handle reattach on load**

The Terminal component already handles this - if `terminalId` is set, it sends `terminal.attach` instead of `terminal.create`.

**Step 4: Test manually**
1. Open app, create a few tabs
2. Close browser tab
3. Reopen - tabs should restore and reattach to existing terminals

**Step 5: Commit**
```bash
git add -A && git commit -m "feat: add tab persistence via localStorage middleware"
```

---

### Task 2.6: Production Build Configuration

**Files:**
- Modify: `vite.config.ts`
- Modify: `server/index.ts`
- Create: `.env.example`
- Modify: `package.json`

**Step 1: Update Vite config for production**

Update `vite.config.ts`:
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: mode === 'development',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
}))
```

**Step 2: Create .env.example**
```
# Server configuration
HOST=127.0.0.1
PORT=3001

# Authentication (REQUIRED for remote access - minimum 32 characters)
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Server will refuse to start if HOST is non-loopback and AUTH_TOKEN is missing/short
AUTH_TOKEN=

# Logging level: fatal, error, warn, info (default), debug, trace
LOG_LEVEL=info

# Claude Code directory (optional, defaults to ~/.claude)
CLAUDE_DIR=

# Background session timeout in minutes (default: 30)
IDLE_TIMEOUT_MINUTES=30

# Terminal output buffer size in bytes (default: 102400 = 100KB)
# Used for scrollback replay on reattach
OUTPUT_BUFFER_SIZE=102400

# Max WebSocket connections (default: 10)
MAX_WS_CONNECTIONS=10

# Google AI API key (required for AI features in Release 7)
GOOGLE_API_KEY=
```

**Step 3: Create Vite env types (`src/vite-env.d.ts`)**
```typescript
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_CWD: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

**Step 3: Update package.json scripts**

> **Note:** `build` now runs both client and server builds. Install `cross-env` for Windows compatibility.

```bash
npm install -D cross-env
```

```json
{
  "scripts": {
    "dev": "vite",
    "dev:server": "tsx watch server/index.ts",
    "build": "npm run build:client && npm run build:server",
    "build:client": "vite build",
    "build:server": "tsc -p tsconfig.server.json",
    "start": "node dist/server/index.js",
    "preview": "npm run build && cross-env NODE_ENV=production npm run start",
    "test": "vitest",
    "test:server": "vitest --config vitest.server.config.ts",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint . --ext ts,tsx",
    "format": "prettier --write \"src/**/*.{ts,tsx}\" \"server/**/*.ts\""
  }
}
```

**Step 4: Test production build**
```bash
npm run build
npm run build:server
NODE_ENV=production npm run start
```

Open http://localhost:3001 - should serve built frontend

**Step 5: Test remote access**
```bash
HOST=0.0.0.0 AUTH_TOKEN=test-secret npm run start
```

From another device on network: `http://<your-ip>:3001?token=test-secret`

**Step 6: Commit**
```bash
git add -A && git commit -m "feat: add production build configuration"
```

---

### Release 2 Acceptance Tests

**E2E headless:**
- [ ] Create 3 terminals, switch tabs, each receives output
- [ ] Close browser and reopen → tabs restore and reattach

**Frontend unit:**
- [ ] Tab switching logic
- [ ] Ctrl-B shortcut flows

**Manual:**
- [ ] Production build serves UI + API from same origin
- [ ] Remote access with auth token works

**Exit Criteria:**
- [ ] Multiple tabs work reliably
- [ ] Ctrl-B shortcuts work
- [ ] Production deployment works

---

## Release 3 — Claude Session Ingestion + History UX

**Purpose:** Prove log ingestion pipeline is reliable. Provide usable history view with correct collapse behavior.

**Exit Criteria:** Sessions load from CC logs, history UX matches spec (old collapsed, active not).

---

### Task 3.1: Create Claude Session Watcher

**Files:**
- Create: `server/claude-watcher.ts`
- Create: `server/session-parser.ts`
- Create: `server/__tests__/session-parser.test.ts`

**Step 1: Create session parser**

Create `server/session-parser.ts`:
```typescript
import { readFile, readdir, stat } from 'fs/promises'
import { join, basename } from 'path'

export interface ClaudeSession {
  sessionId: string
  projectPath: string
  projectName: string
  lastModified: Date
  messageCount?: number
}

export interface ClaudeProject {
  projectPath: string
  projectName: string
  sessions: ClaudeSession[]
}

export async function parseSessionsIndex(claudeDir: string): Promise<ClaudeProject[]> {
  const projectsDir = join(claudeDir, 'projects')
  const projects: ClaudeProject[] = []

  try {
    const entries = await readdir(projectsDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const projectDir = join(projectsDir, entry.name)
      const sessions = await parseProjectSessions(projectDir)

      if (sessions.length > 0) {
        // Decode project path from directory name
        const projectPath = decodeProjectPath(entry.name)
        const projectName = basename(projectPath)

        projects.push({
          projectPath,
          projectName,
          sessions: sessions.map(s => ({
            ...s,
            projectPath,
            projectName,
          })),
        })
      }
    }

    // Sort by most recent session
    projects.sort((a, b) => {
      const aLatest = Math.max(...a.sessions.map(s => s.lastModified.getTime()))
      const bLatest = Math.max(...b.sessions.map(s => s.lastModified.getTime()))
      return bLatest - aLatest
    })

    return projects
  } catch (err) {
    console.error('Failed to parse sessions:', err)
    return []
  }
}

async function parseProjectSessions(projectDir: string): Promise<Omit<ClaudeSession, 'projectPath' | 'projectName'>[]> {
  const sessions: Omit<ClaudeSession, 'projectPath' | 'projectName'>[] = []

  try {
    const files = await readdir(projectDir)

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue

      const sessionId = file.replace('.jsonl', '')
      const filePath = join(projectDir, file)
      const fileStat = await stat(filePath)

      sessions.push({
        sessionId,
        lastModified: fileStat.mtime,
      })
    }

    // Sort by most recent first
    sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime())

    return sessions
  } catch {
    return []
  }
}

/**
 * Decode project path from Claude Code's encoded directory name.
 *
 * WARNING: This decoding is LOSSY - hyphens in original folder names cannot be
 * distinguished from path separators. For example:
 * - "D--Users-Dan-my-project" -> "D:\Users\Dan\my\project" (WRONG if folder is "my-project")
 *
 * BETTER APPROACH: Extract the actual project path from the session metadata
 * inside the .jsonl files. The cwd field in conversation context contains the true path.
 * See extractProjectPathFromSession() below.
 */
function decodeProjectPath(encodedName: string): string {
  // CC encodes paths by replacing special chars
  // Format: D--Users-Dan-project becomes D:\Users\Dan\project on Windows
  // Format: -Users-dan-project becomes /Users/dan/project on Unix

  if (encodedName.match(/^[A-Z]--/)) {
    // Windows path: D--Users-Dan-project
    const drive = encodedName[0]
    const rest = encodedName.slice(3).replace(/-/g, '\\')
    return `${drive}:\\${rest}`
  } else if (encodedName.startsWith('-')) {
    // Unix path: -Users-dan-project
    return encodedName.replace(/-/g, '/')
  }

  return encodedName
}

/**
 * Extract actual project path from session file metadata.
 * This is the PREFERRED approach as it's not lossy.
 */
async function extractProjectPathFromSession(sessionPath: string): Promise<string | null> {
  try {
    const { createReadStream } = await import('fs')
    const { createInterface } = await import('readline')

    // Read first few lines to find the cwd in metadata
    const stream = createReadStream(sessionPath, { encoding: 'utf8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })

    for await (const line of rl) {
      try {
        const entry = JSON.parse(line)
        // Look for conversation context with cwd
        if (entry.type === 'message' && entry.message?.context?.cwd) {
          rl.close()
          stream.destroy()
          return entry.message.context.cwd
        }
        // Also check for system messages with cwd
        if (entry.cwd) {
          rl.close()
          stream.destroy()
          return entry.cwd
        }
      } catch {
        continue  // Skip non-JSON lines
      }
    }

    return null
  } catch {
    return null
  }
}

export function encodeProjectPath(projectPath: string): string {
  if (projectPath.match(/^[A-Z]:\\/)) {
    // Windows path
    const drive = projectPath[0]
    const rest = projectPath.slice(3).replace(/\\/g, '-')
    return `${drive}--${rest}`
  } else if (projectPath.startsWith('/')) {
    // Unix path
    return projectPath.replace(/\//g, '-')
  }
  return projectPath
}
```

**Step 2: Create Claude watcher**

Create `server/claude-watcher.ts`:
```typescript
import { watch } from 'chokidar'
import { EventEmitter } from 'events'
import { join } from 'path'
import { homedir } from 'os'
import { parseSessionsIndex, ClaudeProject } from './session-parser'

export class ClaudeWatcher extends EventEmitter {
  private watcher: ReturnType<typeof watch> | null = null
  private claudeDir: string
  private debounceTimer: NodeJS.Timeout | null = null
  private projects: ClaudeProject[] = []

  constructor(claudeDir?: string) {
    super()
    this.claudeDir = claudeDir || join(homedir(), '.claude')
  }

  async start(): Promise<void> {
    // Initial load
    this.projects = await parseSessionsIndex(this.claudeDir)
    this.emit('sessions', this.projects)

    // Watch for changes
    const projectsDir = join(this.claudeDir, 'projects')
    this.watcher = watch(projectsDir, {
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    })

    this.watcher.on('add', () => this.scheduleRefresh())
    this.watcher.on('change', () => this.scheduleRefresh())
    this.watcher.on('unlink', () => this.scheduleRefresh())
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => this.refresh(), 1000)
  }

  private async refresh(): Promise<void> {
    this.projects = await parseSessionsIndex(this.claudeDir)
    this.emit('sessions', this.projects)
  }

  getProjects(): ClaudeProject[] {
    return this.projects
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.watcher?.close()
  }
}
```

**Step 3: Write parser tests**

Create `server/__tests__/session-parser.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseSessionsIndex, encodeProjectPath } from '../session-parser'

describe('session-parser', () => {
  const testDir = join(tmpdir(), 'claude-test-' + process.pid)
  const projectsDir = join(testDir, 'projects')

  beforeAll(async () => {
    // Create test structure
    const project1Dir = join(projectsDir, 'D--Users-Test-project1')
    const project2Dir = join(projectsDir, 'D--Users-Test-project2')

    await mkdir(project1Dir, { recursive: true })
    await mkdir(project2Dir, { recursive: true })

    // Create session files
    await writeFile(join(project1Dir, 'session1.jsonl'), '{"type":"message"}\n')
    await writeFile(join(project1Dir, 'session2.jsonl'), '{"type":"message"}\n')
    await writeFile(join(project2Dir, 'session3.jsonl'), '{"type":"message"}\n')
  })

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('parses sessions from directory structure', async () => {
    const projects = await parseSessionsIndex(testDir)

    expect(projects).toHaveLength(2)
    expect(projects[0].sessions.length + projects[1].sessions.length).toBe(3)
  })

  it('decodes Windows project paths', async () => {
    const projects = await parseSessionsIndex(testDir)
    const paths = projects.map(p => p.projectPath)

    expect(paths).toContain('D:\\Users\\Test\\project1')
    expect(paths).toContain('D:\\Users\\Test\\project2')
  })

  it('encodes project paths correctly', () => {
    expect(encodeProjectPath('D:\\Users\\Test\\project')).toBe('D--Users-Test-project')
    expect(encodeProjectPath('/Users/test/project')).toBe('-Users-test-project')
  })
})
```

**Step 4: Run tests**
```bash
npm run test:server -- --run server/__tests__/session-parser.test.ts
```

**Step 5: Commit**
```bash
git add -A && git commit -m "feat: add Claude session parser and watcher"
```

---

### Task 3.2: Add Sessions API Endpoint

**Files:**
- Modify: `server/index.ts`
- Create: `server/__tests__/sessions-api.test.ts`

**Step 1: Update server to include sessions API**

Modify `server/index.ts` to add:
```typescript
import { ClaudeWatcher } from './claude-watcher'

// ... existing code ...

// Create watcher instance at module level (but don't start yet)
const claudeWatcher = new ClaudeWatcher(process.env.CLAUDE_DIR)

// REST endpoint can be registered at module level
app.get('/api/sessions', (_req, res) => {
  res.json({ projects: claudeWatcher.getProjects() })
})

// CRITICAL: Inside main(), AFTER wsHandler is assigned, start the watcher
// This fixes the race condition where watcher may emit before wsHandler exists
//
// In main():
//   wsHandler = setupWsHandler(wss, registry)
//
//   // Now it's safe to start the watcher - wsHandler is guaranteed to exist
//   claudeWatcher.on('sessions', (projects) => {
//     wsHandler.broadcast('sessions.updated', { projects })
//   })
//   claudeWatcher.start().catch(console.error)
//
//   server.listen(...)
```

**Step 2: Write API tests**

Create `server/__tests__/sessions-api.test.ts`:
```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ClaudeWatcher } from '../claude-watcher'

describe('Sessions API', () => {
  const testDir = join(tmpdir(), 'claude-api-test-' + process.pid)
  let app: express.Express
  let watcher: ClaudeWatcher

  beforeAll(async () => {
    // Create test fixtures
    const projectDir = join(testDir, 'projects', 'D--Test-project')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'session1.jsonl'), '{}')

    // Create isolated app instance
    app = express()
    app.use(express.json())

    watcher = new ClaudeWatcher(testDir)
    await watcher.start()

    app.get('/api/sessions', (_req, res) => {
      res.json({ projects: watcher.getProjects() })
    })
  })

  afterAll(async () => {
    watcher.stop()
    await rm(testDir, { recursive: true, force: true })
  })

  it('returns session list', async () => {
    const res = await request(app).get('/api/sessions')

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('projects')
    expect(Array.isArray(res.body.projects)).toBe(true)
  })

  it('returns projects with correct structure', async () => {
    const res = await request(app).get('/api/sessions')

    expect(res.body.projects.length).toBeGreaterThan(0)
    expect(res.body.projects[0]).toHaveProperty('projectPath')
    expect(res.body.projects[0]).toHaveProperty('sessions')
  })
})
```

**Step 3: Commit**
```bash
git add -A && git commit -m "feat: add sessions API endpoint"
```

---

### Task 3.3: Create Sessions Redux Slice

**Files:**
- Create: `src/store/sessionsSlice.ts`
- Modify: `src/store/index.ts`

**Step 1: Create sessions slice**

Create `src/store/sessionsSlice.ts`:
```typescript
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit'

export interface ClaudeSession {
  sessionId: string
  projectPath: string
  projectName: string
  lastModified: string
}

export interface ClaudeProject {
  projectPath: string
  projectName: string
  sessions: ClaudeSession[]
  color?: string
}

interface SessionsState {
  projects: ClaudeProject[]
  loading: boolean
  error: string | null
  expandedProjects: Set<string>  // Track expanded, not collapsed (collapsed is default)
}

const initialState: SessionsState = {
  projects: [],
  loading: false,
  error: null,
  expandedProjects: new Set(),
}

import { api } from '../lib/api'

export const fetchSessions = createAsyncThunk(
  'sessions/fetch',
  async (_, { rejectWithValue }) => {
    try {
      const res = await api.get('/api/sessions')
      if (!res.ok) throw new Error('Failed to fetch sessions')
      const data = await res.json()
      return data.projects
    } catch (err) {
      return rejectWithValue((err as Error).message)
    }
  }
)

export const sessionsSlice = createSlice({
  name: 'sessions',
  initialState,
  reducers: {
    setSessions: (state, action: PayloadAction<ClaudeProject[]>) => {
      state.projects = action.payload
    },

    toggleProjectExpanded: (state, action: PayloadAction<string>) => {
      const projectPath = action.payload
      if (state.expandedProjects.has(projectPath)) {
        state.expandedProjects.delete(projectPath)
      } else {
        state.expandedProjects.add(projectPath)
      }
    },

    setProjectColor: (state, action: PayloadAction<{ projectPath: string; color: string }>) => {
      const project = state.projects.find(p => p.projectPath === action.payload.projectPath)
      if (project) {
        project.color = action.payload.color
      }
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSessions.pending, (state) => {
        state.loading = true
        state.error = null
      })
      .addCase(fetchSessions.fulfilled, (state, action) => {
        state.loading = false
        state.projects = action.payload
      })
      .addCase(fetchSessions.rejected, (state, action) => {
        state.loading = false
        state.error = action.payload as string
      })
  },
})

export const { setSessions, toggleProjectExpanded, setProjectColor } = sessionsSlice.actions
export default sessionsSlice.reducer
```

**Step 2: Update store**

Modify `src/store/index.ts`:
```typescript
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from './tabsSlice'
import connectionReducer from './connectionSlice'
import sessionsReducer from './sessionsSlice'
import { persistMiddleware, loadPersistedState } from './persistMiddleware'

const preloadedState = loadPersistedState()

export const store = configureStore({
  reducer: {
    tabs: tabsReducer,
    connection: connectionReducer,
    sessions: sessionsReducer,
  },
  preloadedState,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredPaths: ['sessions.expandedProjects'],
      },
    }).concat(persistMiddleware),
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
```

**Step 3: Commit**
```bash
git add -A && git commit -m "feat: add sessions Redux slice"
```

---

### Task 3.4: Create History View Component

**Files:**
- Create: `src/components/HistoryView.tsx`
- Create: `src/components/SessionCard.tsx`
- Add shadcn components

**Step 1: Add required shadcn components**
```bash
npx shadcn@latest add collapsible card scroll-area badge
```

**Step 2: Create SessionCard component**

Create `src/components/SessionCard.tsx`:
```typescript
import { ClaudeSession } from '../store/sessionsSlice'
import { Card, CardContent } from './ui/card'
import { Badge } from './ui/badge'
import { Trash2 } from 'lucide-react'
import { Button } from './ui/button'

interface SessionCardProps {
  session: ClaudeSession
  projectColor?: string
  isActive?: boolean
  onOpen: () => void
  onDelete: () => void
}

export function SessionCard({ session, projectColor, isActive, onOpen, onDelete }: SessionCardProps) {
  const timeAgo = getTimeAgo(new Date(session.lastModified))

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (e.shiftKey || confirm('Delete this session?')) {
      onDelete()
    }
  }

  return (
    <Card
      className={`group cursor-pointer hover:bg-gray-800 transition-colors ${isActive ? 'ring-2 ring-blue-500' : ''}`}
      onClick={onOpen}
    >
      <CardContent className="p-3 flex items-center gap-3">
        {projectColor && (
          <div
            className="w-2 h-8 rounded-full flex-shrink-0"
            style={{ backgroundColor: projectColor }}
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{session.sessionId.slice(0, 8)}</span>
            {isActive && <Badge variant="secondary">Active</Badge>}
          </div>
          <div className="text-sm text-gray-400">{timeAgo}</div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={handleDelete}
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </CardContent>
    </Card>
  )
}

function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)

  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return date.toLocaleDateString()
}
```

**Step 3: Create HistoryView component**

Create `src/components/HistoryView.tsx`:
```typescript
import { useEffect } from 'react'
import { useAppSelector, useAppDispatch } from '../store/hooks'
import { fetchSessions, toggleProjectExpanded, setSessions } from '../store/sessionsSlice'
import { addTab } from '../store/tabsSlice'
import { getWsClient } from '../lib/ws-client'
import { ScrollArea } from './ui/scroll-area'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible'
import { SessionCard } from './SessionCard'
import { ChevronRight, FolderOpen } from 'lucide-react'
import { nanoid } from 'nanoid'

export function HistoryView() {
  const dispatch = useAppDispatch()
  const { projects, loading, expandedProjects } = useAppSelector(state => state.sessions)
  const { tabs } = useAppSelector(state => state.tabs)

  // Get active terminal project paths (use initialCwd, not current cwd)
  const activeProjectPaths = new Set(tabs.map(t => t.initialCwd))

  useEffect(() => {
    dispatch(fetchSessions())

    // Listen for real-time updates
    const unsubscribe = getWsClient().onMessage((msg: any) => {
      if (msg.type === 'sessions.updated') {
        dispatch(setSessions(msg.projects))
      }
    })

    return unsubscribe
  }, [dispatch])

  const handleOpenSession = (projectPath: string) => {
    const id = nanoid()
    dispatch(addTab({
      id,
      terminalId: null,
      title: projectPath.split(/[/\\]/).pop() || 'Terminal',
      shell: 'cmd',
      cwd: projectPath,
    }))
  }

  const handleDeleteSession = (sessionId: string) => {
    // TODO: Implement soft delete via API
    console.log('Delete session:', sessionId)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        Loading sessions...
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-4">
        <h2 className="text-lg font-semibold">History</h2>

        {projects.map(project => {
          const isActive = activeProjectPaths.has(project.projectPath)
          // Active projects always expanded; others collapsed by default unless explicitly expanded
          const isExpanded = isActive || expandedProjects.has(project.projectPath)

          return (
            <Collapsible
              key={project.projectPath}
              open={isExpanded}
              onOpenChange={() => dispatch(toggleProjectExpanded(project.projectPath))}
            >
              <CollapsibleTrigger className="flex items-center gap-2 w-full p-2 hover:bg-gray-800 rounded">
                <ChevronRight
                  className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                />
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: project.color || '#6b7280' }}
                />
                <FolderOpen className="w-4 h-4" />
                <span className="font-medium">{project.projectName}</span>
                <span className="text-gray-400 text-sm ml-auto">
                  {project.sessions.length} session{project.sessions.length !== 1 ? 's' : ''}
                </span>
              </CollapsibleTrigger>

              <CollapsibleContent className="pl-8 space-y-2 mt-2">
                {project.sessions.map(session => (
                  <SessionCard
                    key={session.sessionId}
                    session={session}
                    projectColor={project.color}
                    isActive={isActive}
                    onOpen={() => handleOpenSession(project.projectPath)}
                    onDelete={() => handleDeleteSession(session.sessionId)}
                  />
                ))}
              </CollapsibleContent>
            </Collapsible>
          )
        })}

        {projects.length === 0 && (
          <div className="text-center text-gray-400 py-8">
            No Claude sessions found
          </div>
        )}
      </div>
    </ScrollArea>
  )
}
```

**Step 4: Commit**
```bash
git add -A && git commit -m "feat: add History view with collapsible projects"
```

---

### Task 3.5: Add Sidebar Navigation

**Files:**
- Modify: `src/components/AppLayout.tsx`
- Create: `src/components/Sidebar.tsx`

**Step 1: Create Sidebar component**

Create `src/components/Sidebar.tsx`:
```typescript
import { Terminal, History, Settings, LayoutDashboard, Menu, X } from 'lucide-react'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { useState } from 'react'

type View = 'terminals' | 'history' | 'overview' | 'settings'

interface SidebarProps {
  activeView: View
  onViewChange: (view: View) => void
}

export function Sidebar({ activeView, onViewChange }: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  const items: { view: View; icon: typeof Terminal; label: string }[] = [
    { view: 'terminals', icon: Terminal, label: 'Terminals' },
    { view: 'history', icon: History, label: 'History' },
    { view: 'overview', icon: LayoutDashboard, label: 'Overview' },
    { view: 'settings', icon: Settings, label: 'Settings' },
  ]

  const handleViewChange = (view: View) => {
    onViewChange(view)
    setMobileOpen(false)  // Close mobile menu on selection
  }

  return (
    <>
      {/* Mobile hamburger button - visible on small screens */}
      <div className="md:hidden fixed top-2 left-2 z-50">
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11"  // 44px touch target
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          {mobileOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
        </Button>
      </div>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar - always visible on md+, conditionally on mobile */}
      <div className={`
        fixed md:relative z-50 md:z-auto
        w-14 h-full bg-gray-800 border-r border-gray-700
        flex flex-col items-center py-4 gap-2
        transition-transform duration-200
        ${mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        <TooltipProvider>
          {items.map(({ view, icon: Icon, label }) => (
            <Tooltip key={view}>
              <TooltipTrigger asChild>
                <Button
                  variant={activeView === view ? 'secondary' : 'ghost'}
                  size="icon"
                  className="h-11 w-11"  // 44px min touch target
                  onClick={() => handleViewChange(view)}
                >
                  <Icon className="w-5 h-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          ))}
        </TooltipProvider>
      </div>
    </>
  )
}
```

**Step 2: Update AppLayout to include sidebar**

Modify `src/components/AppLayout.tsx`:
```typescript
import { useCallback, useState } from 'react'
import { nanoid } from 'nanoid'
import { useAppDispatch, useAppSelector } from '../store/hooks'
import { addTab, removeTab } from '../store/tabsSlice'
import { TabBar } from './TabBar'
import { Terminal } from './Terminal'
import { Sidebar } from './Sidebar'
import { HistoryView } from './HistoryView'
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts'
import { getWsClient } from '../lib/ws-client'

type View = 'terminals' | 'history' | 'overview' | 'settings'

export function AppLayout() {
  const dispatch = useAppDispatch()
  const { tabs, activeTabId } = useAppSelector(state => state.tabs)
  const activeTab = tabs.find(t => t.id === activeTabId)
  const [activeView, setActiveView] = useState<View>('terminals')

  const handleNewTab = useCallback(() => {
    const id = nanoid()
    dispatch(addTab({
      id,
      terminalId: null,
      title: `Terminal ${tabs.length + 1}`,
      shell: 'cmd',
      cwd: import.meta.env.VITE_DEFAULT_CWD || 'C:\\Users',
    }))
    setActiveView('terminals')
  }, [dispatch, tabs.length])

  // DETACH (default): Leave process running in background
  const handleDetachTab = useCallback(() => {
    if (activeTabId && activeTab?.terminalId) {
      getWsClient().send({
        type: 'terminal.detach',
        terminalId: activeTab.terminalId,
      })
      dispatch(removeTab(activeTabId))
    }
  }, [activeTabId, activeTab, dispatch])

  // KILL (explicit): Terminate process immediately (Shift+X)
  const handleKillTab = useCallback(() => {
    if (activeTabId && activeTab?.terminalId) {
      getWsClient().send({
        type: 'terminal.kill',
        terminalId: activeTab.terminalId,
      })
      dispatch(removeTab(activeTabId))
    }
  }, [activeTabId, activeTab, dispatch])

  useKeyboardShortcuts({
    onNewTab: handleNewTab,
    onCloseTab: handleKillTab,     // Shift+X = kill
    onDetachTab: handleDetachTab,  // X = detach (default)
  })

  return (
    <div className="h-screen flex bg-gray-900 text-white">
      <Sidebar activeView={activeView} onViewChange={setActiveView} />

      <div className="flex-1 flex flex-col">
        {activeView === 'terminals' && (
          <>
            <TabBar onNewTab={handleNewTab} />
            <div className="flex-1 relative">
              {tabs.length === 0 ? (
                <div className="flex items-center justify-center h-full text-gray-500">
                  <div className="text-center">
                    <p className="text-lg mb-2">No terminals open</p>
                    <p className="text-sm">
                      Press <kbd className="px-2 py-1 bg-gray-700 rounded">Ctrl-B C</kbd> to create a new terminal
                    </p>
                  </div>
                </div>
              ) : (
                tabs.map(tab => (
                  <Terminal
                    key={tab.id}
                    tabId={tab.id}
                    terminalId={tab.terminalId}
                    shell={tab.shell}
                    cwd={tab.cwd}
                    isActive={tab.id === activeTabId}
                  />
                ))
              )}
            </div>
          </>
        )}

        {activeView === 'history' && <HistoryView />}

        {activeView === 'overview' && (
          <div className="flex items-center justify-center h-full text-gray-400">
            Overview (Release 6)
          </div>
        )}

        {activeView === 'settings' && (
          <div className="flex items-center justify-center h-full text-gray-400">
            Settings (Release 4)
          </div>
        )}
      </div>
    </div>
  )
}
```

**Step 3: Commit**
```bash
git add -A && git commit -m "feat: add sidebar navigation and history view integration"
```

---

### Release 3 Acceptance Tests

**Automated:**
- [ ] Session parser loads sessions from test fixtures
- [ ] Watcher detects new session files
- [ ] API returns correct session structure

**Manual:**
- [ ] History view shows projects grouped with sessions
- [ ] Old sessions collapsed by default
- [ ] Active terminal projects NOT collapsed
- [ ] Delete with confirm, Shift+Delete bypasses
- [ ] Clicking session opens terminal in that project

**Exit Criteria:**
- [ ] Session ingestion stable
- [ ] History UX matches spec

---

## Release 4 — Persistent User Settings + Appearance + Project Colors

**Purpose:** Prove settings work across devices by storing server-side. Establish theming foundation.

**Exit Criteria:** Settings persist across devices, themes apply correctly, project colors work.

---

### Task 4.1: Create Server-Side Config Store

**Files:**
- Create: `server/config-store.ts`
- Create: `server/__tests__/config-store.test.ts`

**Step 1: Create config store**

Create `server/config-store.ts`:
```typescript
import { readFile, writeFile, mkdir, rename, unlink, chmod } from 'fs/promises'
import { join, dirname } from 'path'
import { homedir } from 'os'

export interface UserConfig {
  userName: string
  theme: 'light' | 'dark'
  terminalFont: string
  terminalFontSize: number
  terminalTheme: string
  projectColors: Record<string, string>
  sessionOverrides: Record<string, {
    titleOverride?: string
    descriptionOverride?: string
    deleted?: boolean
  }>
}

const DEFAULT_CONFIG: UserConfig = {
  userName: 'User',
  theme: 'dark',
  terminalFont: 'Consolas, monospace',
  terminalFontSize: 14,
  terminalTheme: 'default',
  projectColors: {},
  sessionOverrides: {},
}

export class ConfigStore {
  private configPath: string
  private config: UserConfig = { ...DEFAULT_CONFIG }

  constructor(configDir?: string) {
    const dir = configDir || join(homedir(), '.claude-organizer')
    this.configPath = join(dir, 'config.json')
  }

  async load(): Promise<UserConfig> {
    try {
      const data = await readFile(this.configPath, 'utf-8')
      this.config = { ...DEFAULT_CONFIG, ...JSON.parse(data) }
    } catch {
      this.config = { ...DEFAULT_CONFIG }
    }
    return this.config
  }

  // Atomic write: temp file + rename (POSIX atomic, Windows needs delete first)
  async save(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true })

    const tempPath = this.configPath + '.tmp'
    const content = JSON.stringify(this.config, null, 2)

    // Write to temp file
    await writeFile(tempPath, content, { mode: 0o600 })

    // On Windows, rename fails if target exists - delete first
    if (process.platform === 'win32') {
      await unlink(this.configPath).catch(() => {})  // Ignore if doesn't exist
    }

    // Atomic rename
    await rename(tempPath, this.configPath)

    // Ensure permissions on final file (not needed on Windows)
    if (process.platform !== 'win32') {
      await chmod(this.configPath, 0o600)
    }
  }

  get(): UserConfig {
    return this.config
  }

  async update(updates: Partial<UserConfig>): Promise<UserConfig> {
    this.config = { ...this.config, ...updates }
    await this.save()
    return this.config
  }

  async setProjectColor(projectPath: string, color: string): Promise<void> {
    this.config.projectColors[projectPath] = color
    await this.save()
  }

  async setSessionOverride(
    sessionId: string,
    overrides: UserConfig['sessionOverrides'][string]
  ): Promise<void> {
    this.config.sessionOverrides[sessionId] = {
      ...this.config.sessionOverrides[sessionId],
      ...overrides,
    }
    await this.save()
  }

  getProjectColor(projectPath: string): string | undefined {
    return this.config.projectColors[projectPath]
  }

  // Generate random color for new project
  generateProjectColor(): string {
    const colors = [
      '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16',
      '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9',
      '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
      '#ec4899', '#f43f5e',
    ]
    return colors[Math.floor(Math.random() * colors.length)]
  }
}
```

**Step 2: Write config store tests**

Create `server/__tests__/config-store.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ConfigStore } from '../config-store'

describe('ConfigStore', () => {
  const testDir = join(tmpdir(), 'config-test-' + process.pid)
  let store: ConfigStore

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
    store = new ConfigStore(testDir)
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  it('loads default config when file does not exist', async () => {
    const config = await store.load()
    expect(config.userName).toBe('User')
    expect(config.theme).toBe('dark')
  })

  it('saves and loads config', async () => {
    await store.load()
    await store.update({ userName: 'Test User' })

    const newStore = new ConfigStore(testDir)
    const config = await newStore.load()

    expect(config.userName).toBe('Test User')
  })

  it('sets project colors', async () => {
    await store.load()
    await store.setProjectColor('/test/project', '#ff0000')

    expect(store.getProjectColor('/test/project')).toBe('#ff0000')
  })

  it('generates random colors', () => {
    const color = store.generateProjectColor()
    expect(color).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
```

**Step 3: Run tests**
```bash
npm run test:server -- --run server/__tests__/config-store.test.ts
```

**Step 4: Commit**
```bash
git add -A && git commit -m "feat: add server-side config store"
```

---

### Task 4.2: Add Settings API Endpoints

**Files:**
- Modify: `server/index.ts`

**Step 1: Add settings endpoints**

Add to `server/index.ts`:
```typescript
import { ConfigStore } from './config-store'

const configStore = new ConfigStore()
configStore.load().catch(console.error)

// Settings endpoints
app.get('/api/settings', (_req, res) => {
  res.json(configStore.get())
})

app.put('/api/settings', requireAuth, async (req, res) => {
  try {
    const config = await configStore.update(req.body)
    // Broadcast to authenticated clients only (via ws-handler)
    wsHandler.broadcast('settings.updated', { settings: config })
    res.json(config)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// Use body instead of path param - paths with slashes don't work in route params
app.put('/api/project-colors', requireAuth, async (req, res) => {
  try {
    const { projectPath, color } = req.body
    if (!projectPath || !color) {
      return res.status(400).json({ error: 'projectPath and color required' })
    }
    await configStore.setProjectColor(projectPath, color)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

**Step 2: Commit**
```bash
git add -A && git commit -m "feat: add settings API endpoints"
```

---

### Task 4.3: Create Settings View

**Files:**
- Create: `src/components/SettingsView.tsx`
- Create: `src/store/settingsSlice.ts`
- Add shadcn components

**Step 1: Add shadcn components**
```bash
npx shadcn@latest add select slider switch label input separator
```

**Step 2: Create settings slice**

Create `src/store/settingsSlice.ts`:
```typescript
import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit'

export interface Settings {
  userName: string
  theme: 'light' | 'dark'
  terminalFont: string
  terminalFontSize: number
  terminalTheme: string
  projectColors: Record<string, string>
}

interface SettingsState extends Settings {
  loading: boolean
}

const initialState: SettingsState = {
  userName: 'User',
  theme: 'dark',
  terminalFont: 'Consolas, monospace',
  terminalFontSize: 14,
  terminalTheme: 'default',
  projectColors: {},
  loading: false,
}

import { api } from '../lib/api'

export const fetchSettings = createAsyncThunk('settings/fetch', async () => {
  const res = await api.get('/api/settings')
  return res.json()
})

export const updateSettings = createAsyncThunk(
  'settings/update',
  async (updates: Partial<Settings>) => {
    const res = await api.put('/api/settings', updates)
    return res.json()
  }
)

export const settingsSlice = createSlice({
  name: 'settings',
  initialState,
  reducers: {
    setSettings: (state, action: PayloadAction<Partial<Settings>>) => {
      Object.assign(state, action.payload)
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchSettings.pending, (state) => {
        state.loading = true
      })
      .addCase(fetchSettings.fulfilled, (state, action) => {
        state.loading = false
        Object.assign(state, action.payload)
      })
      .addCase(updateSettings.fulfilled, (state, action) => {
        Object.assign(state, action.payload)
      })
  },
})

export const { setSettings } = settingsSlice.actions
export default settingsSlice.reducer
```

**Step 3: Create SettingsView**

Create `src/components/SettingsView.tsx`:
```typescript
import { useEffect } from 'react'
import { useAppSelector, useAppDispatch } from '../store/hooks'
import { fetchSettings, updateSettings, setSettings } from '../store/settingsSlice'
import { getWsClient } from '../lib/ws-client'
import { Label } from './ui/label'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Slider } from './ui/slider'
import { Switch } from './ui/switch'
import { Separator } from './ui/separator'
import { ScrollArea } from './ui/scroll-area'

const TERMINAL_FONTS = [
  'Consolas, monospace',
  'Monaco, monospace',
  'Fira Code, monospace',
  'JetBrains Mono, monospace',
  'Source Code Pro, monospace',
]

const TERMINAL_THEMES = [
  { value: 'default', label: 'Default Dark' },
  { value: 'light', label: 'Light' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'monokai', label: 'Monokai' },
  { value: 'nord', label: 'Nord' },
]

export function SettingsView() {
  const dispatch = useAppDispatch()
  const settings = useAppSelector(state => state.settings)

  useEffect(() => {
    dispatch(fetchSettings())

    const unsubscribe = getWsClient().onMessage((msg: any) => {
      if (msg.type === 'settings.updated') {
        dispatch(setSettings(msg.settings))
      }
    })

    return unsubscribe
  }, [dispatch])

  const handleUpdate = (updates: Partial<typeof settings>) => {
    dispatch(updateSettings(updates))
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-6 max-w-2xl mx-auto space-y-8">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Settings</h2>
          <p className="text-gray-400">Configure your Claude Organizer experience</p>
        </div>

        <Separator />

        {/* User */}
        <section className="space-y-4">
          <h3 className="text-lg font-medium">User</h3>

          <div className="space-y-2">
            <Label htmlFor="userName">Display Name</Label>
            <Input
              id="userName"
              value={settings.userName}
              onChange={(e) => handleUpdate({ userName: e.target.value })}
            />
          </div>
        </section>

        <Separator />

        {/* Appearance */}
        <section className="space-y-4">
          <h3 className="text-lg font-medium">Appearance</h3>

          <div className="flex items-center justify-between">
            <div>
              <Label>Dark Mode</Label>
              <p className="text-sm text-gray-400">Use dark theme</p>
            </div>
            <Switch
              checked={settings.theme === 'dark'}
              onCheckedChange={(checked) =>
                handleUpdate({ theme: checked ? 'dark' : 'light' })
              }
            />
          </div>
        </section>

        <Separator />

        {/* Terminal */}
        <section className="space-y-4">
          <h3 className="text-lg font-medium">Terminal</h3>

          <div className="space-y-2">
            <Label>Font Family</Label>
            <Select
              value={settings.terminalFont}
              onValueChange={(value) => handleUpdate({ terminalFont: value })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TERMINAL_FONTS.map((font) => (
                  <SelectItem key={font} value={font}>
                    <span style={{ fontFamily: font }}>{font.split(',')[0]}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Font Size: {settings.terminalFontSize}px</Label>
            <Slider
              value={[settings.terminalFontSize]}
              onValueChange={([value]) => handleUpdate({ terminalFontSize: value })}
              min={10}
              max={24}
              step={1}
            />
          </div>

          <div className="space-y-2">
            <Label>Color Theme</Label>
            <Select
              value={settings.terminalTheme}
              onValueChange={(value) => handleUpdate({ terminalTheme: value })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TERMINAL_THEMES.map((theme) => (
                  <SelectItem key={theme.value} value={theme.value}>
                    {theme.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </section>
      </div>
    </ScrollArea>
  )
}
```

**Step 4: Update store to include settings**

Modify `src/store/index.ts`:
```typescript
import settingsReducer from './settingsSlice'

export const store = configureStore({
  reducer: {
    tabs: tabsReducer,
    connection: connectionReducer,
    sessions: sessionsReducer,
    settings: settingsReducer,
  },
  // ...
})
```

**Step 5: Update AppLayout to render SettingsView**

In `src/components/AppLayout.tsx`, replace the settings placeholder:
```typescript
import { SettingsView } from './SettingsView'

// ...

{activeView === 'settings' && <SettingsView />}
```

**Step 6: Commit**
```bash
git add -A && git commit -m "feat: add Settings view with server-side persistence"
```

---

### Task 4.4: Apply Theme and Terminal Settings

**Files:**
- Create: `src/hooks/useTheme.ts`
- Modify: `src/components/Terminal.tsx`
- Modify: `src/App.tsx`

**Step 1: Create theme hook**

Create `src/hooks/useTheme.ts`:
```typescript
import { useEffect } from 'react'
import { useAppSelector } from '../store/hooks'

export function useTheme() {
  const theme = useAppSelector(state => state.settings.theme)

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
  }, [theme])
}
```

**Step 2: Update Terminal to use settings**

Modify Terminal component to read font settings:
```typescript
const { terminalFont, terminalFontSize, terminalTheme } = useAppSelector(state => state.settings)

// In XTerm constructor:
const term = new XTerm({
  cursorBlink: true,
  fontSize: terminalFontSize,
  fontFamily: terminalFont,
  theme: getTerminalTheme(terminalTheme),
})
```

**Step 3: Apply theme in App**
```typescript
import { useTheme } from './hooks/useTheme'

function App() {
  useTheme()
  // ...
}
```

**Step 4: Commit**
```bash
git add -A && git commit -m "feat: apply theme and terminal settings"
```

---

### Release 4 Acceptance Tests

**Automated:**
- [ ] Config store saves and loads correctly
- [ ] Settings API round-trip works

**Manual:**
- [ ] Change settings on desktop, see them on phone
- [ ] Theme toggle applies immediately
- [ ] Terminal font/size changes apply to new terminals
- [ ] Project colors persist

**Exit Criteria:**
- [ ] Settings work across devices
- [ ] Theming foundation established

---

## Release 5 — Background Sessions + Inactivity Timeout

**Purpose:** Prove terminals can run without browser connected. Avoid resource leaks via timeout.

**Exit Criteria:** Terminals survive browser close, timeout kills inactive sessions.

---

### Task 5.1: Add Inactivity Tracking to Terminal Registry

**Files:**
- Modify: `server/terminal-registry.ts`
- Create: `server/__tests__/inactivity.test.ts`

**Step 1: Add inactivity timeout to registry**

Update `server/terminal-registry.ts`:
```typescript
export class TerminalRegistry extends EventEmitter {
  private sessions = new Map<string, TerminalSession>()
  private inactivityCheckInterval: NodeJS.Timeout | null = null
  private inactivityTimeoutMs: number

  constructor(options?: { inactivityTimeoutMinutes?: number }) {
    super()
    this.inactivityTimeoutMs = (options?.inactivityTimeoutMinutes ?? 30) * 60 * 1000
  }

  startInactivityChecker(): void {
    // Check every minute
    this.inactivityCheckInterval = setInterval(() => {
      this.checkInactiveSessions()
    }, 60 * 1000)
  }

  stopInactivityChecker(): void {
    if (this.inactivityCheckInterval) {
      clearInterval(this.inactivityCheckInterval)
      this.inactivityCheckInterval = null
    }
  }

  private checkInactiveSessions(): void {
    const now = Date.now()

    for (const session of this.sessions.values()) {
      if (session.status !== 'running') continue

      // Only timeout if no clients attached
      if (session.attachedClients.size > 0) continue

      const inactiveMs = now - session.lastActivityAt.getTime()
      if (inactiveMs > this.inactivityTimeoutMs) {
        console.log(`Killing inactive session ${session.terminalId} (inactive for ${Math.round(inactiveMs / 60000)}m)`)
        this.kill(session.terminalId)
      }
    }
  }

  // ... rest of existing code
}
```

**Step 2: Write inactivity tests**

Create `server/__tests__/inactivity.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TerminalRegistry } from '../terminal-registry'

describe('Inactivity Timeout', () => {
  let registry: TerminalRegistry

  beforeEach(() => {
    vi.useFakeTimers()
    // 1 minute timeout for testing
    registry = new TerminalRegistry({ inactivityTimeoutMinutes: 1 })
  })

  afterEach(() => {
    registry.stopInactivityChecker()
    vi.useRealTimers()
  })

  it('does not kill session with attached client', async () => {
    const session = await registry.create({
      shell: 'cmd',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })
    registry.attach(session.terminalId, 'client1')
    registry.startInactivityChecker()

    // Advance time past timeout
    vi.advanceTimersByTime(2 * 60 * 1000)

    expect(registry.get(session.terminalId)?.status).toBe('running')
  })

  it('kills session after inactivity timeout with no clients', async () => {
    const session = await registry.create({
      shell: 'cmd',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    })
    // No client attached
    registry.startInactivityChecker()

    // Advance time past timeout
    vi.advanceTimersByTime(2 * 60 * 1000)

    expect(registry.get(session.terminalId)?.status).toBe('killed')
  })
})
```

**Step 3: Update server to start checker**

In `server/index.ts`:
```typescript
const IDLE_TIMEOUT_MINUTES = parseInt(process.env.IDLE_TIMEOUT_MINUTES || '30', 10)
const registry = new TerminalRegistry({ inactivityTimeoutMinutes: IDLE_TIMEOUT_MINUTES })
registry.startInactivityChecker()
```

**Step 4: Commit**
```bash
git add -A && git commit -m "feat: add inactivity timeout for background sessions"
```

---

### Task 5.2: Add Background Sessions UI

**Files:**
- Create: `src/components/BackgroundSessions.tsx`
- Modify: `src/components/TabBar.tsx`

**Step 1: Create BackgroundSessions component**

Create `src/components/BackgroundSessions.tsx`:
```typescript
import { useEffect, useState } from 'react'
import { getWsClient } from '../lib/ws-client'
import { useAppDispatch } from '../store/hooks'
import { addTab } from '../store/tabsSlice'
import { Button } from './ui/button'
import { Card } from './ui/card'
import { Play, X } from 'lucide-react'
import { nanoid } from 'nanoid'

interface BackgroundTerminal {
  terminalId: string
  shell: string
  cwd: string
  status: string
  createdAt: string
  attachedCount: number
}

export function BackgroundSessions() {
  const [terminals, setTerminals] = useState<BackgroundTerminal[]>([])
  const dispatch = useAppDispatch()

  useEffect(() => {
    const wsClient = getWsClient()

    // Request terminal list
    wsClient.send({ type: 'terminal.list' })

    const unsubscribe = wsClient.onMessage((msg: any) => {
      if (msg.type === 'terminal.list') {
        // Filter to show only detached AND running terminals
        // Exclude killed/exited sessions - they can't be reattached
        setTerminals(msg.terminals.filter((t: BackgroundTerminal) =>
          t.attachedCount === 0 && t.status === 'running'
        ))
      }
    })

    // Refresh periodically
    const interval = setInterval(() => {
      wsClient.send({ type: 'terminal.list' })
    }, 5000)

    return () => {
      unsubscribe()
      clearInterval(interval)
    }
  }, [])

  const handleAttach = (terminal: BackgroundTerminal) => {
    const id = nanoid()
    dispatch(addTab({
      id,
      terminalId: terminal.terminalId,
      title: terminal.cwd.split(/[/\\]/).pop() || 'Terminal',
      shell: terminal.shell as 'cmd' | 'powershell' | 'wsl',
      cwd: terminal.cwd,
      status: 'running',
    }))
  }

  const handleKill = (terminalId: string) => {
    getWsClient().send({ type: 'terminal.kill', terminalId })
  }

  if (terminals.length === 0) return null

  return (
    <div className="p-2 border-b border-gray-700">
      <div className="text-xs text-gray-400 mb-2">Background Sessions</div>
      <div className="flex gap-2 flex-wrap">
        {terminals.map(terminal => (
          <Card key={terminal.terminalId} className="p-2 flex items-center gap-2 text-sm">
            <span className="truncate max-w-32">{terminal.cwd.split(/[/\\]/).pop()}</span>
            <Button size="sm" variant="ghost" onClick={() => handleAttach(terminal)}>
              <Play className="w-3 h-3" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => handleKill(terminal.terminalId)}>
              <X className="w-3 h-3" />
            </Button>
          </Card>
        ))}
      </div>
    </div>
  )
}
```

**Step 2: Add to AppLayout above TabBar**
```typescript
import { BackgroundSessions } from './BackgroundSessions'

// In render:
{activeView === 'terminals' && (
  <>
    <BackgroundSessions />
    <TabBar onNewTab={handleNewTab} />
    {/* ... */}
  </>
)}
```

**Step 3: Commit**
```bash
git add -A && git commit -m "feat: add background sessions UI"
```

---

### Release 5 Acceptance Tests

**Automated:**
- [ ] Session survives client disconnect
- [ ] Inactive session killed after timeout
- [ ] Session with client attached not killed

**Manual:**
- [ ] Close browser, terminal keeps running
- [ ] Reopen browser, see background session
- [ ] Reattach to background session
- [ ] After idle timeout, session auto-killed

**Exit Criteria:**
- [ ] Background sessions work reliably
- [ ] Inactivity cleanup prevents resource leaks

---

## Release 6 — Overview Page with Manual Renaming

**Purpose:** Provide Overview UX without auto AI generation on visit.

**Exit Criteria:** Overview shows sessions, manual rename works, Regenerate button present.

---

### Task 6.1: Create Overview Page

**Files:**
- Create: `src/components/OverviewView.tsx`
- Create: `src/components/OverviewCard.tsx`

**Step 1: Create OverviewCard component**

Create `src/components/OverviewCard.tsx`:
```typescript
import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { Button } from './ui/button'
import { Edit2, Check, X, RefreshCw } from 'lucide-react'

interface OverviewCardProps {
  terminalId: string
  title: string
  description?: string
  shell: string
  cwd: string
  projectColor?: string
  isRegenerating?: boolean
  onRename: (title: string, description: string) => void
  onRegenerateDescription: () => void
}

export function OverviewCard({
  title,
  description,
  shell,
  cwd,
  projectColor,
  isRegenerating,
  onRename,
  onRegenerateDescription,
}: OverviewCardProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(title)
  const [editDescription, setEditDescription] = useState(description || '')

  const handleSave = () => {
    onRename(editTitle, editDescription)
    setIsEditing(false)
  }

  const handleCancel = () => {
    setEditTitle(title)
    setEditDescription(description || '')
    setIsEditing(false)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start gap-3">
          {projectColor && (
            <div
              className="w-3 h-3 rounded-full mt-1.5 flex-shrink-0"
              style={{ backgroundColor: projectColor }}
            />
          )}
          <div className="flex-1">
            {isEditing ? (
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="font-semibold"
              />
            ) : (
              <CardTitle className="text-lg">{title}</CardTitle>
            )}
            <div className="text-sm text-gray-400 mt-1">
              {shell} • {cwd}
            </div>
          </div>
          <div className="flex gap-1">
            {isEditing ? (
              <>
                <Button size="sm" variant="ghost" onClick={handleSave}>
                  <Check className="w-4 h-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={handleCancel}>
                  <X className="w-4 h-4" />
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="ghost" onClick={() => setIsEditing(true)}>
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onRegenerateDescription}
                  disabled={isRegenerating}
                >
                  <RefreshCw className={`w-4 h-4 ${isRegenerating ? 'animate-spin' : ''}`} />
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isEditing ? (
          <Textarea
            value={editDescription}
            onChange={(e) => setEditDescription(e.target.value)}
            placeholder="Add a description..."
            rows={3}
          />
        ) : (
          <p className="text-sm text-gray-300">
            {description || 'No description. Click edit or regenerate to add one.'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
```

**Step 2: Add textarea to shadcn**
```bash
npx shadcn@latest add textarea
```

**Step 3: Create OverviewView**

Create `src/components/OverviewView.tsx`:
```typescript
import { useAppSelector } from '../store/hooks'
import { ScrollArea } from './ui/scroll-area'
import { OverviewCard } from './OverviewCard'

export function OverviewView() {
  const { tabs } = useAppSelector(state => state.tabs)
  const { projectColors } = useAppSelector(state => state.settings)

  const handleRename = (tabId: string, title: string, description: string) => {
    // TODO: Save to server via API
    console.log('Rename:', tabId, title, description)
  }

  const handleRegenerateDescription = (tabId: string) => {
    // TODO: Call AI endpoint (Release 7)
    console.log('Regenerate description for:', tabId)
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-6">
        <div className="mb-6">
          <h2 className="text-2xl font-semibold">Overview</h2>
          <p className="text-gray-400 mt-1">
            View and manage your open terminals
          </p>
        </div>

        {tabs.length === 0 ? (
          <div className="text-center text-gray-400 py-12">
            No open terminals. Create one with Ctrl-B C
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {tabs.map(tab => (
              <OverviewCard
                key={tab.id}
                terminalId={tab.terminalId || ''}
                title={tab.title}
                description={undefined} // Will come from overrides later
                shell={tab.shell}
                cwd={tab.cwd}
                projectColor={projectColors[tab.cwd]}
                onRename={(title, description) => handleRename(tab.id, title, description)}
                onRegenerateDescription={() => handleRegenerateDescription(tab.id)}
              />
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  )
}
```

**Step 4: Update AppLayout**
```typescript
import { OverviewView } from './OverviewView'

// Replace placeholder:
{activeView === 'overview' && <OverviewView />}
```

**Step 5: Commit**
```bash
git add -A && git commit -m "feat: add Overview page with manual renaming"
```

---

### Release 6 Acceptance Tests

**Manual:**
- [ ] Overview loads without triggering AI
- [ ] Can edit name and description inline
- [ ] Regenerate button present (no-op until Release 7)
- [ ] Changes persist across reload

**Exit Criteria:**
- [ ] Overview is stable control panel
- [ ] No AI auto-trigger on navigation

---

## Release 7 — AI Features (Description Generation + Auto-rename)

**Purpose:** Add AI integration as opt-in, controlled feature.

**Exit Criteria:** AI endpoints work, auto-rename is opt-in, caching prevents redundant calls.

---

### Task 7.1: Add AI Description Endpoint

**Files:**
- Create: `server/ai-service.ts`
- Modify: `server/index.ts`

**Step 1: Install AI SDK**
```bash
npm install ai @ai-sdk/google
```

**Step 2: Create AI service**

Create `server/ai-service.ts`:
```typescript
import { generateText } from 'ai'
import { google } from '@ai-sdk/google'

// Simple in-memory cache
const descriptionCache = new Map<string, { description: string; timestamp: number }>()
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

export async function generateDescription(
  context: {
    projectPath: string
    projectName: string
    recentCommands?: string[]
  }
): Promise<string> {
  const cacheKey = `${context.projectPath}:${context.recentCommands?.join(',') || ''}`

  // Check cache
  const cached = descriptionCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.description
  }

  const prompt = `Generate a brief (1-2 sentence) description for a terminal session in the project "${context.projectName}" located at "${context.projectPath}".${
    context.recentCommands?.length
      ? ` Recent commands: ${context.recentCommands.slice(-5).join(', ')}`
      : ''
  } Keep it concise and technical.`

  try {
    const { text } = await generateText({
      model: google('gemini-1.5-flash'),
      prompt,
    })

    // Cache result
    descriptionCache.set(cacheKey, { description: text, timestamp: Date.now() })

    return text
  } catch (err) {
    console.error('AI description generation failed:', err)
    throw err
  }
}

export async function generateAutoRename(
  context: {
    projectPath: string
    projectName: string
    currentTitle: string
    recentCommands?: string[]
  }
): Promise<{ title: string; description: string }> {
  const prompt = `Based on this terminal session context, suggest a short title (2-4 words) and brief description (1 sentence):
Project: ${context.projectName}
Path: ${context.projectPath}
Current title: ${context.currentTitle}
${context.recentCommands?.length ? `Recent commands: ${context.recentCommands.slice(-5).join(', ')}` : ''}

Respond in JSON format: {"title": "...", "description": "..."}`

  const { text } = await generateText({
    model: google('gemini-1.5-flash'),
    prompt,
  })

  try {
    return JSON.parse(text)
  } catch {
    // Fallback if JSON parsing fails
    return {
      title: context.currentTitle,
      description: text,
    }
  }
}
```

**Step 3: Add AI endpoints to server**

Add to `server/index.ts`:
```typescript
import { generateDescription, generateAutoRename } from './ai-service'

app.post('/api/ai/describe', async (req, res) => {
  try {
    const { projectPath, projectName, recentCommands } = req.body
    const description = await generateDescription({ projectPath, projectName, recentCommands })
    res.json({ description })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

app.post('/api/ai/auto-rename', async (req, res) => {
  try {
    const { projectPath, projectName, currentTitle, recentCommands } = req.body
    const result = await generateAutoRename({ projectPath, projectName, currentTitle, recentCommands })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

**Step 4: Commit**
```bash
git add -A && git commit -m "feat: add AI description and auto-rename endpoints"
```

---

### Task 7.2: Connect Overview to AI Endpoints

**Files:**
- Modify: `src/components/OverviewView.tsx`
- Modify: `src/components/OverviewCard.tsx`

**Step 1: Add regenerate functionality**

Update `OverviewView.tsx`:
```typescript
import { Tab } from '../store/tabsSlice'
import { api } from '../lib/api'

// Add state for regenerating
const [regenerating, setRegenerating] = useState<Set<string>>(new Set())

const handleRegenerateDescription = async (tabId: string, tab: Tab) => {
  setRegenerating(prev => new Set(prev).add(tabId))

  try {
    const res = await api.post('/api/ai/describe', {
      projectPath: tab.cwd,
      projectName: tab.cwd.split(/[/\\]/).pop(),
    })
    const { description } = await res.json()
    // Update tab description via Redux/API
    console.log('Generated description:', description)
  } catch (err) {
    console.error('Failed to generate description:', err)
  } finally {
    setRegenerating(prev => {
      const next = new Set(prev)
      next.delete(tabId)
      return next
    })
  }
}
```

**Step 2: Pass loading state to OverviewCard**
```typescript
<OverviewCard
  // ...
  isRegenerating={regenerating.has(tab.id)}
/>
```

**Step 3: Commit**
```bash
git add -A && git commit -m "feat: connect Overview to AI description endpoint"
```

---

### Release 7 Acceptance Tests

**Automated (with mocked AI):**
- [ ] AI endpoints return stable mocked outputs
- [ ] Cache prevents redundant calls

**Manual:**
- [ ] Regenerate updates description only
- [ ] Auto-rename (if enabled) updates both fields
- [ ] AI calls are opt-in, not automatic

**Exit Criteria:**
- [ ] AI is reliable and opt-in
- [ ] No surprises from auto-generation

---

## Release 8 — Codex CLI Support via Provider Abstraction

**Purpose:** Add second session provider without polluting core architecture.

**Exit Criteria:** Provider interface defined, Codex sessions load alongside Claude.

---

### Task 8.1: Create Provider Interface

> **Migration Note:** This task refactors the session loading to use a provider abstraction.
> The `ClaudeWatcher` from Release 3 is replaced by `ProviderManager` which wraps multiple providers.
> Update all imports of `ClaudeWatcher` to use `ProviderManager` instead.

**Files:**
- Create: `server/providers/types.ts`
- Create: `server/providers/claude-provider.ts`
- Create: `server/providers/codex-provider.ts`
- Modify: `server/index.ts` (replace ClaudeWatcher with ProviderManager)
- Delete: `server/claude-watcher.ts` (functionality moved to providers/claude-provider.ts)

**Step 1: Define provider interface**

Create `server/providers/types.ts`:
```typescript
export interface SessionInfo {
  sessionId: string
  provider: 'claude' | 'codex'
  projectPath: string
  projectName: string
  lastModified: Date
}

export interface ProjectInfo {
  projectPath: string
  projectName: string
  sessions: SessionInfo[]
}

export interface SessionProvider {
  name: 'claude' | 'codex'
  getProjects(): Promise<ProjectInfo[]>
  watchForChanges(callback: (projects: ProjectInfo[]) => void): () => void
}
```

**Step 2: Refactor Claude provider**

Create `server/providers/claude-provider.ts`:
```typescript
import { SessionProvider, ProjectInfo } from './types'
import { watch } from 'chokidar'
import { parseSessionsIndex } from '../session-parser'
import { join } from 'path'
import { homedir } from 'os'

export class ClaudeProvider implements SessionProvider {
  name = 'claude' as const
  private claudeDir: string

  constructor(claudeDir?: string) {
    this.claudeDir = claudeDir || join(homedir(), '.claude')
  }

  async getProjects(): Promise<ProjectInfo[]> {
    const projects = await parseSessionsIndex(this.claudeDir)
    return projects.map(p => ({
      ...p,
      sessions: p.sessions.map(s => ({
        ...s,
        provider: 'claude' as const,
      })),
    }))
  }

  watchForChanges(callback: (projects: ProjectInfo[]) => void): () => void {
    const projectsDir = join(this.claudeDir, 'projects')
    const watcher = watch(projectsDir, {
      ignoreInitial: true,
      depth: 2,
    })

    let debounceTimer: NodeJS.Timeout | null = null

    const refresh = async () => {
      const projects = await this.getProjects()
      callback(projects)
    }

    watcher.on('all', () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(refresh, 1000)
    })

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      watcher.close()
    }
  }
}
```

**Step 3: Create Codex provider stub**

Create `server/providers/codex-provider.ts`:
```typescript
import { SessionProvider, ProjectInfo } from './types'

export class CodexProvider implements SessionProvider {
  name = 'codex' as const

  async getProjects(): Promise<ProjectInfo[]> {
    // TODO: Implement Codex session discovery
    // Codex stores sessions differently - needs research
    return []
  }

  watchForChanges(_callback: (projects: ProjectInfo[]) => void): () => void {
    // TODO: Implement file watching for Codex
    return () => {}
  }
}
```

**Step 4: Create provider manager**

Create `server/providers/index.ts`:
```typescript
import { SessionProvider, ProjectInfo } from './types'
import { ClaudeProvider } from './claude-provider'
import { CodexProvider } from './codex-provider'

export class ProviderManager {
  private providers: SessionProvider[] = []
  private watchers: (() => void)[] = []

  constructor() {
    this.providers = [
      new ClaudeProvider(),
      new CodexProvider(),
    ]
  }

  async getAllProjects(): Promise<ProjectInfo[]> {
    const results = await Promise.all(
      this.providers.map(p => p.getProjects())
    )
    return results.flat().sort((a, b) => {
      const aLatest = Math.max(...a.sessions.map(s => s.lastModified.getTime()))
      const bLatest = Math.max(...b.sessions.map(s => s.lastModified.getTime()))
      return bLatest - aLatest
    })
  }

  watchAll(callback: () => void): void {
    this.watchers = this.providers.map(p =>
      p.watchForChanges(() => callback())
    )
  }

  stopWatching(): void {
    this.watchers.forEach(stop => stop())
    this.watchers = []
  }
}

export * from './types'
```

**Step 5: Update server to use provider manager**

Replace ClaudeWatcher usage in `server/index.ts`:
```typescript
import { ProviderManager } from './providers'

const providerManager = new ProviderManager()

providerManager.watchAll(async () => {
  const projects = await providerManager.getAllProjects()
  // Use wsHandler.broadcast for authenticated-only delivery
  wsHandler.broadcast('sessions.updated', { projects })
})

app.get('/api/sessions', async (_req, res) => {
  const projects = await providerManager.getAllProjects()
  res.json({ projects })
})
```

**Step 6: Commit**
```bash
git add -A && git commit -m "feat: add provider abstraction for multi-CLI support"
```

---

### Task 8.2: Add Provider Badge to UI

**Files:**
- Modify: `src/components/SessionCard.tsx`

**Step 1: Add provider badge**

Update `SessionCard.tsx`:
```typescript
import { Badge } from './ui/badge'

// Add to props:
provider: 'claude' | 'codex'

// In render, after session ID:
<Badge variant={provider === 'claude' ? 'default' : 'secondary'}>
  {provider}
</Badge>
```

**Step 2: Commit**
```bash
git add -A && git commit -m "feat: add provider badge to session cards"
```

---

### Release 8 Acceptance Tests

**Automated:**
- [ ] Provider interface tests with fixtures
- [ ] Both providers load without errors

**Manual:**
- [ ] Claude sessions appear with "claude" badge
- [ ] Codex sessions (when implemented) appear with "codex" badge
- [ ] No regressions to core terminal functionality

**Exit Criteria:**
- [ ] Provider abstraction clean
- [ ] Multiple CLIs supported without architectural changes

---

## Summary

This plan is organized into **8 releases**:

1. **Release 1**: Remote-capable PTY + WSL + Correct Attach/Reattach (foundation)
2. **Release 2**: Multi-Tab UI + Ctrl-B Shortcuts + Production Build
3. **Release 3**: Claude Session Ingestion + History UX
4. **Release 4**: Persistent User Settings + Appearance + Project Colors
5. **Release 5**: Background Sessions + Inactivity Timeout
6. **Release 6**: Overview Page with Manual Renaming
7. **Release 7**: AI Features (Description Generation + Auto-rename)
8. **Release 8**: Codex CLI Support via Provider Abstraction

Each release:
- Proves specific technical risks early
- Produces a working, testable increment
- Has clear acceptance tests and exit criteria
- Follows test-as-you-build with minimal mocking

---

## Test Commands Reference

```bash
# Run all frontend tests
npm test

# Run all server/integration tests
npm run test:server

# Run specific test file
npm test -- --run src/store/__tests__/tabsSlice.test.ts

# Run with coverage
npm run test:coverage

# Run browser E2E (Python)
cd test/browser && pytest
```

---

## Appendix: Browser E2E Testing with browser-use

This setup enables AI-powered browser testing for critical user flows.

### Setup

**Files:**
- Create: `test/browser/pyproject.toml`
- Create: `test/browser/conftest.py`
- Create: `test/browser/test_critical_flows.py`

**Step 1: Create Python project config**

Create `test/browser/pyproject.toml`:
```toml
[project]
name = "claude-organizer-e2e"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "browser-use>=0.1.0",
    "pytest>=8.0.0",
    "pytest-asyncio>=0.23.0",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"
```

**Step 2: Create test fixtures**

Create `test/browser/conftest.py`:
```python
import pytest
import asyncio
import subprocess
import time
import os

@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()

@pytest.fixture(scope="session")
async def app_servers():
    """Start the app servers for testing."""
    # Start backend
    backend = subprocess.Popen(
        ["npm", "run", "start"],
        cwd=os.path.join(os.path.dirname(__file__), "../.."),
        env={**os.environ, "PORT": "3099", "HOST": "127.0.0.1"},
    )

    # Wait for server to start
    time.sleep(3)

    yield {
        "backend_url": "http://127.0.0.1:3099",
        "frontend_url": "http://127.0.0.1:3099",
    }

    # Cleanup
    backend.terminate()
    backend.wait()
```

**Step 3: Create critical flow tests**

Create `test/browser/test_critical_flows.py`:
```python
import pytest
from browser_use import Agent, Browser
from langchain_google_genai import ChatGoogleGenerativeAI

@pytest.fixture
def llm():
    return ChatGoogleGenerativeAI(model="gemini-1.5-flash")

@pytest.fixture
async def browser():
    browser = Browser(headless=True)
    yield browser
    await browser.close()

@pytest.mark.asyncio
async def test_create_terminal(app_servers, browser, llm):
    """Test creating a new terminal tab."""
    agent = Agent(
        task=f"""
        1. Go to {app_servers['frontend_url']}
        2. Wait for the page to load completely
        3. Press Ctrl+B then C to create a new terminal
        4. Verify a terminal appears with a command prompt
        5. Report SUCCESS if terminal is visible, FAILURE otherwise
        """,
        llm=llm,
        browser=browser,
    )
    result = await agent.run()
    assert "SUCCESS" in str(result)

@pytest.mark.asyncio
async def test_terminal_input_output(app_servers, browser, llm):
    """Test typing in terminal and seeing output."""
    agent = Agent(
        task=f"""
        1. Go to {app_servers['frontend_url']}
        2. Create a new terminal (Ctrl+B then C)
        3. Type 'echo hello' and press Enter
        4. Verify 'hello' appears in the terminal output
        5. Report SUCCESS if output contains 'hello', FAILURE otherwise
        """,
        llm=llm,
        browser=browser,
    )
    result = await agent.run()
    assert "SUCCESS" in str(result)

@pytest.mark.asyncio
async def test_tab_switching(app_servers, browser, llm):
    """Test creating multiple tabs and switching between them."""
    agent = Agent(
        task=f"""
        1. Go to {app_servers['frontend_url']}
        2. Create first terminal (Ctrl+B then C)
        3. Create second terminal (Ctrl+B then C)
        4. Switch to first tab (Ctrl+B then P or click on it)
        5. Verify first terminal is now active
        6. Report SUCCESS if switching worked, FAILURE otherwise
        """,
        llm=llm,
        browser=browser,
    )
    result = await agent.run()
    assert "SUCCESS" in str(result)
```

**Step 4: Run browser E2E tests**
```bash
cd test/browser
pip install -e .
pytest -v
```

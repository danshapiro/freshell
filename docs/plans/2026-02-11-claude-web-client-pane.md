# Claude Web Client Pane Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Claude Code (Web)" pane type to Freshell that provides a rich chat-style UI for Claude Code sessions — markdown-rendered messages, visual permission approval, tool call visualization, and streaming — as an alternative to the existing terminal/TUI mode.

**Architecture:** Instead of spawning Claude Code as a PTY and rendering it in xterm.js (current approach), the web client spawns Claude Code in "SDK mode" using `--sdk-url`, `--output-format stream-json`, `--input-format stream-json`. Claude Code connects back to a WebSocket bridge on the server, sending structured NDJSON messages. The server routes these to browser clients via Freshell's existing WS protocol, and the client renders them as a rich chat UI in a new pane content type. This approach is inspired by [The Vibe Company's Companion](https://github.com/The-Vibe-Company/companion), adapting its SDK bridge and chat UI concepts into Freshell's pane/tab architecture.

**Why a separate SdkBridge instead of extending CodingCliSessionManager?** The existing `CodingCliSessionManager` + `codingcli.*` protocol spawns Claude Code as a PTY, pipes raw terminal bytes through xterm.js, and supports generic coding CLI providers (Claude, Codex, etc.). The SDK bridge is fundamentally different: it uses structured JSON messages over WebSocket (not a PTY), requires bidirectional message routing (permission requests/responses, interrupts), and maintains rich session state (message history, streaming deltas, cost tracking) that the terminal model has no concept of. Attempting to shoehorn this into the PTY-based provider interface would compromise both systems. The two systems coexist cleanly: terminal-mode Claude (`codingcli.*`) for the TUI experience, SDK-mode Claude (`sdk.*`) for the rich web chat experience. Session indexing is shared — both appear in the sidebar via the existing `claude-indexer` which watches `~/.claude/projects/`.

**Undocumented SDK protocol risk:** Claude Code's `--sdk-url` flag and NDJSON protocol are not officially documented and were reverse-engineered by the companion project. Mitigation: (1) keep all protocol types in a single file (`sdk-bridge-types.ts`) with Zod schemas — invalid messages are logged and skipped rather than crashing, (2) pin the minimum Claude Code version in package.json's `engines` or a runtime check, (3) if the protocol changes, only `sdk-bridge-types.ts` and `sdk-bridge.ts` need updating.
**Tech Stack:** React 18, Redux Toolkit, Zod (message schemas), ws (SDK bridge), react-markdown + remark-gfm (message rendering), Tailwind CSS + shadcn/ui (styling), Vitest (testing)

---

## Companion Feature Mapping

Before diving into tasks, here's the analysis of what companion features are appropriate for Freshell vs. what is specific to companion's own window-hosting model:

### Port to Freshell (rich UI that's not a TUI)

| Companion Feature | Freshell Adaptation |
|---|---|
| **SDK bridge** (`ws-bridge.ts`) — spawns headless Claude Code with `--sdk-url`, routes NDJSON ↔ browser JSON | New `SdkBridge` class in `server/sdk-bridge.ts`, integrated as new WS message types (`sdk.*`) |
| **CLI launcher** (`cli-launcher.ts`) — spawns `claude --sdk-url ws://... --output-format stream-json -p ""` | Reuse approach in `SdkBridge.launch()`, NOT a separate PTY — direct child_process spawn |
| **Chat message feed** (`MessageFeed.tsx`) — markdown messages, tool blocks, thinking blocks, streaming | New `ClaudeChatView` pane component with `MessageFeed`, `MessageBubble` sub-components |
| **Permission approval UI** (`PermissionBanner.tsx`) — allow/deny buttons, tool input preview | New `PermissionBanner` component with tool-specific renderers |
| **Tool call visualization** (`ToolBlock.tsx`) — collapsible cards for Bash, Edit, Write, Read, etc. | New `ToolBlock` component with progressive disclosure |
| **Composer** (`Composer.tsx`) — text input with auto-resize, slash commands, Enter to send | New `ChatComposer` component adapted for Freshell's pane model |
| **Streaming accumulation** (store + ws handler) — token-by-token text deltas | New Redux slice fields + WS message handlers |
| **Message history replay** (ws-bridge reconnect) — replays history on browser reconnect | Server stores message history per SDK session, replays on attach |
| **Interrupt** — cancel in-flight requests | `sdk.interrupt` WS message type |
| **Thinking blocks** — collapsible reasoning display | Rendered as collapsible sections in `MessageBubble` |

### NOT porting (companion's window-hosting / already in Freshell)

| Companion Feature | Why Not |
|---|---|
| Standalone sidebar with session list | Freshell already has a sidebar with session management |
| Homepage / landing page | Freshell has its own shell/tab UI |
| File browser + CodeMirror editor | Freshell has editor panes (Monaco) |
| Environment variable manager | Not needed — Freshell uses config.json |
| Git worktree management UI | Freshell manages worktrees differently |
| Usage limits display | Future enhancement — not core to chat UI |
| Auto-namer service | Freshell auto-associates sessions via claude-indexer |
| Codex adapter | Freshell already supports Codex in terminal mode; SDK mode for Codex is a separate future task |
| Session disk persistence (`~/.companion/sessions/`) | Freshell uses its own persistence model (localStorage + config.json) |
| Task panel (TodoWrite extraction) | Future enhancement — could be added as a companion pane |

---

## Phase 1: Server — SDK Bridge & Protocol Types

### Task 1: Define SDK Protocol Types

Define the NDJSON message types that Claude Code sends/receives in SDK mode, and the corresponding WS messages for browser clients.

**Files:**
- Create: `server/sdk-bridge-types.ts`
- Test: `test/unit/server/sdk-bridge-types.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/server/sdk-bridge-types.test.ts
import { describe, it, expect } from 'vitest'
import {
  CliMessageSchema,
  BrowserSdkMessageSchema,
  SdkSessionState,
  ContentBlock,
} from '../../../server/sdk-bridge-types.js'

describe('SDK Protocol Types', () => {
  describe('CliMessageSchema', () => {
    it('validates system/init message', () => {
      const msg = {
        type: 'system',
        subtype: 'init',
        session_id: 'abc-123',
        tools: [{ name: 'Bash' }],
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/home/user/project',
      }
      const result = CliMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('validates assistant message with content blocks', () => {
      const msg = {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Hello world' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
          ],
          model: 'claude-sonnet-4-5-20250929',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      }
      const result = CliMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('validates result message', () => {
      const msg = {
        type: 'result',
        result: 'success',
        duration_ms: 5000,
        cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 50 },
      }
      const result = CliMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('validates stream_event message', () => {
      const msg = {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hello' },
        },
      }
      const result = CliMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('validates control_request (permission) message', () => {
      const msg = {
        type: 'control_request',
        id: 'req-1',
        subtype: 'can_use_tool',
        tool: { name: 'Bash', input: { command: 'rm -rf /' } },
      }
      const result = CliMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('rejects unknown type', () => {
      const result = CliMessageSchema.safeParse({ type: 'bogus' })
      expect(result.success).toBe(false)
    })
  })

  describe('BrowserSdkMessageSchema', () => {
    it('validates sdk.create message', () => {
      const msg = {
        type: 'sdk.create',
        requestId: 'req-1',
        cwd: '/home/user/project',
        resumeSessionId: 'session-abc',
      }
      const result = BrowserSdkMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('validates sdk.send message', () => {
      const msg = {
        type: 'sdk.send',
        sessionId: 'sess-1',
        text: 'Write a hello world function',
      }
      const result = BrowserSdkMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('validates sdk.permission.respond message', () => {
      const msg = {
        type: 'sdk.permission.respond',
        sessionId: 'sess-1',
        requestId: 'perm-1',
        behavior: 'allow',
      }
      const result = BrowserSdkMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })

    it('validates sdk.interrupt message', () => {
      const msg = {
        type: 'sdk.interrupt',
        sessionId: 'sess-1',
      }
      const result = BrowserSdkMessageSchema.safeParse(msg)
      expect(result.success).toBe(true)
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/sdk-bridge-types.test.ts`
Expected: FAIL — module not found

**Step 3: Write the types implementation**

```typescript
// server/sdk-bridge-types.ts
import { z } from 'zod'

// ── Content blocks (from Claude Code NDJSON) ──

export const TextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

export const ThinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
})

export const ToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
})

export const ToolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]).optional(),
  is_error: z.boolean().optional(),
})

export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextBlockSchema,
  ThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
])

export type ContentBlock = z.infer<typeof ContentBlockSchema>

// ── Token usage ──

export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
}).passthrough()

// ── CLI → Server NDJSON messages ──
<<<<<<< HEAD

const CliSystemInitSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
=======
// Note: system messages share `type: 'system'` and are distinguished by `subtype`.
// We use a single schema with z.union() for the subtype-specific fields,
// since z.discriminatedUnion() requires unique discriminator values per variant.

const CliSystemSchema = z.object({
  type: z.literal('system'),
  subtype: z.string(),
>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)
  session_id: z.string().optional(),
  tools: z.array(z.object({ name: z.string() }).passthrough()).optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  permission_mode: z.string().optional(),
  mcp_servers: z.array(z.unknown()).optional(),
}).passthrough()

<<<<<<< HEAD
const CliSystemStatusSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('status'),
}).passthrough()

=======
>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)
const CliAssistantSchema = z.object({
  type: z.literal('assistant'),
  message: z.object({
    content: z.array(ContentBlockSchema),
    model: z.string().optional(),
    usage: UsageSchema.optional(),
    stop_reason: z.string().optional(),
  }).passthrough(),
}).passthrough()

const CliResultSchema = z.object({
  type: z.literal('result'),
  result: z.string().optional(),
  duration_ms: z.number().optional(),
  cost_usd: z.number().optional(),
  usage: UsageSchema.optional(),
}).passthrough()

const CliStreamEventSchema = z.object({
  type: z.literal('stream_event'),
  event: z.object({
    type: z.string(),
  }).passthrough(),
}).passthrough()

const CliControlRequestSchema = z.object({
  type: z.literal('control_request'),
  id: z.string(),
  subtype: z.string(),
  tool: z.object({
    name: z.string(),
    input: z.record(z.unknown()).optional(),
  }).passthrough().optional(),
}).passthrough()

const CliToolProgressSchema = z.object({
  type: z.literal('tool_progress'),
}).passthrough()

const CliToolUseSummarySchema = z.object({
  type: z.literal('tool_use_summary'),
}).passthrough()

const CliKeepAliveSchema = z.object({
  type: z.literal('keep_alive'),
}).passthrough()

const CliAuthStatusSchema = z.object({
  type: z.literal('auth_status'),
}).passthrough()

export const CliMessageSchema = z.discriminatedUnion('type', [
<<<<<<< HEAD
  CliSystemInitSchema,
  CliSystemStatusSchema,
=======
  CliSystemSchema,
>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)
  CliAssistantSchema,
  CliResultSchema,
  CliStreamEventSchema,
  CliControlRequestSchema,
  CliToolProgressSchema,
  CliToolUseSummarySchema,
  CliKeepAliveSchema,
  CliAuthStatusSchema,
])

export type CliMessage = z.infer<typeof CliMessageSchema>

// ── Browser → Server SDK messages (added to existing WS protocol) ──

const SdkCreateSchema = z.object({
  type: z.literal('sdk.create'),
  requestId: z.string().min(1),
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
})

const SdkSendSchema = z.object({
  type: z.literal('sdk.send'),
  sessionId: z.string().min(1),
  text: z.string().min(1),
  images: z.array(z.object({
    mediaType: z.string(),
    data: z.string(),
  })).optional(),
})

const SdkPermissionRespondSchema = z.object({
  type: z.literal('sdk.permission.respond'),
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  behavior: z.enum(['allow', 'deny']),
  updatedInput: z.record(z.unknown()).optional(),
  message: z.string().optional(),
})

const SdkInterruptSchema = z.object({
  type: z.literal('sdk.interrupt'),
  sessionId: z.string().min(1),
})

const SdkKillSchema = z.object({
  type: z.literal('sdk.kill'),
  sessionId: z.string().min(1),
})

const SdkAttachSchema = z.object({
  type: z.literal('sdk.attach'),
  sessionId: z.string().min(1),
})

export const BrowserSdkMessageSchema = z.discriminatedUnion('type', [
  SdkCreateSchema,
  SdkSendSchema,
  SdkPermissionRespondSchema,
  SdkInterruptSchema,
  SdkKillSchema,
  SdkAttachSchema,
])

export type BrowserSdkMessage = z.infer<typeof BrowserSdkMessageSchema>

// ── Server → Browser SDK messages (responses/events) ──

export type SdkServerMessage =
  | { type: 'sdk.created'; requestId: string; sessionId: string }
  | { type: 'sdk.session.init'; sessionId: string; cliSessionId?: string; model?: string; cwd?: string; tools?: Array<{ name: string }> }
  | { type: 'sdk.assistant'; sessionId: string; content: ContentBlock[]; model?: string; usage?: z.infer<typeof UsageSchema> }
  | { type: 'sdk.stream'; sessionId: string; event: unknown }
  | { type: 'sdk.result'; sessionId: string; result?: string; durationMs?: number; costUsd?: number; usage?: z.infer<typeof UsageSchema> }
  | { type: 'sdk.permission.request'; sessionId: string; requestId: string; subtype: string; tool?: { name: string; input?: Record<string, unknown> } }
  | { type: 'sdk.permission.cancelled'; sessionId: string; requestId: string }
  | { type: 'sdk.status'; sessionId: string; status: 'idle' | 'running' | 'compacting' | 'starting' | 'connected' | 'exited' }
  | { type: 'sdk.error'; sessionId: string; message: string }
  | { type: 'sdk.history'; sessionId: string; messages: Array<{ role: 'user' | 'assistant'; content: ContentBlock[]; timestamp?: string }> }
  | { type: 'sdk.exit'; sessionId: string; exitCode?: number }

// ── SDK Session State (server-side, in-memory) ──

export interface SdkSessionState {
  sessionId: string          // Freshell-assigned session ID
  cliSessionId?: string      // Claude Code's internal session ID (from system/init)
  cwd?: string
  model?: string
  permissionMode?: string
  tools?: Array<{ name: string }>
  status: 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited'
  createdAt: number
  messages: Array<{ role: 'user' | 'assistant'; content: ContentBlock[]; timestamp: string }>
  pendingPermissions: Map<string, { subtype: string; tool?: { name: string; input?: Record<string, unknown> } }>
  costUsd: number
  totalInputTokens: number
  totalOutputTokens: number
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/sdk-bridge-types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/sdk-bridge-types.ts test/unit/server/sdk-bridge-types.test.ts
git commit -m "feat(sdk-bridge): add Zod schemas and TypeScript types for Claude Code SDK protocol

Define CLI→Server NDJSON message schemas (system/init, assistant, result,
stream_event, control_request, etc.) and Browser→Server SDK messages
(sdk.create, sdk.send, sdk.permission.respond, sdk.interrupt).
Also define SdkServerMessage union for Server→Browser events and
SdkSessionState for in-memory session tracking."
```

---

### Task 2: Implement SDK Bridge Core

The bridge spawns headless Claude Code, accepts its WebSocket connection, and routes messages between CLI and browser clients.

**Files:**
- Create: `server/sdk-bridge.ts`
- Test: `test/unit/server/sdk-bridge.test.ts`

**Step 1: Write failing tests**

```typescript
// test/unit/server/sdk-bridge.test.ts
<<<<<<< HEAD
=======
import { EventEmitter } from 'events'
>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SdkBridge } from '../../../server/sdk-bridge.js'
import type { SdkSessionState } from '../../../server/sdk-bridge-types.js'

<<<<<<< HEAD
// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new (require('events').EventEmitter)()
    proc.pid = 12345
    proc.kill = vi.fn()
    proc.stdout = new (require('events').EventEmitter)()
    proc.stderr = new (require('events').EventEmitter)()
=======
// Mock child_process.spawn (ESM-compatible — uses top-level import)
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn>; stdout: EventEmitter; stderr: EventEmitter }
    proc.pid = 12345
    proc.kill = vi.fn()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)
    return proc
  }),
}))

describe('SdkBridge', () => {
  let bridge: SdkBridge

  beforeEach(() => {
    bridge = new SdkBridge({ port: 0 }) // port 0 = random available
  })

  afterEach(() => {
    bridge.close()
  })

  describe('session lifecycle', () => {
    it('creates a session with unique ID', () => {
      const session = bridge.createSession({ cwd: '/tmp' })
      expect(session.sessionId).toBeTruthy()
      expect(session.status).toBe('starting')
      expect(session.cwd).toBe('/tmp')
    })

    it('lists active sessions', () => {
      bridge.createSession({ cwd: '/tmp' })
      bridge.createSession({ cwd: '/home' })
      expect(bridge.listSessions()).toHaveLength(2)
    })

    it('gets session by ID', () => {
      const session = bridge.createSession({ cwd: '/tmp' })
      expect(bridge.getSession(session.sessionId)).toBeDefined()
      expect(bridge.getSession('nonexistent')).toBeUndefined()
    })

    it('kills a session', () => {
      const session = bridge.createSession({ cwd: '/tmp' })
      const killed = bridge.killSession(session.sessionId)
      expect(killed).toBe(true)
      expect(bridge.getSession(session.sessionId)?.status).toBe('exited')
    })
  })

<<<<<<< HEAD
  describe('NDJSON parsing', () => {
    it('parses single-line NDJSON', () => {
      const parsed = (bridge as any).parseNdjson(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n'
      )
      expect(parsed).toHaveLength(1)
      expect(parsed[0].type).toBe('assistant')
    })

    it('handles multiple lines', () => {
      const data = [
        '{"type":"keep_alive"}',
        '{"type":"result","result":"success"}',
      ].join('\n') + '\n'
      const parsed = (bridge as any).parseNdjson(data)
      expect(parsed).toHaveLength(2)
    })

    it('ignores empty lines and invalid JSON', () => {
      const data = '{"type":"keep_alive"}\n\nnot json\n{"type":"result"}\n'
      const parsed = (bridge as any).parseNdjson(data)
      expect(parsed).toHaveLength(2)
=======
  describe('CLI message handling (exercises NDJSON parsing internally)', () => {
    it('processes a valid assistant message and stores it', () => {
      const session = bridge.createSession({ cwd: '/tmp' })
      // handleCliMessage is the public-facing entry point that internally
      // parses and validates messages via CliMessageSchema
      ;(bridge as any).handleCliMessage(session.sessionId, {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      })
      expect(bridge.getSession(session.sessionId)?.messages).toHaveLength(1)
    })

    it('ignores messages with unknown types gracefully', () => {
      const session = bridge.createSession({ cwd: '/tmp' })
      // Should not throw — invalid messages are logged and skipped
      ;(bridge as any).handleCliMessage(session.sessionId, { type: 'bogus_unknown' })
      expect(bridge.getSession(session.sessionId)?.messages).toHaveLength(0)
>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)
    })
  })

  describe('message routing', () => {
    it('stores assistant messages in session history', () => {
      const session = bridge.createSession({ cwd: '/tmp' })
      ;(bridge as any).handleCliMessage(session.sessionId, {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          model: 'claude-sonnet-4-5-20250929',
        },
      })
      const state = bridge.getSession(session.sessionId)
      expect(state?.messages).toHaveLength(1)
      expect(state?.messages[0].role).toBe('assistant')
    })

    it('tracks permission requests', () => {
      const session = bridge.createSession({ cwd: '/tmp' })
      ;(bridge as any).handleCliMessage(session.sessionId, {
        type: 'control_request',
        id: 'perm-1',
        subtype: 'can_use_tool',
        tool: { name: 'Bash', input: { command: 'ls' } },
      })
      const state = bridge.getSession(session.sessionId)
      expect(state?.pendingPermissions.size).toBe(1)
      expect(state?.pendingPermissions.get('perm-1')).toBeDefined()
    })

    it('updates session state on system/init', () => {
      const session = bridge.createSession({ cwd: '/tmp' })
      ;(bridge as any).handleCliMessage(session.sessionId, {
        type: 'system',
        subtype: 'init',
        session_id: 'claude-session-abc',
        model: 'claude-opus-4-6',
        tools: [{ name: 'Bash' }, { name: 'Read' }],
      })
      const state = bridge.getSession(session.sessionId)
      expect(state?.cliSessionId).toBe('claude-session-abc')
      expect(state?.model).toBe('claude-opus-4-6')
      expect(state?.status).toBe('connected')
    })

    it('updates cost tracking on result', () => {
      const session = bridge.createSession({ cwd: '/tmp' })
      ;(bridge as any).handleCliMessage(session.sessionId, {
        type: 'result',
        result: 'success',
        cost_usd: 0.05,
        usage: { input_tokens: 1000, output_tokens: 500 },
      })
      const state = bridge.getSession(session.sessionId)
      expect(state?.costUsd).toBe(0.05)
      expect(state?.totalInputTokens).toBe(1000)
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/sdk-bridge.test.ts`
Expected: FAIL — module not found

**Step 3: Write the SdkBridge implementation**

```typescript
// server/sdk-bridge.ts
import { nanoid } from 'nanoid'
import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { WebSocketServer, WebSocket } from 'ws'
import { logger } from './logger.js'
import {
  CliMessageSchema,
  type CliMessage,
  type SdkSessionState,
  type ContentBlock,
  type SdkServerMessage,
} from './sdk-bridge-types.js'

const log = logger.child({ component: 'sdk-bridge' })

const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude'
const GRACEFUL_KILL_TIMEOUT_MS = 5_000

interface SdkBridgeOptions {
  port?: number
}

interface SessionProcess {
  proc: ChildProcess
  cliSocket?: WebSocket
  browserListeners: Set<(msg: SdkServerMessage) => void>
  pendingMessages: string[] // queued NDJSON lines for CLI before it connects
}

export class SdkBridge extends EventEmitter {
  private wss: WebSocketServer
  private sessions = new Map<string, SdkSessionState>()
  private processes = new Map<string, SessionProcess>()
  private port: number

  constructor(options: SdkBridgeOptions = {}) {
    super()
    this.port = options.port ?? 0

<<<<<<< HEAD
    this.wss = new WebSocketServer({ port: this.port, path: '/ws/sdk' })
=======
    // Bind to loopback only — the SDK bridge WS is for local CLI↔server
    // communication only, not exposed to the network. The CLI connects
    // using ws://127.0.0.1:PORT, and the sessionId (nanoid) acts as a
    // bearer token to prevent unauthorized local connections.
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: this.port, path: '/ws/sdk' })
>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)
    this.wss.on('listening', () => {
      const addr = this.wss.address()
      this.port = typeof addr === 'object' ? addr.port : this.port
      log.info({ port: this.port }, 'SDK bridge WebSocket server listening')
    })
    this.wss.on('connection', (ws, req) => this.onCliConnection(ws, req))
  }

  getPort(): number {
    return this.port
  }

  createSession(options: {
    cwd?: string
    resumeSessionId?: string
    model?: string
    permissionMode?: string
  }): SdkSessionState {
    const sessionId = nanoid()
    const state: SdkSessionState = {
      sessionId,
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
      status: 'starting',
      createdAt: Date.now(),
      messages: [],
      pendingPermissions: new Map(),
      costUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    }
    this.sessions.set(sessionId, state)

    const proc = this.spawnCli(sessionId, options)
    this.processes.set(sessionId, {
      proc,
      browserListeners: new Set(),
      pendingMessages: [],
    })

    return state
  }

  getSession(sessionId: string): SdkSessionState | undefined {
    return this.sessions.get(sessionId)
  }

  listSessions(): SdkSessionState[] {
    return Array.from(this.sessions.values())
  }

  killSession(sessionId: string): boolean {
    const sp = this.processes.get(sessionId)
    if (!sp) return false

    const state = this.sessions.get(sessionId)
    if (state) state.status = 'exited'

    try {
      sp.proc.kill('SIGTERM')
      setTimeout(() => {
        try { sp.proc.kill('SIGKILL') } catch { /* ignore */ }
      }, GRACEFUL_KILL_TIMEOUT_MS)
    } catch { /* ignore */ }

    sp.cliSocket?.close()
    return true
  }

  /**
   * Subscribe a browser client to a session's events.
   * Returns unsubscribe function.
   */
  subscribe(sessionId: string, listener: (msg: SdkServerMessage) => void): (() => void) | null {
    const sp = this.processes.get(sessionId)
    if (!sp) return null
    sp.browserListeners.add(listener)
    return () => { sp.browserListeners.delete(listener) }
  }

  /**
   * Send a user message to the CLI.
   */
  sendUserMessage(sessionId: string, text: string, images?: Array<{ mediaType: string; data: string }>): boolean {
    const content: Array<Record<string, unknown>> = [{ type: 'text', text }]
    if (images?.length) {
      for (const img of images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        })
      }
    }

    const ndjson = JSON.stringify({
      type: 'user',
      content,
    }) + '\n'

    const state = this.sessions.get(sessionId)
    if (state) {
      state.messages.push({
        role: 'user',
        content: [{ type: 'text', text } as ContentBlock],
        timestamp: new Date().toISOString(),
      })
    }

    return this.sendToCli(sessionId, ndjson)
  }

  /**
   * Respond to a permission request.
   */
  respondPermission(
    sessionId: string,
    requestId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
    message?: string,
  ): boolean {
    const state = this.sessions.get(sessionId)
    state?.pendingPermissions.delete(requestId)

    const response: Record<string, unknown> = {
      type: 'control_response',
      id: requestId,
      result: { behavior },
    }
    if (updatedInput) (response.result as Record<string, unknown>).updatedInput = updatedInput
    if (message) (response.result as Record<string, unknown>).message = message

    return this.sendToCli(sessionId, JSON.stringify(response) + '\n')
  }

  /**
   * Send interrupt signal.
   */
  interrupt(sessionId: string): boolean {
    const ndjson = JSON.stringify({
      type: 'control_request',
      subtype: 'interrupt',
    }) + '\n'
    return this.sendToCli(sessionId, ndjson)
  }

  close(): void {
    for (const [sessionId] of this.processes) {
      this.killSession(sessionId)
    }
    this.wss.close()
  }

  // ── Private ──

  private spawnCli(sessionId: string, options: {
    cwd?: string
    resumeSessionId?: string
    model?: string
    permissionMode?: string
  }): ChildProcess {
    const sdkUrl = `ws://127.0.0.1:${this.port}/ws/sdk?sessionId=${sessionId}`

    const args = [
      '--sdk-url', sdkUrl,
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
<<<<<<< HEAD
      '--print', // synonym for -p
      '--verbose',
=======
      '--verbose',
      '-p', '', // headless: empty prompt → waits for input via WS
>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)
    ]

    if (options.model) args.push('--model', options.model)
    if (options.permissionMode) args.push('--permission-mode', options.permissionMode)
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)
<<<<<<< HEAD
    args.push('-p', '') // headless: empty prompt → waits for input via WS
=======
>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)

    log.info({ sessionId, cmd: CLAUDE_CMD, args, cwd: options.cwd }, 'Spawning Claude Code in SDK mode')

    const proc = spawn(CLAUDE_CMD, args, {
      cwd: options.cwd || undefined,
      env: { ...process.env, CLAUDECODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    proc.stdout?.on('data', (data: Buffer) => {
      log.debug({ sessionId, stdout: data.toString().slice(0, 200) }, 'CLI stdout')
    })

    proc.stderr?.on('data', (data: Buffer) => {
      log.debug({ sessionId, stderr: data.toString().slice(0, 200) }, 'CLI stderr')
    })

    proc.on('exit', (code) => {
      log.info({ sessionId, exitCode: code }, 'Claude Code CLI exited')
      const state = this.sessions.get(sessionId)
      if (state) state.status = 'exited'
      this.broadcastToSession(sessionId, { type: 'sdk.exit', sessionId, exitCode: code ?? undefined })
    })

    return proc
  }

  private onCliConnection(ws: WebSocket, req: import('http').IncomingMessage): void {
    const url = new URL(req.url || '', `http://127.0.0.1:${this.port}`)
    const sessionId = url.searchParams.get('sessionId')

    if (!sessionId || !this.sessions.has(sessionId)) {
      log.warn({ sessionId }, 'CLI connected with unknown sessionId')
      ws.close(4001, 'Unknown session')
      return
    }

    log.info({ sessionId }, 'Claude Code CLI connected to SDK bridge')
    const sp = this.processes.get(sessionId)
    if (sp) {
      sp.cliSocket = ws
      // Flush pending messages
      for (const msg of sp.pendingMessages) {
        ws.send(msg)
      }
      sp.pendingMessages = []
    }

    let buffer = ''
    ws.on('message', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // Keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line)
          this.handleCliMessage(sessionId, parsed)
        } catch (err) {
          log.debug({ sessionId, line: line.slice(0, 100) }, 'Failed to parse CLI NDJSON line')
        }
      }
    })

    ws.on('close', () => {
      log.info({ sessionId }, 'CLI WebSocket disconnected')
      if (sp) sp.cliSocket = undefined
    })
  }

  private handleCliMessage(sessionId: string, raw: unknown): void {
    const parsed = CliMessageSchema.safeParse(raw)
    if (!parsed.success) {
      log.debug({ sessionId, error: parsed.error.message }, 'Unrecognized CLI message')
      return
    }

    const msg = parsed.data
    const state = this.sessions.get(sessionId)
    if (!state) return

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          state.cliSessionId = msg.session_id
          state.model = msg.model || state.model
          state.tools = msg.tools as Array<{ name: string }> | undefined
          state.cwd = msg.cwd || state.cwd
          state.status = 'connected'
          this.broadcastToSession(sessionId, {
            type: 'sdk.session.init',
            sessionId,
            cliSessionId: state.cliSessionId,
            model: state.model,
            cwd: state.cwd,
            tools: state.tools,
          })
        }
        break
      }

      case 'assistant': {
        const content = msg.message.content as ContentBlock[]
        state.messages.push({
          role: 'assistant',
          content,
          timestamp: new Date().toISOString(),
        })
        this.broadcastToSession(sessionId, {
          type: 'sdk.assistant',
          sessionId,
          content,
          model: msg.message.model,
          usage: msg.message.usage,
        })
        state.status = 'running'
        break
      }

      case 'result': {
        if (msg.cost_usd) state.costUsd += msg.cost_usd
        if (msg.usage) {
          state.totalInputTokens += msg.usage.input_tokens
          state.totalOutputTokens += msg.usage.output_tokens
        }
        state.status = 'idle'
        this.broadcastToSession(sessionId, {
          type: 'sdk.result',
          sessionId,
          result: msg.result,
          durationMs: msg.duration_ms,
          costUsd: msg.cost_usd,
          usage: msg.usage,
        })
        break
      }

      case 'stream_event': {
        this.broadcastToSession(sessionId, {
          type: 'sdk.stream',
          sessionId,
          event: msg.event,
        })
        break
      }

      case 'control_request': {
        state.pendingPermissions.set(msg.id, {
          subtype: msg.subtype,
          tool: msg.tool as { name: string; input?: Record<string, unknown> } | undefined,
        })
        this.broadcastToSession(sessionId, {
          type: 'sdk.permission.request',
          sessionId,
          requestId: msg.id,
          subtype: msg.subtype,
          tool: msg.tool as { name: string; input?: Record<string, unknown> } | undefined,
        })
        break
      }

      case 'keep_alive':
        // No-op, just keeps connection alive
        break

      default:
        log.debug({ sessionId, type: msg.type }, 'Unhandled CLI message type')
    }
  }

<<<<<<< HEAD
  parseNdjson(data: string): unknown[] {
=======
  private parseNdjson(data: string): unknown[] {
>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)
    const results: unknown[] = []
    for (const line of data.split('\n')) {
      if (!line.trim()) continue
      try {
        results.push(JSON.parse(line))
      } catch { /* skip */ }
    }
    return results
  }

  private sendToCli(sessionId: string, ndjson: string): boolean {
    const sp = this.processes.get(sessionId)
    if (!sp) return false

    if (sp.cliSocket?.readyState === WebSocket.OPEN) {
      sp.cliSocket.send(ndjson)
      return true
    }

    // Queue if CLI hasn't connected yet
    sp.pendingMessages.push(ndjson)
    return true
  }

  private broadcastToSession(sessionId: string, msg: SdkServerMessage): void {
    const sp = this.processes.get(sessionId)
    if (!sp) return
    for (const listener of sp.browserListeners) {
      try {
        listener(msg)
      } catch (err) {
        log.warn({ err, sessionId }, 'Browser listener error')
      }
    }
    this.emit('message', sessionId, msg)
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/server/sdk-bridge.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/sdk-bridge.ts test/unit/server/sdk-bridge.test.ts
git commit -m "feat(sdk-bridge): implement SdkBridge for headless Claude Code sessions

SdkBridge spawns Claude Code with --sdk-url, accepts CLI WebSocket
connections, parses NDJSON messages, routes them to browser listeners,
and manages session state (permissions, messages, cost tracking).
Supports user messages, permission responses, interrupt, and kill."
```

---

### Task 3: Integrate SDK Bridge into WS Handler

Wire the SDK bridge into Freshell's existing WebSocket protocol so browser clients can create/interact with SDK sessions via the existing connection.

**Files:**
- Modify: `server/ws-handler.ts` (add `sdk.*` message handling)
- Modify: `server/index.ts` (instantiate SdkBridge)
- Test: `test/unit/server/ws-handler-sdk.test.ts`

**Step 1: Write failing tests**

Test that the WS handler recognizes and routes `sdk.*` messages (you'll need to add the schemas to `ClientMessageSchema` and add `case` branches).

**Step 2: Add SDK schemas to ClientMessageSchema in ws-handler.ts**

Import `BrowserSdkMessageSchema` union members and add them to the `ClientMessageSchema` discriminated union. Add cases in the `switch (m.type)` block for `sdk.create`, `sdk.send`, `sdk.permission.respond`, `sdk.interrupt`, `sdk.kill`.

**Step 3: In `server/index.ts`, instantiate `SdkBridge` and pass it to `WsHandler`**

The bridge's listener pattern means WsHandler subscribes per-client and forwards `SdkServerMessage` events as WebSocket JSON.

**Step 4: Run tests**

Run: `npm test`
Expected: All PASS

**Step 5: Commit**

---

## Phase 2: Client — Redux State & WebSocket Integration

### Task 4: Add `claude-chat` Pane Content Type

Add the new pane content type to the pane type system.

**Files:**
- Modify: `src/store/paneTypes.ts` — add `ClaudeChatPaneContent`
- Modify: `src/lib/derivePaneTitle.ts` — handle new kind
- Test: `test/unit/client/paneTypes.test.ts`

**Step 1: Write failing test**

Test that `PaneContent` union accepts `{ kind: 'claude-chat', ... }` and `derivePaneTitle` returns "Claude Web" for it.

**Step 2: Add the type**

```typescript
// In paneTypes.ts, add:
<<<<<<< HEAD
=======

/** SDK session statuses — richer than TerminalStatus to reflect Claude Code lifecycle */
export type SdkSessionStatus = 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited'

>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)
export type ClaudeChatPaneContent = {
  kind: 'claude-chat'
  /** SDK session ID (undefined until created) */
  sessionId?: string
  /** Idempotency key for sdk.create */
  createRequestId: string
<<<<<<< HEAD
  /** Current status */
  status: TerminalStatus
=======
  /** Current status — uses SdkSessionStatus, not TerminalStatus */
  status: SdkSessionStatus
>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)
  /** Claude session to resume */
  resumeSessionId?: string
  /** Working directory */
  initialCwd?: string
}

// Update union:
export type PaneContent = TerminalPaneContent | BrowserPaneContent | EditorPaneContent | PickerPaneContent | ClaudeChatPaneContent
```

**Step 3: Run tests, verify pass**

**Step 4: Commit**

---

### Task 5: Create Claude Chat Redux Slice

Manage SDK session state on the client: messages, streaming text, permissions, and session metadata.

**Files:**
- Create: `src/store/claudeChatSlice.ts`
- Create: `src/store/claudeChatTypes.ts`
- Test: `test/unit/client/claudeChatSlice.test.ts`

**Step 1: Write failing tests**

```typescript
// test/unit/client/claudeChatSlice.test.ts
import { describe, it, expect } from 'vitest'
import claudeChatReducer, {
  sessionCreated,
  sessionInit,
  addAssistantMessage,
  addUserMessage,
  setStreaming,
  appendStreamDelta,
  clearStreaming,
  addPermissionRequest,
  removePermission,
  setSessionStatus,
  turnResult,
} from '../../../src/store/claudeChatSlice'

describe('claudeChatSlice', () => {
  const initial = claudeChatReducer(undefined, { type: 'init' })

  it('has empty initial state', () => {
    expect(initial.sessions).toEqual({})
  })

  it('creates a session', () => {
    const state = claudeChatReducer(initial, sessionCreated({
      requestId: 'req-1',
      sessionId: 'sess-1',
    }))
    expect(state.sessions['sess-1']).toBeDefined()
    expect(state.sessions['sess-1'].messages).toEqual([])
  })

  it('stores assistant messages', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, addAssistantMessage({
      sessionId: 's1',
      content: [{ type: 'text', text: 'Hello' }],
      model: 'claude-sonnet-4-5-20250929',
    }))
    expect(state.sessions['s1'].messages).toHaveLength(1)
    expect(state.sessions['s1'].messages[0].role).toBe('assistant')
  })

  it('tracks streaming text', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, setStreaming({ sessionId: 's1', active: true }))
    state = claudeChatReducer(state, appendStreamDelta({ sessionId: 's1', text: 'Hel' }))
    state = claudeChatReducer(state, appendStreamDelta({ sessionId: 's1', text: 'lo' }))
    expect(state.sessions['s1'].streamingText).toBe('Hello')
  })

  it('tracks permission requests', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, addPermissionRequest({
      sessionId: 's1',
      requestId: 'perm-1',
      subtype: 'can_use_tool',
      tool: { name: 'Bash', input: { command: 'ls' } },
    }))
    expect(state.sessions['s1'].pendingPermissions['perm-1']).toBeDefined()
    state = claudeChatReducer(state, removePermission({ sessionId: 's1', requestId: 'perm-1' }))
    expect(state.sessions['s1'].pendingPermissions['perm-1']).toBeUndefined()
  })

  it('accumulates cost on result', () => {
    let state = claudeChatReducer(initial, sessionCreated({ requestId: 'r', sessionId: 's1' }))
    state = claudeChatReducer(state, turnResult({
      sessionId: 's1',
      costUsd: 0.05,
      durationMs: 3000,
      usage: { input_tokens: 1000, output_tokens: 500 },
    }))
    expect(state.sessions['s1'].totalCostUsd).toBe(0.05)
    expect(state.sessions['s1'].totalInputTokens).toBe(1000)
  })
})
```

**Step 2: Run to verify fail**

**Step 3: Implement the slice**

Key state shape per session:
- `messages: ChatMessage[]` (role, content blocks, timestamp, model)
- `streamingText: string` (accumulated delta)
- `streamingActive: boolean`
- `pendingPermissions: Record<string, PermissionRequest>`
- `status: 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'exited'`
- `model?: string`, `cwd?: string`, `cliSessionId?: string`
- `totalCostUsd: number`, `totalInputTokens: number`, `totalOutputTokens: number`

**Step 4: Run tests, verify pass**

**Step 5: Commit**

---

### Task 6: Add SDK Message Handlers to WS Client

Handle incoming `sdk.*` messages from the server and dispatch Redux actions.

**Files:**
- Modify: `src/lib/ws-client.ts` — add handlers for `sdk.created`, `sdk.assistant`, `sdk.stream`, `sdk.permission.request`, `sdk.result`, `sdk.exit`, etc.
- Test: `test/unit/client/ws-client-sdk.test.ts`

**Step 1: Write failing tests**

Test that receiving `sdk.assistant` dispatches `addAssistantMessage`, `sdk.permission.request` dispatches `addPermissionRequest`, etc.

**Step 2: Add message handlers**

In the WS client's message dispatch, add cases for all `sdk.*` message types that dispatch into the `claudeChatSlice`.

**Step 3: Run tests, commit**

---

## Phase 3: Client — Chat UI Components

### Task 7: MessageBubble Component

Renders a single chat message (user or assistant) with markdown, code blocks, and thinking sections.

**Files:**
- Create: `src/components/claude-chat/MessageBubble.tsx`
- Test: `test/unit/client/components/MessageBubble.test.tsx`

**Key features:**
- User messages: right-aligned, simple text
- Assistant messages: left-aligned, markdown rendered via `react-markdown` + `remark-gfm`
- Code blocks: syntax highlighted (use existing Freshell code highlighting or `react-syntax-highlighter`)
- Thinking blocks: collapsible `<details>` with character count badge
- Tool use blocks: delegate to `ToolBlock` component
- Timestamp + model badge

**Step 1: Write failing test (renders user message, renders assistant markdown)**

**Step 2: Implement component**

**Step 3: Run tests, commit**

---

### Task 8: ToolBlock Component

Renders tool call visualization with progressive disclosure (collapsed by default, expandable).

**Files:**
- Create: `src/components/claude-chat/ToolBlock.tsx`
- Test: `test/unit/client/components/ToolBlock.test.tsx`

**Key features (adapted from companion's ToolBlock):**
- Collapsible card with icon, tool name, and preview
- **Bash**: Show command with `$ ` prefix in monospace
- **Edit**: Show file path + diff preview (removed/added sections)
- **Write**: Show file path + content preview (truncated)
- **Read**: Show file path
- **Default**: Show JSON input pretty-printed
- Status indicator (running spinner, success check, error X)

**Step 1: Write failing tests**

**Step 2: Implement**

**Step 3: Commit**

---

### Task 9: PermissionBanner Component

Renders pending permission requests with allow/deny buttons and tool input preview.

**Files:**
- Create: `src/components/claude-chat/PermissionBanner.tsx`
- Test: `test/unit/client/components/PermissionBanner.test.tsx`

**Key features (adapted from companion's PermissionBanner):**
- Warning-styled banner for permission requests
- Tool name and input preview (delegates to tool-specific display: BashDisplay, EditDisplay, etc.)
- Allow / Deny buttons
- Loading state while waiting for response
- Accessible: proper ARIA labels, button semantics

**Step 1: Write failing tests**

**Step 2: Implement**

**Step 3: Commit**

---

### Task 10: ChatComposer Component

Text input for sending messages to the Claude Code SDK session.

**Files:**
- Create: `src/components/claude-chat/ChatComposer.tsx`
- Test: `test/unit/client/components/ChatComposer.test.tsx`

**Key features:**
- Auto-resizing textarea (min 36px, max 200px)
- Enter to send, Shift+Enter for newline
- Disabled when not connected
- Interrupt button (visible when session is running)
- Placeholder text changes based on connection state
- Accessible: label, proper form semantics

**Step 1: Write failing tests**

**Step 2: Implement**

**Step 3: Commit**

---

### Task 11: ClaudeChatView Container Component

The main container that composes MessageBubble list, PermissionBanner, and ChatComposer into a complete chat pane.

**Files:**
- Create: `src/components/claude-chat/ClaudeChatView.tsx`
- Test: `test/unit/client/components/ClaudeChatView.test.tsx`

**Key features:**
- Manages SDK session lifecycle (sends `sdk.create` on mount, subscribes to events)
- Auto-scrolling message feed (scrolls to bottom on new messages unless user has scrolled up)
- Streaming indicator (shows "Generating..." with token count during active stream)
- Connection status banner (reconnecting, CLI disconnected)
- Session metadata display (model, cost, token count in subtle header)
- Handles resume: if `resumeSessionId` set, sends `sdk.attach` and receives history replay

**Step 1: Write failing tests**

**Step 2: Implement**

**Step 3: Commit**

---

## Phase 4: Integration

### Task 12: Add "Claude Web" to PanePicker

Add the new pane type as an option in the PanePicker UI.

**Files:**
- Modify: `src/components/panes/PanePicker.tsx` — add 'claude-web' option
- Modify: `src/components/panes/PaneContainer.tsx` — render `ClaudeChatView` for `kind: 'claude-chat'`
- Modify: `src/lib/coding-cli-utils.ts` — add `claude-web` to provider configs if needed
- Test: `test/unit/client/components/PanePicker.test.tsx`

**Step 1: Write failing tests**

Test that PanePicker shows a "Claude Web" option and that selecting it creates a `claude-chat` pane content.

**Step 2: Implementation**

In `PanePicker`:
- Add a new option: `{ type: 'claude-web', label: 'Claude Web', icon: null, iconUrl: claudeIconUrl, shortcut: 'W' }` (or adapt shortcut)
- Position it right after the existing "Claude" option in the list

In `PaneContainer.renderContent()`:
```typescript
if (content.kind === 'claude-chat') {
  return <ClaudeChatView key={paneId} tabId={tabId} paneId={paneId} paneContent={content} hidden={hidden} />
}
```

In the `PickerWrapper.createContentForType()`:
```typescript
case 'claude-web':
  return {
    kind: 'claude-chat',
    createRequestId: nanoid(),
    status: 'creating',
    ...(cwd ? { initialCwd: cwd } : {}),
  }
```

**Step 3: Run tests, commit**

---

### Task 13: Pane Lifecycle & Session Association

Handle the full lifecycle: creating SDK sessions when panes mount, cleanup on close, resume on reconnect, and sidebar integration.

**Files:**
- Modify: `src/components/claude-chat/ClaudeChatView.tsx` — lifecycle effect
- Modify: `src/store/panesSlice.ts` — handle `claude-chat` in close/persist logic
- Modify: `src/components/panes/PaneContainer.tsx` — cleanup on close
- Test: integration tests

**Key behaviors:**
- On pane mount with `createRequestId`: send `sdk.create` WS message
- On `sdk.created` response: update pane content with `sessionId`
- On pane close: send `sdk.kill` (or just detach, keeping session in background)
- On page refresh: restore from localStorage, re-attach to existing SDK session
- Sidebar: show active SDK sessions in "Background" section if detached

**Step 1: Write failing tests**

**Step 2: Implement**

**Step 3: Commit**

---

<<<<<<< HEAD
### Task 14: Install react-markdown Dependency

The chat UI needs markdown rendering for assistant messages.

**Files:**
- Modify: `package.json`

**Step 1: Install**

```bash
npm install react-markdown remark-gfm
```

Note: Check if these are already dependencies. If not, install and commit the lockfile change.

**Step 2: Commit**
=======
### Task 14: Verify Markdown Dependencies

~~The chat UI needs markdown rendering for assistant messages.~~

**Status: No action needed.** `react-markdown` (^9.0.1) and `remark-gfm` (^4.0.0) are already in `package.json`. Verify they're importable and move on.
>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)

---

### Task 15: End-to-End Integration Test

Write an integration test that verifies the full flow: create SDK session → send message → receive response → render in UI.

**Files:**
- Create: `test/integration/sdk-chat-flow.test.ts`

**Test flow:**
1. Start the server with SdkBridge
2. Connect a WebSocket client
3. Send `sdk.create` message
4. Verify `sdk.created` response
5. Mock/stub the CLI connection to the bridge
6. Send a fake `system/init` NDJSON message from the mock CLI
7. Verify browser receives `sdk.session.init`
8. Send `sdk.send` with user text
9. Send fake `assistant` NDJSON from mock CLI
10. Verify browser receives `sdk.assistant` with content

**Step 1: Write the test**

**Step 2: Run, verify pass**

**Step 3: Commit**

---

## Phase 5: Polish & Refinement

### Task 16: Streaming Visualization

Implement real-time text streaming in the chat UI (token-by-token rendering as Claude generates).

**Key implementation:**
- Handle `sdk.stream` messages with `content_block_delta` events
- Accumulate text deltas in Redux (`appendStreamDelta`)
- Render streaming text below the last assistant message with cursor animation
- Show token count badge during streaming
- Clear streaming state on `sdk.result`

---

### Task 17: Message History Replay

When attaching to an existing SDK session (resume or reconnect), replay the conversation history.

**Key implementation:**
- Server sends `sdk.history` with all stored messages on `sdk.attach`
- Client renders all history messages before switching to live streaming
- Deduplication: track message IDs to prevent duplicates on reconnect

---

### Task 18: Directory Picker Integration

When creating a new Claude Web pane, show the directory picker (reuse existing `DirectoryPicker` component).

**Key implementation:**
- In `PickerWrapper`, when 'claude-web' is selected, show DirectoryPicker (same flow as existing coding CLI providers)
- Pass selected directory as `initialCwd` to `ClaudeChatPaneContent`

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| **1: Server** | 1-3 | SDK protocol types, bridge implementation, WS handler integration |
| **2: Client State** | 4-6 | Pane type, Redux slice, WS client handlers |
| **3: UI Components** | 7-11 | MessageBubble, ToolBlock, PermissionBanner, Composer, ClaudeChatView |
| **4: Integration** | 12-15 | PanePicker, lifecycle, dependencies, e2e test |
| **5: Polish** | 16-18 | Streaming, history replay, directory picker |

**Dependencies:**
- Task 2 depends on Task 1 (types)
- Task 3 depends on Task 2 (bridge)
- Tasks 4-6 can run in parallel with Tasks 1-3
- Tasks 7-10 depend on Task 5 (Redux slice)
- Task 11 depends on Tasks 7-10 (sub-components)
- Task 12-13 depend on Tasks 4 and 11
- Tasks 16-18 depend on Task 15 (integration verified)

<<<<<<< HEAD
**Key risk:** Claude Code's `--sdk-url` flag and NDJSON protocol are not officially documented and were reverse-engineered by the companion project. If Anthropic changes the protocol, the bridge will need updating. Mitigation: keep the protocol types in a single file (`sdk-bridge-types.ts`) and validate all messages with Zod schemas — invalid messages are logged and skipped rather than crashing.
=======
**Key risks and mitigations:** See the "Undocumented SDK protocol risk" and "Why a separate SdkBridge" sections in the Architecture preamble above.
>>>>>>> 98b863f (docs: add Claude Web Client Pane implementation plan)

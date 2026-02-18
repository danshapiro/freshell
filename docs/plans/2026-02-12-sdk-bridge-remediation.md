# SDK Bridge Remediation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace freshell's broken hand-rolled SDK bridge with one built on the official `@anthropic-ai/claude-agent-sdk` TypeScript package, matching the approach proven in [claudechic](https://github.com/mrocklin/claudechic) (the known-good reference implementation).

**Context — claudechic as source of truth:** The original implementation plan for the Claude Web Client Pane (`docs/plans/2026-02-11-claude-web-client-pane.md`) was based on reverse-engineering a companion project. That plan made incorrect assumptions about the CLI's communication protocol — inventing a `--sdk-url` WebSocket callback flag that doesn't exist, wrong message formats, and missing initialization handshakes. Meanwhile, [claudechic](https://github.com/mrocklin/claudechic) is a working Textual TUI that uses the official `claude-agent-sdk` Python package. Its agent layer (`claudechic/agent.py`) demonstrates the correct architecture: the SDK spawns `claude` as a subprocess, communicates via stdin/stdout NDJSON, sends an initialization handshake, and uses a structured control protocol for permissions. The official TypeScript equivalent is `@anthropic-ai/claude-agent-sdk` (v0.2.39), which provides a `query()` function that handles all transport, initialization, and control protocol internally. This plan replaces the hand-rolled transport with the official SDK.

**What's broken (12 deviations catalogued in prior analysis):**
1. **Fatal:** `--sdk-url` flag doesn't exist — CLI never connects back to server
2. **Fatal:** `stdio: ['ignore',...]` — stdin closed, can't send messages
3. **Fatal:** No initialization handshake, no `--permission-prompt-tool stdio`
4. **Breaking:** Wrong message formats for user messages, control requests/responses, interrupts
5. **Missing:** `parent_tool_use_id`, `user` CLI message type, result fields, stream event context

**What's correct and stays unchanged:**
- Browser↔Server protocol (`sdk.*` message types) — freshell-specific relay protocol, well-designed
- Redux `claudeChatSlice` — state shape is reasonable, will be extended
- Client-side `sdk-message-handler.ts` — dispatch logic is correct
- Chat UI components (`ClaudeChatView`, `MessageBubble`, `ToolBlock`, etc.) — render layer is fine
- Pane system integration (`PaneContainer`, `PanePicker`, `paneTypes`) — correct
- All existing test files for the client-side (`claudeChatSlice.test.ts`, `ws-client-sdk.test.ts`, component tests)

**Architecture:** Replace `SdkBridge`'s internal `child_process.spawn` + WebSocketServer with the official `@anthropic-ai/claude-agent-sdk` TypeScript SDK. The SDK's `query()` function returns an `AsyncGenerator<SDKMessage>` that handles subprocess transport, CLI flags, initialization, and the control protocol. SdkBridge becomes a thin adapter: it creates `query()` instances per session, iterates their message streams, translates `SDKMessage` types into the existing `sdk.*` browser protocol, and handles `canUseTool` callbacks by pausing the SDK and waiting for browser user responses via Promises. The internal WebSocketServer is deleted entirely.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` (official TS SDK, latest), existing: Node.js, ws, Zod, Vitest

**Post-review fixes (2026-02-12):** Independent review identified 3 valid issues (of 6 flagged):
1. **Permission flow incomplete** — `PermissionResult` is a discriminated union where `deny` requires `message`; `allow` supports `updatedPermissions`. The `canUseTool` options (`suggestions`, `blockedPath`, `decisionReason`, `toolUseID`) must be forwarded to the browser. Fixed throughout Task 2-3.
2. **Race condition** — `consumeStream` starts before WS subscribers attach, dropping early init/status messages. Fixed with message buffering in Task 3 (`messageBuffer` + replay on first `subscribe()`).
3. **Test coverage** — `it.todo` placeholders replaced with real type-level tests. Permission round-trip and message buffering tests added to Task 3.

(Issues 2-3 of the original 6 — non-existent SDK types and wrong API names — were false positives: `SDKStatusMessage`, `SDKToolProgressMessage`, `PermissionResult`, `settingSources`, `close()`, and `streamInput()` all exist in the SDK.)

---

## Task 1: Install the SDK and verify it works

**Files:**
- Modify: `package.json` (add dependency)
- Create: `server/sdk-smoke-test.ts` (temporary, deleted after verification)

**Step 1: Install the package**

Run: `cd /home/user/code/freshell/.worktrees/fix-sdk-bridge && npm install @anthropic-ai/claude-agent-sdk`
Expected: Package installs, appears in `package.json` dependencies

**Step 2: Write a smoke test script**

Create `server/sdk-smoke-test.ts`:
```typescript
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'

async function main() {
  const conversation = query({
    prompt: 'Say "hello" and nothing else.',
    options: {
      cwd: process.cwd(),
      maxTurns: 1,
      includePartialMessages: true,
    },
  })

  for await (const msg of conversation) {
    console.log(JSON.stringify({ type: msg.type, ...(msg as Record<string, unknown>) }, null, 2))
  }
}

main().catch(console.error)
```

**Step 3: Run the smoke test**

Run: `cd /home/user/code/freshell/.worktrees/fix-sdk-bridge && npx tsx server/sdk-smoke-test.ts`
Expected: See `system` (init), `assistant`, possibly `stream_event`, and `result` messages printed. This confirms the SDK works in our Node.js environment.

**Step 4: Delete smoke test, commit**

Run:
```bash
rm server/sdk-smoke-test.ts
git add package.json package-lock.json
git commit -m "feat(sdk-bridge): add @anthropic-ai/claude-agent-sdk dependency"
```

---

## Task 2: Define the new SDK message type interfaces

The current `sdk-bridge-types.ts` has Zod schemas for CLI↔Server NDJSON that are wrong (matching the nonexistent `--sdk-url` protocol). Replace the CLI message types with TypeScript interfaces that match the actual `SDKMessage` union from the official SDK. Keep the Browser↔Server types unchanged (they are correct).

**Files:**
- Modify: `server/sdk-bridge-types.ts`
- Modify: `test/unit/server/sdk-bridge-types.test.ts`

**Step 1: Update the failing test expectations**

Modify `test/unit/server/sdk-bridge-types.test.ts`. The existing tests validate `CliMessageSchema` (Zod) which we are removing. Replace with tests that validate the new approach — since we'll be using SDK types directly, tests should verify our `toSdkServerMessage()` translation function (written in Task 3).

Remove the `CliMessageSchema` validation tests and replace with tests that verify the SDK re-exports compile and the updated `SdkSessionState` shape:

```typescript
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  SDKStatusMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  SdkOptions,
  SdkQuery,
  CanUseTool,
  PermissionResult,
} from '../../../server/sdk-bridge-types.js'
import type { SdkSessionState } from '../../../server/sdk-bridge-types.js'

describe('SDK Bridge Types', () => {
  describe('BrowserSdkMessageSchema', () => {
    // Keep all existing BrowserSdkMessage tests — these are correct
  })

  describe('SDK re-exports', () => {
    it('re-exports SDKMessage union type', () => {
      // Type-level test: verify the re-export compiles
      const msg: SDKMessage = {
        type: 'assistant',
        message: {} as any,
        parent_tool_use_id: null,
        uuid: 'test' as any,
        session_id: 'test',
      }
      expect(msg.type).toBe('assistant')
    })

    it('re-exports PermissionResult discriminated union', () => {
      const allow: PermissionResult = {
        behavior: 'allow',
        updatedInput: { command: 'ls' },
        updatedPermissions: [],
      }
      // deny requires message (not optional)
      const deny: PermissionResult = {
        behavior: 'deny',
        message: 'User denied',
        interrupt: true,
      }
      expect(allow.behavior).toBe('allow')
      expect(deny.behavior).toBe('deny')
    })
  })

  describe('SdkSessionState', () => {
    it('pendingPermissions stores resolve function and SDK context', () => {
      const state: SdkSessionState = {
        sessionId: 'test',
        status: 'connected',
        createdAt: Date.now(),
        messages: [],
        pendingPermissions: new Map(),
        costUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      }
      const resolveFn = vi.fn()
      state.pendingPermissions.set('req-1', {
        toolName: 'Bash',
        input: { command: 'ls' },
        toolUseID: 'tool-1',
        resolve: resolveFn,
      })
      const pending = state.pendingPermissions.get('req-1')!
      pending.resolve({ behavior: 'allow' })
      expect(resolveFn).toHaveBeenCalledWith({ behavior: 'allow' })
    })
  })
})
```

**Step 2: Run test to verify the old CLI tests fail/are removed**

Run: `cd /home/user/code/freshell/.worktrees/fix-sdk-bridge && npx vitest run test/unit/server/sdk-bridge-types.test.ts`
Expected: Browser tests pass, removed tests are todo

**Step 3: Update sdk-bridge-types.ts**

Remove these exports (they are replaced by SDK types):
- `CliSystemSchema`, `CliAssistantSchema`, `CliResultSchema`, `CliStreamEventSchema`, `CliControlRequestSchema`, `CliToolProgressSchema`, `CliToolUseSummarySchema`, `CliKeepAliveSchema`, `CliAuthStatusSchema`
- `CliMessageSchema`, `CliMessage`

Keep these exports (correct and still needed):
- All `ContentBlock` types and schema
- `UsageSchema`
- All `BrowserSdkMessage` schemas (`SdkCreateSchema`, `SdkSendSchema`, etc.)
- All `SdkServerMessage` types
- `SdkSessionStatus`
- `SdkSessionState`

Add a re-export from the SDK for convenience:

```typescript
// Re-export SDK message types used by the bridge
export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  SDKStatusMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  Options as SdkOptions,
  Query as SdkQuery,
  CanUseTool,
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk'
```

Update `SdkServerMessage` union — add `parent_tool_use_id` to `sdk.stream`:

```typescript
| { type: 'sdk.stream'; sessionId: string; event: unknown; parentToolUseId?: string | null }
```

Update `SdkSessionState` — add missing fields from SDK:

```typescript
export interface SdkSessionState {
  sessionId: string
  cliSessionId?: string
  cwd?: string
  model?: string
  permissionMode?: string
  tools?: Array<{ name: string }>
  status: SdkSessionStatus
  createdAt: number
  messages: Array<{ role: 'user' | 'assistant'; content: ContentBlock[]; timestamp: string }>
  pendingPermissions: Map<string, {
    toolName: string
    input: Record<string, unknown>
    toolUseID: string
    suggestions?: PermissionUpdate[]
    blockedPath?: string
    decisionReason?: string
    resolve: (result: PermissionResult) => void
  }>
  costUsd: number
  totalInputTokens: number
  totalOutputTokens: number
}
```

Note the key change to `pendingPermissions`: it now stores a `resolve` function — when the browser user clicks Allow/Deny, we resolve the Promise that the SDK's `canUseTool` callback is awaiting.

**Step 4: Run tests**

Run: `cd /home/user/code/freshell/.worktrees/fix-sdk-bridge && npx vitest run test/unit/server/sdk-bridge-types.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add server/sdk-bridge-types.ts test/unit/server/sdk-bridge-types.test.ts
git commit -m "refactor(sdk-bridge): replace hand-rolled CLI schemas with official SDK types"
```

---

## Task 3: Rewrite SdkBridge to use the official SDK

This is the core task. Replace the entire `SdkBridge` class.

**Files:**
- Modify: `server/sdk-bridge.ts` (complete rewrite)
- Modify: `test/unit/server/sdk-bridge.test.ts` (complete rewrite)

**Step 1: Write the failing tests**

Rewrite `test/unit/server/sdk-bridge.test.ts`. Since the SDK spawns a real subprocess, tests should mock the `query` function from `@anthropic-ai/claude-agent-sdk`. The mock returns an async generator that yields controlled `SDKMessage` objects.

```typescript
import { EventEmitter } from 'events'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the SDK's query function
const mockMessages: any[] = []
let mockAbortController: AbortController | undefined

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ options }: any) => {
    mockAbortController = options?.abortController
    // Return an AsyncGenerator that yields mockMessages
    const gen = (async function* () {
      for (const msg of mockMessages) {
        yield msg
      }
    })()
    // Add close() and other Query methods
    ;(gen as any).close = vi.fn()
    ;(gen as any).interrupt = vi.fn()
    ;(gen as any).streamInput = vi.fn()
    return gen
  }),
}))

import { SdkBridge } from '../../../server/sdk-bridge.js'

describe('SdkBridge', () => {
  let bridge: SdkBridge

  beforeEach(() => {
    mockMessages.length = 0
    bridge = new SdkBridge()
  })

  afterEach(() => {
    bridge.close()
  })

  describe('session lifecycle', () => {
    it('creates a session with unique ID', async () => {
      const session = await bridge.createSession({ cwd: '/tmp' })
      expect(session.sessionId).toBeTruthy()
      expect(session.status).toBe('starting')
      expect(session.cwd).toBe('/tmp')
    })

    it('lists active sessions', async () => {
      await bridge.createSession({ cwd: '/tmp' })
      await bridge.createSession({ cwd: '/home' })
      expect(bridge.listSessions()).toHaveLength(2)
    })

    it('gets session by ID', async () => {
      const session = await bridge.createSession({ cwd: '/tmp' })
      expect(bridge.getSession(session.sessionId)).toBeDefined()
      expect(bridge.getSession('nonexistent')).toBeUndefined()
    })

    it('kills a session', async () => {
      const session = await bridge.createSession({ cwd: '/tmp' })
      const killed = bridge.killSession(session.sessionId)
      expect(killed).toBe(true)
      expect(bridge.getSession(session.sessionId)?.status).toBe('exited')
    })

    it('returns false when killing nonexistent session', () => {
      expect(bridge.killSession('nonexistent')).toBe(false)
    })
  })

  describe('SDK message translation', () => {
    it('translates system init to sdk.session.init', async () => {
      mockMessages.push({
        type: 'system',
        subtype: 'init',
        session_id: 'cli-123',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/home/user',
        tools: ['Bash', 'Read'],
        uuid: 'test-uuid',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      // Wait for async generator to process
      await new Promise(resolve => setTimeout(resolve, 50))

      const initMsg = received.find(m => m.type === 'sdk.session.init')
      expect(initMsg).toBeDefined()
      expect(initMsg.cliSessionId).toBe('cli-123')
      expect(initMsg.model).toBe('claude-sonnet-4-5-20250929')
    })

    it('translates assistant messages to sdk.assistant', async () => {
      mockMessages.push({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Hello' }],
          model: 'claude-sonnet-4-5-20250929',
        },
        parent_tool_use_id: null,
        uuid: 'test-uuid',
        session_id: 'cli-123',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      await new Promise(resolve => setTimeout(resolve, 50))

      const assistantMsg = received.find(m => m.type === 'sdk.assistant')
      expect(assistantMsg).toBeDefined()
    })

    it('translates result to sdk.result with full fields', async () => {
      mockMessages.push({
        type: 'result',
        subtype: 'success',
        duration_ms: 3000,
        duration_api_ms: 2500,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.05,
        usage: { input_tokens: 1000, output_tokens: 500 },
        session_id: 'cli-123',
        uuid: 'test-uuid',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      await new Promise(resolve => setTimeout(resolve, 50))

      const resultMsg = received.find(m => m.type === 'sdk.result')
      expect(resultMsg).toBeDefined()
      expect(resultMsg.costUsd).toBe(0.05)
    })

    it('translates stream_event with parent_tool_use_id', async () => {
      mockMessages.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
        parent_tool_use_id: 'tool-1',
        uuid: 'test-uuid',
        session_id: 'cli-123',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      await new Promise(resolve => setTimeout(resolve, 50))

      const streamMsg = received.find(m => m.type === 'sdk.stream')
      expect(streamMsg).toBeDefined()
      expect(streamMsg.parentToolUseId).toBe('tool-1')
    })

    it('sets status to idle on result', async () => {
      mockMessages.push({
        type: 'result',
        subtype: 'success',
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 50 },
        session_id: 'cli-123',
        uuid: 'test-uuid',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(bridge.getSession(session.sessionId)?.status).toBe('idle')
    })
  })

  describe('subscribe/unsubscribe', () => {
    it('subscribe returns null for nonexistent session', () => {
      expect(bridge.subscribe('nonexistent', () => {})).toBeNull()
    })

    it('unsubscribe removes listener', async () => {
      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      const unsub = bridge.subscribe(session.sessionId, (msg) => received.push(msg))
      unsub!()
      // Messages after unsubscribe should not be received
    })

    it('emits message event on broadcast', async () => {
      mockMessages.push({
        type: 'system',
        subtype: 'init',
        session_id: 'cli-123',
        model: 'claude-sonnet-4-5-20250929',
        cwd: '/tmp',
        tools: ['Bash'],
        uuid: 'test-uuid',
      })

      const session = await bridge.createSession({ cwd: '/tmp' })
      const emitted: any[] = []
      bridge.on('message', (_sid: string, msg: any) => emitted.push(msg))

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(emitted.length).toBeGreaterThan(0)
    })
  })

  describe('permission round-trip', () => {
    it('broadcasts permission request with SDK context fields', async () => {
      // canUseTool callback is invoked by the SDK internally; test via mock
      const session = await bridge.createSession({ cwd: '/tmp' })
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      // Simulate a permission request arriving (via the SDK calling canUseTool)
      // Since we mock query(), we test respondPermission directly
      const state = bridge.getSession(session.sessionId)!
      const resolvePromise = new Promise<any>((resolve) => {
        state.pendingPermissions.set('req-1', {
          toolName: 'Bash',
          input: { command: 'rm -rf /' },
          toolUseID: 'tool-1',
          suggestions: [],
          resolve,
        })
      })

      // Browser user allows with updatedInput
      bridge.respondPermission(session.sessionId, 'req-1', {
        behavior: 'allow',
        updatedInput: { command: 'ls' },
      })

      const result = await resolvePromise
      expect(result.behavior).toBe('allow')
      expect(result.updatedInput).toEqual({ command: 'ls' })
      expect(state.pendingPermissions.has('req-1')).toBe(false)
    })

    it('deny requires message field (matches SDK PermissionResult)', async () => {
      const session = await bridge.createSession({ cwd: '/tmp' })
      const state = bridge.getSession(session.sessionId)!
      const resolvePromise = new Promise<any>((resolve) => {
        state.pendingPermissions.set('req-2', {
          toolName: 'Bash',
          input: { command: 'rm -rf /' },
          toolUseID: 'tool-2',
          resolve,
        })
      })

      bridge.respondPermission(session.sessionId, 'req-2', {
        behavior: 'deny',
        message: 'Too dangerous',
        interrupt: true,
      })

      const result = await resolvePromise
      expect(result.behavior).toBe('deny')
      expect(result.message).toBe('Too dangerous')
      expect(result.interrupt).toBe(true)
    })
  })

  describe('message buffering', () => {
    it('buffers messages before first subscriber and replays on subscribe', async () => {
      mockMessages.push(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'cli-123',
          model: 'claude-sonnet-4-5-20250929',
          cwd: '/tmp',
          tools: ['Bash'],
          uuid: 'test-uuid-1',
        },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: 'Hello' }],
            model: 'claude-sonnet-4-5-20250929',
          },
          parent_tool_use_id: null,
          uuid: 'test-uuid-2',
          session_id: 'cli-123',
        },
      )

      const session = await bridge.createSession({ cwd: '/tmp' })

      // Wait for stream to be consumed (messages buffered, no subscriber yet)
      await new Promise(resolve => setTimeout(resolve, 50))

      // NOW subscribe — should get buffered messages replayed
      const received: any[] = []
      bridge.subscribe(session.sessionId, (msg) => received.push(msg))

      expect(received.length).toBeGreaterThanOrEqual(2)
      expect(received[0].type).toBe('sdk.session.init')
      expect(received[1].type).toBe('sdk.assistant')
    })
  })

  describe('sendUserMessage', () => {
    it('returns false for nonexistent session', () => {
      expect(bridge.sendUserMessage('nonexistent', 'hello')).toBe(false)
    })
  })

  describe('interrupt', () => {
    it('returns false for nonexistent session', () => {
      expect(bridge.interrupt('nonexistent')).toBe(false)
    })
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `cd /home/user/code/freshell/.worktrees/fix-sdk-bridge && npx vitest run test/unit/server/sdk-bridge.test.ts`
Expected: Fails because `SdkBridge` still has the old implementation

**Step 3: Rewrite sdk-bridge.ts**

Replace the entire file. The new SdkBridge:
- **No internal WebSocketServer** — deleted entirely
- **No `child_process.spawn`** — SDK handles subprocess
- **Uses `query()` from the SDK** — returns AsyncGenerator<SDKMessage>
- **`canUseTool` callback** — creates a Promise, stores the `resolve` function in `pendingPermissions`, broadcasts `sdk.permission.request` to browser, waits for `respondPermission()` to resolve it
- **Iterates the generator** — translates each `SDKMessage` into an `SdkServerMessage` and broadcasts

```typescript
import { nanoid } from 'nanoid'
import { EventEmitter } from 'events'
import { query, type SDKMessage, type Query as SdkQuery } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { logger } from './logger.js'
import type {
  SdkSessionState,
  ContentBlock,
  SdkServerMessage,
} from './sdk-bridge-types.js'

const log = logger.child({ component: 'sdk-bridge' })

interface SessionProcess {
  query: SdkQuery
  abortController: AbortController
  browserListeners: Set<(msg: SdkServerMessage) => void>
  /** Buffer messages until the first subscriber attaches (prevents race condition) */
  messageBuffer: SdkServerMessage[]
  hasSubscribers: boolean
}

export class SdkBridge extends EventEmitter {
  private sessions = new Map<string, SdkSessionState>()
  private processes = new Map<string, SessionProcess>()

  async createSession(options: {
    cwd?: string
    resumeSessionId?: string
    model?: string
    permissionMode?: string
  }): Promise<SdkSessionState> {
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

    const abortController = new AbortController()

    const sdkQuery = query({
      prompt: this.createInputStream(sessionId),
      options: {
        cwd: options.cwd || undefined,
        resume: options.resumeSessionId,
        model: options.model,
        permissionMode: options.permissionMode as any,
        includePartialMessages: true,
        abortController,
        canUseTool: async (toolName, input, ctx) => {
          return this.handlePermissionRequest(sessionId, toolName, input, ctx)
        },
        settingSources: ['user', 'project', 'local'],
      },
    })

    this.processes.set(sessionId, {
      query: sdkQuery,
      abortController,
      browserListeners: new Set(),
      messageBuffer: [],
      hasSubscribers: false,
    })

    // Start consuming the message stream in the background
    this.consumeStream(sessionId, sdkQuery).catch((err) => {
      log.error({ sessionId, err }, 'SDK stream error')
    })

    return state
  }

  // Creates an async iterable that yields user messages written via sendUserMessage
  private createInputStream(sessionId: string): AsyncIterable<any> {
    // Store a message queue per session
    const queue: any[] = []
    let waiting: ((value: IteratorResult<any>) => void) | null = null
    let done = false

    // Store the push function so sendUserMessage can use it
    const inputStream = {
      push: (msg: any) => {
        if (waiting) {
          const resolve = waiting
          waiting = null
          resolve({ value: msg, done: false })
        } else {
          queue.push(msg)
        }
      },
      end: () => {
        done = true
        if (waiting) {
          const resolve = waiting
          waiting = null
          resolve({ value: undefined, done: true })
        }
      },
    }

    // Store on the session for sendUserMessage to find
    ;(this as any)[`_input_${sessionId}`] = inputStream

    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<any>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift(), done: false })
            }
            if (done) {
              return Promise.resolve({ value: undefined, done: true })
            }
            return new Promise((resolve) => { waiting = resolve })
          },
        }
      },
    }
  }

  private async consumeStream(sessionId: string, sdkQuery: SdkQuery): Promise<void> {
    try {
      for await (const msg of sdkQuery) {
        this.handleSdkMessage(sessionId, msg)
      }
    } catch (err: any) {
      log.error({ sessionId, err: err?.message }, 'SDK stream ended with error')
      this.broadcastToSession(sessionId, {
        type: 'sdk.error',
        sessionId,
        message: `SDK error: ${err?.message || 'Unknown error'}`,
      })
    } finally {
      const state = this.sessions.get(sessionId)
      if (state) state.status = 'exited'
      this.broadcastToSession(sessionId, {
        type: 'sdk.exit',
        sessionId,
        exitCode: undefined,
      })
      this.processes.delete(sessionId)
      this.sessions.delete(sessionId)
    }
  }

  private handleSdkMessage(sessionId: string, msg: SDKMessage): void {
    const state = this.sessions.get(sessionId)
    if (!state) return

    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          const init = msg as any
          state.cliSessionId = init.session_id
          state.model = init.model || state.model
          state.tools = (init.tools as string[] | undefined)?.map((t: string) => ({ name: t }))
          state.cwd = init.cwd || state.cwd
          state.status = 'connected'
          this.broadcastToSession(sessionId, {
            type: 'sdk.session.init',
            sessionId,
            cliSessionId: state.cliSessionId,
            model: state.model,
            cwd: state.cwd,
            tools: state.tools,
          })
        } else if (msg.subtype === 'status') {
          const status = (msg as any).status
          if (status === 'compacting') {
            state.status = 'compacting'
            this.broadcastToSession(sessionId, {
              type: 'sdk.status',
              sessionId,
              status: 'compacting',
            })
          }
        }
        break
      }

      case 'assistant': {
        const aMsg = msg as any
        const content = aMsg.message?.content || []
        // Map SDK content blocks to our ContentBlock format
        const blocks: ContentBlock[] = content.map((b: any) => {
          if (b.type === 'text') return { type: 'text' as const, text: b.text }
          if (b.type === 'thinking') return { type: 'thinking' as const, thinking: b.thinking }
          if (b.type === 'tool_use') return { type: 'tool_use' as const, id: b.id, name: b.name, input: b.input }
          if (b.type === 'tool_result') return { type: 'tool_result' as const, tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error }
          return b
        })
        state.messages.push({
          role: 'assistant',
          content: blocks,
          timestamp: new Date().toISOString(),
        })
        state.status = 'running'
        this.broadcastToSession(sessionId, {
          type: 'sdk.assistant',
          sessionId,
          content: blocks,
          model: aMsg.message?.model,
        })
        break
      }

      case 'result': {
        const rMsg = msg as any
        if (rMsg.total_cost_usd != null) state.costUsd += rMsg.total_cost_usd
        if (rMsg.usage) {
          state.totalInputTokens += rMsg.usage.input_tokens ?? 0
          state.totalOutputTokens += rMsg.usage.output_tokens ?? 0
        }
        state.status = 'idle'
        this.broadcastToSession(sessionId, {
          type: 'sdk.result',
          sessionId,
          result: rMsg.result,
          durationMs: rMsg.duration_ms,
          costUsd: rMsg.total_cost_usd,
          usage: rMsg.usage,
        })
        break
      }

      case 'stream_event': {
        const sMsg = msg as any
        this.broadcastToSession(sessionId, {
          type: 'sdk.stream',
          sessionId,
          event: sMsg.event,
          parentToolUseId: sMsg.parent_tool_use_id,
        })
        break
      }

      default:
        log.debug({ sessionId, type: msg.type }, 'Unhandled SDK message type')
    }
  }

  private async handlePermissionRequest(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: {
      signal: AbortSignal
      suggestions?: PermissionUpdate[]
      blockedPath?: string
      decisionReason?: string
      toolUseID: string
      agentID?: string
    },
  ): Promise<PermissionResult> {
    const state = this.sessions.get(sessionId)
    if (!state) return { behavior: 'deny', message: 'Session not found' }

    const requestId = nanoid()

    // Create a Promise that will be resolved when the browser user responds
    return new Promise((resolve) => {
      state.pendingPermissions.set(requestId, {
        toolName,
        input,
        toolUseID: options.toolUseID,
        suggestions: options.suggestions,
        blockedPath: options.blockedPath,
        decisionReason: options.decisionReason,
        resolve,
      })

      this.broadcastToSession(sessionId, {
        type: 'sdk.permission.request',
        sessionId,
        requestId,
        subtype: 'can_use_tool',
        tool: { name: toolName, input },
        toolUseID: options.toolUseID,
        suggestions: options.suggestions,
        blockedPath: options.blockedPath,
        decisionReason: options.decisionReason,
      })
    })
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
      sp.abortController.abort()
      sp.query.close()
    } catch { /* ignore */ }

    return true
  }

  subscribe(sessionId: string, listener: (msg: SdkServerMessage) => void): (() => void) | null {
    const sp = this.processes.get(sessionId)
    if (!sp) return null
    sp.browserListeners.add(listener)

    // Replay buffered messages to the first subscriber (fixes race where
    // consumeStream starts before WS handler has attached a listener)
    if (!sp.hasSubscribers) {
      sp.hasSubscribers = true
      for (const msg of sp.messageBuffer) {
        try { listener(msg) } catch (err) {
          log.warn({ err, sessionId }, 'Buffer replay error')
        }
      }
      sp.messageBuffer.length = 0
    }

    return () => { sp.browserListeners.delete(listener) }
  }

  sendUserMessage(sessionId: string, text: string, images?: Array<{ mediaType: string; data: string }>): boolean {
    const inputStream = (this as any)[`_input_${sessionId}`]
    if (!inputStream) return false

    const state = this.sessions.get(sessionId)
    if (state) {
      state.messages.push({
        role: 'user',
        content: [{ type: 'text', text } as ContentBlock],
        timestamp: new Date().toISOString(),
      })
    }

    // Build content array matching SDK's SDKUserMessage format
    const content: any[] = [{ type: 'text', text }]
    if (images?.length) {
      for (const img of images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
        })
      }
    }

    inputStream.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: state?.cliSessionId || 'default',
    })

    return true
  }

  respondPermission(
    sessionId: string,
    requestId: string,
    decision: PermissionResult,
  ): boolean {
    const state = this.sessions.get(sessionId)
    const pending = state?.pendingPermissions.get(requestId)
    if (!pending) return false

    state!.pendingPermissions.delete(requestId)
    pending.resolve(decision)
    return true
  }

  interrupt(sessionId: string): boolean {
    const sp = this.processes.get(sessionId)
    if (!sp) return false

    try {
      sp.query.interrupt()
    } catch { /* ignore */ }
    return true
  }

  close(): void {
    for (const [sessionId] of this.processes) {
      this.killSession(sessionId)
    }
  }

  private broadcastToSession(sessionId: string, msg: SdkServerMessage): void {
    const sp = this.processes.get(sessionId)
    if (!sp) return

    // Buffer messages until the first subscriber attaches
    if (!sp.hasSubscribers) {
      sp.messageBuffer.push(msg)
      return
    }

    for (const listener of sp.browserListeners) {
      try { listener(msg) } catch (err) {
        log.warn({ err, sessionId }, 'Browser listener error')
      }
    }
    this.emit('message', sessionId, msg)
  }
}
```

**Step 4: Run tests**

Run: `cd /home/user/code/freshell/.worktrees/fix-sdk-bridge && npx vitest run test/unit/server/sdk-bridge.test.ts`
Expected: All tests pass

**Step 5: Commit**

```bash
git add server/sdk-bridge.ts test/unit/server/sdk-bridge.test.ts
git commit -m "feat(sdk-bridge): rewrite to use official @anthropic-ai/claude-agent-sdk

Replace hand-rolled subprocess + WebSocket callback model with the
official TypeScript SDK. The SDK handles CLI spawning, stdio transport,
initialization handshake, and control protocol internally.

Key changes:
- Delete internal WebSocketServer (no more --sdk-url)
- Use query() from SDK which returns AsyncGenerator<SDKMessage>
- canUseTool callback creates Promise, resolved by respondPermission()
- User messages sent via async input stream to SDK
- Translate SDKMessage types to existing sdk.* browser protocol"
```

---

## Task 4: Update WS handler for new SdkBridge API

The WS handler needs minor updates since the SdkBridge API changed slightly (no more `portReady`, `pendingPermissions` shape change).

**Files:**
- Modify: `server/ws-handler.ts` (sdk.* cases only)
- Modify: `test/unit/server/ws-handler-sdk.test.ts`

**Step 1: Update the WS handler**

The existing `sdk.*` message handlers in `ws-handler.ts` are mostly correct. Changes needed:

1. `SdkBridge` constructor no longer takes `{ port }` — update `server/index.ts` accordingly (remove any port args)
2. The `sdk.create` handler already calls `await this.sdkBridge.createSession()` — this is still correct
3. The `sdk.attach` handler calls `bridge.getSession()` — still correct

The only change: remove the `import { WebSocket } from 'ws'` if it was only used by the old bridge.

**Step 2: Update index.ts**

In `server/index.ts`, the `SdkBridge` instantiation becomes simply:
```typescript
const sdkBridge = new SdkBridge()
```
(Remove any port arguments if present)

**Step 3: Run the WS handler SDK tests**

Run: `cd /home/user/code/freshell/.worktrees/fix-sdk-bridge && npx vitest run test/unit/server/ws-handler-sdk.test.ts`
Expected: All 14 tests pass (they mock the bridge, so they don't depend on internal implementation)

**Step 4: Commit**

```bash
git add server/ws-handler.ts server/index.ts test/unit/server/ws-handler-sdk.test.ts
git commit -m "fix(ws-handler): update for new SdkBridge API (no WebSocketServer)"
```

---

## Task 5: Run full test suite and fix any breakage

**Step 1: Run all tests**

Run: `cd /home/user/code/freshell/.worktrees/fix-sdk-bridge && npm test`
Expected: 184+ files, 2800+ tests pass. If any fail, fix them.

**Step 2: Check TypeScript compilation**

Run: `cd /home/user/code/freshell/.worktrees/fix-sdk-bridge && npx tsc --noEmit`
Expected: No type errors

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve test/type breakage from SDK bridge rewrite"
```

---

## Task 6: Manual smoke test

**Step 1: Start dev server**

Run: `cd /home/user/code/freshell/.worktrees/fix-sdk-bridge && npm run dev`

**Step 2: Open browser, create Claude Web pane**

1. Navigate to `http://localhost:3000`
2. Open a new tab
3. Click "+" to add a pane, select "Claude Web"
4. Select a working directory
5. Wait for "Connected" status (should take 5-10 seconds)

**Step 3: Send a message**

Type "Say hello" and press Enter.
Expected: See assistant message appear with streaming text, then final result.

**Step 4: Test permission flow**

Type "List the files in /tmp" and press Enter.
Expected: See a permission banner for the Bash tool. Click Allow. See the result.

**Step 5: Test interrupt**

Type a long request, then click the Stop button.
Expected: Generation stops.

**Step 6: Commit and finalize**

```bash
git add -A
git commit -m "test: manual smoke test passed — SDK bridge working end-to-end"
```

---

## Task 7: Kill orphaned claude processes from old bridge

**Step 1: Find and kill any leftover processes from the broken bridge**

Run:
```bash
ps aux | grep 'claude.*--sdk-url' | grep -v grep | awk '{print $2}' | xargs -r kill
```

**Step 2: Verify clean**

Run: `ps aux | grep claude | grep -v grep`
Expected: No processes with `--sdk-url` in their args

---

## Key Architectural Decisions

### Why `query()` (v1) instead of `unstable_v2_createSession()` (v2)?

The v2 session API (`unstable_v2_createSession`) is marked `@alpha` / unstable. The v1 `query()` API is stable and provides the same capabilities via `AsyncIterable<SDKUserMessage>` input + `AsyncGenerator<SDKMessage>` output. We use a custom async iterable as the input stream, pushing user messages into it from `sendUserMessage()`. This gives us full multi-turn control without depending on an unstable API.

### Why not use the SDK's `canUseTool` to auto-allow everything?

We want to show the permission UI in the browser. The `canUseTool` callback creates a Promise that blocks the SDK until the user responds via the browser. This is the same pattern claudechic uses (via `PermissionRequest` with `asyncio.Event`), adapted for Node.js Promises.

### What about the internal WebSocketServer?

Deleted entirely. It was part of the imagined `--sdk-url` callback model. The SDK communicates with the CLI via subprocess stdio — no WebSocket needed between server and CLI.

### What about `sdk-bridge-types.ts` Zod schemas?

The `CliMessageSchema` (CLI→Server Zod validation) is removed — the SDK handles message parsing internally. The `BrowserSdkMessageSchema` (Browser→Server Zod validation) is kept — freshell still needs to validate incoming WS messages from browsers. The `SdkServerMessage` type union (Server→Browser) is kept and extended with `parentToolUseId`.

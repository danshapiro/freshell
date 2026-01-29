# Claude Chat UI Refactor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace terminal-based Claude rendering with a chat-style React UI that parses Claude Code's stream-json output, providing native scrollback, no flashing, and better UX.

**Architecture:** Run Claude Code in headless mode (`-p --output-format stream-json`) via child_process (not PTY). Parse NDJSON events server-side, stream to client via WebSocket. Render as React components with natural scrolling. Keep xterm.js terminal only for shell sessions.

**Tech Stack:** Node.js child_process, NDJSON parsing, React components, WebSocket streaming, existing Redux store

---

## Phase 1: Server-Side Claude Stream Parser

### Task 1: Create Claude Event Types

**Files:**
- Create: `server/claude-stream-types.ts`
- Test: `test/unit/server/claude-stream-types.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/server/claude-stream-types.test.ts
import { describe, it, expect } from 'vitest'
import {
  ClaudeEventType,
  parseClaudeEvent,
  isTextContent,
  isToolUseContent,
  isToolResultContent,
} from '../../server/claude-stream-types'

describe('claude-stream-types', () => {
  describe('parseClaudeEvent', () => {
    it('parses assistant text message', () => {
      const line = JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_123',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world' }],
        },
        session_id: 'session_abc',
        uuid: 'uuid_123',
      })

      const event = parseClaudeEvent(line)
      expect(event.type).toBe('assistant')
      expect(event.message.content[0].type).toBe('text')
    })

    it('parses system init event', () => {
      const line = JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'session_abc',
        cwd: '/home/user',
        model: 'claude-sonnet-4-5-20250929',
      })

      const event = parseClaudeEvent(line)
      expect(event.type).toBe('system')
      expect(event.subtype).toBe('init')
    })

    it('parses result event', () => {
      const line = JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1000,
        session_id: 'session_abc',
      })

      const event = parseClaudeEvent(line)
      expect(event.type).toBe('result')
      expect(event.is_error).toBe(false)
    })

    it('throws on invalid JSON', () => {
      expect(() => parseClaudeEvent('not json')).toThrow()
    })
  })

  describe('content type guards', () => {
    it('identifies text content', () => {
      expect(isTextContent({ type: 'text', text: 'hello' })).toBe(true)
      expect(isTextContent({ type: 'tool_use', id: '1', name: 'Bash', input: {} })).toBe(false)
    })

    it('identifies tool_use content', () => {
      expect(isToolUseContent({ type: 'tool_use', id: '1', name: 'Bash', input: {} })).toBe(true)
    })

    it('identifies tool_result content', () => {
      expect(isToolResultContent({ type: 'tool_result', tool_use_id: '1', content: '' })).toBe(true)
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/claude-stream-types.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// server/claude-stream-types.ts

// Event types from Claude Code stream-json output
export type ClaudeEventType = 'system' | 'assistant' | 'user' | 'result'

// Content block types
export interface TextContent {
  type: 'text'
  text: string
}

export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent

// Message structure
export interface ClaudeMessage {
  id?: string
  role: 'assistant' | 'user'
  content: ContentBlock[]
  model?: string
  stop_reason?: string | null
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

// System events
export interface SystemInitEvent {
  type: 'system'
  subtype: 'init'
  session_id: string
  cwd: string
  model: string
  tools: string[]
  claude_code_version: string
  uuid: string
}

export interface SystemHookEvent {
  type: 'system'
  subtype: 'hook_started' | 'hook_response'
  hook_id: string
  hook_name: string
  session_id: string
  uuid: string
  outcome?: 'success' | 'error'
  exit_code?: number
  stdout?: string
  stderr?: string
}

export type SystemEvent = SystemInitEvent | SystemHookEvent

// Assistant/User message events
export interface MessageEvent {
  type: 'assistant' | 'user'
  message: ClaudeMessage
  session_id: string
  uuid: string
  parent_tool_use_id?: string | null
  tool_use_result?: {
    stdout?: string
    stderr?: string
    interrupted?: boolean
    isImage?: boolean
  }
}

// Result event
export interface ResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  is_error: boolean
  duration_ms: number
  duration_api_ms?: number
  num_turns: number
  result?: string
  session_id: string
  total_cost_usd?: number
  usage?: ClaudeMessage['usage']
  uuid: string
}

export type ClaudeEvent = SystemEvent | MessageEvent | ResultEvent

// Type guards
export function isTextContent(block: ContentBlock): block is TextContent {
  return block.type === 'text'
}

export function isToolUseContent(block: ContentBlock): block is ToolUseContent {
  return block.type === 'tool_use'
}

export function isToolResultContent(block: ContentBlock): block is ToolResultContent {
  return block.type === 'tool_result'
}

export function isSystemEvent(event: ClaudeEvent): event is SystemEvent {
  return event.type === 'system'
}

export function isMessageEvent(event: ClaudeEvent): event is MessageEvent {
  return event.type === 'assistant' || event.type === 'user'
}

export function isResultEvent(event: ClaudeEvent): event is ResultEvent {
  return event.type === 'result'
}

// Parser
export function parseClaudeEvent(line: string): ClaudeEvent {
  const parsed = JSON.parse(line)
  return parsed as ClaudeEvent
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/claude-stream-types.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/claude-stream-types.ts test/unit/server/claude-stream-types.test.ts
git commit -m "feat: add Claude stream-json event types and parser

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 2: Create Claude Session Manager

**Files:**
- Create: `server/claude-session.ts`
- Test: `test/unit/server/claude-session.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/server/claude-session.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ClaudeSession, ClaudeSessionManager } from '../../server/claude-session'
import { EventEmitter } from 'events'

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

describe('ClaudeSession', () => {
  let mockProcess: any

  beforeEach(() => {
    mockProcess = new EventEmitter()
    mockProcess.stdout = new EventEmitter()
    mockProcess.stderr = new EventEmitter()
    mockProcess.stdin = { write: vi.fn(), end: vi.fn() }
    mockProcess.kill = vi.fn()
    mockProcess.pid = 12345

    const { spawn } = require('child_process')
    spawn.mockReturnValue(mockProcess)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('spawns claude with correct arguments', () => {
    const { spawn } = require('child_process')
    const session = new ClaudeSession({
      prompt: 'hello',
      cwd: '/test',
    })

    expect(spawn).toHaveBeenCalledWith(
      'claude',
      ['-p', 'hello', '--output-format', 'stream-json'],
      expect.objectContaining({
        cwd: '/test',
      })
    )
  })

  it('emits parsed events from stdout', async () => {
    const session = new ClaudeSession({ prompt: 'test' })
    const events: any[] = []
    session.on('event', (e) => events.push(e))

    const line = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      session_id: 'abc',
      uuid: '123',
    })

    mockProcess.stdout.emit('data', Buffer.from(line + '\n'))

    await new Promise((r) => setTimeout(r, 10))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('assistant')
  })

  it('emits error on stderr', async () => {
    const session = new ClaudeSession({ prompt: 'test' })
    const errors: string[] = []
    session.on('stderr', (e) => errors.push(e))

    mockProcess.stderr.emit('data', Buffer.from('error message'))

    await new Promise((r) => setTimeout(r, 10))
    expect(errors).toContain('error message')
  })

  it('emits exit on process close', async () => {
    const session = new ClaudeSession({ prompt: 'test' })
    let exitCode: number | null = null
    session.on('exit', (code) => { exitCode = code })

    mockProcess.emit('close', 0)

    await new Promise((r) => setTimeout(r, 10))
    expect(exitCode).toBe(0)
  })

  it('can send input to stdin', () => {
    const session = new ClaudeSession({ prompt: 'test' })
    session.sendInput('user input')

    expect(mockProcess.stdin.write).toHaveBeenCalledWith('user input')
  })

  it('can kill the process', () => {
    const session = new ClaudeSession({ prompt: 'test' })
    session.kill()

    expect(mockProcess.kill).toHaveBeenCalled()
  })
})

describe('ClaudeSessionManager', () => {
  let manager: ClaudeSessionManager

  beforeEach(() => {
    manager = new ClaudeSessionManager()
  })

  afterEach(() => {
    manager.shutdown()
  })

  it('creates sessions with unique IDs', () => {
    const session1 = manager.create({ prompt: 'test1' })
    const session2 = manager.create({ prompt: 'test2' })

    expect(session1.id).toBeDefined()
    expect(session2.id).toBeDefined()
    expect(session1.id).not.toBe(session2.id)
  })

  it('retrieves sessions by ID', () => {
    const session = manager.create({ prompt: 'test' })
    const retrieved = manager.get(session.id)

    expect(retrieved).toBe(session)
  })

  it('lists all sessions', () => {
    manager.create({ prompt: 'test1' })
    manager.create({ prompt: 'test2' })

    const list = manager.list()
    expect(list).toHaveLength(2)
  })

  it('removes sessions', () => {
    const session = manager.create({ prompt: 'test' })
    manager.remove(session.id)

    expect(manager.get(session.id)).toBeUndefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/claude-session.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// server/claude-session.ts
import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { nanoid } from 'nanoid'
import { ClaudeEvent, parseClaudeEvent } from './claude-stream-types'
import { logger } from './logger'

export interface ClaudeSessionOptions {
  prompt: string
  cwd?: string
  resumeSessionId?: string
  model?: string
  maxTurns?: number
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'
}

export interface ClaudeSessionInfo {
  id: string
  claudeSessionId?: string
  status: 'running' | 'completed' | 'error'
  createdAt: number
  prompt: string
  cwd?: string
  events: ClaudeEvent[]
}

export class ClaudeSession extends EventEmitter {
  readonly id: string
  private process: ChildProcess | null = null
  private buffer = ''
  private _status: 'running' | 'completed' | 'error' = 'running'
  private _claudeSessionId?: string
  private _events: ClaudeEvent[] = []
  readonly createdAt = Date.now()
  readonly prompt: string
  readonly cwd?: string

  constructor(options: ClaudeSessionOptions) {
    super()
    this.id = nanoid()
    this.prompt = options.prompt
    this.cwd = options.cwd
    this.spawn(options)
  }

  private spawn(options: ClaudeSessionOptions) {
    const args = ['-p', options.prompt, '--output-format', 'stream-json']

    if (options.resumeSessionId) {
      args.push('--resume', options.resumeSessionId)
    }
    if (options.model) {
      args.push('--model', options.model)
    }
    if (options.maxTurns) {
      args.push('--max-turns', String(options.maxTurns))
    }
    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode)
    }
    if (options.allowedTools?.length) {
      for (const tool of options.allowedTools) {
        args.push('--allowedTools', tool)
      }
    }
    if (options.disallowedTools?.length) {
      for (const tool of options.disallowedTools) {
        args.push('--disallowedTools', tool)
      }
    }

    const claudeCmd = process.env.CLAUDE_CMD || 'claude'
    logger.info({ id: this.id, cmd: claudeCmd, args, cwd: options.cwd }, 'Spawning Claude session')

    this.process = spawn(claudeCmd, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleStdout(data.toString())
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      logger.warn({ id: this.id, stderr: text }, 'Claude stderr')
      this.emit('stderr', text)
    })

    this.process.on('close', (code) => {
      this._status = code === 0 ? 'completed' : 'error'
      logger.info({ id: this.id, code }, 'Claude session closed')
      this.emit('exit', code)
    })

    this.process.on('error', (err) => {
      this._status = 'error'
      logger.error({ id: this.id, err }, 'Claude session error')
      this.emit('error', err)
    })
  }

  private handleStdout(data: string) {
    this.buffer += data
    const lines = this.buffer.split('\n')

    // Keep incomplete last line in buffer
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = parseClaudeEvent(line)
        this._events.push(event)

        // Extract Claude's session ID from init event
        if (event.type === 'system' && 'subtype' in event && event.subtype === 'init') {
          this._claudeSessionId = event.session_id
        }

        this.emit('event', event)
      } catch (err) {
        logger.warn({ id: this.id, line, err }, 'Failed to parse Claude event')
      }
    }
  }

  get status() {
    return this._status
  }

  get claudeSessionId() {
    return this._claudeSessionId
  }

  get events() {
    return this._events
  }

  getInfo(): ClaudeSessionInfo {
    return {
      id: this.id,
      claudeSessionId: this._claudeSessionId,
      status: this._status,
      createdAt: this.createdAt,
      prompt: this.prompt,
      cwd: this.cwd,
      events: this._events,
    }
  }

  sendInput(data: string) {
    if (this.process?.stdin) {
      this.process.stdin.write(data)
    }
  }

  kill() {
    if (this.process) {
      this.process.kill()
      this._status = 'error'
    }
  }
}

export class ClaudeSessionManager {
  private sessions = new Map<string, ClaudeSession>()

  create(options: ClaudeSessionOptions): ClaudeSession {
    const session = new ClaudeSession(options)
    this.sessions.set(session.id, session)

    session.on('exit', () => {
      // Keep session for history, don't auto-remove
    })

    return session
  }

  get(id: string): ClaudeSession | undefined {
    return this.sessions.get(id)
  }

  list(): ClaudeSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.getInfo())
  }

  remove(id: string): boolean {
    const session = this.sessions.get(id)
    if (session) {
      session.kill()
      this.sessions.delete(id)
      return true
    }
    return false
  }

  shutdown() {
    for (const session of this.sessions.values()) {
      session.kill()
    }
    this.sessions.clear()
  }
}

export const claudeSessionManager = new ClaudeSessionManager()
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/claude-session.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/claude-session.ts test/unit/server/claude-session.test.ts
git commit -m "feat: add ClaudeSession manager for stream-json parsing

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 3: Add WebSocket Message Types for Claude Events

**Files:**
- Modify: `server/ws-handler.ts`
- Test: `test/server/ws-claude-events.test.ts`

**Step 1: Write the failing test**

```typescript
// test/server/ws-claude-events.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'http'
import express from 'express'
import WebSocket from 'ws'
import { WsHandler } from '../../server/ws-handler'
import { TerminalRegistry } from '../../server/terminal-registry'
import { ClaudeSessionManager } from '../../server/claude-session'

describe('WebSocket Claude Events', () => {
  let server: http.Server
  let port: number
  let wsHandler: WsHandler
  let registry: TerminalRegistry
  let claudeManager: ClaudeSessionManager

  beforeAll(async () => {
    const app = express()
    server = http.createServer(app)
    registry = new TerminalRegistry()
    claudeManager = new ClaudeSessionManager()
    wsHandler = new WsHandler(server, registry, claudeManager)

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port
        resolve()
      })
    })
  })

  afterAll(async () => {
    claudeManager.shutdown()
    registry.shutdown()
    wsHandler.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function createAuthenticatedWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', token: process.env.AUTH_TOKEN || 'test-token' }))
      })
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve(ws)
      })
      ws.on('error', reject)
    })
  }

  it('accepts claude.create message', async () => {
    const ws = await createAuthenticatedWs()

    const responsePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'claude.created') resolve(msg)
      })
    })

    ws.send(JSON.stringify({
      type: 'claude.create',
      requestId: 'req-123',
      prompt: 'say hello',
      cwd: process.cwd(),
    }))

    const response = await responsePromise
    expect(response.type).toBe('claude.created')
    expect(response.sessionId).toBeDefined()
    expect(response.requestId).toBe('req-123')

    ws.close()
  })

  it('streams claude.event messages', async () => {
    const ws = await createAuthenticatedWs()
    const events: any[] = []

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'claude.event') events.push(msg)
    })

    ws.send(JSON.stringify({
      type: 'claude.create',
      requestId: 'req-456',
      prompt: 'say hi',
    }))

    // Wait for events
    await new Promise((r) => setTimeout(r, 5000))

    expect(events.length).toBeGreaterThan(0)
    ws.close()
  }, 10000)
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.server.config.ts test/server/ws-claude-events.test.ts`
Expected: FAIL (WsHandler doesn't accept claudeManager parameter yet)

**Step 3: Write minimal implementation**

Add to `server/ws-handler.ts`:

```typescript
// Add to imports
import { ClaudeSessionManager, ClaudeSession } from './claude-session'
import { ClaudeEvent } from './claude-stream-types'

// Add new message schemas (after existing schemas around line 98)
const claudeCreateSchema = z.object({
  type: z.literal('claude.create'),
  requestId: z.string(),
  prompt: z.string(),
  cwd: z.string().optional(),
  resumeSessionId: z.string().optional(),
  model: z.string().optional(),
  maxTurns: z.number().optional(),
  permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
})

const claudeInputSchema = z.object({
  type: z.literal('claude.input'),
  sessionId: z.string(),
  data: z.string(),
})

const claudeKillSchema = z.object({
  type: z.literal('claude.kill'),
  sessionId: z.string(),
})

// Modify constructor to accept ClaudeSessionManager
constructor(
  server: http.Server,
  private registry: TerminalRegistry,
  private claudeManager?: ClaudeSessionManager,
) {
  // ... existing code
}

// Add handler in handleMessage (after terminal handlers)
if (data.type === 'claude.create') {
  const parsed = claudeCreateSchema.safeParse(data)
  if (!parsed.success) {
    return this.sendError(ws, 'INVALID_MESSAGE', 'Invalid claude.create', data.requestId)
  }

  if (!this.claudeManager) {
    return this.sendError(ws, 'NOT_SUPPORTED', 'Claude sessions not enabled', data.requestId)
  }

  const session = this.claudeManager.create({
    prompt: parsed.data.prompt,
    cwd: parsed.data.cwd,
    resumeSessionId: parsed.data.resumeSessionId,
    model: parsed.data.model,
    maxTurns: parsed.data.maxTurns,
    permissionMode: parsed.data.permissionMode,
  })

  // Track this client for the session
  if (!state.claudeSessions) state.claudeSessions = new Set()
  state.claudeSessions.add(session.id)

  // Stream events to client
  session.on('event', (event: ClaudeEvent) => {
    this.safeSend(ws, {
      type: 'claude.event',
      sessionId: session.id,
      event,
    })
  })

  session.on('exit', (code: number) => {
    this.safeSend(ws, {
      type: 'claude.exit',
      sessionId: session.id,
      exitCode: code,
    })
  })

  session.on('stderr', (text: string) => {
    this.safeSend(ws, {
      type: 'claude.stderr',
      sessionId: session.id,
      text,
    })
  })

  this.safeSend(ws, {
    type: 'claude.created',
    requestId: parsed.data.requestId,
    sessionId: session.id,
  })
  return
}

if (data.type === 'claude.input') {
  const parsed = claudeInputSchema.safeParse(data)
  if (!parsed.success) {
    return this.sendError(ws, 'INVALID_MESSAGE', 'Invalid claude.input')
  }

  const session = this.claudeManager?.get(parsed.data.sessionId)
  if (!session) {
    return this.sendError(ws, 'NOT_FOUND', 'Session not found')
  }

  session.sendInput(parsed.data.data)
  return
}

if (data.type === 'claude.kill') {
  const parsed = claudeKillSchema.safeParse(data)
  if (!parsed.success) {
    return this.sendError(ws, 'INVALID_MESSAGE', 'Invalid claude.kill')
  }

  const removed = this.claudeManager?.remove(parsed.data.sessionId)
  this.safeSend(ws, {
    type: 'claude.killed',
    sessionId: parsed.data.sessionId,
    success: !!removed,
  })
  return
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.server.config.ts test/server/ws-claude-events.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/ws-handler.ts test/server/ws-claude-events.test.ts
git commit -m "feat: add WebSocket handlers for Claude stream events

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Phase 2: Client-Side Claude Components

### Task 4: Create Shared Claude Event Types for Client

**Files:**
- Create: `src/lib/claude-types.ts`

**Step 1: Create the types file**

```typescript
// src/lib/claude-types.ts

// Mirror server types for client use
export type ClaudeEventType = 'system' | 'assistant' | 'user' | 'result'

export interface TextContent {
  type: 'text'
  text: string
}

export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent

export interface ClaudeMessage {
  id?: string
  role: 'assistant' | 'user'
  content: ContentBlock[]
  model?: string
  usage?: {
    input_tokens: number
    output_tokens: number
  }
}

export interface SystemInitEvent {
  type: 'system'
  subtype: 'init'
  session_id: string
  cwd: string
  model: string
  tools: string[]
  claude_code_version: string
}

export interface MessageEvent {
  type: 'assistant' | 'user'
  message: ClaudeMessage
  session_id: string
  uuid: string
  tool_use_result?: {
    stdout?: string
    stderr?: string
    isImage?: boolean
  }
}

export interface ResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  is_error: boolean
  duration_ms: number
  total_cost_usd?: number
  session_id: string
}

export type ClaudeEvent = SystemInitEvent | MessageEvent | ResultEvent | { type: 'system'; subtype: string; [key: string]: unknown }

// Type guards
export function isTextContent(block: ContentBlock): block is TextContent {
  return block.type === 'text'
}

export function isToolUseContent(block: ContentBlock): block is ToolUseContent {
  return block.type === 'tool_use'
}

export function isToolResultContent(block: ContentBlock): block is ToolResultContent {
  return block.type === 'tool_result'
}

export function isMessageEvent(event: ClaudeEvent): event is MessageEvent {
  return event.type === 'assistant' || event.type === 'user'
}

export function isResultEvent(event: ClaudeEvent): event is ResultEvent {
  return event.type === 'result'
}

// WebSocket message types
export interface ClaudeWsEvent {
  type: 'claude.event'
  sessionId: string
  event: ClaudeEvent
}

export interface ClaudeWsCreated {
  type: 'claude.created'
  requestId: string
  sessionId: string
}

export interface ClaudeWsExit {
  type: 'claude.exit'
  sessionId: string
  exitCode: number
}

export type ClaudeWsMessage = ClaudeWsEvent | ClaudeWsCreated | ClaudeWsExit
```

**Step 2: Commit**

```bash
git add src/lib/claude-types.ts
git commit -m "feat: add client-side Claude event types

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 5: Create Claude Redux Slice

**Files:**
- Create: `src/store/claudeSlice.ts`
- Test: `test/unit/client/store/claudeSlice.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/client/store/claudeSlice.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import claudeReducer, {
  createClaudeSession,
  addClaudeEvent,
  setClaudeSessionStatus,
  clearClaudeSession,
} from '../../../../src/store/claudeSlice'
import type { ClaudeEvent } from '../../../../src/lib/claude-types'

function createTestStore(preloadedState = {}) {
  return configureStore({
    reducer: { claude: claudeReducer },
    preloadedState: { claude: { sessions: {}, ...preloadedState } },
  })
}

describe('claudeSlice', () => {
  describe('createClaudeSession', () => {
    it('creates a new session with empty events', () => {
      const store = createTestStore()
      store.dispatch(createClaudeSession({ sessionId: 'session-1', prompt: 'hello' }))

      const state = store.getState().claude
      expect(state.sessions['session-1']).toBeDefined()
      expect(state.sessions['session-1'].events).toEqual([])
      expect(state.sessions['session-1'].status).toBe('running')
      expect(state.sessions['session-1'].prompt).toBe('hello')
    })
  })

  describe('addClaudeEvent', () => {
    it('appends event to session', () => {
      const store = createTestStore()
      store.dispatch(createClaudeSession({ sessionId: 'session-1', prompt: 'test' }))

      const event: ClaudeEvent = {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        session_id: 'abc',
        uuid: '123',
      }
      store.dispatch(addClaudeEvent({ sessionId: 'session-1', event }))

      const state = store.getState().claude
      expect(state.sessions['session-1'].events).toHaveLength(1)
      expect(state.sessions['session-1'].events[0]).toEqual(event)
    })

    it('ignores events for unknown sessions', () => {
      const store = createTestStore()
      const event: ClaudeEvent = {
        type: 'assistant',
        message: { role: 'assistant', content: [] },
        session_id: 'x',
        uuid: 'y',
      }
      store.dispatch(addClaudeEvent({ sessionId: 'unknown', event }))

      const state = store.getState().claude
      expect(state.sessions['unknown']).toBeUndefined()
    })
  })

  describe('setClaudeSessionStatus', () => {
    it('updates session status', () => {
      const store = createTestStore()
      store.dispatch(createClaudeSession({ sessionId: 'session-1', prompt: 'test' }))
      store.dispatch(setClaudeSessionStatus({ sessionId: 'session-1', status: 'completed' }))

      const state = store.getState().claude
      expect(state.sessions['session-1'].status).toBe('completed')
    })
  })

  describe('clearClaudeSession', () => {
    it('removes session from state', () => {
      const store = createTestStore()
      store.dispatch(createClaudeSession({ sessionId: 'session-1', prompt: 'test' }))
      store.dispatch(clearClaudeSession({ sessionId: 'session-1' }))

      const state = store.getState().claude
      expect(state.sessions['session-1']).toBeUndefined()
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/store/claudeSlice.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// src/store/claudeSlice.ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { ClaudeEvent } from '@/lib/claude-types'

export interface ClaudeSessionState {
  sessionId: string
  prompt: string
  status: 'running' | 'completed' | 'error'
  events: ClaudeEvent[]
  claudeSessionId?: string
  cwd?: string
  createdAt: number
}

interface ClaudeState {
  sessions: Record<string, ClaudeSessionState>
}

const initialState: ClaudeState = {
  sessions: {},
}

const claudeSlice = createSlice({
  name: 'claude',
  initialState,
  reducers: {
    createClaudeSession(
      state,
      action: PayloadAction<{ sessionId: string; prompt: string; cwd?: string }>
    ) {
      state.sessions[action.payload.sessionId] = {
        sessionId: action.payload.sessionId,
        prompt: action.payload.prompt,
        cwd: action.payload.cwd,
        status: 'running',
        events: [],
        createdAt: Date.now(),
      }
    },

    addClaudeEvent(
      state,
      action: PayloadAction<{ sessionId: string; event: ClaudeEvent }>
    ) {
      const session = state.sessions[action.payload.sessionId]
      if (session) {
        session.events.push(action.payload.event)

        // Extract Claude's session ID from init event
        if (
          action.payload.event.type === 'system' &&
          'subtype' in action.payload.event &&
          action.payload.event.subtype === 'init'
        ) {
          session.claudeSessionId = action.payload.event.session_id
        }
      }
    },

    setClaudeSessionStatus(
      state,
      action: PayloadAction<{ sessionId: string; status: ClaudeSessionState['status'] }>
    ) {
      const session = state.sessions[action.payload.sessionId]
      if (session) {
        session.status = action.payload.status
      }
    },

    clearClaudeSession(state, action: PayloadAction<{ sessionId: string }>) {
      delete state.sessions[action.payload.sessionId]
    },
  },
})

export const {
  createClaudeSession,
  addClaudeEvent,
  setClaudeSessionStatus,
  clearClaudeSession,
} = claudeSlice.actions

export default claudeSlice.reducer
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/client/store/claudeSlice.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/store/claudeSlice.ts test/unit/client/store/claudeSlice.test.ts
git commit -m "feat: add Redux slice for Claude session state

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 6: Register Claude Slice in Store

**Files:**
- Modify: `src/store/store.ts`

**Step 1: Add import and reducer**

```typescript
// Add to imports
import claudeReducer from './claudeSlice'

// Add to reducer object
const rootReducer = {
  tabs: tabsReducer,
  connection: connectionReducer,
  sessions: sessionsReducer,
  settings: settingsReducer,
  claude: claudeReducer,  // Add this line
}
```

**Step 2: Run tests to verify nothing broke**

Run: `npx vitest run test/unit/client/store/`
Expected: PASS

**Step 3: Commit**

```bash
git add src/store/store.ts
git commit -m "feat: register Claude slice in Redux store

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 7: Create Message Bubble Components

**Files:**
- Create: `src/components/claude/MessageBubble.tsx`
- Create: `src/components/claude/ToolCallBlock.tsx`
- Create: `src/components/claude/ToolResultBlock.tsx`
- Test: `test/unit/client/components/claude/MessageBubble.test.tsx`

**Step 1: Write the failing test**

```typescript
// test/unit/client/components/claude/MessageBubble.test.tsx
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { MessageBubble } from '../../../../../src/components/claude/MessageBubble'
import type { MessageEvent } from '../../../../../src/lib/claude-types'

afterEach(() => cleanup())

describe('MessageBubble', () => {
  it('renders text content', () => {
    const event: MessageEvent = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello, world!' }],
      },
      session_id: 'abc',
      uuid: '123',
    }

    render(<MessageBubble event={event} />)
    expect(screen.getByText('Hello, world!')).toBeInTheDocument()
  })

  it('renders multiple text blocks', () => {
    const event: MessageEvent = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First paragraph' },
          { type: 'text', text: 'Second paragraph' },
        ],
      },
      session_id: 'abc',
      uuid: '123',
    }

    render(<MessageBubble event={event} />)
    expect(screen.getByText('First paragraph')).toBeInTheDocument()
    expect(screen.getByText('Second paragraph')).toBeInTheDocument()
  })

  it('renders tool_use blocks', () => {
    const event: MessageEvent = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'ls -la' },
          },
        ],
      },
      session_id: 'abc',
      uuid: '123',
    }

    render(<MessageBubble event={event} />)
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText(/ls -la/)).toBeInTheDocument()
  })

  it('applies assistant styling for assistant messages', () => {
    const event: MessageEvent = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      session_id: 'abc',
      uuid: '123',
    }

    const { container } = render(<MessageBubble event={event} />)
    expect(container.firstChild).toHaveClass('bg-muted')
  })

  it('applies user styling for user messages', () => {
    const event: MessageEvent = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      session_id: 'abc',
      uuid: '123',
    }

    const { container } = render(<MessageBubble event={event} />)
    expect(container.firstChild).toHaveClass('bg-primary')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/claude/MessageBubble.test.tsx`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// src/components/claude/ToolCallBlock.tsx
import { cn } from '@/lib/utils'
import type { ToolUseContent } from '@/lib/claude-types'

interface ToolCallBlockProps {
  tool: ToolUseContent
  className?: string
}

export function ToolCallBlock({ tool, className }: ToolCallBlockProps) {
  const inputStr = JSON.stringify(tool.input, null, 2)

  return (
    <div className={cn('rounded-md border bg-background/50 p-3 my-2', className)}>
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-2">
        <span className="text-xs bg-muted px-1.5 py-0.5 rounded">Tool</span>
        <span>{tool.name}</span>
      </div>
      <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-words bg-muted/50 p-2 rounded">
        {inputStr}
      </pre>
    </div>
  )
}
```

```typescript
// src/components/claude/ToolResultBlock.tsx
import { cn } from '@/lib/utils'
import type { ToolResultContent } from '@/lib/claude-types'

interface ToolResultBlockProps {
  result: ToolResultContent
  stdout?: string
  stderr?: string
  className?: string
}

export function ToolResultBlock({ result, stdout, stderr, className }: ToolResultBlockProps) {
  const content = stdout || result.content
  const hasError = result.is_error || !!stderr

  return (
    <div
      className={cn(
        'rounded-md border p-3 my-2',
        hasError ? 'border-destructive/50 bg-destructive/10' : 'bg-background/50',
        className
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-2">
        <span className={cn('text-xs px-1.5 py-0.5 rounded', hasError ? 'bg-destructive/20' : 'bg-muted')}>
          {hasError ? 'Error' : 'Result'}
        </span>
      </div>
      {content && (
        <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-words bg-muted/50 p-2 rounded max-h-64 overflow-y-auto">
          {content}
        </pre>
      )}
      {stderr && (
        <pre className="text-xs overflow-x-auto whitespace-pre-wrap break-words bg-destructive/10 p-2 rounded mt-2 text-destructive">
          {stderr}
        </pre>
      )}
    </div>
  )
}
```

```typescript
// src/components/claude/MessageBubble.tsx
import { cn } from '@/lib/utils'
import type { MessageEvent, ContentBlock } from '@/lib/claude-types'
import { isTextContent, isToolUseContent, isToolResultContent } from '@/lib/claude-types'
import { ToolCallBlock } from './ToolCallBlock'
import { ToolResultBlock } from './ToolResultBlock'

interface MessageBubbleProps {
  event: MessageEvent
  className?: string
}

export function MessageBubble({ event, className }: MessageBubbleProps) {
  const isAssistant = event.type === 'assistant'

  const renderContent = (block: ContentBlock, index: number) => {
    if (isTextContent(block)) {
      return (
        <div key={index} className="whitespace-pre-wrap break-words">
          {block.text}
        </div>
      )
    }

    if (isToolUseContent(block)) {
      return <ToolCallBlock key={index} tool={block} />
    }

    if (isToolResultContent(block)) {
      return (
        <ToolResultBlock
          key={index}
          result={block}
          stdout={event.tool_use_result?.stdout}
          stderr={event.tool_use_result?.stderr}
        />
      )
    }

    return null
  }

  return (
    <div
      className={cn(
        'rounded-lg px-4 py-3 max-w-[85%]',
        isAssistant ? 'bg-muted self-start' : 'bg-primary text-primary-foreground self-end',
        className
      )}
    >
      {event.message.content.map(renderContent)}
    </div>
  )
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/client/components/claude/MessageBubble.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/claude/
git add test/unit/client/components/claude/
git commit -m "feat: add Claude message bubble components

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 8: Create ClaudeSessionView Component

**Files:**
- Create: `src/components/ClaudeSessionView.tsx`
- Test: `test/unit/client/components/ClaudeSessionView.test.tsx`

**Step 1: Write the failing test**

```typescript
// test/unit/client/components/ClaudeSessionView.test.tsx
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import ClaudeSessionView from '../../../../../src/components/ClaudeSessionView'
import claudeReducer from '../../../../../src/store/claudeSlice'
import settingsReducer from '../../../../../src/store/settingsSlice'

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    onMessage: vi.fn(() => () => {}),
    connect: vi.fn().mockResolvedValue(undefined),
  }),
}))

function createTestStore(claudeState = {}) {
  return configureStore({
    reducer: {
      claude: claudeReducer,
      settings: settingsReducer,
    },
    preloadedState: {
      claude: {
        sessions: {
          'session-1': {
            sessionId: 'session-1',
            prompt: 'test prompt',
            status: 'running',
            events: [],
            createdAt: Date.now(),
          },
          ...claudeState,
        },
      },
    },
  })
}

afterEach(() => cleanup())

describe('ClaudeSessionView', () => {
  it('renders session prompt', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <ClaudeSessionView sessionId="session-1" />
      </Provider>
    )

    expect(screen.getByText(/test prompt/)).toBeInTheDocument()
  })

  it('renders message events', () => {
    const store = createTestStore({
      'session-1': {
        sessionId: 'session-1',
        prompt: 'test',
        status: 'running',
        events: [
          {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'Hello from Claude!' }],
            },
            session_id: 'abc',
            uuid: '123',
          },
        ],
        createdAt: Date.now(),
      },
    })

    render(
      <Provider store={store}>
        <ClaudeSessionView sessionId="session-1" />
      </Provider>
    )

    expect(screen.getByText('Hello from Claude!')).toBeInTheDocument()
  })

  it('shows loading state when no events', () => {
    const store = createTestStore()
    render(
      <Provider store={store}>
        <ClaudeSessionView sessionId="session-1" />
      </Provider>
    )

    expect(screen.getByText(/waiting/i)).toBeInTheDocument()
  })

  it('shows completed state', () => {
    const store = createTestStore({
      'session-1': {
        sessionId: 'session-1',
        prompt: 'test',
        status: 'completed',
        events: [
          {
            type: 'result',
            subtype: 'success',
            is_error: false,
            duration_ms: 1000,
            session_id: 'abc',
          },
        ],
        createdAt: Date.now(),
      },
    })

    render(
      <Provider store={store}>
        <ClaudeSessionView sessionId="session-1" />
      </Provider>
    )

    expect(screen.getByText(/completed/i)).toBeInTheDocument()
  })

  it('returns null for unknown session', () => {
    const store = createTestStore()
    const { container } = render(
      <Provider store={store}>
        <ClaudeSessionView sessionId="unknown" />
      </Provider>
    )

    expect(container.firstChild).toBeNull()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/ClaudeSessionView.test.tsx`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

```typescript
// src/components/ClaudeSessionView.tsx
import { useEffect, useRef } from 'react'
import { useAppSelector } from '@/store/hooks'
import { cn } from '@/lib/utils'
import { MessageBubble } from './claude/MessageBubble'
import { isMessageEvent, isResultEvent } from '@/lib/claude-types'
import type { ClaudeEvent } from '@/lib/claude-types'

interface ClaudeSessionViewProps {
  sessionId: string
  hidden?: boolean
}

export default function ClaudeSessionView({ sessionId, hidden }: ClaudeSessionViewProps) {
  const session = useAppSelector((s) => s.claude.sessions[sessionId])
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new events
  useEffect(() => {
    if (scrollRef.current && !hidden) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [session?.events.length, hidden])

  if (!session) return null

  const messageEvents = session.events.filter(isMessageEvent)
  const resultEvent = session.events.find(isResultEvent)

  return (
    <div className={cn('h-full w-full flex flex-col', hidden ? 'hidden' : '')}>
      {/* Header */}
      <div className="flex-none border-b px-4 py-2 bg-muted/30">
        <div className="text-sm text-muted-foreground truncate">
          Prompt: {session.prompt}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
          <span
            className={cn(
              'px-1.5 py-0.5 rounded',
              session.status === 'running' && 'bg-blue-500/20 text-blue-500',
              session.status === 'completed' && 'bg-green-500/20 text-green-500',
              session.status === 'error' && 'bg-red-500/20 text-red-500'
            )}
          >
            {session.status}
          </span>
          {session.claudeSessionId && (
            <span className="font-mono">{session.claudeSessionId.slice(0, 8)}...</span>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messageEvents.length === 0 && session.status === 'running' && (
          <div className="text-center text-muted-foreground py-8">
            <div className="animate-pulse">Waiting for response...</div>
          </div>
        )}

        {messageEvents.map((event, index) => (
          <MessageBubble key={index} event={event} />
        ))}

        {resultEvent && (
          <div className="text-center text-sm text-muted-foreground py-4 border-t mt-4">
            <span className="bg-muted px-2 py-1 rounded">
              Completed in {(resultEvent.duration_ms / 1000).toFixed(1)}s
              {resultEvent.total_cost_usd && ` • $${resultEvent.total_cost_usd.toFixed(4)}`}
            </span>
          </div>
        )}
      </div>

      {/* Input area (placeholder for now) */}
      <div className="flex-none border-t p-4 bg-muted/30">
        <div className="text-sm text-muted-foreground text-center">
          {session.status === 'running' ? (
            <span>Claude is working...</span>
          ) : (
            <span>Session {session.status}</span>
          )}
        </div>
      </div>
    </div>
  )
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/client/components/ClaudeSessionView.test.tsx`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/ClaudeSessionView.tsx test/unit/client/components/ClaudeSessionView.test.tsx
git commit -m "feat: add ClaudeSessionView component for chat-style rendering

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Phase 3: Integration

### Task 9: Update Tab Types to Support Claude Mode Rendering

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/tabsSlice.ts`

**Step 1: Update types**

Add to `src/store/types.ts`:

```typescript
// Modify Tab interface to include claudeSessionId
export interface Tab {
  id: string
  createRequestId: string
  title: string
  description?: string
  terminalId?: string          // For shell mode
  claudeSessionId?: string     // For claude mode (new field)
  status: 'creating' | 'running' | 'exited' | 'error'
  mode: 'shell' | 'claude' | 'codex'
  shell?: 'system' | 'cmd' | 'powershell' | 'wsl'
  initialCwd?: string
  resumeSessionId?: string
  createdAt: number
}
```

**Step 2: Update tabsSlice to support claudeSessionId**

```typescript
// In tabsSlice.ts updateTab reducer, ensure claudeSessionId can be set
updateTab(state, action: PayloadAction<{ id: string; updates: Partial<Tab> }>) {
  const tab = state.tabs.find((t) => t.id === action.payload.id)
  if (tab) {
    Object.assign(tab, action.payload.updates)
  }
}
```

**Step 3: Commit**

```bash
git add src/store/types.ts src/store/tabsSlice.ts
git commit -m "feat: add claudeSessionId field to Tab type

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 10: Create Unified TabContent Component

**Files:**
- Create: `src/components/TabContent.tsx`
- Modify: `src/App.tsx`

**Step 1: Create TabContent component**

```typescript
// src/components/TabContent.tsx
import TerminalView from './TerminalView'
import ClaudeSessionView from './ClaudeSessionView'
import { useAppSelector } from '@/store/hooks'

interface TabContentProps {
  tabId: string
  hidden?: boolean
}

export default function TabContent({ tabId, hidden }: TabContentProps) {
  const tab = useAppSelector((s) => s.tabs.tabs.find((t) => t.id === tabId))

  if (!tab) return null

  // Use ClaudeSessionView for claude mode with claudeSessionId
  if (tab.mode === 'claude' && tab.claudeSessionId) {
    return <ClaudeSessionView sessionId={tab.claudeSessionId} hidden={hidden} />
  }

  // Fall back to terminal for shell mode or claude without claudeSessionId yet
  return <TerminalView tabId={tabId} hidden={hidden} />
}
```

**Step 2: Update App.tsx to use TabContent**

Replace direct `TerminalView` usage with `TabContent`:

```typescript
// In App.tsx, replace:
<TerminalView tabId={tab.id} hidden={tab.id !== activeTabId} />

// With:
<TabContent tabId={tab.id} hidden={tab.id !== activeTabId} />
```

**Step 3: Commit**

```bash
git add src/components/TabContent.tsx src/App.tsx
git commit -m "feat: add TabContent component for mode-based rendering

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 11: Wire Up Claude WebSocket Events in Client

**Files:**
- Modify: `src/components/ClaudeSessionView.tsx`
- Modify: `src/lib/ws-client.ts`

**Step 1: Add Claude message handling to ws-client subscriptions**

Update `ClaudeSessionView` to dispatch Redux actions on WebSocket events:

```typescript
// In ClaudeSessionView.tsx, add WebSocket subscription effect
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { addClaudeEvent, setClaudeSessionStatus } from '@/store/claudeSlice'
import { getWsClient } from '@/lib/ws-client'

// Inside component:
const dispatch = useAppDispatch()
const ws = useMemo(() => getWsClient(), [])

useEffect(() => {
  const unsub = ws.onMessage((msg) => {
    if (msg.type === 'claude.event' && msg.sessionId === sessionId) {
      dispatch(addClaudeEvent({ sessionId, event: msg.event }))
    }
    if (msg.type === 'claude.exit' && msg.sessionId === sessionId) {
      dispatch(setClaudeSessionStatus({
        sessionId,
        status: msg.exitCode === 0 ? 'completed' : 'error',
      }))
    }
  })

  return unsub
}, [sessionId, dispatch, ws])
```

**Step 2: Commit**

```bash
git add src/components/ClaudeSessionView.tsx src/lib/ws-client.ts
git commit -m "feat: wire up Claude WebSocket events to Redux

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 12: Update Tab Creation to Use Claude Sessions

**Files:**
- Modify: `src/store/tabsSlice.ts` or create a thunk
- Modify: component that creates tabs (TabBar or similar)

**Step 1: Create async thunk for Claude tab creation**

```typescript
// src/store/claudeThunks.ts
import { createAsyncThunk } from '@reduxjs/toolkit'
import { getWsClient } from '@/lib/ws-client'
import { addTab, updateTab } from './tabsSlice'
import { createClaudeSession } from './claudeSlice'
import { nanoid } from 'nanoid'

export const createClaudeTab = createAsyncThunk(
  'claude/createTab',
  async (
    { prompt, cwd }: { prompt: string; cwd?: string },
    { dispatch }
  ) => {
    const tabId = nanoid()
    const requestId = tabId

    // Create tab in pending state
    dispatch(addTab({
      id: tabId,
      createRequestId: requestId,
      title: prompt.slice(0, 30) + (prompt.length > 30 ? '...' : ''),
      mode: 'claude',
      status: 'creating',
      initialCwd: cwd,
      createdAt: Date.now(),
    }))

    // Connect and send create request
    const ws = getWsClient()
    await ws.connect()

    return new Promise<string>((resolve, reject) => {
      const unsub = ws.onMessage((msg) => {
        if (msg.type === 'claude.created' && msg.requestId === requestId) {
          unsub()

          // Create Claude session in Redux
          dispatch(createClaudeSession({
            sessionId: msg.sessionId,
            prompt,
            cwd,
          }))

          // Link tab to Claude session
          dispatch(updateTab({
            id: tabId,
            updates: {
              claudeSessionId: msg.sessionId,
              status: 'running',
            },
          }))

          resolve(msg.sessionId)
        }
        if (msg.type === 'error' && msg.requestId === requestId) {
          unsub()
          dispatch(updateTab({ id: tabId, updates: { status: 'error' } }))
          reject(new Error(msg.message))
        }
      })

      ws.send({
        type: 'claude.create',
        requestId,
        prompt,
        cwd,
      })
    })
  }
)
```

**Step 2: Commit**

```bash
git add src/store/claudeThunks.ts
git commit -m "feat: add createClaudeTab thunk for Claude session creation

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 13: Update Server Index to Initialize ClaudeSessionManager

**Files:**
- Modify: `server/index.ts`

**Step 1: Initialize ClaudeSessionManager and pass to WsHandler**

```typescript
// In server/index.ts, add import
import { claudeSessionManager } from './claude-session'

// Modify WsHandler instantiation
const wsHandler = new WsHandler(server, registry, claudeSessionManager)

// Add to shutdown handler
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully')
  claudeSessionManager.shutdown()  // Add this
  registry.shutdown()
  wsHandler.close()
  process.exit(0)
})
```

**Step 2: Commit**

```bash
git add server/index.ts
git commit -m "feat: initialize ClaudeSessionManager in server

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

### Task 14: Add Integration Test for Full Flow

**Files:**
- Create: `test/integration/server/claude-session-flow.test.ts`

**Step 1: Write integration test**

```typescript
// test/integration/server/claude-session-flow.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import express from 'express'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler'
import { TerminalRegistry } from '../../../server/terminal-registry'
import { ClaudeSessionManager } from '../../../server/claude-session'

describe('Claude Session Flow Integration', () => {
  let server: http.Server
  let port: number
  let wsHandler: WsHandler
  let registry: TerminalRegistry
  let claudeManager: ClaudeSessionManager

  beforeAll(async () => {
    const app = express()
    server = http.createServer(app)
    registry = new TerminalRegistry()
    claudeManager = new ClaudeSessionManager()
    wsHandler = new WsHandler(server, registry, claudeManager)

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port
        resolve()
      })
    })
  })

  afterAll(async () => {
    claudeManager.shutdown()
    registry.shutdown()
    wsHandler.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function createAuthenticatedWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', token: process.env.AUTH_TOKEN || 'test-token' }))
      })
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ready') resolve(ws)
      })
      ws.on('error', reject)
      setTimeout(() => reject(new Error('Timeout')), 5000)
    })
  }

  it('creates session and streams events', async () => {
    const ws = await createAuthenticatedWs()
    const events: any[] = []
    let sessionId: string | null = null

    const done = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())

        if (msg.type === 'claude.created') {
          sessionId = msg.sessionId
        }

        if (msg.type === 'claude.event') {
          events.push(msg.event)
        }

        if (msg.type === 'claude.exit') {
          resolve()
        }
      })
    })

    ws.send(JSON.stringify({
      type: 'claude.create',
      requestId: 'test-req-1',
      prompt: 'say "hello world" and nothing else',
      permissionMode: 'bypassPermissions',
    }))

    await done

    expect(sessionId).toBeDefined()
    expect(events.length).toBeGreaterThan(0)

    // Should have at least init and result events
    const hasInit = events.some((e) => e.type === 'system' && e.subtype === 'init')
    const hasResult = events.some((e) => e.type === 'result')
    expect(hasInit || hasResult).toBe(true)

    ws.close()
  }, 30000)
})
```

**Step 2: Run test**

Run: `npx vitest run --config vitest.server.config.ts test/integration/server/claude-session-flow.test.ts`
Expected: PASS (may take time due to Claude API call)

**Step 3: Commit**

```bash
git add test/integration/server/claude-session-flow.test.ts
git commit -m "test: add integration test for Claude session flow

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Phase 4: Polish and Migration

### Task 15: Add UI for Creating Claude Sessions

**Files:**
- Modify: `src/components/TabBar.tsx` or `src/components/Sidebar.tsx`

Add a button or menu option to create a Claude session with a prompt input dialog.

*(Detailed implementation depends on current UI patterns - adapt to existing patterns)*

---

### Task 16: Update Documentation

**Files:**
- Create: `docs/claude-chat-mode.md`

Document:
- How Claude chat mode works
- Differences from terminal mode
- Supported Claude CLI flags
- Known limitations

---

### Task 17: Remove Terminal Flashing (Shell Mode Polish)

**Files:**
- Modify: `src/components/TerminalView.tsx`

Remove `term.clear()` calls that cause flashing:

```typescript
// Replace:
term.clear()
term.write(msg.snapshot)

// With:
term.write(msg.snapshot)
```

This keeps existing content and appends snapshot. May need additional logic to avoid duplicates.

---

### Task 18: Final Integration Test

Run full test suite:

```bash
npm run test:all
```

Verify all tests pass including new Claude-related tests.

---

## Summary

This plan transforms the Claude Code rendering from terminal-based to a chat-style React UI by:

1. **Server**: Spawning Claude via `child_process` with `--output-format stream-json`, parsing NDJSON events
2. **WebSocket**: New message types for Claude session lifecycle and event streaming
3. **Client**: Redux slice for Claude state, React components for message rendering
4. **Integration**: Tab system supports both terminal (shell) and chat (claude) modes

**Key Benefits:**
- Natural scrollback (React list, not terminal buffer)
- No flashing on reconnect (state in Redux)
- Searchable/selectable message history
- Better tool call visualization
- Future: easy to add features like copy, edit, regenerate

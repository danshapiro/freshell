# Codex Session Observability Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make future "live terminal disappeared and restore is unavailable" incidents root-causeable from persisted Freshell logs without adding heuristic recovery fallbacks.

**Architecture:** Add a low-volume, always-on session lifecycle JSONL log for terminal/session association events that must survive stdout loss and the UI debug toggle. Route Codex durable-session observation, session association broadcasts, terminal exits, and stale-terminal errors through one typed observability helper so every event has stable names, correlation ids, and no terminal input or token data.

**Tech Stack:** Node.js/Express, TypeScript ESM/NodeNext, Pino, rotating-file-stream, React, Redux Toolkit, Vitest, Testing Library.

---

## Context

The incident being addressed had this failure mode:

- Codex durable thread existed in `/home/user/.codex/sessions/2026/05/03/rollout-2026-05-03T16-54-38-019df043-f1fd-79d0-85c8-3ae11fb2237d.jsonl`.
- Freshell's pane did not have a canonical `sessionRef`.
- The browser still held a stale `terminalId`.
- The server returned `INVALID_TERMINAL_ID`.
- [TerminalView.tsx](/home/user/code/freshell/src/components/TerminalView.tsx:2215) showed `[Restore unavailable - the live terminal is gone and no durable session identity was saved]`.
- The main server had not restarted, but stdout/stderr were attached to a PTY, so there was no durable server-side event trail for why the live handle disappeared or why the association was missing.

This plan intentionally improves observability only. It does not add resume heuristics, inferred fallbacks, or any recovery path that invents a `sessionRef`.

## File Structure

- Modify: `server/logger.ts`
  - Owns persistent log-file path resolution and logger construction.
  - Add a separate file-only lifecycle logger that is not affected by `setLogLevel(resolveRuntimeLogLevel(false))`.
- Create: `server/session-observability.ts`
  - Owns typed session lifecycle event shapes and the single `recordSessionLifecycleEvent()` API.
  - Redacts/omits sensitive data by construction.
- Modify: `server/terminal-registry.ts`
  - Emits lifecycle events when Codex durable identity is observed/promoted, when terminal sessions bind/rebind, and when terminals exit without durable identity.
- Modify: `server/ws-handler.ts`
  - Emits lifecycle events for terminal create requests/results and `INVALID_TERMINAL_ID` responses on attach/input/resize when the server no longer has a live record.
  - Accepts a narrow client diagnostic message for the restore-unavailable UI path and records it in the lifecycle log.
- Modify: `shared/ws-protocol.ts`
  - Adds the client diagnostic websocket schema used only for restore-unavailable observability.
- Modify: `server/index.ts`
  - Emits lifecycle events for `terminal.session.associated` broadcasts from indexer, Claude fast-path, and OpenCode controller.
- Create: `server/session-association-broadcast.ts`
  - Owns the shared "record lifecycle event, broadcast `terminal.session.associated`, update metadata" sequence used by `server/index.ts`.
- Modify: `src/components/TerminalView.tsx`
  - Emits a client warning and sends a server-persisted diagnostic with pane/tab correlation when it renders the restore-unavailable message.
- Create: `test/unit/server/session-observability.test.ts`
  - Unit tests for event shape, severity routing, and sensitive-data exclusion.
- Modify: `test/unit/server/logger.test.ts`
  - Unit tests for lifecycle log path resolution and the always-on logger contract.
- Create: `test/server/ws-session-observability.test.ts`
  - Server tests proving stale terminal operations produce lifecycle events with `connectionId`, `terminalId`, and operation.
- Modify: `test/server/session-association.test.ts`
  - Server tests proving association and Codex durable promotion events are emitted once with the canonical provider/session id.
- Create: `test/server/session-association-broadcast.test.ts`
  - Unit tests proving each association broadcast source logs exactly one lifecycle event and sends the expected websocket message.
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
  - Client test proving the restore-unavailable path logs pane/tab correlation without changing UI behavior.
- Create: `docs/debugging/session-observability.md`
  - Human runbook for locating lifecycle logs and querying an incident by `terminalId`, `sessionId`, `requestId`, or `connectionId`.

## Acceptance Criteria

- A production server writes session lifecycle JSONL under the Freshell log directory even when UI debug logging is off.
- The log includes enough fields to answer:
  - Was a Codex durable session observed from the sidecar?
  - Was `terminal.session.associated` broadcast?
  - Did a terminal exit while still live-only?
  - Which websocket operation received `INVALID_TERMINAL_ID`?
  - Which tab/pane saw the restore-unavailable client error?
- The log never records terminal input data, auth tokens, full environment variables, or command-line args.
- Existing restore behavior remains unchanged.
- Focused unit/server/client tests pass.
- The coordinated full test suite passes before merge.

## Chunk 1: Persistent Lifecycle Log Sink

### Task 1: Add red tests for lifecycle log path resolution

**Files:**
- Modify: `test/unit/server/logger.test.ts`
- Modify: `server/logger.ts`

- [ ] **Step 1: Add failing tests for session lifecycle log path resolution**

Add these tests inside the existing `describe("debug log path resolution", () => { ... })` block in `test/unit/server/logger.test.ts`:

```ts
it(
  "resolves a session lifecycle log path under FRESHELL_LOG_DIR",
  async () => {
    const logDir = path.join(os.tmpdir(), "freshell-lifecycle-logs")
    const { resolveSessionLifecycleLogPath } = await import("../../../server/logger")

    const resolved = resolveSessionLifecycleLogPath(
      { FRESHELL_LOG_DIR: logDir, NODE_ENV: "production", PORT: "3333" } as NodeJS.ProcessEnv,
      "/home/test",
      ["node", "dist/server/index.js"],
    )

    expect(resolved).toBe(
      path.join(
        path.resolve(logDir),
        "session-lifecycle.production.3333.jsonl",
      ),
    )
  },
  TEST_TIMEOUT_MS,
)

it(
  "resolves a default session lifecycle log path under FRESHELL_HOME",
  async () => {
    const { resolveSessionLifecycleLogPath } = await import("../../../server/logger")

    const resolved = resolveSessionLifecycleLogPath(
      {
        FRESHELL_HOME: "/tmp/freshell-home",
        NODE_ENV: "production",
        FRESHELL_LOG_INSTANCE_ID: "prod-main",
      } as NodeJS.ProcessEnv,
      undefined,
      ["node", "dist/server/index.js"],
    )

    expect(resolved).toBe(
      path.join(
        "/tmp/freshell-home",
        ".freshell",
        "logs",
        "session-lifecycle.production.prod-main.jsonl",
      ),
    )
  },
  TEST_TIMEOUT_MS,
)

it(
  "skips session lifecycle log path under vitest unless explicitly requested",
  async () => {
    const { resolveSessionLifecycleLogPath } = await import("../../../server/logger")

    expect(resolveSessionLifecycleLogPath({ VITEST: "true" } as NodeJS.ProcessEnv, "/home/test")).toBeNull()
    expect(resolveSessionLifecycleLogPath({
      VITEST: "true",
      LOG_SESSION_LIFECYCLE_PATH: "/tmp/session-lifecycle.jsonl",
    } as NodeJS.ProcessEnv, "/home/test")).toBe("/tmp/session-lifecycle.jsonl")
  },
  TEST_TIMEOUT_MS,
)
```

- [ ] **Step 2: Run the logger tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/server/logger.test.ts --run
```

Expected: FAIL with `resolveSessionLifecycleLogPath` not exported.

- [ ] **Step 3: Implement the lifecycle log path resolver**

In `server/logger.ts`, add constants near the existing debug log constants:

```ts
const DEFAULT_SESSION_LIFECYCLE_LOG_FILE = 'session-lifecycle'
const DEFAULT_SESSION_LIFECYCLE_LOG_SUFFIX = '.jsonl'
const DEFAULT_SESSION_LIFECYCLE_LOG_SIZE: SizeString = '10M'
const DEFAULT_SESSION_LIFECYCLE_LOG_MAX_FILES = 10
```

Add this exported resolver near `resolveDebugLogPath()`:

```ts
export function resolveSessionLifecycleLogPath(
  envVars: NodeJS.ProcessEnv = process.env,
  homeDir: string = getFreshellHomeDir(envVars),
  argv: string[] = process.argv,
): string | null {
  const explicitPath = envVars.LOG_SESSION_LIFECYCLE_PATH?.trim()
  if (explicitPath) return path.resolve(explicitPath)
  if (isTestRuntime(envVars)) return null

  const logDirOverride = envVars.FRESHELL_LOG_DIR?.trim()
  const logDir = logDirOverride ? path.resolve(logDirOverride) : path.join(homeDir, '.freshell', 'logs')
  const mode = resolveDebugLogMode(envVars, argv)
  const instance = resolveDebugInstanceTag(envVars)
  return path.join(logDir, `${DEFAULT_SESSION_LIFECYCLE_LOG_FILE}.${mode}.${instance}${DEFAULT_SESSION_LIFECYCLE_LOG_SUFFIX}`)
}
```

- [ ] **Step 4: Run the logger tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/server/logger.test.ts --run
```

Expected: PASS.

### Task 2: Add the always-on lifecycle logger

**Files:**
- Modify: `server/logger.ts`
- Modify: `test/unit/server/logger.test.ts`

- [ ] **Step 1: Add a failing test for lifecycle logger creation**

Append this test to `test/unit/server/logger.test.ts`:

```ts
it(
  "creates the session lifecycle logger at info level independent of runtime debug level",
  async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "freshell-lifecycle-"))
    const filePath = path.join(tempDir, "session-lifecycle.jsonl")
    const { createSessionLifecycleLogger, setLogLevel, logger } = await import("../../../server/logger")

    setLogLevel("warn")
    const lifecycleLogger = createSessionLifecycleLogger(filePath)

    lifecycleLogger.info({ event: "session_lifecycle_test" }, "session_lifecycle_test")
    await new Promise((resolve) => setTimeout(resolve, 50))

    const content = await fsp.readFile(filePath, "utf8")
    expect(logger.level).toBe("warn")
    expect(lifecycleLogger.level).toBe("info")
    expect(content).toContain("session_lifecycle_test")
  },
  TEST_TIMEOUT_MS,
)
```

- [ ] **Step 2: Run the logger tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/server/logger.test.ts --run
```

Expected: FAIL with `createSessionLifecycleLogger` not exported.

- [ ] **Step 3: Implement the lifecycle logger**

In `server/logger.ts`, refactor `createPinoOptions()` to accept an optional level:

```ts
function createPinoOptions(options: { level?: LevelWithSilent } = {}) {
  return {
    level: options.level ?? level,
    base: {
      app: 'freshell',
      env,
      version: appVersion,
    },
    formatters: {
      level(label: string, number: number) {
        return { level: number, severity: label }
      },
    },
    mixin() {
      const ctx = logContext.getStore()
      return ctx ? { ...ctx } : {}
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  }
}
```

Add this exported logger factory after `createDebugFileStream()`:

```ts
export function createSessionLifecycleLogger(filePath: string) {
  const stream = createDebugFileStream(filePath, {
    size: DEFAULT_SESSION_LIFECYCLE_LOG_SIZE,
    maxFiles: DEFAULT_SESSION_LIFECYCLE_LOG_MAX_FILES,
  })
  return pino(createPinoOptions({ level: 'info' }), stream)
}
```

Add the exported singleton after `export const logger = createLogger()`:

```ts
const sessionLifecycleLogPath = resolveSessionLifecycleLogPath()
export const sessionLifecycleLogger = sessionLifecycleLogPath
  ? createSessionLifecycleLogger(sessionLifecycleLogPath)
  : logger.child({ component: 'session-lifecycle-disabled' })
```

- [ ] **Step 4: Run the logger tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/server/logger.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit Chunk 1**

Run:

```bash
git add server/logger.ts test/unit/server/logger.test.ts
git commit -m "feat: add session lifecycle log sink"
```

Expected: commit succeeds.

## Chunk 2: Typed Session Observability Events

### Task 3: Add red tests for event routing and redaction

**Files:**
- Create: `test/unit/server/session-observability.test.ts`
- Create: `server/session-observability.ts`

- [ ] **Step 1: Create the failing unit test**

Create `test/unit/server/session-observability.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setSessionLifecycleLoggerForTest,
  recordSessionLifecycleEvent,
} from '../../../server/session-observability'

describe('session observability', () => {
  const info = vi.fn()
  const warn = vi.fn()

  beforeEach(() => {
    info.mockReset()
    warn.mockReset()
    __setSessionLifecycleLoggerForTest({ info, warn })
  })

  it('records normal lifecycle events at info with a stable event envelope', () => {
    recordSessionLifecycleEvent({
      kind: 'session_association_broadcast',
      provider: 'codex',
      terminalId: 'term-1',
      sessionId: 'thread-1',
      source: 'indexer_update',
    })

    expect(info).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
    expect(info.mock.calls[0][0]).toMatchObject({
      event: 'session_lifecycle',
      kind: 'session_association_broadcast',
      provider: 'codex',
      terminalId: 'term-1',
      sessionId: 'thread-1',
      source: 'indexer_update',
    })
    expect(info.mock.calls[0][1]).toBe('session_association_broadcast')
  })

  it('records incident events at warn and never logs terminal input data', () => {
    recordSessionLifecycleEvent({
      kind: 'invalid_terminal_id_without_session_ref',
      provider: 'codex',
      terminalId: 'term-stale',
      connectionId: 'conn-1',
      operation: 'terminal.input',
      tabId: 'tab-1',
      paneId: 'pane-1',
      attemptedInputBytes: 120,
      input: 'terminal input should never be logged',
      env: { AUTH_TOKEN: 'secret-token' },
      args: ['--token', 'secret-token'],
    } as any)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(info).not.toHaveBeenCalled()
    const payload = warn.mock.calls[0][0]
    expect(payload).toMatchObject({
      event: 'session_lifecycle',
      kind: 'invalid_terminal_id_without_session_ref',
      terminalId: 'term-stale',
      operation: 'terminal.input',
      attemptedInputBytes: 120,
    })
    expect(JSON.stringify(payload)).not.toContain('terminal input')
    expect(JSON.stringify(payload)).not.toContain('AUTH_TOKEN')
    expect(JSON.stringify(payload)).not.toContain('secret-token')
  })
})
```

- [ ] **Step 2: Run the new test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/server/session-observability.test.ts --run
```

Expected: FAIL because `server/session-observability.ts` does not exist.

- [ ] **Step 3: Implement the typed observability helper**

Create `server/session-observability.ts`:

```ts
import { sessionLifecycleLogger } from './logger.js'
import type { CodingCliProviderName } from './coding-cli/types.js'
import type { TerminalMode } from './terminal-registry.js'

type SessionLifecycleSink = Pick<typeof sessionLifecycleLogger, 'info' | 'warn'>

type OptionalUiContext = {
  tabId?: string
  paneId?: string
  cwd?: string
}

export type SessionLifecycleEvent =
  | (OptionalUiContext & {
    kind: 'terminal_create_requested'
    requestId: string
    connectionId: string
    mode: TerminalMode
    restoreRequested: boolean
    hasRequestedSessionRef: boolean
    requestedSessionId?: string
  })
  | (OptionalUiContext & {
    kind: 'terminal_created'
    requestId: string
    connectionId: string
    terminalId: string
    mode: TerminalMode
    reused: boolean
    hasSessionRef: boolean
  })
  | {
    kind: 'codex_durable_session_observed'
    provider: 'codex'
    terminalId: string
    sessionId: string
    generation: number
    attemptId?: string
    source: 'sidecar'
  }
  | {
    kind: 'session_association_broadcast'
    provider: CodingCliProviderName
    terminalId: string
    sessionId: string
    source: 'indexer_update' | 'claude_new_session' | 'opencode_controller'
  }
  | {
    kind: 'terminal_session_bound'
    provider: CodingCliProviderName
    terminalId: string
    sessionId: string
    reason: string
  }
  | {
    kind: 'terminal_exit_without_durable_session'
    terminalId: string
    mode: TerminalMode
    exitCode: number
    ageMs: number
    reason: 'pty_exit' | 'user_final_close'
    ptyPid?: number
    codexRecoveryState?: string
  }
  | (OptionalUiContext & {
    kind: 'invalid_terminal_id_without_session_ref'
    provider?: CodingCliProviderName
    terminalId: string
    connectionId: string
    operation: 'terminal.attach' | 'terminal.input' | 'terminal.resize'
    attemptedInputBytes?: number
  })
  | (OptionalUiContext & {
    kind: 'client_restore_unavailable'
    terminalId: string
    connectionId: string
    mode: string
    reason: 'dead_live_handle'
    hasSessionRef: false
  })

let sink: SessionLifecycleSink = sessionLifecycleLogger

export function __setSessionLifecycleLoggerForTest(next: SessionLifecycleSink): void {
  sink = next
}

function isIncidentEvent(kind: SessionLifecycleEvent['kind']): boolean {
  return kind === 'terminal_exit_without_durable_session'
    || kind === 'invalid_terminal_id_without_session_ref'
    || kind === 'client_restore_unavailable'
}

function buildPayload(event: SessionLifecycleEvent): Record<string, unknown> {
  const base = {
    event: 'session_lifecycle',
    observedAt: new Date().toISOString(),
    kind: event.kind,
  }

  switch (event.kind) {
    case 'terminal_create_requested':
      return {
        ...base,
        requestId: event.requestId,
        connectionId: event.connectionId,
        tabId: event.tabId,
        paneId: event.paneId,
        cwd: event.cwd,
        mode: event.mode,
        restoreRequested: event.restoreRequested,
        hasRequestedSessionRef: event.hasRequestedSessionRef,
        requestedSessionId: event.requestedSessionId,
      }
    case 'terminal_created':
      return {
        ...base,
        requestId: event.requestId,
        connectionId: event.connectionId,
        terminalId: event.terminalId,
        tabId: event.tabId,
        paneId: event.paneId,
        cwd: event.cwd,
        mode: event.mode,
        reused: event.reused,
        hasSessionRef: event.hasSessionRef,
      }
    case 'codex_durable_session_observed':
      return { ...base, provider: event.provider, terminalId: event.terminalId, sessionId: event.sessionId, generation: event.generation, attemptId: event.attemptId, source: event.source }
    case 'session_association_broadcast':
      return { ...base, provider: event.provider, terminalId: event.terminalId, sessionId: event.sessionId, source: event.source }
    case 'terminal_session_bound':
      return { ...base, provider: event.provider, terminalId: event.terminalId, sessionId: event.sessionId, reason: event.reason }
    case 'terminal_exit_without_durable_session':
      return { ...base, terminalId: event.terminalId, mode: event.mode, exitCode: event.exitCode, ageMs: event.ageMs, reason: event.reason, ptyPid: event.ptyPid, codexRecoveryState: event.codexRecoveryState }
    case 'invalid_terminal_id_without_session_ref':
      return { ...base, provider: event.provider, terminalId: event.terminalId, connectionId: event.connectionId, tabId: event.tabId, paneId: event.paneId, cwd: event.cwd, operation: event.operation, attemptedInputBytes: event.attemptedInputBytes }
    case 'client_restore_unavailable':
      return { ...base, terminalId: event.terminalId, connectionId: event.connectionId, tabId: event.tabId, paneId: event.paneId, cwd: event.cwd, mode: event.mode, reason: event.reason, hasSessionRef: event.hasSessionRef }
  }
}

export function recordSessionLifecycleEvent(event: SessionLifecycleEvent): void {
  const payload = buildPayload(event)
  if (isIncidentEvent(event.kind)) {
    sink.warn(payload, event.kind)
  } else {
    sink.info(payload, event.kind)
  }
}
```

- [ ] **Step 4: Run the observability unit test and verify it passes**

Run:

```bash
npm run test:vitest -- test/unit/server/session-observability.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Run a focused typecheck for the typed API contract**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

Run:

```bash
git add server/session-observability.ts test/unit/server/session-observability.test.ts
git commit -m "feat: add session lifecycle event helper"
```

Expected: commit succeeds.

## Chunk 3: Server Instrumentation

### Task 4: Instrument terminal registry binding and exits

**Files:**
- Modify: `server/terminal-registry.ts`
- Modify: `test/server/session-association.test.ts`

- [ ] **Step 1: Add failing registry observability tests**

At the top of `test/server/session-association.test.ts`, mock the observability helper:

```ts
vi.mock('../../server/session-observability.js', () => ({
  recordSessionLifecycleEvent: vi.fn(),
}))
```

Import the mock after the existing imports:

```ts
import { recordSessionLifecycleEvent } from '../../server/session-observability'
```

Add this test to the `SessionAssociationCoordinator integration` describe block:

```ts
it('records a lifecycle event when Codex durable identity is explicitly bound', () => {
  const registry = new TerminalRegistry()
  const terminal = registry.create({ mode: 'codex', cwd: '/home/user/project' })

  registry.rebindSession(terminal.terminalId, 'codex', 'codex-thread-1', 'association')

  expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
    kind: 'terminal_session_bound',
    provider: 'codex',
    terminalId: terminal.terminalId,
    sessionId: 'codex-thread-1',
    reason: 'association',
  })

  registry.shutdown()
})
```

Add this test for a live-only exit:

```ts
it('records a lifecycle warning when a Codex terminal exits before durable identity exists', () => {
  const registry = new TerminalRegistry()
  const terminal = registry.create({ mode: 'codex', cwd: '/home/user/project' })
  const pty = terminal.pty as unknown as { onExit: ReturnType<typeof vi.fn> }
  const onExit = pty.onExit.mock.calls[0][0]

  onExit({ exitCode: 0, signal: 0 })

  expect(recordSessionLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'terminal_exit_without_durable_session',
    terminalId: terminal.terminalId,
    mode: 'codex',
    exitCode: 0,
    reason: 'pty_exit',
  }))

  registry.shutdown()
})
```

- [ ] **Step 2: Add a failing Codex durable observation test**

Add this test to the same describe block:

```ts
it('records a lifecycle event when the Codex sidecar reports durable identity', () => {
  let onDurableSession: ((sessionId: string) => void) | undefined
  const sidecar = {
    attachTerminal: vi.fn((callbacks: { onDurableSession: (sessionId: string) => void }) => {
      onDurableSession = callbacks.onDurableSession
    }),
    shutdown: vi.fn(async () => undefined),
  }
  const registry = new TerminalRegistry()
  const terminal = registry.create({
    mode: 'codex',
    cwd: '/home/user/project',
    codexSidecar: sidecar,
  })

  onDurableSession?.('codex-thread-1')
  onDurableSession?.('codex-thread-1')

  const durableObservationCalls = vi.mocked(recordSessionLifecycleEvent).mock.calls.filter(([event]) =>
    event.kind === 'codex_durable_session_observed'
  )
  expect(durableObservationCalls).toEqual([[
    {
    kind: 'codex_durable_session_observed',
    provider: 'codex',
    terminalId: terminal.terminalId,
    sessionId: 'codex-thread-1',
    generation: 0,
    source: 'sidecar',
    },
  ]])

  registry.shutdown()
})
```

- [ ] **Step 3: Run the session association tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/server/session-association.test.ts --run
```

Expected: FAIL because `terminal-registry.ts` does not emit lifecycle events yet.

- [ ] **Step 4: Emit binding, durable-observation, and exit events in the registry**

In `server/terminal-registry.ts`, add:

```ts
import { recordSessionLifecycleEvent } from './session-observability.js'
```

Inside `bindSession()`, immediately before or after `this.emit('terminal.session.bound', ...)`, add:

```ts
recordSessionLifecycleEvent({
  kind: 'terminal_session_bound',
  terminalId,
  provider,
  sessionId: normalized,
  reason,
})
```

Inside `promoteCodexDurableSession()`, after conflict/retiring checks and before assigning `codex.durableSessionId = sessionId`, add an idempotent observation log:

```ts
const alreadyObservedDurableSession = codex.durableSessionId === sessionId
if (!alreadyObservedDurableSession) {
  recordSessionLifecycleEvent({
    kind: 'codex_durable_session_observed',
    provider: 'codex',
    terminalId: record.terminalId,
    sessionId,
    generation,
    source: 'sidecar',
  })
}
```

Inside `finalizeTerminalExit()`, before `this.releaseBinding(terminalId, 'exit')`, add:

```ts
const hadDurableSession = Boolean(record.resumeSessionId)
if (record.mode !== 'shell' && !hadDurableSession) {
  recordSessionLifecycleEvent({
    kind: 'terminal_exit_without_durable_session',
    terminalId,
    mode: record.mode,
    exitCode: finalExitCode,
    ageMs: Math.max(0, now - record.createdAt),
    reason: _reason,
    ...(record.pty.pid ? { ptyPid: record.pty.pid } : {}),
    ...(record.codex?.recoveryState ? { codexRecoveryState: record.codex.recoveryState } : {}),
  })
}
```

- [ ] **Step 5: Run the session association tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/server/session-association.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

Run:

```bash
git add server/terminal-registry.ts test/server/session-association.test.ts
git commit -m "feat: record terminal session lifecycle events"
```

Expected: commit succeeds.

### Task 5: Instrument websocket terminal create and stale-terminal errors

**Files:**
- Modify: `server/ws-handler.ts`
- Create: `test/server/ws-session-observability.test.ts`

- [ ] **Step 1: Create failing websocket observability tests for terminal create**

Create `test/server/ws-session-observability.test.ts` using the constructor/setup style from `test/server/ws-terminal-create-session-repair.test.ts`. Keep the test narrow: instantiate `WsHandler` with a mocked registry whose `create()` returns a terminal record and whose `input()`, `resize()`, and `get()` can return missing/not-running results.

Core create assertions:

```ts
expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
  kind: 'terminal_create_requested',
  requestId: 'req-create-1',
  connectionId: 'conn-1',
  tabId: 'tab-1',
  paneId: 'pane-1',
  cwd: '/home/user/project',
  mode: 'shell',
  restoreRequested: false,
  hasRequestedSessionRef: false,
})
```

and:

```ts
expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
  kind: 'terminal_created',
  requestId: 'req-create-1',
  connectionId: 'conn-1',
  terminalId: 'term-created-1',
  tabId: 'tab-1',
  paneId: 'pane-1',
  cwd: '/home/user/project',
  mode: 'shell',
  reused: false,
  hasSessionRef: false,
})
```

- [ ] **Step 2: Add failing stale-terminal websocket assertions**

Add assertions for input, resize, and each stale attach branch. The input assertion must not include input data, only byte count:

```ts
expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
  kind: 'invalid_terminal_id_without_session_ref',
  terminalId: 'term-missing',
  connectionId: 'conn-1',
  operation: 'terminal.input',
  attemptedInputBytes: 5,
})
```

and:

```ts
expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
  kind: 'invalid_terminal_id_without_session_ref',
  terminalId: 'term-missing',
  connectionId: 'conn-1',
  operation: 'terminal.resize',
})
```

For attach, cover all four `INVALID_TERMINAL_ID` branches in `terminal.attach`:

- missing record before stream broker attach
- existing record with `status !== 'running'`
- broker returns `missing` and latest record is exited/not-running
- broker returns `missing` and no latest record exists

Each branch should assert:

```ts
expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
  kind: 'invalid_terminal_id_without_session_ref',
  terminalId: 'term-missing',
  connectionId: 'conn-1',
  operation: 'terminal.attach',
})
```

- [ ] **Step 3: Run the websocket observability test and verify it fails**

Run:

```bash
npm run test:vitest -- test/server/ws-session-observability.test.ts --run
```

Expected: FAIL because `ws-handler.ts` does not record terminal create or stale-terminal lifecycle events yet.

- [ ] **Step 4: Record terminal create request/result events**

In `server/ws-handler.ts`, import:

```ts
import { recordSessionLifecycleEvent } from './session-observability.js'
```

In the `terminal.create` case, immediately after `requestedSessionRef`, `restoreRequested`, and `canonicalSessionId` are computed, add:

```ts
recordSessionLifecycleEvent({
  kind: 'terminal_create_requested',
  requestId: m.requestId,
  connectionId: ws.connectionId || 'unknown',
  tabId: m.tabId,
  paneId: m.paneId,
  cwd: m.cwd,
  mode: m.mode as TerminalMode,
  restoreRequested,
  hasRequestedSessionRef: Boolean(requestedSessionRef),
  ...(canonicalSessionId ? { requestedSessionId: canonicalSessionId } : {}),
})
```

After each successful `terminal.created` send, record the result. For reused terminals, do this inside `attachReusedTerminal(...)` after `sendCreateResult(...)` succeeds:

```ts
recordSessionLifecycleEvent({
  kind: 'terminal_created',
  requestId: m.requestId,
  connectionId: ws.connectionId || 'unknown',
  terminalId: reusedTerminalId,
  tabId: m.tabId,
  paneId: m.paneId,
  cwd: m.cwd,
  mode: m.mode as TerminalMode,
  reused: true,
  hasSessionRef: Boolean(requestedSessionRef),
})
```

For newly created terminals, record the same event with `terminalId: created.terminalId` and `reused: false` immediately after the successful `sendCreateResult(...)` call for the new record.

- [ ] **Step 5: Add a local helper in `WsHandler` for stale-terminal logging**

Add this private helper near other `WsHandler` helpers:

```ts
private recordInvalidTerminalId(
  ws: LiveWebSocket,
  terminalId: string,
  operation: 'terminal.attach' | 'terminal.input' | 'terminal.resize',
  attemptedInputBytes?: number,
): void {
  recordSessionLifecycleEvent({
    kind: 'invalid_terminal_id_without_session_ref',
    terminalId,
    connectionId: ws.connectionId || 'unknown',
    operation,
    ...(attemptedInputBytes !== undefined ? { attemptedInputBytes } : {}),
  })
}
```

Call it before every `terminal.attach`, `terminal.input`, and `terminal.resize` `sendError()` that returns `INVALID_TERMINAL_ID`. For `terminal.attach`, this includes missing record before broker attach, exited/not-running record, broker-missing with latest exited/not-running record, and broker-missing unknown id.

```ts
this.recordInvalidTerminalId(ws, m.terminalId, 'terminal.input', Buffer.byteLength(m.data, 'utf8'))
this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Terminal not running', terminalId: m.terminalId })
```

```ts
this.recordInvalidTerminalId(ws, m.terminalId, 'terminal.resize')
this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Terminal not running', terminalId: m.terminalId })
```

```ts
this.recordInvalidTerminalId(ws, m.terminalId, 'terminal.attach')
this.sendError(ws, { code: 'INVALID_TERMINAL_ID', message: 'Unknown terminalId', terminalId: m.terminalId })
```

- [ ] **Step 6: Run websocket tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/server/ws-session-observability.test.ts --run
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

Run:

```bash
git add server/ws-handler.ts test/server/ws-session-observability.test.ts
git commit -m "feat: log stale terminal websocket operations"
```

Expected: commit succeeds.

### Task 6: Instrument association broadcasts

**Files:**
- Create: `server/session-association-broadcast.ts`
- Modify: `server/index.ts`
- Create: `test/server/session-association-broadcast.test.ts`

- [ ] **Step 1: Add failing tests for the shared association broadcast helper**

Create `test/server/session-association-broadcast.test.ts`.

Mock `recordSessionLifecycleEvent`:

```ts
vi.mock('../../server/session-observability.js', () => ({
  recordSessionLifecycleEvent: vi.fn(),
}))
```

Test each source with a fake `wsHandler`, `terminalMetadata`, and `broadcastTerminalMetaUpserts`. The Claude fast-path case should assert:

```ts
broadcastTerminalSessionAssociation({
  wsHandler,
  terminalMetadata,
  broadcastTerminalMetaUpserts,
  provider: 'claude',
  terminalId: 'term-claude',
  sessionId: SESSION_ID_ONE,
  source: 'claude_new_session',
})

expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
  kind: 'session_association_broadcast',
  provider: 'claude',
  terminalId: 'term-claude',
  sessionId: SESSION_ID_ONE,
  source: 'claude_new_session',
})
expect(wsHandler.broadcast).toHaveBeenCalledWith({
  type: 'terminal.session.associated',
  terminalId: 'term-claude',
  sessionRef: {
    provider: 'claude',
    sessionId: SESSION_ID_ONE,
  },
})
expect(recordSessionLifecycleEvent).toHaveBeenCalledTimes(1)
```

The indexer update case should assert all correlation fields:

```ts
broadcastTerminalSessionAssociation({
  wsHandler,
  terminalMetadata,
  broadcastTerminalMetaUpserts,
  provider: 'codex',
  terminalId: 'term-codex',
  sessionId: SESSION_ID_TWO,
  source: 'indexer_update',
})

expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
  kind: 'session_association_broadcast',
  provider: 'codex',
  terminalId: 'term-codex',
  sessionId: SESSION_ID_TWO,
  source: 'indexer_update',
})
```

The OpenCode controller case should assert:

```ts
broadcastTerminalSessionAssociation({
  wsHandler,
  terminalMetadata,
  broadcastTerminalMetaUpserts,
  provider: 'opencode',
  terminalId: 'term-opencode',
  sessionId: 'opencode-session-1',
  source: 'opencode_controller',
})

expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
  kind: 'session_association_broadcast',
  provider: 'opencode',
  terminalId: 'term-opencode',
  sessionId: 'opencode-session-1',
  source: 'opencode_controller',
})
```

- [ ] **Step 2: Run the association tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/server/session-association-broadcast.test.ts --run
```

Expected: FAIL because `server/session-association-broadcast.ts` does not exist.

- [ ] **Step 3: Implement the shared association broadcast helper**

Create `server/session-association-broadcast.ts`:

```ts
import { recordSessionLifecycleEvent } from './session-observability.js'
import type { CodingCliProviderName } from './coding-cli/types.js'
import type { TerminalMetadataService } from './terminal-metadata-service.js'

type AssociationBroadcastSource = 'indexer_update' | 'claude_new_session' | 'opencode_controller'

export function broadcastTerminalSessionAssociation(opts: {
  wsHandler: { broadcast: (message: unknown) => void }
  terminalMetadata: Pick<TerminalMetadataService, 'associateSession'>
  broadcastTerminalMetaUpserts: (upserts: ReturnType<TerminalMetadataService['list']>) => void
  provider: CodingCliProviderName
  terminalId: string
  sessionId: string
  source: AssociationBroadcastSource
}): void {
  recordSessionLifecycleEvent({
    kind: 'session_association_broadcast',
    provider: opts.provider,
    terminalId: opts.terminalId,
    sessionId: opts.sessionId,
    source: opts.source,
  })

  opts.wsHandler.broadcast({
    type: 'terminal.session.associated' as const,
    terminalId: opts.terminalId,
    sessionRef: {
      provider: opts.provider,
      sessionId: opts.sessionId,
    },
  })

  const metaUpsert = opts.terminalMetadata.associateSession(
    opts.terminalId,
    opts.provider,
    opts.sessionId,
  )
  if (metaUpsert) {
    opts.broadcastTerminalMetaUpserts([metaUpsert])
  }
}
```

- [ ] **Step 4: Replace direct association broadcasts in `server/index.ts`**

Import:

```ts
import { broadcastTerminalSessionAssociation } from './session-association-broadcast.js'
```

Replace the indexer update path:

```ts
broadcastTerminalSessionAssociation({
  wsHandler,
  terminalMetadata,
  broadcastTerminalMetaUpserts: (upserts) => associationMetaUpserts.push(...upserts),
  provider: session.provider,
  terminalId,
  sessionId: session.sessionId,
  source: 'indexer_update',
})
```

Replace the Claude fast-path:

```ts
broadcastTerminalSessionAssociation({
  wsHandler,
  terminalMetadata,
  broadcastTerminalMetaUpserts,
  provider: 'claude',
  terminalId,
  sessionId: session.sessionId,
  source: 'claude_new_session',
})
```

Replace the OpenCode controller listener:

```ts
broadcastTerminalSessionAssociation({
  wsHandler,
  terminalMetadata,
  broadcastTerminalMetaUpserts,
  provider: 'opencode',
  terminalId,
  sessionId,
  source: 'opencode_controller',
})
```

- [ ] **Step 5: Run the association tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/server/session-association-broadcast.test.ts test/server/session-association.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

Run:

```bash
git add server/session-association-broadcast.ts server/index.ts test/server/session-association-broadcast.test.ts test/server/session-association.test.ts
git commit -m "feat: log durable session association broadcasts"
```

Expected: commit succeeds.

## Chunk 4: Client Correlation And Runbook

### Task 7: Add client-side restore-unavailable correlation logging

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/server/ws-session-observability.test.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

- [ ] **Step 1: Add failing protocol and server tests for restore-unavailable diagnostics**

In `test/server/ws-protocol.test.ts`, add a schema test proving this client message is accepted:

```ts
const result = ClientMessageSchema.safeParse({
  type: 'client.diagnostic',
  event: 'restore_unavailable',
  reason: 'dead_live_handle',
  terminalId: 'term-stale',
  tabId: 'tab-1',
  paneId: 'pane-1',
  mode: 'codex',
  hasSessionRef: false,
})

expect(result.success).toBe(true)
```

In `test/server/ws-session-observability.test.ts`, add a websocket message assertion:

```ts
expect(recordSessionLifecycleEvent).toHaveBeenCalledWith({
  kind: 'client_restore_unavailable',
  terminalId: 'term-stale',
  connectionId: 'conn-1',
  tabId: 'tab-1',
  paneId: 'pane-1',
  mode: 'codex',
  reason: 'dead_live_handle',
  hasSessionRef: false,
})
```

- [ ] **Step 2: Run the protocol/server tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/server/ws-protocol.test.ts test/server/ws-session-observability.test.ts --run
```

Expected: FAIL because `client.diagnostic` is not in the protocol and `ws-handler.ts` does not persist it.

- [ ] **Step 3: Add the narrow diagnostic protocol and server handler**

In `shared/ws-protocol.ts`, add a client message schema variant:

```ts
export const ClientDiagnosticSchema = z.object({
  type: z.literal('client.diagnostic'),
  event: z.literal('restore_unavailable'),
  reason: z.literal('dead_live_handle'),
  terminalId: z.string().min(1),
  tabId: z.string().min(1),
  paneId: z.string().min(1),
  mode: z.string().min(1),
  hasSessionRef: z.literal(false),
})
```

Add it to the `ClientMessageSchema` union.

In `server/ws-handler.ts`, handle the message:

```ts
case 'client.diagnostic': {
  if (m.event === 'restore_unavailable') {
    recordSessionLifecycleEvent({
      kind: 'client_restore_unavailable',
      terminalId: m.terminalId,
      connectionId: ws.connectionId || 'unknown',
      tabId: m.tabId,
      paneId: m.paneId,
      mode: m.mode,
      reason: m.reason,
      hasSessionRef: m.hasSessionRef,
    })
  }
  return
}
```

- [ ] **Step 4: Add a failing client test**

In `test/unit/client/components/TerminalView.lifecycle.test.tsx`, update the existing test named `surfaces restore-unavailable for a live-only INVALID_TERMINAL_ID reconnect`.

Wrap the entire spy lifetime in `try/finally`: create the spy, then run `render(...)`, the existing restore-unavailable assertions, and the new warning/diagnostic assertions inside the `try`; restore the spy in `finally` so a failure cannot leak it:

```ts
const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
try {
  render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
    </Provider>
  )

  await waitFor(() => {
    expect(messageHandler).not.toBeNull()
  })

  messageHandler!({
    type: 'error',
    code: 'INVALID_TERMINAL_ID',
    message: 'Unknown terminalId',
    terminalId: 'term-clear',
  })

  await waitFor(() => {
    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.restoreError).toEqual({
      code: 'RESTORE_UNAVAILABLE',
      reason: 'dead_live_handle',
    })
  })

  expect(warnSpy).toHaveBeenCalledWith(
    expect.stringContaining('[TerminalView]'),
    'restore_unavailable',
    expect.objectContaining({
      event: 'restore_unavailable',
      reason: 'dead_live_handle',
      terminalId: 'term-clear',
      tabId,
      paneId,
      mode: 'claude',
      hasSessionRef: false,
    }),
  )
  expect(sentMessages).toContainEqual({
    type: 'client.diagnostic',
    event: 'restore_unavailable',
    reason: 'dead_live_handle',
    terminalId: 'term-clear',
    tabId,
    paneId,
    mode: 'claude',
    hasSessionRef: false,
  })
} finally {
  warnSpy.mockRestore()
}
```

- [ ] **Step 5: Run the client lifecycle test and verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run
```

Expected: FAIL because no warning or diagnostic websocket message is emitted.

- [ ] **Step 6: Emit the client warning and server-persisted diagnostic in `TerminalView.tsx`**

Inside the `if (!current?.sessionRef) { ... }` block near [TerminalView.tsx](/home/user/code/freshell/src/components/TerminalView.tsx:2214), before `term.writeln(...)`, add:

```ts
const restoreDiagnostic = {
  event: 'restore_unavailable' as const,
  reason: 'dead_live_handle' as const,
  terminalId: currentTerminalId,
  tabId,
  paneId,
  mode: current?.mode || paneContent.mode || 'shell',
  hasSessionRef: false as const,
}
log.warn('restore_unavailable', {
  ...restoreDiagnostic,
})
ws.send({
  type: 'client.diagnostic',
  ...restoreDiagnostic,
})
```

- [ ] **Step 7: Run protocol, server, and client tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/server/ws-protocol.test.ts test/server/ws-session-observability.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx --run
```

Expected: PASS.

- [ ] **Step 8: Commit Task 7**

Run:

```bash
git add shared/ws-protocol.ts server/ws-handler.ts src/components/TerminalView.tsx test/server/ws-protocol.test.ts test/server/ws-session-observability.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "feat: log restore-unavailable client context"
```

Expected: commit succeeds.

### Task 8: Add the debugging runbook

**Files:**
- Create: `docs/debugging/session-observability.md`

- [ ] **Step 1: Write the runbook**

Create `docs/debugging/session-observability.md`:

```md
# Session Observability

Freshell writes a low-volume lifecycle log for terminal/session incidents:

`~/.freshell/logs/session-lifecycle.<mode>.<instance>.jsonl`

If `FRESHELL_LOG_DIR` is set, lifecycle logs are written there instead. If `LOG_SESSION_LIFECYCLE_PATH` is set, that exact file path wins.

Use this log when a pane reports restore unavailable, a terminal id becomes stale, or a coding CLI session was durable in the provider but missing from Freshell pane state.

## Useful Queries

Find all lifecycle events for one terminal:

```bash
rg '"terminalId":"term-id-here"' ~/.freshell/logs/session-lifecycle.*.jsonl*
```

Find all events for one durable session:

```bash
rg '"sessionId":"session-id-here"' ~/.freshell/logs/session-lifecycle.*.jsonl*
```

Show stale terminal operations:

```bash
rg '"kind":"invalid_terminal_id_without_session_ref"' ~/.freshell/logs/session-lifecycle.*.jsonl*
```

Show live-only terminal exits:

```bash
rg '"kind":"terminal_exit_without_durable_session"' ~/.freshell/logs/session-lifecycle.*.jsonl*
```

Show panes that rendered restore unavailable:

```bash
rg '"kind":"client_restore_unavailable"' ~/.freshell/logs/session-lifecycle.*.jsonl*
```

Find restore-unavailable events for one tab or pane:

```bash
rg '"tabId":"tab-id-here"|"paneId":"pane-id-here"' ~/.freshell/logs/session-lifecycle.*.jsonl*
```

## Expected Event Chain For A Healthy New Codex Pane

1. `terminal_create_requested`
2. `terminal_created`
3. `codex_durable_session_observed`
4. `terminal_session_bound`
5. `session_association_broadcast`

If `invalid_terminal_id_without_session_ref` appears after `terminal_created` without the durable-session events, the live terminal disappeared before Freshell persisted a canonical session reference.

If `client_restore_unavailable` appears, use its `tabId`, `paneId`, `terminalId`, and `connectionId` to join the UI failure back to websocket stale-terminal events and terminal lifecycle events.

## Data Policy

The lifecycle log may include terminal ids, request ids, connection ids, tab ids, pane ids, providers, durable session ids, process ids, exit codes, and cwd. It must not include terminal input data, auth tokens, process environments, or full command-line arguments.
```

- [ ] **Step 2: Verify the runbook includes lifecycle and client restore queries**

Run:

```bash
rg -n "session-lifecycle|client_restore_unavailable|invalid_terminal_id_without_session_ref|terminal_exit_without_durable_session" docs/debugging/session-observability.md
```

Expected: all four terms are present.

- [ ] **Step 3: Commit Task 8**

Run:

```bash
git add docs/debugging/session-observability.md
git commit -m "docs: add session observability runbook"
```

Expected: commit succeeds.

## Chunk 5: Verification And Merge Readiness

### Task 9: Focused verification

**Files:**
- No source changes expected.

- [ ] **Step 1: Run focused server and client tests**

Run:

```bash
npm run test:vitest -- \
  test/unit/server/logger.test.ts \
  test/unit/server/session-observability.test.ts \
  test/server/session-association-broadcast.test.ts \
  test/server/session-association.test.ts \
  test/server/ws-protocol.test.ts \
  test/server/ws-session-observability.test.ts \
  test/unit/client/components/TerminalView.lifecycle.test.tsx \
  --run
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Inspect coordinated test status before broad tests**

Run:

```bash
npm run test:status
```

Expected: either no active holder or a clear active holder. If another agent holds the coordinator gate, wait rather than killing it.

- [ ] **Step 4: Run the coordinated full test suite**

Run:

```bash
FRESHELL_TEST_SUMMARY="codex session observability final verification" npm test
```

Expected: PASS.

- [ ] **Step 5: Inspect coordinated test status after broad tests**

Run:

```bash
npm run test:status
```

Expected: latest result records the final verification run and no stale holder remains.

- [ ] **Step 6: Commit any final cleanup**

If verification required any cleanup:

```bash
git status --short
git add server/logger.ts server/session-observability.ts server/session-association-broadcast.ts server/terminal-registry.ts server/ws-handler.ts server/index.ts shared/ws-protocol.ts src/components/TerminalView.tsx test/unit/server/logger.test.ts test/unit/server/session-observability.test.ts test/server/session-association-broadcast.test.ts test/server/session-association.test.ts test/server/ws-protocol.test.ts test/server/ws-session-observability.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx docs/debugging/session-observability.md
git commit -m "chore: verify session observability"
```

Expected: either no changes or a cleanup commit succeeds.

### Task 10: Manual production-mode smoke test

**Files:**
- No source changes expected.

- [ ] **Step 1: Build from the worktree**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 2: Start production server on a unique port**

Use a port not occupied by another Freshell instance:

```bash
PORT=3349 AUTH_TOKEN=smoke-token UNIQUE_FAKE_ENV_SECRET=env-secret-should-not-log FRESHELL_LOG_INSTANCE_ID=codex-session-observability npm start > /tmp/freshell-3349.log 2>&1 & echo $! > /tmp/freshell-3349.pid
```

Expected: `/tmp/freshell-3349.pid` contains one PID.

- [ ] **Step 3: Confirm the process belongs to this worktree**

Run:

```bash
ps -fp "$(cat /tmp/freshell-3349.pid)"
readlink "/proc/$(cat /tmp/freshell-3349.pid)/cwd"
```

Expected: `readlink` prints `/home/user/code/freshell/.worktrees/codex-session-observability-plan-20260504`.

- [ ] **Step 4: Trigger a real terminal lifecycle event through the production websocket**

Run from the worktree after the server is listening:

```bash
node --input-type=module <<'NODE'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from './dist/shared/ws-protocol.js'

const ws = new WebSocket('ws://127.0.0.1:3349/ws')
let terminalId
const timeout = setTimeout(() => {
  console.error('timed out waiting for terminal.created')
  process.exit(1)
}, 8000)

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'hello',
    token: 'smoke-token',
    protocolVersion: WS_PROTOCOL_VERSION,
  }))
})

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.type === 'ready') {
    ws.send(JSON.stringify({
      type: 'terminal.create',
      requestId: 'smoke-create-1',
      tabId: 'smoke-tab',
      paneId: 'smoke-pane',
      mode: 'shell',
      shell: 'bash',
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    }))
  }
  if (msg.type === 'terminal.created') {
    terminalId = msg.terminalId
    console.log(`created ${terminalId}`)
    ws.send(JSON.stringify({
      type: 'terminal.input',
      terminalId,
      data: 'fake terminal input should not log\n',
    }))
    ws.send(JSON.stringify({ type: 'terminal.kill', terminalId }))
    clearTimeout(timeout)
    ws.close()
  }
})

ws.on('error', (err) => {
  clearTimeout(timeout)
  console.error(err)
  process.exit(1)
})
NODE
```

Expected: prints `created <terminal-id>`.

- [ ] **Step 5: Confirm lifecycle log file contains valid JSONL with stable fields**

Run:

```bash
log=~/.freshell/logs/session-lifecycle.production.codex-session-observability.jsonl
test -s "$log"
node --input-type=module <<'NODE'
import fs from 'fs'
const log = `${process.env.HOME}/.freshell/logs/session-lifecycle.production.codex-session-observability.jsonl`
const lines = fs.readFileSync(log, 'utf8').trim().split('\n')
const events = lines.map((line) => JSON.parse(line))
const createRequested = events.find((entry) => entry.event === 'session_lifecycle' && entry.kind === 'terminal_create_requested' && entry.requestId === 'smoke-create-1')
const created = events.find((entry) => entry.event === 'session_lifecycle' && entry.kind === 'terminal_created' && entry.requestId === 'smoke-create-1')
if (!createRequested || !created) {
  throw new Error('missing expected terminal_create lifecycle events')
}
if (
  createRequested.connectionId === undefined
  || createRequested.tabId !== 'smoke-tab'
  || createRequested.paneId !== 'smoke-pane'
  || createRequested.mode !== 'shell'
  || createRequested.restoreRequested !== false
  || createRequested.hasRequestedSessionRef !== false
) {
  throw new Error('terminal_create_requested missing stable correlation fields')
}
if (
  typeof created.terminalId !== 'string'
  || created.connectionId === undefined
  || created.tabId !== 'smoke-tab'
  || created.paneId !== 'smoke-pane'
  || created.mode !== 'shell'
  || created.reused !== false
  || created.hasSessionRef !== false
) {
  throw new Error('terminal_created missing stable correlation fields')
}
const serialized = JSON.stringify(events)
if (
  serialized.includes('smoke-token')
  || serialized.includes('AUTH_TOKEN')
  || serialized.includes('UNIQUE_FAKE_ENV_SECRET')
  || serialized.includes('env-secret-should-not-log')
  || serialized.includes('fake terminal input')
) {
  throw new Error('lifecycle log contains sensitive auth data')
}
console.log(JSON.stringify({ createRequested: createRequested.kind, created: created.kind }))
NODE
```

Expected: prints `{"createRequested":"terminal_create_requested","created":"terminal_created"}`.

- [ ] **Step 6: Stop only the recorded server PID**

Run:

```bash
test "$(readlink "/proc/$(cat /tmp/freshell-3349.pid)/cwd")" = "/home/user/code/freshell/.worktrees/codex-session-observability-plan-20260504" && kill "$(cat /tmp/freshell-3349.pid)" && rm -f /tmp/freshell-3349.pid
```

Expected: cwd check passes, process exits, and PID file is removed.

### Task 11: Final commit review

**Files:**
- No source changes expected.

- [ ] **Step 1: Review git history**

Run:

```bash
git log --oneline --decorate -n 8
```

Expected: chunk commits are present and scoped.

- [ ] **Step 2: Review final diff against base**

Run:

```bash
git diff --name-only main...HEAD
git diff --stat main...HEAD
git diff main...HEAD
```

Expected: diff only contains observability, protocol schema, tests, and documentation. No fallback resume behavior is introduced.

- [ ] **Step 3: Record handoff summary**

Add a final implementation note to the PR or handoff:

```md
Implemented session lifecycle observability for durable session association and stale-terminal incidents.

Verification:
- npm run test:vitest -- test/unit/server/logger.test.ts test/unit/server/session-observability.test.ts test/server/session-association-broadcast.test.ts test/server/session-association.test.ts test/server/ws-protocol.test.ts test/server/ws-session-observability.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx --run
- npm run typecheck
- FRESHELL_TEST_SUMMARY="codex session observability final verification" npm test

Manual smoke:
- Production server on PORT=3349 wrote `~/.freshell/logs/session-lifecycle.production.codex-session-observability.jsonl`.
```

Expected: handoff includes the log path and exact verification commands.

# Fix SDK Bridge Startup — Claude Web Pane Hangs at "Starting Claude Code..."

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix three issues preventing the Claude Web pane from connecting: the subprocess refusing to start due to inherited `CLAUDECODE` env var, silent error loss from a message ordering race, and missing stderr logging.

**Architecture:** Three independent fixes to `server/sdk-bridge.ts` and `server/ws-handler.ts`. The SDK's `query()` function spawns a Claude Code subprocess which inherits `process.env`. When the freshell server runs inside a Claude Code terminal, `CLAUDECODE=1` is set, causing the child process to refuse startup. Additionally, the ws-handler sends `sdk.created` *after* `subscribe()` replays buffered messages, so fast errors arrive at the client before the session exists in Redux and are silently dropped.

**Tech Stack:** `@anthropic-ai/claude-agent-sdk` (`query()`), Vitest, Node.js

---

## Task 1: Strip `CLAUDECODE` from subprocess environment

**Files:**
- Modify: `server/sdk-bridge.ts:67-82` (the `query()` call in `createSession`)
- Test: `test/unit/server/sdk-bridge.test.ts` (add tests to `CLAUDE_CMD override` describe block)

**Step 1: Write the failing test**

Add two tests to the existing `CLAUDE_CMD override` describe block (rename it to `environment handling`):

```typescript
describe('environment handling', () => {
  // ... existing CLAUDE_CMD tests stay ...

  it('strips CLAUDECODE from env passed to SDK query', async () => {
    const original = process.env.CLAUDECODE
    try {
      process.env.CLAUDECODE = '1'
      await bridge.createSession({ cwd: '/tmp' })
      const passedEnv = mockQueryOptions?.env
      expect(passedEnv).toBeDefined()
      expect(passedEnv.CLAUDECODE).toBeUndefined()
    } finally {
      if (original !== undefined) {
        process.env.CLAUDECODE = original
      } else {
        delete process.env.CLAUDECODE
      }
    }
  })

  it('passes env even when CLAUDECODE is not set', async () => {
    const original = process.env.CLAUDECODE
    try {
      delete process.env.CLAUDECODE
      await bridge.createSession({ cwd: '/tmp' })
      const passedEnv = mockQueryOptions?.env
      expect(passedEnv).toBeDefined()
      expect(passedEnv.CLAUDECODE).toBeUndefined()
    } finally {
      if (original !== undefined) {
        process.env.CLAUDECODE = original
      } else {
        delete process.env.CLAUDECODE
      }
    }
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/sdk-bridge.test.ts --reporter=verbose`
Expected: Both new tests FAIL — `mockQueryOptions.env` is `undefined` because `env` is not currently passed to `query()`.

**Step 3: Write minimal implementation**

In `server/sdk-bridge.ts`, inside `createSession()`, build a clean env and pass it to `query()`:

Change the `query()` call (lines 67-82) from:

```typescript
    const sdkQuery = query({
      prompt: inputIterable as AsyncIterable<any>,
      options: {
        cwd: options.cwd || undefined,
        resume: options.resumeSessionId,
        model: options.model,
        permissionMode: options.permissionMode as any,
        pathToClaudeCodeExecutable: process.env.CLAUDE_CMD || undefined,
        includePartialMessages: true,
        abortController,
        canUseTool: async (toolName, input, ctx) => {
          return this.handlePermissionRequest(sessionId, toolName, input as Record<string, unknown>, ctx)
        },
        settingSources: ['user', 'project', 'local'],
      },
    })
```

To:

```typescript
    // Strip env vars that prevent nested Claude Code subprocess startup.
    // CLAUDECODE is set by parent Claude Code sessions and causes the child
    // to refuse startup with "cannot be launched inside another session".
    const { CLAUDECODE: _, ...cleanEnv } = process.env

    const sdkQuery = query({
      prompt: inputIterable as AsyncIterable<any>,
      options: {
        cwd: options.cwd || undefined,
        resume: options.resumeSessionId,
        model: options.model,
        permissionMode: options.permissionMode as any,
        pathToClaudeCodeExecutable: process.env.CLAUDE_CMD || undefined,
        includePartialMessages: true,
        abortController,
        env: cleanEnv,
        canUseTool: async (toolName, input, ctx) => {
          return this.handlePermissionRequest(sessionId, toolName, input as Record<string, unknown>, ctx)
        },
        settingSources: ['user', 'project', 'local'],
      },
    })
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/sdk-bridge.test.ts --reporter=verbose`
Expected: All tests PASS, including the two new environment handling tests.

**Step 5: Commit**

```bash
git add server/sdk-bridge.ts test/unit/server/sdk-bridge.test.ts
git commit -m "fix(sdk-bridge): strip CLAUDECODE env var from subprocess environment

The SDK's query() inherits process.env by default. When the freshell
server runs inside a Claude Code terminal, CLAUDECODE=1 is set, causing
the child Claude Code process to refuse startup with 'cannot be launched
inside another Claude Code session'. This caused the Claude Web pane to
hang at 'Starting Claude Code...' with no error displayed.

Strip CLAUDECODE (and pass explicit env) so the SDK subprocess starts
correctly regardless of the parent environment."
```

---

## Task 2: Fix message ordering — send `sdk.created` before subscribe replay

**Files:**
- Modify: `server/ws-handler.ts:1478-1486` (the `sdk.create` handler)
- Test: `test/unit/server/ws-handler-sdk.test.ts` (add ordering test)

**Context:** Currently the ws-handler does: `createSession()` → `subscribe()` → send `sdk.created`. The `subscribe()` call replays any buffered messages (like `sdk.error` or `sdk.session.init`) via `safeSend()`. These arrive at the client BEFORE `sdk.created`, but the client-side Redux handlers (`sessionError`, `sessionInit`) need the session to exist first (created by the `sessionCreated` action dispatched when `sdk.created` is processed). Result: fast errors are silently dropped.

**Step 1: Write the failing test**

Add to the `WsHandler SDK message routing` describe block:

```typescript
it('sends sdk.created before replaying buffered session messages', async () => {
  // Make createSession return a session, but make subscribe replay a buffered message
  const subscribeFn = vi.fn().mockImplementation((_sessionId: string, listener: Function) => {
    // Simulate buffer replay: the init message is sent synchronously during subscribe
    listener({
      type: 'sdk.session.init',
      sessionId: 'sdk-sess-1',
      cliSessionId: 'cli-123',
      model: 'claude-sonnet-4-5-20250929',
      cwd: '/tmp',
      tools: [],
    })
    return () => {}
  })
  mockSdkBridge.subscribe = subscribeFn

  const ws = await connectAndAuth()
  try {
    const received: any[] = []
    ws.on('message', (data: WebSocket.RawData) => {
      const parsed = JSON.parse(data.toString())
      if (parsed.type === 'sdk.created' || parsed.type === 'sdk.session.init') {
        received.push(parsed)
      }
    })

    ws.send(JSON.stringify({
      type: 'sdk.create',
      requestId: 'req-order',
      cwd: '/tmp',
    }))

    // Wait for both messages
    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2), { timeout: 3000 })

    // sdk.created MUST arrive before sdk.session.init
    expect(received[0].type).toBe('sdk.created')
    expect(received[1].type).toBe('sdk.session.init')
  } finally {
    ws.close()
  }
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/ws-handler-sdk.test.ts --reporter=verbose`
Expected: FAIL — `received[0].type` is `sdk.session.init` (replay happens before `sdk.created` is sent).

**Step 3: Write minimal implementation**

In `server/ws-handler.ts`, in the `sdk.create` handler, swap the order: send `sdk.created` first, then subscribe (which triggers buffer replay).

Change lines ~1478-1486 from:

```typescript
          state.sdkSessions.add(session.sessionId)

          // Subscribe this client to session events
          const off = this.sdkBridge.subscribe(session.sessionId, (msg: SdkServerMessage) => {
            this.safeSend(ws, msg)
          })
          if (off) state.sdkSubscriptions.set(session.sessionId, off)

          this.send(ws, { type: 'sdk.created', requestId: m.requestId, sessionId: session.sessionId })
```

To:

```typescript
          state.sdkSessions.add(session.sessionId)

          // Send sdk.created FIRST so the client creates the Redux session
          // before any buffered messages (sdk.session.init, sdk.error) arrive.
          this.send(ws, { type: 'sdk.created', requestId: m.requestId, sessionId: session.sessionId })

          // Subscribe this client to session events (replays buffered messages)
          const off = this.sdkBridge.subscribe(session.sessionId, (msg: SdkServerMessage) => {
            this.safeSend(ws, msg)
          })
          if (off) state.sdkSubscriptions.set(session.sessionId, off)
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/ws-handler-sdk.test.ts --reporter=verbose`
Expected: All tests PASS, including the new ordering test.

**Step 5: Commit**

```bash
git add server/ws-handler.ts test/unit/server/ws-handler-sdk.test.ts
git commit -m "fix(ws-handler): send sdk.created before subscribe buffer replay

Previously, subscribe() was called before sending sdk.created. When the
SDK process emitted messages quickly (e.g. sdk.error on startup failure),
subscribe() replayed them to the client before sdk.created arrived. The
client-side Redux sessionError reducer silently dropped errors for
sessions that didn't exist yet, making startup failures invisible.

Reorder: send sdk.created first so the client creates the Redux session,
then subscribe (which replays any buffered messages like sdk.session.init
or sdk.error into an already-existing session)."
```

---

## Task 3: Add stderr logging for SDK subprocess

**Files:**
- Modify: `server/sdk-bridge.ts:67-82` (add `stderr` callback to `query()` options)
- Test: `test/unit/server/sdk-bridge.test.ts` (verify stderr callback is passed)

**Step 1: Write the failing test**

Add to the `environment handling` describe block (or create a new `stderr logging` block):

```typescript
it('passes stderr callback to SDK query', async () => {
  await bridge.createSession({ cwd: '/tmp' })
  expect(mockQueryOptions?.stderr).toBeInstanceOf(Function)
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/sdk-bridge.test.ts --reporter=verbose`
Expected: FAIL — `mockQueryOptions.stderr` is `undefined`.

**Step 3: Write minimal implementation**

In `server/sdk-bridge.ts`, add a `stderr` callback to the `query()` options (inside the options object that was already modified in Task 1):

```typescript
        env: cleanEnv,
        stderr: (data: string) => {
          log.warn({ sessionId, data: data.trimEnd() }, 'SDK subprocess stderr')
        },
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/sdk-bridge.test.ts --reporter=verbose`
Expected: All tests PASS.

**Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass (no regressions).

**Step 6: Commit**

```bash
git add server/sdk-bridge.ts test/unit/server/sdk-bridge.test.ts
git commit -m "fix(sdk-bridge): log SDK subprocess stderr output

Previously, stderr from the Claude Code subprocess was silently
discarded. If the process failed to start (e.g. auth errors, missing
binary), the error message was invisible. Forward stderr to the
structured logger so startup failures appear in server logs."
```

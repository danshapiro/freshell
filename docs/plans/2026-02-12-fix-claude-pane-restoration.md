# Fix Claude Pane Restoration After Server Reset

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent Claude panes from losing conversation history when the Freshell server is reset.

**Architecture:** Three layered fixes targeting the root cause chain: (1) graceful shutdown gives Claude time to flush JSONL writes, (2) session repair blocks terminal creation so Claude reads a repaired file, (3) xterm is always cleared on terminal creation to avoid stale content. Each fix is independently valuable — together they eliminate the failure mode.

**Tech Stack:** Node.js (server), node-pty, React/xterm.js (client), Vitest

---

## Context

When Freshell's server is reset, Claude panes restore to an earlier point in conversation history. Root cause chain:

1. **Shutdown sends SIGHUP then immediately exits** — Claude can't flush JSONL writes → file on disk is incomplete
2. **Session repair is fire-and-forget** — `void waitForSession(...)` means Claude reads the incomplete file before repair runs
3. **Empty snapshot skips `term.clear()`** — old xterm content from before restart persists, adding visual confusion

---

### Task 1: Graceful shutdown — give PTY processes time to flush

**Files:**
- Modify: `server/terminal-registry.ts:1174-1196` (add `shutdownGracefully` method)
- Modify: `server/index.ts:823-824` (use new async shutdown)
- Test: `test/unit/server/terminal-lifecycle.test.ts` (add graceful shutdown tests)

**Step 1: Write the failing tests**

In `test/unit/server/terminal-lifecycle.test.ts`, add a new describe block after the existing `describe('shutdown')` block:

```typescript
describe('shutdownGracefully', () => {
  it('should send SIGTERM to running terminals', async () => {
    registry.create({ mode: 'shell' })
    registry.create({ mode: 'shell' })

    const ptys = mockPtyProcess.instances

    // Simulate prompt exits when SIGTERM arrives
    for (const pty of ptys) {
      pty.kill.mockImplementation(() => {
        setTimeout(() => pty._emitExit(0), 10)
      })
    }

    await registry.shutdownGracefully(5000)

    for (const pty of ptys) {
      expect(pty.kill).toHaveBeenCalledWith('SIGTERM')
    }
  })

  it('should wait for terminals to exit within timeout', async () => {
    registry.create({ mode: 'shell' })
    const pty = mockPtyProcess.instances[0]

    pty.kill.mockImplementation(() => {
      setTimeout(() => pty._emitExit(0), 50)
    })

    const start = Date.now()
    await registry.shutdownGracefully(5000)
    // Should resolve quickly, not wait the full 5s
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('should force-kill terminals after timeout', async () => {
    registry.create({ mode: 'shell' })
    const pty = mockPtyProcess.instances[0]

    // Never exits on SIGTERM
    pty.kill.mockImplementation(() => {})

    await registry.shutdownGracefully(200)

    // Should have been called twice: once SIGTERM, once forced
    expect(pty.kill).toHaveBeenCalledTimes(2)
    expect(pty.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
  })

  it('should handle already exited terminals', async () => {
    const term = registry.create({ mode: 'shell' })
    const pty = mockPtyProcess.instances[0]
    pty._emitExit(0)
    expect(term.status).toBe('exited')

    await expect(registry.shutdownGracefully(1000)).resolves.toBeUndefined()
  })

  it('should handle no terminals', async () => {
    await expect(registry.shutdownGracefully(1000)).resolves.toBeUndefined()
  })

  it('should clear timers', async () => {
    registry.create({ mode: 'shell' })
    const pty = mockPtyProcess.instances[0]
    pty.kill.mockImplementation(() => {
      setTimeout(() => pty._emitExit(0), 10)
    })

    await registry.shutdownGracefully(1000)

    vi.advanceTimersByTime(60 * 60 * 1000)
    // Timer should have been cleared — only the one SIGTERM kill
    expect(pty.kill).toHaveBeenCalledTimes(1)
  })
})
```

**Important:** These tests use `vi.useFakeTimers()` which is already set up in `beforeEach`. The `setTimeout` in mock implementations will fire when timers are advanced. However, the `shutdownGracefully` method uses real async (Promise + setTimeout for timeout). For fake timer tests, you may need to advance timers manually. Consider whether to use real timers for this describe block (`vi.useRealTimers()` in a nested `beforeEach`).

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/server/terminal-lifecycle.test.ts --reporter=verbose`
Expected: FAIL — `shutdownGracefully` does not exist.

**Step 3: Implement `shutdownGracefully` in TerminalRegistry**

In `server/terminal-registry.ts`, add after the existing `shutdown()` method (around line 1196):

```typescript
/**
 * Gracefully shutdown all terminals. Sends SIGTERM and waits for processes
 * to exit (allowing them to flush writes). Falls back to forced kill after timeout.
 */
async shutdownGracefully(timeoutMs: number = 5000): Promise<void> {
  // Stop timers
  if (this.idleTimer) {
    clearInterval(this.idleTimer)
    this.idleTimer = null
  }
  if (this.perfTimer) {
    clearInterval(this.perfTimer)
    this.perfTimer = null
  }

  const running: TerminalRecord[] = []
  for (const term of this.terminals.values()) {
    if (term.status === 'running') running.push(term)
  }

  if (running.length === 0) {
    logger.info('No running terminals to shut down')
    return
  }

  // Set up exit listeners BEFORE sending signals (avoid race)
  const exitPromises = running.map(term =>
    new Promise<void>(resolve => {
      if (term.status === 'exited') { resolve(); return }
      const handler = (evt: { terminalId: string }) => {
        if (evt.terminalId === term.terminalId) {
          this.off('terminal.exit', handler)
          resolve()
        }
      }
      this.on('terminal.exit', handler)
      // Re-check after listener setup (TOCTOU guard)
      if (term.status === 'exited') {
        this.off('terminal.exit', handler)
        resolve()
      }
    })
  )

  // Send SIGTERM to all running terminals
  for (const term of running) {
    try {
      term.pty.kill('SIGTERM')
    } catch {
      // Already gone — will be cleaned up below
    }
  }

  logger.info({ count: running.length }, 'Sent SIGTERM to running terminals, waiting for exit...')

  // Wait for all to exit, or timeout
  await Promise.race([
    Promise.all(exitPromises),
    new Promise<void>(r => setTimeout(r, timeoutMs)),
  ])

  // Force kill any that didn't exit in time
  let forceKilled = 0
  for (const term of running) {
    if (term.status !== 'exited') {
      this.kill(term.terminalId)
      forceKilled++
    }
  }

  if (forceKilled > 0) {
    logger.warn({ forceKilled }, 'Force-killed terminals after graceful timeout')
  }

  logger.info({ count: running.length, forceKilled }, 'All terminals shut down')
}
```

**Step 4: Update `index.ts` shutdown handler**

In `server/index.ts`, change line 823-824 from:

```typescript
// 3. Kill all running terminals
registry.shutdown()
```

to:

```typescript
// 3. Gracefully shut down terminals (gives Claude time to flush JSONL writes)
await registry.shutdownGracefully(5000)
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/server/terminal-lifecycle.test.ts --reporter=verbose`
Expected: All tests pass including new `shutdownGracefully` tests.

**Step 6: Commit**

```bash
git add server/terminal-registry.ts server/index.ts test/unit/server/terminal-lifecycle.test.ts
git commit -m "fix(shutdown): add graceful shutdown with SIGTERM + grace period

Add shutdownGracefully(timeoutMs) to TerminalRegistry. Sends SIGTERM
to all running PTY processes and waits up to timeoutMs for them to exit,
giving Claude Code time to flush JSONL session writes. Falls back to
forced kill after timeout. Server shutdown now uses this instead of the
immediate kill-all."
```

---

### Task 2: Await session repair before terminal creation

**Files:**
- Modify: `server/ws-handler.ts:1157-1184` (await instead of void)
- Modify: `test/server/ws-terminal-create-session-repair.test.ts` (update and add tests)

**Step 1: Update existing test and add new tests**

In `test/server/ws-terminal-create-session-repair.test.ts`:

First, change `FakeSessionRepairService.waitForSession` to support controlled resolution:

```typescript
class FakeSessionRepairService extends EventEmitter {
  waitForSessionCalls: string[] = []
  result: SessionScanResult | undefined
  waitForSessionResult: SessionScanResult | undefined
  waitForSessionDelay: number = 0

  prioritizeSessions() {}

  getResult(_sessionId: string): SessionScanResult | undefined {
    return this.result
  }

  async waitForSession(sessionId: string, _timeoutMs?: number): Promise<SessionScanResult> {
    this.waitForSessionCalls.push(sessionId)
    if (this.waitForSessionDelay > 0) {
      await new Promise(r => setTimeout(r, this.waitForSessionDelay))
    }
    if (this.waitForSessionResult) {
      return this.waitForSessionResult
    }
    // Default: resolve as healthy
    return {
      sessionId,
      filePath: `/tmp/${sessionId}.jsonl`,
      status: 'healthy',
      chainDepth: 10,
      orphanCount: 0,
      fileSize: 1024,
      messageCount: 10,
    }
  }
}
```

Update the `beforeEach` to also reset:

```typescript
beforeEach(() => {
  sessionRepairService.waitForSessionCalls = []
  sessionRepairService.result = undefined
  sessionRepairService.waitForSessionResult = undefined
  sessionRepairService.waitForSessionDelay = 0
  registry.records.clear()
  registry.lastCreateOpts = null
})
```

Update the existing test `'does not block terminal.create while session repair runs'` — rename and adapt since it now SHOULD block (briefly):

```typescript
it('blocks terminal.create until session repair completes', async () => {
  sessionRepairService.waitForSessionDelay = 100

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  try {
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))
    await waitForMessage(ws, (m) => m.type === 'ready')

    const requestId = 'resume-1'
    ws.send(JSON.stringify({
      type: 'terminal.create',
      requestId,
      mode: 'claude',
      resumeSessionId: VALID_SESSION_ID,
    }))

    const created = await waitForMessage(
      ws,
      (m) => m.type === 'terminal.created' && m.requestId === requestId,
      3000,
    )

    expect(created.terminalId).toMatch(/^term_/)
    expect(created.effectiveResumeSessionId).toBe(VALID_SESSION_ID)
    expect(sessionRepairService.waitForSessionCalls).toContain(VALID_SESSION_ID)
  } finally {
    await closeWebSocket(ws)
  }
})
```

Add a test for repair finding 'missing' status (drops resume):

```typescript
it('drops resumeSessionId when repair resolves as missing', async () => {
  sessionRepairService.waitForSessionResult = {
    sessionId: VALID_SESSION_ID,
    filePath: `/tmp/${VALID_SESSION_ID}.jsonl`,
    status: 'missing',
    chainDepth: 0,
    orphanCount: 0,
    fileSize: 0,
    messageCount: 0,
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  try {
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))
    await waitForMessage(ws, (m) => m.type === 'ready')

    const requestId = 'resume-repair-missing-1'
    ws.send(JSON.stringify({
      type: 'terminal.create',
      requestId,
      mode: 'claude',
      resumeSessionId: VALID_SESSION_ID,
    }))

    const created = await waitForMessage(
      ws,
      (m) => m.type === 'terminal.created' && m.requestId === requestId,
    )

    expect(registry.lastCreateOpts?.resumeSessionId).toBeUndefined()
    expect(created.effectiveResumeSessionId).toBeUndefined()
  } finally {
    await closeWebSocket(ws)
  }
})
```

Add a test for repair timeout (still creates terminal):

```typescript
it('proceeds with resume when repair wait throws (timeout)', async () => {
  // Override waitForSession to reject
  const origWait = sessionRepairService.waitForSession.bind(sessionRepairService)
  sessionRepairService.waitForSession = async (sessionId: string, timeoutMs?: number) => {
    sessionRepairService.waitForSessionCalls.push(sessionId)
    throw new Error('Timeout')
  }

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  try {
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'testtoken-testtoken' }))
    await waitForMessage(ws, (m) => m.type === 'ready')

    const requestId = 'resume-timeout-1'
    ws.send(JSON.stringify({
      type: 'terminal.create',
      requestId,
      mode: 'claude',
      resumeSessionId: VALID_SESSION_ID,
    }))

    const created = await waitForMessage(
      ws,
      (m) => m.type === 'terminal.created' && m.requestId === requestId,
      3000,
    )

    // Should still create with the resumeSessionId (repair failed, but we proceed)
    expect(created.terminalId).toMatch(/^term_/)
    expect(created.effectiveResumeSessionId).toBe(VALID_SESSION_ID)
  } finally {
    sessionRepairService.waitForSession = origWait
    await closeWebSocket(ws)
  }
})
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/ws-terminal-create-session-repair.test.ts --reporter=verbose`
Expected: FAIL — the `blocks terminal.create` test may pass (since the never-resolving promise is gone) but the `repair resolves as missing` test should fail (current code ignores repair result).

**Step 3: Implement the fix in ws-handler.ts**

In `server/ws-handler.ts`, replace the session repair block (lines ~1157-1184). Change from:

```typescript
if (m.mode === 'claude' && effectiveResumeSessionId && this.sessionRepairService) {
  const sessionId = effectiveResumeSessionId
  const cached = this.sessionRepairService.getResult(sessionId)
  if (cached?.status === 'missing') {
    log.info({ sessionId, connectionId: ws.connectionId }, 'Session previously marked missing; resume will start fresh')
    effectiveResumeSessionId = undefined
  } else {
    const endRepairTimer = startPerfTimer(
      'terminal_create_repair_wait',
      { connectionId: ws.connectionId, sessionId },
      { minDurationMs: perfConfig.slowTerminalCreateMs, level: 'warn' },
    )
    void this.sessionRepairService.waitForSession(sessionId, 10000)
      .then((result) => {
        endRepairTimer({ status: result.status })
        if (result.status === 'missing') {
          log.info({ sessionId, connectionId: ws.connectionId }, 'Session file missing; resume may start fresh')
        }
      })
      .catch((err) => {
        endRepairTimer({ error: err instanceof Error ? err.message : String(err) })
        log.debug({ err, sessionId, connectionId: ws.connectionId }, 'Session repair wait failed, proceeding')
      })
  }
}
```

To:

```typescript
if (m.mode === 'claude' && effectiveResumeSessionId && this.sessionRepairService) {
  const sessionId = effectiveResumeSessionId
  const cached = this.sessionRepairService.getResult(sessionId)
  if (cached?.status === 'missing') {
    log.info({ sessionId, connectionId: ws.connectionId }, 'Session previously marked missing; resume will start fresh')
    effectiveResumeSessionId = undefined
  } else {
    const endRepairTimer = startPerfTimer(
      'terminal_create_repair_wait',
      { connectionId: ws.connectionId, sessionId },
      { minDurationMs: perfConfig.slowTerminalCreateMs, level: 'warn' },
    )
    try {
      const result = await this.sessionRepairService.waitForSession(sessionId, 10000)
      endRepairTimer({ status: result.status })
      if (result.status === 'missing') {
        log.info({ sessionId, connectionId: ws.connectionId }, 'Session file missing; resume will start fresh')
        effectiveResumeSessionId = undefined
      }
    } catch (err) {
      endRepairTimer({ error: err instanceof Error ? err.message : String(err) })
      log.debug({ err, sessionId, connectionId: ws.connectionId }, 'Session repair wait failed, proceeding with resume')
    }
  }
}
```

Key changes:
- `void ... .then().catch()` → `try { await ... } catch {}`
- On repair result `'missing'`, set `effectiveResumeSessionId = undefined` (was only logged before)
- On timeout/error, proceed with the original `effectiveResumeSessionId` (safe fallback)

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/server/ws-terminal-create-session-repair.test.ts --reporter=verbose`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add server/ws-handler.ts test/server/ws-terminal-create-session-repair.test.ts
git commit -m "fix(session-repair): await repair before spawning claude --resume

Change session repair wait from fire-and-forget to blocking await. This
ensures the JSONL file is scanned (and repaired if needed) before Claude
reads it. If repair resolves as 'missing', the resume is skipped and
Claude starts a fresh session. If repair times out, proceed anyway."
```

---

### Task 3: Clear xterm on terminal creation regardless of snapshot

**Files:**
- Modify: `src/components/TerminalView.tsx:536-541` (always clear)
- Test: `test/unit/client/components/TerminalView.resumeSession.test.tsx` (add test)

**Step 1: Check existing test patterns**

Read: `test/unit/client/components/TerminalView.resumeSession.test.tsx` to understand test setup patterns for TerminalView.

**Step 2: Write the failing test**

In the resume session test file, add a test that verifies xterm is cleared when `terminal.created` has an empty snapshot:

```typescript
it('clears xterm on terminal.created with empty snapshot', async () => {
  // Test that term.clear() is called even when snapshot is empty
  // (This prevents stale content from before a reconnect persisting)
  // ... setup to trigger terminal.created with snapshot: "" ...
  // ... verify term.clear() was called ...
})
```

The exact test structure depends on how the existing tests mock xterm. Read the file first to match patterns.

**Step 3: Implement the fix**

In `src/components/TerminalView.tsx`, change lines ~536-541 from:

```typescript
const isSnapshotChunked = msg.snapshotChunked === true
if (isSnapshotChunked) {
  markSnapshotChunkedCreated()
} else if (msg.snapshot) {
  try { term.clear(); term.write(msg.snapshot) } catch { /* disposed */ }
}
```

To:

```typescript
const isSnapshotChunked = msg.snapshotChunked === true
if (isSnapshotChunked) {
  markSnapshotChunkedCreated()
} else {
  try { term.clear() } catch { /* disposed */ }
  if (msg.snapshot) {
    try { term.write(msg.snapshot) } catch { /* disposed */ }
  }
}
```

This separates the clear from the write. `term.clear()` always runs on creation (unless chunked). `term.write()` only runs if there's content to write.

**Step 4: Run tests**

Run: `npx vitest run test/unit/client/components/ --reporter=verbose`
Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx
git commit -m "fix(terminal): always clear xterm on terminal creation

Previously, term.clear() was only called when the snapshot was non-empty.
After a server restart, the new terminal has an empty snapshot, so old
xterm content from before the restart persisted, mixing with Claude's
resume output. Now term.clear() runs unconditionally on creation."
```

---

### Task 4: Run full test suite and verify

**Step 1: Run all tests**

Run: `npm test`
Expected: All tests pass.

**Step 2: Fix any regressions**

If any tests fail, investigate and fix.

**Step 3: Final commit if needed**

---

## Verification

### Automated
- `npm test` — all unit + integration tests pass

### Manual
1. Start Freshell with `npm run dev`
2. Open a Claude pane and have a multi-turn conversation
3. Ctrl+C the server → restart with `npm run dev`
4. Observe: the Claude pane should restore with the full conversation history, no stale content from before the restart
5. Check server logs for `Sent SIGTERM to running terminals, waiting for exit...` message confirming graceful shutdown

### What Each Fix Prevents
| Fix | Without it | With it |
|-----|-----------|---------|
| Graceful shutdown | JSONL missing recent messages | Claude gets 5s to flush writes |
| Await repair | Claude reads corrupted JSONL | Repaired file is ready before resume |
| Clear xterm | Old + new content mixed | Clean slate on reconnect |

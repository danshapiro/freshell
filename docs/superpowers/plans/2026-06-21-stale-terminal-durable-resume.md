# Stale Terminal Durable Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a pane points at a stale durable terminal handle, the client clears only that handle and resumes the saved session instead of surfacing a red restore failure. If the resumed CLI exits cleanly before attach completes, the pane must show a clean exited state, not an error.

**Architecture:** Mark only recoverable stale-handle exits at the registry event boundary: idle auto-kills, plus detached PTY exits for terminals with a durable `sessionRef`. Extend the existing `terminals.changed` invalidation with an optional `recoverableTerminalIds` payload for those exits only. On the client, route that payload through the existing terminal invalidation handler into a new exact panes reducer that clears only named terminal handles, then register restore intent only for panes that matched those terminal ids before clearing. Separately, when a restore launch exits with code 0 before attach completes, carry the exited terminal's structured exit code to TerminalView and settle the pane as `exited` rather than `error`.

Idle auto-kills are treated as stale-handle recoveries even for non-durable shell panes. That matches the existing `terminal.inventory` recovery behavior: the exact pane whose dead terminal id was idle-killed gets a fresh terminal request, while durable panes use `sessionRef` restore and unrelated panes are untouched.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, ws, Vitest, Testing Library.

## Global Constraints

- Work in `/home/dan/code/freshell/.worktrees/fix-stale-terminal-durable-resume`.
- Do not restart the self-hosted Freshell server.
- Preserve unrelated changes in the main checkout, including the untracked `.claude/skills/triage-old-worktrees/`.
- Server uses NodeNext/ESM; relative imports must include `.js` extensions.
- Do not create or open a PR without explicit user approval.
- Use red/green/refactor TDD for the behavior changes.
- Use structured tests that prove user behavior: hidden/detached durable panes must recover without surfacing red restore failure.

---

## File Structure

- Modify `shared/ws-protocol.ts`: add optional `recoverableTerminalIds?: string[]` to the `TerminalsChangedMessage` server-to-client type.
- Modify `server/terminal-registry.ts`: mark idle auto-kills and detached durable PTY exits as `recoverableForRestore`; do not mark explicit user kills or attached PTY exits recoverable.
- Modify `server/ws-handler.ts`: broadcast `terminals.changed` from the registry exit listener only when the event carries `recoverableForRestore: true`; leave existing explicit `terminal.kill` broadcasts unchanged.
- Modify `src/store/panesSlice.ts`: add `clearTerminalLiveHandles({ terminalIds })` and reuse the existing stale-terminal clearing logic from `clearDeadTerminals`.
- Modify `src/lib/terminal-invalidation-handler.ts`: parse `recoverableTerminalIds` on `terminals.changed` and call an injected exact-clear callback before scheduling refreshes.
- Modify `src/App.tsx`: register pending restore/fresh-recovery request ids for the panes that matched `terminals.changed.recoverableTerminalIds` before clearing.
- Modify `src/components/TerminalView.tsx`: treat clean restored terminal startup exits as clean exits rather than restore failures.
- Test `test/unit/server/terminal-registry.test.ts`: prove idle auto-kill and detached durable PTY exit emit `terminal.exit` with `recoverableForRestore: true`, while non-durable PTY exit, attached PTY exit, and explicit kill do not.
- Test `test/unit/server/terminal-registry.codex-recovery.test.ts`: update existing detached durable final-exit assertions that now intentionally include `recoverableForRestore: true`.
- Test `test/server/ws-handshake-snapshot.test.ts`: prove registry `terminal.exit` with `recoverableForRestore: true` is broadcast globally as `terminals.changed` with `recoverableTerminalIds`, and non-recoverable registry exits do not broadcast from this listener.
- Test `test/unit/client/lib/terminal-invalidation-handler.test.ts`: prove `recoverableTerminalIds` are parsed and forwarded while refreshes still coalesce.
- Test `test/unit/client/store/panesSlice.test.ts`: prove exact stale-handle clearing only touches named terminals and preserves durable restore state.
- Test `test/unit/client/components/App.ws-bootstrap.test.tsx`: prove an unmounted durable pane is restored from a `terminals.changed.recoverableTerminalIds` message without waiting for `terminal.inventory`.
- Test `test/unit/client/components/TerminalView.lifecycle.test.tsx`: prove restore startup exit code 0 settles as `exited` without `[Restore failed]`, while non-zero startup exits still fail.

---

### Task 1: Recoverable Server Exit Invalidation Payload

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Test: `test/unit/server/terminal-registry.test.ts`
- Test: `test/unit/server/terminal-registry.codex-recovery.test.ts`
- Test: `test/server/ws-handshake-snapshot.test.ts`

**Interfaces:**
- Consumes: registry `terminal.exit` payloads shaped like `{ terminalId?: string; exitCode?: number; recoverableForRestore?: boolean }`.
- Produces: `TerminalsChangedMessage` may include `recoverableTerminalIds?: string[]` only for recoverable exits.

- [ ] **Step 1: Write failing registry tests**

Add this import at the top of `test/unit/server/terminal-registry.test.ts`:

```ts
import { defaultSettings } from '../../../server/config-store'
```

Then add these tests near the existing terminal exit lifecycle tests:

```ts
it('marks idle detached auto-kill exits as recoverable for restore', async () => {
  const exited = vi.fn()
  registry.on('terminal.exit', exited)
  registry.setSettings({
    ...defaultSettings,
    safety: {
      ...defaultSettings.safety,
      autoKillIdleMinutes: 1,
    },
  })
  const record = registry.create({ mode: 'shell', cwd: '/home/user/project' })
  record.lastActivityAt = Date.now() - 61_000

  await registry.enforceIdleKillsForTest()

  expect(exited).toHaveBeenCalledWith({
    terminalId: record.terminalId,
    exitCode: 0,
    recoverableForRestore: true,
  })
})

it('marks detached durable PTY exits as recoverable for restore', async () => {
  const exited = vi.fn()
  registry.on('terminal.exit', exited)
  const durableExit = registry.create({
    mode: 'codex',
    cwd: '/home/user/project',
    resumeSessionId: '019ede4a-c03c-70a1-832c-ecabfaed4767',
  })
  durableExit.codexDurability = {
    schemaVersion: 1,
    state: 'durable',
    durableThreadId: '019ede4a-c03c-70a1-832c-ecabfaed4767',
  }
  const pty = await import('node-pty')
  const durablePty = vi.mocked(pty.spawn).mock.results.at(-1)?.value
  const onExitCallback = durablePty.onExit.mock.calls[0][0]

  onExitCallback({ exitCode: 0, signal: 0 })

  await vi.waitFor(() => {
    expect(exited).toHaveBeenCalledWith({
      terminalId: durableExit.terminalId,
      exitCode: 0,
      recoverableForRestore: true,
    })
  })
})

it('does not mark non-durable PTY exit, attached durable PTY exit, or explicit kill as recoverable for restore', async () => {
  const exited = vi.fn()
  registry.on('terminal.exit', exited)
  const nonDurableExit = registry.create({ mode: 'shell', cwd: '/home/user/project' })
  const attachedDurableExit = registry.create({
    mode: 'codex',
    cwd: '/home/user/project',
    resumeSessionId: '019ede4a-c03c-70a1-832c-ecabfaed4767',
  })
  attachedDurableExit.codexDurability = {
    schemaVersion: 1,
    state: 'durable',
    durableThreadId: '019ede4a-c03c-70a1-832c-ecabfaed4767',
  }
  registry.attach(attachedDurableExit.terminalId, { send: vi.fn(), bufferedAmount: 0 } as any)
  const explicitKill = registry.create({ mode: 'shell', cwd: '/home/user/project' })
  const pty = await import('node-pty')
  const nonDurablePty = vi.mocked(pty.spawn).mock.results.at(-3)?.value
  const attachedDurablePty = vi.mocked(pty.spawn).mock.results.at(-2)?.value

  nonDurablePty.onExit.mock.calls[0][0]({ exitCode: 7, signal: 0 })
  attachedDurablePty.onExit.mock.calls[0][0]({ exitCode: 0, signal: 0 })
  registry.kill(explicitKill.terminalId)

  expect(exited).toHaveBeenCalledWith({
    terminalId: nonDurableExit.terminalId,
    exitCode: 7,
  })
  await vi.waitFor(() => {
    expect(exited).toHaveBeenCalledWith({
      terminalId: attachedDurableExit.terminalId,
      exitCode: 0,
    })
  })
  expect(exited).toHaveBeenCalledWith({
    terminalId: explicitKill.terminalId,
    exitCode: 0,
  })
  expect(exited.mock.calls.some(([payload]) => payload?.recoverableForRestore === true)).toBe(false)
})
```

- [ ] **Step 2: Write the failing WebSocket broadcast tests**

Add `EventEmitter` support to the fake registry and add this test in `test/server/ws-handshake-snapshot.test.ts`:

```ts
import { EventEmitter } from 'events'

class FakeRegistry extends EventEmitter {
  private terminals: any[] = []

  detach() {
    return true
  }
  list() {
    return [...this.terminals]
  }

  setTerminals(terminals: any[]) {
    this.terminals = [...terminals]
  }
}

it('broadcasts recoverable terminal ids when the registry reports a recoverable terminal exit', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

  try {
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    await waitForReady(ws, 10_000)

    const changedPromise = waitForMessage(ws, (m) => m.type === 'terminals.changed', 10_000)
    registry.emit('terminal.exit', {
      terminalId: 'term-detached-dead',
      exitCode: 0,
      recoverableForRestore: true,
    })

    await expect(changedPromise).resolves.toEqual({
      type: 'terminals.changed',
      revision: 1,
      recoverableTerminalIds: ['term-detached-dead'],
    })
  } finally {
    await closeWs(ws)
  }
})

it('does not broadcast terminals.changed from non-recoverable registry terminal exits', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)

  try {
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    await waitForReady(ws, 10_000)

    registry.emit('terminal.exit', { terminalId: 'term-normal-exit', exitCode: 0 })

    await expectNoMessage(ws, (m) => m.type === 'terminals.changed')
  } finally {
    await closeWs(ws)
  }
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/server/ws-handshake-snapshot.test.ts --run
```

Expected: FAIL because idle auto-kill and detached durable PTY exits do not mark exit events recoverable, and WebSocket broadcasts do not carry recoverable terminal ids.

- [ ] **Step 4: Implement recoverable exit marking and broadcast**

Change `shared/ws-protocol.ts`:

```ts
export type TerminalsChangedMessage = {
  type: 'terminals.changed'
  revision: number
  recoverableTerminalIds?: string[]
}
```

Change `server/terminal-registry.ts`:

```ts
type TerminalKillOptions = {
  recoverableForRestore?: boolean
}
```

Update `kill()`:

```ts
kill(terminalId: string, options: TerminalKillOptions = {}): boolean {
  // existing body...
  this.emit('terminal.exit', {
    terminalId,
    exitCode: term.exitCode,
    ...(options.recoverableForRestore ? { recoverableForRestore: true } : {}),
  })
  // existing body...
}
```

Update idle enforcement only:

```ts
this.kill(term.terminalId, { recoverableForRestore: true })
```

Update `finishTerminalPtyExit()` before it clears `record.clients` and before it calls `releaseBinding()`:

```ts
const recoverableForRestore = record.clients.size === 0 && !!buildTerminalSessionRef(record)
// existing terminal.exit safeSend loop and cleanup...
this.emit('terminal.exit', {
  terminalId: record.terminalId,
  exitCode: event.exitCode,
  ...(recoverableForRestore ? { recoverableForRestore: true } : {}),
})
```

This intentionally excludes attached PTY exits: mounted panes already receive `terminal.exit` and should settle to `exited`, not immediately recreate themselves. The `buildTerminalSessionRef(record)` check must happen before `releaseBinding(record.terminalId, 'exit')`, because `releaseBinding()` clears `record.resumeSessionId`.

Do not gate this flag on `exitCode === 0`. A detached durable pane should get one precise client-side recovery attempt whenever the attached PTY disappears, whether the old PTY exited cleanly or with a non-zero code. Task 4 is stricter only for restore startup exits: a newly spawned restore command that exits non-zero is still a red restore failure.

Update existing exact `terminal.exit` expectations in `test/unit/server/terminal-registry.codex-recovery.test.ts`. For detached durable final exits that now satisfy `buildTerminalSessionRef(record)`, update exact assertions from:

```ts
expect(exited).toHaveBeenCalledWith({ terminalId: record.terminalId, exitCode: 0 })
```

to:

```ts
expect(exited).toHaveBeenCalledWith({
  terminalId: record.terminalId,
  exitCode: 0,
  recoverableForRestore: true,
})
```

At minimum, update the durable detached final-exit assertions currently covered by the tests named like:

- `keeps a durable Codex PTY exit final when the visible process exits cleanly`
- `runs normal PTY-exit cleanup when durable recovery is already blocked`
- durable clean-exit tests that set `resumeSessionId`, set `codexDurability.state === 'durable'`, do not attach a client, and then expect `terminal.exit`

For the blocked-recovery case with `exitCode: 9`, expect the same `recoverableForRestore: true` flag because the terminal is still detached and durable even though the PTY exit code is non-zero. Keep non-durable, attached, and explicit-close expectations exact without the flag.

Change `server/ws-handler.ts`:

```ts
  private onTerminalExitBound = (payload: { terminalId?: string; recoverableForRestore?: boolean }) => {
    if (!payload?.terminalId) return
    this.forgetCreatedRequestIdsForTerminal(payload.terminalId)
    if (!payload.recoverableForRestore) return
    this.broadcastTerminalsChanged({
      recoverableTerminalIds: [payload.terminalId],
    })
  }
```

Update the broadcast method:

```ts
  broadcastTerminalsChanged(options: { recoverableTerminalIds?: string[] } = {}): void {
    this.terminalsRevision += 1
    const recoverableTerminalIds = (options.recoverableTerminalIds || [])
      .filter((terminalId): terminalId is string => typeof terminalId === 'string' && terminalId.length > 0)
    this.broadcastAuthenticated({
      type: 'terminals.changed',
      revision: this.terminalsRevision,
      ...(recoverableTerminalIds.length > 0 ? { recoverableTerminalIds } : {}),
    })
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/server/ws-handshake-snapshot.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/ws-protocol.ts server/terminal-registry.ts server/ws-handler.ts test/unit/server/terminal-registry.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/server/ws-handshake-snapshot.test.ts
git commit -m "fix: broadcast recoverable terminal invalidations"
```

---

### Task 2: Exact Client Stale-Handle Clearing

**Files:**
- Modify: `src/store/panesSlice.ts`
- Modify: `src/lib/terminal-invalidation-handler.ts`
- Test: `test/unit/client/store/panesSlice.test.ts`
- Test: `test/unit/client/lib/terminal-invalidation-handler.test.ts`

**Interfaces:**
- Consumes: `terminalIds: string[]` from `terminals.changed.recoverableTerminalIds`.
- Produces: `clearTerminalLiveHandles({ terminalIds })`, which clears only matching pane `terminalId` values and preserves `sessionRef` for durable restore.

- [ ] **Step 1: Write failing reducer test**

Add to `describe('clearDeadTerminals', ...)` or a new nearby `describe('clearTerminalLiveHandles', ...)` block in `test/unit/client/store/panesSlice.test.ts`:

```ts
it('clears only explicitly removed terminal handles and preserves durable restore state', () => {
  const state = stateWithLayout({
    'tab-1': {
      type: 'leaf',
      id: 'p1',
      content: {
        kind: 'terminal',
        mode: 'codex',
        createRequestId: 'req-dead',
        status: 'running',
        terminalId: 'term-dead',
        serverInstanceId: 'srv-old',
        streamId: 'stream-old',
        sessionRef: { provider: 'codex', sessionId: 'codex-thread-1' },
      },
    } as any,
    'tab-2': {
        type: 'leaf',
        id: 'p2',
        content: {
          kind: 'terminal',
          mode: 'shell',
          createRequestId: 'req-alive',
          status: 'running',
          terminalId: 'term-alive',
        },
      } as any,
  })

  const next = panesReducer(state, clearTerminalLiveHandles({ terminalIds: ['term-dead'] }))
  const dead = next.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
  const alive = next.layouts['tab-2'] as Extract<PaneNode, { type: 'leaf' }>

  expect((dead.content as TerminalPaneContent).terminalId).toBeUndefined()
  expect((dead.content as TerminalPaneContent).status).toBe('creating')
  expect((dead.content as TerminalPaneContent).createRequestId).not.toBe('req-dead')
  expect((dead.content as TerminalPaneContent).serverInstanceId).toBeUndefined()
  expect((dead.content as TerminalPaneContent).streamId).toBeUndefined()
  expect((dead.content as TerminalPaneContent).sessionRef).toEqual({ provider: 'codex', sessionId: 'codex-thread-1' })
  expect(next.restoreFallbackAttemptsByPane?.['tab-1']?.['p1']).toBeUndefined()

  expect((alive.content as TerminalPaneContent).terminalId).toBe('term-alive')
  expect((alive.content as TerminalPaneContent).status).toBe('running')
  expect((alive.content as TerminalPaneContent).createRequestId).toBe('req-alive')
})
```

- [ ] **Step 2: Write failing invalidation handler test**

Add to `test/unit/client/lib/terminal-invalidation-handler.test.ts`:

```ts
it('forwards recoverable terminal ids from terminals.changed before coalesced refresh', async () => {
  vi.useFakeTimers()
  const dispatch = vi.fn()
  const refresh = createRefreshDoubles()
  const handleRecoverableTerminalIds = vi.fn()
  const handler = createTerminalInvalidationHandler({
    dispatch,
    upsertTerminalMeta,
    removeTerminalMeta,
    patchSessionRunningStateFromTerminalMeta,
    queueActiveSessionWindowRefresh: refresh.queueActiveSessionWindowRefresh,
    fetchTerminalDirectoryWindow: refresh.fetchTerminalDirectoryWindow,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    refreshDelayMs: 50,
    handleRecoverableTerminalIds,
  })

  const handled = handler.handle({
    type: 'terminals.changed',
    revision: 12,
    recoverableTerminalIds: ['term-dead', '', 42, 'term-other'],
  })

  expect(handled).toBe(true)
  expect(handleRecoverableTerminalIds).toHaveBeenCalledWith(['term-dead', 'term-other'])
  expect(refresh.fetchTerminalDirectoryWindow).not.toHaveBeenCalled()

  await vi.advanceTimersByTimeAsync(50)
  expect(refresh.fetchTerminalDirectoryWindow).toHaveBeenCalledTimes(1)
  expect(refresh.queueActiveSessionWindowRefresh).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/store/panesSlice.test.ts test/unit/client/lib/terminal-invalidation-handler.test.ts --run
```

Expected: FAIL because `clearTerminalLiveHandles` and `handleRecoverableTerminalIds` do not exist.

- [ ] **Step 4: Implement exact stale-handle clearing**

In `src/store/panesSlice.ts`, extract the stale terminal clearing body into a local helper used by both reducers:

```ts
function clearTerminalContentForRecreate(
  state: PanesState,
  node: Extract<PaneNode, { type: 'leaf' }>,
  tabId: string,
): void {
  if (node.content?.kind !== 'terminal' || !node.content.terminalId) return
  const staleTerminalId = node.content.terminalId
  const nextRequestId = nanoid()
  node.content.terminalId = undefined
  node.content.serverInstanceId = undefined
  node.content.streamId = undefined
  node.content.status = 'creating'
  node.content.createRequestId = nextRequestId
  if (!sanitizeSessionRef(node.content.sessionRef)) {
    if (!state.restoreFallbackAttemptsByPane) state.restoreFallbackAttemptsByPane = {}
    if (!state.restoreFallbackAttemptsByPane[tabId]) state.restoreFallbackAttemptsByPane[tabId] = {}
    state.restoreFallbackAttemptsByPane[tabId][node.id] = {
      staleTerminalId,
      requestId: nextRequestId,
      reason: 'dead_live_handle_without_session_ref',
    }
  } else {
    clearRestoreFallbackAttemptForPane(state, tabId, node.id)
  }
}
```

Add reducer:

```ts
clearTerminalLiveHandles: (state, action: PayloadAction<{ terminalIds: string[] }>) => {
  const removedSet = new Set(action.payload.terminalIds.filter(Boolean))

  function clearInNode(node: PaneNode, tabId: string): void {
    if (node.type === 'leaf') {
      if (
        node.content?.kind === 'terminal' &&
        node.content.terminalId &&
        removedSet.has(node.content.terminalId)
      ) {
        clearTerminalContentForRecreate(state, node, tabId)
      }
      return
    }
    if (node.type === 'split' && Array.isArray(node.children)) {
      for (const child of node.children) clearInNode(child, tabId)
    }
  }

  for (const [tabId, layout] of Object.entries(state.layouts)) {
    clearInNode(layout, tabId)
  }
},
```

Refactor `clearDeadTerminals` to call the same helper instead of duplicating the body. Export `clearTerminalLiveHandles`.

In `src/lib/terminal-invalidation-handler.ts`, extend deps:

```ts
  handleRecoverableTerminalIds?: (terminalIds: string[]) => void
```

Widen the message type accepted by `handle()`:

```ts
handle(msg: {
  type?: unknown
  upsert?: unknown
  remove?: unknown
  recoverableTerminalIds?: unknown
}): boolean {
```

In the `terminals.changed` branch:

```ts
const recoverableTerminalIds = Array.isArray(msg.recoverableTerminalIds)
  ? msg.recoverableTerminalIds.filter((terminalId): terminalId is string => typeof terminalId === 'string' && terminalId.length > 0)
  : []
if (recoverableTerminalIds.length > 0) {
  deps.handleRecoverableTerminalIds?.(recoverableTerminalIds)
}
scheduleRefresh()
return true
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/store/panesSlice.test.ts test/unit/client/lib/terminal-invalidation-handler.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/panesSlice.ts src/lib/terminal-invalidation-handler.ts test/unit/client/store/panesSlice.test.ts test/unit/client/lib/terminal-invalidation-handler.test.ts
git commit -m "fix: clear exact exited terminal handles"
```

---

### Task 3: App Restore Registration On Live Exit Invalidation

**Files:**
- Modify: `src/App.tsx`
- Test: `test/unit/client/components/App.ws-bootstrap.test.tsx`

**Interfaces:**
- Consumes: `clearTerminalLiveHandles({ terminalIds })` from Task 2.
- Produces: durable panes cleared by `terminals.changed.recoverableTerminalIds` have their new `createRequestId` registered with `addTerminalRestoreRequestId`.

- [ ] **Step 1: Write failing App regression test**

Add to `test/unit/client/components/App.ws-bootstrap.test.tsx` near the existing inventory restore tests:

```tsx
it('restores an unmounted durable pane when terminals.changed removes its live terminal', async () => {
  const sessionRef = {
    provider: 'codex',
    sessionId: 'codex-detached-thread-1',
  }
  const store = createStore({
    tabs: [{
      id: 'tab-detached-codex',
      mode: 'codex',
      status: 'running',
      sessionRef,
    }],
    panes: {
      layouts: {
        'tab-detached-codex': {
          type: 'leaf',
          id: 'pane-detached-codex',
          content: {
            kind: 'terminal',
            createRequestId: 'req-detached-old',
            status: 'running',
            mode: 'codex',
            shell: 'system',
            terminalId: 'term-detached-dead',
            serverInstanceId: 'srv-old',
            streamId: 'stream-old',
            sessionRef,
          },
        },
      },
      activePane: { 'tab-detached-codex': 'pane-detached-codex' },
    },
  })

  render(
    <Provider store={store}>
      <App />
    </Provider>
  )

  await waitFor(() => {
    expect(messageHandler).toBeTypeOf('function')
  })

  act(() => {
    messageHandler?.({
      type: 'terminals.changed',
      revision: 7,
      recoverableTerminalIds: ['term-detached-dead'],
    })
  })

  await waitFor(() => {
    const layout = store.getState().panes.layouts['tab-detached-codex']
    if (!layout || layout.type !== 'leaf') throw new Error('expected leaf layout')
    const content = layout.content
    if (content.kind !== 'terminal') throw new Error('expected terminal pane')

    expect(content.terminalId).toBeUndefined()
    expect(content.serverInstanceId).toBeUndefined()
    expect(content.streamId).toBeUndefined()
    expect(content.status).toBe('creating')
    expect(content.createRequestId).not.toBe('req-detached-old')
    expect(content.sessionRef).toEqual(sessionRef)
    expect(terminalRestoreMocks.addTerminalRestoreRequestId).toHaveBeenCalledWith(content.createRequestId)
    expect(terminalRestoreMocks.addTerminalFreshRecoveryRequestId).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-bootstrap.test.tsx --run
```

Expected: FAIL because `terminals.changed` only schedules refreshes and does not clear the stale live handle or register the restore request.

- [ ] **Step 3: Implement exact pending recovery registration**

In `src/App.tsx`, import `clearTerminalLiveHandles` from `@/store/panesSlice`.

Add helpers near the websocket message handling code:

```ts
const collectTerminalPaneTargets = (terminalIds: string[]) => {
  const terminalIdSet = new Set(terminalIds)
  const layouts = appStore.getState().panes.layouts
  const targets: Array<{ tabId: string; paneId: string }> = []
  for (const [tabId, layout] of Object.entries(layouts)) {
    ;(function walk(node: any) {
      if (!node) return
      if (node.type === 'leaf') {
        if (
          node.content?.kind === 'terminal' &&
          node.content.terminalId &&
          terminalIdSet.has(node.content.terminalId)
        ) {
          targets.push({ tabId, paneId: node.id })
        }
        return
      }
      if (node.type === 'split' && Array.isArray(node.children)) {
        for (const child of node.children) walk(child)
      }
    })(layout)
  }
  return targets
}

const findPaneById = (layout: any, paneId: string): any | undefined => {
  if (!layout) return undefined
  if (layout.type === 'leaf') return layout.id === paneId ? layout : undefined
  if (layout.type === 'split' && Array.isArray(layout.children)) {
    for (const child of layout.children) {
      const found = findPaneById(child, paneId)
      if (found) return found
    }
  }
  return undefined
}

const registerPendingTerminalRecoveriesForTargets = (targets: Array<{ tabId: string; paneId: string }>) => {
  const state = appStore.getState()
  const fallbackAttempts = state.panes.restoreFallbackAttemptsByPane || {}
  for (const target of targets) {
    const pane = findPaneById(state.panes.layouts[target.tabId], target.paneId)
    const content = pane?.content
    if (content?.kind !== 'terminal' || content.status !== 'creating' || !content.createRequestId) continue
    const fallbackAttempt = fallbackAttempts[target.tabId]?.[target.paneId]
    if (
      fallbackAttempt?.requestId === content.createRequestId &&
      !content.sessionRef
    ) {
      addTerminalFreshRecoveryRequestId(
        content.createRequestId,
        'fresh_after_restore_unavailable',
      )
    } else if (content.sessionRef) {
      addTerminalRestoreRequestId(content.createRequestId)
    }
  }
}
```

Keep the existing full `terminal.inventory` recovery scan as the broad authoritative-inventory path. Use `registerPendingTerminalRecoveriesForTargets()` only for `recoverableTerminalIds`. Do not use a broad all-pane scan for `recoverableTerminalIds`, because unrelated already-creating panes must not be marked as restore attempts for this event.

Pass this callback to `createTerminalInvalidationHandler`:

```ts
handleRecoverableTerminalIds: (terminalIds) => {
  const targets = collectTerminalPaneTargets(terminalIds)
  if (targets.length === 0) return
  const removedSet = new Set(terminalIds)
  const currentLiveIds = appStore.getState().connection.liveTerminalIds
  if (currentLiveIds) {
    dispatch(setLiveTerminalIds(currentLiveIds.filter((terminalId) => !removedSet.has(terminalId))))
  }
  dispatch(clearTerminalLiveHandles({ terminalIds }))
  for (const terminalId of terminalIds) {
    dispatch(removeTerminalMeta(terminalId))
  }
  registerPendingTerminalRecoveriesForTargets(targets)
},
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/lib/terminal-invalidation-handler.test.ts test/unit/client/store/panesSlice.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Run regression-adjacent e2e/unit coverage**

Run:

```bash
npm run test:vitest -- test/e2e/codex-refresh-rehydrate-flow.test.tsx test/e2e/terminal-restart-recovery.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "fix: restore durable panes after exit invalidation"
```

---

### Task 4: Clean Restore Startup Exits

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Test: `test/server/ws-edge-cases.test.ts`

**Interfaces:**
- Consumes: exited-terminal attach errors for restore launches, shaped as `ErrorMessage` with `code: 'INVALID_TERMINAL_ID'`, `terminalId`, and `terminalExitCode?: number`.
- Produces: restored terminals that exit with code 0 before attach completes settle as `exited`; non-zero restore startup exits still settle as `error`.

- [ ] **Step 1: Write failing TerminalView tests**

Add tests near the existing restore startup failure coverage in `test/unit/client/components/TerminalView.lifecycle.test.tsx`.

First test: arrange a terminal pane with `sessionRef` and a request id registered via `addTerminalRestoreRequestId`; simulate `terminal.created` for that request, then an `INVALID_TERMINAL_ID` attach error for the created terminal with `terminalExitCode: 0`. Assert pane content has `status: 'exited'`, `terminalId` and `streamId` cleared, `restoreError` undefined, tab status `exited`, terminal output does not contain `[Restore failed]`, and terminal output includes a neutral clean-exit notice.

Second test: simulate the direct `terminal.exit` path by sending `terminal.created` for a restore request followed by `terminal.exit` with `exitCode: 0` before `terminal.attach.ready`. Assert the same clean exited state and no `[Restore failed]` output.

Third test: tighten the existing non-zero restore startup failure test by including `terminalExitCode: 1` on the `INVALID_TERMINAL_ID` error and preserving the current assertions that pane and tab status become `error` and the output contains `[Restore failed]`.

- [ ] **Step 2: Write failing server attach-error test**

In `test/server/ws-edge-cases.test.ts`, add a new clean-exit exited-terminal attach test so an attach to an exited record proves the error payload includes structured exit code. The assertion must check the actual terminal id created in the test:

```ts
expect(error).toEqual(expect.objectContaining({
  type: 'error',
  code: 'INVALID_TERMINAL_ID',
  terminalId,
  terminalExitCode: 0,
}))
```

Expected: FAIL because `ErrorMessage` does not expose `terminalExitCode` and TerminalView treats all restore startup exits as failures.

- [ ] **Step 3: Implement structured exited-terminal attach errors**

Change `shared/ws-protocol.ts`:

```ts
export type ErrorMessage = {
  type: 'error'
  code: ErrorCode
  message: string
  requestId?: string
  terminalId?: string
  terminalExitCode?: number
  expectedSessionRef?: SessionLocator
  actualSessionRef?: SessionLocator
  timestamp: string
}
```

Change `server/ws-handler.ts`:

```ts
private sendError(
  ws: LiveWebSocket,
  params: {
    code: z.infer<typeof ErrorCode>
    message: string
    requestId?: string
    terminalId?: string
    terminalExitCode?: number
    expectedSessionRef?: { provider: string; sessionId: string }
    actualSessionRef?: { provider: string; sessionId: string }
  },
) {
  // include terminalExitCode in the sent error object only when it is a number
}
```

For each `terminal.attach` path that formats an exited record with `formatExitedTerminalAttachMessage(record)`, pass:

```ts
terminalExitCode: latestRecord.exitCode,
```

or `record.exitCode` at the earlier exited-record branch.

- [ ] **Step 4: Implement clean restore exit settlement**

In `src/components/TerminalView.tsx`, extract a helper local to the lifecycle effect:

```ts
const settleCleanRestoreStartupExit = (terminalId: string, message?: string) => {
  clearRateLimitRetry()
  setIsAttaching(false)
  currentAttachRef.current = null
  launchAttemptRef.current = null
  deferredAttachStateRef.current = {
    mode: 'none',
    pendingIntent: null,
    pendingSinceSeq: 0,
    pendingReason: 'initial_hydrate',
  }
  dispatch(clearPaneRuntimeActivity({ paneId: paneIdRef.current }))
  clearTerminalCursor(terminalId)
  resetParserAppliedSurface()
  forgetSentViewport(terminalId)
  lastSentViewportRef.current = null
  terminalIdRef.current = undefined
  applySeqState(createAttachSeqState())
  updateContent({
    terminalId: undefined,
    streamId: undefined,
    status: 'exited',
    restoreError: undefined,
  })
  const currentTab = tabRef.current
  if (currentTab) {
    dispatch(updateTab({ id: currentTab.id, updates: { status: 'exited' } }))
  }
  writeLocalXtermNotice(term, `\r\n[Restored terminal exited cleanly${message ? `: ${message}` : ''}]\r\n`)
}
```

Use it in both startup-exit sites before `failLaunch()`:

```ts
if (
  exitedDuringLaunch
  && launchAttempt.restore
  && msg.exitCode === 0
  && contentRef.current?.sessionRef
) {
  settleCleanRestoreStartupExit(tid)
  return
}
```

and:

```ts
if (
  failedDuringLaunch
  && launchAttempt?.restore
  && msg.terminalExitCode === 0
  && current?.sessionRef
) {
  settleCleanRestoreStartupExit(currentTerminalId, msg.message)
  return
}
```

Do not apply this to shell launches, non-restore launches, restores without `sessionRef`, or non-zero exits; those remain failure paths.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/server/ws-edge-cases.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/server/ws-edge-cases.test.ts
git commit -m "fix: treat clean restore exits as exited"
```

---

### Task 5: Final Verification

**Files:**
- No code changes unless a verification failure identifies a defect.

**Interfaces:**
- Consumes: all commits from Tasks 1-4.
- Produces: verified branch ready for review and PR approval request.

- [ ] **Step 1: Run typecheck and coordinated suite**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 2: Run full build plus coordinated suite if check passes**

Run:

```bash
npm run verify
```

Expected: PASS.

- [ ] **Step 3: Inspect git status**

Run:

```bash
git status --short --branch
```

Expected: branch `fix-stale-terminal-durable-resume` has only committed changes, with ignored/untracked generated dependency links left uncommitted.

- [ ] **Step 4: Commit any verification-only fixes**

If verification required fixes, commit them with:

```bash
git add <changed files>
git commit -m "test: cover stale terminal resume recovery"
```

Expected: no uncommitted source changes remain.

---

## Self-Review

**Spec coverage:** The plan addresses both user questions: detached hidden panes can exist without attached clients, and idle-killed detached terminal reconnect now becomes deterministic because a recoverable server exit invalidation clears stale live handles before the user interacts with the pane.

**Placeholder scan:** No task uses TBD/TODO/fill-in language. Each task has explicit files, snippets, commands, and expected results.

**Type consistency:** `recoverableTerminalIds` is introduced in `TerminalsChangedMessage`, emitted by `broadcastTerminalsChanged`, consumed by `createTerminalInvalidationHandler`, and translated into `clearTerminalLiveHandles`.

# Pane-Based Architecture Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the regressions and correctness issues found in the pane-based architecture worktree vs `main` (sessions chunking, terminal lifecycle races, cross-tab sync duplication, queue overflow dedupe bugs, idle warning regression, and missing git-tracked files) with strong unit/integration coverage.

**Architecture:** Keep terminal lifecycle state pane-owned in Redux, centralize terminal/session cleanup in `paneCleanupListeners`, and treat the WebSocket protocol as authoritative. Client state must handle chunked `sessions.updated`, avoid duplicate attach/snapshot races, and synchronize across tabs without double-processing.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, Vite, Vitest, Node/Express, `ws`, Zod.

---

### Task 1: Check In Currently Untracked Core Modules

**Why:** The worktree currently has untracked files that are imported by production code; they must be committed so the branch is reproducible/reviewable.

**Files:**
- Add: `src/store/persistedState.ts`
- Add: `src/store/persistBroadcast.ts`
- Add: `src/store/crossTabSync.ts`
- Add: `src/store/paneCleanupListeners.ts`
- Add: `test/unit/client/store/persistedState.test.ts`
- Add: `test/unit/client/store/crossTabSync.test.ts`
- Add: `test/unit/client/store/paneCleanupListeners.test.ts`
- Add: `test/unit/client/store/paneCleanupThunks.test.ts`

**Step 1: Run the smallest relevant tests to ensure we are not committing broken files**

Run:
```bash
npm test -- test/unit/client/store/persistedState.test.ts
```
Expected: PASS

**Step 2: Stage the files**

Run:
```bash
git add src/store/persistedState.ts src/store/persistBroadcast.ts src/store/crossTabSync.ts src/store/paneCleanupListeners.ts
git add test/unit/client/store/persistedState.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/paneCleanupListeners.test.ts test/unit/client/store/paneCleanupThunks.test.ts
```

**Step 3: Commit**

Run:
```bash
git commit -m "chore: check in persisted state + cross-tab + cleanup modules"
```

---

### Task 2: Add Red Test For Chunked `sessions.updated` Handling

**Issue:** The server sends chunked session updates using `clear`/`append` flags (`server/ws-handler.ts`), but the client currently ignores them and calls `setProjects` for each chunk, losing data.

**Files:**
- Modify: `test/unit/client/components/App.test.tsx`
- Modify (later): `src/App.tsx`

**Step 1: Write the failing test**

Add a new test case:
```tsx
it('merges chunked sessions.updated messages (clear/append) instead of replacing', async () => {
  let handler: ((msg: any) => void) | null = null
  mockOnMessage.mockImplementation((cb: (msg: any) => void) => {
    handler = cb
    return () => { handler = null }
  })

  const store = createTestStore()
  renderApp(store)

  await waitFor(() => expect(handler).not.toBeNull())

  handler!({
    type: 'sessions.updated',
    clear: true,
    projects: [{ projectPath: '/p1', sessions: [{ provider: 'claude', sessionId: 's1', updatedAt: 1 }] }],
  })
  handler!({
    type: 'sessions.updated',
    append: true,
    projects: [{ projectPath: '/p2', sessions: [{ provider: 'claude', sessionId: 's2', updatedAt: 2 }] }],
  })

  await waitFor(() => {
    expect(store.getState().sessions.projects.map((p) => p.projectPath).sort()).toEqual(['/p1', '/p2'])
  })
})
```

**Step 2: Run the test to verify it fails**

Run:
```bash
npm test -- test/unit/client/components/App.test.tsx -t "merges chunked sessions.updated"
```
Expected: FAIL (only last chunk is present).

**Step 3: Commit the failing test**

Run:
```bash
git add test/unit/client/components/App.test.tsx
git commit -m "test: assert App merges chunked sessions.updated updates"
```

---

### Task 3: Implement Chunked `sessions.updated` Handling In The Client

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/store/sessionsSlice.ts` (only if needed; likely not)
- Test: `test/unit/client/components/App.test.tsx`

**Step 1: Minimal implementation**

Update the WS message handler in `src/App.tsx` to restore chunk handling:
```ts
import { setProjects, clearProjects, mergeProjects } from '@/store/sessionsSlice'

// ...
if (msg.type === 'sessions.updated') {
  if (msg.clear) {
    dispatch(clearProjects())
    dispatch(mergeProjects(msg.projects || []))
  } else if (msg.append) {
    dispatch(mergeProjects(msg.projects || []))
  } else {
    dispatch(setProjects(msg.projects || []))
  }
}
```

**Step 2: Run the test to verify it passes**

Run:
```bash
npm test -- test/unit/client/components/App.test.tsx -t "merges chunked sessions.updated"
```
Expected: PASS

**Step 3: Run the server chunking test to ensure protocol still matches**

Run:
```bash
npm test -- test/server/ws-handshake-snapshot.test.ts
```
Expected: PASS

**Step 4: Commit**

Run:
```bash
git add src/App.tsx
git commit -m "fix: handle chunked sessions.updated (clear/append) on client"
```

---

### Task 4: Add Red Tests For Terminal Create Attach/Snapshot Race + Unmount Detach

**Issues:**
- Client currently sends `terminal.attach` immediately after receiving `terminal.created`, but the server already attached the creator. This can cause a second snapshot to clear output (race).
- Client also detaches on component unmount, bypassing the new reference-counted cleanup middleware.

**Files:**
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify (later): `src/components/TerminalView.tsx`

**Step 1: Write failing test for "no terminal.attach on terminal.created"**

Add:
```tsx
it('does not send terminal.attach after terminal.created (creator is already attached server-side)', async () => {
  const tabId = 'tab-created'
  const paneId = 'pane-created'
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-created',
    status: 'creating',
    mode: 'shell',
    shell: 'system',
  }

  const store = configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, settings: settingsReducer, connection: connectionReducer },
    preloadedState: {
      tabs: { tabs: [{ id: tabId, title: 'Tab', createdAt: Date.now() }], activeTabId: tabId },
      panes: { layouts: { [tabId]: { type: 'leaf', id: paneId, content: paneContent } }, activePane: { [tabId]: paneId }, paneTitles: {}, paneTitleSetByUser: {} },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'connected', error: null },
    },
  })

  render(<Provider store={store}><TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} /></Provider>)
  await waitFor(() => expect(messageHandler).not.toBeNull())

  wsMocks.send.mockClear()
  messageHandler!({ type: 'terminal.created', requestId: 'req-created', terminalId: 'term-123', snapshot: '', createdAt: Date.now() })

  expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal.attach' }))
  expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal.resize', terminalId: 'term-123' }))
})
```

**Step 2: Write failing test for "unmount does not detach directly"**

Add:
```tsx
it('does not detach on unmount (cleanup is handled by paneCleanupListeners)', async () => {
  const tabId = 'tab-unmount'
  const paneId = 'pane-unmount'
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-unmount',
    status: 'creating',
    mode: 'shell',
    shell: 'system',
  }

  const store = configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer, settings: settingsReducer, connection: connectionReducer },
    preloadedState: {
      tabs: { tabs: [{ id: tabId, title: 'Tab', createdAt: Date.now() }], activeTabId: tabId },
      panes: { layouts: { [tabId]: { type: 'leaf', id: paneId, content: paneContent } }, activePane: { [tabId]: paneId }, paneTitles: {}, paneTitleSetByUser: {} },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'connected', error: null },
    },
  })

  const rendered = render(<Provider store={store}><TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} /></Provider>)
  await waitFor(() => expect(messageHandler).not.toBeNull())

  messageHandler!({ type: 'terminal.created', requestId: 'req-unmount', terminalId: 'term-unmount', snapshot: '', createdAt: Date.now() })

  wsMocks.send.mockClear()
  rendered.unmount()

  expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'terminal.detach' }))
})
```

**Step 3: Run the tests to verify they fail**

Run:
```bash
npm test -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "does not send terminal.attach after terminal.created"
```
Expected: FAIL (currently sends `terminal.attach`).

**Step 4: Commit the failing tests**

Run:
```bash
git add test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "test: guard TerminalView against attach-after-created and unmount-detach"
```

---

### Task 5: Fix TerminalView Create/Attach Flow And Remove Unmount Detach

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Step 1: Minimal implementation**

In the `terminal.created` handler:
- Do not call `attach(newId)`
- Send only a `terminal.resize`
- Clear the attaching spinner

Example change:
```ts
if (msg.type === 'terminal.created' && msg.requestId === reqId) {
  const newId = msg.terminalId as string
  terminalIdRef.current = newId
  updateContent({ terminalId: newId, status: 'running' })
  if (msg.snapshot) {
    try { xtermApi.clear(); xtermApi.write(msg.snapshot) } catch { /* disposed */ }
  }
  setIsAttaching(false)
  ws.send({ type: 'terminal.resize', terminalId: newId, cols: xtermApi.cols, rows: xtermApi.rows })
}
```

Remove the unmount detach effect entirely:
```ts
// Delete this effect from TerminalView.tsx:
// useEffect(() => () => ws.send({ type: 'terminal.detach', terminalId: tid }), [ws])
```

**Step 2: Run the focused tests**

Run:
```bash
npm test -- test/unit/client/components/TerminalView.lifecycle.test.tsx -t "does not send terminal.attach after terminal.created"
```
Expected: PASS

**Step 3: Run the whole TerminalView test suite**

Run:
```bash
npm test -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```
Expected: PASS

**Step 4: Commit**

Run:
```bash
git add src/components/TerminalView.tsx
git commit -m "fix: avoid attach-after-created and rely on centralized cleanup"
```

---

### Task 6: Add Red Test For `useTerminalActivityMonitor` Interval Stability

**Issue:** The interval effect currently depends on the entire `working` object and tears down/recreates the interval on each state change.

**Files:**
- Modify: `test/unit/client/hooks/useTerminalActivityMonitor.test.tsx`
- Modify (later): `src/hooks/useTerminalActivityMonitor.ts`

**Step 1: Add failing test**

Add under `describe('periodic activity timeout check')`:
```tsx
it('does not recreate the interval on unrelated working-map updates while still working', async () => {
  const store = createStore(baseTime)
  const setIntervalSpy = vi.spyOn(window, 'setInterval')
  const clearIntervalSpy = vi.spyOn(window, 'clearInterval')

  render(<Provider store={store}><TestComponent /></Provider>)

  expect(setIntervalSpy).toHaveBeenCalledTimes(1)

  await act(async () => {
    // This keeps working=true but updates the working map reference
    store.dispatch({ type: 'terminalActivity/recordOutput', payload: { paneId: 'pane-1', at: baseTime + 10 } })
    store.dispatch({ type: 'terminalActivity/recordOutput', payload: { paneId: 'pane-1', at: baseTime + 20 } })
  })

  expect(clearIntervalSpy).not.toHaveBeenCalled()
  expect(setIntervalSpy).toHaveBeenCalledTimes(1)
})
```

**Step 2: Run to confirm it fails**

Run:
```bash
npm test -- test/unit/client/hooks/useTerminalActivityMonitor.test.tsx -t "does not recreate the interval"
```
Expected: FAIL (interval is cleared/recreated).

**Step 3: Commit the failing test**

Run:
```bash
git add test/unit/client/hooks/useTerminalActivityMonitor.test.tsx
git commit -m "test: ensure terminal activity monitor interval is stable"
```

---

### Task 7: Fix `useTerminalActivityMonitor` To Depend On A Boolean, Not The Whole Map

**Files:**
- Modify: `src/hooks/useTerminalActivityMonitor.ts`
- Test: `test/unit/client/hooks/useTerminalActivityMonitor.test.tsx`

**Step 1: Minimal implementation**

Change to select a boolean:
```ts
const hasWorkingPanes = useAppSelector((state) =>
  Object.values(state.terminalActivity?.working ?? EMPTY_ACTIVITY_FLAGS).some(Boolean)
)

useEffect(() => {
  if (!hasWorkingPanes) {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    return
  }
  if (!intervalRef.current) {
    intervalRef.current = setInterval(() => dispatch(checkActivityTimeout({})), ACTIVITY_CHECK_INTERVAL_MS)
  }
  return () => {}
}, [dispatch, hasWorkingPanes])
```

**Step 2: Run the focused test**

Run:
```bash
npm test -- test/unit/client/hooks/useTerminalActivityMonitor.test.tsx -t "does not recreate the interval"
```
Expected: PASS

**Step 3: Run the full hook test file**

Run:
```bash
npm test -- test/unit/client/hooks/useTerminalActivityMonitor.test.tsx
```
Expected: PASS

**Step 4: Commit**

Run:
```bash
git add src/hooks/useTerminalActivityMonitor.ts
git commit -m "fix: keep terminal activity monitor interval stable"
```

---

### Task 8: Add Red Test For History Session "Open" Detection Including Session Panes

**Issue:** `buildMenuItems` disables destructive actions when a history session is already open, but it currently checks only terminal panes (resumeSessionId), not `kind: 'session'` panes.

**Files:**
- Create: `test/unit/client/components/context-menu/menu-defs.test.ts`
- Modify (later): `src/components/context-menu/menu-defs.ts`

**Step 1: Write failing test**

Create `test/unit/client/components/context-menu/menu-defs.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildMenuItems } from '@/components/context-menu/menu-defs'

describe('menu-defs history-session', () => {
  it('treats session panes as open sessions (disables delete)', () => {
    const items = buildMenuItems(
      { kind: 'history-session', sessionId: 's1', provider: 'claude' } as any,
      {
        view: 'sessions',
        sidebarCollapsed: false,
        tabs: [{ id: 't1', title: 'Tab', createdAt: 1 }] as any,
        paneLayouts: {
          t1: { type: 'leaf', id: 'p1', content: { kind: 'session', sessionId: 's1', provider: 'claude', title: 'Session' } } as any,
        },
        sessions: [{ projectPath: '/p', sessions: [{ provider: 'claude', sessionId: 's1', updatedAt: 1 }] }] as any,
        expandedProjects: new Set(),
        contextElement: null,
        platform: null,
        actions: new Proxy({}, { get: () => () => {} }) as any,
      }
    )

    const del = items.find((i: any) => i.id === 'history-session-delete')
    expect(del).toBeTruthy()
    expect((del as any).disabled).toBe(true)
  })
})
```

**Step 2: Run to confirm it fails**

Run:
```bash
npm test -- test/unit/client/components/context-menu/menu-defs.test.ts
```
Expected: FAIL (delete not disabled).

**Step 3: Commit the failing test**

Run:
```bash
git add test/unit/client/components/context-menu/menu-defs.test.ts
git commit -m "test: history-session menu treats session panes as open"
```

---

### Task 9: Fix History Session "Open" Detection To Include Session Panes

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Test: `test/unit/client/components/context-menu/menu-defs.test.ts`

**Step 1: Minimal implementation**

Update the `history-session` section to check both:
- terminal panes where `terminal.content.resumeSessionId` matches and provider matches
- session panes where `sessionPane.content.sessionId` matches and provider matches

Example:
```ts
import { collectTerminalPanes, collectSessionPanes, findPaneContent } from '@/lib/pane-utils'

const provider = target.provider || 'claude'
const isOpen = Object.values(paneLayouts).some((layout) => {
  for (const t of collectTerminalPanes(layout)) {
    if (t.content.resumeSessionId === target.sessionId && t.content.mode === provider) return true
  }
  for (const s of collectSessionPanes(layout)) {
    if (s.content.sessionId === target.sessionId && (s.content.provider || 'claude') === provider) return true
  }
  return false
})
```

**Step 2: Run the new unit test**

Run:
```bash
npm test -- test/unit/client/components/context-menu/menu-defs.test.ts
```
Expected: PASS

**Step 3: Commit**

Run:
```bash
git add src/components/context-menu/menu-defs.ts
git commit -m "fix: treat session panes as open sessions in history context menu"
```

---

### Task 10: Add Red Test For WsClient Queue Overflow Clearing `terminal.create` Dedupe

**Issue:** When `pendingMessages` exceeds `maxQueueSize`, we drop the oldest message but do not clear its requestId from `inFlightTerminalCreateRequestIds`, potentially blocking terminal creation forever.

**Files:**
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Modify (later): `src/lib/ws-client.ts`

**Step 1: Write failing test**

Add:
```ts
it('clears terminal.create dedupe when an enqueued create is dropped due to queue overflow', async () => {
  const c = new WsClient('ws://example/ws')
  const p = c.connect()
  const ws = MockWebSocket.instances[0]

  const requestId = 'req-drop'
  c.send({ type: 'terminal.create', requestId, mode: 'shell' })

  // Overflow the queue to drop the first message (maxQueueSize = 1000).
  for (let i = 0; i < 1000; i++) {
    c.send({ type: 'noop', i })
  }

  // Re-send should be allowed because the original was dropped.
  c.send({ type: 'terminal.create', requestId, mode: 'shell' })

  ws._open()
  ws._message({ type: 'ready' })
  await p

  const sent = ws.sent.map((s) => JSON.parse(s))
  const creates = sent.filter((m) => m.type === 'terminal.create' && m.requestId === requestId)
  expect(creates).toHaveLength(1)
})
```

**Step 2: Run to confirm it fails**

Run:
```bash
npm test -- test/unit/client/lib/ws-client.test.ts -t "queue overflow"
```
Expected: FAIL (0 create messages sent for `req-drop`).

**Step 3: Commit the failing test**

Run:
```bash
git add test/unit/client/lib/ws-client.test.ts
git commit -m "test: ws-client clears create dedupe when queue drops oldest"
```

---

### Task 11: Fix WsClient Queue Drop To Clear In-Flight Create RequestIds

**Files:**
- Modify: `src/lib/ws-client.ts`
- Test: `test/unit/client/lib/ws-client.test.ts`

**Step 1: Minimal implementation**

When dropping `pendingMessages.shift()`, inspect the dropped message:
```ts
if (this.pendingMessages.length >= this.maxQueueSize) {
  const dropped = this.pendingMessages.shift()
  if (dropped && typeof dropped === 'object' && (dropped as any).type === 'terminal.create') {
    const rid = (dropped as any).requestId
    if (typeof rid === 'string' && rid) this.inFlightTerminalCreateRequestIds.delete(rid)
  }
}
```

**Step 2: Run the focused test**

Run:
```bash
npm test -- test/unit/client/lib/ws-client.test.ts -t "queue overflow"
```
Expected: PASS

**Step 3: Commit**

Run:
```bash
git add src/lib/ws-client.ts
git commit -m "fix: clear terminal.create dedupe when queued create is dropped"
```

---

### Task 12: Add Red Test For Cross-Tab Sync Double-Processing (Storage + Broadcast)

**Issue:** Other tabs can receive the same persisted update twice (storage event + BroadcastChannel), causing redundant hydrates.

**Files:**
- Modify: `test/unit/client/store/crossTabSync.test.ts`
- Modify (later): `src/store/crossTabSync.ts`

**Step 1: Write failing test**

Add:
```ts
it('dedupes identical persisted payloads delivered via both storage and BroadcastChannel', () => {
  const dispatchSpy = vi.fn()
  const storeLike = {
    dispatch: dispatchSpy,
    getState: () => ({ tabs: { activeTabId: null }, panes: { activePane: {} } }),
  }

  // Minimal BroadcastChannel stub
  const original = (globalThis as any).BroadcastChannel
  class MockBC {
    static instance: MockBC | null = null
    onmessage: ((ev: any) => void) | null = null
    constructor(_name: string) { MockBC.instance = this }
    close() {}
  }
  ;(globalThis as any).BroadcastChannel = MockBC

  try {
    const cleanup = installCrossTabSync(storeLike as any)

    const raw = JSON.stringify({ version: 1, tabs: { activeTabId: null, tabs: [{ id: 't1', title: 'T1', createdAt: 1 }] } })
    window.dispatchEvent(new StorageEvent('storage', { key: TABS_STORAGE_KEY, newValue: raw }))

    // Simulate BroadcastChannel delivering the same payload.
    MockBC.instance!.onmessage?.({ data: { type: 'persist', key: TABS_STORAGE_KEY, raw, sourceId: 'other' } })

    const hydrateCalls = dispatchSpy.mock.calls
      .map((c) => c[0])
      .filter((a: any) => a?.type === 'tabs/hydrateTabs')
    expect(hydrateCalls).toHaveLength(1)

    cleanup()
  } finally {
    ;(globalThis as any).BroadcastChannel = original
  }
})
```

**Step 2: Run to confirm it fails**

Run:
```bash
npm test -- test/unit/client/store/crossTabSync.test.ts -t "dedupes identical persisted payloads"
```
Expected: FAIL (hydrate dispatched twice).

**Step 3: Commit the failing test**

Run:
```bash
git add test/unit/client/store/crossTabSync.test.ts
git commit -m "test: cross-tab sync dedupes identical payloads"
```

---

### Task 13: Implement Cross-Tab Sync Dedupe By `(key, raw)`

**Files:**
- Modify: `src/store/crossTabSync.ts`
- Test: `test/unit/client/store/crossTabSync.test.ts`

**Step 1: Minimal implementation**

In `installCrossTabSync`, keep an in-memory cache:
```ts
const lastProcessedRawByKey = new Map<string, string>()

function handleIncomingRaw(store: StoreLike, key: string, raw: string) {
  if (lastProcessedRawByKey.get(key) === raw) return
  lastProcessedRawByKey.set(key, raw)
  // existing routing...
}
```

**Step 2: Run the focused test**

Run:
```bash
npm test -- test/unit/client/store/crossTabSync.test.ts -t "dedupes identical persisted payloads"
```
Expected: PASS

**Step 3: Commit**

Run:
```bash
git add src/store/crossTabSync.ts
git commit -m "fix: dedupe cross-tab persisted hydration"
```

---

### Task 14: Add Red Server Test For `terminal.create.cancel` Kill Restriction Across Connections

**Issue:** `terminal.create.cancel` currently uses the global requestId mapping for both detach and kill. A different connection can kill a terminal by requestId if it exists in the global cache.

**Files:**
- Modify: `test/server/ws-protocol.test.ts`
- Modify (later): `server/ws-handler.ts`

**Step 1: Write failing test**

Add:
```ts
it('terminal.create.cancel kill=true does not kill when requestId belongs to a different connection', async () => {
  const { ws: ws1, close: close1 } = await createAuthenticatedConnection()
  const requestId = 'cancel-cross-conn'
  const terminalId = await createTerminal(ws1, requestId)

  const { ws: ws2, close: close2 } = await createAuthenticatedConnection()
  ws2.send(JSON.stringify({ type: 'terminal.create.cancel', requestId, kill: true }))

  await new Promise((r) => setTimeout(r, 20))
  expect(registry.killCalls).not.toContain(terminalId)
  expect(registry.records.has(terminalId)).toBe(true)

  await close1()
  await close2()
})
```

**Step 2: Run to confirm it fails**

Run:
```bash
npm test -- test/server/ws-protocol.test.ts -t "cancel-cross-conn"
```
Expected: FAIL (terminal gets killed).

**Step 3: Commit failing test**

Run:
```bash
git add test/server/ws-protocol.test.ts
git commit -m "test(server): prevent cross-connection kill via terminal.create.cancel"
```

---

### Task 15: Restrict `terminal.create.cancel` Kill To Local Mapping (Detach Still Allowed)

**Files:**
- Modify: `server/ws-handler.ts`
- Test: `test/server/ws-protocol.test.ts`

**Step 1: Minimal implementation**

In the `terminal.create.cancel` handler, only allow `kill: true` when the requestId exists in the current connection’s `state.createdByRequestId`.

Example:
```ts
case 'terminal.create.cancel': {
  const requestId = m.requestId
  const kill = !!m.kill

  const localTerminalId = state.createdByRequestId.get(requestId)
  const globalTerminalId = localTerminalId ? undefined : this.getGlobalRequestIdMapping(requestId)
  const terminalId = localTerminalId || globalTerminalId
  if (!terminalId) return

  if (kill && !localTerminalId) {
    // Safety: don't allow kill via global mapping.
    this.registry.detach(terminalId, ws)
  } else if (kill) {
    this.registry.kill(terminalId)
    this.globalCreatedByRequestId.delete(requestId)
  } else {
    this.registry.detach(terminalId, ws)
  }
  state.attachedTerminalIds.delete(terminalId)
  this.broadcast({ type: 'terminal.list.updated' })
  return
}
```

**Step 2: Run the focused server test**

Run:
```bash
npm test -- test/server/ws-protocol.test.ts -t "cancel-cross-conn"
```
Expected: PASS

**Step 3: Run existing cancel tests**

Run:
```bash
npm test -- test/server/ws-protocol.test.ts -t "terminal.create.cancel"
```
Expected: PASS

**Step 4: Commit**

Run:
```bash
git add server/ws-handler.ts
git commit -m "fix(server): restrict terminal.create.cancel kill to local request mapping"
```

---

### Task 16: Restore Idle Warning Feature (Red Test)

**Issue:** Server still emits `terminal.idle.warning`, but the client no longer stores/displays it (regression vs `main`).

**Files:**
- Modify: `test/unit/client/components/App.test.tsx`
- Modify (later): `src/store/store.ts`
- Modify (later): `src/App.tsx`
- Modify (later): `src/store/types.ts` (only if types need restoration; likely not)

**Step 1: Port the idle warning test from `main` (failing on this branch)**

Add (or restore) a block similar to:
```tsx
describe('App Component - Idle Warnings', () => {
  let messageHandler: ((msg: any) => void) | null = null

  beforeEach(() => {
    mockOnMessage.mockImplementation((cb: (msg: any) => void) => {
      messageHandler = cb
      return () => { messageHandler = null }
    })
    mockApiGet.mockImplementation((url: string) => {
      if (url === '/api/settings') return Promise.resolve(defaultSettings)
      if (url === '/api/platform') return Promise.resolve({ platform: 'linux' })
      if (url === '/api/sessions') return Promise.resolve([])
      return Promise.resolve({})
    })
  })

  it('shows an indicator when the server warns an idle terminal will auto-kill soon', async () => {
    renderApp()
    await waitFor(() => expect(messageHandler).not.toBeNull())

    messageHandler!({
      type: 'terminal.idle.warning',
      terminalId: 'term-idle',
      killMinutes: 10,
      warnMinutes: 3,
      lastActivityAt: Date.now(),
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /auto-kill soon/i })).toBeInTheDocument()
    })
  })
})
```

Ensure the test store includes the reducer:
```ts
import idleWarningsReducer from '@/store/idleWarningsSlice'
// ...
reducer: { /* ... */, idleWarnings: idleWarningsReducer }
```

**Step 2: Run to confirm it fails**

Run:
```bash
npm test -- test/unit/client/components/App.test.tsx -t "Idle Warnings"
```
Expected: FAIL (indicator missing).

**Step 3: Commit failing test**

Run:
```bash
git add test/unit/client/components/App.test.tsx
git commit -m "test: restore App idle warning indicator behavior"
```

---

### Task 17: Restore Idle Warning State + UI + WS Handling

**Files:**
- Modify: `src/store/store.ts`
- Modify: `src/App.tsx`
- Test: `test/unit/client/components/App.test.tsx`

**Step 1: Re-add reducer to the store**

In `src/store/store.ts`:
```ts
import idleWarningsReducer from './idleWarningsSlice'

reducer: {
  // ...
  idleWarnings: idleWarningsReducer,
}
```

**Step 2: Restore WS message handling and UI indicator**

In `src/App.tsx`:
- Reintroduce selector for warning count (stable empty object pattern)
- Handle `terminal.idle.warning` and `terminal.exit`:
```ts
import { clearIdleWarning, recordIdleWarning } from '@/store/idleWarningsSlice'

if (msg.type === 'terminal.exit' && msg.terminalId) {
  dispatch(clearIdleWarning(msg.terminalId))
}
if (msg.type === 'terminal.idle.warning') {
  if (!msg.terminalId) return
  dispatch(recordIdleWarning({
    terminalId: msg.terminalId,
    killMinutes: Number(msg.killMinutes) || 0,
    warnMinutes: Number(msg.warnMinutes) || 0,
    lastActivityAt: typeof msg.lastActivityAt === 'number' ? msg.lastActivityAt : undefined,
  }))
}
```

- Restore the header indicator button that navigates to `overview`.

**Step 3: Run the idle warnings test**

Run:
```bash
npm test -- test/unit/client/components/App.test.tsx -t "Idle Warnings"
```
Expected: PASS

**Step 4: Commit**

Run:
```bash
git add src/store/store.ts src/App.tsx
git commit -m "fix: restore idle warning state and indicator"
```

---

### Task 18: Wire `TabItem` Working Indicator (Or Remove Dead Code)

**Issue:** `TabItem`’s `StatusIndicator` supports `isWorking`, but nothing passes it.

**Files:**
- Modify: `test/unit/client/components/TabItem.test.tsx`
- Modify: `src/components/TabItem.tsx`
- Modify: `src/components/TabBar.tsx`

**Step 1: Add a failing test**

In `test/unit/client/components/TabItem.test.tsx`:
```tsx
it('shows pulsing indicator when isWorking is true', () => {
  render(<TabItem {...defaultProps} isWorking={true} />)
  expect(screen.getByTestId('circle-icon').className).toContain('animate-pulse')
})
```

**Step 2: Run to confirm it fails**

Run:
```bash
npm test -- test/unit/client/components/TabItem.test.tsx -t "pulsing indicator"
```
Expected: FAIL (prop not wired yet).

**Step 3: Implement the wiring**

In `src/components/TabItem.tsx`:
- Add optional prop `isWorking?: boolean`
- Pass it into `StatusIndicator`

In `src/components/TabBar.tsx`:
- Select `terminalActivity.working`
- Compute `isWorking` for the tab as `true` if any pane leaf in the layout is working
- Pass `isWorking` to `TabItem` and the mobile dropdown `TabItem`

**Step 4: Run tests**

Run:
```bash
npm test -- test/unit/client/components/TabItem.test.tsx
```
Expected: PASS

**Step 5: Commit**

Run:
```bash
git add src/components/TabItem.tsx src/components/TabBar.tsx test/unit/client/components/TabItem.test.tsx
git commit -m "feat: show working/pulsing tab status when terminal is streaming"
```

---

### Task 19: Final Verification And Cleanup

**Files:**
- (Various)

**Step 1: Run the full test suite**

Run:
```bash
npm test
```
Expected: PASS

**Step 2: Run lint**

Run:
```bash
npm run lint
```
Expected: PASS

**Step 3: Ensure repo is clean**

Run:
```bash
git status --porcelain=v1
```
Expected: no output

**Step 4: Optional: document protocol expectations**

If needed, add a short note to `README.md` about chunked sessions updates and multi-tab sync behavior.

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-02-07-pane-based-architecture-review-fixes.md`. Two execution options:

1. Subagent-Driven (this session): fresh subagent per task, review between tasks, fast iteration. REQUIRED SUB-SKILL: superpowers:subagent-driven-development
2. Parallel Session (separate): open a new session in the worktree and execute with checkpoints. REQUIRED SUB-SKILL: superpowers:executing-plans

Which approach?


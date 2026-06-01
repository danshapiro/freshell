# OpenCode Browser Refresh Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenCode browser refresh restore survive a missed `terminal.session.associated` UI event by replaying canonical `sessionRef` through server terminal metadata and central client reconciliation.

**Architecture:** Keep `terminal.session.associated` as the authoritative live promotion event, but make already-promoted terminal identity replayable through `terminal.inventory`, `terminal.created`, and `terminal.attach.ready`. Add one client-side reconciliation helper that persists `{ terminalId, sessionRef }` into matching terminal panes before stale live handles are cleared, and use it from App-level WebSocket handling so it works even when `TerminalView` is not mounted. Do not infer OpenCode identity from cwd, title, or the OpenCode database during refresh.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, WebSocket protocol types in `shared/ws-protocol.ts`, Vitest, Testing Library.

---

## Context

The theory file is `/tmp/freshell-opencode-restore-theory.md`. It identifies a refresh-time race where OpenCode panes can persist a live `terminalId` but miss the later canonical `sessionRef`. After refresh, Freshell can attach only while the same server still owns that `terminalId`; once the handle is dead, non-Codex restore correctly requires a canonical `sessionRef`.

Existing durable identity contracts to preserve:

- `sessionRef` is the canonical durable identity; `terminalId` is only a live server handle.
- OpenCode restore identity must come from server-side ownership proof and registry binding, not cwd/title/database guessing.
- `terminal.session.associated` remains the live promotion event. Inventory/create/attach metadata only replay a canonical identity that the server already knows.
- `sessionRef` may authorize a restored create after stale-handle cleanup. It must not be used as runtime kill/replacement authority for OpenCode replay-gap repair.
- The baseline full suite on `origin/main` was user-accepted as a flake despite one failure in `test/integration/real/coding-cli-session-contract.test.ts` waiting for an OpenCode DB row.

## File Structure

- Modify `shared/ws-protocol.ts`
  - Add optional `sessionRef?: SessionLocator` to `TerminalCreatedMessage` and `TerminalAttachReadyMessage`.
- Create `server/terminal-session-ref.ts`
  - Central server helper for exposing a terminal record's already-known canonical durable `sessionRef`.
- Modify `server/terminal-registry.ts`
  - Reuse the helper in `list()` so inventory keeps the existing behavior with less duplicated logic.
- Modify `server/ws-handler.ts`
  - Include `sessionRef` on `terminal.created` when the terminal record already has canonical durable identity.
  - Include the same identity for reused existing terminals.
- Modify `server/terminal-stream/broker.ts`
  - Include `sessionRef` on `terminal.attach.ready` when attaching to a terminal with canonical durable identity.
- Modify `src/store/panesSlice.ts`
  - Add a reducer that reconciles a canonical session ref into every terminal pane matching a live `terminalId`, clears legacy `resumeSessionId`, and clears stale fresh-fallback attempts for those panes.
- Create `src/lib/terminal-session-association.ts`
  - Shared client helper that finds matching panes, dispatches the panes reducer, updates tab-level fallback identity only for single-pane tabs, and flushes persisted layout.
- Modify `src/App.tsx`
  - Use the client helper for `terminal.session.associated`, `terminal.created`, `terminal.attach.ready`, and inventory terminals before `clearDeadTerminals`.
- Modify `src/components/TerminalView.tsx`
  - Remove duplicated session-association persistence logic and rely on the central helper; keep local terminal lifecycle behavior unchanged.
  - On `terminal.created` and `terminal.attach.ready`, call the helper when those messages carry `sessionRef`.
- Test `test/server/ws-protocol.test.ts`
  - Prove `terminal.created` and `terminal.attach.ready` replay OpenCode `sessionRef` for a restored OpenCode terminal.
- Test `test/unit/client/components/App.ws-bootstrap.test.tsx`
  - Prove App-level inventory reconciliation recovers a stripped OpenCode `sessionRef` before clearing a stale handle.
  - Prove App-level live association works without `TerminalView` mounted.
- Test `test/unit/client/components/TerminalView.resumeSession.test.tsx`
  - Update expectations so `terminal.created` remains live-only when no `sessionRef` is present, and add a narrow assertion that a provided `sessionRef` is persisted through the central path.
- Test `test/e2e/terminal-restart-recovery.test.tsx`
  - Prove a pane whose missing OpenCode `sessionRef` was recovered before stale-handle cleanup emits a restored `terminal.create`, not fresh fallback.

## Task 1: Server Replayable SessionRef Contract

**Files:**
- Modify: `shared/ws-protocol.ts`
- Create: `server/terminal-session-ref.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-stream/broker.ts`
- Test: `test/server/ws-protocol.test.ts`

- [ ] **Step 1: Write the failing server test**

Add this test near the existing terminal create/attach protocol tests in `test/server/ws-protocol.test.ts`:

```ts
it('replays OpenCode sessionRef on terminal.created and terminal.attach.ready for restored terminals', async () => {
  const { ws, close } = await createAuthenticatedConnection()
  const requestId = 'req-opencode-restored-session-ref'
  const sessionRef = {
    provider: 'opencode',
    sessionId: 'ses_root_browser_refresh_restore',
  }

  ws.send(JSON.stringify({
    type: 'terminal.create',
    requestId,
    mode: 'opencode',
    restore: true,
    sessionRef,
    cwd: '/repo/project',
  }))

  const created = await waitForMessage(
    ws,
    (msg) => msg.type === 'terminal.created' && msg.requestId === requestId,
    5000,
  )

  expect(created).toMatchObject({
    type: 'terminal.created',
    requestId,
    sessionRef,
  })

  ws.send(JSON.stringify({
    type: 'terminal.attach',
    terminalId: created.terminalId,
    intent: 'viewport_hydrate',
    cols: 120,
    rows: 40,
    sinceSeq: 0,
  }))

  const ready = await waitForMessage(
    ws,
    (msg) => msg.type === 'terminal.attach.ready' && msg.terminalId === created.terminalId,
    5000,
  )

  expect(ready).toMatchObject({
    type: 'terminal.attach.ready',
    terminalId: created.terminalId,
    sessionRef,
  })

  await close()
})
```

- [ ] **Step 2: Run the server test and verify it fails**

Run:

```bash
npm run test:vitest -- test/server/ws-protocol.test.ts --run -t "replays OpenCode sessionRef"
```

Expected: FAIL because neither `terminal.created` nor `terminal.attach.ready` currently includes `sessionRef`.

- [ ] **Step 3: Add server protocol fields**

In `shared/ws-protocol.ts`, change the server message types:

```ts
export type TerminalCreatedMessage = {
  type: 'terminal.created'
  requestId: string
  terminalId: string
  createdAt: number
  sessionRef?: SessionLocator
  clearCodexDurability?: boolean
  restoreError?: RestoreError
}

export type TerminalAttachReadyMessage = {
  type: 'terminal.attach.ready'
  terminalId: string
  headSeq: number
  replayFromSeq: number
  replayToSeq: number
  attachRequestId?: string
  sessionRef?: SessionLocator
}
```

- [ ] **Step 4: Create the server sessionRef helper**

Create `server/terminal-session-ref.ts`:

```ts
import type { SessionLocator } from '../shared/ws-protocol.js'
import { modeSupportsResume, type TerminalMode, type TerminalRecord } from './terminal-registry.js'
import type { CodingCliProviderName } from './coding-cli/types.js'
import type { CodexDurabilityRef } from '../shared/codex-durability.js'

type TerminalSessionRefSource = Pick<TerminalRecord, 'mode' | 'resumeSessionId'> & {
  codexDurability?: CodexDurabilityRef
}

export function buildTerminalSessionRef(record: TerminalSessionRefSource): SessionLocator | undefined {
  if (!modeSupportsResume(record.mode as TerminalMode)) return undefined
  if (!record.resumeSessionId) return undefined
  if (
    record.mode === 'codex'
    && (
      record.codexDurability?.state !== 'durable'
      || record.codexDurability.durableThreadId !== record.resumeSessionId
    )
  ) {
    return undefined
  }

  return {
    provider: record.mode as CodingCliProviderName,
    sessionId: record.resumeSessionId,
  }
}
```

- [ ] **Step 5: Use the helper in registry inventory**

In `server/terminal-registry.ts`, import:

```ts
import { buildTerminalSessionRef } from './terminal-session-ref.js'
```

Then change the `list()` record mapping from the inline `sessionRef: modeSupportsResume(...) ? ... : undefined` expression to:

```ts
sessionRef: buildTerminalSessionRef(t),
```

This should be behavior-preserving for inventory: OpenCode/Claude records with `resumeSessionId` expose `sessionRef`; Codex still exposes it only after durable proof.

- [ ] **Step 6: Include sessionRef in terminal.created**

In `server/ws-handler.ts`, import:

```ts
import { buildTerminalSessionRef } from './terminal-session-ref.js'
import type { SessionLocator } from '../shared/ws-protocol.js'
```

Update `sendCreateResult` to accept and send `sessionRef`:

```ts
const sendCreateResult = async (opts: {
  ws: LiveWebSocket
  requestId: string
  terminalId: string
  createdAt: number
  sessionRef?: SessionLocator
  clearCodexDurability?: boolean
  restoreError?: RestoreError
}): Promise<boolean> => {
  if (opts.ws.readyState !== WebSocket.OPEN) {
    return false
  }

  this.send(opts.ws, {
    type: 'terminal.created',
    requestId: opts.requestId,
    terminalId: opts.terminalId,
    createdAt: opts.createdAt,
    ...(opts.sessionRef ? { sessionRef: opts.sessionRef } : {}),
    ...(opts.clearCodexDurability ? { clearCodexDurability: true } : {}),
    ...(opts.restoreError ? { restoreError: opts.restoreError } : {}),
  })
  return true
}
```

Change `attachReusedTerminal` to take a `TerminalRecord`:

```ts
const attachReusedTerminal = async (reusedRecord: TerminalRecord): Promise<boolean> => {
  const sessionRef = buildTerminalSessionRef(reusedRecord)
  const sent = await sendCreateResult({
    ws,
    requestId: m.requestId,
    terminalId: reusedRecord.terminalId,
    createdAt: reusedRecord.createdAt,
    sessionRef,
  })
  if (!sent) return false
  state.createdByRequestId.set(m.requestId, reusedRecord.terminalId)
  this.rememberCreatedRequestId(m.requestId, reusedRecord.terminalId)
  terminalId = reusedRecord.terminalId
  reused = true
  recordSessionLifecycleEvent({
    kind: 'terminal_created',
    requestId: m.requestId,
    connectionId: ws.connectionId || 'unknown',
    terminalId: reusedRecord.terminalId,
    ...(m.tabId ? { tabId: m.tabId } : {}),
    ...(m.paneId ? { paneId: m.paneId } : {}),
    ...(m.cwd ? { cwd: m.cwd } : {}),
    mode: m.mode as TerminalMode,
    reused: true,
    hasSessionRef: !!sessionRef,
  })
  this.broadcastTerminalsChanged()
  return true
}
```

Then replace calls like:

```ts
await attachReusedTerminal(existing.terminalId, existing.createdAt, existing.resumeSessionId)
```

with:

```ts
await attachReusedTerminal(existing)
```

Update all six existing call sites in `server/ws-handler.ts` the same way, including the live Codex proof branches that currently pass `decision.sessionId` or `live.resumeSessionId`. The new helper always derives the replayed identity from the current `TerminalRecord`; do not pass a session id separately.

For newly created terminals, send:

```ts
const sent = await sendCreateResult({
  ws,
  requestId: m.requestId,
  terminalId: record.terminalId,
  createdAt: record.createdAt,
  sessionRef: buildTerminalSessionRef(record),
  clearCodexDurability: clearCodexDurabilityOnCreate,
  restoreError: restoreErrorOnCreate,
})
```

- [ ] **Step 7: Include sessionRef in terminal.attach.ready**

In `server/terminal-stream/broker.ts`, import:

```ts
import { buildTerminalSessionRef } from '../terminal-session-ref.js'
```

Before sending `terminal.attach.ready`, compute:

```ts
const sessionRef = buildTerminalSessionRef(record)
```

Then send:

```ts
this.safeSend(ws, {
  type: 'terminal.attach.ready',
  terminalId,
  headSeq,
  replayFromSeq,
  replayToSeq,
  ...(attachment.activeAttachRequestId ? { attachRequestId: attachment.activeAttachRequestId } : {}),
  ...(sessionRef ? { sessionRef } : {}),
})
```

- [ ] **Step 8: Run the focused server tests**

Run:

```bash
npm run test:vitest -- test/server/ws-protocol.test.ts test/unit/server/terminal-registry.test.ts --run -t "replays OpenCode sessionRef|list\\(\\) returns resumeSessionId|terminal.attach accepts paired viewport payload"
```

Expected: PASS.

- [ ] **Step 9: Commit server contract work**

Run:

```bash
git add shared/ws-protocol.ts server/terminal-session-ref.ts server/terminal-registry.ts server/ws-handler.ts server/terminal-stream/broker.ts test/server/ws-protocol.test.ts
git commit -m "fix: replay terminal session refs over websocket"
```

## Task 2: Central Client SessionRef Reconciliation

**Files:**
- Modify: `src/store/panesSlice.ts`
- Create: `src/lib/terminal-session-association.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Test: `test/unit/client/components/TerminalView.resumeSession.test.tsx`

- [ ] **Step 1: Write failing App inventory reconciliation test**

Add this test to `test/unit/client/components/App.ws-bootstrap.test.tsx` near the existing `terminal.inventory` tests:

```tsx
it('recovers an OpenCode sessionRef from inventory before clearing a stale live handle', async () => {
  const store = createStore({
    tabs: [{
      id: 'tab-opencode-refresh',
      mode: 'opencode',
      status: 'running',
      resumeSessionId: 'legacy-title-like-id',
    }],
    panes: {
      layouts: {
        'tab-opencode-refresh': {
          type: 'leaf',
          id: 'pane-opencode-refresh',
          content: {
            kind: 'terminal',
            createRequestId: 'req-opencode-old',
            status: 'running',
            mode: 'opencode',
            shell: 'system',
            terminalId: 'term-opencode-old',
            resumeSessionId: 'legacy-title-like-id',
            serverInstanceId: 'srv-old',
          },
        },
      },
      activePane: { 'tab-opencode-refresh': 'pane-opencode-refresh' },
    },
  })

  render(
    <Provider store={store}>
      <App />
    </Provider>,
  )

  await waitFor(() => {
    expect(messageHandler).toBeTypeOf('function')
  })

  const sessionRef = {
    provider: 'opencode',
    sessionId: 'ses_root_inventory_refresh_restore',
  }

  act(() => {
    messageHandler?.({
      type: 'terminal.inventory',
      terminals: [{
        terminalId: 'term-opencode-old',
        title: 'OpenCode',
        mode: 'opencode',
        createdAt: 1_000,
        lastActivityAt: 1_700,
        status: 'running',
        sessionRef,
      }],
      terminalMeta: [],
    })
  })

  await waitFor(() => {
    const layout = store.getState().panes.layouts['tab-opencode-refresh']
    if (!layout || layout.type !== 'leaf') throw new Error('expected leaf layout')
    const content = layout.content
    if (content.kind !== 'terminal') throw new Error('expected terminal pane')

    expect(content.terminalId).toBe('term-opencode-old')
    expect(content.status).toBe('running')
    expect(content.createRequestId).toBe('req-opencode-old')
    expect(content.sessionRef).toEqual(sessionRef)
    expect(content.resumeSessionId).toBeUndefined()
    expect(store.getState().tabs.tabs.find((tab) => tab.id === 'tab-opencode-refresh')?.sessionRef).toEqual(sessionRef)
    expect(store.getState().tabs.tabs.find((tab) => tab.id === 'tab-opencode-refresh')?.resumeSessionId).toBeUndefined()
  })

  act(() => {
    messageHandler?.({
      type: 'terminal.inventory',
      terminals: [],
      terminalMeta: [],
    })
  })

  await waitFor(() => {
    const layout = store.getState().panes.layouts['tab-opencode-refresh']
    if (!layout || layout.type !== 'leaf') throw new Error('expected leaf layout')
    const content = layout.content
    if (content.kind !== 'terminal') throw new Error('expected terminal pane')

    expect(content.terminalId).toBeUndefined()
    expect(content.status).toBe('creating')
    expect(content.createRequestId).not.toBe('req-opencode-old')
    expect(content.sessionRef).toEqual(sessionRef)
    expect(content.resumeSessionId).toBeUndefined()
    expect(store.getState().panes.restoreFallbackAttemptsByPane?.['tab-opencode-refresh']?.['pane-opencode-refresh']).toBeUndefined()
    expect(terminalRestoreMocks.addTerminalRestoreRequestId).toHaveBeenCalledWith(content.createRequestId)
    expect(terminalRestoreMocks.addTerminalFreshRecoveryRequestId).not.toHaveBeenCalledWith(
      content.createRequestId,
      'fresh_after_restore_unavailable',
    )
  })
})
```

- [ ] **Step 2: Write failing App live-association test**

Add this second test to the same file:

```tsx
it.each(['terminal.session.associated', 'terminal.attach.ready'] as const)(
  'persists OpenCode sessionRef from %s without TerminalView mounted',
  async (type) => {
    const store = createStore({
      tabs: [{ id: 'tab-opencode-associated', mode: 'opencode', status: 'running' }],
      panes: {
        layouts: {
          'tab-opencode-associated': {
            type: 'leaf',
            id: 'pane-opencode-associated',
            content: {
              kind: 'terminal',
              createRequestId: 'req-opencode-associated',
              status: 'running',
              mode: 'opencode',
              shell: 'system',
              terminalId: 'term-opencode-associated',
            },
          },
        },
        activePane: { 'tab-opencode-associated': 'pane-opencode-associated' },
      },
    })

    render(
      <Provider store={store}>
        <App />
      </Provider>,
    )

    await waitFor(() => {
      expect(messageHandler).toBeTypeOf('function')
    })

    const sessionRef = {
      provider: 'opencode',
      sessionId: `ses_root_${type.replaceAll('.', '_')}`,
    }

    act(() => {
      messageHandler?.(type === 'terminal.session.associated'
        ? {
            type,
            terminalId: 'term-opencode-associated',
            sessionRef,
          }
        : {
            type,
            terminalId: 'term-opencode-associated',
            headSeq: 0,
            replayFromSeq: 1,
            replayToSeq: 0,
            sessionRef,
          })
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts['tab-opencode-associated']
      if (!layout || layout.type !== 'leaf') throw new Error('expected leaf layout')
      const content = layout.content
      if (content.kind !== 'terminal') throw new Error('expected terminal pane')
      expect(content.sessionRef).toEqual(sessionRef)
      expect(store.getState().tabs.tabs.find((tab) => tab.id === 'tab-opencode-associated')?.sessionRef).toEqual(sessionRef)
    })
  },
)
```

- [ ] **Step 3: Run App tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-bootstrap.test.tsx --run -t "OpenCode sessionRef"
```

Expected: FAIL because App does not reconcile session refs centrally before `clearDeadTerminals`.

- [ ] **Step 4: Add the panes reducer**

In `src/store/panesSlice.ts`, add this helper near other private reducer helpers:

```ts
function sessionRefsEqual(left?: { provider?: string; sessionId?: string }, right?: { provider?: string; sessionId?: string }): boolean {
  return left?.provider === right?.provider && left?.sessionId === right?.sessionId
}
```

Add this reducer before `clearDeadTerminals`:

```ts
    reconcileTerminalSessionRefByTerminalId: (
      state,
      action: PayloadAction<{ terminalId: string; sessionRef: unknown }>
    ) => {
      const terminalId = action.payload.terminalId
      const sessionRef = sanitizeSessionRef(action.payload.sessionRef)
      if (!terminalId || !sessionRef) return

      function reconcileNode(node: PaneNode, tabId: string): void {
        if (node.type === 'leaf') {
          const content = node.content
          if (
            content.kind !== 'terminal'
            || content.terminalId !== terminalId
          ) {
            return
          }

          if (!sessionRefsEqual(content.sessionRef, sessionRef)) {
            content.sessionRef = sessionRef
          }
          content.resumeSessionId = undefined
          if (
            sessionRef.provider === 'codex'
            && !(
              content.codexDurability?.state === 'durable'
              && (
                content.codexDurability.durableThreadId === sessionRef.sessionId
                || content.codexDurability.candidate?.candidateThreadId === sessionRef.sessionId
              )
            )
          ) {
            content.codexDurability = undefined
          }
          clearRestoreFallbackAttemptForPane(state, tabId, node.id)
          return
        }
        reconcileNode(node.children[0], tabId)
        reconcileNode(node.children[1], tabId)
      }

      for (const [tabId, layout] of Object.entries(state.layouts)) {
        reconcileNode(layout, tabId)
      }
    },
```

Export it from the slice actions:

```ts
export const {
  // existing actions...
  reconcileTerminalSessionRefByTerminalId,
  clearDeadTerminals,
} = panesSlice.actions
```

- [ ] **Step 5: Create the central client helper**

Create `src/lib/terminal-session-association.ts`:

```ts
import { updateTab } from '@/store/tabsSlice'
import {
  reconcileTerminalSessionRefByTerminalId,
} from '@/store/panesSlice'
import {
  buildTerminalDurableSessionRefUpdate,
  flushPersistedLayoutNow,
} from '@/store/persistControl'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import type { RootState } from '@/store/store'
import { sanitizeSessionRef, type SessionRef } from '@shared/session-contract'

type Dispatch = (action: unknown) => unknown

function collectMatchingTerminalPanes(
  node: PaneNode | undefined,
  terminalId: string,
  out: Array<{ paneId: string; content: TerminalPaneContent }>,
): void {
  if (!node) return
  if (node.type === 'leaf') {
    if (node.content.kind === 'terminal' && node.content.terminalId === terminalId) {
      out.push({ paneId: node.id, content: node.content })
    }
    return
  }
  collectMatchingTerminalPanes(node.children[0], terminalId, out)
  collectMatchingTerminalPanes(node.children[1], terminalId, out)
}

function isSinglePaneTerminalMatch(layout: PaneNode | undefined, terminalId: string): layout is Extract<PaneNode, { type: 'leaf' }> {
  return Boolean(
    layout
      && layout.type === 'leaf'
      && layout.content.kind === 'terminal'
      && layout.content.terminalId === terminalId,
  )
}

function sessionRefsEqual(left?: SessionRef, right?: SessionRef): boolean {
  return left?.provider === right?.provider && left?.sessionId === right?.sessionId
}

function terminalPaneNeedsDurableIdentityUpdate(content: TerminalPaneContent, sessionRef: SessionRef): boolean {
  if (!sessionRefsEqual(content.sessionRef, sessionRef)) return true
  if (typeof content.resumeSessionId === 'string') return true
  if (
    sessionRef.provider === 'codex'
    && !(
      content.codexDurability?.state === 'durable'
      && (
        content.codexDurability.durableThreadId === sessionRef.sessionId
        || content.codexDurability.candidate?.candidateThreadId === sessionRef.sessionId
      )
    )
  ) {
    return content.codexDurability !== undefined
  }
  return false
}

export function reconcileTerminalSessionAssociation({
  dispatch,
  getState,
  terminalId,
  sessionRef: rawSessionRef,
}: {
  dispatch: Dispatch
  getState: () => RootState
  terminalId?: string
  sessionRef?: unknown
}): boolean {
  if (!terminalId) return false
  const sessionRef = sanitizeSessionRef(rawSessionRef)
  if (!sessionRef) return false

  const state = getState()
  let matchedAnyPane = false
  let shouldFlush = false
  const matchedSinglePaneTabs: Array<{ tabId: string; content: TerminalPaneContent }> = []
  for (const [tabId, layout] of Object.entries(state.panes.layouts)) {
    const matches: Array<{ paneId: string; content: TerminalPaneContent }> = []
    collectMatchingTerminalPanes(layout, terminalId, matches)
    if (matches.length === 0) continue
    matchedAnyPane = true
    if (matches.some(({ content }) => terminalPaneNeedsDurableIdentityUpdate(content, sessionRef))) {
      shouldFlush = true
    }
    if (isSinglePaneTerminalMatch(layout, terminalId)) {
      matchedSinglePaneTabs.push({ tabId, content: matches[0].content })
    }
  }

  if (!matchedAnyPane) return false

  dispatch(reconcileTerminalSessionRefByTerminalId({ terminalId, sessionRef }))

  for (const { tabId, content } of matchedSinglePaneTabs) {
    const tab = state.tabs.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) continue
    const durableIdentityUpdate = buildTerminalDurableSessionRefUpdate({
      provider: sessionRef.provider as SessionRef['provider'],
      sessionId: sessionRef.sessionId,
      paneSessionRef: content.sessionRef,
      tabSessionRef: tab.sessionRef,
      paneResumeSessionId: content.resumeSessionId,
      tabResumeSessionId: tab.resumeSessionId,
    })
    const nextTabCodexDurability = sessionRef.provider === 'codex'
      && tab.codexDurability?.state === 'durable'
      && (
        tab.codexDurability.durableThreadId === sessionRef.sessionId
        || tab.codexDurability.candidate?.candidateThreadId === sessionRef.sessionId
      )
      ? tab.codexDurability
      : undefined
    const tabUpdates = {
      ...(durableIdentityUpdate?.tabUpdates ?? {}),
      ...(sessionRef.provider === 'codex' && tab.codexDurability !== nextTabCodexDurability
        ? { codexDurability: nextTabCodexDurability }
        : {}),
    }
    if (Object.keys(tabUpdates).length > 0) {
      shouldFlush = true
      dispatch(updateTab({
        id: tab.id,
        updates: tabUpdates,
      }))
    }
  }

  if (shouldFlush) {
    dispatch(flushPersistedLayoutNow())
  }
  return true
}
```

The helper computes `shouldFlush` before dispatching the panes reducer so repeated `terminal.attach.ready` messages that replay an already-persisted `sessionRef` do not force redundant synchronous layout writes.

- [ ] **Step 6: Use the helper in App WebSocket handling**

In `src/App.tsx`, import:

```ts
import { reconcileTerminalSessionAssociation } from '@/lib/terminal-session-association'
```

In the WebSocket message handler, add this before `terminal.inventory` handling:

```ts
        if (
          (msg.type === 'terminal.session.associated'
            || msg.type === 'terminal.created'
            || msg.type === 'terminal.attach.ready')
          && typeof (msg as any).terminalId === 'string'
          && (msg as any).sessionRef
        ) {
          reconcileTerminalSessionAssociation({
            dispatch,
            getState: appStore.getState,
            terminalId: (msg as any).terminalId,
            sessionRef: (msg as any).sessionRef,
          })
        }
```

Inside `terminal.inventory`, reconcile before computing `liveIds` and before `dispatch(clearDeadTerminals(...))`:

```ts
          for (const terminal of terminals) {
            if (terminal?.terminalId && terminal?.sessionRef) {
              reconcileTerminalSessionAssociation({
                dispatch,
                getState: appStore.getState,
                terminalId: terminal.terminalId,
                sessionRef: terminal.sessionRef,
              })
            }
          }
```

- [ ] **Step 7: Route TerminalView association through the central helper**

In `src/components/TerminalView.tsx`, import `useAppStore` and the helper:

```ts
import { useAppDispatch, useAppSelector, useAppStore } from '@/store/hooks'
import { reconcileTerminalSessionAssociation } from '@/lib/terminal-session-association'
```

Inside the component:

```ts
const appStore = useAppStore()
```

When handling `terminal.attach.ready`, after validating it is current and before sequence state updates:

```ts
          if (msg.sessionRef) {
            reconcileTerminalSessionAssociation({
              dispatch,
              getState: appStore.getState,
              terminalId: tid,
              sessionRef: msg.sessionRef,
            })
          }
```

When handling `terminal.created`, include `sessionRef` in the immediate content update so App-ordering does not matter:

```ts
          updateContent({
            terminalId: newId,
            serverInstanceId: serverInstanceIdRef.current,
            status: 'running',
            ...(msg.sessionRef ? { sessionRef: msg.sessionRef, resumeSessionId: undefined } : {}),
            ...(msg.clearCodexDurability ? { codexDurability: undefined } : {}),
            ...(msg.restoreError ? { restoreError: msg.restoreError } : {}),
          })
```

Then call the helper after `terminalIdRef.current = newId`:

```ts
          if (msg.sessionRef) {
            reconcileTerminalSessionAssociation({
              dispatch,
              getState: appStore.getState,
              terminalId: newId,
              sessionRef: msg.sessionRef,
            })
          }
```

Replace the current `terminal.session.associated` block with:

```ts
        if (msg.type === 'terminal.session.associated' && msg.terminalId === tid) {
          const reconciled = reconcileTerminalSessionAssociation({
            dispatch,
            getState: appStore.getState,
            terminalId: tid,
            sessionRef: msg.sessionRef,
          })
          if (debugRef.current && reconciled) {
            log.debug('[TRACE resumeSessionId] terminal.session.associated reconciled', {
              paneId: paneIdRef.current,
              terminalId: tid,
              sessionRef: msg.sessionRef,
            })
          }
        }
```

Remove the now-unused `buildTerminalDurableSessionRefUpdate` import from `TerminalView.tsx`.

- [ ] **Step 8: Add the TerminalView terminal.created assertion**

In `test/unit/client/components/TerminalView.resumeSession.test.tsx`, keep the existing "keeps terminal.created live-only until an explicit terminal.session.associated arrives" test unchanged for messages with no `sessionRef`. Add this assertion in the same describe block:

```tsx
it('persists canonical sessionRef from terminal.created when the server replays it', async () => {
  const tabId = 'tab-opencode'
  const paneId = 'pane-opencode'
  let messageHandler: ((msg: any) => void) | null = null

  wsMocks.onMessage.mockImplementation((handler: (msg: any) => void) => {
    messageHandler = handler
    return () => {}
  })

  const sessionRef = {
    provider: 'opencode',
    sessionId: 'ses_root_created_replay',
  }
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-created-replay',
    status: 'creating',
    mode: 'opencode',
    shell: 'system',
    initialCwd: '/tmp',
  }
  const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: tabId,
          mode: 'opencode',
          status: 'running',
          title: 'OpenCode',
          titleSetByUser: false,
          createRequestId: 'req-created-replay',
        }],
        activeTabId: tabId,
      },
      panes: {
        layouts: { [tabId]: root },
        activePane: { [tabId]: paneId },
        paneTitles: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'connected', error: null, serverInstanceId: 'srv-local' },
    },
  })

  render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
    </Provider>,
  )

  await waitFor(() => {
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.create',
      requestId: 'req-created-replay',
    }))
  })

  messageHandler?.({
    type: 'terminal.created',
    requestId: 'req-created-replay',
    terminalId: 'term-created-replay',
    sessionRef,
  })

  await waitFor(() => {
    const layout = store.getState().panes.layouts[tabId]
    if (layout?.type !== 'leaf') throw new Error('unexpected layout')
    if (layout.content.kind !== 'terminal') throw new Error('unexpected content')
    expect(layout.content.terminalId).toBe('term-created-replay')
    expect(layout.content.sessionRef).toEqual(sessionRef)
    expect(layout.content.resumeSessionId).toBeUndefined()

    const tab = store.getState().tabs.tabs.find((entry) => entry.id === tabId)
    expect(tab?.sessionRef).toEqual(sessionRef)
    expect(tab?.resumeSessionId).toBeUndefined()
  })
})
```

- [ ] **Step 9: Run focused client tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "OpenCode sessionRef|terminal.session.associated|terminal.created live-only|terminal.created when the server replays it|persists canonical durable sessionRef|shows feedback when Codex input is blocked"
```

Expected: PASS.

- [ ] **Step 10: Commit client reconciliation work**

Run:

```bash
git add src/store/panesSlice.ts src/lib/terminal-session-association.ts src/App.tsx src/components/TerminalView.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx
git commit -m "fix: reconcile terminal session refs centrally"
```

## Task 3: End-To-End Restore Regression

**Files:**
- Test: `test/e2e/terminal-restart-recovery.test.tsx`

- [ ] **Step 1: Write the failing e2e regression**

Add this test to `test/e2e/terminal-restart-recovery.test.tsx`:

```tsx
it('restores an OpenCode pane after inventory recovers a missing sessionRef before stale-handle cleanup', async () => {
  const layout: PaneNode = {
    type: 'leaf',
    id: 'pane-opencode',
    content: {
      kind: 'terminal',
      createRequestId: 'req-opencode-old',
      status: 'running',
      mode: 'opencode',
      shell: 'system',
      terminalId: 'term-opencode-old',
      serverInstanceId: 'srv-old',
    } satisfies TerminalPaneContent,
  }
  const store = createStore(layout)

  render(
    <Provider store={store}>
      <TerminalViewFromStore tabId="tab-restart" paneId="pane-opencode" />
    </Provider>,
  )

  await waitFor(() => {
    expect(sentMessages().some((msg) => msg?.type === 'terminal.attach' && msg.terminalId === 'term-opencode-old')).toBe(true)
  })

  wsHarness.send.mockClear()
  store.dispatch(reconcileTerminalSessionRefByTerminalId({
    terminalId: 'term-opencode-old',
    sessionRef: {
      provider: 'opencode',
      sessionId: 'ses_root_recovered_before_dead_clear',
    },
  }))
  store.dispatch(clearDeadTerminals({ liveTerminalIds: [] }))
  registerRecoveryRequestsFromState(store)

  await waitFor(() => {
    const create = sentMessages().find((msg) => msg?.type === 'terminal.create')
    expect(create).toMatchObject({
      type: 'terminal.create',
      mode: 'opencode',
      restore: true,
      sessionRef: {
        provider: 'opencode',
        sessionId: 'ses_root_recovered_before_dead_clear',
      },
    })
    expect(create).not.toHaveProperty('recoveryIntent')
  })
})
```

Also import the reducer:

```ts
import panesReducer, { clearDeadTerminals, reconcileTerminalSessionRefByTerminalId } from '@/store/panesSlice'
```

- [ ] **Step 2: Run the e2e regression**

Run:

```bash
npm run test:vitest -- test/e2e/terminal-restart-recovery.test.tsx --run -t "inventory recovers a missing sessionRef"
```

Expected before Task 2 implementation: FAIL. Expected after Task 2 implementation: PASS.

- [ ] **Step 3: Commit e2e regression**

Run:

```bash
git add test/e2e/terminal-restart-recovery.test.tsx
git commit -m "test: cover opencode restore after inventory identity recovery"
```

## Task 4: Focused Verification And Refactor

**Files:**
- Modify only files touched by Tasks 1-3 if cleanup is needed.

- [ ] **Step 1: Run focused server verification**

Run:

```bash
npm run test:vitest -- test/server/ws-protocol.test.ts test/integration/server/opencode-session-flow.test.ts test/unit/server/coding-cli/opencode-session-controller.test.ts test/unit/server/coding-cli/opencode-activity-wiring.test.ts --run -t "opencode|OpenCode|replays OpenCode sessionRef|terminal.attach accepts paired viewport payload"
```

Expected: PASS.

- [ ] **Step 2: Run focused client verification**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-restart-recovery.test.tsx test/e2e/codex-refresh-rehydrate-flow.test.tsx --run -t "OpenCode sessionRef|terminal.session.associated|terminal.created live-only|terminal.created when the server replays it|persists canonical durable sessionRef|inventory recovers a missing sessionRef|registers regenerated restart request ids|restores the same Codex session after a refresh"
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run check
```

Expected: PASS except for the known user-accepted OpenCode real-provider DB-row flake only if it recurs in broad verification.

- [ ] **Step 4: Refactor duplicated traversal if needed**

If `src/lib/terminal-session-association.ts` has duplicate tree walks after implementation, replace them with one pass:

```ts
const matchedByTab: Array<{ tabId: string; singlePane: boolean; content: TerminalPaneContent }> = []
for (const [tabId, layout] of Object.entries(state.panes.layouts)) {
  const matches: Array<{ paneId: string; content: TerminalPaneContent }> = []
  collectMatchingTerminalPanes(layout, terminalId, matches)
  if (matches.length === 0) continue
  matchedAnyPane = true
  if (isSinglePaneTerminalMatch(layout, terminalId)) {
    matchedByTab.push({ tabId, singlePane: true, content: matches[0].content })
  }
}
```

Run the focused client tests again after any refactor.

- [ ] **Step 5: Commit verification cleanup**

Run:

```bash
git status --short
git add src test server shared
git commit -m "refactor: simplify terminal session association reconciliation"
```

If there are no cleanup changes, skip this commit.

## Task 5: Final Verification And Delivery

**Files:**
- No planned file edits.

- [ ] **Step 1: Run broad coordinated verification**

Run:

```bash
FRESHELL_TEST_SUMMARY='opencode browser refresh restore final verification' npm test
```

Expected: PASS. If the same real-provider OpenCode DB-row timeout from the accepted baseline appears, rerun that failing test once and record both outputs. Do not claim broad green unless the coordinated suite exits 0.

- [ ] **Step 2: Run build/type verification if broad test passes**

Run:

```bash
FRESHELL_TEST_SUMMARY='opencode browser refresh restore final check' npm run check
```

Expected: PASS.

- [ ] **Step 3: Confirm no unwanted changes**

Run:

```bash
git status --short
git log --oneline --decorate -5
```

Expected: only intentional committed changes on `opencode-browser-refresh-restore`.

- [ ] **Step 4: Commit any final fixes**

If verification required fixes:

```bash
git add shared server src test
git commit -m "fix: stabilize opencode refresh restore reconciliation"
```

If no files changed, skip this step.

## Self-Review

**Spec coverage:** The plan implements every claim in `/tmp/freshell-opencode-restore-theory.md`: server replay through inventory/create/attach, central client reconciliation, inventory-before-clear ordering, no database guessing, fresh-fallback clearing, tab fallback updates for single-pane tabs, and restore-create coverage after stale handle cleanup.

**Placeholder scan:** There are no `TBD`, `TODO`, or "similar to" placeholders. Task 3 has full test code and is part of the required verification path.

**Type consistency:** The same `SessionLocator`/`SessionRef` shape is used throughout: `{ provider, sessionId }`. Server code uses `.js` extensions for new ESM imports. Client store code uses existing `sanitizeSessionRef`, `buildTerminalDurableSessionRefUpdate`, `updateTab`, `flushPersistedLayoutNow`, and `clearRestoreFallbackAttemptForPane` patterns.

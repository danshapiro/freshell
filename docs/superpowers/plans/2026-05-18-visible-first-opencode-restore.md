# Visible-First OpenCode Restore Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make restored OpenCode terminal panes deterministic by representing stale/dead OpenCode restores as visibility-gated restore intents, launching them only when a mounted `TerminalView` is visible, while preserving a constrained replay-gap repair path for same-server restored panes.

**Architecture:** Add an explicit queued-restore state to terminal pane content instead of treating `status: "creating"` as both "create now" and "restore later." `TerminalView` becomes a small restore lifecycle state machine: queued OpenCode panes do not send `terminal.create` while hidden; the same mounted component transitions the queued pane once to a restored create as soon as it is visible; visible-started OpenCode restores carry an immediate attach obligation so `terminal.created` cannot become a hidden detached PTY if the user switches tabs mid-launch.

**Fundamental Invariant:** Durable session identity never grants runtime ownership or destructive authority. `sessionRef` identifies the OpenCode session to restore; `terminalId` identifies a current PTY; only a current restore-attempt lease tied to that specific `{ sessionRef, createRequestId, terminalId, serverInstanceId }` may kill, replace, or recreate the PTY. The initial implementation represents this lease with `restoreRuntime`. The lease is created only for a restored OpenCode create, may survive a browser refresh only while the same server instance and live terminal handle are preserved, and is retired after the first successful `viewport_hydrate` attach for that terminal. After the lease is retired, replay gaps are non-destructive live-terminal events.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, Vitest, Playwright browser e2e, Freshell WebSocket terminal protocol.

---

## Chunk 1: Restore State Model

### File Structure

- Verify/no change: `/home/user/code/freshell/.worktrees/dev/src/store/types.ts`
  - Leave the shared tab/background terminal status unchanged.
- Modify: `/home/user/code/freshell/.worktrees/dev/src/store/paneTypes.ts`
  - Add a pane-only queued terminal status type.
  - Add explicit queued OpenCode restore metadata on `TerminalPaneContent`.
- Modify: `/home/user/code/freshell/.worktrees/dev/src/store/panesSlice.ts`
  - Use shared restore-state normalization for reducer actions.
  - Convert restored hidden OpenCode panes to queued state when stale runtime ids are stripped.
- Add/modify: `/home/user/code/freshell/.worktrees/dev/src/store/paneRestoreState.ts`
  - Own the shared terminal pane restore-state sanitizers used by both `panesSlice.ts` and `persistMiddleware.ts`.
- Modify: `/home/user/code/freshell/.worktrees/dev/src/store/persistMiddleware.ts`
  - Apply shared boot-load sanitization for queued/error/lease fields without discarding same-server live terminal handles.
  - Persist only valid same-server restore-attempt leases, and strip them when the server instance or terminal handle is no longer live.
- Modify: `/home/user/code/freshell/.worktrees/dev/src/lib/terminal-status-indicator.ts`
  - Render queued restore as pending/neutral, not running/error.
- Modify as needed: `/home/user/code/freshell/.worktrees/dev/src/components/panes/Pane.tsx`, `/home/user/code/freshell/.worktrees/dev/src/components/panes/PaneHeader.tsx`, `/home/user/code/freshell/.worktrees/dev/src/components/TabItem.tsx`, `/home/user/code/freshell/.worktrees/dev/src/components/TabSwitcher.tsx`
  - Accept pane-local `TerminalPaneStatus` only where status is derived from pane content.
- Test: `/home/user/code/freshell/.worktrees/dev/test/unit/client/store/panesSlice.test.ts`
- Test: `/home/user/code/freshell/.worktrees/dev/test/unit/client/store/panesPersistence.test.ts`

### Task 1: Add Explicit Queued Restore Types

- [ ] **Step 1: Write the failing type/model test**

Add a test proving restored OpenCode pane hydration becomes queued instead of creating:

```ts
it('queues restored OpenCode panes until visible when stale runtime ids are stripped', () => {
  const layout: PaneNode = {
    type: 'leaf',
    id: 'pane-opencode',
    content: {
      kind: 'terminal',
      mode: 'opencode',
      shell: 'system',
      status: 'running',
      terminalId: 'old-term',
      createRequestId: 'old-request',
      sessionRef: { provider: 'opencode', sessionId: 'ses_root_1' },
    },
  }

  const result = panesReducer(
    initialState,
    restoreLayout({ tabId: 'tab-opencode', layout, paneTitles: {} }),
  )
  const restored = result.layouts['tab-opencode']
  expect(restored.type).toBe('leaf')
  if (restored.type !== 'leaf' || restored.content.kind !== 'terminal') {
    throw new Error('expected terminal leaf')
  }

  expect(restored.content).toMatchObject({
    kind: 'terminal',
    mode: 'opencode',
    status: 'queued',
    sessionRef: { provider: 'opencode', sessionId: 'ses_root_1' },
    queuedRestore: {
      kind: 'until_visible',
      provider: 'opencode',
      reason: 'visible_owner_required',
    },
  })
  expect(restored.content.terminalId).toBeUndefined()
  expect(restored.content.createRequestId).not.toBe('old-request')
})
```

Add a companion malformed-state test so queued never degrades into a valid create state. This intentionally uses `initLayout` with an `as any` corrupt payload to exercise `normalizePaneContent` directly; the normal `restoreLayout` path should repair OpenCode restores into a valid queued shape via `stripStaleIds`. This store test is necessary but not sufficient: Chunk 2 adds the mounted `TerminalView` no-create proof so an `error` terminal without a `terminalId` cannot still launch a PTY.

```ts
it('marks malformed queued terminal state as an error instead of creating', () => {
  const result = panesReducer(
    initialState,
    initLayout({
      tabId: 'tab-bad-queue',
      paneId: 'pane-bad-queue',
      content: {
        kind: 'terminal',
        mode: 'opencode',
        shell: 'system',
        status: 'queued' as any,
        createRequestId: 'req-bad-queue',
        terminalId: 'stale-term',
        sessionRef: { provider: 'opencode', sessionId: 'ses_root_bad' },
      },
    }),
  )
  const restored = result.layouts['tab-bad-queue']
  expect(restored.type).toBe('leaf')
  if (restored.type !== 'leaf' || restored.content.kind !== 'terminal') {
    throw new Error('expected terminal leaf')
  }
  expect(restored.content.status).toBe('error')
  expect(restored.content.terminalId).toBeUndefined()
  expect(restored.content.queuedRestore).toBeUndefined()
  expect(restored.content.restoreError?.reason).toBe('provider_runtime_failed')
})
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run test:vitest -- test/unit/client/store/panesSlice.test.ts --run -t "queued"
```

Expected: FAIL because `TerminalPaneContent.status` currently cannot represent `queued` and `stripStaleIds` currently returns a normal creating terminal input.

- [ ] **Step 3: Add the model**

Do not widen `/home/user/code/freshell/.worktrees/dev/src/store/types.ts`'s `TerminalStatus`. `TerminalStatus` is also used by `Tab.status`, `BackgroundTerminal`, `tabsSlice.normalizePersistedTerminalStatus`, `TabSwitcher`, and `TabItem`; tabs must never enter `queued`.

In `/home/user/code/freshell/.worktrees/dev/src/store/paneTypes.ts`:

```ts
export type TerminalPaneStatus = TerminalStatus | 'queued'

export type TerminalQueuedRestore = {
  kind: 'until_visible'
  provider: 'opencode'
  /** Restore needs a visible terminal owner before Freshell may start the OpenCode PTY. */
  reason: 'visible_owner_required'
}
```

Change `TerminalPaneContent.status` and `TerminalPaneInput.status` from `TerminalStatus` to `TerminalPaneStatus`, then add `queuedRestore` to `TerminalPaneContent`:

```ts
  /** Current pane-local terminal status. `queued` is not valid for Tab.status. */
  status: TerminalPaneStatus
  /** Restore launch is intentionally delayed until this pane is visible. */
  queuedRestore?: TerminalQueuedRestore
```

Update the input alias explicitly:

```ts
export type TerminalPaneInput = Omit<TerminalPaneContent, 'createRequestId' | 'status'> & {
  createRequestId?: string
  status?: TerminalPaneStatus
}
```

Keep the type narrow. Do not make this a generic provider framework until a second provider needs it.

Update pane-only UI and helpers that consume `TerminalPaneContent.status` (`Pane`, `PaneHeader`, `TabItem`'s pane-derived status path, and `/home/user/code/freshell/.worktrees/dev/src/lib/terminal-status-indicator.ts`) to accept `TerminalPaneStatus`. Leave `/home/user/code/freshell/.worktrees/dev/src/store/tabsSlice.ts`, `Tab.status`, and `normalizePersistedTerminalStatus` on `TerminalStatus`; persisted tab status of `'queued'` should continue normalizing to `'creating'` because it is invalid tab state.

Add an explicit tab-status mapping rule: a tab containing a queued OpenCode restore must present `Tab.status === 'creating'`, never stale `'running'` and never pane-only `'queued'`. Because `panesSlice` cannot mutate `tabsSlice`, apply this in the dispatching orchestration around any transition that can queue the primary terminal pane (`restoreLayout`, `clearDeadTerminals`, and startup repair paths). Existing direct `Tab.status` consumers such as `/home/user/code/freshell/.worktrees/dev/src/components/TabSwitcher.tsx` and the no-pane-icons path in `/home/user/code/freshell/.worktrees/dev/src/components/TabItem.tsx` may continue reading `tab.status`, but tests must prove queued panes do not leave those surfaces showing `running`.

Add focused UI/store tests:

- In the flow that dispatches `clearDeadTerminals` after receiving the server live-terminal list, prove any tab whose active/primary OpenCode pane was changed to queued also receives `updateTab({ status: 'creating' })`. `panesSlice` itself cannot update `tabsSlice`, so this belongs in the App/startup orchestration test or a small thunk/listener test, not in a pure `panesReducer` assertion.
- In the restored-tab/open-session path, prove adding a tab for a queued OpenCode pane initializes `Tab.status` as `creating`.
- In the tab component tests closest to `TabSwitcher`/`TabItem`, render a tab with a queued OpenCode pane and `tab.status: 'creating'`; assert the status label/dot is pending/creating, not running. If no such focused test exists, add one in `/home/user/code/freshell/.worktrees/dev/test/unit/client/components/`.

- [ ] **Step 4: Normalize queued restore metadata**

In `/home/user/code/freshell/.worktrees/dev/src/store/panesSlice.ts`, add a small sanitizer near `normalizePaneContent`:

```ts
function sanitizeTerminalQueuedRestore(input: unknown): TerminalQueuedRestore | undefined {
  const value = input as Partial<TerminalQueuedRestore> | undefined
  if (
    value?.kind === 'until_visible'
    && value.provider === 'opencode'
    && value.reason === 'visible_owner_required'
  ) {
    return {
      kind: 'until_visible',
      provider: 'opencode',
      reason: 'visible_owner_required',
    }
  }
  return undefined
}
```

Use it from `normalizePaneContent`. Keep the existing explicit terminal return object; do not switch to an implicit spread of unknown input. Import `type TerminalQueuedRestore` from `./paneTypes`, then make the terminal branch compute `sessionRef`, `queuedRestore`, and `canQueue` before the return:

```ts
const sessionRef = sanitizeSessionRef(input.sessionRef)
const queuedRestore = sanitizeTerminalQueuedRestore((input as { queuedRestore?: unknown }).queuedRestore)
const canQueue = mode === 'opencode' && sessionRef?.provider === 'opencode'
const invalidQueuedRestore = input.status === 'queued' && !(queuedRestore && canQueue)
const status = normalizeTerminalPaneStatus(input.status, Boolean(queuedRestore && canQueue))
const stripRuntimeForQueued = status === 'queued' || invalidQueuedRestore
```

Then keep the full explicit return shape and add `queuedRestore` as one conditional field:

```ts
return {
  kind: 'terminal',
  terminalId: !stripRuntimeForQueued && typeof input.terminalId === 'string' ? input.terminalId : undefined,
  createRequestId: typeof input.createRequestId === 'string' && input.createRequestId
    ? input.createRequestId
    : nanoid(),
  status,
  mode,
  shell: typeof input.shell === 'string' ? input.shell : 'system',
  resumeSessionId,
  ...(sessionRef ? { sessionRef } : {}),
  ...(codexDurability ? { codexDurability } : {}),
  serverInstanceId: !stripRuntimeForQueued && typeof input.serverInstanceId === 'string' ? input.serverInstanceId : undefined,
  ...(invalidQueuedRestore
    ? { restoreError: buildRestoreError('provider_runtime_failed') }
    : (restoreError.success ? { restoreError: restoreError.data } : {})),
  ...(queuedRestore && canQueue ? { queuedRestore } : {}),
  initialCwd: typeof input.initialCwd === 'string' ? input.initialCwd : undefined,
}
```

Add `normalizeTerminalPaneStatus` in `panesSlice.ts` so arbitrary persisted strings cannot become runtime status:

```ts
function normalizeTerminalPaneStatus(status: unknown, allowQueued: boolean): TerminalPaneStatus {
  if (status === 'queued' && allowQueued) return 'queued'
  if (status === 'queued') return 'error'
  if (
    status === 'creating'
    || status === 'running'
    || status === 'recovering'
    || status === 'exited'
    || status === 'error'
  ) return status
  return 'creating'
}
```

Import `buildRestoreError` from `@shared/session-contract` if it is not already available in this file. This prevents malformed persisted `status: 'queued'` from silently falling back to `creating`; the runtime launch prevention is pinned separately in Chunk 2.

- [ ] **Step 5: Share restore-state normalization with persisted load**

Do not maintain separate reducer and localStorage boot paths. Move the restore-state content helpers needed by both paths into `/home/user/code/freshell/.worktrees/dev/src/store/paneRestoreState.ts`:

- `normalizePaneContent`
- `stripStaleIds`
- `normalizeRestoredTree`
- `normalizePersistedPaneTreeForBoot`
- `normalizePersistedTerminalContentForBoot`
- queued-restore/session-ref/status sanitizers

`paneRestoreState.ts` must not import `panesSlice.ts` or `persistMiddleware.ts`; both of those modules may import the shared helpers. This avoids a circular dependency and keeps reducer and localStorage boot sanitization consistent without pretending that same-server reload and known-dead restore are the same transition.

Update `panesSlice.ts` to import and use the shared helpers instead of keeping local-only copies.

Update both sanitized layout loops in `persistMiddleware.ts` so `loadPersistedPanes()` applies `normalizePersistedPaneTreeForBoot` before returning data to `panesSlice.ts` or `terminal-restore.ts`:

```ts
const sanitizedNode = stripEditorContentFromNode(normalizePersistedPaneTreeForBoot(migrateNode(node)))
```

For the post-migration loop that already operates on `layouts`, apply the same `normalizePersistedPaneTreeForBoot` call before `stripEditorContentFromNode`. This helper sanitizes queued/error/lease fields, but it must preserve `terminalId` and `serverInstanceId` for normal same-server browser refresh. Do not call `normalizeRestoredTree` directly from persisted boot loading; that helper is for explicit restore/dead-handle transitions where stale runtime ids are already known.

Add failing persisted-load tests in `/home/user/code/freshell/.worktrees/dev/test/unit/client/store/panesPersistence.test.ts`:

```ts
it('preserves a valid same-server OpenCode restore lease candidate with its live handle', () => {
  localStorage.setItem('freshell.layout.v3', JSON.stringify({
    version: 3,
    tabs: { tabs: [{ id: 'tab-opencode', title: 'OpenCode' }], activeTabId: 'tab-opencode' },
    panes: {
      version: PANES_SCHEMA_VERSION,
      layouts: {
        'tab-opencode': {
          type: 'leaf',
          id: 'pane-opencode',
          content: {
            kind: 'terminal',
            mode: 'opencode',
            shell: 'system',
            status: 'running',
            terminalId: 'term-live-refresh',
            createRequestId: 'req-live-refresh',
            serverInstanceId: 'server-same',
            sessionRef: { provider: 'opencode', sessionId: 'ses_root_1' },
            restoreRuntime: {
              replaceOnViewportReplayGap: true,
              createRequestId: 'req-live-refresh',
              terminalId: 'term-live-refresh',
              serverInstanceId: 'server-same',
            },
          },
        },
      },
      activePane: { 'tab-opencode': 'pane-opencode' },
      paneTitles: {},
      paneTitleSetByUser: {},
    },
    tombstones: [],
  }))

  const loaded = loadPersistedPanes()
  const layout = loaded!.layouts['tab-opencode']
  expect(layout.type).toBe('leaf')
  expect(layout.content).toMatchObject({
    kind: 'terminal',
    mode: 'opencode',
    status: 'running',
    terminalId: 'term-live-refresh',
    createRequestId: 'req-live-refresh',
    serverInstanceId: 'server-same',
    sessionRef: { provider: 'opencode', sessionId: 'ses_root_1' },
    restoreRuntime: {
      replaceOnViewportReplayGap: true,
      createRequestId: 'req-live-refresh',
      terminalId: 'term-live-refresh',
      serverInstanceId: 'server-same',
    },
  })
})
```

```ts
it('queues dead OpenCode handles after terminal liveness is known', () => {
  const state = panesReducer(initialState, initLayout({
    tabId: 'tab-opencode',
    paneId: 'pane-opencode',
    content: {
      kind: 'terminal',
      mode: 'opencode',
      shell: 'system',
      status: 'running',
      terminalId: 'term-dead-opencode',
      createRequestId: 'req-dead-opencode',
      sessionRef: { provider: 'opencode', sessionId: 'ses_root_dead' },
    },
  }))

  const next = panesReducer(state, clearDeadTerminals({ liveTerminalIds: [] }))
  const layout = next.layouts['tab-opencode']
  expect(layout.type).toBe('leaf')
  expect(layout.content).toMatchObject({
    kind: 'terminal',
    mode: 'opencode',
    status: 'queued',
    sessionRef: { provider: 'opencode', sessionId: 'ses_root_dead' },
    queuedRestore: {
      kind: 'until_visible',
      provider: 'opencode',
      reason: 'visible_owner_required',
    },
  })
  expect(layout.content.terminalId).toBeUndefined()
  expect(layout.content.createRequestId).not.toBe('req-dead-opencode')
  expect(layout.content.restoreRuntime).toBeUndefined()
})
```

Run:

```bash
npm run test:vitest -- test/unit/client/store/panesPersistence.test.ts --run -t "OpenCode|restore-attempt lease"
npm run test:vitest -- test/unit/client/store/panesSlice.test.ts --run -t "queues dead OpenCode handles"
```

Expected: FAIL before persisted-load sanitization and dead-handle queuing exist.

- [ ] **Step 6: Queue OpenCode restores when stripping stale ids**

In `stripStaleIds`, replace the terminal branch with this shape:

```ts
if (content.kind === 'terminal') {
  const {
    terminalId: _terminalId,
    createRequestId: _createRequestId,
    status: _status,
    queuedRestore: _queuedRestore,
    ...rest
  } = content
  const sessionRef = sanitizeSessionRef(content.sessionRef)
  if (content.mode === 'opencode' && sessionRef?.provider === 'opencode') {
    const { serverInstanceId: _serverInstanceId, ...queuedRest } = rest
    return {
      ...queuedRest,
      status: 'queued',
      queuedRestore: {
        kind: 'until_visible',
        provider: 'opencode',
        reason: 'visible_owner_required',
      },
    }
  }
  return rest
}
```

This keeps shell/Claude/Codex behavior unchanged, including the existing preservation of `serverInstanceId` for non-OpenCode restores. `serverInstanceId` is stripped only for the OpenCode queued branch because a queued pane has no same-server live terminal to match.

Use this same `stripStaleIds` + `normalizePaneContent` path from `clearDeadTerminals` when a terminal pane's `terminalId` is absent from the server's live terminal list. For dead OpenCode handles with canonical `sessionRef.provider === 'opencode'`, the reducer must transition to a visibility-gated restore intent: `status: 'queued'`, `queuedRestore.reason: 'visible_owner_required'`, and a fresh `createRequestId` instead of `status: 'creating'`.

Do not make `clearDeadTerminals` branch on visibility; it does not know which panes are visible. The queued state means "do not start this OpenCode PTY until a mounted visible `TerminalView` owns it", not "this pane was definitely hidden." A currently visible pane may pass through queued for one reducer tick and then launch immediately through `TerminalView`'s visible transition. For non-OpenCode providers, keep the existing dead-handle behavior unless a focused test proves it must change.

- [ ] **Step 7: Update status UI**

In `/home/user/code/freshell/.worktrees/dev/src/lib/terminal-status-indicator.ts`, handle `queued` the same as `creating`:

```ts
case 'queued':
case 'creating':
default:
  return 'text-muted-foreground'
```

and:

```ts
case 'queued':
case 'creating':
default:
  return 'fill-muted-foreground text-muted-foreground'
```

- [ ] **Step 7: Run the model test green**

Run:

```bash
npm run test:vitest -- test/unit/client/store/panesSlice.test.ts --run -t "queued"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/store/paneTypes.ts src/store/panesSlice.ts src/store/paneRestoreState.ts src/store/persistMiddleware.ts src/lib/terminal-status-indicator.ts src/components/panes/Pane.tsx src/components/panes/PaneHeader.tsx src/components/TabItem.tsx src/components/TabSwitcher.tsx test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/components
git commit -m "feat: model queued opencode restores"
```

---

## Chunk 2: TerminalView Visible-First State Machine

### File Structure

- Modify: `/home/user/code/freshell/.worktrees/dev/src/components/TerminalView.tsx`
  - Do not create hidden queued OpenCode restores.
  - On reveal, mark request id as a restore request and send exactly one restored create.
  - Attach immediately after `terminal.created` for visible-started OpenCode restores, even if the pane became hidden before create completed.
- Test: `/home/user/code/freshell/.worktrees/dev/test/unit/client/components/TerminalView.lifecycle.test.tsx`

### Task 2: Prevent Hidden Queued Creates

- [ ] **Step 1: Write the failing hidden-queued test**

Add to the existing `v2 stream lifecycle` describe block:

```ts
it('does not create hidden queued OpenCode restores', async () => {
  const sessionRef = { provider: 'opencode', sessionId: 'ses_queued_hidden' } as const
  await renderTerminalHarness({
    status: 'queued',
    mode: 'opencode',
    hidden: true,
    requestId: 'req-opencode-queued-hidden',
    sessionRef,
    queuedRestore: {
      kind: 'until_visible',
      provider: 'opencode',
      reason: 'visible_owner_required',
    },
    clearSends: false,
  })

  expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
    type: 'terminal.create',
  }))
  expect(restoreMocks.consumeTerminalRestoreRequestId).not.toHaveBeenCalledWith('req-opencode-queued-hidden')
})
```

Add a mounted malformed-state guard test. This is the runtime proof that complements the reducer test from Chunk 1:

```ts
it('does not create a terminal for malformed queued state normalized to error', async () => {
  await renderTerminalHarness({
    status: 'error',
    mode: 'opencode',
    requestId: 'req-opencode-bad-queue',
    terminalId: undefined,
    sessionRef: { provider: 'opencode', sessionId: 'ses_bad_queue' },
    clearSends: false,
  })

  expect(wsMocks.send).not.toHaveBeenCalledWith(expect.objectContaining({
    type: 'terminal.create',
  }))
  expect(restoreMocks.consumeTerminalRestoreRequestId).not.toHaveBeenCalledWith('req-opencode-bad-queue')
})
```

Extend `renderTerminalHarness` options with:

```ts
status?: TerminalPaneContent['status']
queuedRestore?: TerminalPaneContent['queuedRestore']
renderFromStore?: boolean
```

When `renderFromStore` is true, render `TerminalViewFromStore` on the initial render as well as later rerenders:

```tsx
const view = render(
  <Provider store={store}>
    {opts?.renderFromStore
      ? <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={opts?.hidden} />
      : <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} hidden={opts?.hidden} />}
  </Provider>,
)
```

Reveal tests must use the same component type before and after `rerender`. Do not render `TerminalView` first and then `TerminalViewFromStore`; React treats that as an unmount/remount and hides the production tab-activation bug.

- [ ] **Step 2: Run the failing test**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "does not create hidden queued OpenCode restores"
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "does not create a terminal for malformed queued state normalized to error"
```

Expected: FAIL because current code sends `terminal.create` for any terminal content with no `terminalId`, including invalid `error` content.

- [ ] **Step 3: Extract create launch into a reusable state-machine transition**

In `TerminalView.tsx`, add helpers near the other lifecycle helpers:

```ts
function isQueuedVisibleFirstOpenCodeRestore(content: TerminalPaneContent | null | undefined): boolean {
  return content?.mode === 'opencode'
    && content.status === 'queued'
    && !content.terminalId
    && content.queuedRestore?.kind === 'until_visible'
    && content.queuedRestore.provider === 'opencode'
    && content.sessionRef?.provider === 'opencode'
    && typeof content.sessionRef.sessionId === 'string'
}
```

Treat `queued` plus an existing `terminalId` as invalid state. The normal restore path strips runtime ids before queuing; if a malformed persisted pane has both, normalization must drop the stale `terminalId` or surface an error instead of launching or attaching ambiguously.

Add a create eligibility guard that is independent from the queued reveal transition:

```ts
function shouldCreateTerminalImmediately(content: TerminalPaneContent | null | undefined): boolean {
  if (!content) return false
  if (isQueuedVisibleFirstOpenCodeRestore(content)) return false
  return content.status === 'creating' || content.status === 'recovering'
}
```

Use this guard in the no-`terminalId` branch before sending a create:

```ts
} else {
  deferredAttachStateRef.current = {
    mode: 'none',
    pendingIntent: null,
    pendingSinceSeq: 0,
  }
  if (!shouldCreateTerminalImmediately(contentRef.current)) {
    setIsAttaching(false)
    return
  }
  sendCreateForCurrentContent(createRequestId)
}
```

This is not a fallback. It is the terminal lifecycle boundary: only `creating`/`recovering` content may launch immediately, while valid queued OpenCode restores launch through the visibility transition and invalid/error/exited states do not launch.

Extract the existing create sender into a `useCallback` helper outside the create/attach effect so it can be called from both the initial lifecycle effect and the visibility effect:

```ts
const sendCreateForCurrentContent = useCallback((requestId: string) => {
  const content = contentRef.current
  if (!content) return
  const recoveryIntent = getFreshRecoveryIntentForRequest(requestId)
  const restore = recoveryIntent ? false : getRestoreFlagForRequest(requestId)
  const createSessionState = getCreateSessionStateFromRef(contentRef)
  launchAttemptRef.current = {
    requestId,
    restore,
    ...(recoveryIntent ? { recoveryIntent } : {}),
    attachReady: false,
    attachOnCreatedEvenIfHidden: content.mode === 'opencode' && restore && !hiddenRef.current,
  }
  ws.send({
    type: 'terminal.create',
    requestId,
    mode: content.mode,
    shell: content.shell || 'system',
    cwd: content.initialCwd,
    ...(!recoveryIntent && createSessionState.sessionRef ? { sessionRef: createSessionState.sessionRef } : {}),
    ...(!recoveryIntent && createSessionState.codexDurability ? { codexDurability: createSessionState.codexDurability } : {}),
    ...(!recoveryIntent && createSessionState.liveTerminal ? { liveTerminal: createSessionState.liveTerminal } : {}),
    tabId,
    paneId: paneIdRef.current,
    ...(restore ? { restore: true } : {}),
    ...(recoveryIntent ? { recoveryIntent } : {}),
  })
}, [getFreshRecoveryIntentForRequest, getRestoreFlagForRequest, tabId, ws])
```

Move the current `getRestoreFlag` and `getFreshRecoveryIntent` side-channel reads into helpers outside the effect, so rate-limit retry and queued-reveal launch use the same sender:

```ts
const getRestoreFlagForRequest = useCallback((requestId: string) => {
  if (restoreRequestIdRef.current !== requestId) {
    restoreRequestIdRef.current = requestId
    restoreFlagRef.current = consumeTerminalRestoreRequestId(requestId)
  }
  return restoreFlagRef.current
}, [])

const getFreshRecoveryIntentForRequest = useCallback((requestId: string) => {
  if (freshRecoveryRequestIdRef.current !== requestId) {
    freshRecoveryRequestIdRef.current = requestId
    freshRecoveryIntentRef.current = consumeTerminalFreshRecoveryRequest(requestId)
  }
  return freshRecoveryIntentRef.current
}, [])
```

Define these helper callbacks before `sendCreateForCurrentContent` in the file. This preserves the existing "consume when create is actually sent" behavior; hidden queued panes must not consume restore request ids while they are still queued. Rate-limit retry should reuse `sendCreateForCurrentContent(requestId)` so it does not create a second restore-consumption path. If `pendingDurableReplacementRef` or other recovery branches add a restore request id, they should continue doing so before updating `requestIdRef.current`, and the new sender should consume it on the subsequent create.

Add a second helper:

```ts
const launchedQueuedRestoreRequestIdsRef = useRef<Set<string>>(new Set())

const launchQueuedOpenCodeRestoreIfVisible = useCallback(() => {
  const content = contentRef.current
  if (!isQueuedVisibleFirstOpenCodeRestore(content)) return false
  if (hiddenRef.current) return false
  const createRequestId = content.createRequestId
  if (launchedQueuedRestoreRequestIdsRef.current.has(createRequestId)) return true
  launchedQueuedRestoreRequestIdsRef.current.add(createRequestId)
  addTerminalRestoreRequestId(createRequestId)
  updateContent({
    status: 'creating',
    queuedRestore: undefined,
    restoreError: undefined,
  })
  const currentTab = tabRef.current
  if (currentTab) {
    dispatch(updateTab({ id: currentTab.id, updates: { status: 'creating' } }))
  }
  sendCreateForCurrentContent(createRequestId)
  return true
}, [dispatch, sendCreateForCurrentContent, updateContent])
```

Inside the create/attach effect before the `currentTerminalId` decision, add:

```ts
if (isQueuedVisibleFirstOpenCodeRestore(contentRef.current)) {
  if (!launchQueuedOpenCodeRestoreIfVisible()) {
    deferredAttachStateRef.current = {
      mode: 'none',
      pendingIntent: null,
      pendingSinceSeq: 0,
    }
    setIsAttaching(false)
  }
  return
}
```

Do not consume the restore request id while hidden.

In the existing `hidden`-dependent "When becoming visible" effect, call the same transition before existing attach/layout logic:

```ts
if (!hidden && launchQueuedOpenCodeRestoreIfVisible()) {
  return
}
```

This `hidden`-dependent call is the production path for tab activation, because `/home/user/code/freshell/.worktrees/dev/src/App.tsx` mounts each `TabContent` once and toggles `hidden` instead of remounting tabs.

- [ ] **Step 4: Run the hidden-queued test green**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "does not create hidden queued OpenCode restores"
```

Expected: PASS.

### Task 3: Reveal Queued Restores Exactly Once

- [ ] **Step 1: Write the failing reveal test**

```ts
it('revealing a queued OpenCode restore sends one restored create with the canonical sessionRef', async () => {
  const sessionRef = { provider: 'opencode', sessionId: 'ses_queued_visible' } as const
  const { store, tabId, paneId, rerender, requestId } = await renderTerminalHarness({
    status: 'queued',
    mode: 'opencode',
    hidden: true,
    requestId: 'req-opencode-queued-visible',
    sessionRef,
    renderFromStore: true,
    queuedRestore: {
      kind: 'until_visible',
      provider: 'opencode',
      reason: 'visible_owner_required',
    },
    clearSends: false,
  })

  wsMocks.send.mockClear()

  const addedRestoreIds = new Set<string>()
  restoreMocks.addTerminalRestoreRequestId.mockImplementation((id: string) => {
    addedRestoreIds.add(id)
  })
  restoreMocks.consumeTerminalRestoreRequestId.mockImplementation((id: string) => {
    if (!addedRestoreIds.has(id)) return false
    addedRestoreIds.delete(id)
    return true
  })

  // Keep the component type identical across rerenders. This simulates the
  // production tab path where App.tsx toggles hidden without remounting.
  rerender(
    <Provider store={store}>
      <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
    </Provider>,
  )

  await waitFor(() => {
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.create',
      requestId,
      mode: 'opencode',
      sessionRef,
      restore: true,
    }))
  })

  const creates = wsMocks.send.mock.calls
    .map(([msg]) => msg)
    .filter((msg) => msg?.type === 'terminal.create' && msg?.requestId === requestId)
  expect(creates).toHaveLength(1)
  const layout = store.getState().panes.layouts[tabId]
  expect(layout?.type).toBe('leaf')
  if (layout?.type === 'leaf' && layout.content.kind === 'terminal') {
    expect(layout.content.status).toBe('creating')
    expect(layout.content.queuedRestore).toBeUndefined()
  }
  expect(store.getState().tabs.tabs.find((tab) => tab.id === tabId)?.status).toBe('creating')
})
```

- [ ] **Step 2: Run the reveal test**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "revealing a queued OpenCode restore"
```

Expected: FAIL until the `hidden`-dependent reveal effect launches queued restores without relying on remount.

- [ ] **Step 3: Fix duplicate create risk**

If the test sends twice, use the ref added in Task 2:

```ts
const launchedQueuedRestoreRequestIdsRef = useRef<Set<string>>(new Set())
```

Guard the reveal branch:

```ts
if (launchedQueuedRestoreRequestIdsRef.current.has(createRequestId)) return
launchedQueuedRestoreRequestIdsRef.current.add(createRequestId)
```

Clear this set only on unmount by letting the component instance go away; do not persist it. Do not clear the old id when a recovery path mints a new `createRequestId`: the old id should remain suppressed, and the new id is intentionally allowed to launch once. The guard is same-pane dedupe, not same-session dedupe across multiple panes.

- [ ] **Step 4: Run the reveal test green**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "revealing a queued OpenCode restore"
```

Expected: PASS.

### Task 4: Close the Visible-Create-Then-Hidden Race

- [ ] **Step 1: Write the failing race test**

```ts
it('attaches an OpenCode restore created while visible even if hidden before terminal.created', async () => {
  const sessionRef = { provider: 'opencode', sessionId: 'ses_visible_then_hidden' } as const
  const { store, tabId, paneId, rerender, requestId } = await renderTerminalHarness({
    status: 'queued',
    mode: 'opencode',
    hidden: false,
    requestId: 'req-opencode-visible-race',
    sessionRef,
    renderFromStore: true,
    queuedRestore: {
      kind: 'until_visible',
      provider: 'opencode',
      reason: 'visible_owner_required',
    },
    clearSends: false,
  })

  await waitFor(() => {
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.create',
      requestId,
      restore: true,
    }))
  })

  wsMocks.send.mockClear()

  rerender(
    <Provider store={store}>
      <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden />
    </Provider>,
  )

  act(() => {
    messageHandler!({
      type: 'terminal.created',
      requestId,
      terminalId: 'term-visible-started-opencode',
      createdAt: Date.now(),
    })
  })

  await waitFor(() => {
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.attach',
      terminalId: 'term-visible-started-opencode',
      intent: 'viewport_hydrate',
      sinceSeq: 0,
    }))
  })

  const attach = wsMocks.send.mock.calls
    .map(([msg]) => msg)
    .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === 'term-visible-started-opencode')
  wsMocks.send.mockClear()

  act(() => {
    messageHandler!({
      type: 'terminal.attach.ready',
      terminalId: 'term-visible-started-opencode',
      headSeq: 0,
      replayFromSeq: 1,
      replayToSeq: 0,
      attachRequestId: attach.attachRequestId,
    })
  })

  // Seed the cached viewport to the same geometry the fit will produce. The
  // reveal resize must still send because hidden attach used fallback geometry.
  seedLastSentViewportForTest('term-visible-started-opencode', { cols: 80, rows: 24 })

  rerender(
    <Provider store={store}>
      <TerminalViewFromStore tabId={tabId} paneId={paneId} hidden={false} />
    </Provider>,
  )

  await waitFor(() => {
    expect(wsMocks.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal.resize',
      terminalId: 'term-visible-started-opencode',
    }))
  })
})
```

Add the `seedLastSentViewportForTest` hook through `renderTerminalHarness` or another test-only harness seam; do not expose it in production UI props.

- [ ] **Step 2: Run the race test red**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "attaches an OpenCode restore created while visible"
```

Expected: FAIL because `terminal.created` currently branches on `hiddenRef.current` and defers attach.

- [ ] **Step 3: Add attach obligation to launch attempts**

Extend `LaunchAttemptState` in `/home/user/code/freshell/.worktrees/dev/src/components/TerminalView.tsx`:

```ts
  attachOnCreatedEvenIfHidden?: boolean
```

If this was not already done while extracting `sendCreateForCurrentContent` in Task 2, set the attach obligation after computing `restore`:

```ts
const attachOnCreatedEvenIfHidden = mode === 'opencode'
  && restore
  && !hiddenRef.current
```

Store it in `launchAttemptRef.current`.

In `terminal.created`, compute the attach obligation from the pre-overwrite launch snapshot before assigning a fresh `launchAttemptRef.current`:

```ts
const mustAttachNow = pendingLaunch?.requestId === reqId
  && pendingLaunch.attachOnCreatedEvenIfHidden

launchAttemptRef.current = {
  requestId: reqId,
  restore: pendingLaunch?.restore ?? false,
  attachReady: false,
  ...(mustAttachNow ? { attachOnCreatedEvenIfHidden: true } : {}),
}
```

Then replace:

```ts
if (hiddenRef.current) {
```

with:

```ts
if (hiddenRef.current && !mustAttachNow) {
```

For `mustAttachNow`, call:

```ts
attachTerminal(newId, 'viewport_hydrate', {
  clearViewportFirst: true,
  skipPreAttachFit: true,
})
```

Because this attach happens while the pane may be hidden, record that the terminal needs a real geometry resize on reveal:

```ts
const resizeAfterHiddenOpenCodeRestoreAttachRef = useRef<Set<string>>(new Set())

if (mustAttachNow && hiddenRef.current) {
  resizeAfterHiddenOpenCodeRestoreAttachRef.current.add(newId)
}
```

Extend `requestTerminalLayout`/`pendingLayoutWorkRef` with a one-shot `forceResize?: boolean` flag. When `forceResize` is set, `flushScheduledLayout` must send `terminal.resize` after `runtime.fit()` even if the new geometry matches `lastSentViewportRef`; clear the flag in the same flush. This is the only place in this plan that may bypass the cached viewport suppression.

In the `hidden`-dependent visibility effect, after queued-launch handling and before the generic layout return, send a forced fit+resize when the pane becomes visible:

```ts
if (!hidden) {
  const tid = terminalIdRef.current
  if (tid && resizeAfterHiddenOpenCodeRestoreAttachRef.current.delete(tid)) {
    requestTerminalLayout({ fit: true, resize: true, forceResize: true })
    return
  }
}
```

This keeps the immediate attach obligation deterministic without freezing OpenCode at the fallback hidden geometry. A test must assert an actual `terminal.resize` message is sent on reveal even when `lastSentViewportRef` already matches the fitted geometry.

Clean up `resizeAfterHiddenOpenCodeRestoreAttachRef` whenever the terminal id is replaced, killed/exited, or the component unmounts:

```ts
resizeAfterHiddenOpenCodeRestoreAttachRef.current.delete(oldTerminalId)
resizeAfterHiddenOpenCodeRestoreAttachRef.current.clear() // unmount cleanup
```

Only visible-started OpenCode restores get `attachOnCreatedEvenIfHidden`. Recovery-driven creates sent while already hidden should keep the existing deferred-attach behavior unless a separate test proves they need the same obligation.

- [ ] **Step 4: Run race test green**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "attaches an OpenCode restore created while visible"
```

Expected: PASS.

- [ ] **Step 5: Run full lifecycle test file**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix: launch opencode restores only when visible"
```

---

## Chunk 3: Constrain Replay-Gap Safety Net

### File Structure

- Modify: `/home/user/code/freshell/.worktrees/dev/src/store/paneTypes.ts`
  - Add a narrow restore-attempt lease for OpenCode restored PTYs that may be replaced if their initial viewport hydrate is unrecoverable.
- Modify: `/home/user/code/freshell/.worktrees/dev/src/store/paneRestoreState.ts`
  - Sanitize restore-attempt leases without widening the durable pane contract.
- Modify: `/home/user/code/freshell/.worktrees/dev/src/store/persistMiddleware.ts`
  - Persist only validated same-server restore-attempt lease candidates; dead-handle cleanup strips them before queued repair.
- Modify: `/home/user/code/freshell/.worktrees/dev/src/components/TerminalView.tsx`
  - Set the lease only for restored OpenCode creates that can still be safely replaced.
  - Require the lease before the kill/recreate safety net runs.
- Test: `/home/user/code/freshell/.worktrees/dev/test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Test: `/home/user/code/freshell/.worktrees/dev/test/unit/client/store/panesPersistence.test.ts`

### Task 5: Mark Replaceable Restored OpenCode PTYs

- [ ] **Step 1: Write failing non-kill test**

```ts
it('does not kill an unowned OpenCode terminal on viewport replay gap', async () => {
  const sessionRef = { provider: 'opencode', sessionId: 'ses_live_busy' } as const
  const { store, tabId, paneId, terminalId } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-opencode-live-gap',
    mode: 'opencode',
    sessionRef,
    clearSends: false,
  })

  const attach = wsMocks.send.mock.calls
    .map(([msg]) => msg)
    .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)

  wsMocks.send.mockClear()
  act(() => {
    messageHandler!({
      type: 'terminal.output.gap',
      terminalId,
      fromSeq: 1,
      toSeq: 100,
      reason: 'replay_window_exceeded',
      attachRequestId: attach.attachRequestId,
    } as any)
  })

  expect(wsMocks.send).not.toHaveBeenCalledWith({
    type: 'terminal.kill',
    terminalId,
  })
  const layout = store.getState().panes.layouts[tabId]
  expect(layout?.type).toBe('leaf')
  if (layout?.type === 'leaf') {
    expect(layout.id).toBe(paneId)
    expect(layout.content.kind).toBe('terminal')
    if (layout.content.kind === 'terminal') {
      expect(layout.content.status).toBe('running')
      expect(layout.content.restoreRuntime).toBeUndefined()
    }
  }
})
```

Expected red today if the current PR #346 guard kills any OpenCode pane with `sessionRef`.

- [ ] **Step 2: Add restore-attempt lease type**

In `/home/user/code/freshell/.worktrees/dev/src/store/paneTypes.ts`:

```ts
export type TerminalRestoreRuntime = {
  replaceOnViewportReplayGap: true
  createRequestId: string
  terminalId: string
  serverInstanceId: string
}
```

Add to `TerminalPaneContent`:

```ts
  /** Restore-attempt lease for a restored PTY that is still safe to replace if initial replay is unrecoverable. */
  restoreRuntime?: TerminalRestoreRuntime
```

Keep this lease narrow. It does not need a `provider` field because it is only valid on `mode: 'opencode'` pane content with `sessionRef.provider === 'opencode'`. It does need `serverInstanceId` so a browser refresh can preserve an in-flight same-server lease without letting that lease survive a server restart. Do not treat `sessionRef` or `terminalId` alone as proof of ownership.

- [ ] **Step 3: Normalize restore-attempt lease**

In `panesSlice.ts`, add a sanitizer near the queued-restore sanitizer and call it from `normalizePaneContent`:

```ts
function sanitizeTerminalRestoreRuntime(input: unknown): TerminalRestoreRuntime | undefined {
  const value = input as Partial<TerminalRestoreRuntime> | undefined
  if (
    value?.replaceOnViewportReplayGap === true
    && typeof value.createRequestId === 'string'
    && value.createRequestId.length > 0
    && typeof value.terminalId === 'string'
    && value.terminalId.length > 0
    && typeof value.serverInstanceId === 'string'
    && value.serverInstanceId.length > 0
  ) {
    return {
      replaceOnViewportReplayGap: true,
      createRequestId: value.createRequestId,
      terminalId: value.terminalId,
      serverInstanceId: value.serverInstanceId,
    }
  }
  return undefined
}
```

Only preserve `restoreRuntime` when:

```ts
mode === 'opencode'
&& sessionRef?.provider === 'opencode'
&& restoreRuntime.replaceOnViewportReplayGap === true
&& typeof restoreRuntime.createRequestId === 'string'
&& typeof restoreRuntime.terminalId === 'string'
&& typeof restoreRuntime.serverInstanceId === 'string'
&& restoreRuntime.createRequestId === createRequestId
&& restoreRuntime.terminalId === terminalId
&& restoreRuntime.serverInstanceId === serverInstanceId
```

Add it explicitly to `normalizePaneContent`'s terminal return object, just like `queuedRestore`:

```ts
const restoreRuntime = sanitizeTerminalRestoreRuntime((input as { restoreRuntime?: unknown }).restoreRuntime)
const canKeepRestoreRuntime = mode === 'opencode'
  && sessionRef?.provider === 'opencode'
  && status !== 'queued'
  && !invalidQueuedRestore
  && Boolean(restoreRuntime)
  && restoreRuntime?.createRequestId === createRequestId
  && restoreRuntime?.terminalId === terminalId
  && restoreRuntime?.serverInstanceId === serverInstanceId

return {
  // existing explicit fields...
  ...(queuedRestore && canQueue ? { queuedRestore } : {}),
  ...(canKeepRestoreRuntime ? { restoreRuntime } : {}),
  initialCwd: typeof input.initialCwd === 'string' ? input.initialCwd : undefined,
}
```

Do not let a restore-attempt lease survive a server restart or dead terminal handle. Do allow it to survive a same-server browser refresh while the restored PTY is still live and before the first successful `viewport_hydrate`; otherwise a refresh during initial OpenCode startup would remove the only ownership proof allowed to repair an unrecoverable replay gap.

In this chunk, update the shared terminal restore-state helper introduced in Chunk 1 so every stale-runtime stripping path drops `restoreRuntime` before constructing either return path:

```ts
const {
  terminalId: _terminalId,
  createRequestId: _createRequestId,
  status: _status,
  queuedRestore: _queuedRestore,
  restoreRuntime: _restoreRuntime,
  ...rest
} = content
```

Keep the Chunk 1 behavior that preserves `serverInstanceId` for non-OpenCode restores; only the OpenCode queued branch should strip `serverInstanceId`. A fresh `restoreRuntime` lease is authored in `terminal.created` for the new restored create.

Update `/home/user/code/freshell/.worktrees/dev/src/store/persistMiddleware.ts` so `stripTransientSessionFields` preserves only a structurally valid same-server lease candidate and strips malformed lease payloads:

```ts
if (content.kind === 'terminal') {
  const normalized = normalizePersistedTerminalContentForBoot(content)
  const sessionRef = sanitizeSessionRef(normalized.sessionRef)
  const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, sessionId: _sessionId, ...rest } = normalized
  return {
    ...rest,
    ...(sessionRef ? { sessionRef } : {}),
  }
}
```

The read path must be sanitized too, because users may already have persisted layouts containing malformed or stale-looking `restoreRuntime`. The `panesPersistence.test.ts` lease test from Chunk 1 proves that a valid candidate with matching `createRequestId`, `terminalId`, and `serverInstanceId` is preserved on boot. Add companion tests proving malformed candidates are stripped and `clearDeadTerminals` strips even valid candidates when the terminal is not live.

- [ ] **Step 4: Set lease on restored OpenCode create**

Do not rely only on Redux propagation for the server instance id. On cold boot, `WsClient` can receive `ready`, populate its own `serverInstanceId`, flush queued `terminal.create`, and receive a fast `terminal.created` before `App.tsx` has pushed `connection.serverInstanceId` through React into `TerminalView`. Add a local helper that reads the synchronous WebSocket client value first:

```ts
const getCurrentServerInstanceId = useCallback(() => {
  const fromWs = typeof ws.serverInstanceId === 'string' && ws.serverInstanceId.trim()
    ? ws.serverInstanceId
    : undefined
  return fromWs ?? serverInstanceIdRef.current
}, [ws])
```

In `terminal.created`, when `pendingLaunch?.restore === true`, `mode === 'opencode'`, and `getCurrentServerInstanceId()` returns a non-empty string, include:

```ts
const restoreServerInstanceId = getCurrentServerInstanceId()
restoreRuntime: {
  replaceOnViewportReplayGap: true,
  createRequestId: reqId,
  terminalId: newId,
  serverInstanceId: restoreServerInstanceId,
},
```

Add a lifecycle test that simulates `ws.serverInstanceId` being set while Redux `connection.serverInstanceId` is still undefined and proves the resulting `terminal.created` handler writes `restoreRuntime.serverInstanceId`. This test should fail if the implementation reads only `serverInstanceIdRef.current`.

Also store the create request id by terminal id in a ref so attach-completion code never compares create ids to attach ids:

```ts
const replaceableRestoreByTerminalIdRef = useRef<Map<string, string>>(new Map())
replaceableRestoreByTerminalIdRef.current.set(newId, reqId)
```

Clear the lease only after the first successful `viewport_hydrate` attach completes for the same terminal and the same create request:

```ts
const currentAttach = currentAttachRef.current
const restoreRuntime = contentRef.current?.restoreRuntime
if (
  currentAttach?.intent === 'viewport_hydrate'
  && restoreRuntime?.replaceOnViewportReplayGap === true
  && restoreRuntime.terminalId === currentAttach.terminalId
  && restoreRuntime.serverInstanceId === getCurrentServerInstanceId()
  && replaceableRestoreByTerminalIdRef.current.get(currentAttach.terminalId) === restoreRuntime.createRequestId
) {
  replaceableRestoreByTerminalIdRef.current.delete(currentAttach.terminalId)
  updateContent({ restoreRuntime: undefined })
}
```

Do not clear the lease on `terminal.output.gap`; the lease must remain available for the replacement decision.

- [ ] **Step 5: Require restore-attempt ownership before replay-gap replacement**

Change `beginOpenCodeReplacementAfterExit` or its caller so the kill/recreate path only runs when:

```ts
contentRef.current?.restoreRuntime?.replaceOnViewportReplayGap === true
&& contentRef.current.restoreRuntime.terminalId === terminalId
&& contentRef.current.restoreRuntime.createRequestId === contentRef.current.createRequestId
&& contentRef.current.restoreRuntime.serverInstanceId === contentRef.current.serverInstanceId
&& contentRef.current.restoreRuntime.serverInstanceId === getCurrentServerInstanceId()
```

If the lease is absent, do not kill and do not mark the pane errored. Leave live OpenCode terminals in the existing soft gap behavior: write the ordinary replay-gap notice, apply sequence state, and let fresh frames continue. This is important because an unowned OpenCode terminal may still be live and usable.

```ts
if (!canReplaceForReplayGap) {
  // Existing non-destructive output-gap path continues here.
  term.writeln('\r\n[Terminal output gap detected; some earlier output is no longer available]\r\n')
  applySeqState(/* existing gap handling state */)
  return
}
```

Do not silently start a fresh terminal for an unowned gap. Also do not set `status: 'error'` unless the terminal actually exits or another existing unrecoverable-terminal path proves the PTY is gone.

- [ ] **Step 6: Preserve migration repair for the current bad release window**

Do not keep PR #346's broad `lastSeq === 0 && !terminalFirstOutputMarkedRef.current` compatibility guard. That runtime state is indistinguishable from a live user-owned OpenCode terminal that simply missed replay, so using it would either kill real work or make the non-kill test impossible to satisfy.

Preserve migration repair only through explicit state:

```ts
const canReplaceForReplayGap = contentRef.current?.mode === 'opencode'
  && contentRef.current?.sessionRef?.provider === 'opencode'
  && contentRef.current?.restoreRuntime?.replaceOnViewportReplayGap === true
  && contentRef.current.restoreRuntime.terminalId === terminalId
  && contentRef.current.restoreRuntime.createRequestId === contentRef.current.createRequestId
  && contentRef.current.restoreRuntime.serverInstanceId === contentRef.current.serverInstanceId
  && contentRef.current.restoreRuntime.serverInstanceId === getCurrentServerInstanceId()
```

The deterministic migration is: Chunk 1 turns restored hidden OpenCode panes into queued restore intents, and Chunk 3 authors `restoreRuntime` at the point the restored `terminal.create` succeeds. Persisted pre-lease panes therefore do not need a stored lease; their next visible restore create gets one before any replay-gap replacement can run. Already-live, unowned PTYs from the current release window are treated conservatively as live terminals: they receive the soft output-gap notice and keep running, with no kill/recreate.

Do not invent alternate ownership proofs from `seqStateRef`, `lastSeq`, first-output flags, or the mere presence of `sessionRef`.

Update the existing repair test `recreates a restored OpenCode pane when visible viewport hydration cannot replay startup output` so its harness state includes:

```ts
restoreRuntime: {
  replaceOnViewportReplayGap: true,
  createRequestId: requestId,
  terminalId,
  serverInstanceId: 'server-test',
}
```

Extend `renderTerminalHarness` with `restoreRuntime?: TerminalPaneContent['restoreRuntime']`. This makes the repair test and the new non-kill test intentionally different: the repair case has the restore-attempt lease; the live case does not.

- [ ] **Step 7: Run safety-net tests**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run -t "viewport replay gap"
```

Expected: both the existing leased repair test and the new unowned non-kill test pass.

- [ ] **Step 8: Commit**

```bash
git add src/store/paneTypes.ts src/store/paneRestoreState.ts src/store/persistMiddleware.ts src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/store/panesPersistence.test.ts
git commit -m "fix: constrain opencode replay-gap replacement"
```

---

## Chunk 4: Restart And Sidebar Contract

### File Structure

- Modify: `/home/user/code/freshell/.worktrees/dev/test/e2e-browser/specs/opencode-restart-recovery.spec.ts`
  - Change restart expectations: active visible OpenCode restores immediately; hidden OpenCode panes remain queued until clicked.
  - Assert left/sidebar history still lists old OpenCode sessions.
- Possibly modify: `/home/user/code/freshell/.worktrees/dev/src/components/TerminalView.tsx`
  - User-visible copy for queued visible-first restore, if a visible queued pane renders before transition.
- Possibly modify: `/home/user/code/freshell/.worktrees/dev/src/components/Sidebar.tsx` or selectors under `/home/user/code/freshell/.worktrees/dev/src/store/selectors/`
  - Only if tests prove queued no-PTY sessions disappear from the left pane.

### Task 6: Update Browser Restart Expectations

- [ ] **Step 1: Write failing browser e2e for queued hidden restart**

In `/home/user/code/freshell/.worktrees/dev/test/e2e-browser/specs/opencode-restart-recovery.spec.ts`, split the current assertion after restart:

```ts
const activeTabId = await harness.getActiveTabId()
const hiddenOpenCodeTabIds = survivingOpenCodeTabIds.filter((tabId) => tabId !== activeTabId)

const activeAfterRestart = await waitForRunningTerminals(input.page, [activeTabId], previousTerminalIdsByTab)
expect(activeAfterRestart[0].mode).toBe('opencode')
expect(activeAfterRestart[0].terminalId).toBeTruthy()

const hiddenSnapshots = await getPaneSnapshots(input.page, hiddenOpenCodeTabIds)
for (const snapshot of hiddenSnapshots) {
  expect(snapshot.status).toBe('queued')
  expect(snapshot.terminalId).toBeFalsy()
  expect(snapshot.sessionRef?.sessionId).toMatch(/^ses_root_/)
}
```

Then click each hidden OpenCode tab and assert it restores:

```ts
for (const tabId of hiddenOpenCodeTabIds) {
  await selectTab(input.page, tabId)
  const [snapshot] = await waitForOpenCodeSessions(input.page, [tabId])
  expect(snapshot.terminalId).toBeTruthy()
  expect(snapshot.sessionRef).toEqual(beforeByTab.get(tabId)?.sessionRef)
}
```

Use existing helper names where available; add `harness.getActiveTabId` or equivalent only if no helper exists.

- [ ] **Step 2: Run browser e2e red**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts
```

Expected: FAIL before visible-first implementation is complete because hidden OpenCode panes still restore immediately or because helpers do not yet expose queued state.

- [ ] **Step 3: Fix helper/state exposure if needed**

If `getPaneSnapshots` omits `status` or `queuedRestore`, extend the browser harness snapshot shape in `/home/user/code/freshell/.worktrees/dev/test/e2e-browser/helpers/test-harness.ts` only for test visibility.

- [ ] **Step 4: Assert sidebar/history rows remain present**

Add an assertion after restart and before clicking hidden tabs:

```ts
const expectedHistoryRows = survivingOpenCodeTabIds.map((tabId) => ({
  tabId,
  sessionId: beforeByTab.get(tabId)?.sessionRef?.sessionId,
}))

for (const row of expectedHistoryRows) {
  expect(row.sessionId, `missing sessionRef for ${row.tabId}`).toBeTruthy()
  const fakeOpenCodeHistoryTitle = `Root ${row.sessionId}`
  await expect(input.page.getByRole('button', {
    name: new RegExp(`^${escapeRegExp(fakeOpenCodeHistoryTitle)}\\b`, 'i'),
  })).toBeVisible()
}
```

Use the visible title rendered by the fake OpenCode session metadata (`/home/user/code/freshell/.worktrees/dev/test/e2e-browser/fixtures/fake-opencode.cjs` currently seeds `Root ${rootSessionId}`), not the tab title. Add a local `escapeRegExp` helper if the spec does not already have one. If the fixture title shape changes, compute the title from that fixture metadata and keep the assertion role-based and session-specific. Do not weaken this to checking Redux state only; the requirement is left-pane visibility.

- [ ] **Step 5: Run browser e2e green**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/e2e-browser/specs/opencode-restart-recovery.spec.ts test/e2e-browser/helpers/test-harness.ts src/components/TerminalView.tsx src/components/Sidebar.tsx src/store/selectors
git commit -m "test: cover visible-first opencode restart restores"
```

Only add `src/components/Sidebar.tsx` or selector files if the implementation actually required them.

---

## Chunk 5: Multi-Client And Server Reuse Proofs

### File Structure

- Modify: `/home/user/code/freshell/.worktrees/dev/test/server/ws-terminal-create-session-repair.test.ts`
  - Prove killed OpenCode terminal binding is released before restored create.
  - Prove the existing canonical-session reuse path handles both sequential and simultaneous duplicate restored creates for the same OpenCode `sessionRef`.
- Add or modify: `/home/user/code/freshell/.worktrees/dev/test/e2e/opencode-visible-first-restore-flow.test.tsx`
  - Mock-WebSocket client test for same-pane duplicate create prevention.
- Possibly modify: `/home/user/code/freshell/.worktrees/dev/src/components/TerminalView.tsx`
  - Add same-pane dedupe guard if tests show duplicate creates.
- Possibly modify: `/home/user/code/freshell/.worktrees/dev/server/ws-handler.ts` and `/home/user/code/freshell/.worktrees/dev/server/terminal-registry.ts`
  - Extend the existing canonical-session reuse/binding path if the simultaneous-create characterization proves a real race; do not add a second session ownership table.

### Task 7: Prove Replacement Cannot Reuse Killed Terminal

- [ ] **Step 1: Write server test**

Add a server-side test that:

1. Creates an OpenCode terminal with `sessionRef`.
2. Kills it with `terminal.kill`.
3. Sends restored `terminal.create` for the same `sessionRef`.
4. Asserts the new `terminal.created.terminalId` differs from the killed id.

Use existing fake registry/test harness in `ws-terminal-create-session-repair.test.ts`.

- [ ] **Step 2: Run server test**

Run:

```bash
npm run test:vitest -- test/server/ws-terminal-create-session-repair.test.ts --run -t "opencode"
```

Expected: PASS if current `TerminalRegistry.kill()` release binding behavior is correct; FAIL if the create reuses stale binding.

### Task 8: Prove Restore Launches Are Idempotent At The Right Layer

- [ ] **Step 1: Write same-pane client flow test**

Create `/home/user/code/freshell/.worktrees/dev/test/e2e/opencode-visible-first-restore-flow.test.tsx` or extend an existing terminal lifecycle flow test. Simulate one queued OpenCode pane that becomes visible, rerenders, hides, and becomes visible again before `terminal.created`.

Expected:

```ts
const restoreCreatesForPaneRequestId = wsMocks.send.mock.calls
  .map(([msg]) => msg)
  .filter((msg) => msg?.type === 'terminal.create'
    && msg.requestId === requestId
    && msg.restore === true)
expect(restoreCreatesForPaneRequestId).toHaveLength(1)
```

This test pins the `launchedQueuedRestoreRequestIdsRef` contract: a single pane instance sends at most one restored create for its current persisted `createRequestId`. Do not filter by a fresh `nanoid`; the matcher must compare against the pane's `requestId` returned by the harness.

- [ ] **Step 2: Write server same-session reuse and race tests**

First add a characterization for the existing sequential reuse path in `/home/user/code/freshell/.worktrees/dev/test/server/ws-terminal-create-session-repair.test.ts`. This may already pass because `/home/user/code/freshell/.worktrees/dev/server/ws-handler.ts` checks `getCanonicalRunningTerminalBySession` before and after async config loading:

```ts
const sessionRef = { provider: 'opencode', sessionId: 'ses_same_session' } as const
sendCreate({ requestId: 'req-a', mode: 'opencode', restore: true, sessionRef })
const first = await waitForCreated('req-a')
sendCreate({ requestId: 'req-b', mode: 'opencode', restore: true, sessionRef })
const second = await waitForCreated('req-b')
expect(second.terminalId).toBe(first.terminalId)
expect(fakePtySpawnCountForSession(sessionRef.sessionId)).toBe(1)
```

Then add the actual race characterization: hold the fake spawn/config path open, send `req-a` and `req-b` for the same canonical OpenCode `sessionRef` before either request can emit `terminal.created`, release the held create, and assert both request ids receive the same terminal id with one PTY spawn.

```ts
const sessionRef = { provider: 'opencode', sessionId: 'ses_same_session_race' } as const
const hold = holdNextPtyCreateForSession(sessionRef.sessionId)
sendCreate({ requestId: 'req-a', mode: 'opencode', restore: true, sessionRef })
sendCreate({ requestId: 'req-b', mode: 'opencode', restore: true, sessionRef })
hold.release()
const first = await waitForCreated('req-a')
const second = await waitForCreated('req-b')
expect(second.terminalId).toBe(first.terminalId)
expect(fakePtySpawnCountForSession(sessionRef.sessionId)).toBe(1)
```

Use the existing fake registry/test harness equivalent for the spawn-count assertion; do not add production-only counters. If the sequential characterization passes but the simultaneous race fails, extend the existing canonical-session binding/reuse mechanism already used by `getCanonicalRunningTerminalBySession`, `repairLegacySessionOwners`, and `SessionBindingAuthority`. The fix should reserve an in-flight canonical create for `{ mode: 'opencode', sessionRef.sessionId }` inside the existing registry/binding architecture, then resolve all waiters to the created terminal id. Do not create a parallel OpenCode-only ownership table with separate kill/exit semantics.

Server contract if the race is real:

- For `terminal.create` with `restore: true`, `mode: 'opencode'`, and canonical `sessionRef.provider === 'opencode'`, canonicalize the session id through the existing session-binding validation before considering reuse.
- If `getCanonicalRunningTerminalBySession` returns a live non-exited terminal, return that terminal id and do not spawn.
- If an in-flight canonical create already exists in the existing binding/reuse mechanism, await it and return that terminal id for the later request id. This closes simultaneous-create races.
- If the in-flight create rejects, clear the reservation and surface the original create error to all waiters; do not leave a permanently poisoned reservation.
- If the prior PTY exited or was killed, existing binding release must happen before a later restored create can reuse anything, so Task 7's kill-then-restore path creates a new terminal id.
- If the live PTY exists but has no attached client yet, still reuse it; each client/pane will attach after receiving `terminal.created`.
- Existing ws-handler repair paths that recover or migrate an OpenCode terminal must either flow through the same canonical binding mechanism or deliberately bypass it with a test explaining why. The Task 8 server race test should cover the main restored-create path; add a second assertion if implementation discovery shows a separate repair path can create an equivalent terminal.

The WebSocket handler remains responsible for emitting one `terminal.created` message per incoming request id, even when the terminal id is reused:

```ts
ws.send({
  type: 'terminal.created',
  requestId: incoming.requestId,
  terminalId: reusedOrCreatedTerminalId,
  createdAt,
})
```

- [ ] **Step 3: Run flow tests red/green**

Run:

```bash
npm run test:vitest -- test/e2e/opencode-visible-first-restore-flow.test.tsx --run
npm run test:vitest -- test/server/ws-terminal-create-session-repair.test.ts --run -t "same OpenCode session"
```

Expected: the same-pane client test fails before the `TerminalView` guard and passes after it. The sequential server characterization may already pass; the simultaneous server race test is the proof that determines whether server code needs to change. If both server tests are already green, record them as characterization coverage and do not change server code.

- [ ] **Step 4: Commit**

```bash
git add test/server/ws-terminal-create-session-repair.test.ts test/e2e/opencode-visible-first-restore-flow.test.tsx src/components/TerminalView.tsx server/ws-handler.ts server/terminal-registry.ts
git commit -m "test: prove opencode restore reuse and replacement binding"
```

---

## Chunk 6: Documentation, Verification, And Landing

### File Structure

- Modify: `/home/user/code/freshell/.worktrees/dev/docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md`
  - Record visible-first restore as the chosen architecture and note the race/safety-net constraints.
- Possibly modify: `/home/user/code/freshell/.worktrees/dev/docs/index.html`
  - Only if visible queued restore becomes a user-facing UI mode worth documenting in the mock docs.

### Task 9: Update Research Note

- [ ] **Step 1: Add the decision record**

In the OpenCode section, add:

```md
### 2026-05-18 visible-first restore decision

Freshell now treats stale/dead OpenCode restores as visibility-gated restore intents, not background PTYs. This is required because OpenCode's TUI screen is terminal-rendered and cannot be reconstructed from HTTP metadata if startup terminal frames are missed. A visible-started OpenCode restore carries an immediate attach obligation: if the user switches away before `terminal.created`, Freshell still attaches once so the PTY has a terminal owner from startup.

The core invariant is that durable session identity does not grant runtime ownership. `sessionRef` identifies what to restore; `terminalId` identifies a current PTY; only a current restore-attempt lease tied to `{ sessionRef, createRequestId, terminalId, serverInstanceId }` authorizes replacement. The lease may survive a browser refresh only if the same server instance and live terminal handle are preserved; it is invalidated by server restart or dead-handle repair. The replay-gap replacement path remains only as a constrained stale-restore repair while that lease is active. Any in-memory `replaceableRestoreByTerminalIdRef` map is only an implementation aid for clearing `restoreRuntime`; it is not a separate durable contract.
```

- [ ] **Step 2: Update machine-readable contract**

Add fields under `providers.opencode`:

```json
"hiddenRestorePolicy": "queue_until_visible",
"visibleStartedRestoreAttachObligation": true,
"queuedRestoreStatus": "queued",
"queuedRestoreReason": "visible_owner_required",
"durableSessionIdentityGrantsRuntimeOwnership": false,
"runtimeReplacementAuthority": "restore_attempt_lease",
"replayGapReplacementRequiresRestoreAttemptLease": true,
"restoreAttemptLeaseFields": ["replaceOnViewportReplayGap", "createRequestId", "terminalId", "serverInstanceId"],
"restoreAttemptLeaseSurvivesSameServerRefresh": true,
"restoreAttemptLeaseInvalidatedByServerRestart": true,
"restoredCreateReuseKey": "opencode.sessionRef.sessionId"
```

- [ ] **Step 3: Validate JSON block**

Run:

```bash
node - <<'NODE'
const fs = require('fs')
const path = 'docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md'
const text = fs.readFileSync(path, 'utf8')
const match = text.match(/## Machine-readable contract\n```json\n([\s\S]*?)\n```/)
if (!match) throw new Error('machine-readable contract block not found')
JSON.parse(match[1])
console.log('machine-readable contract JSON OK')
NODE
```

Expected: `machine-readable contract JSON OK`.

- [ ] **Step 4: Run focused verification**

Run:

```bash
npm run typecheck
npm run lint
npm run test:vitest -- test/unit/client/store/panesSlice.test.ts --run
npm run test:vitest -- test/unit/client/store/panesPersistence.test.ts --run
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run
npm run test:vitest -- test/unit/client/components --run -t "queued OpenCode|TabSwitcher|TabItem"
npm run test:vitest -- test/e2e/opencode-startup-probes.test.tsx --run
npm run test:vitest -- test/server/ws-terminal-create-session-repair.test.ts --run -t "opencode"
npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts
```

Expected:

- `npm run typecheck`: exit 0.
- `npm run lint`: exit 0; existing warnings are acceptable only if already present on dev before this branch.
- All focused tests pass.

- [ ] **Step 5: Check broad suite status**

Run:

```bash
npm run test:status
```

If the coordinator is idle and no reusable green baseline is available, run the repo's coordinated check gate:

```bash
FRESHELL_TEST_SUMMARY="visible-first opencode restore" npm run check
```

Expected: typecheck and tests pass, or document pre-existing failures with proof.

- [ ] **Step 6: Commit docs**

```bash
git add docs/lab-notes/2026-05-13-coding-cli-session-restore-research.md docs/index.html
git commit -m "docs: record visible-first opencode restore contract"
```

Only include `docs/index.html` if it changed.

- [ ] **Step 7: Open PR**

Follow the repository branch model. Authored behavior changes start from `origin/main` and the PR targets `origin/main`; do not branch from `/home/user/code/freshell/.worktrees/dev` and do not open a PR with `--base dev`. If this plan depends on an OpenCode resilience prerequisite that is not yet on `origin/main`, pause and either land that prerequisite first or create an explicitly stacked PR against the prerequisite branch with user approval.

```bash
git push -u origin <branch-name>
gh pr create --repo danshapiro/freshell --base main --head <branch-name> --title "Implement visible-first OpenCode restores" --body "<summary and verification>"
```

- [ ] **Step 8: Land on dev without restarting self-hosted server**

After the PR branch is pushed and verified, apply the PR head to `/home/user/code/freshell/.worktrees/dev` as integration-only consumption of the reviewed branch. Do not hide behavior changes in local-only `dev` commits. If applying the PR head needs semantic conflict resolution, stop and fix the PR branch or create a replacement PR.

```bash
cd /home/user/code/freshell/.worktrees/dev
git status --short
git fetch origin <branch-name>
# Apply the fetched PR head using the repo's current dev integration practice.
```

Do not restart the self-hosted dev server unless the user explicitly says `APPROVED`.

---

## Implementation Notes And Guardrails

- Do not implement this as a local `if (hidden) return` hack in `TerminalView`. The queued state must be visible in the pane model.
- Do not start visibility-gated OpenCode restore PTYs unless an immediate visible terminal owner exists.
- Do not generalize this to Codex or Claude Code.
- Do not use redraw nudges, Ctrl-L, delayed resize, or larger replay buffers as restore contracts.
- Preserve the runtime ownership invariant: `sessionRef` is durable identity, not authority to kill or replace a PTY.
- Preserve a restore-attempt lease across browser refresh only when `createRequestId`, `terminalId`, and `serverInstanceId` all still match; strip it on dead-handle repair or server-instance change.
- Do not remove or broaden the replay-gap safety net; it is valid only while the current restore-attempt lease is active.
- Do not test reveal by remounting `TerminalView`; production toggles `hidden` on an already-mounted component.
- Do not confuse server-side same-session reuse with destructive authority; reuse uses canonical `sessionRef`, replacement uses the restore-attempt lease.
- When an OpenCode restore attaches while hidden because it was launched visible, send a real fit+resize on reveal.
- Be explicit in tests about three states: queued restore, creating restore, running attached restore.
- Preserve old sessions in the left pane even when no live terminal exists.
- If a queued pane lacks canonical `sessionRef.provider === "opencode"`, it must not silently start a fresh terminal. Surface a restore-unavailable error path.

# Name Sync And Pane Auto-Naming Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Make pane and tab names derive from one consistent title model so panes auto-name meaningfully, single-pane tab/pane renames mirror each other without duplicate writes, and runtime/session title updates stop depending on brittle ad hoc paths.

**Architecture:** Treat persisted manual names and observed runtime names as separate sources, and compute every displayed pane/tab title through selectors instead of caching derived titles in reducers. Use terminal metadata to carry coding-session titles for CLI panes, keep xterm title changes as pane-scoped runtime titles, and make single-pane tab/pane sync a projection rule enforced by one rename coordinator rather than by scattered symmetric writes.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, Zod, Express, WebSocket, Vitest, Testing Library

---

## Strategy Gate

- The real bug is not “panes need one more rename path.” The bug is split ownership: `tabsSlice`, `panesSlice`, `TerminalView`, `HistoryView`, `TabBar`, the agent API router, and the server layout mirror all write title state independently.
- The direct fix is to stop storing derived display titles as if they were source-of-truth data.
  - Today `paneTitles` mixes user overrides, runtime/session titles, and reducer-seeded fallbacks.
  - Today `tab.title` is both a manual override and a mutable auto-title sink.
- The requested end state lands cleanly if the model is:
  - `tab.title` + `tab.titleSetByUser`: manual tab title only.
  - `panes.paneManualTitles`: manual pane titles only.
  - `panes.paneRuntimeTitles`: observed pane titles only.
  - Display titles: computed selectors, never persisted as client source-of-truth.
- Coding-CLI session titles should not depend on `registry.title` promotion for pane/tab naming.
  - Add `sessionTitle` to terminal metadata and let the client project from it.
  - Keep server-side registry title promotion only as a compatibility path for terminal-directory/overview UX, and fix it to compare against the canonical provider label instead of hard-coded `Claude` / `Codex`.

## Scope Notes

- No `/rename` provider-command queueing or PTY command interception is in scope.
- No new user setting is needed.
- Empty rename submissions stay “cancel”, not “clear title”.
- Manual pane titles win over runtime/session titles, but runtime titles must still be recorded behind the manual override so clearing/manual replacement reveals the latest observed title.
- Explicit rename on a single-pane tab always converges to the pane manual title:
  - Rename pane on single-pane tab: set pane manual title, clear tab manual title.
  - Rename tab on single-pane tab: redirect to pane manual title, clear tab manual title.
- If a formerly multi-pane tab becomes single-pane later, an existing multi-pane tab manual title still wins until the user performs a new explicit rename while single-pane.
- Client persisted pane schema should migrate old mixed title state by preserving only legacy titles that had `paneTitleSetByUser === true`.
- `ui.layout.sync` must keep server/CLI/agent targeting working by mirroring display titles, while also carrying manual title sources for agent-side writes.
- No `docs/index.html` update is required; this is a behavior/model correction, not a major mock/UI expansion.

## Acceptance Mapping

1. New panes auto-name meaningfully without manual intervention.
   - Shell panes prefer checkout/worktree directory context over generic `Shell` when available.
   - CLI panes prefer indexed session title when available, otherwise provider label.
   - Agent-chat panes prefer indexed session title when available, otherwise provider label.
2. Single-pane tab/pane sync is symmetric by projection, not duplicate state writes.
   - Pane rename changes visible tab title on single-pane tabs.
   - Tab rename on single-pane tabs writes pane manual title instead of a second independent tab title.
3. Runtime/session title updates are pane-scoped and automatic.
   - `TerminalView` xterm title updates and history/session renames update pane observed titles.
   - Single-pane tab labels follow automatically through selectors.
   - Multi-pane tab labels remain derived from layout composition, not from arbitrary runtime writes.
4. All rename entry points share one policy.
   - Tab bar inline rename.
   - Pane header inline rename.
   - History/session rename cascade.
   - Agent API `/tabs/:id` and `/panes/:id`.
   - `ui.command` replay paths.
5. Server mirror and tab registry remain targetable by visible titles.

### Task 1: Replace Cached Pane Title State With Manual/Runtime Sources And Selector-Based Display Titles

**Files:**
- Create: `src/store/selectors/titleSelectors.ts`
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/crossTabSync.ts`
- Modify: `src/lib/derivePaneTitle.ts`
- Modify: `src/lib/deriveTabName.ts`
- Modify: `src/lib/tab-title.ts`
- Test: `test/unit/client/store/panesSlice.test.ts`
- Test: `test/unit/client/store/panesPersistence.test.ts`
- Test: `test/unit/client/store/crossTabSync.test.ts`
- Test: `test/unit/client/lib/derivePaneTitle.test.ts`
- Create: `test/unit/client/store/titleSelectors.test.ts`

**Step 1: Write the failing tests**

Add reducer and migration coverage that proves the new state model:

```ts
it('migrates only legacy user-set pane titles into paneManualTitles', () => {
  localStorage.setItem('freshell.panes.v2', JSON.stringify({
    version: 6,
    layouts: {
      'tab-1': {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' },
      },
    },
    activePane: { 'tab-1': 'pane-1' },
    paneTitles: { 'tab-1': { 'pane-1': 'Shell', 'pane-2': 'Ops desk' } },
    paneTitleSetByUser: { 'tab-1': { 'pane-2': true } },
  }))

  const loaded = loadPersistedPanes()
  expect(loaded?.paneManualTitles).toEqual({ 'tab-1': { 'pane-2': 'Ops desk' } })
  expect(loaded?.paneRuntimeTitles).toEqual({})
})

it('does not seed manual titles when a pane is created', () => {
  const next = panesReducer(initialState, initLayout({
    tabId: 'tab-1',
    content: { kind: 'terminal', mode: 'shell' },
  }))

  expect(next.paneManualTitles['tab-1']).toBeUndefined()
  expect(next.paneRuntimeTitles['tab-1']).toBeUndefined()
})

it('keeps runtime title separate from manual title', () => {
  const start = withSingleTerminalPane()
  const withRuntime = panesReducer(start, setPaneRuntimeTitle({
    tabId: 'tab-1',
    paneId: 'pane-1',
    title: 'user@host:~/repo',
  }))
  const withManual = panesReducer(withRuntime, setPaneManualTitle({
    tabId: 'tab-1',
    paneId: 'pane-1',
    title: 'Ops desk',
  }))

  expect(withManual.paneRuntimeTitles['tab-1']['pane-1']).toBe('user@host:~/repo')
  expect(withManual.paneManualTitles['tab-1']['pane-1']).toBe('Ops desk')
})
```

Add selector coverage that proves projection instead of duplicated writes:

```ts
it('projects single-pane tab title from pane display title when tab title is not user-set', () => {
  const state = makeState({
    tabs: [{ id: 'tab-1', title: 'Tab 1', titleSetByUser: false }],
    panes: {
      layouts: singlePane('pane-1', shellPane({ initialCwd: '/repo/worktree' })),
      paneManualTitles: {},
      paneRuntimeTitles: { 'tab-1': { 'pane-1': 'vim README.md' } },
    },
  })

  expect(selectTabDisplayTitle(state, 'tab-1')).toBe('vim README.md')
})

it('falls back to cwd-derived shell title when no runtime or manual title exists', () => {
  const state = makeStateWithShellPane({ initialCwd: '/repo/worktree' })
  expect(selectPaneDisplayTitle(state, 'tab-1', 'pane-1')).toBe('worktree')
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/lib/derivePaneTitle.test.ts test/unit/client/store/titleSelectors.test.ts
```

Expected: FAIL because pane titles are still seeded/cached in reducers, `paneRuntimeTitles` does not exist, and tab/pane display is not selector-driven.

**Step 3: Write the minimal implementation**

Change pane state to explicit manual/runtime sources:

```ts
export interface PanesState {
  layouts: Record<string, PaneNode>
  activePane: Record<string, string>
  paneManualTitles: Record<string, Record<string, string>>
  paneRuntimeTitles: Record<string, Record<string, string>>
  renameRequestTabId: string | null
  renameRequestPaneId: string | null
  zoomedPane: Record<string, string | undefined>
  refreshRequestsByPane: Record<string, Record<string, PaneRefreshRequest>>
}
```

Migrate legacy persisted panes by filtering old mixed `paneTitles` through `paneTitleSetByUser` and discarding derived/runtime cache entries:

```ts
const paneManualTitles = Object.fromEntries(
  Object.entries(parsed.paneTitles || {}).flatMap(([tabId, titles]) => {
    const filtered = Object.fromEntries(
      Object.entries(titles).filter(([paneId]) => parsed.paneTitleSetByUser?.[tabId]?.[paneId]),
    )
    return Object.keys(filtered).length > 0 ? [[tabId, filtered]] : []
  }),
)
```

Add pure display selectors:

```ts
export const selectPaneDisplayTitle = (
  state: RootState,
  tabId: string,
  paneId: string,
): string => {
  const manual = state.panes.paneManualTitles[tabId]?.[paneId]
  if (manual) return manual

  const runtime = state.panes.paneRuntimeTitles[tabId]?.[paneId]
  if (runtime) return runtime

  const leaf = selectPaneLeaf(state, tabId, paneId)
  return leaf ? derivePaneTitle(leaf.content, {
    terminalMeta: selectTerminalMetaForPane(state, tabId, paneId),
    indexedSession: selectIndexedSessionForPane(state, tabId, paneId),
    extensions: state.extensions.entries,
  }) : 'Pane'
}

export const selectTabDisplayTitle = (state: RootState, tabId: string): string => {
  const tab = state.tabs.tabs.find((item) => item.id === tabId)
  if (!tab) return 'Tab'
  if (tab.titleSetByUser && tab.title.trim()) return tab.title

  const layout = state.panes.layouts[tabId]
  if (!layout) return tab.title || 'Tab'
  if (layout.type === 'leaf') return selectPaneDisplayTitle(state, tabId, layout.id)
  return deriveTabName(layout, {
    terminalMetaById: state.terminalMeta.byTerminalId,
    extensions: state.extensions.entries,
  })
}
```

Stop seeding derived titles in `panesSlice`; only maintain manual/runtime entries when explicitly set or cleared.

**Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/lib/derivePaneTitle.test.ts test/unit/client/store/titleSelectors.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/selectors/titleSelectors.ts src/store/paneTypes.ts src/store/panesSlice.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/store/crossTabSync.ts src/lib/derivePaneTitle.ts src/lib/deriveTabName.ts src/lib/tab-title.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/lib/derivePaneTitle.test.ts test/unit/client/store/titleSelectors.test.ts
git commit -m "refactor: separate pane manual and runtime titles"
```

### Task 2: Route Every Rename Path Through One Coordinator And Make Single-Pane Sync A Projection Rule

**Files:**
- Create: `src/store/titleCoordinator.ts`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/lib/ui-commands.ts`
- Modify: `src/store/paneTitleSync.ts`
- Modify: `src/store/layoutMirrorMiddleware.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `server/agent-api/layout-schema.ts`
- Modify: `server/agent-api/layout-store.ts`
- Modify: `server/agent-api/target-resolver.ts`
- Modify: `server/agent-api/router.ts`
- Test: `test/unit/client/store/tab-pane-title-sync.test.ts`
- Test: `test/unit/client/components/TabBar.test.tsx`
- Test: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Test: `test/unit/client/layout-mirror-middleware.test.ts`
- Test: `test/unit/server/agent-layout-schema.test.ts`
- Test: `test/unit/server/agent-layout-store.test.ts`
- Test: `test/unit/server/agent-target-resolver.test.ts`
- Test: `test/server/agent-tabs-write.test.ts`
- Test: `test/server/agent-panes-write.test.ts`

**Step 1: Write the failing tests**

Replace the old explicit-write expectations with coordinator/projection expectations:

```ts
it('renaming the only pane clears tab manual title and updates visible tab title by projection', async () => {
  const store = createStore(singlePaneTabState({
    tabTitle: 'Backlog',
    tabTitleSetByUser: true,
    paneRuntimeTitle: 'claude',
  }))

  await store.dispatch(commitPaneRename({ tabId: 'tab-1', paneId: 'pane-1', title: 'Issue 166 work' }))

  expect(store.getState().tabs.tabs[0].titleSetByUser).toBe(false)
  expect(selectTabDisplayTitle(store.getState() as RootState, 'tab-1')).toBe('Issue 166 work')
})

it('renaming a single-pane tab redirects to pane manual title instead of storing an independent tab title', async () => {
  const store = createStore(singlePaneTabState())

  await store.dispatch(commitTabRename({ tabId: 'tab-1', title: 'Docs' }))

  expect(store.getState().panes.paneManualTitles['tab-1']).toEqual({ 'pane-1': 'Docs' })
  expect(store.getState().tabs.tabs[0].titleSetByUser).toBe(false)
})

it('keeps multi-pane tab and pane titles independent', async () => {
  const store = createStore(splitTabState())

  await store.dispatch(commitPaneRename({ tabId: 'tab-1', paneId: 'pane-a', title: 'Logs' }))

  expect(store.getState().tabs.tabs[0].title).toBe('Release board')
  expect(selectTabDisplayTitle(store.getState() as RootState, 'tab-1')).toBe('Release board')
})
```

Add server/API coverage:

```ts
it('PATCH /api/tabs/:id renames the only pane instead of calling renameTab', async () => {
  const renamePane = vi.fn(() => ({ tabId: 'tab-1', paneId: 'pane-1' }))
  const renameTab = vi.fn()
  const listPanes = vi.fn(() => [{ paneId: 'pane-1' }])

  // expect router to call renamePane, not renameTab
})

it('ui.layout.sync mirrors display titles plus manual title sources', () => {
  expect(sentPayload.tabs[0]).toMatchObject({
    id: 'tab-1',
    title: 'Issue 166 work',
    manualTitle: undefined,
  })
  expect(sentPayload.paneTitles['tab-1']['pane-1']).toBe('Issue 166 work')
  expect(sentPayload.paneManualTitles['tab-1']['pane-1']).toBe('Issue 166 work')
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/components/TabBar.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/layout-mirror-middleware.test.ts test/unit/server/agent-layout-schema.test.ts test/unit/server/agent-layout-store.test.ts test/unit/server/agent-target-resolver.test.ts test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts
```

Expected: FAIL because rename semantics are still split across reducers/components/router paths, `ui.layout.sync` does not expose manual title sources, and the server router still calls `renameTab()` directly on single-pane tabs.

**Step 3: Write the minimal implementation**

Create a coordinator that is the only place allowed to apply rename policy:

```ts
export const commitPaneRename = createAsyncThunk(
  'titles/commitPaneRename',
  async ({ tabId, paneId, title }: { tabId: string; paneId: string; title: string }, { dispatch, getState }) => {
    dispatch(setPaneManualTitle({ tabId, paneId, title }))

    const layout = (getState() as RootState).panes.layouts[tabId]
    if (layout?.type === 'leaf' && layout.id === paneId) {
      dispatch(updateTab({ id: tabId, updates: { titleSetByUser: false, title: '' } }))
    }
  },
)

export const commitTabRename = createAsyncThunk(
  'titles/commitTabRename',
  async ({ tabId, title }: { tabId: string; title: string }, { dispatch, getState }) => {
    const layout = (getState() as RootState).panes.layouts[tabId]
    if (layout?.type === 'leaf') {
      await dispatch(commitPaneRename({ tabId, paneId: layout.id, title }))
      return { redirectedToPane: true }
    }

    dispatch(updateTab({ id: tabId, updates: { title, titleSetByUser: true } }))
    return { redirectedToPane: false }
  },
)
```

Update every rename ingress to use the coordinator:

- `TabBar` inline rename:
  - call `PATCH /api/panes/:paneId` for single-pane tabs.
  - call `PATCH /api/tabs/:tabId` only for multi-pane tabs.
  - on success dispatch the matching coordinator action instead of `updateTab()`.
- `PaneContainer` inline rename:
  - dispatch `commitPaneRename()` on success instead of directly mutating both pane and tab.
- `HistoryView`:
  - replace `syncPaneTitleByTerminalId()` with an observed-title action that never writes manual titles.
- `ui.command`:
  - `tab.rename` applies manual tab rename only.
  - `pane.rename` applies manual pane rename only.
- Agent API router:
  - `PATCH /tabs/:id` inspects pane count and redirects to pane rename semantics for single-pane tabs.
  - `PATCH /panes/:id` no longer calls `renameTab()` just to mirror a single-pane tab; visible tab title changes via projection.

Mirror display titles and manual title sources separately:

```ts
const payload = {
  type: 'ui.layout.sync',
  tabs: state.tabs.tabs.map((tab) => ({
    id: tab.id,
    title: selectTabDisplayTitle(state, tab.id),
    ...(tab.titleSetByUser && tab.title.trim() ? { manualTitle: tab.title } : {}),
    ...(fallbackSessionRef ? { fallbackSessionRef } : {}),
  })),
  activeTabId: state.tabs.activeTabId,
  layouts: state.panes.layouts,
  activePane: state.panes.activePane,
  paneTitles: selectPaneDisplayTitlesByTab(state),
  paneManualTitles: state.panes.paneManualTitles,
}
```

**Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/components/TabBar.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/layout-mirror-middleware.test.ts test/unit/server/agent-layout-schema.test.ts test/unit/server/agent-layout-store.test.ts test/unit/server/agent-target-resolver.test.ts test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/titleCoordinator.ts src/components/TabBar.tsx src/components/panes/PaneContainer.tsx src/components/HistoryView.tsx src/lib/ui-commands.ts src/store/paneTitleSync.ts src/store/layoutMirrorMiddleware.ts shared/ws-protocol.ts server/agent-api/layout-schema.ts server/agent-api/layout-store.ts server/agent-api/target-resolver.ts server/agent-api/router.ts test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/components/TabBar.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/layout-mirror-middleware.test.ts test/unit/server/agent-layout-schema.test.ts test/unit/server/agent-layout-store.test.ts test/unit/server/agent-target-resolver.test.ts test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts
git commit -m "refactor: centralize pane and tab rename policy"
```

### Task 3: Feed Meaningful Runtime And Session Titles Into The Projection

**Files:**
- Modify: `server/terminal-metadata-service.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `src/store/terminalMetaSlice.ts`
- Modify: `server/index.ts`
- Modify: `server/spawn-spec.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/store/selectors/titleSelectors.ts`
- Modify: `src/lib/derivePaneTitle.ts`
- Test: `test/unit/server/terminal-metadata-service.test.ts`
- Test: `test/server/session-association.test.ts`
- Test: `test/unit/client/store/terminalMetaSlice.test.ts`
- Test: `test/unit/client/components/TerminalView.test.ts`
- Test: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Test: `test/unit/client/components/TabBar.deriveTitle.test.tsx`

**Step 1: Write the failing tests**

Add server metadata coverage:

```ts
it('stores sessionTitle in terminal metadata when session metadata is applied', async () => {
  await service.seedFromTerminal({ terminalId: 'term-1', mode: 'codex', cwd: '/repo' })
  const next = await service.applySessionMetadata('term-1', {
    provider: 'codex',
    sessionId: 'session-1',
    projectPath: '/repo',
    cwd: '/repo',
    updatedAt: 1,
    title: 'Fix name sync',
  })

  expect(next?.sessionTitle).toBe('Fix name sync')
})
```

Add client behavior coverage:

```ts
it('shows sessionTitle from terminal metadata for a CLI pane without mutating tab.title', () => {
  const state = makeState({
    tabs: [{ id: 'tab-1', title: 'Tab 1', titleSetByUser: false }],
    panes: singleCliPane('tab-1', 'pane-1', 'term-1', 'codex'),
    terminalMeta: {
      byTerminalId: {
        'term-1': { terminalId: 'term-1', provider: 'codex', sessionId: 'session-1', sessionTitle: 'Fix name sync', updatedAt: 1 },
      },
    },
  })

  expect(selectPaneDisplayTitle(state, 'tab-1', 'pane-1')).toBe('Fix name sync')
  expect(selectTabDisplayTitle(state, 'tab-1')).toBe('Fix name sync')
  expect(state.tabs.tabs[0].title).toBe('Tab 1')
})

it('writes xterm title changes to paneRuntimeTitles and not to tab.title', () => {
  const state = reduceTerminalTitleChange(makeTerminalState(), 'vim README.md')
  expect(state.panes.paneRuntimeTitles['tab-1']['pane-1']).toBe('vim README.md')
  expect(state.tabs.tabs[0].title).toBe('Tab 1')
})

it('appends exit code to pane runtime title so single-pane tabs still surface exit state', () => {
  const state = reduceTerminalExit(makeTerminalState(), 1)
  expect(selectPaneDisplayTitle(state as any, 'tab-1', 'pane-1')).toBe('Shell (exit 1)')
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-metadata-service.test.ts test/server/session-association.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/TerminalView.test.ts test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabBar.deriveTitle.test.tsx
```

Expected: FAIL because terminal metadata has no `sessionTitle`, `TerminalView` still mutates tab titles directly, shell panes still fall back to generic `Shell`, and the server promotion path is still tied to hard-coded default labels.

**Step 3: Write the minimal implementation**

Extend terminal metadata:

```ts
export type TerminalMeta = {
  terminalId: string
  cwd?: string
  checkoutRoot?: string
  repoRoot?: string
  displaySubdir?: string
  branch?: string
  isDirty?: boolean
  provider?: TerminalProvider
  sessionId?: string
  sessionTitle?: string
  tokenUsage?: TokenSummary
  updatedAt: number
}
```

Populate it from indexed sessions:

```ts
const next = await this.enrichFromCwd({
  ...current,
  provider: session.provider,
  sessionId: session.sessionId,
  sessionTitle: session.title ?? current.sessionTitle,
  cwd: resolvedCwd,
  branch: session.gitBranch ?? current.branch,
  isDirty: session.isDirty ?? current.isDirty,
  tokenUsage: session.tokenUsage ?? current.tokenUsage,
})
```

Use selector precedence for terminal panes:

```ts
const terminalMetaTitle =
  content.kind === 'terminal' ? terminalMetaById[content.terminalId ?? '']?.sessionTitle : undefined

return manualTitle
  ?? runtimeTitle
  ?? terminalMetaTitle
  ?? derivePaneTitle(content, { terminalMeta, indexedSession, extensions })
```

Stop `TerminalView` from mutating tab titles on runtime events:

```ts
dispatch(setPaneRuntimeTitle({ tabId, paneId: paneIdRef.current, title: cleanTitle }))
```

For exit handling, write a pane runtime title derived from the current non-manual display title plus the exit suffix.

Keep registry-title promotion only as a compatibility path for terminal directory / overview, and fix it to compare against the canonical provider label:

```ts
import { getModeLabel } from './spawn-spec.js'

const defaultTitle = getModeLabel(session.provider)
if (term.title === defaultTitle) {
  registry.updateTitle(term.terminalId, session.title)
  wsHandler.broadcast({ type: 'terminal.title.updated', terminalId: term.terminalId, title: session.title })
}
```

**Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/server/terminal-metadata-service.test.ts test/server/session-association.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/TerminalView.test.ts test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabBar.deriveTitle.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-metadata-service.ts shared/ws-protocol.ts src/store/terminalMetaSlice.ts server/index.ts server/spawn-spec.ts src/components/TerminalView.tsx src/store/selectors/titleSelectors.ts src/lib/derivePaneTitle.ts test/unit/server/terminal-metadata-service.test.ts test/server/session-association.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/TerminalView.test.ts test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabBar.deriveTitle.test.tsx
git commit -m "feat: drive pane auto-titles from runtime and session metadata"
```

### Task 4: Update Remaining Title Consumers, Add E2E Coverage, And Verify The Whole Cutover

**Files:**
- Modify: `src/store/tabRegistrySync.ts`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/store/selectors/tabsRegistrySelectors.ts`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/components/Sidebar.tsx`
- Test: `test/unit/client/store/tabRegistrySync.test.ts`
- Test: `test/unit/client/lib/tab-registry-snapshot.test.ts`
- Test: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Test: `test/unit/client/components/TabsView.test.tsx`
- Create: `test/e2e/tab-pane-name-sync.test.tsx`
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`

**Step 1: Write the failing tests**

Add end-to-end application coverage that exercises the actual user-visible contract:

```ts
it('auto-names a new shell pane from cwd and mirrors single-pane rename into the tab label', async () => {
  const { store, user } = renderAppWithSingleShellPane({ initialCwd: '/repo/worktree' })

  expect(screen.getByText('worktree')).toBeInTheDocument()

  await renamePaneHeader(user, 'Main shell')

  expect(screen.getByRole('tab', { name: 'Main shell' })).toBeInTheDocument()
  expect(store.getState().tabs.tabs[0].titleSetByUser).toBe(false)
  expect(store.getState().panes.paneManualTitles['tab-1']['pane-1']).toBe('Main shell')
})

it('uses session title from terminal metadata for CLI panes and keeps manual titles independent in multi-pane tabs', async () => {
  const { store } = renderAppWithSplitTab({
    terminalMeta: {
      'term-1': { terminalId: 'term-1', provider: 'codex', sessionId: 'session-1', sessionTitle: 'Fix name sync', updatedAt: 1 },
    },
  })

  expect(screen.getByText('Fix name sync')).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Release board' })).toBeInTheDocument()
  expect(selectTabDisplayTitle(store.getState() as RootState, 'tab-1')).toBe('Release board')
})

it('history rename updates pane and single-pane tab display through observed title state', async () => {
  // Rename session from HistoryView; expect pane display + tab display to update without creating pane manual title.
})
```

Add projection consumer coverage:

```ts
it('tab registry snapshots store display tab and pane titles, not stale manual placeholders', () => {
  const record = buildOpenTabRegistryRecord({
    tabDisplayTitle: 'Fix name sync',
    paneDisplayTitles: { 'pane-1': 'Fix name sync' },
    // ...
  })

  expect(record.tabName).toBe('Fix name sync')
  expect(record.panes[0].title).toBe('Fix name sync')
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/store/tabRegistrySync.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/components/TabsView.test.tsx test/e2e/tab-pane-name-sync.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected: FAIL because registry/sidebar/tabs-view consumers still read raw stored titles, and there is no app-level regression suite for the new name-sync contract.

**Step 3: Write the minimal implementation**

Switch consumer code from stored titles to display projections:

```ts
const tabDisplayTitle = selectTabDisplayTitle(state, tab.id)
const paneDisplayTitles = selectPaneDisplayTitlesForTab(state, tab.id)
```

Use those values when building:

- tab registry snapshots
- sidebar fallback session labels
- `TabsView` tab/pane lists
- any app-level tab/pane title comparisons that currently read raw `tab.title` or raw pane title maps

Do not resurrect reducer-side title writes to satisfy a consumer. Fix the consumer to use the selector.

**Step 4: Run the focused tests and then the full verification stack**

Run:

```bash
npm run test:vitest -- test/unit/client/store/tabRegistrySync.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/components/TabsView.test.tsx test/e2e/tab-pane-name-sync.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
npm run lint
npm run typecheck
FRESHELL_TEST_SUMMARY="name sync auto-naming cutover" npm test
```

Expected:

- Focused Vitest set: PASS
- `npm run lint`: PASS
- `npm run typecheck`: PASS
- `npm test`: PASS

**Step 5: Commit**

```bash
git add src/store/tabRegistrySync.ts src/lib/tab-registry-snapshot.ts src/store/selectors/sidebarSelectors.ts src/store/selectors/tabsRegistrySelectors.ts src/components/TabsView.tsx src/components/Sidebar.tsx test/unit/client/store/tabRegistrySync.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/components/TabsView.test.tsx test/e2e/tab-pane-name-sync.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
git commit -m "test: cover name sync and auto-naming end to end"
```

## Final Notes For Execution

- Keep the cutover atomic. Do not leave a hybrid state where some consumers read raw stored titles and others read selectors.
- Delete or fully repurpose the old `paneTitleSetByUser` behavior in the same change that introduces `paneManualTitles`; leaving both active recreates the exact ambiguity this plan is fixing.
- Do not preserve the old `syncPaneTitleByTerminalId` semantics. History/session rename must become an observed-title update, not a hidden manual rename.
- When a failing test reveals another direct `updateTab({ title: ... })` or reducer-seeded pane title path, remove it and route the caller through the selector/coordinator model rather than patching around it.

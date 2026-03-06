# Refresh Tab And Refresh Pane Context Menus Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Add `Refresh Tab` and `Refresh Pane` to the existing right-click context menus so browser panes reload or recover in place and terminal panes re-establish their frontend connection to the existing pane session, including tabs that are currently zoomed.

**Architecture:** Make refresh state-driven but one-shot. Store at most one pending refresh request per pane in `panesSlice`, keyed by a unique `requestId` plus a target snapshot derived from the pane’s current content; menus dispatch those requests from the stored layout tree, and panes explicitly consume or clear them so refresh never replays across later remounts. Browser panes must preserve the current live-document reload path when an iframe exists and only fall back to state-reset recovery when the pane is already on an error screen; terminal refresh must be folded into the existing attach lifecycle so a mount with a pending request performs exactly one detach/attach sequence instead of racing the normal mount attach.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, xterm.js, Vitest, Testing Library

---

## Scope Notes

- `Refresh Pane` belongs on the pane chrome context menu (`ContextIds.Pane`), not the inner terminal/browser/editor content menus.
- `Refresh Tab` must iterate the entire stored tab layout tree, not just currently mounted leaves.
- `PaneLayout` renders only the zoomed leaf when a tab is zoomed (`src/components/panes/PaneLayout.tsx:66-72`), so menu enablement and request creation must come from stored layout state, not mounted-pane registries.
- Refresh requests must be ephemeral UI/runtime state like `renameRequest*` and `zoomedPane`, not persisted to localStorage.
- Refresh must be a one-shot consume/ack flow. A request may stay pending while a pane is unmounted, but once a pane claims it, the request must be removed from Redux so later remounts do not replay it.
- Pane IDs are reused across replacement/content changes, so each refresh request needs a target snapshot and the slice must clear stale requests when pane content changes enough that the request no longer applies.
- Refreshable pane kinds for this issue:
  - `terminal`
  - `browser`
- Non-refreshable pane kinds for now:
  - `editor`
  - `picker`
  - `agent-chat`
  - `extension`
- Browser refresh must preserve the existing `iframe.contentWindow?.location.reload()` behavior when an iframe exists. Recreating the iframe from the stored Redux URL is only the recovery path when the iframe is missing because the pane is on an error screen.
- Terminal refresh must not add a second attach path on mount. A pre-existing pending refresh request on mount must replace the normal mount attach, not run before it.
- No server-side protocol changes are needed.
- No `docs/index.html` update is required; this is not a major UI mock change.

### Task 1: Add Shared Pane Refresh Helpers

**Files:**
- Modify: `src/lib/pane-utils.ts`
- Test: `test/unit/client/lib/pane-utils.test.ts`

**Step 1: Write the failing test**

Extend `test/unit/client/lib/pane-utils.test.ts` with helpers that the slice and panes can share:

```ts
import {
  buildPaneRefreshTarget,
  collectPaneLeaves,
  isRefreshablePaneContent,
  paneRefreshTargetMatchesContent,
} from '@/lib/pane-utils'

describe('collectPaneLeaves', () => {
  it('returns leaf ids in tree order', () => {
    const tree = split([
      split([leaf('p1', shellContent), leaf('p2', browserContent)]),
      leaf('p3', editorContent),
    ])

    expect(collectPaneLeaves(tree).map((leaf) => leaf.id)).toEqual(['p1', 'p2', 'p3'])
  })
})

describe('buildPaneRefreshTarget', () => {
  it('returns a terminal target keyed by createRequestId', () => {
    expect(buildPaneRefreshTarget({
      kind: 'terminal',
      mode: 'shell',
      createRequestId: 'req-1',
      status: 'running',
    })).toEqual({ kind: 'terminal', createRequestId: 'req-1' })
  })

  it('returns a browser target for browser panes', () => {
    expect(buildPaneRefreshTarget(browserContent)).toEqual({ kind: 'browser' })
  })

  it('returns null for non-refreshable panes', () => {
    expect(buildPaneRefreshTarget(editorContent)).toBeNull()
  })
})

describe('paneRefreshTargetMatchesContent', () => {
  it('matches a terminal target only when createRequestId still matches', () => {
    expect(
      paneRefreshTargetMatchesContent(
        { kind: 'terminal', createRequestId: 'req-1' },
        { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', status: 'running' },
      ),
    ).toBe(true)

    expect(
      paneRefreshTargetMatchesContent(
        { kind: 'terminal', createRequestId: 'req-1' },
        { kind: 'terminal', mode: 'shell', createRequestId: 'req-2', status: 'running' },
      ),
    ).toBe(false)
  })

  it('matches browser targets only for browser content', () => {
    expect(paneRefreshTargetMatchesContent({ kind: 'browser' }, browserContent)).toBe(true)
    expect(paneRefreshTargetMatchesContent({ kind: 'browser' }, editorContent)).toBe(false)
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/lib/pane-utils.test.ts
```

Expected: FAIL because the refresh-target helpers are not exported yet.

**Step 3: Write minimal implementation**

Update `src/lib/pane-utils.ts`:

```ts
import type { PaneContent, PaneNode, PaneRefreshTarget } from '@/store/paneTypes'

export function collectPaneLeaves(node: PaneNode): Array<Extract<PaneNode, { type: 'leaf' }>> {
  if (node.type === 'leaf') return [node]
  return [...collectPaneLeaves(node.children[0]), ...collectPaneLeaves(node.children[1])]
}

export function isRefreshablePaneContent(content: PaneContent): boolean {
  return content.kind === 'terminal' || content.kind === 'browser'
}

export function buildPaneRefreshTarget(content: PaneContent): PaneRefreshTarget | null {
  if (content.kind === 'terminal') {
    return { kind: 'terminal', createRequestId: content.createRequestId }
  }
  if (content.kind === 'browser') {
    return { kind: 'browser' }
  }
  return null
}

export function paneRefreshTargetMatchesContent(
  target: PaneRefreshTarget,
  content: PaneContent | null | undefined,
): boolean {
  if (!content) return false
  if (target.kind === 'terminal') {
    return content.kind === 'terminal' && content.createRequestId === target.createRequestId
  }
  return content.kind === 'browser'
}
```

Keep the existing non-refresh helpers in place.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/lib/pane-utils.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/pane-utils.ts test/unit/client/lib/pane-utils.test.ts
git commit -m "test(panes): add pane refresh target helpers"
```

### Task 2: Add One-Shot Pane Refresh Requests To `panesSlice`

**Files:**
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/persistMiddleware.ts`
- Test: `test/unit/client/store/panesSlice.test.ts`
- Test: `test/unit/client/store/panesPersistence.test.ts`

**Step 1: Write the failing tests**

Add reducer coverage to `test/unit/client/store/panesSlice.test.ts`:

```ts
import {
  consumePaneRefreshRequest,
  requestPaneRefresh,
  requestTabRefresh,
  replacePane,
  updatePaneContent,
} from '../../../../src/store/panesSlice'

describe('requestPaneRefresh', () => {
  it('stores a one-shot terminal refresh request keyed by createRequestId', () => {
    const state = panesReducer(
      stateWithLeaf('pane-term', {
        kind: 'terminal',
        mode: 'shell',
        createRequestId: 'req-1',
        status: 'running',
      }),
      requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-term' }),
    )

    expect(state.refreshRequestsByPane['tab-1']['pane-term']).toMatchObject({
      requestId: expect.any(String),
      target: { kind: 'terminal', createRequestId: 'req-1' },
    })
  })

  it('does not create refresh state for unsupported panes', () => {
    const state = panesReducer(
      stateWithLeaf('pane-editor', editorContent),
      requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-editor' }),
    )

    expect(state.refreshRequestsByPane['tab-1']).toBeUndefined()
  })
})

describe('requestTabRefresh', () => {
  it('stores requests for every refreshable leaf in a zoomed layout tree', () => {
    const state = panesReducer(
      stateWithLayoutAndZoom({
        layout: split([
          leaf('pane-editor', editorContent),
          split([
            leaf('pane-term', {
              kind: 'terminal',
              mode: 'shell',
              createRequestId: 'req-term',
              status: 'running',
            }),
            leaf('pane-browser', browserContent),
          ]),
        ]),
        zoomedPaneId: 'pane-editor',
      }),
      requestTabRefresh({ tabId: 'tab-1' }),
    )

    expect(Object.keys(state.refreshRequestsByPane['tab-1']).sort()).toEqual(['pane-browser', 'pane-term'])
    expect(state.refreshRequestsByPane['tab-1']['pane-term'].target).toEqual({
      kind: 'terminal',
      createRequestId: 'req-term',
    })
    expect(state.refreshRequestsByPane['tab-1']['pane-browser'].target).toEqual({ kind: 'browser' })
  })
})

describe('consumePaneRefreshRequest', () => {
  it('removes the matching request and ignores stale requestIds', () => {
    const start = panesReducer(
      stateWithLeaf('pane-browser', browserContent),
      requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-browser' }),
    )

    const requestId = start.refreshRequestsByPane['tab-1']['pane-browser'].requestId

    const ignored = panesReducer(
      start,
      consumePaneRefreshRequest({ tabId: 'tab-1', paneId: 'pane-browser', requestId: 'wrong-id' }),
    )
    expect(ignored.refreshRequestsByPane['tab-1']['pane-browser'].requestId).toBe(requestId)

    const consumed = panesReducer(
      start,
      consumePaneRefreshRequest({ tabId: 'tab-1', paneId: 'pane-browser', requestId }),
    )
    expect(consumed.refreshRequestsByPane['tab-1']?.['pane-browser']).toBeUndefined()
  })
})

describe('refresh request reconciliation', () => {
  it('clears a pending terminal request when the pane gets a new createRequestId', () => {
    const requested = panesReducer(
      stateWithLeaf('pane-term', {
        kind: 'terminal',
        mode: 'shell',
        createRequestId: 'req-1',
        status: 'running',
      }),
      requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-term' }),
    )

    const next = panesReducer(
      requested,
      updatePaneContent({
        tabId: 'tab-1',
        paneId: 'pane-term',
        content: {
          kind: 'terminal',
          mode: 'shell',
          createRequestId: 'req-2',
          status: 'running',
        },
      }),
    )

    expect(next.refreshRequestsByPane['tab-1']?.['pane-term']).toBeUndefined()
  })

  it('clears a pending browser request when the pane is replaced', () => {
    const requested = panesReducer(
      stateWithLeaf('pane-browser', browserContent),
      requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-browser' }),
    )

    const next = panesReducer(
      requested,
      replacePane({ tabId: 'tab-1', paneId: 'pane-browser' }),
    )

    expect(next.refreshRequestsByPane['tab-1']?.['pane-browser']).toBeUndefined()
  })
})
```

Add a persistence test to `test/unit/client/store/panesPersistence.test.ts`:

```ts
it('does not persist refreshRequestsByPane', () => {
  const store = configureStore({
    reducer: { tabs: tabsReducer, panes: panesReducer },
    middleware: (getDefault) => getDefault().concat(persistMiddleware as any),
  })

  store.dispatch(addTab({ mode: 'shell' }))
  const tabId = store.getState().tabs.tabs[0].id
  store.dispatch(initLayout({
    tabId,
    paneId: 'pane-1',
    content: {
      kind: 'terminal',
      mode: 'shell',
      createRequestId: 'req-1',
      status: 'running',
    },
  }))
  store.dispatch(requestPaneRefresh({ tabId, paneId: 'pane-1' }))

  vi.runAllTimers()
  const saved = JSON.parse(localStorage.getItem('freshell.panes.v2')!)
  expect(saved.refreshRequestsByPane).toBeUndefined()
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:client -- test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts
```

Expected: FAIL because the slice does not yet model one-shot refresh requests.

**Step 3: Write minimal implementation**

First extend `src/store/paneTypes.ts`:

```ts
export type PaneRefreshTarget =
  | { kind: 'terminal'; createRequestId: string }
  | { kind: 'browser' }

export interface PaneRefreshRequest {
  requestId: string
  target: PaneRefreshTarget
}

export interface PanesState {
  // existing fields...
  /**
   * Ephemeral one-shot refresh requests keyed by tab and pane.
   * Requests stay pending while a pane is unmounted, then must be consumed
   * or cleared exactly once.
   */
  refreshRequestsByPane: Record<string, Record<string, PaneRefreshRequest>>
}
```

Initialize `refreshRequestsByPane` everywhere the slice creates `PanesState`.

In `src/store/panesSlice.ts`, add reducers:

```ts
requestPaneRefresh: (
  state,
  action: PayloadAction<{ tabId: string; paneId: string }>
) => {
  const { tabId, paneId } = action.payload
  const content = findLeaf(state.layouts[tabId], paneId)?.content
  const target = content ? buildPaneRefreshTarget(content) : null
  if (!target) return

  if (!state.refreshRequestsByPane[tabId]) state.refreshRequestsByPane[tabId] = {}
  state.refreshRequestsByPane[tabId][paneId] = {
    requestId: nanoid(),
    target,
  }
},

requestTabRefresh: (
  state,
  action: PayloadAction<{ tabId: string }>
) => {
  const { tabId } = action.payload
  const layout = state.layouts[tabId]
  if (!layout) return

  if (!state.refreshRequestsByPane[tabId]) state.refreshRequestsByPane[tabId] = {}
  for (const leaf of collectPaneLeaves(layout)) {
    const target = buildPaneRefreshTarget(leaf.content)
    if (!target) continue
    state.refreshRequestsByPane[tabId][leaf.id] = {
      requestId: nanoid(),
      target,
    }
  }
},

consumePaneRefreshRequest: (
  state,
  action: PayloadAction<{ tabId: string; paneId: string; requestId: string }>
) => {
  const { tabId, paneId, requestId } = action.payload
  const request = state.refreshRequestsByPane[tabId]?.[paneId]
  if (!request || request.requestId !== requestId) return
  delete state.refreshRequestsByPane[tabId][paneId]
  if (Object.keys(state.refreshRequestsByPane[tabId]).length === 0) {
    delete state.refreshRequestsByPane[tabId]
  }
},
```

Add a small slice-local helper to reconcile stale requests whenever pane content mutates:

```ts
function reconcilePaneRefreshRequest(
  state: PanesState,
  tabId: string,
  paneId: string,
  nextContent: PaneContent | null | undefined,
) {
  const request = state.refreshRequestsByPane[tabId]?.[paneId]
  if (!request) return
  if (paneRefreshTargetMatchesContent(request.target, nextContent)) return

  delete state.refreshRequestsByPane[tabId][paneId]
  if (Object.keys(state.refreshRequestsByPane[tabId]).length === 0) {
    delete state.refreshRequestsByPane[tabId]
  }
}
```

Call that helper from reducers that can invalidate a pending request:

- `updatePaneContent`
- `mergePaneContent`
- `replacePane`
- `closePane`
- `removeLayout`
- orphan-layout cleanup during initial state load

For `updatePaneContent` and `mergePaneContent`, reconcile after computing the new content. For `replacePane`, `closePane`, and `removeLayout`, delete the request outright because the old pane content is gone.

Then update `src/store/persistMiddleware.ts` to strip the new ephemeral field:

```ts
const {
  renameRequestTabId: _rrt,
  renameRequestPaneId: _rrp,
  zoomedPane: _zp,
  refreshRequestsByPane: _rrbp,
  ...persistablePanes
} = state.panes
```

**Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:client -- test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/paneTypes.ts src/store/panesSlice.ts src/store/persistMiddleware.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts
git commit -m "feat(panes): add one-shot pane refresh requests"
```

### Task 3: Add Layout-Based Refresh Menu Items In `menu-defs`

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `test/unit/client/components/context-menu/menu-defs.test.ts`

**Step 1: Write the failing tests**

Extend `test/unit/client/components/context-menu/menu-defs.test.ts`:

```ts
it('enables Refresh tab when the stored layout has refreshable leaves even if only non-refreshable panes are mounted', () => {
  const actions = createMockActions()
  const ctx = {
    ...createMockContext(actions),
    paneLayouts: {
      tab1: {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane-editor', content: editorContent },
          { type: 'leaf', id: 'pane-browser', content: browserContent },
        ],
      },
    },
  }

  const items = buildMenuItems({ kind: 'tab', tabId: 'tab1' }, ctx)
  const refreshItem = items.find((item) => item.type === 'item' && item.id === 'refresh-tab')

  expect(refreshItem?.type).toBe('item')
  expect(refreshItem?.type === 'item' ? refreshItem.disabled : true).toBe(false)
})

it('disables Refresh tab when no leaf in the layout is refreshable', () => {
  const actions = createMockActions()
  const ctx = {
    ...createMockContext(actions),
    paneLayouts: {
      tab1: { type: 'leaf', id: 'pane-editor', content: editorContent },
    },
  }

  const items = buildMenuItems({ kind: 'tab', tabId: 'tab1' }, ctx)
  const refreshItem = items.find((item) => item.type === 'item' && item.id === 'refresh-tab')

  expect(refreshItem?.type).toBe('item')
  expect(refreshItem?.type === 'item' ? refreshItem.disabled : false).toBe(true)
})

it('selecting Refresh pane calls refreshPane', () => {
  const actions = createMockActions()
  const ctx = createMockContext(actions)
  const items = buildMenuItems({ kind: 'pane', tabId: 'tab1', paneId: 'pane1' }, ctx)
  const refreshItem = items.find((item) => item.type === 'item' && item.id === 'refresh-pane')

  expect(refreshItem).toBeDefined()
  if (refreshItem?.type === 'item') refreshItem.onSelect()
  expect(actions.refreshPane).toHaveBeenCalledWith('tab1', 'pane1')
})
```

Update `createMockActions()` with `refreshTab` and `refreshPane`.

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/context-menu/menu-defs.test.ts
```

Expected: FAIL because the new menu items and action fields do not exist yet.

**Step 3: Write minimal implementation**

Update `src/components/context-menu/menu-defs.ts`:

```ts
export type MenuActions = {
  // existing fields...
  refreshTab: (tabId: string) => void
  refreshPane: (tabId: string, paneId: string) => void
}
```

Use `collectPaneLeaves()` and `isRefreshablePaneContent()` to compute enablement from stored layout content:

```ts
const canRefreshTab = !!layout && collectPaneLeaves(layout).some((leaf) => isRefreshablePaneContent(leaf.content))
const canRefreshPane = !!paneContent && isRefreshablePaneContent(paneContent)
```

Insert:

```ts
{ type: 'item', id: 'refresh-tab', label: 'Refresh tab', onSelect: () => actions.refreshTab(target.tabId), disabled: !canRefreshTab }
```

and:

```ts
{ type: 'item', id: 'refresh-pane', label: 'Refresh pane', onSelect: () => actions.refreshPane(target.tabId, target.paneId), disabled: !canRefreshPane }
```

Placement:

- `Refresh tab` before `Rename tab`
- `Refresh pane` before the split actions

Do not read `getTerminalActions()` or `getBrowserActions()` for refresh enablement.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/context-menu/menu-defs.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/components/context-menu/menu-defs.test.ts
git commit -m "feat(ui): add layout-driven refresh menu items"
```

### Task 4: Dispatch One-Shot Refresh Requests From `ContextMenuProvider`

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/components/panes/Pane.tsx`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Step 1: Write the failing tests**

Add provider tests that use the real store state instead of action-registry stubs:

```tsx
import TabBar from '@/components/TabBar'
import TabContent from '@/components/TabContent'

it('opens the pane context menu from the focused pane shell with Shift+F10', async () => {
  const user = userEvent.setup()
  renderRealPaneHarness()

  const pane = screen.getByRole('group', { name: 'Pane: Shell' })
  pane.focus()
  await user.keyboard('{Shift>}{F10}{/Shift}')

  expect(screen.getByRole('menuitem', { name: 'Refresh pane' })).toBeInTheDocument()
})

it('Refresh pane stores a one-shot request for the targeted pane', async () => {
  const user = userEvent.setup()
  const { store } = renderRealPaneHarness()

  await user.pointer({ target: screen.getByText('Shell'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: 'Refresh pane' }))

  expect(store.getState().panes.refreshRequestsByPane['tab-1']['pane-1']).toMatchObject({
    requestId: expect.any(String),
    target: { kind: 'terminal', createRequestId: expect.any(String) },
  })
})

it('Refresh tab stores requests for all refreshable leaves in a zoomed tab, including unmounted siblings', async () => {
  const user = userEvent.setup()
  const store = createZoomedStore({
    layout: split([
      leaf('pane-editor', editorContent),
      split([leaf('pane-term', shellContent), leaf('pane-browser', browserContent)]),
    ]),
    zoomedPaneId: 'pane-editor',
  })

  render(
    <Provider store={store}>
      <ContextMenuProvider view="terminal" onViewChange={() => {}} onToggleSidebar={() => {}} sidebarCollapsed={false}>
        <TabBar />
        <TabContent tabId="tab-1" hidden={false} />
      </ContextMenuProvider>
    </Provider>,
  )

  await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: 'Refresh tab' }))

  expect(Object.keys(store.getState().panes.refreshRequestsByPane['tab-1']).sort()).toEqual([
    'pane-browser',
    'pane-term',
  ])
})
```

That zoomed-tab test must use the real zoomed layout so only the editor leaf is mounted.

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: FAIL because the provider does not dispatch refresh-request reducers yet and the pane shell is not yet the keyboard context target.

**Step 3: Write minimal implementation**

Move the pane context metadata onto the focusable pane shell in `src/components/panes/Pane.tsx`:

```tsx
<div
  data-pane-shell="true"
  data-context={ContextIds.Pane}
  data-tab-id={tabId}
  data-pane-id={paneId}
  role="group"
  tabIndex={0}
  aria-label={`Pane: ${title || 'untitled'}`}
>
```

Then update `src/components/context-menu/ContextMenuProvider.tsx`:

```ts
const refreshPaneAction = useCallback((tabId: string, paneId: string) => {
  dispatch(requestPaneRefresh({ tabId, paneId }))
}, [dispatch])

const refreshTabAction = useCallback((tabId: string) => {
  dispatch(requestTabRefresh({ tabId }))
}, [dispatch])
```

Wire them into the menu action map:

```ts
actions: {
  // existing actions...
  refreshTab: refreshTabAction,
  refreshPane: refreshPaneAction,
}
```

Do not call browser or terminal action registries here. The provider’s job is to enqueue one-shot refresh requests in slice state.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: PASS, including the zoomed-tab regression.

**Step 5: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx src/components/panes/Pane.tsx test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "feat(ui): dispatch one-shot pane refresh requests"
```

### Task 5: Refactor `BrowserPane` Refresh To Preserve Live Reload And Recover Error Screens

**Files:**
- Modify: `src/components/panes/BrowserPane.tsx`
- Test: `test/unit/client/components/panes/BrowserPane.test.tsx`

**Step 1: Write the failing tests**

Add real BrowserPane tests that verify the component’s actual DOM/API behavior:

```tsx
import { requestPaneRefresh } from '@/store/panesSlice'

it('toolbar Refresh reloads the live iframe document when an iframe exists', async () => {
  renderBrowserPane({ url: 'https://example.com' })

  const iframe = await screen.findByTitle('Browser content')
  const reloadSpy = vi.fn()
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: { location: { reload: reloadSpy } },
  })

  fireEvent.click(screen.getByTitle('Refresh'))

  expect(reloadSpy).toHaveBeenCalledTimes(1)
  expect(document.querySelectorAll('iframe')).toHaveLength(1)
  expect(document.querySelector('iframe')).toBe(iframe)
})

it('toolbar Refresh retries forwarding when the pane is on a forwardError screen with no iframe', async () => {
  setWindowHostname('192.168.1.100')
  vi.mocked(api.post)
    .mockRejectedValueOnce(new Error('Connection refused'))
    .mockResolvedValueOnce({ forwardedPort: 45678 })

  renderBrowserPane({ url: 'http://localhost:3000' })

  await waitFor(() => expect(screen.getByText(/Failed to connect to localhost:3000/i)).toBeInTheDocument())
  expect(document.querySelector('iframe')).toBeNull()

  fireEvent.click(screen.getByTitle('Refresh'))

  await waitFor(() => {
    expect(api.post).toHaveBeenCalledTimes(2)
    expect(document.querySelector('iframe')?.getAttribute('src')).toBe('http://192.168.1.100:45678/')
  })
})

it('consumes a pending refresh request once and does not replay it after remount', async () => {
  setWindowHostname('192.168.1.100')
  vi.mocked(api.post)
    .mockRejectedValueOnce(new Error('Connection refused'))
    .mockResolvedValueOnce({ forwardedPort: 45678 })

  const store = createStoreWithPendingBrowserRefresh()

  const first = renderBrowserPane({ url: 'http://localhost:3000' }, store)
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
  expect(store.getState().panes.refreshRequestsByPane['tab-1']?.['pane-1']).toBeUndefined()

  first.unmount()
  renderBrowserPane({ url: 'http://localhost:3000' }, store)

  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(3))
})

it('dispatching requestPaneRefresh uses the same refresh path as the toolbar button', async () => {
  setWindowHostname('192.168.1.100')
  vi.mocked(api.post)
    .mockRejectedValueOnce(new Error('Connection refused'))
    .mockResolvedValueOnce({ forwardedPort: 45678 })

  const { store } = renderBrowserPane({ url: 'http://localhost:3000' })

  await waitFor(() => expect(screen.getByText(/Failed to connect to localhost:3000/i)).toBeInTheDocument())

  act(() => {
    store.dispatch(requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-1' }))
  })

  await waitFor(() => {
    expect(api.post).toHaveBeenCalledTimes(2)
    expect(store.getState().panes.refreshRequestsByPane['tab-1']?.['pane-1']).toBeUndefined()
  })
})
```

These tests must use the real BrowserPane behavior. Do not replace refresh with a fake `browserReload` spy.

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/panes/BrowserPane.test.tsx
```

Expected: FAIL because the current `refresh()` is iframe-only and there is no consume/clear path for pane refresh requests.

**Step 3: Write minimal implementation**

Update `src/components/panes/BrowserPane.tsx` with three separate concepts:

1. Select the pending refresh request:

```ts
const pendingRefreshRequest = useAppSelector((s) => s.panes.refreshRequestsByPane[tabId]?.[paneId] ?? null)
```

2. Preserve the current live-document reload path for mounted iframes:

```ts
const reloadLiveIframe = useCallback(() => {
  const iframe = iframeRef.current
  if (!iframe) return false

  try {
    iframe.contentWindow?.location.reload()
    setIsLoading(true)
    return true
  } catch {
    const src = iframe.src
    iframe.src = src
    setIsLoading(true)
    return true
  }
}, [])
```

3. Add a separate recovery path for error-screen states where no iframe exists:

```ts
const recoverBrowserPane = useCallback(() => {
  if (!currentUrl) return

  setLoadError(null)
  setForwardError(null)
  setResolvedSrc(null)
  setIsLoading(true)
  setForwardRetryKey((key) => key + 1)
}, [currentUrl])
```

Then make the single refresh entrypoint choose between them:

```ts
const refreshBrowser = useCallback(() => {
  if (reloadLiveIframe()) return
  recoverBrowserPane()
}, [recoverBrowserPane, reloadLiveIframe])
```

Keep using `forwardRetryKey` or rename it to `resolveAttemptKey`; either is fine, but the behavior must remain:

- existing iframe -> reload the live document
- no iframe because of `forwardError`/`loadError` -> clear errors and retry resolution

Finally, add a request-consumption effect:

```ts
useEffect(() => {
  const request = pendingRefreshRequest
  if (!request) return
  if (!paneRefreshTargetMatchesContent(request.target, { kind: 'browser', url, devToolsOpen })) {
    dispatch(consumePaneRefreshRequest({ tabId, paneId, requestId: request.requestId }))
    return
  }

  dispatch(consumePaneRefreshRequest({ tabId, paneId, requestId: request.requestId }))
  refreshBrowser()
}, [pendingRefreshRequest?.requestId, dispatch, paneId, refreshBrowser, tabId, url, devToolsOpen])
```

Important constraints:

- No `handledRefreshGenerationRef` pattern. The store consume/clear path is what makes the request one-shot.
- Keep the toolbar Refresh button and the registered browser action (`reload`) pointed at the same `refreshBrowser()` helper.
- Do not force a new iframe from the last saved Redux URL when a live iframe exists. That would regress in-iframe navigation reload behavior.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/panes/BrowserPane.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/panes/BrowserPane.tsx test/unit/client/components/panes/BrowserPane.test.tsx
git commit -m "fix(browser): make pane refresh one-shot and error-safe"
```

### Task 6: Make `TerminalView` Consume Requests Without Double-Attach On Mount

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Step 1: Write the failing tests**

Add terminal refresh coverage to `test/unit/client/components/TerminalView.lifecycle.test.tsx`:

```tsx
import { requestPaneRefresh } from '@/store/panesSlice'

it('dispatching requestPaneRefresh detaches and performs exactly one visible replay attach', async () => {
  const { store, tabId, paneId, terminalId } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-refresh-visible',
  })

  wsMocks.send.mockClear()

  act(() => {
    store.dispatch(requestPaneRefresh({ tabId, paneId }))
  })

  const detachCalls = wsMocks.send.mock.calls.filter(([msg]) => msg.type === 'terminal.detach')
  const attachCalls = wsMocks.send.mock.calls.filter(([msg]) => msg.type === 'terminal.attach')

  expect(detachCalls).toEqual([[{ type: 'terminal.detach', terminalId }]])
  expect(attachCalls).toHaveLength(1)
  expect(attachCalls[0][0]).toMatchObject({
    type: 'terminal.attach',
    terminalId,
    sinceSeq: 0,
    attachRequestId: expect.any(String),
  })
})

it('dispatching requestPaneRefresh while hidden detaches and performs exactly one delta attach', async () => {
  const { store, tabId, paneId, terminalId } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-refresh-hidden',
    hidden: true,
  })

  messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 3, data: 'abc' })
  wsMocks.send.mockClear()

  act(() => {
    store.dispatch(requestPaneRefresh({ tabId, paneId }))
  })

  const attachCalls = wsMocks.send.mock.calls.filter(([msg]) => msg.type === 'terminal.attach')

  expect(wsMocks.send).toHaveBeenCalledWith({ type: 'terminal.detach', terminalId })
  expect(attachCalls).toHaveLength(1)
  expect(attachCalls[0][0]).toMatchObject({
    type: 'terminal.attach',
    terminalId,
    sinceSeq: 3,
    attachRequestId: expect.any(String),
  })
})

it('a pending refresh request present on mount replaces the normal mount attach instead of adding a second attach', async () => {
  const store = createStoreWithPendingTerminalRefresh({
    terminalId: 'term-on-mount',
    createRequestId: 'req-1',
  })

  renderTerminalHarnessWithStore(store)

  await waitFor(() => {
    const attachCalls = wsMocks.send.mock.calls.filter(([msg]) => msg.type === 'terminal.attach')
    expect(attachCalls).toHaveLength(1)
    expect(attachCalls[0][0]).toMatchObject({
      type: 'terminal.attach',
      terminalId: 'term-on-mount',
      sinceSeq: 0,
    })
  })

  expect(wsMocks.send).toHaveBeenCalledWith({ type: 'terminal.detach', terminalId: 'term-on-mount' })
  expect(store.getState().panes.refreshRequestsByPane['tab-1']?.['pane-1']).toBeUndefined()
})

it('consumed refresh requests do not replay after App view remounts the terminal pane', async () => {
  const store = createStoreWithPendingTerminalRefresh({
    terminalId: 'term-remount',
    createRequestId: 'req-1',
  })

  const first = renderTerminalHarnessWithStore(store)
  await waitFor(() => {
    expect(wsMocks.send.mock.calls.filter(([msg]) => msg.type === 'terminal.attach')).toHaveLength(1)
  })

  wsMocks.send.mockClear()
  first.unmount()
  renderTerminalHarnessWithStore(store)

  await waitFor(() => {
    expect(wsMocks.send.mock.calls.filter(([msg]) => msg.type === 'terminal.detach')).toHaveLength(0)
    expect(wsMocks.send.mock.calls.filter(([msg]) => msg.type === 'terminal.attach').length).toBeLessThanOrEqual(1)
  })
})
```

That third test is the mount-order regression: a pre-existing request on mount must not produce `detach -> attach(viewport) -> attach(keepalive)` on the same mount.

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL because `TerminalView` has no request consume/clear path and no mount-order coordination for refresh.

**Step 3: Write minimal implementation**

Update `src/components/TerminalView.tsx` in three parts.

1. Select the pending request and add a small helper for terminal-specific target validation:

```ts
const pendingRefreshRequest = useAppSelector((s) => s.panes.refreshRequestsByPane[tabId]?.[paneId] ?? null)
```

2. Add a shared helper that consumes the request and performs the refresh attach exactly once:

```ts
const runTerminalRefresh = useCallback((request: PaneRefreshRequest) => {
  dispatch(consumePaneRefreshRequest({ tabId, paneId, requestId: request.requestId }))

  const tid = terminalIdRef.current
  if (!tid) return

  ws.send({ type: 'terminal.detach', terminalId: tid })
  currentAttachRef.current = null

  if (hiddenRef.current) {
    needsViewportHydrationRef.current = true
    attachTerminal(tid, 'keepalive_delta')
    return
  }

  attachTerminal(tid, 'viewport_hydrate', { clearViewportFirst: true })
}, [attachTerminal, dispatch, paneId, tabId, ws])
```

3. Coordinate mount-time and post-mount refresh separately so the normal mount attach never races a refresh attach.

Keep the existing create/attach lifecycle effect, but before its normal `attachTerminal(currentTerminalId, intent)` branch, inspect the current pending request:

```ts
const refreshRequest = pendingRefreshRequest
if (refreshRequest && !paneRefreshTargetMatchesContent(refreshRequest.target, contentRef.current)) {
  dispatch(consumePaneRefreshRequest({ tabId, paneId, requestId: refreshRequest.requestId }))
} else if (refreshRequest && currentTerminalId) {
  runTerminalRefresh(refreshRequest)
  return
} else if (refreshRequest && !currentTerminalId) {
  dispatch(consumePaneRefreshRequest({ tabId, paneId, requestId: refreshRequest.requestId }))
}
```

That makes mount-time pending requests replace the normal attach path.

Then add a second effect for requests that arrive after the initial mount decision, with an arm-once guard so it does not also fire on the first render:

```ts
const refreshEffectArmedRef = useRef(false)

useEffect(() => {
  if (!refreshEffectArmedRef.current) {
    refreshEffectArmedRef.current = true
    return
  }

  const request = pendingRefreshRequest
  if (!request) return
  if (!paneRefreshTargetMatchesContent(request.target, contentRef.current)) {
    dispatch(consumePaneRefreshRequest({ tabId, paneId, requestId: request.requestId }))
    return
  }

  runTerminalRefresh(request)
}, [pendingRefreshRequest?.requestId, dispatch, paneId, runTerminalRefresh, tabId])
```

Key rules:

- Do not add a new refresh effect before the existing mount attach logic.
- Do not rely on `handledRefreshGenerationRef`; the request must be removed from Redux when claimed.
- A pre-existing request on mount must result in exactly one attach cycle.
- If there is no `terminalId` yet, consume the request and let the existing create flow continue; creating a terminal already establishes a fresh frontend connection.
- Hidden terminals still use the delta path and deferred viewport hydration. The only change is that refresh goes through the same path exactly once.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix(terminals): make pane refresh one-shot and mount-safe"
```

### Task 7: Add A Zoomed-Tab One-Shot Refresh Regression Flow

**Files:**
- Create: `test/e2e/refresh-context-menu-flow.test.tsx`

**Step 1: Write the failing test**

Create a flow that exercises the full cross-component behavior with real store state:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'react-redux'
import { toggleZoom } from '@/store/panesSlice'
import TabBar from '@/components/TabBar'
import TabContent from '@/components/TabContent'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { api } from '@/lib/api'

describe('refresh context menu flow', () => {
  it('Refresh tab queues hidden zoom siblings, consumes them on mount, and does not replay them after remount', async () => {
    const user = userEvent.setup()
    const store = createZoomedBrowserSiblingStore()
    vi.mocked(api.post).mockResolvedValue({ forwardedPort: 45678 })

    const view = render(
      <Provider store={store}>
        <ContextMenuProvider view="terminal" onViewChange={() => {}} onToggleSidebar={() => {}} sidebarCollapsed={false}>
          <TabBar />
          <TabContent tabId="tab-1" hidden={false} />
        </ContextMenuProvider>
      </Provider>,
    )

    // The tab is zoomed onto an editor leaf; browser sibling is not mounted.
    expect(screen.queryByTitle('Back')).toBeNull()

    await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'Refresh tab' }))

    expect(store.getState().panes.refreshRequestsByPane['tab-1']['pane-browser']).toMatchObject({
      requestId: expect.any(String),
      target: { kind: 'browser' },
    })

    store.dispatch(toggleZoom({ tabId: 'tab-1', paneId: 'pane-editor' }))

    await waitFor(() => {
      expect(api.post).toHaveBeenCalled()
      expect(store.getState().panes.refreshRequestsByPane['tab-1']?.['pane-browser']).toBeUndefined()
    })

    vi.mocked(api.post).mockClear()
    view.unmount()

    render(
      <Provider store={store}>
        <ContextMenuProvider view="terminal" onViewChange={() => {}} onToggleSidebar={() => {}} sidebarCollapsed={false}>
          <TabBar />
          <TabContent tabId="tab-1" hidden={false} />
        </ContextMenuProvider>
      </Provider>,
    )

    await waitFor(() => expect(api.post).not.toHaveBeenCalled())
  })
})
```

Use a zoomed editor leaf plus a hidden browser leaf with a localhost URL so the unzoom step has an externally visible retry signal (`api.post('/api/proxy/forward', ...)`).

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run test/e2e/refresh-context-menu-flow.test.tsx
```

Expected: FAIL until Tasks 2-6 are complete.

**Step 3: Write minimal implementation**

Finish the test with the real store shape and mocks that the app already uses. The important assertions are:

- `Refresh tab` remains enabled while only the zoomed editor leaf is mounted.
- Clicking it stores one-shot refresh requests for hidden refreshable siblings.
- Unzooming later causes the previously skipped browser sibling to claim and consume its request.
- Remounting the same tab contents afterward does not replay the old request.

This test must not pre-register hidden pane action registries; that would reintroduce the bug the test is supposed to catch.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run test/e2e/refresh-context-menu-flow.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e/refresh-context-menu-flow.test.tsx
git commit -m "test(ui): cover one-shot zoomed refresh flow"
```

## Final Validation

Run the focused client suite first:

```bash
npm run test:client -- test/unit/client/lib/pane-utils.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/components/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/panes/BrowserPane.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
npx vitest run test/e2e/refresh-context-menu-flow.test.tsx
```

Then run the repo gates:

```bash
npm run lint
npm test
```

Expected final state:

- Right-clicking a tab shows `Refresh tab`.
- Right-clicking a pane header shows `Refresh pane`.
- Menu enablement depends on the stored pane content kinds, not mounted component registries.
- `Refresh Tab` creates requests for every terminal/browser leaf in the tab’s layout tree, even in zoomed tabs where siblings are currently unmounted.
- Refresh requests are one-shot: panes explicitly consume them, stale requests are cleared when content changes, and old requests do not replay after later remounts.
- Browser panes preserve live-document reload when an iframe exists and recover from `forwardError`/`loadError` when no iframe exists.
- Terminal panes refresh through exactly one detach/attach decision per mount, with visible panes using full replay and hidden panes preserving the deferred-hydration path.
- Refresh bookkeeping is ephemeral and is not persisted to localStorage.

If `npm test` surfaces unrelated failures, stop and fix them before rebasing or merging, per repo policy.

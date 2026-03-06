# Refresh Tab And Refresh Pane Context Menus Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Add `Refresh Tab` and `Refresh Pane` to the existing right-click context menus so browser panes reload the correct embedded browser instance, terminal panes reconnect to the existing terminal session, and the behavior stays correct for zoomed tabs, keyboard-opened menus, and hidden panes.

**Architecture:** Keep refresh state one-shot and Redux-driven. Store ephemeral refresh requests in `panesSlice`, but target them by stable pane-instance identity, not by pane id alone and not by browser URL. Terminals already have `createRequestId`; browser panes need the same concept via a new persisted `browserInstanceId` on browser pane content. Menu enablement and request creation must use a single helper that only returns a target for panes that can actually refresh right now: terminals with an attached `terminalId`, and browser panes with a non-empty URL. Pane components consume matching requests exactly once and reducers reconcile stale requests after every layout/content mutation.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, xterm.js, Vitest, Testing Library

---

## Scope Notes

- `Refresh Pane` must appear anywhere pane-level commands already exist:
  - `ContextIds.Pane`
  - `ContextIds.Terminal`
  - `ContextIds.Browser`
- `Refresh Pane` does **not** apply to `editor`, `picker`, `agent-chat`, or `extension` panes in this issue.
- `Refresh Tab` must walk the stored layout tree, not mounted pane instances, so zoomed tabs still queue hidden refreshable leaves.
- Refresh requests are ephemeral like `renameRequest*` and `zoomedPane`; they must never persist to localStorage or hydrate from remote state.
- Browser refresh requests must target `browserInstanceId`, not URL.
  - Same browser instance with a new URL should still satisfy the pending request.
  - Same URL on a different browser instance must **not** satisfy the pending request.
- Browser panes need a real persisted instance identity:
  - Generate `browserInstanceId` when browser pane content is created or normalized.
  - Preserve it across normal browser navigation and devtools toggles.
  - Migrate older persisted browser panes that do not have it yet.
- Refreshable pane states for this feature:
  - Terminal pane: `kind === 'terminal'` and `terminalId` is present.
  - Browser pane: `kind === 'browser'` and `url.trim()` is non-empty.
- Guaranteed no-op panes must not advertise refresh:
  - Blank browser panes stay disabled and are skipped by `Refresh Tab`.
  - Exited or unattached terminal panes stay disabled and are skipped by `Refresh Tab`.
- Browser refresh must preserve the current live iframe reload path when an iframe exists and only fall back to error recovery when there is no iframe to reload.
- Terminal refresh must fold into the existing attach lifecycle so a mount-time pending request replaces the normal attach path instead of adding a second attach.
- No server or WebSocket protocol changes are needed.
- No `docs/index.html` update is required; this is not a major mock/UI-doc change.

### Task 1: Introduce Stable Browser Instance Identity

**Files:**
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/persistedState.ts`
- Test: `test/unit/client/store/panesSlice.test.ts`
- Test: `test/unit/client/store/panesPersistence.test.ts`

**Step 1: Write the failing tests**

Extend `test/unit/client/store/panesSlice.test.ts` with browser normalization coverage:

```ts
it('generates browserInstanceId for browser pane input', () => {
  const state = panesReducer(
    initialState,
    initLayout({
      tabId: 'tab-1',
      content: { kind: 'browser', url: 'https://example.com', devToolsOpen: false },
    }),
  )

  const layout = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
  expect(layout.content.kind).toBe('browser')
  if (layout.content.kind === 'browser') {
    expect(layout.content.browserInstanceId).toBeDefined()
  }
})

it('preserves provided browserInstanceId when normalizing browser input', () => {
  const state = panesReducer(
    initialState,
    initLayout({
      tabId: 'tab-1',
      content: {
        kind: 'browser',
        url: 'https://example.com',
        devToolsOpen: false,
        browserInstanceId: 'browser-1',
      },
    }),
  )

  const layout = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
  expect(layout.content).toMatchObject({
    kind: 'browser',
    browserInstanceId: 'browser-1',
  })
})
```

Extend `test/unit/client/store/panesPersistence.test.ts` with migration coverage:

```ts
it('migrates older browser pane content to include browserInstanceId', () => {
  localStorage.setItem('freshell.panes.v2', JSON.stringify({
    version: 5,
    layouts: {
      'tab-1': {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'browser', url: 'https://example.com', devToolsOpen: true },
      },
    },
    activePane: { 'tab-1': 'pane-1' },
    paneTitles: {},
    paneTitleSetByUser: {},
  }))

  const loaded = loadPersistedPanes()
  const layout = loaded!.layouts['tab-1'] as any

  expect(layout.content.kind).toBe('browser')
  expect(layout.content.browserInstanceId).toBeDefined()
  expect(loaded!.version).toBe(PANES_SCHEMA_VERSION)
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:client -- test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts
```

Expected: FAIL because browser panes do not yet have a stable instance identity or migration path.

**Step 3: Write minimal implementation**

Update `src/store/paneTypes.ts`:

```ts
export type BrowserPaneContent = {
  kind: 'browser'
  browserInstanceId: string
  url: string
  devToolsOpen: boolean
}

export type BrowserPaneInput = Omit<BrowserPaneContent, 'browserInstanceId'> & {
  browserInstanceId?: string
}

export type PaneContentInput =
  | TerminalPaneInput
  | BrowserPaneInput
  | EditorPaneInput
  | PickerPaneContent
  | AgentChatPaneInput
  | ExtensionPaneInput
```

Update `normalizeContent()` in `src/store/panesSlice.ts`:

```ts
if (input.kind === 'browser') {
  return {
    kind: 'browser',
    browserInstanceId: input.browserInstanceId || nanoid(),
    url: input.url,
    devToolsOpen: input.devToolsOpen,
  }
}
```

Update migration and versioning:

```ts
export const PANES_SCHEMA_VERSION = 6
```

```ts
function migratePaneContent(content: any): any {
  if (content?.kind === 'browser') {
    return {
      ...content,
      browserInstanceId: content.browserInstanceId || nanoid(),
    }
  }
  // existing terminal migration...
}
```

Also update any normalized browser fixtures touched by these suites so state-shaped browser content includes `browserInstanceId`; input-only call sites can stay on `BrowserPaneInput`.

**Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:client -- test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/paneTypes.ts src/store/panesSlice.ts src/store/persistMiddleware.ts src/store/persistedState.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts
git commit -m "refactor(browser): add stable browser instance ids"
```

### Task 2: Add One-Shot Refresh Helpers And Request Reconciliation

**Files:**
- Modify: `src/lib/pane-utils.ts`
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/persistMiddleware.ts`
- Test: `test/unit/client/lib/pane-utils.test.ts`
- Test: `test/unit/client/store/panesSlice.test.ts`
- Test: `test/unit/client/store/panesPersistence.test.ts`

**Step 1: Write the failing tests**

Extend `test/unit/client/lib/pane-utils.test.ts`:

```ts
describe('buildPaneRefreshTarget', () => {
  it('returns null for terminal panes without terminalId', () => {
    expect(buildPaneRefreshTarget({
      kind: 'terminal',
      mode: 'shell',
      createRequestId: 'req-1',
      status: 'running',
    })).toBeNull()
  })

  it('returns a terminal target for attached terminals', () => {
    expect(buildPaneRefreshTarget({
      kind: 'terminal',
      mode: 'shell',
      createRequestId: 'req-1',
      terminalId: 'term-1',
      status: 'running',
    })).toEqual({ kind: 'terminal', createRequestId: 'req-1' })
  })

  it('returns null for blank browser panes', () => {
    expect(buildPaneRefreshTarget({
      kind: 'browser',
      browserInstanceId: 'browser-1',
      url: '',
      devToolsOpen: false,
    })).toBeNull()
  })

  it('returns a browser target keyed by browserInstanceId', () => {
    expect(buildPaneRefreshTarget({
      kind: 'browser',
      browserInstanceId: 'browser-1',
      url: 'https://example.test/a',
      devToolsOpen: false,
    })).toEqual({ kind: 'browser', browserInstanceId: 'browser-1' })
  })
})

describe('paneRefreshTargetMatchesContent', () => {
  it('keeps matching the same browser instance even when url changes', () => {
    expect(
      paneRefreshTargetMatchesContent(
        { kind: 'browser', browserInstanceId: 'browser-1' },
        { kind: 'browser', browserInstanceId: 'browser-1', url: 'https://example.test/b', devToolsOpen: false },
      ),
    ).toBe(true)
  })

  it('does not match a different browser instance even when the url is the same', () => {
    expect(
      paneRefreshTargetMatchesContent(
        { kind: 'browser', browserInstanceId: 'browser-1' },
        { kind: 'browser', browserInstanceId: 'browser-2', url: 'https://example.test/a', devToolsOpen: false },
      ),
    ).toBe(false)
  })
})
```

Extend `test/unit/client/store/panesSlice.test.ts`:

```ts
it('requestPaneRefresh skips blank browser panes and unattached terminals', () => {
  const blankBrowserState = panesReducer(
    stateWithLeaf('pane-browser', {
      kind: 'browser',
      browserInstanceId: 'browser-1',
      url: '',
      devToolsOpen: false,
    }),
    requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-browser' }),
  )
  expect(blankBrowserState.refreshRequestsByPane['tab-1']).toBeUndefined()

  const unattachedTerminalState = panesReducer(
    stateWithLeaf('pane-term', {
      kind: 'terminal',
      mode: 'shell',
      createRequestId: 'req-1',
      status: 'running',
    }),
    requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-term' }),
  )
  expect(unattachedTerminalState.refreshRequestsByPane['tab-1']).toBeUndefined()
})

it('requestTabRefresh queues only live-capable leaves in a zoomed tab', () => {
  const state = panesReducer(
    stateWithLayoutAndZoom({
      layout: split([
        leaf('pane-editor', editorContent),
        split([
          leaf('pane-live-browser', {
            kind: 'browser',
            browserInstanceId: 'browser-1',
            url: 'https://example.test/a',
            devToolsOpen: false,
          }),
          leaf('pane-blank-browser', {
            kind: 'browser',
            browserInstanceId: 'browser-2',
            url: '',
            devToolsOpen: false,
          }),
        ]),
      ]),
      zoomedPaneId: 'pane-editor',
    }),
    requestTabRefresh({ tabId: 'tab-1' }),
  )

  expect(Object.keys(state.refreshRequestsByPane['tab-1'])).toEqual(['pane-live-browser'])
})

it('preserves a browser refresh request across same-instance url changes', () => {
  const requested = panesReducer(
    stateWithLeaf('pane-browser', {
      kind: 'browser',
      browserInstanceId: 'browser-1',
      url: 'https://example.test/a',
      devToolsOpen: false,
    }),
    requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-browser' }),
  )

  const next = panesReducer(
    requested,
    updatePaneContent({
      tabId: 'tab-1',
      paneId: 'pane-browser',
      content: {
        kind: 'browser',
        browserInstanceId: 'browser-1',
        url: 'https://example.test/b',
        devToolsOpen: false,
      },
    }),
  )

  expect(next.refreshRequestsByPane['tab-1']?.['pane-browser']).toBeDefined()
})

it('clears a pending browser request after a same-url browser swap changes instance identity', () => {
  const requested = panesReducer(
    stateWithLayout({
      'tab-1': split([
        leaf('pane-a', {
          kind: 'browser',
          browserInstanceId: 'browser-a',
          url: 'https://example.test/shared',
          devToolsOpen: false,
        }),
        leaf('pane-b', {
          kind: 'browser',
          browserInstanceId: 'browser-b',
          url: 'https://example.test/shared',
          devToolsOpen: false,
        }),
      ]),
    }),
    requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-a' }),
  )

  const next = panesReducer(
    requested,
    swapPanes({ tabId: 'tab-1', paneId: 'pane-a', otherId: 'pane-b' }),
  )

  expect(next.refreshRequestsByPane['tab-1']?.['pane-a']).toBeUndefined()
})
```

Add a persistence assertion to `test/unit/client/store/panesPersistence.test.ts`:

```ts
it('does not persist refreshRequestsByPane', () => {
  // existing store setup ...
  expect(JSON.parse(localStorage.getItem('freshell.panes.v2')!).refreshRequestsByPane).toBeUndefined()
})
```

**Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:client -- test/unit/client/lib/pane-utils.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts
```

Expected: FAIL because refresh helpers, request state, and reconciliation do not exist yet.

**Step 3: Write minimal implementation**

Add refresh types in `src/store/paneTypes.ts`:

```ts
export type PaneRefreshTarget =
  | { kind: 'terminal'; createRequestId: string }
  | { kind: 'browser'; browserInstanceId: string }

export interface PaneRefreshRequest {
  requestId: string
  target: PaneRefreshTarget
}
```

Add shared helpers in `src/lib/pane-utils.ts`:

```ts
export function buildPaneRefreshTarget(content: PaneContent): PaneRefreshTarget | null {
  if (content.kind === 'terminal') {
    return content.terminalId ? { kind: 'terminal', createRequestId: content.createRequestId } : null
  }
  if (content.kind === 'browser') {
    return content.url.trim()
      ? { kind: 'browser', browserInstanceId: content.browserInstanceId }
      : null
  }
  return null
}

export function paneRefreshTargetMatchesContent(
  target: PaneRefreshTarget,
  content: PaneContent | null | undefined,
): boolean {
  if (!content) return false
  if (target.kind === 'terminal') {
    return content.kind === 'terminal'
      && !!content.terminalId
      && content.createRequestId === target.createRequestId
  }
  return content.kind === 'browser'
    && !!content.url.trim()
    && content.browserInstanceId === target.browserInstanceId
}
```

Add `refreshRequestsByPane` to `PanesState`, initialize it everywhere, and add reducers:

```ts
requestPaneRefresh(...)
requestTabRefresh(...)
consumePaneRefreshRequest(...)
```

Reconcile pending requests after any reducer that can change which content lives under a pane id or whether a pane is refresh-capable:

- `initLayout`
- `resetLayout`
- `splitPane`
- `addPane`
- `closePane`
- `swapPanes`
- `replacePane`
- `updatePaneContent`
- `mergePaneContent`
- `removeLayout`
- `hydratePanes`

Also strip `refreshRequestsByPane` in `src/store/persistMiddleware.ts`.

**Step 4: Run tests to verify they pass**

Run:

```bash
npm run test:client -- test/unit/client/lib/pane-utils.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/pane-utils.ts src/store/paneTypes.ts src/store/panesSlice.ts src/store/persistMiddleware.ts test/unit/client/lib/pane-utils.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts
git commit -m "feat(panes): add one-shot refresh requests"
```

### Task 3: Add Refresh Items To Tab, Pane, Terminal, And Browser Menus

**Files:**
- Modify: `src/components/context-menu/menu-defs.ts`
- Test: `test/unit/client/context-menu/menu-defs.test.ts`

**Step 1: Write the failing tests**

Extend `test/unit/client/context-menu/menu-defs.test.ts`:

```ts
it('enables Refresh tab only when the stored layout has at least one refresh-capable leaf', () => {
  const actions = createActions()
  const items = buildMenuItems(
    { kind: 'tab', tabId: 'tab-1' },
    makeCtx(actions, {
      paneLayouts: {
        'tab-1': {
          type: 'split',
          id: 'split-1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'pane-live-browser', content: { kind: 'browser', browserInstanceId: 'browser-1', url: 'https://example.com', devToolsOpen: false } },
            { type: 'leaf', id: 'pane-blank-browser', content: { kind: 'browser', browserInstanceId: 'browser-2', url: '', devToolsOpen: false } },
          ],
        },
      },
    }),
  )

  const refreshItem = items.find((item) => item.type === 'item' && item.id === 'refresh-tab')
  expect(refreshItem?.type).toBe('item')
  expect(refreshItem?.type === 'item' ? refreshItem.disabled : true).toBe(false)
})

it('disables Refresh pane for blank browser panes and unattached terminal panes', () => {
  const blankBrowserItems = buildMenuItems(
    { kind: 'browser', tabId: 'tab-1', paneId: 'pane-1' },
    makeCtx(createActions(), {
      paneLayouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: { kind: 'browser', browserInstanceId: 'browser-1', url: '', devToolsOpen: false },
        },
      },
    }),
  )
  const blankBrowserRefresh = blankBrowserItems.find((item) => item.type === 'item' && item.id === 'refresh-pane')
  expect(blankBrowserRefresh?.type === 'item' ? blankBrowserRefresh.disabled : false).toBe(true)
})

it('includes Refresh pane on pane, terminal, and browser menus', () => {
  for (const target of [
    { kind: 'pane', tabId: 'tab-1', paneId: 'pane-1' } as const,
    { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' } as const,
    { kind: 'browser', tabId: 'tab-1', paneId: 'pane-2' } as const,
  ]) {
    const items = buildMenuItems(target, makeCtx(createActions(), {
      paneLayouts: {
        'tab-1': {
          type: 'split',
          id: 'split-1',
          direction: 'horizontal',
          sizes: [50, 50],
          children: [
            { type: 'leaf', id: 'pane-1', content: { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', terminalId: 'term-1', status: 'running' } },
            { type: 'leaf', id: 'pane-2', content: { kind: 'browser', browserInstanceId: 'browser-2', url: 'https://example.com', devToolsOpen: false } },
          ],
        },
      },
    }))

    expect(items.find((item) => item.type === 'item' && item.id === 'refresh-pane')).toBeDefined()
  }
})
```

Update `createActions()` with `refreshTab` and `refreshPane`.

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/context-menu/menu-defs.test.ts
```

Expected: FAIL because refresh actions and menu items are not defined yet.

**Step 3: Write minimal implementation**

Update `src/components/context-menu/menu-defs.ts`:

```ts
export type MenuActions = {
  // existing actions...
  refreshTab: (tabId: string) => void
  refreshPane: (tabId: string, paneId: string) => void
}
```

Use `collectPaneLeaves()` plus `buildPaneRefreshTarget()` for enablement:

```ts
const canRefreshTab = !!layout && collectPaneLeaves(layout).some((leaf) => !!buildPaneRefreshTarget(leaf.content))
const canRefreshPane = !!paneContent && !!buildPaneRefreshTarget(paneContent)
```

Add:

```ts
{ type: 'item', id: 'refresh-tab', label: 'Refresh tab', onSelect: () => actions.refreshTab(target.tabId), disabled: !canRefreshTab }
```

and:

```ts
{ type: 'item', id: 'refresh-pane', label: 'Refresh pane', onSelect: () => actions.refreshPane(target.tabId, target.paneId), disabled: !canRefreshPane }
```

Placement:

- Tab menu: before `Rename tab`
- Pane menu: before split actions
- Terminal menu: before split actions
- Browser menu: before split actions

Do not use terminal/browser action registries to decide refresh enablement.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/context-menu/menu-defs.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/context-menu/menu-defs.ts test/unit/client/context-menu/menu-defs.test.ts
git commit -m "feat(ui): add refresh context menu items"
```

### Task 4: Dispatch Refresh Requests And Preserve Keyboard Menu Access

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/components/panes/Pane.tsx`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`

**Step 1: Write the failing tests**

Extend `test/unit/client/components/ContextMenuProvider.test.tsx`:

```tsx
it('opens the pane menu from the focused pane shell with Shift+F10', async () => {
  const user = userEvent.setup()
  renderRealPaneHarness()

  const paneShell = screen.getByRole('group', { name: 'Pane: Shell' })
  paneShell.focus()
  await user.keyboard('{Shift>}{F10}{/Shift}')

  expect(screen.getByRole('menuitem', { name: 'Refresh pane' })).toBeInTheDocument()
})

it('shows Refresh pane from the terminal content menu and dispatches a request', async () => {
  const user = userEvent.setup()
  const { store } = renderRealTerminalHarness()

  await user.pointer({ target: screen.getByText('Terminal Content'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: 'Refresh pane' }))

  expect(store.getState().panes.refreshRequestsByPane['tab-1']['pane-1']).toMatchObject({
    target: { kind: 'terminal', createRequestId: expect.any(String) },
  })
})

it('shows Refresh pane from the browser content menu and dispatches a browser-instance request', async () => {
  const user = userEvent.setup()
  const { store } = renderRealBrowserHarness()

  await user.pointer({ target: screen.getByPlaceholderText('Enter URL...'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: 'Refresh pane' }))

  expect(store.getState().panes.refreshRequestsByPane['tab-1']['pane-1']).toMatchObject({
    target: { kind: 'browser', browserInstanceId: expect.any(String) },
  })
})

it('Refresh tab queues only refresh-capable leaves from a zoomed tab', async () => {
  const user = userEvent.setup()
  const store = createZoomedStore({
    layout: split([
      leaf('pane-editor', editorContent),
      split([
        leaf('pane-term', { kind: 'terminal', mode: 'shell', createRequestId: 'req-1', terminalId: 'term-1', status: 'running' }),
        leaf('pane-blank-browser', { kind: 'browser', browserInstanceId: 'browser-2', url: '', devToolsOpen: false }),
      ]),
    ]),
    zoomedPaneId: 'pane-editor',
  })

  renderProviderHarness(store)

  await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: 'Refresh tab' }))

  expect(Object.keys(store.getState().panes.refreshRequestsByPane['tab-1'])).toEqual(['pane-term'])
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: FAIL because refresh reducers are not wired into the provider and the focusable pane shell is not yet a keyboard context target.

**Step 3: Write minimal implementation**

Update `src/components/context-menu/ContextMenuProvider.tsx` to dispatch the new reducers:

```ts
const refreshPaneAction = useCallback((tabId: string, paneId: string) => {
  dispatch(requestPaneRefresh({ tabId, paneId }))
}, [dispatch])

const refreshTabAction = useCallback((tabId: string) => {
  dispatch(requestTabRefresh({ tabId }))
}, [dispatch])
```

Pass them into `buildMenuItems()`:

```ts
actions: {
  // existing actions...
  refreshTab: refreshTabAction,
  refreshPane: refreshPaneAction,
}
```

Update `src/components/panes/Pane.tsx` so the focusable pane shell itself is the pane context target:

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

Keep the inner `ContextIds.Terminal` and `ContextIds.Browser` roots unchanged so right-clicking inside those panes still opens the specialized menu with `Refresh pane` plus split/replace/browser or terminal commands.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx src/components/panes/Pane.tsx test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "feat(ui): dispatch refresh requests from context menus"
```

### Task 5: Make `BrowserPane` Refresh Instance-Aware And Recovery-Safe

**Files:**
- Modify: `src/components/panes/BrowserPane.tsx`
- Modify: `src/components/panes/PaneContainer.tsx`
- Test: `test/unit/client/components/panes/BrowserPane.test.tsx`

**Step 1: Write the failing tests**

Extend `test/unit/client/components/panes/BrowserPane.test.tsx`:

```tsx
it('toolbar Refresh reloads the live iframe document when an iframe exists', async () => {
  renderBrowserPane({ paneContent: { kind: 'browser', browserInstanceId: 'browser-1', url: 'https://example.com', devToolsOpen: false } })

  const iframe = await screen.findByTitle('Browser content')
  const reloadSpy = vi.fn()
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: { location: { reload: reloadSpy } },
  })

  fireEvent.click(screen.getByTitle('Refresh'))
  expect(reloadSpy).toHaveBeenCalledTimes(1)
})

it('dispatching requestPaneRefresh retries an error-screen browser pane without creating a second mount load', async () => {
  setWindowHostname('192.168.1.100')
  vi.mocked(api.post)
    .mockRejectedValueOnce(new Error('Connection refused'))
    .mockResolvedValueOnce({ forwardedPort: 45678 })

  const { store } = renderBrowserPane({
    paneContent: { kind: 'browser', browserInstanceId: 'browser-1', url: 'http://localhost:3000', devToolsOpen: false },
  })

  await waitFor(() => expect(screen.getByText(/Failed to connect/i)).toBeInTheDocument())

  act(() => {
    store.dispatch(requestPaneRefresh({ tabId: 'tab-1', paneId: 'pane-1' }))
  })

  await waitFor(() => {
    expect(api.post).toHaveBeenCalledTimes(2)
    expect(store.getState().panes.refreshRequestsByPane['tab-1']?.['pane-1']).toBeUndefined()
  })
})

it('ignores a stale refresh request for a different browserInstanceId', async () => {
  const store = createStoreWithPendingBrowserRefresh({
    paneContent: { kind: 'browser', browserInstanceId: 'browser-live', url: 'https://example.com', devToolsOpen: false },
    requestTarget: { kind: 'browser', browserInstanceId: 'browser-stale' },
  })

  renderBrowserPane({ paneContent: store.getState().panes.layouts['tab-1'].content as any }, store)

  await waitFor(() => {
    expect(store.getState().panes.refreshRequestsByPane['tab-1']?.['pane-1']).toBeUndefined()
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/panes/BrowserPane.test.tsx
```

Expected: FAIL because browser refresh is still iframe-only and refresh requests are not yet targeted by browser instance identity.

**Step 3: Write minimal implementation**

Make `BrowserPane` consume normalized browser content instead of loose props. In `src/components/panes/PaneContainer.tsx`:

```tsx
<BrowserPane paneId={paneId} tabId={tabId} paneContent={content} />
```

In `src/components/panes/BrowserPane.tsx`, use `browserInstanceId` from `paneContent`, preserve it on Redux updates, and add one refresh entrypoint:

```ts
const reloadLiveIframe = useCallback(() => { ... }, [])
const recoverBrowserPane = useCallback(() => { ... }, [currentUrl])
const refreshBrowser = useCallback(() => {
  if (reloadLiveIframe()) return
  recoverBrowserPane()
}, [reloadLiveIframe, recoverBrowserPane])
```

Select and consume pending requests:

```ts
const pendingRefreshRequest = useAppSelector((s) => s.panes.refreshRequestsByPane[tabId]?.[paneId] ?? null)
```

After the existing resolve/load effect, add a mount-aware consume effect that:

- consumes stale requests whose `browserInstanceId` no longer matches
- consumes a matching mount-time request without starting a second resolve/load path if the normal initial load is already satisfying it
- calls `refreshBrowser()` only when extra work is actually needed

Keep browser updates preserving `browserInstanceId`:

```ts
dispatch(updatePaneContent({
  tabId,
  paneId,
  content: { ...paneContent, url: fullUrl },
}))
```

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/panes/BrowserPane.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/panes/BrowserPane.tsx src/components/panes/PaneContainer.tsx test/unit/client/components/panes/BrowserPane.test.tsx
git commit -m "fix(browser): refresh the correct browser instance"
```

### Task 6: Make `TerminalView` Consume Refresh Requests Without Double Attach

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Step 1: Write the failing tests**

Extend `test/unit/client/components/TerminalView.lifecycle.test.tsx`:

```tsx
it('dispatching requestPaneRefresh detaches and performs exactly one attach for a visible terminal', async () => {
  // existing visible-terminal harness
})

it('dispatching requestPaneRefresh performs exactly one delta attach for a hidden terminal', async () => {
  // existing hidden-terminal harness
})

it('a pending refresh request on mount replaces the normal mount attach', async () => {
  // existing mount-order regression harness
})

it('consumes stale refresh requests without detaching when terminalId is missing', async () => {
  const store = createStoreWithPendingTerminalRefresh({
    terminalId: undefined,
    createRequestId: 'req-1',
  })

  renderTerminalHarnessWithStore(store)

  await waitFor(() => {
    expect(store.getState().panes.refreshRequestsByPane['tab-1']?.['pane-1']).toBeUndefined()
    expect(wsMocks.send.mock.calls.filter(([msg]) => msg.type === 'terminal.detach')).toHaveLength(0)
  })
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npm run test:client -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL because terminal refresh requests are not yet consumed inside the attach lifecycle.

**Step 3: Write minimal implementation**

In `src/components/TerminalView.tsx`, select pending refresh requests:

```ts
const pendingRefreshRequest = useAppSelector((s) => s.panes.refreshRequestsByPane[tabId]?.[paneId] ?? null)
```

Add a helper that consumes the request and performs exactly one refresh attach:

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

In the existing mount attach effect:

- consume stale requests whose target no longer matches `contentRef.current`
- if a matching request exists and `terminalId` exists, call `runTerminalRefresh()` and return before the normal attach branch
- if no `terminalId` exists, consume the request and allow the normal create flow to continue

Then add a second armed effect for refresh requests that arrive after mount.

**Step 4: Run test to verify it passes**

Run:

```bash
npm run test:client -- test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix(terminals): consume refresh requests in attach lifecycle"
```

### Task 7: Add A Zoomed-Tab Refresh Flow Regression Test

**Files:**
- Create: `test/e2e/refresh-context-menu-flow.test.tsx`

**Step 1: Write the failing test**

Create an end-to-end client flow that exercises the real context-menu path:

```tsx
it('Refresh tab queues only live-capable hidden leaves, consumes them on mount, and does not replay after remount', async () => {
  const user = userEvent.setup()
  const store = createZoomedStore({
    layout: split([
      leaf('pane-editor', editorContent),
      split([
        leaf('pane-browser-live', {
          kind: 'browser',
          browserInstanceId: 'browser-live',
          url: 'http://localhost:3000',
          devToolsOpen: false,
        }),
        leaf('pane-browser-blank', {
          kind: 'browser',
          browserInstanceId: 'browser-blank',
          url: '',
          devToolsOpen: false,
        }),
      ]),
    ]),
    zoomedPaneId: 'pane-editor',
  })

  vi.mocked(api.post).mockResolvedValue({ forwardedPort: 45678 })

  const view = renderProviderHarness(store)

  await user.pointer({ target: screen.getByText('Tab One'), keys: '[MouseRight]' })
  await user.click(screen.getByRole('menuitem', { name: 'Refresh tab' }))

  expect(Object.keys(store.getState().panes.refreshRequestsByPane['tab-1'])).toEqual(['pane-browser-live'])

  store.dispatch(toggleZoom({ tabId: 'tab-1', paneId: 'pane-editor' }))

  await waitFor(() => {
    expect(api.post).toHaveBeenCalledTimes(1)
    expect(store.getState().panes.refreshRequestsByPane['tab-1']?.['pane-browser-live']).toBeUndefined()
  })

  vi.mocked(api.post).mockClear()
  view.unmount()
  renderProviderHarness(store)

  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
npx vitest run test/e2e/refresh-context-menu-flow.test.tsx
```

Expected: FAIL until Tasks 1-6 are complete.

**Step 3: Write minimal implementation**

Finish the store helpers and mocks so the test uses:

- the real tab context menu
- a zoomed tab whose refreshable browser sibling is unmounted when the request is created
- a blank browser sibling that proves no-op leaves are skipped
- the real browser mount/load path when the hidden pane becomes visible

Do not fake pane action registries for hidden panes; the point of the test is that layout state, not mounted registries, drives refresh.

**Step 4: Run test to verify it passes**

Run:

```bash
npx vitest run test/e2e/refresh-context-menu-flow.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e/refresh-context-menu-flow.test.tsx
git commit -m "test(ui): cover zoomed refresh context menu flow"
```

## Final Validation

Run the focused suites first:

```bash
npm run test:client -- test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/lib/pane-utils.test.ts test/unit/client/context-menu/menu-defs.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/panes/BrowserPane.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
npx vitest run test/e2e/refresh-context-menu-flow.test.tsx
```

Then run the repo gates:

```bash
npm run lint
npm test
```

Expected final state:

- Right-clicking a tab shows `Refresh tab`, enabled only when at least one leaf can actually refresh.
- Right-clicking a pane header, terminal content, or browser content shows `Refresh pane`.
- Keyboard opening the pane menu from the focusable pane shell (`Shift+F10` / context-menu key) shows `Refresh pane`.
- `Refresh Tab` queues refresh requests for hidden zoom siblings by walking the stored layout tree.
- Blank browser panes and unattached/exited terminals never advertise refresh and are skipped by `Refresh Tab`.
- Refresh requests are one-shot and ephemeral.
- Terminal requests target `createRequestId` and only run when a terminal session is still attached.
- Browser requests target `browserInstanceId`, so same-instance URL changes preserve the request while same-URL browser swaps clear it.
- Browser panes preserve live iframe reload when possible and only use recovery logic when the pane is on an error screen.
- Terminal panes perform exactly one detach/attach decision per refresh.

If `npm test` exposes additional type or fixture fallout from the new required `browserInstanceId`, fix those failures before rebasing or merging.

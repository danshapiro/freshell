# Same-Tab Monaco File Link Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Clicking a detected local file path in a terminal should open a fresh Monaco editor pane on the same tab and on the clicked pane's branch, instead of creating and navigating to a new tab.

**Architecture:** Preserve the current fresh-editor semantics and change only the container. `TerminalView` already has the clicked `tabId` and `paneId`, and `splitPane` already creates a sibling pane on the current tab, makes it active, and clears zoom so the new pane is visible. The implementation should therefore replace the file-link path's `addTab` + `initLayout` flow with a direct `splitPane({ tabId, paneId, ... })` dispatch and leave editor reuse, retargeting, and unsaved-buffer behavior out of scope.

**Tech Stack:** React 18, Redux Toolkit, xterm.js link providers, Monaco editor pane, Vitest, Testing Library

## Strategy Gate

- The user asked for "same tab instead of navigating," not for a new editor-ownership model. The cleanest path is to preserve today's "fresh editor per click" behavior and change only where it opens.
- The broader reuse-first design is riskier than the request requires. It introduces destructive overwrite behavior for existing editor panes and would require new product decisions around dirty buffers and file retargeting.
- `splitPane` is already the idiomatic primitive for "open a new sibling pane here." It targets an arbitrary pane, activates the new pane, preserves the surrounding tree, and clears zoom. That is exactly the behavior the requested change needs.
- Repeated terminal file-link clicks may still create multiple editor panes on the same tab. That matches the current fresh-editor semantics; the only intended behavior change in this plan is "same tab" instead of "new tab."
- No new pane reducer, no pane-tree helper, and no `EditorPane` retarget logic should be introduced for this feature.
- Proof still needs to live at the `TerminalView` boundary. Tests must fail if the implementation targets the active pane or uses a generic add-pane path instead of the clicked pane's `splitPane` path.
- No user decision is required. The minimal same-tab split is the direct implementation of the request with the lowest product risk.

---

### Task 1: Add the deterministic integrated regression first

**Files:**
- Create: `test/e2e/terminal-file-link-same-tab.test.tsx`

**Step 1: Write the failing integrated regression with a nested, non-active clicked pane**

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import TabContent from '@/components/TabContent'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  onReconnect: vi.fn().mockReturnValue(() => {}),
  setHelloExtensionProvider: vi.fn(),
}))

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(async (path: string) => {
    if (path === '/api/terminals') return []
    if (path === '/api/files/read?path=%2Ftmp%2Fexample.txt') {
      return {
        content: 'console.log(42)\n',
        language: 'typescript',
        filePath: '/tmp/example.txt',
      }
    }
    throw new Error(`Unexpected api.get path: ${path}`)
  }),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
    setHelloExtensionProvider: wsMocks.setHelloExtensionProvider,
  }),
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: apiMocks.get,
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

vi.mock('@/components/terminal/terminal-runtime', () => ({
  createTerminalRuntime: () => ({
    attachAddons: vi.fn(),
    fit: vi.fn(),
    findNext: vi.fn(() => false),
    findPrevious: vi.fn(() => false),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    webglActive: vi.fn(() => false),
    suspendWebgl: vi.fn(() => false),
    resumeWebgl: vi.fn(),
  }),
}))

vi.mock('@monaco-editor/react', () => {
  const MonacoMock = ({ value = '' }: { value?: string }) => (
    <textarea data-testid="monaco-mock" value={value} readOnly />
  )

  return {
    default: MonacoMock,
    Editor: MonacoMock,
  }
})

const linkProvidersByPaneId = new Map<string, {
  provideLinks: (line: number, callback: (links: any[] | undefined) => void) => void
}>()

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    paneId: string | null = null
    buffer = {
      active: {
        viewportY: 0,
        getLine: vi.fn(() => ({
          translateToString: () => '/tmp/example.txt',
        })),
      },
    }
    open = vi.fn((element: HTMLElement) => {
      this.paneId = element.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? null
    })
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn((provider: any) => {
      if (this.paneId) {
        linkProvidersByPaneId.set(this.paneId, provider)
      }
      return { dispose: vi.fn() }
    })
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    paste = vi.fn()
    reset = vi.fn()
    select = vi.fn()
    selectLines = vi.fn()
    scrollLines = vi.fn()
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function createTerminalContent(createRequestId: string, terminalId: string): TerminalPaneContent {
  return {
    kind: 'terminal',
    createRequestId,
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId,
    initialCwd: '/tmp',
  }
}

function createStore() {
  const clickedPaneId = 'pane-clicked'
  const layout: PaneNode = {
    type: 'split',
    id: 'split-root',
    direction: 'vertical',
    sizes: [45, 55],
    children: [
      {
        type: 'leaf',
        id: 'pane-left',
        content: createTerminalContent('req-left', 'term-left'),
      },
      {
        type: 'split',
        id: 'split-right',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          {
            type: 'leaf',
            id: 'pane-middle',
            content: createTerminalContent('req-middle', 'term-middle'),
          },
          {
            type: 'leaf',
            id: clickedPaneId,
            content: createTerminalContent('req-clicked', 'term-clicked'),
          },
        ],
      },
    ],
  }

  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: 'tab-1',
          createRequestId: 'req-left',
          title: 'Shell',
          status: 'running',
          mode: 'shell',
          shell: 'system',
          terminalId: 'term-left',
          createdAt: 1,
        }],
        activeTabId: 'tab-1',
        renameRequestTabId: null,
      },
      panes: {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-left' },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: { 'tab-1': clickedPaneId },
        refreshRequestsByPane: {},
      },
      settings: {
        settings: defaultSettings,
        loaded: true,
      },
      connection: {
        status: 'ready',
        platform: null,
        availableClis: {},
        featureFlags: {},
      },
    },
  })
}

describe('terminal file links open Monaco on the clicked pane branch without navigating tabs', () => {
  beforeEach(() => {
    apiMocks.get.mockClear()
    wsMocks.send.mockClear()
    wsMocks.connect.mockClear()
    wsMocks.onMessage.mockClear()
    wsMocks.onReconnect.mockClear()
    wsMocks.setHelloExtensionProvider.mockClear()
    linkProvidersByPaneId.clear()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps the same tab, clears zoom, and opens the editor off the clicked nested pane instead of the active pane', async () => {
    const store = createStore()

    render(
      <Provider store={store}>
        <TabContent tabId="tab-1" />
      </Provider>
    )

    await waitFor(() => {
      expect(linkProvidersByPaneId.has('pane-clicked')).toBe(true)
    })

    const clickedProvider = linkProvidersByPaneId.get('pane-clicked')!
    let links: any[] | undefined
    clickedProvider.provideLinks(1, (provided) => {
      links = provided
    })

    expect(links).toHaveLength(1)
    expect(links![0].text).toBe('/tmp/example.txt')

    links![0].activate()

    await waitFor(() => {
      expect(store.getState().tabs.tabs).toHaveLength(1)
      expect(store.getState().tabs.activeTabId).toBe('tab-1')
      expect(store.getState().panes.zoomedPane['tab-1']).toBeUndefined()
      expect(screen.getByTestId('monaco-mock')).toBeInTheDocument()
    })

    const root = store.getState().panes.layouts['tab-1']
    expect(root.type).toBe('split')
    if (root.type !== 'split') {
      throw new Error('expected root split layout')
    }

    expect(root.children[0]).toMatchObject({ type: 'leaf', id: 'pane-left' })

    const rightBranch = root.children[1]
    expect(rightBranch.type).toBe('split')
    if (rightBranch.type !== 'split') {
      throw new Error('expected right branch split layout')
    }

    expect(rightBranch.children[0]).toMatchObject({ type: 'leaf', id: 'pane-middle' })

    const clickedBranch = rightBranch.children[1]
    expect(clickedBranch.type).toBe('split')
    if (clickedBranch.type !== 'split') {
      throw new Error('expected clicked branch split layout')
    }

    expect(clickedBranch.children[0]).toMatchObject({ type: 'leaf', id: 'pane-clicked' })
    expect(clickedBranch.children[1]).toMatchObject({
      type: 'leaf',
      content: {
        kind: 'editor',
        filePath: '/tmp/example.txt',
      },
    })

    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledWith('/api/files/read?path=%2Ftmp%2Fexample.txt')
    })
  })
})
```

Notes for this harness:

- The provider map is the critical deterministic piece. It must key `registerLinkProvider()` by the `paneId` captured during `open(element)` so the test activates the clicked pane's own provider and not whichever terminal registered last.
- Preload `activePane['tab-1'] = 'pane-left'` and `zoomedPane['tab-1'] = 'pane-clicked'`. That makes the regression fail if the implementation targets the active pane or bypasses `splitPane` and therefore misses zoom clearing.
- The integrated test intentionally covers one click only. Reuse or overwrite behavior is out of scope for this feature and should not be locked in by this plan.

**Step 2: Run the new integrated regression to verify it fails**

Run: `npx vitest run test/e2e/terminal-file-link-same-tab.test.tsx`

Expected: FAIL because `TerminalView` still dispatches `addTab` + `initLayout`, which creates a second tab instead of splitting `pane-clicked` in place.

**Step 3: Commit the red integrated regression**

```bash
git add test/e2e/terminal-file-link-same-tab.test.tsx
git commit -m "test: add failing same-tab file-link integration regression"
```

### Task 2: Rewrite the stale unit regression and add a clicked-pane wiring proof

**Files:**
- Modify: `test/unit/client/components/TerminalView.keyboard.test.tsx`

**Step 1: Add a dedicated file-link store helper without changing the existing shared helper contract**

Leave the existing `createTestStore(terminalId?: string)` helper in place exactly as-is so all current positional callers, including the no-terminal-id regression, keep their current behavior.

Add this new helper below the existing shared helper:

```tsx
function createTerminalContent(createRequestId: string, terminalId?: string): TerminalPaneContent {
  return {
    kind: 'terminal',
    createRequestId,
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId,
    initialCwd: '/tmp',
  }
}

function createFileLinkTestStore(options: {
  tabId?: string
  paneId: string
  paneContent?: TerminalPaneContent
  layout: PaneNode
  activePaneId: string
}) {
  const tabId = options?.tabId ?? 'tab-1'
  const paneId = options.paneId
  const paneContent = options.paneContent ?? createTerminalContent('req-1', 'term-1')

  return {
    store: configureStore({
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
            mode: 'shell' as const,
            status: 'running' as const,
            title: 'Shell',
            titleSetByUser: false,
            createRequestId: paneContent.createRequestId,
            terminalId: paneContent.terminalId,
            createdAt: 1,
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: options.layout },
          activePane: { [tabId]: options.activePaneId },
          paneTitles: {},
        },
        settings: { settings: defaultSettings, status: 'loaded' as const },
        connection: { status: 'connected' as const, error: null },
      },
    }),
    tabId,
    paneId,
    paneContent,
  }
}
```

Why this helper split matters:

- The real file still has many positional `createTestStore(...)` callers that this plan does not otherwise touch.
- The existing `createTestStore(undefined)` regression must keep constructing a pane without a terminal id.
- The plan's later full-file test run should fail only on real regressions, not because the helper contract was silently changed under unrelated tests.

**Step 2: Replace the stale old-behavior test with a same-tab unit regression**

Replace:

```tsx
it('opens an editor tab when a detected local file link is activated', async () => {
```

with:

```tsx
it('opens an editor pane on the same tab when a detected local file link is activated', async () => {
  const { store, tabId, paneId, paneContent } = createTestStore('term-1')

  render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
    </Provider>
  )

  await waitFor(() => {
    expect(capturedLinkProvider).not.toBeNull()
  })

  let links: any[] | undefined
  capturedLinkProvider!.provideLinks(1, (provided) => {
    links = provided
  })

  expect(links).toHaveLength(1)
  expect(links![0].text).toBe('/tmp/example.txt')

  links![0].activate()

  const state = store.getState()
  expect(state.tabs.tabs).toHaveLength(1)
  expect(state.tabs.activeTabId).toBe(tabId)

  const layout = state.panes.layouts[tabId]
  expect(layout.type).toBe('split')
  if (layout.type !== 'split') {
    throw new Error('expected split layout')
  }

  expect(layout.children[0]).toMatchObject({ type: 'leaf', id: paneId })
  expect(layout.children[1]).toMatchObject({
    type: 'leaf',
    content: {
      kind: 'editor',
      filePath: '/tmp/example.txt',
      language: null,
      readOnly: false,
      content: '',
      viewMode: 'source',
    },
  })
})
```

**Step 3: Add a second unit regression that fails if the implementation uses the active pane or generic add-pane path**

Append this test in the same `describe('local file path links', ...)` block:

```tsx
it('targets the clicked pane instead of the active pane when the clicked terminal is not active', async () => {
  const activePaneId = 'pane-active'
  const clickedPaneId = 'pane-clicked'

  const activeContent = createTerminalContent('req-active', 'term-active')
  const clickedContent = createTerminalContent('req-clicked', 'term-clicked')

  const layout: PaneNode = {
    type: 'split',
    id: 'split-root',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      { type: 'leaf', id: activePaneId, content: activeContent },
      { type: 'leaf', id: clickedPaneId, content: clickedContent },
    ],
  }

  const { store, tabId } = createFileLinkTestStore({
    paneId: clickedPaneId,
    paneContent: clickedContent,
    layout,
    activePaneId,
  })

  render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={clickedPaneId} paneContent={clickedContent} />
    </Provider>
  )

  await waitFor(() => {
    expect(capturedLinkProvider).not.toBeNull()
  })

  let links: any[] | undefined
  capturedLinkProvider!.provideLinks(1, (provided) => {
    links = provided
  })

  links![0].activate()

  const root = store.getState().panes.layouts[tabId]
  expect(root.type).toBe('split')
  if (root.type !== 'split') {
    throw new Error('expected root split layout')
  }

  expect(root.children[0]).toMatchObject({ type: 'leaf', id: activePaneId })

  const clickedBranch = root.children[1]
  expect(clickedBranch.type).toBe('split')
  if (clickedBranch.type !== 'split') {
    throw new Error('expected clicked branch split layout')
  }

  expect(clickedBranch.children[0]).toMatchObject({ type: 'leaf', id: clickedPaneId })
  expect(clickedBranch.children[1]).toMatchObject({
    type: 'leaf',
    content: {
      kind: 'editor',
      filePath: '/tmp/example.txt',
    },
  })
})
```

Why this test matters:

- If the implementation accidentally looks up `activePane[tabId]`, it will split `pane-active` and this assertion fails.
- If the implementation falls back to a generic add-pane path, it will also split the active pane and fail.
- This keeps the proof at `TerminalView`, not in reducer-only tests that do not exercise the file-link activation code path.

**Step 4: Run the focused unit file to verify both regressions fail**

Run: `npx vitest run test/unit/client/components/TerminalView.keyboard.test.tsx -t "local file path links"`

Expected: FAIL because the current implementation still creates a new tab and leaves the current tab layout unchanged.

Then run the full unit file once to verify the harness refactor itself did not break unrelated tests:

Run: `npx vitest run test/unit/client/components/TerminalView.keyboard.test.tsx`

Expected: FAIL only in the new same-tab file-link assertions; existing non-file-link tests, including the no-terminal-id regression, should remain green.

**Step 5: Commit the red unit regressions**

```bash
git add test/unit/client/components/TerminalView.keyboard.test.tsx
git commit -m "test: rewrite file-link unit regressions for same-tab split"
```

### Task 3: Implement the minimal `TerminalView` fix on the existing split path

**Files:**
- Modify: `src/components/TerminalView.tsx`

**Step 1: Replace the file-link activation's new-tab flow with `splitPane` on the clicked pane**

Update the existing imports precisely:

```tsx
import { updateTab, switchToNextTab, switchToPrevTab } from '@/store/tabsSlice'
import { consumePaneRefreshRequest, splitPane, updatePaneContent, updatePaneTitle } from '@/store/panesSlice'
```

Notes:

- `paneRefreshTargetMatchesContent` is already imported from `@/lib/pane-utils`; do not touch that import.
- Remove only the obsolete file-link-specific `addTab` and `initLayout` imports.
- Keep the unrelated `nanoid()` call sites in `TerminalView.tsx`; they still serve attach and reconnect behavior.

Replace the file-link `activate()` body with:

```tsx
activate: () => {
  dispatch(splitPane({
    tabId,
    paneId,
    direction: 'horizontal',
    newContent: {
      kind: 'editor',
      filePath: m.path,
      language: null,
      readOnly: false,
      content: '',
      viewMode: 'source',
    },
  }))
},
```

Guardrails:

- Do not add a new pane reducer.
- Do not refactor `splitPane`.
- Do not change `addPane`.
- Do not touch `EditorPane`, browser-pane logic, pane persistence, or refresh-request logic.
- Do not add reuse, retarget, or dirty-buffer behavior to this feature. Preserve the current fresh-editor-per-click semantics; only change the container from new tab to same-tab split.

**Step 2: Run the focused unit regressions**

Run: `npx vitest run test/unit/client/components/TerminalView.keyboard.test.tsx -t "local file path links"`

Expected: PASS

**Step 3: Run the new integrated regression**

Run: `npx vitest run test/e2e/terminal-file-link-same-tab.test.tsx`

Expected: PASS

**Step 4: Commit the green implementation**

```bash
git add src/components/TerminalView.tsx
git commit -m "feat: open terminal file links in same-tab editor panes"
```

### Task 4: Verify the change at repo scope

**Files:**
- Verify only: `src/components/TerminalView.tsx`
- Verify only: `test/unit/client/components/TerminalView.keyboard.test.tsx`
- Verify only: `test/e2e/terminal-file-link-same-tab.test.tsx`

**Step 1: Run the two targeted regressions together one more time**

Run: `npx vitest run test/unit/client/components/TerminalView.keyboard.test.tsx test/e2e/terminal-file-link-same-tab.test.tsx`

Expected: PASS

**Step 2: Run repo-level typecheck + test verification**

Run: `npm run check`

Expected: PASS

If `npm run check` fails anywhere, stop and fix the failure before any merge or fast-forward attempt. Do not assume the failure is unrelated.

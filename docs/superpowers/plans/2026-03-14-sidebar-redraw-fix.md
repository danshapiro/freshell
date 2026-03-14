# Sidebar Redraw Fix Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the visible left-sidebar redraw/fill-in during background session refreshes by replacing the current index-keyed virtualized list with a keyed list that keeps unchanged rows mounted.

**Architecture:** Treat this as a client render-stability bug. The sidebar window is capped at 50 items per page, so the implementation should remove `react-window` from the sidebar path and render a normal keyed scroll container instead. Preserve the existing loading/search contract, preserve append pagination by moving the trigger from `onRowsRendered` to scroll/resize checks, and prove the fix with DOM-identity regressions that fail on current `main`.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Testing Library, Vitest, JSDOM.

---

## Guardrails

- Do not reopen the server/session-recency contract work. This plan only fixes the remaining client-side redraw.
- New regression coverage must exercise the real sidebar renderer. Do not mock `react-window` in the new failing tests.
- Preserve current behavior for:
  - initial empty loads showing blocking UI
  - silent background refreshes keeping loaded content visible
  - title search vs. server-backed search tiers
  - append pagination via `fetchSessionWindow({ append: true })`
- Existing sidebar suites that mock `react-window` stay in place unless the renderer swap breaks them. They are regression backstops for loading/search behavior, not the place to prove DOM identity.
- Keep scope tight. Do not churn package dependencies unless the implementation requires it.

## File Structure Map

- Create: `test/unit/client/components/Sidebar.dom-stability.test.tsx`
  - Purpose: real-renderer component regression that captures DOM node identity for unchanged sidebar rows across a store-driven refresh.
- Create: `test/e2e/sidebar-refresh-dom-stability.test.tsx`
  - Purpose: `App`-level regression for the production invalidation path (`sessions.changed` -> queued HTTP refresh -> sidebar update) without a virtual-list mock.
- Modify: `src/components/Sidebar.tsx`
  - Purpose: replace the `react-window` list with a keyed scroll container, preserve `SidebarItem` memoization, and move append pagination to scroll/resize-aware checks.
- Modify: `test/unit/client/components/Sidebar.test.tsx`
  - Purpose: align existing sidebar behavior coverage with the non-virtualized list and rewrite the pagination guard test around scroll-based loading.
- Modify: `test/unit/client/components/Sidebar.render-stability.test.tsx`
  - Purpose: remove stale `SidebarRow` assumptions and keep the value-comparator coverage aligned with the new renderer.

## Chunk 1: Lock the Failure With Real Renderer Tests

### Task 1: Add a component-level DOM identity regression

**Files:**
- Create: `test/unit/client/components/Sidebar.dom-stability.test.tsx`

- [ ] **Step 1: Write the failing real-renderer test**

```tsx
// In this new file, copy only the minimal store/render harness from
// Sidebar.test.tsx (keeping the helper naming close to createTestStore /
// renderSidebar so it is recognizable). Do not import helpers from that file,
// and do not add a react-window mock anywhere in the file.

it('keeps unchanged sidebar rows mounted across a silent window refresh', () => {
  const store = createSidebarStore({
    projects: [
      {
        projectPath: '/proj',
        sessions: [
          { provider: 'codex', sessionId: 'stable-a', projectPath: '/proj', lastActivityAt: 40, title: 'Stable A' },
          { provider: 'codex', sessionId: 'stable-b', projectPath: '/proj', lastActivityAt: 30, title: 'Stable B' },
        ],
      },
    ],
  })

  renderSidebar(store)

  const stableAButton = screen.getByRole('button', { name: /Stable A/i })
  const stableBButton = screen.getByRole('button', { name: /Stable B/i })

  act(() => {
    store.dispatch(setSessionWindowData({
      surface: 'sidebar',
      projects: [
        {
          projectPath: '/proj',
          sessions: [
            { provider: 'codex', sessionId: 'new-top', projectPath: '/proj', lastActivityAt: 50, title: 'New Top' },
            { provider: 'codex', sessionId: 'stable-a', projectPath: '/proj', lastActivityAt: 40, title: 'Stable A' },
            { provider: 'codex', sessionId: 'stable-b', projectPath: '/proj', lastActivityAt: 30, title: 'Stable B' },
          ],
        },
      ],
      totalSessions: 3,
      oldestLoadedTimestamp: 30,
      oldestLoadedSessionId: 'codex:stable-b',
      hasMore: false,
    }))
  })

  expect(screen.getByRole('button', { name: /Stable A/i })).toBe(stableAButton)
  expect(screen.getByRole('button', { name: /Stable B/i })).toBe(stableBButton)
})
```

- [ ] **Step 2: Run the new unit test to verify it fails on current `main`**

Run: `npm run test:vitest -- test/unit/client/components/Sidebar.dom-stability.test.tsx`

Expected: FAIL because the current `react-window` sidebar recycles the visible rows by index, so at least one unchanged session button is replaced after the reorder.

- [ ] **Step 3: Commit the red test**

```bash
git add test/unit/client/components/Sidebar.dom-stability.test.tsx
git commit -m "test: capture sidebar row remount on refresh"
```

### Task 2: Add an App-level invalidation-path regression

**Files:**
- Create: `test/e2e/sidebar-refresh-dom-stability.test.tsx`

- [ ] **Step 1: Write the failing `App` regression against the real refresh chain**

```tsx
// Reuse the websocket/app harness shape from
// test/e2e/open-tab-session-sidebar-visibility.test.tsx, but in a new file
// with no react-window mock. Preload the sidebar window so App does not do a
// bootstrap sidebar fetch before the invalidation under test, and carry over
// the existing _resetSessionWindowThunkState() cleanup from that harness.

it('keeps unchanged sidebar rows mounted when sessions.changed triggers a background refresh', async () => {
  fetchSidebarSessionsSnapshot.mockResolvedValueOnce({
    projects: [
      {
        projectPath: '/proj',
        sessions: [
          { provider: 'codex', sessionId: 'new-top', projectPath: '/proj', lastActivityAt: 50, title: 'New Top' },
          { provider: 'codex', sessionId: 'stable-a', projectPath: '/proj', lastActivityAt: 40, title: 'Stable A' },
          { provider: 'codex', sessionId: 'stable-b', projectPath: '/proj', lastActivityAt: 30, title: 'Stable B' },
        ],
      },
    ],
    totalSessions: 3,
    oldestIncludedTimestamp: 30,
    oldestIncludedSessionId: 'codex:stable-b',
    hasMore: false,
  })

  const store = createStore({
    sessions: {
      projects: [
        {
          projectPath: '/proj',
          sessions: [
            { provider: 'codex', sessionId: 'stable-a', projectPath: '/proj', lastActivityAt: 40, title: 'Stable A' },
            { provider: 'codex', sessionId: 'stable-b', projectPath: '/proj', lastActivityAt: 30, title: 'Stable B' },
          ],
        },
      ],
      activeSurface: 'sidebar',
      lastLoadedAt: Date.now(),
      windows: {
        sidebar: {
          projects: [
            {
              projectPath: '/proj',
              sessions: [
                { provider: 'codex', sessionId: 'stable-a', projectPath: '/proj', lastActivityAt: 40, title: 'Stable A' },
                { provider: 'codex', sessionId: 'stable-b', projectPath: '/proj', lastActivityAt: 30, title: 'Stable B' },
              ],
            },
          ],
          lastLoadedAt: Date.now(),
          hasMore: false,
        },
      },
    },
  })

  render(<Provider store={store}><App /></Provider>)

  act(() => {
    broadcastWs({
      type: 'ready',
      timestamp: new Date().toISOString(),
      serverInstanceId: 'srv-local',
    })
  })

  await waitFor(() => {
    expect(store.getState().connection.status).toBe('ready')
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(0)
  })

  const stableAButton = screen.getByRole('button', { name: /Stable A/i })

  act(() => {
    broadcastWs({ type: 'sessions.changed', revision: 7 })
  })

  await waitFor(() => {
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: /New Top/i })).toBeInTheDocument()
  })

  expect(screen.getByRole('button', { name: /Stable A/i })).toBe(stableAButton)
})
```

- [ ] **Step 2: Run the invalidation regression to verify it fails**

Run: `npm run test:vitest -- test/e2e/sidebar-refresh-dom-stability.test.tsx`

Expected: FAIL on the final DOM-identity assertion after these preconditions are true:
- the preloaded sidebar rendered without an initial bootstrap fetch
- `sessions.changed` triggered exactly one background fetch
- the refreshed snapshot rendered `New Top`

- [ ] **Step 3: Commit the second red test**

```bash
git add test/e2e/sidebar-refresh-dom-stability.test.tsx
git commit -m "test: capture sidebar redraw during invalidation refresh"
```

## Chunk 2: Replace the Sidebar Renderer, Not the Data Contract

Write Task 4's new pagination/search/render-stability regressions first, run the combined Chunk 2 test pack red, then make the `Sidebar.tsx` renderer changes in Task 3 until the same pack goes green.

### Task 3: Remove `react-window` from the sidebar path and render keyed rows

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Test: `test/unit/client/components/Sidebar.dom-stability.test.tsx`
- Test: `test/e2e/sidebar-refresh-dom-stability.test.tsx`

- [ ] **Step 1: Replace the virtualized list with a keyed scroll container**

```tsx
const listRef = useRef<HTMLDivElement | null>(null) // replaces listContainerRef

<div
  ref={listRef}
  data-testid="sidebar-session-list"
  className="h-full overflow-y-auto"
  onScroll={handleListScroll}
>
  {sortedItems.map((item) => {
    const sessionKey = `${item.provider}:${item.sessionId}`
    const isActive = computeIsActive({
      isRunning: item.isRunning,
      runningTerminalId: item.runningTerminalId,
      sessionKey,
      activeSessionKey,
      activeTerminalId,
    })

    return (
      <div key={sessionKey} className="pb-0.5">
        <SidebarItem
          item={item}
          isActiveTab={isActive}
          showProjectBadge={settings.sidebar?.showProjectBadges}
          onClick={() => handleItemClick(item)}
          timestampTick={timestampTick}
        />
      </div>
    )
  })}
</div>
```

- [ ] **Step 2: Remove now-dead virtual-list machinery**

```ts
// Delete from Sidebar.tsx once the keyed list is in place:
// - react-window imports
// - RowComponentProps / SidebarRow
// - listContainerRef and the height-measurement ResizeObserver effect
// - listHeight / effectiveListHeight / SESSION_LIST_MAX_HEIGHT if they become dead
// - onRowsRendered wiring
```

- [ ] **Step 3: Preserve append pagination with scroll and resize checks**

```tsx
const sidebarHasMore = sidebarWindow?.hasMore ?? false
const sidebarOldestLoadedTimestamp = sidebarWindow?.oldestLoadedTimestamp
const sidebarOldestLoadedSessionId = sidebarWindow?.oldestLoadedSessionId
const localQuery = filter.trim()
const committedQuery = (sidebarWindow?.query ?? '').trim()
const hasActiveQuery = localQuery.length > 0 || committedQuery.length > 0

const requestSidebarAppend = useCallback(() => {
  if (!sidebarHasMore || sidebarWindow?.loading || loadMoreInFlightRef.current) return
  if (sidebarOldestLoadedTimestamp == null || sidebarOldestLoadedSessionId == null) return
  if (hasActiveQuery) return

  loadMoreInFlightRef.current = true
  void dispatch(fetchSessionWindow({
    surface: 'sidebar',
    priority: 'visible',
    append: true,
  }) as any)

  if (loadMoreTimeoutRef.current) clearTimeout(loadMoreTimeoutRef.current)
  loadMoreTimeoutRef.current = setTimeout(() => {
    loadMoreInFlightRef.current = false
  }, 15_000)
}, [
  dispatch,
  hasActiveQuery,
  sidebarHasMore,
  sidebarOldestLoadedTimestamp,
  sidebarOldestLoadedSessionId,
  sidebarWindow?.loading,
])

const maybeBackfillViewport = useCallback(() => {
  const list = listRef.current
  if (!list) return
  if (list.clientHeight <= 0 || list.scrollHeight <= 0) return
  const underfilledViewport = list.scrollHeight <= list.clientHeight
  if (!underfilledViewport) return
  requestSidebarAppend()
}, [requestSidebarAppend])

const handleListScroll = useCallback(() => {
  const list = listRef.current
  if (!list) return
  const remaining = list.scrollHeight - (list.scrollTop + list.clientHeight)
  const nearBottom = remaining <= SESSION_ITEM_HEIGHT * 10
  if (!nearBottom) return
  requestSidebarAppend()
}, [requestSidebarAppend])

useEffect(() => {
  maybeBackfillViewport()
}, [
  maybeBackfillViewport,
  sortedItems.length,
  sidebarWindow?.lastLoadedAt,
  sidebarWindow?.oldestLoadedTimestamp,
  sidebarWindow?.oldestLoadedSessionId,
  sidebarWindow?.hasMore,
  sidebarWindow?.loading,
])

useEffect(() => {
  const list = listRef.current
  if (!list || typeof ResizeObserver === 'undefined') return
  const observer = new ResizeObserver(() => maybeBackfillViewport())
  observer.observe(list)
  return () => observer.disconnect()
}, [maybeBackfillViewport])

useEffect(() => {
  if (!sidebarWindow?.loading) {
    loadMoreInFlightRef.current = false
    if (loadMoreTimeoutRef.current) clearTimeout(loadMoreTimeoutRef.current)
    loadMoreTimeoutRef.current = null
  }
}, [sidebarWindow?.loading])

// Keep the timeout and unmount cleanup, but make all append-guard state derive
// from windows.sidebar rather than top-level active-surface mirrors.
```

- [ ] **Step 4: After Task 4's regressions are written, run the full Chunk 2 pack red**

Run:

```bash
npm run test:vitest -- \
  test/unit/client/components/Sidebar.dom-stability.test.tsx \
  test/e2e/sidebar-refresh-dom-stability.test.tsx \
  test/unit/client/components/Sidebar.test.tsx \
  test/unit/client/components/Sidebar.render-stability.test.tsx
```

Expected: FAIL before the renderer swap, covering DOM identity plus the new pagination/search/render-stability regressions.

- [ ] **Step 5: Implement the keyed-list renderer and behavior fixes until the same Chunk 2 pack passes**

```bash
npm run test:vitest -- \
  test/unit/client/components/Sidebar.dom-stability.test.tsx \
  test/e2e/sidebar-refresh-dom-stability.test.tsx \
  test/unit/client/components/Sidebar.test.tsx \
  test/unit/client/components/Sidebar.render-stability.test.tsx
```

- [ ] **Step 6: Hold the green commit until Task 4 and the render-stability cleanup are green**

### Task 4: Keep the existing sidebar behavior contract intact

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Test: `test/unit/client/components/Sidebar.test.tsx`
- Test: `test/unit/client/components/Sidebar.render-stability.test.tsx`

- [ ] **Step 1: Add small test helpers for sidebar list geometry and near-bottom scroll**

```tsx
function setSidebarListGeometry(node: HTMLElement, geometry: { clientHeight: number; scrollHeight: number; scrollTop: number }) {
  Object.defineProperty(node, 'clientHeight', { configurable: true, value: geometry.clientHeight })
  Object.defineProperty(node, 'scrollHeight', { configurable: true, value: geometry.scrollHeight })
  Object.defineProperty(node, 'scrollTop', { configurable: true, value: geometry.scrollTop, writable: true })
}

function triggerNearBottomScroll(node: HTMLElement, geometry: { clientHeight: number; scrollHeight: number }) {
  setSidebarListGeometry(node, {
    clientHeight: geometry.clientHeight,
    scrollHeight: geometry.scrollHeight,
    scrollTop: geometry.scrollHeight - geometry.clientHeight,
  })
  fireEvent.scroll(node)
}
```

- [ ] **Step 2: Add a positive scroll-trigger regression for the new list**

```tsx
it('starts append pagination when the loaded sidebar is scrolled near the bottom', async () => {
  // Use try/finally in the real test so prototype spies always restore.
  const geometry = { clientHeight: 560, scrollHeight: 1120, scrollTop: 0 }
  const clientHeightSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => geometry.clientHeight)
  const scrollHeightSpy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => geometry.scrollHeight)
  const scrollTopGetterSpy = vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => geometry.scrollTop)

  mockFetchSidebarSessionsSnapshot.mockResolvedValueOnce({
    projects: [{
      projectPath: '/older',
      sessions: [{
        provider: 'codex',
        sessionId: 'older-session',
        projectPath: '/older',
        lastActivityAt: 10,
        title: 'Older Session',
      }],
    }],
    totalSessions: 2,
    oldestIncludedTimestamp: 10,
    oldestIncludedSessionId: 'codex:older-session',
    hasMore: false,
  })

  const store = createTestStore({
    projects: [{
      projectPath: '/recent',
      sessions: [{
        provider: 'codex',
        sessionId: 'recent-session',
        projectPath: '/recent',
        lastActivityAt: 20,
        title: 'Recent Session',
      }],
    }],
    sessions: {
      activeSurface: 'sidebar',
      projects: [{
        projectPath: '/recent',
        sessions: [{
          provider: 'codex',
          sessionId: 'recent-session',
          projectPath: '/recent',
          lastActivityAt: 20,
          title: 'Recent Session',
        }],
      }],
      lastLoadedAt: 1_700_000_000_000,
      hasMore: true,
      oldestLoadedTimestamp: 20,
      oldestLoadedSessionId: 'codex:recent-session',
      windows: {
        sidebar: {
          projects: [{
            projectPath: '/recent',
            sessions: [{
              provider: 'codex',
              sessionId: 'recent-session',
              projectPath: '/recent',
              lastActivityAt: 20,
              title: 'Recent Session',
            }],
          }],
          lastLoadedAt: 1_700_000_000_000,
          hasMore: true,
          oldestLoadedTimestamp: 20,
          oldestLoadedSessionId: 'codex:recent-session',
          loading: false,
          query: '',
          searchTier: 'title',
        },
      },
    },
  })

  renderSidebar(store)
  expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(0)

  const list = screen.getByTestId('sidebar-session-list')
  triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })

  await waitFor(() => {
    expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      limit: 50,
      before: 20,
      beforeId: 'codex:recent-session',
      signal: expect.any(AbortSignal),
    }))
  })
  await waitFor(() => {
    expect(screen.getByText('Older Session')).toBeInTheDocument()
  })
  expect(screen.getByText('Recent Session')).toBeInTheDocument()

  clientHeightSpy.mockRestore()
  scrollHeightSpy.mockRestore()
  scrollTopGetterSpy.mockRestore()
})
```

- [ ] **Step 3: Add a positive resize-trigger regression for an underfilled viewport**

```tsx
it('starts append pagination when a loaded sidebar is shorter than the viewport', async () => {
  // Use try/finally in the real test so prototype/global stubs always restore.
  const resizeCallbacks: Array<() => void> = []
  class MockResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallbacks.push(() => callback([], this as unknown as ResizeObserver))
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver)

  const geometry = { clientHeight: 560, scrollHeight: 1120, scrollTop: 0 }
  const clientHeightSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => geometry.clientHeight)
  const scrollHeightSpy = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => geometry.scrollHeight)
  const scrollTopGetterSpy = vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(() => geometry.scrollTop)

  mockFetchSidebarSessionsSnapshot.mockResolvedValueOnce({
    projects: [{
      projectPath: '/older',
      sessions: [{
        provider: 'codex',
        sessionId: 'older-session',
        projectPath: '/older',
        lastActivityAt: 10,
        title: 'Older Session',
      }],
    }],
    totalSessions: 2,
    oldestIncludedTimestamp: 10,
    oldestIncludedSessionId: 'codex:older-session',
    hasMore: false,
  })

  const store = createTestStore({
    projects: [{
      projectPath: '/recent',
      sessions: [{
        provider: 'codex',
        sessionId: 'recent-session',
        projectPath: '/recent',
        lastActivityAt: 20,
        title: 'Recent Session',
      }],
    }],
    sessions: {
      activeSurface: 'sidebar',
      projects: [{
        projectPath: '/recent',
        sessions: [{
          provider: 'codex',
          sessionId: 'recent-session',
          projectPath: '/recent',
          lastActivityAt: 20,
          title: 'Recent Session',
        }],
      }],
      lastLoadedAt: 1_700_000_000_000,
      hasMore: true,
      oldestLoadedTimestamp: 20,
      oldestLoadedSessionId: 'codex:recent-session',
      windows: {
        sidebar: {
          projects: [{
            projectPath: '/recent',
            sessions: [{
              provider: 'codex',
              sessionId: 'recent-session',
              projectPath: '/recent',
              lastActivityAt: 20,
              title: 'Recent Session',
            }],
          }],
          lastLoadedAt: 1_700_000_000_000,
          hasMore: true,
          oldestLoadedTimestamp: 20,
          oldestLoadedSessionId: 'codex:recent-session',
          loading: false,
          query: '',
          searchTier: 'title',
        },
      },
    },
  })

  renderSidebar(store)
  expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(0)

  geometry.scrollHeight = 112
  await act(async () => {
    resizeCallbacks.forEach((callback) => callback())
    await Promise.resolve()
  })

  await waitFor(() => {
    expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      limit: 50,
      before: 20,
      beforeId: 'codex:recent-session',
      signal: expect.any(AbortSignal),
    }))
  })
  await waitFor(() => {
    expect(screen.getByText('Older Session')).toBeInTheDocument()
  })
  expect(screen.getByText('Recent Session')).toBeInTheDocument()

  clientHeightSpy.mockRestore()
  scrollHeightSpy.mockRestore()
  scrollTopGetterSpy.mockRestore()
  vi.unstubAllGlobals()
})
```

- [ ] **Step 4: Add a repeated underfill regression so backfill continues until the viewport is filled or `hasMore` clears**

```tsx
it('keeps backfilling while append pages remain shorter than the viewport', async () => {
  mockFetchSidebarSessionsSnapshot
    .mockResolvedValueOnce({
      projects: [{ projectPath: '/older', sessions: [{ provider: 'codex', sessionId: 'older-session-1', projectPath: '/older', lastActivityAt: 10, title: 'Older Session 1' }] }],
      totalSessions: 3,
      oldestIncludedTimestamp: 9,
      oldestIncludedSessionId: 'codex:older-session-1',
      hasMore: true,
    })
    .mockResolvedValueOnce({
      projects: [{ projectPath: '/older', sessions: [{ provider: 'codex', sessionId: 'older-session-2', projectPath: '/older', lastActivityAt: 8, title: 'Older Session 2' }] }],
      totalSessions: 4,
      oldestIncludedTimestamp: 8,
      oldestIncludedSessionId: 'codex:older-session-2',
      hasMore: false,
    })

  renderSidebar(store)
  triggerResizeBackfill()

  await screen.findByText('Older Session 1')
  await screen.findByText('Older Session 2')
  expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(2)
})
```

- [ ] **Step 5: Add a searched-sidebar regression so append never runs for restored search results**

```tsx
it('does not append while the sidebar window is showing committed search results', async () => {
  const store = createTestStore({
    sessions: {
      activeSurface: 'sidebar',
      windows: {
        sidebar: {
          projects: [{ projectPath: '/search', sessions: [{ provider: 'codex', sessionId: 'search-session', projectPath: '/search', lastActivityAt: 20, title: 'Search Result' }] }],
          lastLoadedAt: 1_700_000_000_000,
          hasMore: true,
          oldestLoadedTimestamp: 20,
          oldestLoadedSessionId: 'codex:search-session',
          loading: false,
          query: 'search',
          searchTier: 'title',
        },
      },
    },
  })

  renderSidebar(store)
  const list = screen.getByTestId('sidebar-session-list')
  triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })

  expect(mockFetchSidebarSessionsSnapshot).not.toHaveBeenCalled()
})
```

- [ ] **Step 6: Add a local-search regression so append stays suppressed during the debounce window**

```tsx
it('does not append while the user has typed an uncommitted sidebar search query', async () => {
  const store = createTestStore({
    sessions: {
      activeSurface: 'sidebar',
      windows: {
        sidebar: {
          projects: [{ projectPath: '/recent', sessions: [{ provider: 'codex', sessionId: 'recent-session', projectPath: '/recent', lastActivityAt: 20, title: 'Recent Session' }] }],
          lastLoadedAt: 1_700_000_000_000,
          hasMore: true,
          oldestLoadedTimestamp: 20,
          oldestLoadedSessionId: 'codex:recent-session',
          loading: false,
          query: '',
          searchTier: 'title',
        },
      },
    },
  })

  renderSidebar(store)
  fireEvent.change(screen.getByPlaceholderText('Search...'), { target: { value: 'search' } })

  const list = screen.getByTestId('sidebar-session-list')
  triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })

  expect(mockFetchSidebarSessionsSnapshot).not.toHaveBeenCalled()
})
```

- [ ] **Step 7: Add a sidebar-window-local append-guard regression**

```tsx
it('releases the sidebar append guard even when another session surface is active', async () => {
  mockFetchSidebarSessionsSnapshot
    .mockResolvedValueOnce({
      projects: [{
        projectPath: '/older',
        sessions: [{
          provider: 'codex',
          sessionId: 'older-session-1',
          projectPath: '/older',
          lastActivityAt: 10,
          title: 'Older Session 1',
        }],
      }],
      totalSessions: 3,
      oldestIncludedTimestamp: 9,
      oldestIncludedSessionId: 'codex:older-session-1',
      hasMore: true,
    })
    .mockResolvedValueOnce({
      projects: [{
        projectPath: '/older',
        sessions: [{
          provider: 'codex',
          sessionId: 'older-session-2',
          projectPath: '/older',
          lastActivityAt: 8,
          title: 'Older Session 2',
        }],
      }],
      totalSessions: 4,
      oldestIncludedTimestamp: 8,
      oldestIncludedSessionId: 'codex:older-session-2',
      hasMore: false,
    })

  const store = createTestStore({
    sessions: {
      activeSurface: 'history',
      windows: {
        sidebar: {
          projects: [{ projectPath: '/recent', sessions: [{ provider: 'codex', sessionId: 'recent-session', projectPath: '/recent', lastActivityAt: 20, title: 'Recent Session' }] }],
          lastLoadedAt: 1_700_000_000_000,
          hasMore: true,
          oldestLoadedTimestamp: 20,
          oldestLoadedSessionId: 'codex:recent-session',
          loading: false,
          query: '',
          searchTier: 'title',
        },
        history: {
          projects: [],
          lastLoadedAt: 1_700_000_000_000,
          loading: false,
        },
      },
    },
  })

  renderSidebar(store)
  const list = screen.getByTestId('sidebar-session-list')

  triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })
  await waitFor(() => {
    expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
  })
  await screen.findByText('Older Session 1')

  triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })
  await waitFor(() => {
    expect(mockFetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(2)
  })
  await screen.findByText('Older Session 2')
})
```

- [ ] **Step 8: Rewrite the old pagination guard test to use scroll-based triggering**

```tsx
it('does not start append pagination while the sidebar is already refreshing', async () => {
  const store = createTestStore({
    projects: [{
      projectPath: '/recent',
      sessions: [{
        provider: 'codex',
        sessionId: 'recent-session',
        projectPath: '/recent',
        lastActivityAt: 20,
        title: 'Recent Session',
      }],
    }],
    sessions: {
      activeSurface: 'sidebar',
      projects: [{
        projectPath: '/recent',
        sessions: [{
          provider: 'codex',
          sessionId: 'recent-session',
          projectPath: '/recent',
          lastActivityAt: 20,
          title: 'Recent Session',
        }],
      }],
      lastLoadedAt: 1_700_000_000_000,
      hasMore: true,
      oldestLoadedTimestamp: 20,
      oldestLoadedSessionId: 'codex:recent-session',
      windows: {
        sidebar: {
          projects: [{
            projectPath: '/recent',
            sessions: [{
              provider: 'codex',
              sessionId: 'recent-session',
              projectPath: '/recent',
              lastActivityAt: 20,
              title: 'Recent Session',
            }],
          }],
          lastLoadedAt: 1_700_000_000_000,
          hasMore: true,
          oldestLoadedTimestamp: 20,
          oldestLoadedSessionId: 'codex:recent-session',
          loading: true,
          query: '',
          searchTier: 'title',
        },
      },
    },
  })

  renderSidebar(store)

  const list = screen.getByTestId('sidebar-session-list')
  triggerNearBottomScroll(list, { clientHeight: 560, scrollHeight: 1120 })

  expect(mockFetchSidebarSessionsSnapshot).not.toHaveBeenCalled()
})
```

- [ ] **Step 9: Delete the obsolete `SidebarRow` block in `Sidebar.render-stability.test.tsx` now, before the green Chunk 2 run**

```tsx
// Remove:
describe('Row component stability', () => {
  it('SidebarRow is exported at module scope (not recreated per render)', async () => {
    const { SidebarRow } = await import('@/components/Sidebar')
    expect(typeof SidebarRow).toBe('function')
  })
})
```

- [ ] **Step 10: Update existing list-mounted assertions to target the new list container and remove dead virtualization scaffolding from the file**

```tsx
expect(screen.getByTestId('sidebar-session-list')).toBeInTheDocument()
expect(screen.queryByTestId('sidebar-session-list')).not.toBeInTheDocument()

// Remove once the scroll-based tests replace it:
// - latestOnRowsRendered
// - the vi.mock('react-window', ...) block
```

- [ ] **Step 11: Run the sidebar behavior suite**

Run: `npm run test:vitest -- test/unit/client/components/Sidebar.test.tsx`

Expected: PASS, proving the loading/search/pagination behavior stayed intact after removing virtualization.

- [ ] **Step 12: Commit the green renderer + regression state**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.dom-stability.test.tsx test/e2e/sidebar-refresh-dom-stability.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx
git commit -m "fix: replace sidebar virtual list with keyed rows"
```

## Chunk 3: Verify Broadly

### Task 5: Run focused regression coverage, then the coordinated full suite

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `test/unit/client/components/Sidebar.dom-stability.test.tsx`
- Modify: `test/e2e/sidebar-refresh-dom-stability.test.tsx`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/Sidebar.render-stability.test.tsx`
- Test: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

- [ ] **Step 1: Run the focused sidebar regression pack**

Run:

```bash
npm run test:vitest -- \
  test/unit/client/components/Sidebar.dom-stability.test.tsx \
  test/e2e/sidebar-refresh-dom-stability.test.tsx \
  test/e2e/open-tab-session-sidebar-visibility.test.tsx \
  test/unit/client/components/Sidebar.test.tsx \
  test/unit/client/components/Sidebar.render-stability.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run static verification**

Run:

```bash
npm run lint
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the coordinated full suite before landing**

Run:

```bash
FRESHELL_TEST_SUMMARY="sidebar redraw keyed list" npm test
```

Expected: PASS after waiting for the shared test coordinator gate if needed.

- [ ] **Step 4: Commit the final verified state**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.dom-stability.test.tsx test/e2e/sidebar-refresh-dom-stability.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx
git commit -m "fix: keep sidebar rows stable during refresh"
```

## Verification Checklist

- [ ] The new component-level regression fails before the renderer change and passes afterward.
- [ ] The new `App` invalidation regression fails before the renderer change and passes afterward.
- [ ] Background refreshes keep unchanged sidebar row DOM nodes mounted.
- [ ] Initial empty loads still show blocking UI.
- [ ] Loaded sidebar/search views still stay visible during silent background work.
- [ ] Append pagination still fires from both trigger paths: near-bottom scroll and underfilled viewport/resize.
- [ ] Search results never append just because the sidebar was restored with `sidebarWindow.query`.
- [ ] Typing into the sidebar search box suppresses append before the debounced search commits.
- [ ] Append pagination still unlocks correctly even when `activeSurface` is not `'sidebar'`.
- [ ] Append pagination still stays idle while the sidebar is already refreshing.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.

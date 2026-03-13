# Sidebar Silent Refresh Search Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Make sidebar websocket refreshes silent and non-jumping while still showing visible `Searching...` feedback for user-requested search actions that are still in flight.

**Architecture:** Keep the server-side invalidation boundary unchanged and fix this entirely in the client session-window layer. Introduce an explicit per-window loading kind so the store can distinguish first-load blocking, user-driven search loading, and silent background refreshes, then render search feedback inline in the search control instead of as a layout-shifting status row.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Vitest, Testing Library

---

## Strategy Gate

The last fix solved the blank-panel bug but kept one bad assumption: every in-flight sidebar request is treated as the same visible `loading` state. That is why a background `sessions.changed` invalidation against an already loaded query still renders `Searching...`, and why the sidebar jumps when the inline status row mounts.

The simplest correct path is narrower than another server round:

- Leave `App.tsx`, websocket semantics, and the server-side session-directory comparator alone.
- Keep the existing single-request / queued-invalidation fetch orchestration in `src/store/sessionsThunks.ts`.
- Make request intent explicit in the client state so UI can tell the difference between:
  - first load with no committed data
  - user-requested search or search-context change
  - silent background refresh or pagination
- Remove the in-flow refresh row from `Sidebar.tsx`; visible search feedback should live inside fixed chrome so layout height does not change.

Important behavioral decisions:

- `Searching...` is only for user-requested search work, including search-tier changes and clearing a non-empty query back to the default list.
- Websocket invalidations must stay silent even when they are revalidating an active query.
- Initial load with no committed data may still block with `Loading sessions...`.
- Load-more pagination stays silent; its correctness guard is concurrency control, not visible status text.
- No server files should change for this follow-up unless implementation proves the current invalidation boundary is still wrong. Based on current code, it is not.

Rejected approaches:

- Reopening the server-side `sessions.changed` filter. The current regression is now in client request presentation, not invalidation semantics.
- Reusing `loading` alone and inferring UI from `query`. Background revalidation of an active query already proves that is insufficient.
- Keeping the status row and only restyling it. Any in-flow row still changes layout and preserves the jump.
- Adding a broad new global loading system. The problem is local to session-window state for the sidebar/history surfaces.

Implementation invariants:

- Background invalidations still trigger HTTP revalidation and still coalesce.
- A loaded sidebar or loaded empty state stays mounted while any non-initial refresh is in flight.
- User-driven search state remains visible until the latest search-context request settles.
- No visible `Updating sessions...` row remains in the sidebar.
- Existing append/load-more overlap guards still work.
- Tests must cover both loaded default-list and loaded active-search invalidation paths, because the regression escaped once already.

### Task 1: Lock the intended client behavior with failing tests

**Files:**
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

**Step 1: Add the failing thunk intent test**

Extend `test/unit/client/store/sessionsThunks.test.ts` with one focused test that proves the store distinguishes user search from background invalidation:

```ts
it('marks websocket query revalidation as silent but keeps explicit query changes visible', async () => {
  const deferred = createDeferred<any>()
  searchSessions.mockReturnValueOnce(deferred.promise)
  fetchSidebarSessionsSnapshot.mockResolvedValue({
    projects: [],
    totalSessions: 0,
    oldestIncludedTimestamp: 0,
    oldestIncludedSessionId: '',
    hasMore: false,
  })

  const store = createStore()
  store.dispatch(setActiveSessionSurface('sidebar'))

  const direct = store.dispatch(fetchSessionWindow({
    surface: 'sidebar',
    priority: 'visible',
    query: 'needle',
    searchTier: 'fullText',
  }) as any)

  expect(store.getState().sessions.windows.sidebar.loadingKind).toBe('search')

  deferred.resolve({ results: [], tier: 'fullText', query: 'needle', totalScanned: 0 })
  await direct

  const queued = store.dispatch(queueActiveSessionWindowRefresh() as any)
  expect(store.getState().sessions.windows.sidebar.loadingKind).toBe('background')
  await queued
})
```

This should fail first because `loadingKind` does not exist yet and background invalidation still reuses the visible loading path.

**Step 2: Run the thunk test and verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/store/sessionsThunks.test.ts
```

Expected: FAIL with missing state/assertions around `loadingKind` or equivalent request-intent metadata.

**Step 3: Replace the current wrong Sidebar expectations with the desired render contract**

Update `test/unit/client/components/Sidebar.test.tsx` so these cases are explicit:

- loaded non-search sidebar plus `loadingKind: 'background'` keeps rows visible and does not render `sessions-refreshing`
- loaded search results plus `loadingKind: 'background'` keeps results visible and does not render `search-loading`
- loaded search results plus `loadingKind: 'search'` keeps results visible and does render `search-loading`
- first-load query plus `loadingKind: 'initial'` still blocks with `Loading sessions...` or `Searching...`

Use state like:

```ts
windows: {
  sidebar: {
    projects: searchProjects,
    lastLoadedAt: 1_700_000_000_000,
    loading: true,
    loadingKind: 'background',
    query: 'search',
    searchTier: 'title',
  },
}
```

and assert:

```ts
expect(screen.getByText('Search Result')).toBeInTheDocument()
expect(screen.queryByTestId('search-loading')).not.toBeInTheDocument()
expect(screen.queryByTestId('sessions-refreshing')).not.toBeInTheDocument()
```

**Step 4: Run the Sidebar test file and verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.test.tsx
```

Expected: FAIL because the component still renders the in-flow loading row and has no request-intent-aware state.

**Step 5: Add the real App-level regression for an active query**

Extend `test/e2e/open-tab-session-sidebar-visibility.test.tsx` with one integration scenario:

```ts
it('keeps loaded search results visible and shows no search chrome during websocket revalidation', async () => {
  const deferred = createDeferred<any>()
  fetchSidebarSessionsSnapshot.mockReturnValueOnce(deferred.promise)

  const store = createStore({
    sessions: {
      activeSurface: 'sidebar',
      projects: searchProjects,
      lastLoadedAt: Date.now(),
      windows: {
        sidebar: {
          projects: searchProjects,
          lastLoadedAt: Date.now(),
          loading: false,
          query: 'search',
          searchTier: 'title',
        },
      },
    },
  })

  render(<Provider store={store}><App /></Provider>)
  act(() => broadcastWs({ type: 'sessions.changed', revision: 9 }))

  await waitFor(() => expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1))
  expect(screen.getAllByText('Search Result').length).toBeGreaterThan(0)
  expect(screen.queryByTestId('search-loading')).not.toBeInTheDocument()
})
```

This should fail before implementation because background invalidation of a loaded query still surfaces visible search loading.

**Step 6: Run the e2e file and verify the new scenario fails**

Run:

```bash
npm run test:client:standard -- test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: FAIL in the new loaded-query invalidation scenario.

**Step 7: Commit the red tests**

```bash
git add test/unit/client/store/sessionsThunks.test.ts test/unit/client/components/Sidebar.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "test: lock silent sidebar search refresh behavior"
```

### Task 2: Add explicit request intent to session-window state

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/sessionsThunks.ts`
- Test: `test/unit/client/store/sessionsThunks.test.ts`

**Step 1: Add the loading-kind state to the session window**

In `src/store/sessionsSlice.ts`, add a shared type and store it both per-window and on the active top-level mirror:

```ts
export type SessionWindowLoadingKind = 'initial' | 'search' | 'background' | 'pagination'

export interface SessionWindowState {
  projects: ProjectGroup[]
  lastLoadedAt?: number
  totalSessions?: number
  oldestLoadedTimestamp?: number
  oldestLoadedSessionId?: string
  hasMore?: boolean
  loading?: boolean
  loadingKind?: SessionWindowLoadingKind
  error?: string
  query?: string
  searchTier?: 'title' | 'userMessages' | 'fullText'
}
```

Update `syncTopLevelFromWindow()`, `syncActiveWindowFromTopLevel()`, `setActiveSessionSurface()`, and `clearProjects()` so the active mirror keeps `loadingKind` coherent instead of dropping it during surface switches and resets.

**Step 2: Teach the loading reducer to clear and persist the kind**

Update `setSessionWindowLoading` so it accepts `loadingKind`:

```ts
setSessionWindowLoading: (
  state,
  action: PayloadAction<{
    surface: string
    loading: boolean
    loadingKind?: SessionWindowLoadingKind
    query?: string
    searchTier?: 'title' | 'userMessages' | 'fullText'
  }>,
) => {
  const window = ensureWindow(state, action.payload.surface)
  window.loading = action.payload.loading
  window.loadingKind = action.payload.loading ? action.payload.loadingKind : undefined
  if (state.activeSurface === action.payload.surface) {
    state.loadingMore = action.payload.loading
    state.loadingKind = action.payload.loading ? action.payload.loadingKind : undefined
  }
}
```

Make `setSessionWindowData()` and `setSessionWindowError()` clear `loadingKind` when a request settles.

**Step 3: Derive request intent inside `fetchSessionWindow()`**

In `src/store/sessionsThunks.ts`, add a small helper near the thunk:

```ts
function getLoadingKind(args: {
  priority: 'visible' | 'background'
  append: boolean
  trimmedQuery: string
  previousQuery: string
  previousTier: SearchOptions['tier']
  nextTier: SearchOptions['tier']
  hasCommittedWindow: boolean
  hasCommittedItems: boolean
}): SessionWindowLoadingKind {
  if (args.append) return 'pagination'
  if (args.priority === 'background') return 'background'
  if (!args.hasCommittedWindow && !args.hasCommittedItems) return 'initial'

  const queryChanged = args.trimmedQuery !== args.previousQuery
  const tierChanged = args.nextTier !== args.previousTier
  if (queryChanged || tierChanged || args.trimmedQuery.length > 0 || args.previousQuery.length > 0) {
    return 'search'
  }

  return 'background'
}
```

Use the current window state to populate that helper before dispatching `setSessionWindowLoading()`. Keep `loading: true` for all request kinds so concurrency guards continue to work.

**Step 4: Make websocket invalidations explicitly background**

Keep `refreshActiveSessionWindow()` unchanged for direct user-triggered refreshes, but in `queueActiveSessionWindowRefresh()` dispatch:

```ts
await dispatch(fetchSessionWindow({
  surface: activeSurface,
  priority: 'background',
  query: windowState?.query,
  searchTier: windowState?.searchTier,
}) as any)
```

That is the core policy change: background invalidations still fetch, but they can no longer accidentally claim visible search ownership.

**Step 5: Run the thunk tests and make them pass**

Run:

```bash
npm run test:client:standard -- test/unit/client/store/sessionsThunks.test.ts
```

Expected: PASS with the new request-intent assertions.

**Step 6: Commit the state/thunk change**

```bash
git add src/store/sessionsSlice.ts src/store/sessionsThunks.ts test/unit/client/store/sessionsThunks.test.ts
git commit -m "feat: separate silent and visible sidebar refresh states"
```

### Task 3: Move visible search feedback into stable chrome and delete the jumping row

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Test: `test/unit/client/components/Sidebar.test.tsx`

**Step 1: Replace the row-based status rendering with request-kind-aware booleans**

In `src/components/Sidebar.tsx`, replace the current flags:

```ts
const showBlockingLoad = !!sidebarWindow?.loading && !hasLoadedSidebarWindow && !sidebarWindowHasItems
const showInlineRefreshStatus = !!sidebarWindow?.loading && hasLoadedSidebarWindow
```

with:

```ts
const loadingKind = sidebarWindow?.loadingKind
const showBlockingLoad = !!sidebarWindow?.loading && loadingKind === 'initial'
const showSearchLoading = !!sidebarWindow?.loading && loadingKind === 'search'
```

Keep the existing `hasLoadedSidebarWindow` and `sidebarWindowHasItems` calculations as defensive checks, but the source of truth for visible behavior becomes `loadingKind`, not just `loading`.

**Step 2: Render search loading inside the search box instead of above the list**

Update the search control so the right side can host both clear-search and search-progress chrome without affecting layout:

```tsx
<div className="relative">
  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
  <input
    type="text"
    placeholder="Search..."
    value={filter}
    onChange={(e) => setFilter(e.target.value)}
    aria-busy={showSearchLoading}
    className="w-full h-8 pl-8 pr-12 text-sm bg-muted/50 border-0 rounded-md placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-border"
  />
  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
    {showSearchLoading ? (
      <span role="status" data-testid="search-loading" className="inline-flex items-center text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        <span className="sr-only">Searching...</span>
      </span>
    ) : null}
    {filter ? (
      <button aria-label="Clear search" onClick={() => setFilter('')} className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
        <X className="h-3.5 w-3.5" />
      </button>
    ) : null}
  </div>
</div>
```

Delete the old `showInlineRefreshStatus` block entirely. There should be no `sessions-refreshing` row left in the component.

**Step 3: Keep loaded content mounted for every non-initial load**

The list/empty-state branch should now be:

```tsx
{showBlockingLoad ? (
  <BlockingSpinner />
) : sortedItems.length === 0 ? (
  <EmptyState />
) : (
  <List ... />
)}
```

Do not add a second branch for background refresh. Loaded rows and loaded empty states should stay mounted regardless of `loadingKind === 'background' | 'search' | 'pagination'`.

**Step 4: Run the Sidebar test file and make it pass**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.test.tsx
```

Expected: PASS with no `sessions-refreshing` row and with `search-loading` only present for user-visible search requests.

**Step 5: Commit the Sidebar UI change**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.test.tsx
git commit -m "fix: keep sidebar search refresh chrome non-jumping"
```

### Task 4: Prove the integrated behavior and finish cleanly

**Files:**
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

**Step 1: Make the App-level invalidation tests pass**

Run:

```bash
npm run test:client:standard -- test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: PASS for both:

- loaded default-list invalidation stays visible and coalesces
- loaded active-search invalidation stays visible and does not show `search-loading`

**Step 2: Run the focused client regression pack**

Run:

```bash
npm run test:client:standard -- test/unit/client/store/sessionsThunks.test.ts test/unit/client/components/Sidebar.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: PASS.

**Step 3: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS, allowing for pre-existing warnings if the repo already has them.

**Step 4: Check the coordinated test gate and run the broad suite**

Run:

```bash
npm run test:status
FRESHELL_TEST_SUMMARY="sidebar silent refresh search" CI=true npm test
```

Expected: the status command shows the repo gate state, then the full coordinated suite passes.

**Step 5: Commit the final green state**

```bash
git add test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "test: cover silent sidebar revalidation for active queries"
```

## Notes For Execution

- Use the existing worktree `./.worktrees/trycycle-sidebar-silent-refresh-search`; do not touch the dirty primary checkout on `main`.
- Preserve the current `_resetSessionWindowThunkState()` pattern. If new module-scope request metadata is added, reset it there.
- Do not update `docs/index.html`; this is a behavior refinement, not a new user-facing feature surface.
- If implementation reveals that direct non-search user refresh also needs visible feedback, add that as fixed-position chrome in the sidebar header, not as a list row. Do not reintroduce layout-shifting status content.

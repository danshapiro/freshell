# Sidebar Refresh Stability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Stop the left sidebar from blanking during live session refreshes, while ensuring `sessions.changed` only fires when the `/api/session-directory` read model actually changes in a way the sidebar or session search can observe.

**Architecture:** Keep the existing full-fidelity session diff for internal server consumers, and add a shared session-directory projection module reused by both the HTTP read model and the websocket invalidation boundary. On the client, keep already-loaded sidebar content mounted during refresh and route websocket invalidations through a coalesced refresh thunk with repo-standard reset hooks for module-scope fetch state, so repeated invalidations cannot keep aborting the same request and tests remain deterministic.

**Tech Stack:** Node.js, TypeScript, React 18, Redux Toolkit, Vitest, Testing Library

---

## Strategy Gate

The current direction is close, but one part must change: `server/sessions-sync/diff.ts` is not just the websocket invalidation boundary. The session indexer also uses that full diff to decide whether to emit `onUpdate`, and those updates feed internal consumers such as codex activity reconciliation and session association. If we repurpose `diffProjects()` to mean "sidebar-visible change only", we suppress real internal metadata updates that the server still needs.

The clean architecture is:

- Keep `diffProjects()` as the strict, full-session comparator for internal server state.
- Introduce a dedicated session-directory projection plus snapshot comparator for the `sessions.changed` websocket boundary.
- Keep `updatedAt` as real session activity time. An active session should still move and refresh when its visible recency changes.
- Fix the disruptive blanking independently by rendering stale sidebar content while refresh is in flight.
- Coalesce websocket invalidations in the session-window thunk layer, not inline in `App.tsx`, so the policy is testable and scoped to invalidation refreshes only.

Important product decision:

- `/api/session-directory` currently does not expose project colors. Therefore project-color-only changes are not observable through the HTTP-owned sidebar/search read model and should not trigger `sessions.changed`. If project colors are later added to that route, update the directory comparator in the same change.

Rejected approaches:

- Replacing `diffProjects()` globally with a directory-visible comparator. That breaks internal indexer consumers.
- Freezing or carrying forward `updatedAt` to suppress refreshes. That lies about recency and sort order for active sessions.
- Client-only stale rendering with no refresh coalescing. That removes the empty panel but still wastes work by aborting and restarting fetches during invalidation bursts.
- Adding new Redux loading enums for the sidebar. Existing `lastLoadedAt` plus `loading` already distinguishes first load from background refresh.
- Threading websocket `sessions.changed.revision` through `/api/session-directory` fetches. The websocket revision is a sync-service invalidation counter, while the route revision is currently a page watermark derived from session/terminal activity; wiring them together here would add plumbing without addressing the actual bug.

Implementation invariants:

- `diffProjects()` remains the full-fidelity project/session comparator used by the indexer.
- `sessions.changed` means "the base `/api/session-directory` read model changed".
- Invisible session metadata (`tokenUsage`, `codexTaskEvents`, `sourceFile`, `gitBranch`, `isDirty`, `messageCount`, and project color) must not trigger `sessions.changed` when directory-visible fields are unchanged.
- A loaded sidebar must never unmount its current rows just because a refresh is in flight.
- Repeated websocket invalidations while a session-window refresh is already running collapse to one follow-up refresh at most.
- Explicit user-driven refresh paths keep their current direct behavior; only websocket invalidations get coalesced.
- New module-scope state in `sessionsThunks.ts` must be resettable in tests, following the existing thunk-controller pattern used elsewhere in the repo.
- `docs/index.html` stays untouched; this is a behavior fix, not a new UI surface.
- Use repo-owned commands only. The final broad run is `FRESHELL_TEST_SUMMARY="left panel refresh fix" CI=true npm test`.

### Task 1: Lock the server boundary and preserve full internal diff semantics

**Files:**
- Create: `test/unit/server/session-directory/projection.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/unit/server/sessions-sync/diff.test.ts`

**Step 1: Create the failing session-directory projection test**

Add `test/unit/server/session-directory/projection.test.ts` with one explicit item-projection expectation and one snapshot-change expectation:

```ts
const baseSession = {
  provider: 'codex',
  sessionId: 's1',
  projectPath: '/repo',
  updatedAt: 100,
  title: 'Deploy',
} as const

expect(toSessionDirectoryComparableItem({
  provider: 'codex',
  sessionId: 's1',
  projectPath: '/repo',
  updatedAt: 100,
  createdAt: 50,
  title: 'Deploy',
  summary: 'Summary',
  firstUserMessage: 'ship it',
  cwd: '/repo',
  archived: false,
  sessionType: 'codex',
  isSubagent: false,
  isNonInteractive: false,
  tokenUsage: { inputTokens: 1, outputTokens: 2, cachedTokens: 3, totalTokens: 6 },
  codexTaskEvents: { latestTaskStartedAt: 99 },
  sourceFile: '/tmp/session.jsonl',
})).toEqual({
  provider: 'codex',
  sessionId: 's1',
  projectPath: '/repo',
  updatedAt: 100,
  createdAt: 50,
  title: 'Deploy',
  summary: 'Summary',
  firstUserMessage: 'ship it',
  cwd: '/repo',
  archived: false,
  sessionType: 'codex',
  isSubagent: false,
  isNonInteractive: false,
})

expect(hasSessionDirectorySnapshotChange(
  [{
    projectPath: '/repo',
    color: '#f00',
    sessions: [{ ...baseSession, tokenUsage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0, totalTokens: 3 } }],
  }],
  [{
    projectPath: '/repo',
    color: '#0f0',
    sessions: [{ ...baseSession, tokenUsage: { inputTokens: 9, outputTokens: 9, cachedTokens: 9, totalTokens: 27 }, sourceFile: '/tmp/other.jsonl' }],
  }],
)).toBe(false)

expect(hasSessionDirectorySnapshotChange(
  [{ projectPath: '/repo', sessions: [{ ...baseSession, updatedAt: 100 }] }],
  [{ projectPath: '/repo', sessions: [{ ...baseSession, updatedAt: 101 }] }],
)).toBe(true)
```

That test must explicitly pin two decisions:

- invisible metadata and project color are ignored by the directory comparator
- `updatedAt` remains directory-visible and still counts

**Step 2: Run the new projection test and verify it fails**

Run:

```bash
npm run test:server:standard -- test/unit/server/session-directory/projection.test.ts
```

Expected: FAIL because `server/session-directory/projection.ts` does not exist yet.

**Step 3: Add the failing `SessionsSyncService` boundary regression**

Extend `test/unit/server/sessions-sync/service.test.ts` with one explicit websocket-boundary test:

- first `publish()` broadcasts revision `1`
- second `publish()` changes only invisible session metadata and project color while keeping the same directory-visible fields and same `updatedAt`, so it does not broadcast
- third `publish()` changes only `updatedAt`, so it broadcasts revision `2`
- fourth `publish()` changes a visible field such as `title`, so it broadcasts revision `3`

Keep this test at `SessionsSyncService` so it proves the websocket invalidation boundary uses the dedicated session-directory comparator rather than the strict internal diff.

**Step 4: Run the service test and verify it fails**

Run:

```bash
npm run test:server:standard -- test/unit/server/sessions-sync/service.test.ts
```

Expected: FAIL because `SessionsSyncService.publish()` still invalidates on full project diff.

**Step 5: Add a characterization guard that the strict internal diff still stays strict**

Extend `test/unit/server/sessions-sync/diff.test.ts` with one explicit case that changes only `codexTaskEvents` or `sourceFile` and still expects an upsert from `diffProjects()`.

This test is intentionally a guardrail, not the bug fix itself. It documents that the shared internal diff must remain full-fidelity for indexer consumers.

**Step 6: Run the diff guard and verify it already passes**

Run:

```bash
npm run test:server:standard -- test/unit/server/sessions-sync/diff.test.ts
```

Expected: PASS, proving the plan is not trying to rewrite `diffProjects()` semantics.

### Task 2: Implement a dedicated session-directory snapshot comparator

**Files:**
- Create: `server/session-directory/projection.ts`
- Modify: `server/session-directory/service.ts`
- Modify: `server/sessions-sync/service.ts`
- Test: `test/unit/server/session-directory/projection.test.ts`
- Test: `test/unit/server/sessions-sync/service.test.ts`
- Test: `test/unit/server/sessions-sync/diff.test.ts`

**Step 1: Implement the shared session-directory projection helper**

Create `server/session-directory/projection.ts` with five exports:

- `SessionDirectoryComparableItem`
- `toSessionDirectoryComparableItem(session)`
- `compareSessionDirectoryComparableItems(a, b)`
- `buildSessionDirectoryComparableSnapshot(projects)`
- `hasSessionDirectorySnapshotChange(prevProjects, nextProjects)`

Use an explicit field list, not object spread comparisons:

```ts
export type SessionDirectoryComparableItem = Omit<
  SessionDirectoryItem,
  'isRunning' | 'runningTerminalId' | 'snippet' | 'matchedIn'
>

export function toSessionDirectoryComparableItem(session: CodingCliSession): SessionDirectoryComparableItem {
  return {
    provider: session.provider,
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    title: session.title,
    summary: session.summary,
    updatedAt: session.updatedAt,
    createdAt: session.createdAt,
    archived: session.archived,
    cwd: session.cwd,
    sessionType: session.sessionType,
    isSubagent: session.isSubagent,
    isNonInteractive: session.isNonInteractive,
    firstUserMessage: session.firstUserMessage,
  }
}
```

`hasSessionDirectorySnapshotChange()` should flatten both project arrays into the same sorted comparable-item order used by the directory route and compare those ordered arrays item-by-item. Do not inspect raw `CodingCliSession` objects there.

Do not include project color in this comparator because the route does not expose it today.
Do not involve the route's `revision` number in this helper; this helper answers "would the directory payload contents differ?" and nothing else.

**Step 2: Refactor `session-directory/service.ts` to use the helper**

Replace the hand-built item object and local ordering function with the shared helper:

```ts
function toItems(projects: ProjectGroup[], terminalMeta: TerminalMeta[]): SessionDirectoryItem[] {
  return buildSessionDirectoryComparableSnapshot(projects).map((item) => (
    joinRunningState({
      ...item,
      isRunning: false,
    }, terminalMeta)
  ))
}
```

The route must keep all existing behavior unchanged:

- same ordering
- same search fields
- same cursor semantics
- same running-terminal join
- same revision calculation

This task is a refactor of the read-model construction, not a route contract expansion.

**Step 3: Switch `SessionsSyncService` to the directory comparator**

In `server/sessions-sync/service.ts`, stop importing `diffProjects()` and instead ask the dedicated helper whether the directory snapshot changed:

```ts
const changed = hasSessionDirectorySnapshotChange(prev, next)

this.last = next
this.hasLast = true

if (!changed) return
this.revision += 1
this.ws.broadcastSessionsChanged(this.revision)
```

Keep storing the full `ProjectGroup[]` snapshot so later comparisons always project from the canonical source data. Do not mutate `server/sessions-sync/diff.ts`.

**Step 4: Run the focused server regression set**

Run:

```bash
npm run test:server:standard -- test/unit/server/session-directory/projection.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/session-directory/service.test.ts
```

Expected: PASS

**Step 5: Commit the server-side cut**

Run:

```bash
git add server/session-directory/projection.ts server/session-directory/service.ts server/sessions-sync/service.ts test/unit/server/session-directory/projection.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/sessions-sync/diff.test.ts
git commit -m "fix(sessions): align websocket invalidations with directory snapshots"
```

Expected: one commit containing only the dedicated directory comparator and its tests.

### Task 3: Lock stale-while-refresh rendering and invalidation coalescing in failing client tests

**Files:**
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

**Step 1: Add the failing sidebar stale-while-refresh regressions**

In `Sidebar.test.tsx`, preload `sessions.windows.sidebar` with an already-loaded window:

```ts
windows: {
  sidebar: {
    projects: recentProjects,
    lastLoadedAt: 1_700_000_000_000,
    loading: true,
    query: '',
    searchTier: 'title',
  },
},
activeSurface: 'sidebar',
projects: recentProjects,
lastLoadedAt: 1_700_000_000_000,
```

Add two assertions:

- non-search refresh: existing row text is still rendered, `virtualized-list` stays mounted, and `data-testid="sessions-refreshing"` is visible
- search refresh: existing row text is still rendered and `data-testid="search-loading"` stays visible

Also add one first-load search regression with no `lastLoadedAt` that still expects the existing `search-loading` test id while the initial search is blocking.

**Step 2: Run the sidebar test and verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.test.tsx
```

Expected: FAIL because `Sidebar.tsx` currently unmounts the list whenever `sidebarWindow.loading` is true.

**Step 3: Add the failing invalidation-queue thunk regression and the future reset-hook usage**

In `test/unit/client/store/sessionsThunks.test.ts`, import a future `_resetSessionWindowThunkState()` helper from `src/store/sessionsThunks.ts` and call it in `beforeEach`/`afterEach`, matching the pattern already used by `terminalDirectoryThunks` and `agentChatThunks`.

Then add a small deferred helper and a new test around a new invalidation-specific thunk:

```ts
const deferred = createDeferred<any>()
fetchSidebarSessionsSnapshot.mockReturnValueOnce(deferred.promise)

const first = store.dispatch(queueActiveSessionWindowRefresh() as any)
const second = store.dispatch(queueActiveSessionWindowRefresh() as any)
const third = store.dispatch(queueActiveSessionWindowRefresh() as any)

expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(1)
expect((fetchSidebarSessionsSnapshot.mock.calls[0][0] as any).signal.aborted).toBe(false)
```

Then resolve the first request, await all three dispatch promises, and assert exactly one follow-up fetch ran:

```ts
expect(fetchSidebarSessionsSnapshot).toHaveBeenCalledTimes(2)
```

This test belongs in the thunk file because coalescing is session-window fetch policy, not general `App.tsx` behavior.

**Step 4: Run the thunk test and verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/store/sessionsThunks.test.ts
```

Expected: FAIL because repeated invalidations still dispatch `fetchSessionWindow()` directly and abort the previous request.

**Step 5: Add the failing integration regression with real Sidebar rendering**

In `test/e2e/open-tab-session-sidebar-visibility.test.tsx`, also import the future `_resetSessionWindowThunkState()` helper and clear it in `afterEach()` so the deferred invalidation test cannot leak queue/controller state across cases.

Keep the first sidebar snapshot loaded, then make the invalidation-triggered refetch hang:

```ts
const deferred = createDeferred<any>()
fetchSidebarSessionsSnapshot.mockReturnValueOnce(deferred.promise)
```

Broadcast `sessions.changed`, then assert all of these while the promise is still pending:

- the original sidebar row remains visible
- the fetch count is still `1`
- a second `sessions.changed` does not start a second request yet

Resolve the first request with a new response, then assert:

- the old row is replaced by the new row
- at most one queued follow-up request starts after the first one settles

This test is the integration proof that the user-visible blanking is gone during websocket-driven refreshes.

**Step 6: Run the focused client regressions and verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.test.tsx test/unit/client/store/sessionsThunks.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: FAIL because the sidebar still blanks during refresh and invalidation bursts still overlap.

### Task 4: Implement stale-while-refresh rendering and invalidation-only coalescing

**Files:**
- Modify: `src/store/sessionsThunks.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/Sidebar.tsx`
- Test: `test/unit/client/components/Sidebar.test.tsx`
- Test: `test/unit/client/store/sessionsThunks.test.ts`
- Test: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

**Step 1: Add an invalidation-only queued refresh thunk and test reset helper in `sessionsThunks.ts`**

Keep `refreshActiveSessionWindow()` unchanged for explicit user-driven refreshes. Add a new exported thunk, for example `queueActiveSessionWindowRefresh()`, backed by module-scope queue state keyed by surface. In the same file, add `_resetSessionWindowThunkState()` that aborts outstanding controllers, clears the controller map, and clears the invalidation queue map for deterministic tests.

Use the existing `fetchSessionWindow()` as the work unit:

```ts
const invalidationRefreshState = new Map<SessionSurface, {
  inFlight: Promise<void> | null
  queued: boolean
}>()

export function _resetSessionWindowThunkState(): void {
  for (const controller of controllers.values()) {
    controller.abort()
  }
  controllers.clear()
  invalidationRefreshState.clear()
}

export function queueActiveSessionWindowRefresh() {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const surface = getState().sessions.activeSurface as SessionSurface | undefined
    if (!surface) return

    const existing = invalidationRefreshState.get(surface)
    if (existing?.inFlight) {
      existing.queued = true
      return existing.inFlight
    }

    const state = { inFlight: null as Promise<void> | null, queued: false }
    invalidationRefreshState.set(surface, state)

    state.inFlight = (async () => {
      try {
        do {
          state.queued = false
          const windowState = getState().sessions.windows[surface]
          await dispatch(fetchSessionWindow({
            surface,
            priority: 'visible',
            query: windowState?.query,
            searchTier: windowState?.searchTier,
          }) as any)
        } while (state.queued)
      } finally {
        invalidationRefreshState.delete(surface)
      }
    })()

    return state.inFlight
  }
}
```

This queue must never call `fetchSessionWindow()` concurrently for the same surface.
It must also leave the existing `controllers`-based abort behavior intact for explicit user-driven refreshes and append flows.

**Step 2: Route websocket invalidations through the queue**

In `src/App.tsx`, change the `sessions.changed` handler to dispatch the new invalidation thunk:

```ts
if (msg.type === 'sessions.changed') {
  void appStore.dispatch(queueActiveSessionWindowRefresh() as any)
}
```

Do not inline queue state inside the websocket effect. `App.tsx` should stay as the message-to-action bridge.

**Step 3: Split blocking load from background refresh in `Sidebar.tsx`**

Add explicit derived flags:

```tsx
const hasLoadedSidebarWindow = typeof sidebarWindow?.lastLoadedAt === 'number'
const activeQuery = sidebarWindow?.query?.trim() ?? ''
const showBlockingLoad = !!sidebarWindow?.loading && !hasLoadedSidebarWindow && sortedItems.length === 0
const showInlineRefreshStatus = !!sidebarWindow?.loading && hasLoadedSidebarWindow
```

Use this render matrix:

- initial non-search load: centered blocking spinner, no rows
- initial search load: centered blocking spinner with `data-testid="search-loading"`
- loaded refresh with empty query: keep current list or empty state mounted and show inline `data-testid="sessions-refreshing"`
- loaded refresh with query: keep current list or empty state mounted and show inline `data-testid="search-loading"`

Do not add new Redux state for this.

**Step 4: Move the refresh status outside the measured list viewport**

Make the session-list section a flex column and move the measurement ref to the actual list viewport so the inline refresh status does not steal `react-window` height:

```tsx
<div className="flex flex-1 min-h-0 flex-col">
  {showInlineRefreshStatus && (
    <div
      className="px-4 py-2 text-xs text-muted-foreground flex items-center gap-2"
      role="status"
      data-testid={activeQuery ? 'search-loading' : 'sessions-refreshing'}
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      <span>{activeQuery ? 'Searching...' : 'Updating sessions...'}</span>
    </div>
  )}
  <div ref={listContainerRef} className="flex-1 min-h-0 px-2">
    {/* blocking load, empty state, or List */}
  </div>
</div>
```

The `min-h-0` on both wrappers is required so the virtualized list can shrink inside the flex layout.

**Step 5: Keep already-loaded content mounted during refresh**

Render policy inside the viewport:

- if `showBlockingLoad`: render the blocking load state
- else if `sortedItems.length === 0`: render the current empty state even when loading is true
- else: render the `List` even when loading is true

This is the behavior change that removes the visible blank panel.

**Step 6: Run the focused client regression set**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.test.tsx test/unit/client/store/sessionsThunks.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: PASS

**Step 7: Commit the client-side cut**

Run:

```bash
git add src/store/sessionsThunks.ts src/App.tsx src/components/Sidebar.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/store/sessionsThunks.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "fix(sidebar): preserve content during invalidation refreshes"
```

Expected: one commit containing the stale-while-refresh UI and invalidation queue.

### Task 5: Run the combined verification gate

**Files:**
- Modify only files already touched by this plan if follow-up fixes are required

**Step 1: Run the focused server regression suite**

Run:

```bash
npm run test:server:standard -- test/unit/server/session-directory/projection.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/session-directory/service.test.ts
```

Expected: PASS

**Step 2: Run the focused client regression suite**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.test.tsx test/unit/client/store/sessionsThunks.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: PASS

**Step 3: Run accessibility lint**

Run:

```bash
npm run lint
```

Expected: PASS

**Step 4: Run the full repository test suite**

Run:

```bash
FRESHELL_TEST_SUMMARY="left panel refresh fix" CI=true npm test
```

Expected: PASS

If the coordinated broad run is busy, wait rather than killing another holder. Use `npm run test:status` to inspect the holder and recent results.

**Step 5: Commit only if verification required follow-up edits**

Run only if Steps 1-4 required real code changes:

```bash
git add <follow-up-files>
git commit -m "test: finish sidebar refresh verification"
```

Expected: no extra commit unless verification exposed a real issue.

## Final Verification Checklist

- `diffProjects()` still behaves as the strict internal comparator for indexer updates.
- `SessionsSyncService` now invalidates from a dedicated `/api/session-directory` snapshot comparator instead of the strict internal diff.
- Invisible session metadata and project-color-only changes no longer fire `sessions.changed` when directory-visible fields are stable.
- `updatedAt` still reflects real session activity and still causes visible invalidation when it changes.
- A loaded sidebar never goes blank while any refresh is in flight.
- First-load search still uses the existing `search-loading` contract.
- Repeated websocket invalidations do not abort and restart the same sidebar refresh over and over.
- `sessionsThunks.ts` exposes `_resetSessionWindowThunkState()` and the new queue/controller module state is cleaned between tests.
- No code path assumes websocket invalidation revisions and `/api/session-directory` page revisions are interchangeable.
- Focused server regressions pass, then focused client regressions pass, then `npm run lint`, then `FRESHELL_TEST_SUMMARY="left panel refresh fix" CI=true npm test`.

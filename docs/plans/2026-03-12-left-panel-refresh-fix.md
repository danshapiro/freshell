# Sidebar Refresh Stability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Stop the left sidebar from blanking during live session refreshes, while suppressing websocket invalidations caused only by session fields the sidebar and session search cannot observe.

**Architecture:** Extract one server-owned session-directory projection that defines the exact fields exposed by `/api/session-directory`, and use that same projection to decide whether `sessions.changed` should fire. Keep `CodingCliSession.updatedAt` as true activity time; do not redefine recency just to reduce refreshes. On the client, treat websocket invalidation refreshes as stale-while-refresh and coalesce overlapping invalidations so one in-flight sidebar fetch can settle before a follow-up refresh starts.

**Tech Stack:** Node.js, TypeScript, React 18, Redux Toolkit, Vitest, Testing Library

---

## Strategy Gate

The current plan direction is close, but one proposed change is wrong for this product surface: carrying forward the old `updatedAt` across file rewrites would quietly redefine sidebar recency from "last session activity" to "last visible metadata change". That would make sort order, relative timestamps, and pagination cursors stale. The user asked to fix disruptive blanking and noisy invalidations, not to freeze live recency.

The clean fix is:

- Server: define one explicit session-directory projection and reuse it everywhere the sidebar/search read model is compared.
- Client: preserve the already-rendered sidebar rows during refresh and stop websocket invalidations from repeatedly aborting and restarting the same fetch.

Rejected approaches:

- Preserving the previous `updatedAt` when only invisible metadata changed. This hides some invalidations by lying about activity time.
- Client-only stale rendering with no invalidation coalescing. This removes the empty panel but still wastes work by aborting and restarting refreshes during invalidation bursts.
- Adding a second timestamp such as `directoryUpdatedAt`. That duplicates recency semantics across the read model, diffing, pagination, and client state.

Implementation invariants:

- `CodingCliSession.updatedAt` continues to mean provider or file activity time.
- `sessions.changed` means "the session-directory read model changed in a way its consumers can observe".
- Invisible metadata alone (`tokenUsage`, `codexTaskEvents`, `sourceFile`, other non-directory fields) must not trigger `sessions.changed` when `updatedAt` is unchanged.
- A loaded sidebar must never unmount its existing rows just because a refresh is in flight.
- Repeated `sessions.changed` messages while a sidebar refresh is already running collapse to one follow-up refresh at most.
- First load may still show a blocking loading state.
- `docs/index.html` stays untouched; this is a behavior fix, not a new product surface.
- Use repo-owned entrypoints only. The final broad run is `FRESHELL_TEST_SUMMARY="left panel refresh fix" CI=true npm test`.

### Task 1: Lock the server read-model contract in failing tests

**Files:**
- Create: `test/unit/server/session-directory/projection.test.ts`
- Modify: `test/unit/server/sessions-sync/diff.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`

**Step 1: Create the failing projection contract test**

Add `test/unit/server/session-directory/projection.test.ts` with one explicit projection expectation:

```ts
expect(toSessionDirectoryProjection({
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
```

Add the companion equality test:

```ts
expect(directoryProjectionEqual(a, b, { includeUpdatedAt: false })).toBe(true)
expect(directoryProjectionEqual(a, b, { includeUpdatedAt: true })).toBe(false)
```

**Step 2: Run the new projection test and verify it fails**

Run:

```bash
npm run test:server:standard -- test/unit/server/session-directory/projection.test.ts
```

Expected: FAIL because `server/session-directory/projection.ts` does not exist yet.

**Step 3: Add the failing diff regression**

Extend `test/unit/server/sessions-sync/diff.test.ts` with three focused cases:

- changing only invisible fields such as `tokenUsage`, `codexTaskEvents`, or `sourceFile` while keeping the same `updatedAt` does not produce an upsert
- changing only `updatedAt` still produces an upsert because recency is directory-visible
- changing a visible field such as `title`, `summary`, `archived`, `firstUserMessage`, or `sessionType` still produces an upsert

Use the same provider, sessionId, and projectPath in all three cases so the tests isolate field visibility instead of insert or delete behavior.

**Step 4: Run the diff test and verify the invisible-field case fails**

Run:

```bash
npm run test:server:standard -- test/unit/server/sessions-sync/diff.test.ts
```

Expected: FAIL because `diffProjects()` still compares whole session objects.

**Step 5: Add the failing sessions-sync service regression**

Extend `test/unit/server/sessions-sync/service.test.ts` with one boundary test:

- first `publish()` broadcasts revision `1`
- second `publish()` changes only invisible fields and keeps the same `updatedAt`, so it does not broadcast
- third `publish()` changes only `updatedAt`, so it does broadcast revision `2`

This test belongs at `SessionsSyncService` so the executor proves the websocket invalidation boundary inherits the projection semantics instead of relying only on `diff.test.ts`.

**Step 6: Run the service test and verify it fails**

Run:

```bash
npm run test:server:standard -- test/unit/server/sessions-sync/service.test.ts
```

Expected: FAIL because `SessionsSyncService.publish()` still treats invisible metadata churn as a meaningful change.

### Task 2: Extract the session-directory projection as the single source of truth

**Files:**
- Create: `server/session-directory/projection.ts`
- Modify: `server/session-directory/service.ts`
- Test: `test/unit/server/session-directory/projection.test.ts`
- Test: `test/unit/server/session-directory/service.test.ts`

**Step 1: Implement the shared projection helper**

Create `server/session-directory/projection.ts`:

```ts
import type { CodingCliSession } from '../coding-cli/types.js'
import type { SessionDirectoryItem } from './types.js'

export type SessionDirectoryProjection = Omit<
  SessionDirectoryItem,
  'isRunning' | 'runningTerminalId' | 'snippet' | 'matchedIn'
>

export function toSessionDirectoryProjection(session: CodingCliSession): SessionDirectoryProjection {
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

Also add `directoryProjectionEqual(a, b, { includeUpdatedAt?: boolean })`. Compare the explicit projected keys, not raw `CodingCliSession` objects.

**Step 2: Refactor `session-directory/service.ts` to use the helper**

Replace the hand-built object in `toItems()` with the shared projection:

```ts
items.push(joinRunningState({
  ...toSessionDirectoryProjection(session),
  isRunning: false,
}, terminalMeta))
```

Keep search, cursor, ordering, and running-state behavior unchanged.

**Step 3: Run the projection and session-directory tests**

Run:

```bash
npm run test:server:standard -- test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts
```

Expected: PASS

### Task 3: Use the shared projection for websocket invalidation diffing

**Files:**
- Modify: `server/sessions-sync/diff.ts`
- Test: `test/unit/server/sessions-sync/diff.test.ts`
- Test: `test/unit/server/sessions-sync/service.test.ts`
- Test: `test/unit/server/session-directory/projection.test.ts`

**Step 1: Make `diffProjects()` compare directory projections**

Replace raw session-object comparison with:

```ts
directoryProjectionEqual(
  toSessionDirectoryProjection(a),
  toSessionDirectoryProjection(b),
  { includeUpdatedAt: true },
)
```

Keep the existing project-level checks for project path, color, session count, and session order.

**Step 2: Do not modify `server/coding-cli/session-indexer.ts`**

The current indexer should continue to source `updatedAt` from provider activity or file `mtime`. Add no indexer workaround unless a newly written test proves the product requirement is to freeze recency, because that would be a meaning change, not a bug fix.

**Step 3: Run the full targeted server regression set**

Run:

```bash
npm run test:server:standard -- test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts
```

Expected: PASS

**Step 4: Commit the server-side cut**

Run:

```bash
git add server/session-directory/projection.ts server/session-directory/service.ts server/sessions-sync/diff.ts test/unit/server/session-directory/projection.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts
git commit -m "fix(sessions): align invalidations with directory projection"
```

Expected: one commit containing only the shared projection extraction and invalidation semantics cleanup.

### Task 4: Lock stale-while-refresh and invalidation coalescing in failing client tests

**Files:**
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

**Step 1: Add the failing sidebar stale-while-refresh regression**

In `Sidebar.test.tsx`, preload `sessions.windows.sidebar` with:

```ts
sidebar: {
  projects: recentProjects,
  lastLoadedAt: 1_700_000_000_000,
  loading: true,
  query: '',
  searchTier: 'title',
}
```

Assert all three conditions at once:

- the existing row text is still rendered
- the list stays mounted
- an inline refresh status is rendered

Add the companion search case with `query: 'deploy'` and keep the stale row mounted there too. Preserve the existing `data-testid="search-loading"` contract for the query case so the rest of the suite does not need unrelated rewrites.

**Step 2: Run the sidebar unit test and verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.test.tsx
```

Expected: FAIL because `Sidebar.tsx` currently unmounts the list whenever `sidebarWindow.loading` is true.

**Step 3: Add the failing App invalidation-coalescing regression**

In `App.test.tsx`, create a deferred sidebar refresh:

```ts
const deferred = createDeferred<any>()
fetchSidebarSessionsSnapshot.mockReturnValueOnce(deferred.promise)
```

Seed the store with an already-loaded sidebar window, send two `sessions.changed` messages before resolving the promise, and assert:

- only one HTTP refresh starts while the first promise is pending
- the first request's `AbortSignal` is not aborted by the second invalidation
- resolving the first refresh triggers exactly one follow-up refresh, not two

This test belongs in `App.test.tsx` because websocket invalidation policy is an App concern; `fetchSessionWindow()` should still be allowed to replace in-flight requests for search typing.

**Step 4: Run the App unit test and verify it fails**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/App.test.tsx
```

Expected: FAIL because `App.tsx` currently dispatches `refreshActiveSessionWindow()` for every `sessions.changed` message, and the thunk aborts the previous request.

**Step 5: Add the failing end-to-end sidebar regression**

In `test/e2e/open-tab-session-sidebar-visibility.test.tsx`, keep the first sidebar snapshot loaded, then make the invalidation-triggered refetch hang on a deferred promise:

```ts
const deferred = createDeferred<any>()
fetchSidebarSessionsSnapshot
  .mockResolvedValueOnce(initialResponse)
  .mockReturnValueOnce(deferred.promise)
```

Broadcast `sessions.changed`, assert the existing session row remains visible while the promise is pending, then optionally broadcast a second `sessions.changed` and assert the fetch count still stays at `1` until the first promise resolves. Resolve the promise with the new response and assert the new row replaces the old one.

**Step 6: Run the new client regressions and verify they fail**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.test.tsx test/unit/client/components/App.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: FAIL because the sidebar still blanks during refresh and websocket invalidations still overlap.

### Task 5: Implement stale-while-refresh rendering and websocket refresh coalescing

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`
- Test: `test/unit/client/components/Sidebar.test.tsx`
- Test: `test/unit/client/components/App.test.tsx`
- Test: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

**Step 1: Add a coalesced invalidation refresh helper in `App.tsx`**

Inside the websocket effect, replace the direct `refreshActiveSessionWindow()` call with a small queue that drains at most one follow-up refresh:

```ts
let sessionsRefreshInFlight = false
let sessionsRefreshQueued = false

const drainSessionsRefreshQueue = async () => {
  if (sessionsRefreshInFlight) {
    sessionsRefreshQueued = true
    return
  }

  sessionsRefreshInFlight = true
  try {
    do {
      sessionsRefreshQueued = false
      await appStore.dispatch(refreshActiveSessionWindow() as any)
    } while (sessionsRefreshQueued && !cancelled)
  } finally {
    sessionsRefreshInFlight = false
  }
}
```

Use this helper only for websocket `sessions.changed` handling. Do not move the queue into generic search typing paths.

**Step 2: Split blocking load from background refresh in `Sidebar.tsx`**

Add explicit render guards:

```tsx
const hasLoadedSidebarWindow = typeof sidebarWindow?.lastLoadedAt === 'number'
const activeQuery = sidebarWindow?.query?.trim() ?? ''
const showBlockingLoad = !!sidebarWindow?.loading && !hasLoadedSidebarWindow && sortedItems.length === 0
const showRefreshStatus = !!sidebarWindow?.loading && hasLoadedSidebarWindow
```

**Step 3: Restructure the session-list area so the status row does not break virtualization height**

Do not prepend the status row inside the measured list container. Instead, make the list section a flex column:

```tsx
<div className="flex flex-1 min-h-0 flex-col">
  {showRefreshStatus && (
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
    {/* blocking spinner, empty state, or List */}
  </div>
</div>
```

The `min-h-0` is required so the `react-window` list can shrink inside the flex column without overflow bugs.

**Step 4: Keep already-loaded content mounted during refresh**

Render policy:

- `showBlockingLoad`: show the centered blocking spinner
- otherwise: keep rendering the list or empty state even if `sidebarWindow.loading` is true
- query-backed refreshes reuse the existing `search-loading` test id

The current store already has the necessary state:

- `sidebarWindow.projects`
- `sidebarWindow.lastLoadedAt`
- `sidebarWindow.loading`
- `sidebarWindow.query`
- `sidebarWindow.searchTier`

Do not add new Redux state unless a failing test proves it is necessary.

**Step 5: Run the targeted client tests**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.test.tsx test/unit/client/components/App.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: PASS

**Step 6: Commit the client-side cut**

Run:

```bash
git add src/App.tsx src/components/Sidebar.tsx test/unit/client/components/App.test.tsx test/unit/client/components/Sidebar.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "fix(sidebar): preserve loaded sessions during refresh"
```

Expected: one commit containing the sidebar stale-while-refresh behavior and websocket invalidation coalescing.

### Task 6: Run the combined verification gate

**Files:**
- Modify only files already touched by this plan if follow-up fixes are required

**Step 1: Run the focused server regression suite**

Run:

```bash
npm run test:server:standard -- test/unit/server/session-directory/projection.test.ts test/unit/server/session-directory/service.test.ts test/unit/server/sessions-sync/diff.test.ts test/unit/server/sessions-sync/service.test.ts
```

Expected: PASS

**Step 2: Run the focused client regression suite**

Run:

```bash
npm run test:client:standard -- test/unit/client/components/Sidebar.test.tsx test/unit/client/components/App.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
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

- `updatedAt` still reflects real session activity.
- Invisible metadata alone no longer causes `sessions.changed` when `updatedAt` is stable.
- `server/session-directory/service.ts` and `server/sessions-sync/diff.ts` derive visibility from the same projection helper.
- A loaded sidebar never goes blank while a refresh is in flight.
- Search refreshes also keep stale rows visible.
- Websocket invalidation bursts do not abort and restart the same sidebar refresh over and over.
- Focused server regressions pass, then focused client regressions pass, then `npm run lint`, then `FRESHELL_TEST_SUMMARY="left panel refresh fix" CI=true npm test`.

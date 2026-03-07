# Show Open-Tab Sessions In Sidebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Ensure any session already open in a tab is present in the left sidebar even when it falls outside the paginated 100-session window.

**Architecture:** Keep `state.sessions.projects` as the canonical sidebar data source and hydrate only definitely-local open-tab sessions into that state with exact server lookups, but only after the first authoritative server session baseline has landed. Preserve `sessionRef.serverInstanceId`, choose the best locator per `provider:sessionId` with locality-aware precedence so a local locator beats a foreign copied-tab locator, batch `/api/sessions/resolve` calls to the route cap, and park unresolved or failed keys against an authoritative server-sourced `catalogVersion` token. Each queued hydration request must snapshot the exact `catalogVersion` it started against so settle or fail logic never parks against a newer catalog state that arrived while the request was in flight.

**Tech Stack:** React 18, Redux Toolkit, Express, Zod, Vitest, Testing Library, supertest

**Worktree:** `/home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar`

**Notes:**
- The mounted sessions router is `server/sessions-router.ts`. Do not patch `server/routes/sessions.ts`; it is not used by `server/index.ts`.
- Pagination semantics stay intact. The first page is still the newest 100 sessions; open-tab sessions are hydrated out-of-band and merged into canonical state.
- `catalogVersion` must be an authoritative server-derived token for the indexed session catalog itself, not a client-side counter and not a per-request/page counter. Prefer reusing an existing server snapshot/change token if one already exists and only advances on actual catalog mutation; otherwise compute a stable opaque hash from the canonical indexed catalog on the server.
- `/api/sessions`, `sessions.updated`, and `sessions.page` must report the same `catalogVersion` for the same underlying catalog. Loading page 2 or receiving an identical HTTP + WS snapshot must keep the same token and must not re-arm parked unresolved or failed keys. `sessions.patch` must carry the post-change token for the updated catalog.
- Hydration must stay disabled until the first authoritative server-driven baseline arrives with a `catalogVersion`. Restored local tabs and panes alone are not evidence that a session is actually missing from the newest 100.
- `/api/sessions/resolve` is a lookup-only helper. It must not advance `catalogVersion`, `serverBaselineReady`, or any baseline freshness heuristics.
- Do not use `lastLoadedAt` as the hydration retry gate. `mergeResolvedProjects()` is a local upsert and must not modify `lastLoadedAt`, `serverBaselineReady`, or `serverCatalogVersion`.
- Do not drive the network request directly off the same selector that `markOpenTabHydrationRequested()` invalidates. The App orchestration must snapshot the request payload independently so the in-flight state transition does not cancel its own request and strand keys in `inFlight`.
- Do not clear failed requests back to hydratable state immediately. Persistent `/api/sessions/resolve` failures must be parked on the request's own `catalogVersion` so they do not tight-loop and spam logs.
- No `docs/index.html` update is needed for this change because the UI layout does not change; only sidebar data hydration changes.

---

### Task 1: Extract Shared Open-Session Locator Collection

**Files:**
- Modify: `src/lib/session-utils.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Test: `test/unit/client/lib/session-utils.test.ts`

**Step 1: Write the failing tests**

Add focused tests to `test/unit/client/lib/session-utils.test.ts` for a new helper that walks tabs + pane layouts and returns the best deduped session locator for each open session key. Cover:

- terminal panes with `resumeSessionId`
- agent-chat panes (`provider: 'claude'`)
- tabs without layouts using the legacy tab-level fallback
- duplicate session refs across multiple panes and tabs
- invalid Claude IDs ignored the same way existing helpers already ignore them
- explicit `sessionRef.serverInstanceId` is preserved for copied cross-device tabs
- mixed-locality duplicates prefer a local locator over a foreign copied-tab locator for the same `provider:sessionId`
- when no local candidate exists, the foreign locator is preserved so Task 4 can filter it later
- the ref-only wrapper drops `serverInstanceId` but keeps provider and session ordering stable

Use concrete expectations like:

```typescript
expect(collectSessionLocatorsFromTabs(tabs, panes, { localServerInstanceId: 'srv-local' })).toEqual([
  { provider: 'codex', sessionId: 'local-codex', serverInstanceId: 'srv-local' },
  { provider: 'codex', sessionId: 'remote-only', serverInstanceId: 'srv-remote' },
  { provider: 'claude', sessionId: VALID_SESSION_ID },
])

expect(collectSessionLocatorsFromTabs(tabsWithForeignFirstThenLocal, panes)).toEqual([
  { provider: 'codex', sessionId: 'shared-session' },
])

expect(collectSessionRefsFromTabs(tabs, panes)).toEqual([
  { provider: 'codex', sessionId: 'local-codex' },
  { provider: 'codex', sessionId: 'remote-only' },
  { provider: 'claude', sessionId: VALID_SESSION_ID },
])
```

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/session-utils.test.ts
```

Expected: FAIL because the new locality-aware locator helper does not exist yet.

**Step 3: Implement the shared helpers and refactor sidebar tab detection**

In `src/lib/session-utils.ts`, add a locator-preserving helper and keep a thin ref-only wrapper for existing call sites:

```typescript
type CollectSessionLocatorOptions = {
  localServerInstanceId?: string | null
}

function locatorPriority(
  locator: SessionLocator,
  localServerInstanceId?: string | null,
): number {
  if (localServerInstanceId && locator.serverInstanceId === localServerInstanceId) return 3
  if (!locator.serverInstanceId) return 2
  return 1
}

export function collectSessionLocatorsFromTabs(
  tabs: RootState['tabs']['tabs'],
  panes: Pick<RootState['panes'], 'layouts'>,
  options: CollectSessionLocatorOptions = {},
): SessionLocator[] {
  const order: string[] = []
  const bestByKey = new Map<string, SessionLocator>()

  const consider = (locator: SessionLocator) => {
    const key = `${locator.provider}:${locator.sessionId}`
    const previous = bestByKey.get(key)
    if (!previous) {
      order.push(key)
      bestByKey.set(key, locator)
      return
    }
    if (locatorPriority(locator, options.localServerInstanceId) > locatorPriority(previous, options.localServerInstanceId)) {
      bestByKey.set(key, locator)
    }
  }

  // Prefer explicit sessionRef so copied tabs keep their source serverInstanceId.
  // When the same provider:sessionId appears multiple times:
  //   1. exact local explicit locator wins
  //   2. id-less / legacy local locator wins next
  //   3. foreign explicit locator is kept only if no local candidate exists
  // Keep the same Claude UUID validation rules as extractSessionRef().

  return order.map((key) => bestByKey.get(key)!)
}

export function collectSessionRefsFromTabs(
  tabs: RootState['tabs']['tabs'],
  panes: Pick<RootState['panes'], 'layouts'>,
): Array<{ provider: CodingCliProviderName; sessionId: string }> {
  return collectSessionLocatorsFromTabs(tabs, panes).map(({ provider, sessionId }) => ({ provider, sessionId }))
}
```

Then refactor `src/store/selectors/sidebarSelectors.ts` so `buildSessionItems()` uses `collectSessionRefsFromTabs()` instead of keeping its own inline tab traversal logic. The sidebar `hasTab` behavior stays unchanged in this task; the new locator helper exists so Task 4 can apply local-only hydration rules without losing local-vs-foreign duplicate context.

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/session-utils.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/lib/session-utils.ts src/store/selectors/sidebarSelectors.ts test/unit/client/lib/session-utils.test.ts
git commit -m "refactor: share open-tab session locator collection"
```

---

### Task 2: Add Exact Session Resolve API And Authoritative Catalog-Version Contract

**Files:**
- Modify: `server/session-pagination.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/sessions-sync/service.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `src/lib/api.ts`
- Create: `test/unit/server/sessions-router.resolve.test.ts`
- Modify: `test/unit/server/sessions-router-pagination.test.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/server/ws-sessions-patch.test.ts`
- Modify: `test/unit/client/lib/api.test.ts`

**Step 1: Write the failing server and client API tests**

Create `test/unit/server/sessions-router.resolve.test.ts` with cases for:

- `POST /sessions/resolve` returns only requested sessions, grouped by project
- duplicate request entries are deduped
- missing sessions are ignored instead of failing the whole request
- malformed bodies return `400`

Extend `test/unit/server/sessions-router-pagination.test.ts` so both unpaginated and paginated `/sessions` responses include an authoritative `catalogVersion`, and a page-2 fetch for an unchanged catalog returns the same token as page 1.

Extend websocket tests so:

- `sessions.updated` carries `catalogVersion`
- `sessions.page` carries `catalogVersion`
- chunked `sessions.updated` messages for one snapshot all carry the same token
- an identical HTTP baseline and identical websocket snapshot reuse the same `catalogVersion`
- `sessions.patch` carries the post-change `catalogVersion`

Add client tests to `test/unit/client/lib/api.test.ts` that verify:

- a new typed sessions-catalog helper parses `{ projects, catalogVersion, ...paginationMeta }`
- the resolve helper POSTs JSON like:

```json
{
  "sessions": [
    { "provider": "codex", "sessionId": "019cbc9d-bea0-7c93-9248-21d7e48f8ead" }
  ]
}
```

to `/api/sessions/resolve`

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run \
  test/unit/server/sessions-router.resolve.test.ts \
  test/unit/server/sessions-router-pagination.test.ts \
  test/server/ws-handshake-snapshot.test.ts \
  test/server/ws-sessions-patch.test.ts \
  test/unit/client/lib/api.test.ts
```

Expected: FAIL because the route exists only conceptually and the authoritative catalog token contract does not exist yet.

**Step 3: Implement the route and shared catalog-version contract**

In `server/session-pagination.ts`, add an authoritative catalog token helper and thread it through the paginated result:

```typescript
export interface PaginatedResult {
  projects: ProjectGroup[]
  catalogVersion: string
  totalSessions: number
  oldestIncludedTimestamp: number
  oldestIncludedSessionId: string
  hasMore: boolean
}

export function buildCatalogVersion(projects: ProjectGroup[]): string {
  // Use an existing server-side snapshot/change token if one already exists and
  // only advances when the catalog actually changes. Otherwise compute a stable
  // hash from the canonical indexed catalog so identical snapshots share the
  // same token regardless of transport or pagination.
}
```

In `server/sessions-router.ts`:

- make `/sessions` always return an envelope shaped like `{ projects, catalogVersion }`, plus pagination metadata when `limit` or `before` is used
- keep the `POST /sessions/resolve` body capped at `200`
- keep `/sessions/resolve` as a lookup-only helper returning `{ projects }` without advancing or minting a new catalog token

In `server/ws-handler.ts` and `shared/ws-protocol.ts`:

- extend `SessionsUpdatedMessage`, `SessionsPageMessage`, and `SessionsPatchMessage` with `catalogVersion: string`
- include the same `catalogVersion` on every chunk of a chunked `sessions.updated` snapshot
- include the current catalog token on `sessions.page`

In `server/sessions-sync/service.ts`:

- compute or receive the authoritative post-diff `catalogVersion` for `next`
- include that token in `sessions.patch`
- keep the same token when broadcasting unchanged pagination/page views of the same catalog

In `src/lib/api.ts`, add typed helpers:

```typescript
export type SessionsCatalogResponse = {
  projects: ProjectGroup[]
  catalogVersion: string
  totalSessions?: number
  oldestIncludedTimestamp?: number
  oldestIncludedSessionId?: string
  hasMore?: boolean
}

export async function fetchSessionsCatalog(
  params?: { limit?: number; before?: number; beforeId?: string },
): Promise<SessionsCatalogResponse> {
  // centralize the new envelope contract here
}

export async function resolveSessions(
  sessions: Array<{ provider: CodingCliProviderName; sessionId: string }>,
): Promise<{ projects: ProjectGroup[] }> {
  return api.post('/api/sessions/resolve', { sessions })
}
```

**Contract invariant to document in comments and tests:** the authoritative token represents the full indexed catalog, not the requested page. For the same underlying catalog, `/api/sessions`, `sessions.updated`, and `sessions.page` all expose the same token. Page 2 loads do not manufacture a new token.

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run \
  test/unit/server/sessions-router.resolve.test.ts \
  test/unit/server/sessions-router-pagination.test.ts \
  test/server/ws-handshake-snapshot.test.ts \
  test/server/ws-sessions-patch.test.ts \
  test/unit/client/lib/api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add server/session-pagination.ts server/sessions-router.ts server/ws-handler.ts server/sessions-sync/service.ts shared/ws-protocol.ts src/lib/api.ts test/unit/server/sessions-router.resolve.test.ts test/unit/server/sessions-router-pagination.test.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-sessions-patch.test.ts test/unit/client/lib/api.test.ts
git commit -m "feat: add authoritative sessions catalog version contract"
```

---

### Task 3: Add Server-Baseline Gating, Authoritative Catalog State, And Durable Open-Tab Hydration State

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`
- Modify: `test/unit/client/sessionsSlice.pagination.test.ts`

**Step 1: Write the failing reducer tests**

Add reducer tests covering three concerns:

1. `mergeResolvedProjects()` behavior:
- adding an older resolved session into an already-loaded project without dropping existing sessions
- adding a resolved session for a project not yet present in `state.projects`
- replacing a stale copy of an already-known session by `provider:sessionId`
- preserving provider collisions (`claude:s1` and `codex:s1` are different sessions)
- **not** setting `serverBaselineReady`
- **not** changing `serverCatalogVersion`
- **not** modifying `lastLoadedAt`

2. Authoritative server-catalog reducers:
- `replaceProjectsFromServer`, `mergeSnapshotProjectsFromServer`, `appendSessionsPageFromServer`, and `applySessionsPatchFromServer` set `serverBaselineReady = true`
- those reducers copy the exact `catalogVersion` from the payload instead of incrementing a client counter
- replaying an identical baseline, identical snapshot, or page append with the same `catalogVersion` keeps the same token in state and does not falsely clear suppression for parked keys
- `clearProjects()` resets `serverBaselineReady`, `serverCatalogVersion`, and `openTabHydration`

3. Durable hydration state:
- `markOpenTabHydrationRequested()` marks keys as `inFlight`
- `settleOpenTabHydrationRequest()` clears resolved keys and marks zero-result keys as unresolved for the request's own `catalogVersion`
- `failOpenTabHydrationRequest()` clears `inFlight` and parks failed keys on the request's own `catalogVersion`

Use concrete examples like:

```typescript
state = sessionsReducer(state, replaceProjectsFromServer({
  projects: initialProjects,
  catalogVersion: 'catalog-v1',
}))

const beforeLastLoadedAt = state.lastLoadedAt

state = sessionsReducer(state, mergeResolvedProjects([
  {
    projectPath: '/project/a',
    sessions: [
      { provider: 'codex', sessionId: 'open-old', projectPath: '/project/a', updatedAt: 123, title: 'Open old session' },
    ],
  },
]))

expect(state.lastLoadedAt).toBe(beforeLastLoadedAt)
expect(state.serverCatalogVersion).toBe('catalog-v1')

state = sessionsReducer(state, markOpenTabHydrationRequested({
  sessionKeys: ['codex:missing-open'],
}))

state = sessionsReducer(state, settleOpenTabHydrationRequest({
  requestedKeys: ['codex:missing-open'],
  resolvedKeys: [],
  catalogVersion: 'catalog-v1',
}))

expect(state.openTabHydration['codex:missing-open']).toEqual({
  inFlight: false,
  unresolvedCatalogVersion: 'catalog-v1',
})

state = sessionsReducer(state, failOpenTabHydrationRequest({
  sessionKeys: ['codex:failing-open'],
  catalogVersion: 'catalog-v1',
}))

expect(state.openTabHydration['codex:failing-open']).toEqual({
  inFlight: false,
  failedCatalogVersion: 'catalog-v1',
})
```

**Step 2: Run the reducer tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: FAIL because the authoritative catalog reducers and new hydration metadata do not exist yet.

**Step 3: Implement authoritative catalog tracking, durable hydration metadata, and `mergeResolvedProjects`**

Extend `SessionsState` with:

```typescript
serverBaselineReady: boolean
serverCatalogVersion: string | null
openTabHydration: Record<string, {
  inFlight: boolean
  unresolvedCatalogVersion?: string
  failedCatalogVersion?: string
}>
```

Add small helpers inside `src/store/sessionsSlice.ts`:

```typescript
function knownSessionKeys(projects: ProjectGroup[]): Set<string> {
  const keys = new Set<string>()
  for (const project of projects) {
    for (const session of project.sessions) {
      keys.add(`${(session as any).provider || 'claude'}:${(session as any).sessionId}`)
    }
  }
  return keys
}

function applyServerCatalogVersion(state: SessionsState, catalogVersion: string): void {
  state.serverBaselineReady = true
  state.serverCatalogVersion = catalogVersion
}

function clearKnownHydrationEntries(state: SessionsState): void {
  const known = knownSessionKeys(state.projects)
  for (const key of Object.keys(state.openTabHydration)) {
    if (known.has(key)) delete state.openTabHydration[key]
  }
}
```

Then:

- initialize `serverBaselineReady = false` and `serverCatalogVersion = null`
- add server-aware reducers such as:

```typescript
replaceProjectsFromServer: (
  state,
  action: PayloadAction<{ projects: ProjectGroup[]; catalogVersion: string }>,
) => { /* replace, set lastLoadedAt, applyServerCatalogVersion */ },

mergeSnapshotProjectsFromServer: (
  state,
  action: PayloadAction<{ projects: ProjectGroup[]; catalogVersion: string }>,
) => { /* existing mergeSnapshotProjects logic + applyServerCatalogVersion */ },

appendSessionsPageFromServer: (
  state,
  action: PayloadAction<{ projects: ProjectGroup[]; catalogVersion: string }>,
) => { /* existing appendSessionsPage logic + applyServerCatalogVersion */ },

applySessionsPatchFromServer: (
  state,
  action: PayloadAction<{
    upsertProjects: ProjectGroup[]
    removeProjectPaths: string[]
    catalogVersion: string
  }>,
) => { /* existing applySessionsPatch logic + applyServerCatalogVersion */ },
```

- keep `mergeResolvedProjects()` as a **local** partial upsert and do **not** touch `lastLoadedAt`, `serverBaselineReady`, or `serverCatalogVersion`
- preserve existing generic/local reducers only where they still make sense, but route all authoritative HTTP and websocket session ingress through the new server-aware reducers
- make `clearProjects()` reset `serverBaselineReady = false`, `serverCatalogVersion = null`, and `openTabHydration = {}`
- implement:

```typescript
markOpenTabHydrationRequested: (state, action: PayloadAction<{ sessionKeys: string[] }>) => {
  for (const key of action.payload.sessionKeys) {
    const current = state.openTabHydration[key]
    state.openTabHydration[key] = {
      inFlight: true,
      unresolvedCatalogVersion: current?.unresolvedCatalogVersion,
      failedCatalogVersion: current?.failedCatalogVersion,
    }
  }
},

settleOpenTabHydrationRequest: (
  state,
  action: PayloadAction<{ requestedKeys: string[]; resolvedKeys: string[]; catalogVersion: string }>,
) => {
  const resolved = new Set(action.payload.resolvedKeys)
  for (const key of action.payload.requestedKeys) {
    if (resolved.has(key)) {
      delete state.openTabHydration[key]
      continue
    }
    state.openTabHydration[key] = {
      inFlight: false,
      unresolvedCatalogVersion: action.payload.catalogVersion,
    }
  }
},

failOpenTabHydrationRequest: (
  state,
  action: PayloadAction<{ sessionKeys: string[]; catalogVersion: string }>,
) => {
  for (const key of action.payload.sessionKeys) {
    const current = state.openTabHydration[key]
    if (!current) continue
    state.openTabHydration[key] = {
      ...current,
      inFlight: false,
      failedCatalogVersion: action.payload.catalogVersion,
    }
  }
},
```

Keep `mergeResolvedProjects()` as the partial-upsert reducer from the original plan, but after it writes `state.projects`, call `clearKnownHydrationEntries(state)` so keys that were just resolved disappear from the suppression map without pretending that a fresh authoritative baseline landed.

**Step 4: Re-run the reducer tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: PASS. In particular:

- `mergeResolvedProjects()` leaves `lastLoadedAt` unchanged
- the store copies the exact server token instead of incrementing a pseudo-revision
- same-token page loads and identical snapshots keep parked keys suppressed
- settle/fail park keys on the request's own token

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/store/sessionsSlice.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts
git commit -m "feat: track authoritative open-tab hydration state"
```

---

### Task 4: Add Baseline-Gated, Batched, Local-Only Hydration Selectors And App Orchestration

**Files:**
- Create: `src/store/selectors/openSessionSelectors.ts`
- Create: `test/unit/client/store/selectors/openSessionSelectors.test.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Create: `test/unit/client/components/App.open-tab-session-hydration.test.tsx`

**Step 1: Write the failing selector and App tests**

Create `test/unit/client/store/selectors/openSessionSelectors.test.ts` covering:

- no refs are hydratable before `serverBaselineReady` is true and `serverCatalogVersion` is set
- only open sessions missing from `state.sessions.projects` are returned
- mixed-locality duplicates prefer the local locator over a foreign copied-tab locator for the same `provider:sessionId`
- explicit foreign locators (`sessionRef.serverInstanceId !== state.connection.serverInstanceId`) are excluded when no local candidate exists
- explicit locators wait when `sessionRef.serverInstanceId` exists but the local `serverInstanceId` is still unknown
- keys parked in `openTabHydration` for the current `serverCatalogVersion` are excluded
- keys parked by `failedCatalogVersion` for the current `serverCatalogVersion` are excluded
- a later `serverCatalogVersion` makes the same unresolved local key eligible again
- `appendSessionsPageFromServer()` with the same `catalogVersion` does **not** re-arm parked keys
- an identical `replaceProjectsFromServer()` / `mergeSnapshotProjectsFromServer()` with the same `catalogVersion` does **not** re-arm parked keys
- unrelated state changes return the same memoized array reference

Create `test/unit/client/components/App.open-tab-session-hydration.test.tsx` covering:

- before the first authoritative server baseline, restored open local sessions do **not** call `/api/sessions/resolve`
- if the first baseline page already contains the open session, hydration never fires for it
- bootstrap loads `/api/sessions?limit=100` with `catalogVersion: 'catalog-v1'` without the open session
- App then calls `POST /api/sessions/resolve` exactly once for the missing open session
- App dispatches `mergeResolvedProjects()` and the store ends up containing that session
- the request still settles correctly even though `markOpenTabHydrationRequested()` removes the refs from `selectHydratableOpenSessionRefs` during the same render cycle
- more than 200 missing open sessions are sent in multiple requests that each respect the route cap
- a zero-result `/api/sessions/resolve` response marks the key unresolved and does **not** immediately repost on rerender or unrelated local state changes
- a delayed-index case: first resolve returns zero projects, then an identical websocket snapshot with the **same** `catalogVersion` does **not** re-arm the key, then a later server-driven catalog update with `catalogVersion: 'catalog-v2'` re-arms it and a second resolve merges it successfully
- a scroll pagination response (`sessions.page`) with the same `catalogVersion` does **not** re-arm a parked key
- a persistent 500/network failure parks the key on the request's own token and does **not** immediately retrigger the same request on the next render
- a copied remote tab with `sessionRef.serverInstanceId = 'srv-remote'` and local `serverInstanceId = 'srv-local'` never calls `/api/sessions/resolve`
- if the catalog changes while `/api/sessions/resolve` is in flight, settle/fail still use the request's snapshotted token so the key becomes eligible again under the newer token
- the success-path request does not leave keys stuck in `openTabHydration.inFlight` after the promise resolves

Mock heavy children (`TabContent`, `HistoryView`, etc.) but keep the real store and `App`.

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/selectors/openSessionSelectors.test.ts test/unit/client/components/App.open-tab-session-hydration.test.tsx
```

Expected: FAIL because the selectors, server-aware ingress wiring, and durable request snapshot do not exist yet.

**Step 3: Implement the selectors and snapshot-based hydration orchestration**

Create `src/store/selectors/openSessionSelectors.ts` with stable memoized selectors built on the new locator helper:

```typescript
const selectProjects = (state: RootState) => state.sessions.projects
const selectTabs = (state: RootState) => state.tabs.tabs
const selectPanes = (state: RootState) => state.panes
const selectServerBaselineReady = (state: RootState) => state.sessions.serverBaselineReady
const selectServerCatalogVersion = (state: RootState) => state.sessions.serverCatalogVersion
const selectLocalServerInstanceId = (state: RootState) => state.connection.serverInstanceId
const selectOpenTabHydration = (state: RootState) => state.sessions.openTabHydration

function toSessionKey(provider: CodingCliProviderName, sessionId: string): string {
  return `${provider}:${sessionId}`
}

export const selectHydratableOpenSessionLocators = createSelector(
  [
    selectProjects,
    selectTabs,
    selectPanes,
    selectServerBaselineReady,
    selectServerCatalogVersion,
    selectLocalServerInstanceId,
    selectOpenTabHydration,
  ],
  (projects, tabs, panes, serverBaselineReady, serverCatalogVersion, localServerInstanceId, openTabHydration) => {
    if (!serverBaselineReady || !serverCatalogVersion) return []

    const known = new Set<string>()
    for (const project of projects) {
      for (const session of project.sessions) {
        known.add(toSessionKey(session.provider || 'claude', session.sessionId))
      }
    }

    return collectSessionLocatorsFromTabs(tabs, panes, { localServerInstanceId }).filter((locator) => {
      const key = toSessionKey(locator.provider, locator.sessionId)
      if (known.has(key)) return false

      if (locator.serverInstanceId) {
        if (!localServerInstanceId) return false
        if (locator.serverInstanceId !== localServerInstanceId) return false
      }

      const hydration = openTabHydration[key]
      if (hydration?.inFlight) return false
      if (hydration?.unresolvedCatalogVersion === serverCatalogVersion) return false
      if (hydration?.failedCatalogVersion === serverCatalogVersion) return false
      return true
    })
  },
)

export const selectHydratableOpenSessionRefs = createSelector(
  [selectHydratableOpenSessionLocators],
  (locators) => locators.map(({ provider, sessionId }) => ({ provider, sessionId })),
)
```

Update all authoritative session-catalog ingress in the client:

- `src/App.tsx` initial `/api/sessions?limit=100` bootstrap uses `fetchSessionsCatalog()` and dispatches `replaceProjectsFromServer({ projects, catalogVersion })`
- chunked `sessions.updated` buffering stores both the projects and the snapshot `catalogVersion`; when flushed, dispatch either `replaceProjectsFromServer()` or `mergeSnapshotProjectsFromServer()` with that same token
- `sessions.page` dispatches `appendSessionsPageFromServer({ projects, catalogVersion })`
- `sessions.patch` dispatches `applySessionsPatchFromServer({ upsertProjects, removeProjectPaths, catalogVersion })`
- `src/components/HistoryView.tsx` and `src/components/context-menu/ContextMenuProvider.tsx` switch to the new sessions-catalog helper so they understand the envelope response too

In `src/App.tsx`, do **not** fire `resolveSessions()` directly from the same effect that reads `selectHydratableOpenSessionRefs`, because dispatching `markOpenTabHydrationRequested()` will immediately remove those refs from the selector and trigger cleanup of that effect.

Instead, add a snapshotted local request state:

```typescript
type OpenTabHydrationBatch = {
  requestedKeys: string[]
  refs: Array<{ provider: CodingCliProviderName; sessionId: string }>
}

type OpenTabHydrationRequest = {
  requestKey: string
  catalogVersion: string
  requestedKeys: string[]
  batches: OpenTabHydrationBatch[]
}
```

Then use two effects:

1. a **queueing** effect that snapshots the current selector output plus the current `serverCatalogVersion` into local component state and marks Redux `inFlight`
2. a **runner** effect that performs `resolveSessions()` from the stable local snapshot, batch-by-batch, so selector changes during the in-flight window do not cancel the request and large workspaces still respect the route cap

Sketch:

```typescript
const hydratableOpenSessionRefs = useAppSelector(selectHydratableOpenSessionRefs)
const serverCatalogVersion = useAppSelector((state) => state.sessions.serverCatalogVersion)
const [activeOpenTabHydrationRequest, setActiveOpenTabHydrationRequest] =
  useState<OpenTabHydrationRequest | null>(null)
const OPEN_SESSION_RESOLVE_BATCH_SIZE = 200

useEffect(() => {
  if (activeOpenTabHydrationRequest || hydratableOpenSessionRefs.length === 0 || !serverCatalogVersion) return

  const requestedKeys = hydratableOpenSessionRefs
    .map((ref) => `${ref.provider}:${ref.sessionId}`)
    .sort()
  const requestKey = `${serverCatalogVersion}|${requestedKeys.join('|')}`

  const request = {
    requestKey,
    catalogVersion: serverCatalogVersion,
    requestedKeys,
    batches: chunkArray(hydratableOpenSessionRefs, OPEN_SESSION_RESOLVE_BATCH_SIZE).map((refs) => ({
      refs,
      requestedKeys: refs.map((ref) => `${ref.provider}:${ref.sessionId}`),
    })),
  }

  dispatch(markOpenTabHydrationRequested({ sessionKeys: requestedKeys }))
  setActiveOpenTabHydrationRequest(request)
}, [dispatch, hydratableOpenSessionRefs, serverCatalogVersion, activeOpenTabHydrationRequest])

useEffect(() => {
  if (!activeOpenTabHydrationRequest) return

  let cancelled = false
  const { requestedKeys, batches, requestKey, catalogVersion } = activeOpenTabHydrationRequest

  void (async () => {
    const resolvedKeys: string[] = []
    try {
      for (const batch of batches) {
        const response = await resolveSessions(batch.refs)
        if (cancelled) return

        const projects = response.projects || []
        const batchResolvedKeys = projects.flatMap((project) =>
          (project.sessions || []).map((session: any) => `${session.provider || 'claude'}:${session.sessionId}`),
        )
        resolvedKeys.push(...batchResolvedKeys)

        if (projects.length > 0) {
          dispatch(mergeResolvedProjects(projects))
        }
      }

      if (cancelled) return
      dispatch(settleOpenTabHydrationRequest({ requestedKeys, resolvedKeys, catalogVersion }))
    } catch (err) {
      if (cancelled) return
      log.warn('Failed to resolve open-tab sessions', err)

      const resolved = new Set(resolvedKeys)
      const failedKeys = requestedKeys.filter((key) => !resolved.has(key))
      dispatch(failOpenTabHydrationRequest({ sessionKeys: failedKeys, catalogVersion }))
    } finally {
      if (cancelled) return
      setActiveOpenTabHydrationRequest((current) =>
        current?.requestKey === requestKey ? null : current
      )
    }
  })()

  return () => { cancelled = true }
}, [dispatch, activeOpenTabHydrationRequest?.requestKey])
```

Key guardrails:

- do not run for copied remote tabs whose explicit `sessionRef.serverInstanceId` points at another server
- do not guess that a locator with explicit `serverInstanceId` is local before `state.connection.serverInstanceId` is known
- do not queue anything before `serverBaselineReady` is true and `serverCatalogVersion` is known
- do not dispatch placeholder sidebar rows before the canonical payload arrives
- marking keys `inFlight` must not cancel the request that just claimed them
- the runner effect must settle or fail the exact snapshotted `requestedKeys` and `catalogVersion` even after `selectHydratableOpenSessionRefs` becomes empty
- each network call must respect the route cap (`<= 200` refs per request)
- a zero-result resolve must park the key on the request's own `catalogVersion`
- a resolve failure must park the key on the request's own `catalogVersion`
- only a later **server-driven** catalog update with a different `catalogVersion` should make the unresolved key eligible again; `mergeResolvedProjects()` alone must not do that
- only a later **server-driven** catalog update with a different `catalogVersion` should make a failed key eligible again; the same failing request must not immediately retrigger on the next render
- `sessions.page` responses that keep the same `catalogVersion` must not re-arm parked keys, because scroll pagination is not a catalog mutation
- an identical websocket snapshot with the same `catalogVersion` must not re-arm parked keys

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/selectors/openSessionSelectors.test.ts test/unit/client/components/App.open-tab-session-hydration.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/store/selectors/openSessionSelectors.ts src/App.tsx src/components/HistoryView.tsx src/components/context-menu/ContextMenuProvider.tsx test/unit/client/store/selectors/openSessionSelectors.test.ts test/unit/client/components/App.open-tab-session-hydration.test.tsx
git commit -m "feat: hydrate open-tab sessions from authoritative catalog state"
```

---

### Task 5: Add A User-Visible Sidebar Regression Test

**Files:**
- Create: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

**Step 1: Write the failing end-to-end regression test**

Create focused UI flows in `test/e2e/open-tab-session-sidebar-visibility.test.tsx` that:

1. local-session case:
   - render `App` with a preloaded tab and pane resuming `codex:019cbc9d-bea0-7c93-9248-21d7e48f8ead`
   - mock `/api/sessions?limit=100` to return an envelope with `catalogVersion: 'catalog-v1'` and a page that does **not** include that session
   - mock `/api/sessions/resolve` to return the canonical session record with its real title and project
   - keep the real `Sidebar` mounted
   - assert the sidebar eventually shows the resolved session title and marks it as having a tab

2. remote-copy case:
   - render `App` with a preloaded copied pane whose `sessionRef.serverInstanceId` is `srv-remote`
   - set the local server instance to `srv-local`
   - assert `/api/sessions/resolve` is never called for that pane
   - assert the sidebar does not invent a local row for the foreign session

Target assertion shape:

```typescript
const button = await screen.findByRole('button', { name: /codex resume 019cbc9d/i })
expect(button).toHaveAttribute('data-has-tab', 'true')
expect(button).toHaveAttribute('data-provider', 'codex')
```

**Step 2: Run the new e2e test to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: FAIL before Task 4 is in place; PASS after Task 4.

**Step 3: Make the smallest production fix only if the e2e exposes a real gap**

Most likely no new production change is needed here. If the e2e still fails after Task 4, fix the actual issue it reveals instead of weakening the assertion.

**Step 4: Re-run the e2e and closely related sidebar flows**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "test: cover local and remote open-session sidebar hydration"
```

---

### Task 6: Full Verification And Final Cleanup

**Files:**
- No new files expected unless the full suite exposes follow-up fixes

**Step 1: Run the full focused regression set**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/server/sessions-router.resolve.test.ts \
  test/unit/server/sessions-router-pagination.test.ts \
  test/server/ws-handshake-snapshot.test.ts \
  test/server/ws-sessions-patch.test.ts \
  test/unit/client/lib/api.test.ts \
  test/unit/client/store/sessionsSlice.test.ts \
  test/unit/client/sessionsSlice.pagination.test.ts \
  test/unit/client/store/selectors/openSessionSelectors.test.ts \
  test/unit/client/components/App.open-tab-session-hydration.test.tsx \
  test/e2e/open-tab-session-sidebar-visibility.test.tsx \
  test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 2: Run typecheck + tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npm run check
```

Expected: PASS.

**Step 3: Run the full test suite required before merge**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npm test
```

Expected: PASS.

**Step 4: Final review before handoff**

Verify all of the following are true before marking the implementation complete:

- open local sessions outside the newest 100 appear in the sidebar after hydration
- copied foreign tabs are ignored by hydration
- local-vs-foreign duplicate locators prefer the local candidate
- zero-result resolves do not loop forever during the indexer window
- persistent resolve failures do not tight-loop
- `mergeResolvedProjects()` does not change `lastLoadedAt`
- identical HTTP + WS snapshots do not re-arm parked keys
- `sessions.page` loads with the same `catalogVersion` do not re-arm parked keys
- a catalog change that lands while resolve is in flight still allows a retry afterward

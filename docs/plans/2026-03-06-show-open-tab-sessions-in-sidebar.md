# Show Open-Tab Sessions In Sidebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Ensure any session already open in a local tab is present in the left sidebar at bootstrap and after later local tab/open/restore actions, even when that session is older than the default paginated 100-session window.

**Architecture:** Keep sidebar selection authoritative on the server, but keep exact session-locator identity authoritative on the client until after match/open decisions are made. Local session opens must prefer local or id-less tab state and must not collapse back to plain `provider:sessionId` early enough for a foreign copied tab to hijack the action. On the server, teach the first-page selector to union matching local session keys into page 1 while preserving the real cursor boundary for page 2+ and computing `hasMore` from the unique sessions not already present in that expanded first page. Reuse that selector in the three places that matter: JSON-bodied HTTP bootstrap/query when open-session locators must be sent, the websocket handshake snapshot, and a per-connection refresh triggered by `ui.layout.sync`. To make that later refresh see the same open-session state as bootstrap, extend `ui.layout.sync` so it carries tab-level fallback session locators for tabs that have `resumeSessionId` but do not yet have a pane layout.

**Tech Stack:** React 18, Redux Toolkit, Express, WebSocket (`ws`), Zod, Vitest, Testing Library

---

**Notes:**
- Work in `/home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar`.
- The invariant to satisfy is broader than “fix initial hydration”: `state.sessions.projects` must contain any session that is open in a local tab, because the sidebar renders only from that state.
- Do not add client-side synthetic sidebar items, `POST /sessions/resolve`, `mergeResolvedProjects()`, `lastLoadedAt` retry gates, or any second sidebar data source.
- Do not add count caps like `.max(200)` to websocket hello/session payloads. Existing byte-based HTTP and websocket limits are the correct safety boundary.
- Do not encode locator JSON into query params. Use JSON request bodies when locators must cross HTTP.
- Rebuttal to review issue 3: the server already knows which server instance is local. Normalize locators against the authoritative server instance id in `server/index.ts`/`server/ws-handler.ts`; do not depend on the client to tell the server which instance is local.
- Later websocket refreshes must preserve the same no-layout fallback as bootstrap. Do not recompute only from `m.layouts`; recompute from `m.layouts` plus tab-level fallback session locators mirrored in `ui.layout.sync.tabs`.
- Exact locators are authoritative for navigation and dedupe. Collapse to plain `provider:sessionId` only in display-only selectors such as sidebar `hasTab`, not in `findTabIdForSession`, `findPaneForSession`, or `openSessionTab`.
- Only the first page is force-included. Page 2+ must continue to paginate from the normal page-1 cursor boundary.
- First-page `hasMore` means “there exists at least one unique session not already present in the expanded page-1 result.” Do not derive it from `primaryPage.length` or raw `allSessions.length > limit`.
- Inclusion is additive. Existing `mergeSnapshotProjects()` behavior can keep an older session visible after its tab closes; that is acceptable for this change.
- No `docs/index.html` update is needed because the UI surface is unchanged.

### Task 1: Collect Exact Open-Session Locators On The Client

**Files:**
- Modify: `src/lib/session-utils.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `test/unit/client/lib/session-utils.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`

**Step 1: Write the failing tests**

In `test/unit/client/lib/session-utils.test.ts`, add coverage for a new exact-locator path that preserves mixed local/remote candidates instead of collapsing immediately to `provider:sessionId`.

Add expectations like:

```typescript
expect(collectSessionLocatorsFromTabs(tabs, panes)).toEqual([
  { provider: 'codex', sessionId: 'shared', serverInstanceId: 'srv-remote' },
  { provider: 'codex', sessionId: 'shared' },
  { provider: 'claude', sessionId: VALID_SESSION_ID },
])

expect(collectSessionRefsFromTabs(tabs, panes)).toEqual([
  { provider: 'codex', sessionId: 'shared' },
  { provider: 'claude', sessionId: VALID_SESSION_ID },
])
```

Cover:
- explicit `sessionRef` with `serverInstanceId`
- terminal panes and `agent-chat` panes
- legacy tab-level `resumeSessionId` fallback when a tab has no layout yet
- exact duplicate locators deduped by full locator identity
- mixed local/foreign candidates for the same `provider:sessionId` preserved in the exact-locator helper
- invalid Claude ids ignored exactly the same way current helpers ignore them

In `test/unit/client/store/selectors/sidebarSelectors.test.ts`, add a regression proving `buildSessionItems()` still marks `hasTab` correctly after switching to `collectSessionRefsFromTabs()`.

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/session-utils.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts
```

Expected: FAIL because the exact-locator helper does not exist yet.

**Step 3: Implement the exact-locator collector and ref wrapper**

In `src/lib/session-utils.ts`:
- add `extractSessionLocator(content)` that preserves explicit `sessionRef.serverInstanceId`
- add `collectSessionLocatorsFromNode()` and `collectSessionLocatorsFromTabs()`
- dedupe exact locators by `provider + sessionId + serverInstanceId ?? ''`
- add `collectSessionRefsFromTabs()` as the wrapper that collapses exact locators to unique `provider:sessionId`
- keep `collectSessionRefsFromTabs()` explicitly display-only so later tasks do not reuse the lossy form for navigation/dedupe matching

Use a structure like:

```typescript
function locatorIdentity(locator: SessionLocator): string {
  return `${locator.provider}:${locator.sessionId}:${locator.serverInstanceId ?? ''}`
}

function sessionKey(locator: Pick<SessionLocator, 'provider' | 'sessionId'>): string {
  return `${locator.provider}:${locator.sessionId}`
}
```

Then refactor `src/store/selectors/sidebarSelectors.ts` so `buildSessionItems()` uses `collectSessionRefsFromTabs(tabs, panes)` instead of maintaining separate traversal logic.

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/session-utils.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/lib/session-utils.ts src/store/selectors/sidebarSelectors.ts test/unit/client/lib/session-utils.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts
git commit -m "refactor: collect exact open session locators"
```

### Task 2: Use Exact Locators For Local Session Matching And Open Flows

**Files:**
- Modify: `src/lib/session-utils.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `test/unit/client/lib/session-utils.test.ts`
- Modify: `test/unit/client/store/tabsSlice.test.ts`
- Modify: `test/unit/client/components/Sidebar.test.tsx`

**Step 1: Write the failing client-matching tests**

In `test/unit/client/lib/session-utils.test.ts`, extend the matcher coverage so exact locators remain authoritative after Task 1:
- a local target `{ provider, sessionId }` ignores a foreign explicit candidate when that is the only existing tab
- a local target prefers a local explicit or id-less fallback candidate over a foreign explicit candidate with the same `provider:sessionId`
- an explicit foreign target `{ provider, sessionId, serverInstanceId: 'srv-remote' }` still resolves to the foreign copied tab

Add expectations like:

```typescript
expect(findTabIdForSession(localAndForeignState, { provider: 'codex', sessionId: 'shared' }, 'srv-local')).toBe('tab-local')
expect(findTabIdForSession(foreignOnlyState, { provider: 'codex', sessionId: 'shared' }, 'srv-local')).toBeUndefined()
expect(findPaneForSession(
  state,
  { provider: 'codex', sessionId: 'shared', serverInstanceId: 'srv-remote' },
  'srv-local',
)).toEqual({ tabId: 'tab-remote', paneId: 'pane-remote' })
```

Use separate fixtures for:
- “local + foreign both exist” so preference ordering is explicit
- “foreign only exists” so the local target returns no match instead of hijacking
- no-layout fallback tabs where the local match is present only via tab-level `resumeSessionId`

In `test/unit/client/store/tabsSlice.test.ts`, add a thunk regression with `connection.serverInstanceId = 'srv-local'`:
- seed one foreign copied tab whose pane content has `sessionRef = { provider: 'codex', sessionId: 'shared', serverInstanceId: 'srv-remote' }`
- dispatch `openSessionTab({ provider: 'codex', sessionId: 'shared' })`
- assert it creates/activates a local tab with `resumeSessionId: 'shared'` instead of activating the foreign copy

In `test/unit/client/components/Sidebar.test.tsx`, add a click-path regression:
- seed the active tab with a foreign copied pane for `codex:shared`
- render a sidebar item for the local indexed `codex:shared` session
- click it and assert the component adds a new local pane/tab instead of focusing the foreign copied pane

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/session-utils.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/components/Sidebar.test.tsx
```

Expected: FAIL because the matching helpers still collapse to plain `provider:sessionId` and return the first foreign match they encounter.

**Step 3: Implement exact-locator-aware matching**

In `src/lib/session-utils.ts`:
- change `findTabIdForSession(...)` and `findPaneForSession(...)` to accept a target locator and `localServerInstanceId?: string`
- stop early-returning on the first `provider:sessionId` match; instead collect candidate locators and choose the best-scoring one
- score candidates so local session opens cannot be hijacked by foreign explicit copies:

```typescript
function matchScore(
  candidate: SessionLocator,
  target: SessionLocator,
  localServerInstanceId?: string,
): number {
  if (candidate.provider !== target.provider || candidate.sessionId !== target.sessionId) return 0
  if (target.serverInstanceId) {
    if (candidate.serverInstanceId === target.serverInstanceId) return 3
    if (target.serverInstanceId === localServerInstanceId && candidate.serverInstanceId == null) return 2
    return 0
  }
  if (candidate.serverInstanceId === localServerInstanceId) return 3
  if (candidate.serverInstanceId == null) return 2
  return 0
}
```

- treat tab-level `resumeSessionId` fallback as an id-less local candidate
- keep first-in-tab-order behavior only as the tie-breaker among candidates with the same positive score

In `src/store/tabsSlice.ts`:
- derive `const localServerInstanceId = state.connection.serverInstanceId`
- call `findTabIdForSession(state, { provider: resolvedProvider, sessionId }, localServerInstanceId)` before deduping
- keep the public thunk API local-session-oriented: `openSessionTab({ provider, sessionId })` still means “open the local session”, but it now resolves against exact locators instead of the collapsed key

In `src/components/Sidebar.tsx`:
- build the same local target locator from the clicked sidebar item
- pass `state.connection.serverInstanceId` into `findPaneForSession(...)`
- leave the rest of the click flow unchanged so the only behavioral change is “foreign copied tabs no longer satisfy local-session dedupe”

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/session-utils.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/components/Sidebar.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/lib/session-utils.ts src/store/tabsSlice.ts src/components/Sidebar.tsx test/unit/client/lib/session-utils.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/components/Sidebar.test.tsx
git commit -m "fix: prefer local session matches over foreign copies"
```

### Task 3: Add One Server-Side Sidebar Selection Path

**Files:**
- Create: `server/sidebar-session-selection.ts`
- Modify: `server/session-pagination.ts`
- Modify: `test/unit/server/session-pagination.test.ts`
- Create: `test/unit/server/sidebar-session-selection.test.ts`

**Step 1: Write the failing server-selection tests**

In `test/unit/server/sidebar-session-selection.test.ts`, cover the normalization rules:
- local explicit locator (`serverInstanceId === current server`) wins
- id-less locator counts as local fallback
- foreign-only explicit locators are ignored
- duplicates collapse to one forced session key

Add expectations like:

```typescript
expect(buildSidebarOpenSessionKeys([
  { provider: 'codex', sessionId: 'shared', serverInstanceId: 'srv-remote' },
  { provider: 'codex', sessionId: 'shared' },
  { provider: 'codex', sessionId: 'local-explicit', serverInstanceId: 'srv-local' },
  { provider: 'codex', sessionId: 'remote-only', serverInstanceId: 'srv-remote' },
], 'srv-local')).toEqual(new Set([
  'codex:shared',
  'codex:local-explicit',
]))
```

In `test/unit/server/session-pagination.test.ts`, add force-inclusion cases:
- first page returns normal newest-N sessions plus an older forced session outside the window
- a forced session already in the normal window is not duplicated
- page 2 ignores force-inclusion
- `oldestIncludedTimestamp` / `oldestIncludedSessionId` stay anchored to the primary first-page window, not the oldest forced extra
- `hasMore` is `false` when the force-included extras already cover every remaining unique session beyond the primary page
- `hasMore` stays `true` when at least one unseen unique session remains, even if page 2 will naturally include one duplicate forced session that the client later dedupes

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run --config vitest.server.config.ts test/unit/server/sidebar-session-selection.test.ts test/unit/server/session-pagination.test.ts
```

Expected: FAIL because the helper and pagination option do not exist yet.

**Step 3: Implement the shared selector and cursor-safe pagination**

Create `server/sidebar-session-selection.ts` with:
- `buildSidebarOpenSessionKeys(locators, serverInstanceId)`
- small helpers for `sessionKey()` and priority calculation

Use priority ordering:

```typescript
const priority =
  locator.serverInstanceId === serverInstanceId ? 3 :
  locator.serverInstanceId == null ? 2 :
  1
```

Only priorities `>= 2` become forced keys.

In `server/session-pagination.ts`:
- extend `PaginateOptions` with `forceIncludeSessionKeys?: ReadonlySet<string>`
- keep global filtering and sort order unchanged
- build `primaryPage = filteredSessions.slice(0, limit)`
- append `forcedExtras` only when `before` is absent
- keep cursor metadata derived from `primaryPage.at(-1)`
- compute `hasMore` from the unique sessions not already present in the returned page, not from raw page size

Use a shape like:

```typescript
const primaryPage = allSessions.slice(0, limit)
const primaryKeys = new Set(primaryPage.map(cursorKey))
const forcedExtras = isFirstPage && options.forceIncludeSessionKeys?.size
  ? allSessions.filter((session) => (
      options.forceIncludeSessionKeys!.has(cursorKey(session)) && !primaryKeys.has(cursorKey(session))
    ))
  : []

const page = [...primaryPage, ...forcedExtras].sort(compareSessionsDesc)
const pageKeys = new Set(page.map(cursorKey))
const hasMore = allSessions.some((session) => !pageKeys.has(cursorKey(session)))
const cursorSource = primaryPage.at(-1)
```

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run --config vitest.server.config.ts test/unit/server/sidebar-session-selection.test.ts test/unit/server/session-pagination.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add server/sidebar-session-selection.ts server/session-pagination.ts test/unit/server/sidebar-session-selection.test.ts test/unit/server/session-pagination.test.ts
git commit -m "feat: add sidebar session selection helper"
```

### Task 4: Use A JSON Sessions Query For Bootstrap When Open Tabs Exist

**Files:**
- Modify: `server/index.ts`
- Modify: `server/sessions-router.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/App.tsx`
- Modify: `test/unit/server/sessions-router-pagination.test.ts`
- Modify: `test/unit/client/lib/api.test.ts`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`

**Step 1: Write the failing HTTP/bootstrap tests**

In `test/unit/server/sessions-router-pagination.test.ts`, add `POST /sessions/query` coverage:
- returns a paginated first page plus an older forced session from `openSessions`
- ignores foreign-only locators
- preserves cursor metadata from the primary page boundary
- returns `hasMore: false` when the force-included set already covers every unique session beyond the primary window
- rejects invalid body shapes with `400`

In `test/unit/client/lib/api.test.ts`, add coverage for a helper like `fetchSidebarSessionsSnapshot()`:
- with no `openSessions`, it still calls `GET /api/sessions?limit=100`
- with `openSessions`, it calls `POST /api/sessions/query` with JSON

In `test/unit/client/components/App.ws-bootstrap.test.tsx`, add a regression with preloaded tabs/panes containing an older open session:
- `App` uses the new API helper during bootstrap
- the request body includes the exact open-session locators
- the resulting paginated response lands in `state.sessions.projects`

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run --config vitest.server.config.ts test/unit/server/sessions-router-pagination.test.ts
npx vitest run test/unit/client/lib/api.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx
```

Expected: FAIL because the POST route and client helper do not exist yet.

**Step 3: Implement the bootstrap query path**

In `server/index.ts`, pass `serverInstanceId` into `createSessionsRouter(...)`.

In `server/sessions-router.ts`:
- add an optional `serverInstanceId?: string` dependency
- add `POST /sessions/query`
- validate a JSON body like:

```typescript
const SessionsQuerySchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  before: z.number().nonnegative().optional(),
  beforeId: z.string().min(1).optional(),
  openSessions: z.array(SessionLocatorSchema).optional(),
})
```

- compute:

```typescript
const forcedKeys = buildSidebarOpenSessionKeys(
  parsed.data.openSessions ?? [],
  deps.serverInstanceId ?? '',
)

const result = paginateProjects(projects, {
  limit: parsed.data.limit,
  before: parsed.data.before,
  beforeId: parsed.data.beforeId,
  forceIncludeSessionKeys: forcedKeys,
})
```

In `src/lib/api.ts`, add `fetchSidebarSessionsSnapshot()`:
- keep the existing GET path when there are no `openSessions`
- use `POST /api/sessions/query` only when locators must be sent

In `src/App.tsx`, replace the hard-coded `api.get('/api/sessions?limit=100')` bootstrap calls with the helper and `collectSessionLocatorsFromTabs(...)` so both the initial bootstrap and the “ws already ready” refresh use the same logic.

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run --config vitest.server.config.ts test/unit/server/sessions-router-pagination.test.ts
npx vitest run test/unit/client/lib/api.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add server/index.ts server/sessions-router.ts src/lib/api.ts src/App.tsx test/unit/server/sessions-router-pagination.test.ts test/unit/client/lib/api.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "feat: personalize sidebar bootstrap sessions query"
```

### Task 5: Personalize WebSocket Snapshots And Refresh Them From `ui.layout.sync`

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/layoutMirrorMiddleware.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/App.tsx`
- Modify: `server/agent-api/layout-schema.ts`
- Modify: `server/agent-api/layout-store.ts`
- Modify: `server/ws-handler.ts`
- Modify: `test/unit/client/layout-mirror-middleware.test.ts`
- Modify: `test/unit/server/agent-layout-schema.test.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Create: `test/server/ws-sidebar-snapshot-refresh.test.ts`

**Step 1: Write the failing websocket tests**

Extend `test/server/ws-handshake-snapshot.test.ts` with a paginated-handshake case:
- the snapshot provider returns more than 100 sessions
- the client sends `hello` with `sidebarOpenSessions`
- the first `sessions.updated` snapshot includes the older open local session even though it is outside the first 100
- the cursor metadata still points at the normal first-page boundary
- when the force-included older sessions already cover the full remainder, the snapshot reports `hasMore: false`

Extend `test/unit/client/layout-mirror-middleware.test.ts` so a tab with `resumeSessionId` but no layout still emits:

```typescript
{
  type: 'ui.layout.sync',
  tabs: [{
    id: 'tab-1',
    title: 'alpha',
    fallbackSessionRef: { provider: 'codex', sessionId: 'older-open' },
  }],
  layouts: {},
  // ...
}
```

Extend `test/unit/server/agent-layout-schema.test.ts` so the schema accepts `tabs[].fallbackSessionRef`.

Create `test/server/ws-sidebar-snapshot-refresh.test.ts` covering the post-bootstrap invariant:
- connect and receive the normal paginated first page
- send `ui.layout.sync` for a tab that has no layout entry yet but does have `tabs[].fallbackSessionRef` for an older local session outside the first page
- assert the same websocket receives a fresh `sessions.updated` snapshot including that older session
- assert layout-backed sessions and tab-level fallback sessions dedupe cleanly when both identify the same session
- assert foreign-only copied-session locators do not trigger inclusion

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/layout-mirror-middleware.test.ts
npx vitest run --config vitest.server.config.ts test/unit/server/agent-layout-schema.test.ts
npx vitest run --config vitest.server.config.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
```

Expected: FAIL because hello does not carry sidebar locators yet, `ui.layout.sync` does not mirror tab-level fallback session refs, and the websocket refresh path cannot currently see no-layout tabs.

**Step 3: Implement websocket personalization**

In `shared/ws-protocol.ts`:
- add `SessionLocatorSchema`
- export its inferred type
- extend `HelloSchema` with an optional `sidebarOpenSessions: z.array(SessionLocatorSchema).optional()`
- extend `UiLayoutSyncSchema.tabs[]` with an optional `fallbackSessionRef: SessionLocatorSchema`

In `src/store/paneTypes.ts`, alias `SessionLocator` to the shared protocol type so client and server use the same shape.

In `src/store/layoutMirrorMiddleware.ts`, include the tab-level no-layout fallback in the mirrored payload:

```typescript
tabs: state.tabs.tabs.map((tab: any) => ({
  id: tab.id,
  title: tab.title,
  fallbackSessionRef: buildTabFallbackSessionRef(tab),
}))
```

where `buildTabFallbackSessionRef(tab)` returns:
- `undefined` for shell tabs or tabs without `resumeSessionId`
- `{ provider, sessionId }` for a local tab-level fallback session

In `src/lib/ws-client.ts`, extend `HelloExtensionProvider` so it can return `sidebarOpenSessions`.

In `src/App.tsx`, extend the hello provider:

```typescript
ws.setHelloExtensionProvider(() => ({
  sessions: getSessionsForHello(store.getState()),
  sidebarOpenSessions: collectSessionLocatorsFromTabs(
    store.getState().tabs.tabs,
    store.getState().panes,
  ),
  client: { mobile: isMobileRef.current },
}))
```

In `server/agent-api/layout-schema.ts` and `server/agent-api/layout-store.ts`, accept and store the richer `tabs[]` shape with optional `fallbackSessionRef` so websocket validation and the in-memory snapshot stay in sync.

In `server/ws-handler.ts`:
- add per-connection state for normalized sidebar-open keys/signature
- on `hello`, normalize `m.sidebarOpenSessions` with `buildSidebarOpenSessionKeys(..., this.serverInstanceId)`
- on `ui.layout.sync`, extract locators from pane `sessionRef` / `resumeSessionId` plus `tabs[].fallbackSessionRef` for tabs whose layout is still missing, recompute the key set, and if it changed, send a fresh personalized snapshot to that websocket
- extract one helper for paginated snapshots, then route handshake snapshots, `sessions.fetch`, and `broadcastSessionsUpdated()` through it so every paginated snapshot uses the same authoritative first-page selector

Use a handler shape like:

```typescript
case 'ui.layout.sync': {
  this.layoutStore?.updateFromUi(m, ws.connectionId || 'unknown')
  const nextKeys = buildSidebarOpenSessionKeys(
    [
      ...collectSessionLocatorsFromUiLayout(m.layouts),
      ...collectFallbackSessionLocatorsFromUiTabs(m.tabs, m.layouts),
    ],
    this.serverInstanceId,
  )
  if (!sameKeySet(state.sidebarOpenSessionKeys, nextKeys)) {
    state.sidebarOpenSessionKeys = nextKeys
    await this.sendSidebarSessionsSnapshot(ws, state)
  }
  return
}
```

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/layout-mirror-middleware.test.ts
npx vitest run --config vitest.server.config.ts test/unit/server/agent-layout-schema.test.ts
npx vitest run --config vitest.server.config.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add shared/ws-protocol.ts src/store/paneTypes.ts src/store/layoutMirrorMiddleware.ts src/lib/ws-client.ts src/App.tsx server/agent-api/layout-schema.ts server/agent-api/layout-store.ts server/ws-handler.ts test/unit/client/layout-mirror-middleware.test.ts test/unit/server/agent-layout-schema.test.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
git commit -m "feat: personalize websocket sidebar snapshots"
```

### Task 6: Add End-To-End Sidebar Visibility Regressions And Run Full Verification

**Files:**
- Create: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

**Step 1: Write the failing end-to-end regressions**

Create `test/e2e/open-tab-session-sidebar-visibility.test.tsx` using the existing component-e2e style:
- keep the real `Sidebar`
- mock `TabContent` and other heavy views only
- mock HTTP + websocket edges

Add two user-facing regressions:

1. Bootstrap path:
```typescript
expect(screen.getByText('Older Open Session')).toBeInTheDocument()
```
after rendering `App` with a restored open tab and a mocked `POST /api/sessions/query` response that contains the older open session.

2. Post-bootstrap no-layout path:
```typescript
store.dispatch(openSessionTab({ provider: 'codex', sessionId: 'older-open' }))
expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
  type: 'ui.layout.sync',
  tabs: expect.arrayContaining([
    expect.objectContaining({
      fallbackSessionRef: { provider: 'codex', sessionId: 'older-open' },
    }),
  ]),
}))
messageHandler?.(personalizedSidebarSnapshot)
expect(screen.getByText('Older Open Session')).toBeInTheDocument()
```

Keep `TabContent` mocked in this test so the tab remains in the no-layout state long enough to prove the fallback `ui.layout.sync` path, then assert the actual sidebar updates once the personalized websocket refresh arrives.

**Step 2: Run the new e2e file to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: FAIL until the production changes are complete.

**Step 3: Implement any missing harness adjustments**

Keep production code unchanged here unless the new e2e test exposes a real bug. If it does, fix the production bug minimally and rerun the smallest affected unit/integration tests before rerunning the e2e file.

**Step 4: Re-run the e2e file**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: PASS.

**Step 5: Run the full verification suite**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npm test
npm run check
```

Expected: PASS.

**Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "test: cover sidebar visibility for open old sessions"
```

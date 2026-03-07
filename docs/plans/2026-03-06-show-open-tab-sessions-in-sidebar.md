# Show Open-Tab Sessions In Sidebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Ensure any session already open in a local tab is present in the left sidebar at bootstrap and after later local tab/open/restore actions, even when that session is older than the default paginated 100-session window.

**Architecture:** Keep sidebar selection authoritative on the server. Normalize exact open-session locators from local tabs, then teach the server’s first-page session selector to union matching local session keys into page 1 while preserving the real cursor boundary for page 2+. Reuse that same selector in the three places that matter: JSON-bodied HTTP bootstrap/query when open-session locators must be sent, the websocket handshake snapshot, and a per-connection refresh triggered by the existing `ui.layout.sync` stream when the local open-session set changes.

**Tech Stack:** React 18, Redux Toolkit, Express, WebSocket (`ws`), Zod, Vitest, Testing Library

---

**Notes:**
- Work in `/home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar`.
- The invariant to satisfy is broader than “fix initial hydration”: `state.sessions.projects` must contain any session that is open in a local tab, because the sidebar renders only from that state.
- Do not add client-side synthetic sidebar items, `POST /sessions/resolve`, `mergeResolvedProjects()`, `lastLoadedAt` retry gates, or any second sidebar data source.
- Do not add count caps like `.max(200)` to websocket hello/session payloads. Existing byte-based HTTP and websocket limits are the correct safety boundary.
- Do not encode locator JSON into query params. Use JSON request bodies when locators must cross HTTP.
- Rebuttal to review issue 3: the server already knows which server instance is local. Normalize locators against the authoritative server instance id in `server/index.ts`/`server/ws-handler.ts`; do not depend on the client to tell the server which instance is local.
- Only the first page is force-included. Page 2+ must continue to paginate from the normal page-1 cursor boundary.
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

### Task 2: Add One Server-Side Sidebar Selection Path

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

### Task 3: Use A JSON Sessions Query For Bootstrap When Open Tabs Exist

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

### Task 4: Personalize WebSocket Snapshots And Refresh Them From `ui.layout.sync`

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `src/store/paneTypes.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/App.tsx`
- Modify: `server/ws-handler.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Create: `test/server/ws-sidebar-snapshot-refresh.test.ts`

**Step 1: Write the failing websocket tests**

Extend `test/server/ws-handshake-snapshot.test.ts` with a paginated-handshake case:
- the snapshot provider returns more than 100 sessions
- the client sends `hello` with `sidebarOpenSessions`
- the first `sessions.updated` snapshot includes the older open local session even though it is outside the first 100
- the cursor metadata still points at the normal first-page boundary

Create `test/server/ws-sidebar-snapshot-refresh.test.ts` covering the post-bootstrap invariant:
- connect and receive the normal paginated first page
- send `ui.layout.sync` whose layout contains an older local session outside the first page
- assert the same websocket receives a fresh `sessions.updated` snapshot including that older session
- assert foreign-only copied-session locators do not trigger inclusion

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run --config vitest.server.config.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
```

Expected: FAIL because hello does not carry sidebar locators and `ui.layout.sync` does not refresh sidebar snapshots yet.

**Step 3: Implement websocket personalization**

In `shared/ws-protocol.ts`:
- add `SessionLocatorSchema`
- export its inferred type
- extend `HelloSchema` with an optional `sidebarOpenSessions: z.array(SessionLocatorSchema).optional()`

In `src/store/paneTypes.ts`, alias `SessionLocator` to the shared protocol type so client and server use the same shape.

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

In `server/ws-handler.ts`:
- add per-connection state for normalized sidebar-open keys/signature
- on `hello`, normalize `m.sidebarOpenSessions` with `buildSidebarOpenSessionKeys(..., this.serverInstanceId)`
- on `ui.layout.sync`, extract locators from pane `sessionRef` / `resumeSessionId`, recompute the key set, and if it changed, send a fresh personalized snapshot to that websocket
- extract one helper for paginated snapshots, then route handshake snapshots, `sessions.fetch`, and `broadcastSessionsUpdated()` through it so every paginated snapshot uses the same authoritative first-page selector

Use a handler shape like:

```typescript
case 'ui.layout.sync': {
  this.layoutStore?.updateFromUi(m, ws.connectionId || 'unknown')
  const nextKeys = buildSidebarOpenSessionKeys(
    collectSessionLocatorsFromUiLayout(m.layouts),
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
npx vitest run --config vitest.server.config.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add shared/ws-protocol.ts src/store/paneTypes.ts src/lib/ws-client.ts src/App.tsx server/ws-handler.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
git commit -m "feat: personalize websocket sidebar snapshots"
```

### Task 5: Add End-To-End Sidebar Visibility Regressions And Run Full Verification

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

2. Post-bootstrap path:
```typescript
store.dispatch(openSessionTab({ provider: 'codex', sessionId: 'older-open' }))
messageHandler?.({
  type: 'sessions.updated',
  projects: [{ projectPath: '/repo', sessions: [olderOpenSession, ...recentSessions] }],
  totalSessions: 300,
  oldestIncludedTimestamp: recentBoundary,
  oldestIncludedSessionId: 'codex:boundary',
  hasMore: true,
})
expect(screen.getByText('Older Open Session')).toBeInTheDocument()
```

The second test proves the actual sidebar UI updates once the personalized websocket refresh arrives after a later local tab open.

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

# Cross-Device Tabs Registry + Navigation Renames Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a server-backed, client-authored tabs/panes registry that enables cross-device discovery and rehydration, and ship the requested IA rename/order updates: `Coding Agents`, `Tabs`, `Panes`, `Projects`, `Settings`.

**Architecture:** Keep the browser client as the source of truth for local tab/pane state. Add a server-side append-only tabs history store (JSONL + recent in-memory index) for cross-device discovery and closed-tab search. Use WebSocket-only transport with explicit runtime error surfaces, low-frequency sync (5s + lifecycle events), and lazy loading (live + 24h by default; older ranges on demand).

**Tech Stack:** React 18, Redux Toolkit, Zod, WebSocket (`ws`), Node/Express, Vitest (client/server), Testing Library/e2e tests.

---

## Locked Product Decisions

- Reopening a remote tab always creates an **unlinked local copy**.
- Device label is independent metadata (`deviceLabel`) and must not be baked into `tabName`.
- Closed history retention is effectively unbounded (append-only); default search range is 30 days and user-expandable.
- Transport is WebSocket-only; show clear runtime errors when WS is unavailable/degraded.
- Conflict handling is last-write-wins using per-tab `revision`.
- Keep/save heuristic is OR-based:
  - tab open duration > 5 minutes
  - pane count > 1
  - `titleSetByUser === true`
- Performance guardrails:
  - default payload: live tabs + closed tabs from last 24h
  - sync cadence: every 5s plus lifecycle events
  - do not ship older closed history unless user asks for expanded date range/search
- Navigation labels/order must be exactly:
  1. Coding Agents
  2. Tabs
  3. Panes
  4. Projects
  5. Settings

---

### Task 1: Preflight Worktree + Baseline Verification

**Files:**
- Modify: none
- Test: none

**Step 1: Create a dedicated worktree branch**

Run:
```bash
git fetch origin
git worktree add .worktrees/tabs-registry-nav-rename -b feature/tabs-registry-nav-rename
```

**Step 2: Enter worktree and install deps if needed**

Run:
```bash
cd .worktrees/tabs-registry-nav-rename
npm ci
```

**Step 3: Baseline tests before edits**

Run:
```bash
npm test
```
Expected: baseline should pass (or existing failures documented before proceeding).

**Step 4: Baseline lint/build sanity**

Run:
```bash
npm run lint
npm run verify
```
Expected: no new failures introduced by branch setup.

**Step 5: Commit branch bootstrap notes**

```bash
git commit --allow-empty -m "chore: start tabs registry + navigation rename implementation in dedicated worktree"
```

---

### Task 2: Define Shared Tabs Registry Domain Types (Client + Server)

**Files:**
- Create: `src/store/tabRegistryTypes.ts`
- Create: `server/tabs-registry/types.ts`
- Modify: `src/store/types.ts`
- Test: `test/unit/client/store/tabRegistryTypes.test.ts`
- Test: `test/unit/server/tabs-registry/types.test.ts`

**Step 1: Write failing type/schema tests first**

```ts
it('accepts open/closed tab records with device metadata and revision', () => {
  const parsed = TabRegistryRecordSchema.parse({
    tabKey: 'device-1:tab-1',
    tabId: 'tab-1',
    deviceId: 'device-1',
    deviceLabel: 'danlaptop',
    tabName: 'freshell',
    status: 'open',
    revision: 7,
    updatedAt: 1739577600000,
    paneCount: 3,
    titleSetByUser: true,
  })
  expect(parsed.status).toBe('open')
})
```

**Step 2: Run targeted tests and confirm failure**

Run:
```bash
npx vitest run test/unit/client/store/tabRegistryTypes.test.ts
npx vitest run --config vitest.server.config.ts test/unit/server/tabs-registry/types.test.ts
```
Expected: FAIL because schemas/types do not exist yet.

**Step 3: Implement minimal shared type contracts**

```ts
export type RegistryTabStatus = 'open' | 'closed'

export type RegistryPaneSnapshot = {
  paneId: string
  kind: 'terminal' | 'browser' | 'editor' | 'picker' | 'claude-chat'
  title?: string
  payload: Record<string, unknown>
}

export type RegistryTabRecord = {
  tabKey: string
  tabId: string
  deviceId: string
  deviceLabel: string
  tabName: string
  status: RegistryTabStatus
  revision: number
  createdAt: number
  updatedAt: number
  closedAt?: number
  paneCount: number
  titleSetByUser: boolean
  panes: RegistryPaneSnapshot[]
}
```

**Step 4: Re-run tests and verify pass**

Run:
```bash
npx vitest run test/unit/client/store/tabRegistryTypes.test.ts
npx vitest run --config vitest.server.config.ts test/unit/server/tabs-registry/types.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/tabRegistryTypes.ts server/tabs-registry/types.ts src/store/types.ts test/unit/client/store/tabRegistryTypes.test.ts test/unit/server/tabs-registry/types.test.ts
git commit -m "feat: define shared tabs registry domain types and validation schemas"
```

---

### Task 3: Implement Server Tabs Registry Store (JSONL + Recent Index)

**Files:**
- Create: `server/tabs-registry/store.ts`
- Create: `server/tabs-registry/device-store.ts`
- Modify: `server/index.ts`
- Test: `test/unit/server/tabs-registry/store.test.ts`
- Test: `test/integration/server/tabs-registry-store.persistence.test.ts`

**Step 1: Write failing store tests (retention/query behavior)**

```ts
it('returns only live + closed within 24h for default snapshot', async () => {
  const store = createTabsRegistryStore(tmpDir)
  await store.upsert(recordOpen)
  await store.upsert(recordClosedRecent)
  await store.upsert(recordClosedOld)

  const result = await store.query({ deviceId: 'local-device' })
  expect(result.closed.some((r) => r.tabKey === recordClosedRecent.tabKey)).toBe(true)
  expect(result.closed.some((r) => r.tabKey === recordClosedOld.tabKey)).toBe(false)
})
```

**Step 2: Run and confirm failure**

Run:
```bash
npx vitest run --config vitest.server.config.ts test/unit/server/tabs-registry/store.test.ts
```
Expected: FAIL.

**Step 3: Implement append-only persistence with fast recent index**

```ts
export class TabsRegistryStore {
  async upsert(record: RegistryTabRecord): Promise<void> {
    // last-write-wins by revision and updatedAt
    // append line to tab-specific jsonl file
    // update in-memory latest map + recent closed index
  }

  async query(input: { deviceId: string; rangeDays?: number }): Promise<QueryResult> {
    const rangeMs = (input.rangeDays ?? 1) * 24 * 60 * 60 * 1000 // default 24h
    // return localOpen, remoteOpen, closedWithinRange
  }
}
```

**Step 4: Run unit + integration tests**

Run:
```bash
npx vitest run --config vitest.server.config.ts test/unit/server/tabs-registry/store.test.ts
npx vitest run --config vitest.server.config.ts test/integration/server/tabs-registry-store.persistence.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add server/tabs-registry/store.ts server/tabs-registry/device-store.ts server/index.ts test/unit/server/tabs-registry/store.test.ts test/integration/server/tabs-registry-store.persistence.test.ts
git commit -m "feat: add server tabs registry jsonl store with recent closed index and range queries"
```

---

### Task 4: Extend WebSocket Protocol for Tabs Sync (WS-Only)

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `src/lib/ws-client.ts`
- Create: `test/server/ws-tabs-registry.test.ts`
- Create: `test/unit/client/ws-client.tabs-sync.test.ts`

**Step 1: Write failing protocol tests**

```ts
it('accepts tabs.sync.push and emits tabs.sync.snapshot on query', async () => {
  // connect ws, send hello, push payload, request snapshot
  // assert response contains open + closed(24h default)
})
```

**Step 2: Run tests and verify failure**

Run:
```bash
npx vitest run --config vitest.server.config.ts test/server/ws-tabs-registry.test.ts
```
Expected: FAIL (message types missing).

**Step 3: Add schemas + handlers**

```ts
const TabsSyncPushSchema = z.object({
  type: z.literal('tabs.sync.push'),
  deviceId: z.string().min(1),
  deviceLabel: z.string().min(1),
  records: z.array(TabRegistryRecordSchema),
})

const TabsSyncQuerySchema = z.object({
  type: z.literal('tabs.sync.query'),
  requestId: z.string().min(1),
  rangeDays: z.number().int().positive().optional(),
})
```

Emit response:
```ts
{ type: 'tabs.sync.snapshot', requestId, data: { localOpen, remoteOpen, closed } }
```

**Step 4: Re-run tests**

Run:
```bash
npx vitest run --config vitest.server.config.ts test/server/ws-tabs-registry.test.ts
npx vitest run test/unit/client/ws-client.tabs-sync.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add server/ws-handler.ts src/lib/ws-client.ts test/server/ws-tabs-registry.test.ts test/unit/client/ws-client.tabs-sync.test.ts
git commit -m "feat: add websocket tabs sync protocol and snapshot query flow"
```

---

### Task 5: Add Client Tab Registry Slice + Sync Scheduler (5s)

**Files:**
- Create: `src/store/tabRegistrySlice.ts`
- Create: `src/store/tabRegistrySync.ts`
- Modify: `src/store/store.ts`
- Modify: `src/App.tsx`
- Test: `test/unit/client/store/tabRegistrySlice.test.ts`
- Test: `test/unit/client/store/tabRegistrySync.test.ts`

**Step 1: Write failing client state/sync tests**

```ts
it('pushes tabs.sync every 5s and on lifecycle events', () => {
  vi.useFakeTimers()
  // dispatch lifecycle change and advance timers
  // expect ws.send called with tabs.sync.push
})
```

**Step 2: Run tests and confirm failure**

Run:
```bash
npx vitest run test/unit/client/store/tabRegistrySlice.test.ts test/unit/client/store/tabRegistrySync.test.ts
```
Expected: FAIL.

**Step 3: Implement sync module + reducer**

```ts
const SYNC_INTERVAL_MS = 5000

export function startTabRegistrySync(store: AppStore, ws: WsClient) {
  const pushNow = () => ws.send({ type: 'tabs.sync.push', ...buildPayload(store.getState()) })
  const timer = window.setInterval(pushNow, SYNC_INTERVAL_MS)
  // also trigger on open/close/rename/split events
  return () => clearInterval(timer)
}
```

**Step 4: Re-run tests**

Run:
```bash
npx vitest run test/unit/client/store/tabRegistrySlice.test.ts test/unit/client/store/tabRegistrySync.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/tabRegistrySlice.ts src/store/tabRegistrySync.ts src/store/store.ts src/App.tsx test/unit/client/store/tabRegistrySlice.test.ts test/unit/client/store/tabRegistrySync.test.ts
git commit -m "feat: add client tab registry state and 5s websocket sync scheduler"
```

---

### Task 6: Implement Keep Heuristic + Closed Snapshot Capture

**Files:**
- Create: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/tabRegistrySync.ts`
- Test: `test/unit/client/lib/tab-registry-snapshot.test.ts`
- Test: `test/unit/client/store/tabsSlice.closed-registry.test.ts`

**Step 1: Write failing heuristic tests**

```ts
it('keeps closed tab when open > 5 minutes OR paneCount > 1 OR titleSetByUser', () => {
  expect(shouldKeepClosedTab({ openDurationMs: 6 * 60_000, paneCount: 1, titleSetByUser: false })).toBe(true)
  expect(shouldKeepClosedTab({ openDurationMs: 60_000, paneCount: 2, titleSetByUser: false })).toBe(true)
  expect(shouldKeepClosedTab({ openDurationMs: 60_000, paneCount: 1, titleSetByUser: true })).toBe(true)
  expect(shouldKeepClosedTab({ openDurationMs: 60_000, paneCount: 1, titleSetByUser: false })).toBe(false)
})
```

**Step 2: Run tests and confirm failure**

Run:
```bash
npx vitest run test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/store/tabsSlice.closed-registry.test.ts
```
Expected: FAIL.

**Step 3: Implement close-time capture before layout removal**

```ts
const openDurationMs = Date.now() - tab.createdAt
const paneCount = countLeaves(layout)
const keep = openDurationMs > 5 * 60_000 || paneCount > 1 || !!tab.titleSetByUser
if (keep) {
  dispatch(recordClosedTabSnapshot(buildClosedSnapshot(tab, layout, deviceMeta)))
}
```

**Step 4: Re-run tests**

Run:
```bash
npx vitest run test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/store/tabsSlice.closed-registry.test.ts
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/tab-registry-snapshot.ts src/store/tabsSlice.ts src/store/tabRegistrySync.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/store/tabsSlice.closed-registry.test.ts
git commit -m "feat: capture closed tab snapshots using keep heuristic with 5-minute uptime rule"
```

---

### Task 7: Build `Tabs` View (Local/Remote/Closed + Search/Filters)

**Files:**
- Create: `src/components/TabsView.tsx`
- Create: `src/store/selectors/tabsRegistrySelectors.ts`
- Modify: `src/App.tsx`
- Modify: `src/store/panesSlice.ts`
- Test: `test/unit/client/components/TabsView.test.tsx`
- Test: `test/e2e/tabs-view-flow.test.tsx`

**Step 1: Write failing UI tests for grouping/sorting/actions**

```tsx
it('renders groups in order: local open, remote open, closed', () => {
  render(<TabsView ... />)
  expect(screen.getByText('Open on this device')).toBeInTheDocument()
  expect(screen.getByText('Open on other devices')).toBeInTheDocument()
  expect(screen.getByText('Closed')).toBeInTheDocument()
})
```

**Step 2: Run tests and confirm failure**

Run:
```bash
npx vitest run test/unit/client/components/TabsView.test.tsx
```
Expected: FAIL.

**Step 3: Implement view and actions**

- default groups/order:
  - open local
  - open remote
  - closed
- filters: `local/remote`, `open/closed`, `device`, date range (default 30 days)
- actions:
  - jump to local open tab
  - reopen remote/closed tab as unlinked local copy
  - open individual pane into current tab or new tab

Example clone behavior:
```ts
function cloneRemoteToLocalTab(record: RegistryTabRecord): AddTabPayload {
  return {
    title: record.tabName,
    mode: 'shell',
    status: 'creating',
    createRequestId: nanoid(),
  }
}
```

**Step 4: Re-run unit + e2e tests**

Run:
```bash
npx vitest run test/unit/client/components/TabsView.test.tsx
npx vitest run test/e2e/tabs-view-flow.test.tsx
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TabsView.tsx src/store/selectors/tabsRegistrySelectors.ts src/App.tsx src/store/panesSlice.ts test/unit/client/components/TabsView.test.tsx test/e2e/tabs-view-flow.test.tsx
git commit -m "feat: add tabs view for cross-device tab discovery, search, and pane-level reopen actions"
```

---

### Task 8: Rename Navigation + View IDs + Ordering

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `src/components/SetupWizard.tsx`
- Test: `test/unit/client/components/Sidebar.nav-order.test.tsx`
- Test: `test/unit/client/context-menu/menu-defs.test.ts`
- Test: `test/e2e/sidebar-navigation-rename.test.tsx`

**Step 1: Write failing tests for labels and order**

```ts
expect(navLabels()).toEqual([
  'Coding Agents',
  'Tabs',
  'Panes',
  'Projects',
  'Settings',
])
```

**Step 2: Run tests and confirm failure**

Run:
```bash
npx vitest run test/unit/client/components/Sidebar.nav-order.test.tsx test/e2e/sidebar-navigation-rename.test.tsx
```
Expected: FAIL.

**Step 3: Implement rename + order updates**

- Rename view model to:
  - `codingAgents` (was terminal)
  - `tabs` (new)
  - `panes` (was overview)
  - `projects` (was sessions)
  - `settings`
- Update all labels/context-menu entries:
  - Terminal -> Coding Agents
  - Sessions -> Projects
  - Overview -> Panes
- Ensure keyboard hints and titles follow new naming.

```ts
export type AppView = 'codingAgents' | 'tabs' | 'panes' | 'projects' | 'settings'
```

**Step 4: Re-run tests**

Run:
```bash
npx vitest run test/unit/client/components/Sidebar.nav-order.test.tsx test/unit/client/context-menu/menu-defs.test.ts test/e2e/sidebar-navigation-rename.test.tsx
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/App.tsx src/components/context-menu/menu-defs.ts src/components/SetupWizard.tsx test/unit/client/components/Sidebar.nav-order.test.tsx test/unit/client/context-menu/menu-defs.test.ts test/e2e/sidebar-navigation-rename.test.tsx
git commit -m "feat: rename and reorder navigation to coding agents tabs panes projects settings"
```

---

### Task 9: Add WS Runtime Error UX for Tabs Sync

**Files:**
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/lib/ws-client.ts`
- Test: `test/unit/client/components/TabsView.ws-error.test.tsx`

**Step 1: Write failing error-state test**

```tsx
it('shows a clear tabs sync error banner when websocket is disconnected', () => {
  render(<TabsView />)
  expect(screen.getByRole('alert')).toHaveTextContent('Tabs sync unavailable')
})
```

**Step 2: Run test and confirm failure**

Run:
```bash
npx vitest run test/unit/client/components/TabsView.ws-error.test.tsx
```
Expected: FAIL.

**Step 3: Implement explicit runtime error states**

```ts
if (connection.status !== 'ready') {
  state.syncError = 'Tabs sync unavailable. Reconnect WebSocket to refresh remote tabs.'
}
```

**Step 4: Re-run tests**

Run:
```bash
npx vitest run test/unit/client/components/TabsView.ws-error.test.tsx
```
Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/tabRegistrySlice.ts src/components/TabsView.tsx src/lib/ws-client.ts test/unit/client/components/TabsView.ws-error.test.tsx
git commit -m "feat: surface websocket runtime errors clearly in tabs sync UI"
```

---

### Task 10: Performance + Lazy Data-Load Enforcement Tests

**Files:**
- Test: `test/server/ws-tabs-registry.test.ts`
- Test: `test/unit/client/store/tabRegistrySync.test.ts`
- Test: `test/e2e/tabs-view-search-range.test.tsx`
- Modify: `server/ws-handler.ts`
- Modify: `src/components/TabsView.tsx`

**Step 1: Write failing tests for payload minimization**

```ts
it('returns live + last 24h closed only for default tabs.sync.query', async () => {
  // seed old closed entries
  // query without rangeDays
  // assert old entries excluded
})

it('requests older history only when user expands search range', async () => {
  // no extra query on initial render
  // range change triggers tabs.sync.query with rangeDays > 30
})
```

**Step 2: Run tests and confirm failure**

Run:
```bash
npx vitest run --config vitest.server.config.ts test/server/ws-tabs-registry.test.ts
npx vitest run test/e2e/tabs-view-search-range.test.tsx
```
Expected: FAIL.

**Step 3: Implement lazy loading behavior**

- default `tabs.sync.query` with no `rangeDays` -> server returns live + closed 24h
- client default UI range: 30 days
- only when range exceeds default scope, client sends explicit `rangeDays`

**Step 4: Re-run tests**

Run:
```bash
npx vitest run --config vitest.server.config.ts test/server/ws-tabs-registry.test.ts
npx vitest run test/unit/client/store/tabRegistrySync.test.ts test/e2e/tabs-view-search-range.test.tsx
```
Expected: PASS.

**Step 5: Commit**

```bash
git add server/ws-handler.ts src/components/TabsView.tsx test/server/ws-tabs-registry.test.ts test/unit/client/store/tabRegistrySync.test.ts test/e2e/tabs-view-search-range.test.tsx
git commit -m "test: enforce tabs registry performance constraints and lazy history loading"
```

---

### Task 11: Update Mock Docs for Major UI Change

**Files:**
- Modify: `docs/index.html`
- Test: manual verification

**Step 1: Add failing expectation in docs smoke check (if present)**

If docs snapshot test exists, add assertions for new nav labels/order.

**Step 2: Run docs checks and confirm failure**

Run any existing docs test/lint command (or skip if none exists).

**Step 3: Update mock UI text/order**

- Sidebar/nav in docs mock must show:
  - Coding Agents
  - Tabs
  - Panes
  - Projects
  - Settings
- Include a placeholder `Tabs` view region with grouped local/remote/closed cards.

**Step 4: Verify docs render manually**

Run:
```bash
npm run dev
```
Expected: docs mock reflects renamed IA.

**Step 5: Commit**

```bash
git add docs/index.html
git commit -m "docs: update mock UI for tabs registry view and renamed navigation labels"
```

---

### Task 12: Full Regression Gate + Merge Readiness

**Files:**
- Modify: none
- Test: full suite

**Step 1: Run full test suite**

Run:
```bash
npm test
```
Expected: PASS.

**Step 2: Run full verify (build + tests/types)**

Run:
```bash
npm run verify
```
Expected: PASS.

**Step 3: Run lint**

Run:
```bash
npm run lint
```
Expected: PASS.

**Step 4: Prepare merge safety checks**

Run:
```bash
git status
git log --oneline --decorate -n 15
```
Expected: clean branch, coherent commit sequence.

**Step 5: Final commit if needed**

```bash
git commit -m "chore: finalize tabs registry + navigation rename rollout" --allow-empty
```

---

## Implementation Notes

- Do not store device alias in server-global settings (`/api/settings`) because it is shared across clients; keep device identity local (localStorage-backed) and send via WS payload.
- For pane-level reopen from remote/closed tabs, always sanitize runtime-owned fields:
  - terminal: clear `terminalId`, generate new `createRequestId`, set `status: creating`
  - claude-chat: clear `sessionId`, generate new `createRequestId`, keep `resumeSessionId` if present
- Preserve accessibility semantics in new `TabsView` controls (`button`, `aria-label`, keyboard operability).
- Ensure no destructive change to existing tabs/panes persistence keys unless migration is explicitly added.

## Suggested Commit Cadence

- One commit per task above (12 commits).
- Keep commit messages detailed and behavior-oriented, not generic.

## Post-Plan Execution Skill

- Execution should use `@superpowers:executing-plans` task-by-task with review checkpoints.

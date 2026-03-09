# Slow-Network Architecture Rebuild Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Use `@trycycle-executing` for execution handoff.

**Goal:** Replace Freshell's client-heavy, replay-heavy transport with a server-authoritative, viewport-first architecture that stays responsive on slow links by shipping only visible, latency-sensitive state immediately and fetching everything else later or on demand.

**Architecture:** Hard-cut to WebSocket protocol v4 as a realtime lane only, backed by server-owned HTTP read models for startup, session discovery, agent timelines, and terminal viewport/search. The server becomes responsible for shaping, prioritizing, paginating, searching, and measuring large state; the browser keeps only visible windows plus cursors and never rebuilds or filters bulk histories locally.

**Tech Stack:** Node.js, Express, `ws`, React 18, Redux Toolkit, TypeScript, Zod, Vitest, existing `session-search` and `session-history-loader`, existing `terminal-stream` broker/queue, `@xterm/headless`, `@xterm/addon-serialize`.

---

## Strategy Gate

The defect is not "messages are too large sometimes." The defect is that the browser is still treated as a read-model engine:

1. `src/App.tsx` bootstraps from multiple HTTP requests and then waits on WebSocket snapshot/reconciliation paths.
2. `src/store/sessionsSlice.ts`, `src/components/Sidebar.tsx`, and `src/components/HistoryView.tsx` still assume the browser owns full `ProjectGroup[]` snapshots, local filtering, and pagination bookkeeping.
3. `server/ws-handler.ts` still emits `sessions.updated`, `sessions.page`, `sessions.patch`, accepts `sessions.fetch`, and chunks large session payloads over WebSocket.
4. `server/sdk-bridge.ts`, `server/session-history-loader.ts`, `src/lib/sdk-message-handler.ts`, and `src/store/agentChatSlice.ts` are centered on `sdk.history` replay arrays.
5. `server/terminal-stream/broker.ts`, `src/lib/terminal-attach-seq-state.ts`, `src/components/TerminalView.tsx`, and `src/components/terminal/terminal-runtime.ts` are still replay-first and client-search-first.

The direct solution is to stop sending read models over WebSocket. WebSocket should carry live deltas only. Large and potentially stale state belongs on server-authored HTTP views with server-side search, pagination, prioritization, cancellation, and payload budgets.

This plan intentionally chooses a direct cutover, not a mixed compatibility phase. The old socket snapshot paths are the defect. Keeping them alive while adding the new architecture would preserve the same failure modes under a different interface.

## Deep-Dive Findings That Shape The Plan

1. **Server-side building blocks already exist and should be reused.**
   - `server/session-search.ts` already provides server-side search primitives.
   - `server/session-history-loader.ts` already parses `.jsonl` history files.
   - `server/terminal-stream/broker.ts` already sequences terminal output.
   - `server/terminal-stream/client-output-queue.ts` already provides bounded per-client output buffering.
2. **The current browser state model is the main source of over-fetching.**
   - `src/store/sessionsSlice.ts` stores whole project trees.
   - `src/components/Sidebar.tsx` and `src/components/HistoryView.tsx` derive visible lists by filtering/sorting in memory.
   - `src/store/agentChatSlice.ts` expects full message arrays.
3. **The slow-link problem is both compute and transport priority.**
   - It is not enough to paginate HTTP work; visible work and live output must also outrank background work.
   - `server/terminal-stream/client-output-queue.ts` is the right seam to enforce bounded, prioritized realtime egress.
4. **`codingcli.event` is already delta-oriented.**
   - The current bulk offenders are `sessions.updated`, `sessions.page`, `sessions.patch`, `sdk.history`, and replay-first terminal restore.
   - Do not invent a second transcript transport for `codingcli.event` unless a failing test proves a new bulk replay path exists there.
5. **The end state needs measurement, not hope.**
   - Payload size, queue depth, and request latency must be budgeted and logged, or the architecture will drift back toward bulk transport.

## End-State Architecture

### Transport Split

1. **Realtime WebSocket lane**
   - `ready`
   - terminal lifecycle and live output deltas
   - lightweight SDK live events, status, questions, permissions, and a small session snapshot
   - `sessions.changed` invalidation
   - terminal metadata deltas
   - extension lifecycle
2. **Visible HTTP lane**
   - `GET /api/bootstrap`
   - `GET /api/session-directory`
   - `GET /api/agent-sessions/:sessionId/timeline`
   - `GET /api/agent-sessions/:sessionId/turns/:turnId`
   - `GET /api/terminals/:terminalId/viewport`
3. **Background HTTP lane**
   - older session-directory pages
   - older agent-timeline pages
   - terminal scrollback pages
   - terminal search pages

### Priority Rules

1. Visible HTTP work must always outrank background HTTP work.
2. Realtime terminal input and live output must never wait behind background fetch work.
3. Any payload that routinely exceeds the realtime budget is in the wrong lane and must move to HTTP.
4. Stale background requests must be abortable on both client and server.

### Server Authority Rules

1. The server owns session directory ordering, filtering, snippets, summaries, and running-state joins.
2. The server owns agent timeline folding and turn-body hydration.
3. The server owns terminal viewport serialization, scrollback paging, and search.
4. The browser caches only visible windows, cursors, and small revision markers.

### Direct Cutover Rules

1. Bump `WS_PROTOCOL_VERSION` from `3` to `4`.
2. Reject older clients with close code `4010` and `PROTOCOL_MISMATCH`.
3. Remove runtime use of:
   - `sessions.updated`
   - `sessions.page`
   - `sessions.patch`
   - `sessions.fetch`
   - `sdk.history`
4. Keep `codingcli.event` delta-only; do not add a new replay path there.
5. Keep no backward-compatibility shim after cutover. Old clients fail fast.

## Budgets And Invariants

### Realtime Budget

```ts
const MAX_REALTIME_MESSAGE_BYTES = 16 * 1024
```

### HTTP Read-Model Budgets

```ts
const MAX_BOOTSTRAP_ITEMS = 50
const MAX_DIRECTORY_PAGE_ITEMS = 50
const MAX_AGENT_TIMELINE_ITEMS = 40
const MAX_TERMINAL_SCROLLBACK_PAGE_BYTES = 64 * 1024
```

### Invariants

1. Startup performs one bootstrap request before opening the realtime socket.
2. Terminal reconnect shows the current viewport first, then uses `sinceSeq` only for missed live tail.
3. Search for sessions and terminals is server-side only.
4. Offscreen data is never fetched before visible data is rendered.
5. Realtime queues stay bounded; overflow produces gaps or invalidations, never unbounded memory growth.
6. When state is uncertain, refetch the current visible server window instead of rebuilding complex client reconciliation.

## Heavy Test Matrix

The execution agent must add red-green coverage in every task, then run this full matrix before declaring the work done:

1. Protocol tests proving v4 rejects older clients and never emits legacy bulk socket messages.
2. Unit tests for realtime queue prioritization and payload-budget enforcement.
3. Unit tests for read-model scheduler priority, queue depth, and abort handling.
4. Unit and integration tests for:
   - bootstrap response shape
   - session-directory search/cursoring
   - agent timeline folding and turn-body hydration
   - terminal mirror serialization, scrollback paging, and search
5. Client unit tests proving:
   - startup uses one bootstrap document
   - session views no longer filter whole datasets in memory
   - agent chat no longer depends on `sdk.history`
   - terminal search no longer depends on `SearchAddon`
6. Slow-network tests proving:
   - the app becomes interactive before offscreen data arrives
   - terminal reconnect shows the current screen without replaying a whole history
   - agent chat reload shows recent turns before older turn bodies
   - session search works without shipping the full dataset to the browser
   - background fetches do not delay terminal input or visible updates
7. Full verification commands:

```bash
npm run lint
npm run check
npm test
npm run verify
```

## Non-Goals

1. Do not keep the old snapshot protocol alive behind a shim.
2. Do not move terminal search or session filtering back into the browser.
3. Do not make `codingcli.event` more complex without a failing test that proves a bulk replay bug there.
4. Do not preserve large client caches for convenience.

---

### Task 1: Lock WebSocket V4 To Realtime-Only Semantics

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/lib/ws-client.ts`
- Test: `test/server/ws-protocol.test.ts`
- Test: `test/unit/client/lib/ws-client-error-code.test.ts`

**Step 1: Write the failing protocol tests**

Cover:
- `hello.protocolVersion === 4`
- older protocol versions close with `4010`
- v4 server unions no longer model `sessions.updated`, `sessions.page`, `sessions.patch`, or `sdk.history`
- v4 unions do model `sessions.changed` and `sdk.session.snapshot`

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/server/ws-protocol.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client-error-code.test.ts
```

Expected: FAIL because protocol v4 does not exist yet.

**Step 3: Implement the v4 contract**

Add the new server-to-client primitives in `shared/ws-protocol.ts`:

```ts
export const WS_PROTOCOL_VERSION = 4 as const

export type SessionsChangedMessage = {
  type: 'sessions.changed'
  revision: number
}

export type SdkSessionSnapshotMessage = {
  type: 'sdk.session.snapshot'
  sessionId: string
  status: SdkSessionStatus
  cliSessionId?: string
  model?: string
  cwd?: string
  tools?: Array<{ name: string }>
}
```

Update `src/lib/ws-client.ts` to always send `protocolVersion: 4` and treat close code `4010` as fatal. Update `server/ws-handler.ts` to reject mismatched versions immediately.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/server/ws-protocol.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client-error-code.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts src/lib/ws-client.ts test/server/ws-protocol.test.ts test/unit/client/lib/ws-client-error-code.test.ts
git commit -m "feat(protocol): define websocket v4 realtime-only contract"
```

---

### Task 2: Add Realtime Payload Budgets And Prioritized Client Output Queues

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-stream/client-output-queue.ts`
- Modify: `server/terminal-stream/broker.ts`
- Test: `test/unit/server/terminal-stream/client-output-queue.test.ts`
- Test: `test/unit/server/ws-handler-backpressure.test.ts`

**Step 1: Write the failing queue and budget tests**

Cover:
- queue classification keeps live frames ahead of lower-priority frames
- queue overflow drops lower-priority backlog before live frames
- oversized non-realtime messages are rejected instead of chunked onto WebSocket
- queue depth and dropped-byte metrics are exposed for assertions

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts
```

Expected: FAIL because the queue is not priority-aware and the realtime budget is not enforced that narrowly.

**Step 3: Implement prioritized realtime egress**

Extend `server/terminal-stream/client-output-queue.ts`:

```ts
export type OutputPriority = 'live' | 'recovering'

enqueue(frame: ReplayFrame, priority: OutputPriority): void
nextBatch(maxBytes: number): Array<ReplayFrame | GapEvent>
snapshot(): { pendingBytes: number; liveFrames: number; recoveringFrames: number }
```

Rules:
- live output outranks recovering output
- queue overflow drops recovering frames first
- `server/ws-handler.ts` enforces `MAX_REALTIME_MESSAGE_BYTES = 16 * 1024`
- anything that cannot fit this budget moves to HTTP by design

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/ws-handler.ts server/terminal-stream/client-output-queue.ts server/terminal-stream/broker.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts
git commit -m "feat(realtime): prioritize live output and enforce payload budgets"
```

---

### Task 3: Add A Server Read-Model Scheduler With Visible And Background Lanes

**Files:**
- Create: `server/read-models/work-scheduler.ts`
- Create: `server/read-models/request-abort.ts`
- Test: `test/unit/server/read-models/work-scheduler.test.ts`

**Step 1: Write the failing scheduler tests**

Cover:
- visible jobs start before queued background jobs
- background concurrency is capped
- aborted background jobs stop before completion
- queue-depth snapshots are available for logging and tests

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/unit/server/read-models/work-scheduler.test.ts
```

Expected: FAIL because the scheduler does not exist.

**Step 3: Implement the scheduler and request abort helper**

Create `server/read-models/work-scheduler.ts`:

```ts
export type ReadModelPriority = 'visible' | 'background'

export class ReadModelWorkScheduler {
  run<T>(
    priority: ReadModelPriority,
    job: (signal: AbortSignal) => Promise<T>,
    options?: { signal?: AbortSignal }
  ): Promise<T>

  snapshot(): { visibleQueued: number; backgroundQueued: number; runningVisible: number; runningBackground: number }
}
```

Create `server/read-models/request-abort.ts` to produce an `AbortSignal` from an Express request closing.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/unit/server/read-models/work-scheduler.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/read-models/work-scheduler.ts server/read-models/request-abort.ts test/unit/server/read-models/work-scheduler.test.ts
git commit -m "feat(server): add read-model scheduler with abortable priority lanes"
```

---

### Task 4: Define Shared Read-Model Contracts And Budgets

**Files:**
- Create: `shared/read-models.ts`
- Modify: `src/lib/api.ts`
- Test: `test/unit/client/lib/api.test.ts`

**Step 1: Write the failing shared-contract tests**

Cover:
- bootstrap, session directory, agent timeline, and terminal view contracts are exported from one shared module
- cursor and priority fields round-trip through `src/lib/api.ts`

**Step 2: Run tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/lib/api.test.ts
```

Expected: FAIL because the shared contracts do not exist.

**Step 3: Implement the shared contracts**

Create `shared/read-models.ts` with:
- `BootstrapResponse`
- `SessionDirectoryQuery`, `SessionDirectoryItem`, `SessionDirectoryPage`
- `AgentTurnSummary`, `AgentTimelinePage`, `AgentTurnBody`
- `TerminalViewportSnapshot`, `TerminalScrollbackPage`, `TerminalSearchResponse`
- shared budget constants and cursor types

Update `src/lib/api.ts` with typed helpers:
- `getBootstrap()`
- `getSessionDirectoryPage(...)`
- `getAgentTimelinePage(...)`
- `getAgentTurnBody(...)`
- `getTerminalViewport(...)`
- `getTerminalScrollbackPage(...)`
- `searchTerminalView(...)`

**Step 4: Run tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/lib/api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/read-models.ts src/lib/api.ts test/unit/client/lib/api.test.ts
git commit -m "feat(shared): define slow-network read-model contracts"
```

---

### Task 5: Build The Server Session Directory Read Model

**Files:**
- Create: `server/session-directory/types.ts`
- Create: `server/session-directory/service.ts`
- Modify: `server/session-search.ts`
- Modify: `server/coding-cli/types.ts`
- Test: `test/unit/server/session-directory/service.test.ts`

**Step 1: Write the failing session-directory tests**

Cover:
- stable ordering by `updatedAt desc` plus deterministic tiebreaker
- title search is server-side
- `userMessages` and `fullText` searches return bounded snippets
- running terminal metadata is joined server-side
- invalid cursors are rejected

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/unit/server/session-directory/service.test.ts
```

Expected: FAIL because the service does not exist.

**Step 3: Implement the session-directory service**

Create `server/session-directory/service.ts` around the existing indexed inventory:

```ts
export async function querySessionDirectory(input: {
  projects: ProjectGroup[]
  query: SessionDirectoryQuery
  cursor?: string
  limit: number
  terminalMeta: TerminalMeta[]
  priority: ReadModelPriority
  signal?: AbortSignal
}): Promise<SessionDirectoryPage>
```

Rules:
- reuse `server/session-search.ts` for message/full-text search
- keep title search here, not in the browser
- flatten and join terminal state on the server
- bound snippets and items on the server

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/unit/server/session-directory/service.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/session-directory/types.ts server/session-directory/service.ts server/session-search.ts server/coding-cli/types.ts test/unit/server/session-directory/service.test.ts
git commit -m "feat(server): add session-directory read model"
```

---

### Task 6: Serve `/api/bootstrap` And `/api/session-directory` From Server-Owned Read Models

**Files:**
- Create: `server/startup-router.ts`
- Create: `server/session-directory/router.ts`
- Modify: `server/index.ts`
- Test: `test/integration/server/bootstrap-router.test.ts`
- Test: `test/integration/server/session-search-api.test.ts`

**Step 1: Write the failing route tests**

Cover:
- `GET /api/bootstrap` returns one startup document including the first session-directory page and terminal metadata
- `GET /api/session-directory` returns cursorable query windows
- invalid query/cursor input is rejected server-side

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/integration/server/bootstrap-router.test.ts test/integration/server/session-search-api.test.ts
```

Expected: FAIL because these routes do not serve the new contracts yet.

**Step 3: Implement the startup and session-directory routers**

Use `server/startup-router.ts` instead of overloading `server/bootstrap.ts`.

Implementation rules:
- `GET /api/bootstrap` calls `querySessionDirectory(...)` with `priority: 'visible'`
- `GET /api/session-directory` accepts `priority=visible|background`
- both routes use request abort signals
- `server/index.ts` wires these routes before the old session snapshot assumptions are removed

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/integration/server/bootstrap-router.test.ts test/integration/server/session-search-api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/startup-router.ts server/session-directory/router.ts server/index.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-search-api.test.ts
git commit -m "feat(api): serve bootstrap and session-directory read models"
```

---

### Task 7: Cut App Startup Over To A Single Bootstrap Request

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/lib/api.ts`
- Modify: `src/store/terminalMetaSlice.ts`
- Test: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Test: `test/unit/client/components/App.test.tsx`

**Step 1: Write the failing startup tests**

Cover:
- app performs one bootstrap request instead of a waterfall of settings/platform/version/sessions requests
- bootstrap data seeds session directory and terminal metadata
- websocket connect happens after bootstrap succeeds

**Step 2: Run tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx
```

Expected: FAIL because `App.tsx` still bootstraps from multiple fetches plus socket snapshot logic.

**Step 3: Implement the startup cutover**

Replace the startup sequence in `src/App.tsx` with:

```ts
const bootstrap = await api.getBootstrap()
dispatch(seedBootstrap(bootstrap))
await ws.connect()
```

Rules:
- delete separate startup fetches for settings/platform/version/sessions
- seed terminal metadata from the bootstrap document
- preserve auth-failure and websocket fatal-error behavior

**Step 4: Run tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/App.tsx src/lib/api.ts src/store/terminalMetaSlice.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx
git commit -m "refactor(app): bootstrap from one server-authored document"
```

---

### Task 8: Replace `sessionsSlice` With Query-Window State Instead Of Full Project Trees

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Test: `test/unit/client/store/sessionsSlice.test.ts`
- Test: `test/unit/client/sessionsSlice.pagination.test.ts`

**Step 1: Write the failing slice tests**

Cover:
- state stores query, items, cursors, revision, and loading flags
- local title filtering is gone
- invalidation replaces or refreshes the active window instead of merging project trees

**Step 2: Run tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: FAIL because the slice is still centered on `ProjectGroup[]`.

**Step 3: Implement the query-window state**

Replace the state shape with:

```ts
type SessionsState = {
  query: SessionDirectoryQuery
  items: SessionDirectoryItem[]
  nextCursor?: string
  totalItems: number
  revision?: number
  loading: boolean
  loadingMore: boolean
}
```

Update `src/store/selectors/sidebarSelectors.ts` to consume flat `SessionDirectoryItem[]`, not nested projects.

**Step 4: Run tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/sessionsSlice.ts src/store/selectors/sidebarSelectors.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts
git commit -m "refactor(client): store session query windows instead of project snapshots"
```

---

### Task 9: Rewire Sidebar To Server Queries And Abortable Background Fetches

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`
- Modify: `src/lib/api.ts`
- Test: `test/unit/client/components/Sidebar.test.tsx`
- Test: `test/unit/client/components/Sidebar.render-stability.test.tsx`
- Test: `test/e2e/sidebar-click-opens-pane.test.tsx`

**Step 1: Write the failing sidebar tests**

Cover:
- searching calls `/api/session-directory` instead of filtering local state
- scroll/pagination uses returned cursors
- stale search and load-more requests are aborted
- `sessions.changed` triggers a bounded refetch of the active window

**Step 2: Run tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: FAIL because the sidebar still derives from local snapshots and local search.

**Step 3: Implement the sidebar cutover**

Rules:
- visible search requests use `priority=visible`
- infinite-scroll requests use `priority=background`
- keep one `AbortController` per active query
- the component owns only UI state, not derived search results

**Step 4: Run tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/App.tsx src/lib/api.ts test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "refactor(sidebar): render server-owned session query windows"
```

---

### Task 10: Rewire HistoryView To Server Queries Instead Of In-Memory Filtering

**Files:**
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/lib/api.ts`
- Test: `test/unit/client/components/HistoryView.a11y.test.tsx`
- Test: `test/unit/client/components/HistoryView.mobile.test.tsx`

**Step 1: Write the failing history-view tests**

Cover:
- refresh uses `/api/session-directory`
- search/filtering is server-side
- the component renders flat directory items, not project-group snapshots
- mobile behavior still works with server-driven items

**Step 2: Run tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx
```

Expected: FAIL because `HistoryView.tsx` still filters whole project trees locally.

**Step 3: Implement the history-view cutover**

Rules:
- keep only expansion/selection UI state locally
- use background page fetches for older items
- keep all project/session title and snippet shaping on the server

**Step 4: Run tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/HistoryView.tsx src/lib/api.ts test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx
git commit -m "refactor(history): use server-side session search and paging"
```

---

### Task 11: Normalize SDK Session State Into Turns On The Server

**Files:**
- Create: `server/agent-timeline/types.ts`
- Modify: `server/sdk-bridge-types.ts`
- Modify: `server/sdk-bridge.ts`
- Modify: `server/session-history-loader.ts`
- Test: `test/unit/server/sdk-bridge-types.test.ts`
- Test: `test/unit/server/sdk-bridge.test.ts`
- Test: `test/unit/server/session-history-loader.test.ts`

**Step 1: Write the failing turn-model tests**

Cover:
- live SDK events fold into deterministic turn records
- resumed `.jsonl` history normalizes into the same turn structure
- recent turns can be hydrated while older turns stay summary-only
- no server-side state depends on full `messages: ChatMessage[]`

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/unit/server/sdk-bridge-types.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/session-history-loader.test.ts
```

Expected: FAIL because SDK state is still centered on flat message arrays.

**Step 3: Implement the turn model**

Extend `SdkSessionState` to store:

```ts
interface SdkSessionState {
  sessionId: string
  turns: AgentTurnRecord[]
  timelineRevision: number
  recentExpandedTurnIds: string[]
  // existing status, permissions, questions, cost, tokens, metadata
}
```

Normalize resumed history once in `server/session-history-loader.ts`; do not recreate replay arrays later.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/unit/server/sdk-bridge-types.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/session-history-loader.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/agent-timeline/types.ts server/sdk-bridge-types.ts server/sdk-bridge.ts server/session-history-loader.ts test/unit/server/sdk-bridge-types.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/session-history-loader.test.ts
git commit -m "refactor(sdk): normalize session state into turn records"
```

---

### Task 12: Expose Agent Timeline Read Models And Replace `sdk.history` With A Small Snapshot

**Files:**
- Create: `server/agent-timeline/service.ts`
- Create: `server/agent-timeline/router.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`
- Test: `test/unit/server/agent-timeline/service.test.ts`
- Test: `test/integration/server/agent-timeline-router.test.ts`
- Test: `test/unit/server/ws-handler-sdk.test.ts`

**Step 1: Write the failing agent-timeline tests**

Cover:
- timeline pages are cursorable and deterministic
- turn-body fetch returns only the requested turn
- attach/create emits `sdk.session.snapshot`, status, permissions, and questions, but not `sdk.history`

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/unit/server/agent-timeline/service.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/server/ws-handler-sdk.test.ts
```

Expected: FAIL because the route and lightweight snapshot path do not exist.

**Step 3: Implement the agent-timeline service and router**

Create service entry points:

```ts
export function getAgentTimelinePage(input: {
  session: SdkSessionState
  cursor?: string
  limit: number
}): AgentTimelinePage

export function getAgentTurnBody(session: SdkSessionState, turnId: string): AgentTurnBody
```

Update `server/ws-handler.ts` so `sdk.create` and `sdk.attach` send:
- `sdk.created`
- `sdk.session.snapshot`
- live status/permission/question events

They must not send `sdk.history`.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/unit/server/agent-timeline/service.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/server/ws-handler-sdk.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/agent-timeline/service.ts server/agent-timeline/router.ts server/ws-handler.ts server/index.ts test/unit/server/agent-timeline/service.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/server/ws-handler-sdk.test.ts
git commit -m "feat(agent-chat): expose timeline read models and snapshot attach"
```

---

### Task 13: Rewrite Agent Chat Client State Around Visible Timelines

**Files:**
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/lib/sdk-message-handler.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/agent-chat/CollapsedTurn.tsx`
- Test: `test/unit/client/agentChatSlice.test.ts`
- Test: `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`
- Test: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Test: `test/unit/client/components/agent-chat/CollapsedTurn.test.tsx`
- Test: `test/e2e/agent-chat-polish-flow.test.tsx`

**Step 1: Write the failing agent-chat client tests**

Cover:
- reload shows recent turns first without counting upward through old history
- expanding a collapsed turn fetches its body on demand
- `sdk.session.snapshot` seeds live session metadata without `sdk.history`
- stale timeline requests are cancelled on session switch

**Step 2: Run tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/CollapsedTurn.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: FAIL because the client still expects `sdk.history` replay semantics.

**Step 3: Implement visible-first agent chat**

Replace replay-based state with:

```ts
type ChatSessionState = {
  timeline: AgentTurnSummary[]
  hydratedTurnBodies: Record<string, AgentTurnBody>
  nextCursor?: string
  revision?: number
  timelineLoaded: boolean
  status: ...
}
```

Rules:
- fetch the newest timeline page first with `priority=visible`
- fetch older pages and turn bodies only on scroll or expand
- keep websocket live status/questions/permissions unchanged

**Step 4: Run tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/CollapsedTurn.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/lib/sdk-message-handler.ts src/components/agent-chat/AgentChatView.tsx src/components/agent-chat/CollapsedTurn.tsx test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/CollapsedTurn.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
git commit -m "refactor(agent-chat): hydrate visible turns before older history"
```

---

### Task 14: Mirror Terminal State On The Server And Shrink Replay To Short Delta Recovery

**Files:**
- Modify: `package.json`
- Create: `server/terminal-view/types.ts`
- Create: `server/terminal-view/mirror.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `server/terminal-stream/constants.ts`
- Modify: `server/terminal-registry.ts`
- Test: `test/unit/server/terminal-view/mirror.test.ts`
- Test: `test/unit/server/terminal-registry.test.ts`

**Step 1: Write the failing terminal-mirror tests**

Cover:
- PTY output is mirrored into a headless terminal model
- viewport snapshots are deterministic
- alternate screen and ANSI-heavy output stay correct
- replay retention is explicitly short-tail recovery, not full restore

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/unit/server/terminal-view/mirror.test.ts test/unit/server/terminal-registry.test.ts
```

Expected: FAIL because the mirror does not exist and replay remains the restore mechanism.

**Step 3: Implement the terminal mirror**

Add dependencies:

```json
"@xterm/headless": "^6.0.0",
"@xterm/addon-serialize": "^0.14.0"
```

Create `server/terminal-view/mirror.ts`:

```ts
export class TerminalMirrorRegistry {
  applyOutput(terminalId: string, seqStart: number, data: string): void
  getViewportSnapshot(input: { terminalId: string; cols: number; rows: number }): TerminalViewportSnapshot
}
```

Update replay retention so the broker covers only short reconnect deltas; older history must come from the mirror-backed HTTP read models.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/unit/server/terminal-view/mirror.test.ts test/unit/server/terminal-registry.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add package.json server/terminal-view/types.ts server/terminal-view/mirror.ts server/terminal-stream/broker.ts server/terminal-stream/constants.ts server/terminal-registry.ts test/unit/server/terminal-view/mirror.test.ts test/unit/server/terminal-registry.test.ts
git commit -m "feat(terminal): mirror terminal state server-side and shrink replay scope"
```

---

### Task 15: Expose Terminal Viewport, Scrollback, And Search As Read Models

**Files:**
- Create: `server/terminal-view/service.ts`
- Create: `server/terminal-view/router.ts`
- Modify: `server/index.ts`
- Test: `test/integration/server/terminal-view-router.test.ts`
- Test: `test/server/terminals-api.test.ts`

**Step 1: Write the failing terminal read-model tests**

Cover:
- `/api/terminals/:terminalId/viewport` returns current visible state and `tailSeq`
- `/api/terminals/:terminalId/scrollback` returns bounded older pages
- `/api/terminals/:terminalId/search` performs server-side search
- aborted scrollback/search requests stop early

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts
```

Expected: FAIL because these routes do not exist.

**Step 3: Implement the terminal-view service and router**

Create `server/terminal-view/service.ts`:

```ts
export function getTerminalViewport(input: {
  terminalId: string
  cols: number
  rows: number
}): TerminalViewportSnapshot

export function getTerminalScrollbackPage(input: {
  terminalId: string
  cursor?: string
}): TerminalScrollbackPage

export function searchTerminalView(input: {
  terminalId: string
  query: string
  cursor?: string
  signal?: AbortSignal
}): Promise<TerminalSearchResponse>
```

Run viewport work in the visible lane. Run scrollback/search work in the background lane unless the user is jumping to a focused result.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-view/service.ts server/terminal-view/router.ts server/index.ts test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts
git commit -m "feat(terminal): expose viewport scrollback and server-side search"
```

---

### Task 16: Rewrite TerminalView To Restore The Viewport First And Search Server-Side

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/terminal/terminal-runtime.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/lib/terminal-attach-seq-state.ts`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Test: `test/unit/client/components/TerminalView.search.test.tsx`
- Test: `test/unit/client/components/terminal/terminal-runtime.test.ts`
- Test: `test/e2e/terminal-search-flow.test.tsx`
- Test: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`

**Step 1: Write the failing terminal client tests**

Cover:
- mount or reattach fetches `/viewport` first, then attaches with `sinceSeq = tailSeq`
- search UI calls the server instead of `SearchAddon`
- stale scrollback/search requests are aborted on terminal switch
- terminal input stays live while background work is active

**Step 2: Run tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: FAIL because restore and search are still replay-first and client-side.

**Step 3: Implement the viewport-first terminal flow**

Remove `SearchAddon` usage from `src/components/terminal/terminal-runtime.ts`.

Use this attach flow in `src/components/TerminalView.tsx`:

```ts
const snapshot = await api.getTerminalViewport(terminalId, cols, rows)
terminal.reset()
terminal.write(snapshot.serialized)
ws.send({ type: 'terminal.attach', terminalId, cols, rows, sinceSeq: snapshot.tailSeq })
```

Rules:
- visible viewport first
- short-tail replay only for missed live delta
- scrollback/search only on explicit user action

**Step 4: Run tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/components/terminal/terminal-runtime.ts src/lib/api.ts src/lib/ws-client.ts src/lib/terminal-attach-seq-state.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
git commit -m "refactor(terminal): restore viewport before replay and search server-side"
```

---

### Task 17: Delete Legacy Bulk Socket Paths And Keep `codingcli.event` Delta-Only

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `server/sessions-sync/service.ts`
- Modify: `server/ws-chunking.ts`
- Modify: `src/App.tsx`
- Modify: `src/lib/sdk-message-handler.ts`
- Test: `test/server/ws-handshake-snapshot.test.ts`
- Test: `test/server/ws-edge-cases.test.ts`
- Test: `test/unit/server/sessions-sync/service.test.ts`

**Step 1: Write the failing cleanup tests**

Cover:
- no v4 handshake or runtime path emits `sessions.updated`, `sessions.page`, `sessions.patch`, or `sdk.history`
- `sessions.fetch` is gone
- `codingcli.event` remains live delta-only and does not gain a bulk replay path
- oversized bulk payloads are rejected by design instead of chunked onto WebSocket

**Step 2: Run tests to verify failure**

```bash
npm run test:server -- test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/unit/server/sessions-sync/service.test.ts
```

Expected: FAIL because the legacy runtime is still present.

**Step 3: Remove the legacy paths**

Delete or dead-code-eliminate:
- socket session snapshot paging
- `sessions.fetch`
- `broadcastSessionsPatch`
- `broadcastSessionsUpdated`
- `sdk.history`
- active runtime use of `server/ws-chunking.ts`

Keep `codingcli.event` as the small live event lane; do not add a replacement snapshot transport there.

**Step 4: Run tests to verify pass**

```bash
npm run test:server -- test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/unit/server/sessions-sync/service.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/ws-handler.ts server/sessions-sync/service.ts server/ws-chunking.ts src/App.tsx src/lib/sdk-message-handler.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/unit/server/sessions-sync/service.test.ts
git commit -m "refactor(transport): remove legacy bulk websocket session paths"
```

---

### Task 18: Add Slow-Network Instrumentation, Regressions, Docs, And Run Full Verification

**Files:**
- Modify: `server/perf-logger.ts`
- Modify: `src/lib/perf-logger.ts`
- Modify: `docs/index.html`
- Create: `test/e2e/slow-network-end-to-end.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify: `test/e2e/agent-chat-polish-flow.test.tsx`
- Modify: `test/e2e/terminal-search-flow.test.tsx`
- Modify: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`

**Step 1: Write the failing instrumentation and end-to-end tests**

Cover:
- payload size and queue-depth logging for read models and realtime frames
- startup becomes interactive before background data completes
- terminal restore shows current screen without replaying a large history
- agent chat restore shows recent turns before older bodies
- background work does not delay terminal input

**Step 2: Run the new regression to verify failure**

```bash
NODE_ENV=test npx vitest run test/e2e/slow-network-end-to-end.test.tsx
```

Expected: FAIL until the cutover is complete.

**Step 3: Implement instrumentation and update docs**

Rules:
- log payload bytes and request duration for bootstrap and read-model routes
- log realtime queue depth and dropped bytes for terminal output
- update `docs/index.html` to reflect server-side search, recent-turn-first restore, and viewport-first terminal restore

**Step 4: Run full verification**

```bash
npm run lint
npm run check
npm test
npm run verify
```

Expected: all PASS.

**Step 5: Commit**

```bash
git add server/perf-logger.ts src/lib/perf-logger.ts docs/index.html test/e2e/slow-network-end-to-end.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/agent-chat-polish-flow.test.tsx test/e2e/terminal-search-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
git commit -m "test(perf): lock in slow-network visible-first architecture"
```

## Final Notes For The Implementer

1. Build on the existing server-side strengths already in the repo instead of creating duplicate search or indexing systems.
2. When the UI needs a field, add it to the server response; do not recreate browser-side derivation after introducing the server read models.
3. Prefer refetching the active visible window over keeping large caches and local diff logic.
4. Keep tasks in order. The plan assumes a direct cutover from bulk replay/snapshot flows to server-authored read models.

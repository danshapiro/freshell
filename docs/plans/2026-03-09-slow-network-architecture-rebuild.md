# Slow-Network Architecture Rebuild Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Rebuild Freshell so startup, session browsing, agent chat, and terminal restore stay responsive on slow links by sending only visible state immediately, moving heavy query/search work to the server, and reserving WebSocket for small live deltas.

**Architecture:** Hard-cut to a server-authoritative read-model architecture. HTTP serves visible and background read models with explicit priority lanes, while WebSocket v4 carries only realtime deltas, invalidations, and control messages. The server owns search, pagination, turn folding, terminal viewport serialization, and payload budgets; the browser owns only visible windows, cursors, optimistic UI, and lightweight local adornment based on client-only state such as open tabs.

**Tech Stack:** Node.js, Express, `ws`, React 18, Redux Toolkit, TypeScript, Zod, Vitest, existing coding CLI indexer/search infrastructure, existing terminal stream broker, `@xterm/headless`, `@xterm/addon-serialize`.

---

## Strategy Gate

The core defect is not "large messages occasionally happen." The core defect is that Freshell still treats the browser as the place where canonical read models are assembled, searched, paginated, replayed, and reconciled.

The right fix is a direct cutover:

1. Stop sending bulk session/chat/terminal history over WebSocket.
2. Stop asking the client to own full project trees and full chat histories.
3. Serve visible windows from server-owned read models.
4. Make realtime traffic small, prioritized, and bounded.

This revision replaces the earlier draft rather than lightly editing it. The earlier draft had the right architectural direction, but it was not excellent yet for five reasons:

1. The tasks were still too coarse for disciplined red-green-refactor execution.
2. It treated all ordering/filtering as server-owned, even when some ordering depends on client-only state such as open tabs and local activity pinning.
3. It did not explicitly simplify websocket ownership on the client, so the startup race that currently forces reconciliation logic could survive the transport rewrite under a different name.
4. It did not explicitly account for several existing test surfaces that encode the old transport contract, especially `test/unit/client/ws-client-sdk.test.ts`, `test/e2e/auth-required-bootstrap-flow.test.tsx`, `test/unit/server/ws-chunking.test.ts`, and `test/server/ws-sessions-patch.test.ts`.
5. It reused legacy "session search" naming for the new server-owned directory read model, which makes it too easy for the execution agent to preserve the wrong API shape or keep duplicate endpoints alive.

The direct end state is still correct. What changes here is the execution shape and a sharper boundary:

1. Heavy query work moves to the server.
2. Small visible-window adornment based on client-only state may stay in the client.
3. `App.tsx` becomes the sole websocket owner; child components stop calling `ws.connect()`.

## Codebase Findings

1. **Startup is both heavy and racy.**
   - `src/App.tsx` fetches settings, platform, version, sessions, and network status separately.
   - `src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/OverviewView.tsx`, `src/components/BackgroundSessions.tsx`, `src/components/SessionView.tsx`, `src/components/TerminalView.tsx`, and `src/store/codingCliThunks.ts` all participate in websocket connection behavior.
   - The app therefore needs late-handler reconciliation for messages that can arrive before `App.tsx` finishes bootstrapping.

2. **Session browsing is still client-owned in the expensive places.**
   - `src/store/sessionsSlice.ts` stores full `ProjectGroup[]`.
   - `src/components/Sidebar.tsx`, `src/components/HistoryView.tsx`, and `src/store/selectors/sidebarSelectors.ts` derive visible lists by filtering and reshaping in memory.
   - `server/sessions-router.ts` and `server/session-search.ts` already show the server can own paging and search instead.

3. **Agent chat restore is replay-heavy.**
   - `server/ws-handler.ts` loads full history through `server/session-history-loader.ts` and sends `sdk.history`.
   - `src/store/agentChatSlice.ts` and `src/lib/sdk-message-handler.ts` assume full replay arrays.
   - This is exactly the "watch old history scroll by while counters climb" failure the user called out.

4. **Terminal restore is replay-first instead of viewport-first.**
   - `src/components/TerminalView.tsx`, `src/lib/terminal-attach-seq-state.ts`, `server/terminal-stream/broker.ts`, and `server/terminal-registry.ts` are centered on replay.
   - `src/components/terminal/terminal-runtime.ts` still loads `SearchAddon`, so terminal search work remains client-side.

5. **Transport priority exists only in fragments.**
   - `server/terminal-stream/client-output-queue.ts` already bounds queued output, but it is not priority-aware.
   - There is no shared server concept of visible versus background read-model work.

6. **There is dead or overlapping surface area that should not survive the cutover.**
   - `server/routes/sessions.ts` duplicates logic already owned by `server/sessions-router.ts`.
   - `server/ws-chunking.ts`, `server/session-pagination.ts`, `sessions.updated`, `sessions.page`, and `sessions.patch` are compatibility scaffolding for the old transport model.

7. **The current test suite already hardcodes the old behavior in more places than the earlier draft acknowledged.**
   - `test/unit/client/ws-client-sdk.test.ts`, `test/unit/client/components/App.test.tsx`, `test/unit/client/store/sessionsSlice.test.ts`, `test/unit/server/ws-chunking.test.ts`, `test/server/ws-sessions-patch.test.ts`, and `test/e2e/auth-required-bootstrap-flow.test.tsx` will all need direct rewrites or deletion as part of the cutover.
   - Leaving those suites outside the plan would create predictable red bars late in execution and invite accidental compatibility shims.

## End-State Architecture

### Transport Split

1. `GET /api/bootstrap` returns only first-paint data:
   - settings
   - platform and feature flags
   - config fallback/perf flags
   - first session-directory window
   - optionally terminal metadata if the payload stays within bootstrap budget
2. `GET /api/version` and network diagnostics remain background startup work because they are not required for first paint.
3. `GET /api/session-directory` returns server-shaped directory windows, search results, snippets, cursors, and revision markers.
4. `GET /api/agent-sessions/:sessionId/timeline` and `GET /api/agent-sessions/:sessionId/turns/:turnId` return recent-first timeline summaries and on-demand turn bodies.
5. `GET /api/terminals/:terminalId/viewport`, `/scrollback`, and `/search` return visible terminal state, older pages, and search results.
6. WebSocket v4 carries only:
   - `ready`
   - live terminal deltas and lifecycle events
   - lightweight SDK live events and `sdk.session.snapshot`
   - `sessions.changed`
   - terminal metadata deltas
   - extension lifecycle

### Priority Rules

1. Visible HTTP jobs outrank background HTTP jobs.
2. Live terminal input and output outrank all read-model work.
3. Background requests are abortable on both client and server.
4. Any frame that routinely exceeds the realtime budget is in the wrong transport lane.

### Ownership Rules

1. The server owns expensive directory shaping: search, pagination, snippets, and stable canonical order.
2. The client may still do tiny, client-only adornment on the already-fetched visible window:
   - pinning sessions that already have open tabs
   - displaying local activity state
   - expansion UI state in `HistoryView`
3. The server owns agent turn folding and turn-body hydration.
4. The server owns terminal viewport serialization, scrollback paging, and terminal search.
5. `App.tsx` owns websocket lifecycle. Child components and thunks stop calling `ws.connect()`.

### Cutover Invariants

1. `WS_PROTOCOL_VERSION = 4`.
2. Startup does one visible bootstrap request before websocket connect.
3. `version` and network status no longer block websocket readiness or first paint.
4. No runtime path emits or consumes `sessions.updated`, `sessions.page`, `sessions.patch`, `sessions.fetch`, or `sdk.history`.
5. Terminal reconnect paints the current viewport first, then requests only the short missed tail with `sinceSeq`.
6. Session and terminal search are server-side only.
7. When state is uncertain, refetch the active visible window instead of rebuilding large client reconciliation logic.

## Budgets And Invariants

```ts
export const MAX_REALTIME_MESSAGE_BYTES = 16 * 1024
export const MAX_BOOTSTRAP_DIRECTORY_ITEMS = 40
export const MAX_DIRECTORY_PAGE_ITEMS = 50
export const MAX_AGENT_TIMELINE_ITEMS = 30
export const MAX_TERMINAL_SCROLLBACK_PAGE_BYTES = 64 * 1024
```

Additional invariants:

1. `GET /api/bootstrap` must stay small enough to render immediately on slow links.
2. Realtime queues are bounded; overflow yields gaps or invalidations, never unbounded buffering.
3. Offscreen data is fetched later or on demand, never before the visible window is rendered.

## Heavy Test Program

Every task below follows red-green-refactor and adds coverage at the seam being changed. In addition to per-task tests, the execution agent must end with all of these passing:

1. Protocol tests proving websocket v4 rejects old clients and never emits legacy bulk socket messages.
2. Unit tests for realtime queue prioritization and realtime payload budget enforcement.
3. Unit tests for read-model scheduler priority and abort handling.
4. Integration tests for bootstrap, session-directory, agent-timeline, and terminal-view HTTP routes.
5. Client tests proving:
   - `App.tsx` performs one visible bootstrap request
   - child components no longer own websocket connection setup
   - sessions state is visible-window oriented, not snapshot oriented
   - agent chat no longer depends on `sdk.history`
   - terminal search no longer depends on `SearchAddon`
   - `ws-client` SDK handling no longer depends on replay-history messages
6. Slow-network e2e tests proving:
   - the app becomes interactive before offscreen work completes
   - terminal reconnect shows the current screen without replaying the entire backlog
   - agent chat reload shows recent turns before older bodies
   - background fetches do not delay terminal input or visible updates
   - token-protected bootstrap still gates first paint correctly
7. Legacy cleanup tests proving:
   - no test or runtime path still imports `server/ws-chunking.ts`
   - no route test still exercises `/api/sessions/search` as the sidebar/history source of truth
8. Final verification:

```bash
npm run lint
npm run check
npm test
npm run verify
```

## Non-Goals

1. Do not keep the legacy socket snapshot protocol alive behind a compatibility shim.
2. Do not move search or heavy pagination back into the browser.
3. Do not bloat bootstrap with non-visible startup data.
4. Do not preserve duplicate server route modules after the new architecture lands.

---

### Task 1: Write Failing WebSocket V4 Contract Tests

**Files:**
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/unit/client/lib/ws-client-error-code.test.ts`

**Step 1: Write the failing tests**

Cover:
- protocol version `4` is required
- mismatched clients close with `4010`
- legacy bulk message types are absent from the v4 runtime contract
- new lightweight messages `sessions.changed` and `sdk.session.snapshot` are present

**Step 2: Run the tests to verify failure**

```bash
npm run test:server -- test/server/ws-protocol.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client-error-code.test.ts
```

Expected: FAIL because protocol v4 does not exist yet.

**Step 3: Refine the assertions until they describe the exact end state**

Add explicit assertions that no successful attach/create path ever expects `sessions.updated`, `sessions.page`, `sessions.patch`, or `sdk.history`.

**Step 4: Run the tests again**

```bash
npm run test:server -- test/server/ws-protocol.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client-error-code.test.ts
```

Expected: still FAIL, but now for the correct missing contract.

**Step 5: Commit**

```bash
git add test/server/ws-protocol.test.ts test/unit/client/lib/ws-client-error-code.test.ts
git commit -m "test(protocol): define websocket v4 slow-network contract"
```

---

### Task 2: Implement The WebSocket V4 Contract

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/lib/ws-client.ts`

**Step 1: Implement the minimal protocol changes**

Add:

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

**Step 2: Make the server reject mismatched clients immediately**

Close mismatches with `4010` and `PROTOCOL_MISMATCH`.

**Step 3: Make the client speak only v4 and treat `4010` as fatal**

`src/lib/ws-client.ts` must stop retrying protocol-mismatch connections.

**Step 4: Run the tests to verify pass**

```bash
npm run test:server -- test/server/ws-protocol.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client-error-code.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts src/lib/ws-client.ts
git commit -m "feat(protocol): ship websocket v4 realtime-only contract"
```

---

### Task 3: Write Failing Realtime Queue Priority Tests

**Files:**
- Modify: `test/unit/server/terminal-stream/client-output-queue.test.ts`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`

**Step 1: Write the failing tests**

Cover:
- live frames outrank recovering frames
- overflow drops recovering frames before live frames
- oversized non-realtime payloads are rejected instead of chunked
- queue metrics expose live/recovering counts and dropped bytes

**Step 2: Run the tests to verify failure**

```bash
npm run test:server -- test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts
```

Expected: FAIL because the queue is not priority-aware yet.

**Step 3: Tighten the assertions around budgets**

Assert `MAX_REALTIME_MESSAGE_BYTES = 16 * 1024` at the handler seam.

**Step 4: Run the tests again**

```bash
npm run test:server -- test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts
git commit -m "test(realtime): define priority queue and budget behavior"
```

---

### Task 4: Implement Realtime Queue Priorities And Budgets

**Files:**
- Modify: `server/terminal-stream/client-output-queue.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `server/ws-handler.ts`

**Step 1: Add queue priority support**

Implement:

```ts
export type OutputPriority = 'live' | 'recovering'

enqueue(frame: ReplayFrame, priority: OutputPriority): void
snapshot(): { pendingBytes: number; liveFrames: number; recoveringFrames: number; droppedBytes: number }
```

**Step 2: Preserve live output first**

Overflow must drop recovering backlog before live frames.

**Step 3: Enforce realtime message size at the websocket boundary**

Do not route oversize bulk payloads onto WebSocket.

**Step 4: Run the tests to verify pass**

```bash
npm run test:server -- test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-stream/client-output-queue.ts server/terminal-stream/broker.ts server/ws-handler.ts
git commit -m "feat(realtime): prioritize live terminal traffic and enforce budgets"
```

---

### Task 5: Write Failing Read-Model Scheduler Tests

**Files:**
- Create: `test/unit/server/read-models/work-scheduler.test.ts`

**Step 1: Write the failing tests**

Cover:
- visible jobs start before background jobs
- background concurrency is capped
- request abort cancels in-flight or queued background work
- scheduler snapshots expose queue depth for logs and assertions

**Step 2: Run the test to verify failure**

```bash
npm run test:server -- test/unit/server/read-models/work-scheduler.test.ts
```

Expected: FAIL because the scheduler does not exist.

**Step 3: Add assertions for both queued and running counts**

Do not leave metrics ambiguous.

**Step 4: Run the test again**

```bash
npm run test:server -- test/unit/server/read-models/work-scheduler.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/server/read-models/work-scheduler.test.ts
git commit -m "test(server): define read-model scheduler behavior"
```

---

### Task 6: Implement The Read-Model Scheduler And Abort Helper

**Files:**
- Create: `server/read-models/work-scheduler.ts`
- Create: `server/read-models/request-abort.ts`

**Step 1: Implement the scheduler**

Create:

```ts
export type ReadModelPriority = 'visible' | 'background'

export class ReadModelWorkScheduler {
  run<T>(priority: ReadModelPriority, job: (signal: AbortSignal) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>
  snapshot(): { visibleQueued: number; backgroundQueued: number; runningVisible: number; runningBackground: number }
}
```

**Step 2: Implement request-bound abort signals**

`server/read-models/request-abort.ts` should turn request close/abort into an `AbortSignal`.

**Step 3: Keep policy explicit**

Visible work may preempt queued background work, but never cancel active visible work.

**Step 4: Run the test to verify pass**

```bash
npm run test:server -- test/unit/server/read-models/work-scheduler.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/read-models/work-scheduler.ts server/read-models/request-abort.ts
git commit -m "feat(server): add visible-vs-background read-model scheduler"
```

---

### Task 7: Write Failing Shared Read-Model Contract Tests

**Files:**
- Modify: `test/unit/client/lib/api.test.ts`

**Step 1: Write the failing tests**

Cover:
- shared schemas for bootstrap, session directory, agent timeline, and terminal view exist in one module
- `src/lib/api.ts` exposes typed helpers for those routes
- helpers accept `AbortSignal`

**Step 2: Run the test to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/lib/api.test.ts
```

Expected: FAIL because the shared contracts do not exist.

**Step 3: Add explicit assertions for cursor and revision fields**

These are central to visible-window refetch behavior.

**Step 4: Run the test again**

```bash
NODE_ENV=test npx vitest run test/unit/client/lib/api.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/client/lib/api.test.ts
git commit -m "test(shared): define slow-network read-model API contracts"
```

---

### Task 8: Implement Shared Read-Model Contracts And Typed API Helpers

**Files:**
- Create: `shared/read-models.ts`
- Modify: `src/lib/api.ts`

**Step 1: Implement shared schemas and types**

Include:
- `BootstrapResponse`
- `SessionDirectoryQuery`
- `SessionDirectoryItem`
- `SessionDirectoryPage`
- `AgentTimelinePage`
- `AgentTurnBody`
- `TerminalViewportSnapshot`
- `TerminalScrollbackPage`
- `TerminalSearchResponse`

**Step 2: Extend the client API helpers**

Add:

```ts
getBootstrap(options?: { signal?: AbortSignal }): Promise<BootstrapResponse>
getSessionDirectoryPage(...)
getAgentTimelinePage(...)
getAgentTurnBody(...)
getTerminalViewport(...)
getTerminalScrollbackPage(...)
searchTerminalView(...)
```

**Step 3: Add `signal` support to the base request helper**

Abort must be first-class before UI cutover work starts.

**Step 4: Run the test to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/lib/api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/read-models.ts src/lib/api.ts
git commit -m "feat(shared): add server-owned read-model contracts"
```

---

### Task 9: Write Failing Bootstrap Route Tests

**Files:**
- Create: `test/integration/server/bootstrap-router.test.ts`

**Step 1: Write the failing tests**

Cover:
- `GET /api/bootstrap` returns only first-paint data
- bootstrap includes the first session-directory window
- invalid auth and malformed responses fail cleanly
- `version` and network status are not required members of bootstrap

**Step 2: Run the test to verify failure**

```bash
npm run test:server -- test/integration/server/bootstrap-router.test.ts
```

Expected: FAIL because the route does not exist.

**Step 3: Make payload scope explicit in the test**

Assert that non-critical startup data is intentionally absent.

**Step 4: Run the test again**

```bash
npm run test:server -- test/integration/server/bootstrap-router.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/integration/server/bootstrap-router.test.ts
git commit -m "test(api): define first-paint bootstrap route"
```

---

### Task 10: Implement The Bootstrap Route And Wire It Into The Server

**Files:**
- Create: `server/startup-router.ts`
- Modify: `server/index.ts`

**Step 1: Implement `GET /api/bootstrap`**

Use the new shared contract and return:
- settings
- platform/available CLI/feature flags data
- config fallback/perf flags
- first session-directory window
- terminal metadata only if the payload stays within budget

**Step 2: Keep lower-priority startup work out of bootstrap**

Do not include version/update checks or network diagnostics.

**Step 3: Mount the route in `server/index.ts`**

Use the existing app wiring style; do not introduce a parallel boot path.

**Step 4: Run the test to verify pass**

```bash
npm run test:server -- test/integration/server/bootstrap-router.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/startup-router.ts server/index.ts
git commit -m "feat(api): add visible-first bootstrap route"
```

---

### Task 11: Write Failing App Bootstrap Tests

**Files:**
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`

**Step 1: Write the failing tests**

Cover:
- app uses one visible bootstrap request before websocket connect
- `version` and network status are demoted to background work
- `App.tsx` owns websocket connection lifecycle
- child components no longer need to call `ws.connect()`

**Step 2: Run the tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
```

Expected: FAIL because startup is still a waterfall and connection ownership is fragmented.

**Step 3: Add assertions around ordering**

Bootstrap must finish before `ready` is awaited.

**Step 4: Run the tests again**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
git commit -m "test(app): define single-owner websocket bootstrap flow"
```

---

### Task 12: Implement The App Bootstrap Cutover

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/OverviewView.tsx`
- Modify: `src/components/BackgroundSessions.tsx`
- Modify: `src/components/SessionView.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/store/codingCliThunks.ts`

**Step 1: Make `App.tsx` the sole websocket owner**

Children and thunks must stop calling `ws.connect()`.

**Step 2: Replace the startup waterfall**

Use:

```ts
const bootstrap = await api.getBootstrap()
dispatch(seedBootstrap(bootstrap))
await ws.connect()
```

**Step 3: Move lower-priority startup work behind first paint**

Run `GET /api/version` and network status fetches after the visible bootstrap and websocket connection are established.

**Step 4: Run the tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/App.tsx src/components/Sidebar.tsx src/components/OverviewView.tsx src/components/BackgroundSessions.tsx src/components/SessionView.tsx src/components/TerminalView.tsx src/store/codingCliThunks.ts
git commit -m "refactor(app): make bootstrap visible-first and app-owned"
```

---

### Task 13: Write Failing Session Directory Service Tests

**Files:**
- Create: `test/unit/server/session-directory/service.test.ts`

**Step 1: Write the failing tests**

Cover:
- stable canonical ordering
- server-side title and content search
- bounded snippets
- deterministic cursoring
- running terminal metadata joins

**Step 2: Run the test to verify failure**

```bash
npm run test:server -- test/unit/server/session-directory/service.test.ts
```

Expected: FAIL because the service does not exist.

**Step 3: Include a test for invalid cursor rejection**

Do not leave cursor parsing implicit.

**Step 4: Run the test again**

```bash
npm run test:server -- test/unit/server/session-directory/service.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/server/session-directory/service.test.ts
git commit -m "test(server): define session-directory read model"
```

---

### Task 14: Implement The Session Directory Service

**Files:**
- Create: `server/session-directory/types.ts`
- Create: `server/session-directory/service.ts`
- Modify: `server/session-search.ts`

**Step 1: Implement the service**

Create:

```ts
export async function querySessionDirectory(input: {
  projects: ProjectGroup[]
  query: SessionDirectoryQuery
  terminalMeta: TerminalMeta[]
  signal?: AbortSignal
}): Promise<SessionDirectoryPage>
```

**Step 2: Reuse existing search infrastructure**

`server/session-search.ts` remains the deep text-search primitive. The new service owns response shaping and snippet bounding.

**Step 3: Keep the server-owned and client-owned boundaries explicit**

Canonical ordering is server-owned. Tiny local tab pinning later stays client-side because it depends on browser-only state.

**Step 4: Run the test to verify pass**

```bash
npm run test:server -- test/unit/server/session-directory/service.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/session-directory/types.ts server/session-directory/service.ts server/session-search.ts
git commit -m "feat(server): add session-directory query service"
```

---

### Task 15: Write Failing Session Directory Route And Invalidation Tests

**Files:**
- Create: `test/integration/server/session-directory-router.test.ts`
- Delete: `test/integration/server/session-search-api.test.ts`
- Create: `test/server/ws-sessions-changed.test.ts`

**Step 1: Write the failing tests**

Cover:
- `GET /api/session-directory` returns cursorable windows
- `priority=visible|background` is validated
- session index updates emit `sessions.changed` with a revision, not bulk data

Start by moving the existing search-route test intent into the new file so the suite names the new architecture correctly.

**Step 2: Run the tests to verify failure**

```bash
npm run test:server -- test/integration/server/session-directory-router.test.ts test/server/ws-sessions-changed.test.ts
```

Expected: FAIL because the new route and invalidation path do not exist.

**Step 3: Make the websocket test reject legacy messages**

Assert no session project payload is broadcast during invalidation.

**Step 4: Run the tests again**

```bash
npm run test:server -- test/integration/server/session-directory-router.test.ts test/server/ws-sessions-changed.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/integration/server/session-directory-router.test.ts test/server/ws-sessions-changed.test.ts
git rm test/integration/server/session-search-api.test.ts
git commit -m "test(api): define session-directory routing and revision invalidation"
```

---

### Task 16: Implement The Session Directory Route And `sessions.changed`

**Files:**
- Modify: `server/sessions-router.ts`
- Modify: `server/sessions-sync/service.ts`
- Modify: `server/index.ts`

**Step 1: Add `GET /api/session-directory` to `server/sessions-router.ts`**

Run visible work through the read-model scheduler and abort via request signal.

**Step 2: Replace bulk session websocket publication**

`server/sessions-sync/service.ts` should maintain a revision counter and emit:

```ts
{ type: 'sessions.changed', revision }
```

**Step 3: Wire the new revision flow in `server/index.ts`**

Keep route ownership simple; do not introduce a second sessions router.

**Step 4: Stop treating `/api/sessions/search` as a first-class browsing route**

Once the session-directory route is wired and covered, remove or dead-end the old sidebar/history search path instead of keeping two server-owned query surfaces with overlapping semantics.

**Step 5: Run the tests to verify pass**

```bash
npm run test:server -- test/integration/server/session-directory-router.test.ts test/server/ws-sessions-changed.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add server/sessions-router.ts server/sessions-sync/service.ts server/index.ts
git commit -m "feat(sessions): serve session-directory windows and revision invalidations"
```

---

### Task 17: Write Failing Sessions Slice And Selector Tests

**Files:**
- Modify: `test/unit/client/store/sessionsSlice.test.ts`
- Modify: `test/unit/client/sessionsSlice.pagination.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts`

**Step 1: Write the failing tests**

Cover:
- state stores query window data instead of `ProjectGroup[]`
- invalidation refreshes the visible window instead of merging snapshots
- selectors annotate visible items without reconstructing full project trees

**Step 2: Run the tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts
```

Expected: FAIL because the slice and selectors still assume full snapshots.

**Step 3: Preserve client-only adornment in the assertions**

Keep tests for tab pinning and visibility filters on the visible window only.

**Step 4: Run the tests again**

```bash
NODE_ENV=test npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts
git commit -m "test(client): define visible-window sessions state"
```

---

### Task 18: Implement Query-Window Sessions State And Selectors

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`

**Step 1: Replace snapshot state with query-window state**

Use a shape like:

```ts
type SessionsState = {
  query: SessionDirectoryQuery
  items: SessionDirectoryItem[]
  nextCursor?: string
  revision?: number
  loading: boolean
  loadingMore: boolean
}
```

**Step 2: Remove full-project merge logic**

Delete chunk-buffer assumptions and snapshot patch application from the slice.

**Step 3: Keep selectors narrow**

Selectors may annotate and locally pin already-fetched visible items, but must not perform search or deep pagination.

**Step 4: Run the tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/sessionsSlice.ts src/store/selectors/sidebarSelectors.ts
git commit -m "refactor(client): store session directory windows instead of snapshots"
```

---

### Task 19: Write Failing Sidebar And HistoryView Tests

**Files:**
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/Sidebar.render-stability.test.tsx`
- Modify: `test/unit/client/components/HistoryView.a11y.test.tsx`
- Modify: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`

**Step 1: Write the failing tests**

Cover:
- all search tiers call `/api/session-directory`
- load-more uses returned cursors
- stale requests are aborted
- `sessions.changed` triggers a bounded refresh of the active window
- `HistoryView` keeps only UI expansion state locally

**Step 2: Run the tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: FAIL because both components still derive from local snapshots.

**Step 3: Keep accessibility assertions intact**

The transport rewrite must not degrade discoverability or keyboard access.

**Step 4: Run the tests again**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "test(ui): define server-driven session browsing flow"
```

---

### Task 20: Implement Server-Driven Sidebar And HistoryView

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/App.tsx`

**Step 1: Move session search and paging to HTTP**

Use `priority=visible` for active searches and `priority=background` for load-more.

**Step 2: Add abortable request ownership**

Each active query gets its own `AbortController`.

**Step 3: Keep only small local UI state**

Local state may cover search box text, project expansion, and selected item; heavy query results stay server-authored.

**Step 4: Run the tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/components/HistoryView.tsx src/App.tsx
git commit -m "refactor(history): use server-owned session query windows"
```

---

### Task 21: Write Failing SDK Turn Normalization Tests

**Files:**
- Modify: `test/unit/server/sdk-bridge-types.test.ts`
- Modify: `test/unit/server/sdk-bridge.test.ts`
- Modify: `test/unit/server/session-history-loader.test.ts`

**Step 1: Write the failing tests**

Cover:
- live SDK events fold into deterministic turn records
- resumed `.jsonl` history normalizes into the same turn structure
- no server-side state depends on full `messages: ChatMessage[]`

**Step 2: Run the tests to verify failure**

```bash
npm run test:server -- test/unit/server/sdk-bridge-types.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/session-history-loader.test.ts
```

Expected: FAIL because the server still thinks in replay arrays.

**Step 3: Add a recent-turns-first expectation**

The server must be able to answer "what is visible now?" without materializing the entire past.

**Step 4: Run the tests again**

```bash
npm run test:server -- test/unit/server/sdk-bridge-types.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/session-history-loader.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/server/sdk-bridge-types.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/session-history-loader.test.ts
git commit -m "test(sdk): define server-side turn normalization"
```

---

### Task 22: Implement Server-Side Turn Normalization

**Files:**
- Create: `server/agent-timeline/types.ts`
- Modify: `server/sdk-bridge-types.ts`
- Modify: `server/sdk-bridge.ts`
- Modify: `server/session-history-loader.ts`

**Step 1: Replace replay-array state with turn-record state**

Add:

```ts
interface SdkSessionState {
  sessionId: string
  turns: AgentTurnRecord[]
  timelineRevision: number
  recentExpandedTurnIds: string[]
}
```

**Step 2: Normalize resumed history once**

`server/session-history-loader.ts` should produce turn records, not replay arrays that are rebuilt later.

**Step 3: Preserve live status, permissions, and questions**

Only history transport changes here.

**Step 4: Run the tests to verify pass**

```bash
npm run test:server -- test/unit/server/sdk-bridge-types.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/session-history-loader.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/agent-timeline/types.ts server/sdk-bridge-types.ts server/sdk-bridge.ts server/session-history-loader.ts
git commit -m "refactor(sdk): normalize chat sessions into turn records"
```

---

### Task 23: Write Failing Agent Timeline Route And Snapshot Tests

**Files:**
- Create: `test/unit/server/agent-timeline/service.test.ts`
- Create: `test/integration/server/agent-timeline-router.test.ts`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`

**Step 1: Write the failing tests**

Cover:
- timeline pages are recent-first and cursorable
- turn bodies hydrate on demand
- `sdk.attach` and `sdk.create` emit `sdk.session.snapshot`, not `sdk.history`

**Step 2: Run the tests to verify failure**

```bash
npm run test:server -- test/unit/server/agent-timeline/service.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/server/ws-handler-sdk.test.ts
```

Expected: FAIL because the routes and snapshot path do not exist.

**Step 3: Reject replay reintroduction in the tests**

Assert that successful attach never sends a full history array.

**Step 4: Run the tests again**

```bash
npm run test:server -- test/unit/server/agent-timeline/service.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/server/ws-handler-sdk.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/server/agent-timeline/service.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/server/ws-handler-sdk.test.ts
git commit -m "test(agent-chat): define timeline routes and snapshot attach"
```

---

### Task 24: Implement Agent Timeline Routes And `sdk.session.snapshot`

**Files:**
- Create: `server/agent-timeline/service.ts`
- Create: `server/agent-timeline/router.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`

**Step 1: Implement the timeline read-model service**

Expose:

```ts
getAgentTimelinePage(...)
getAgentTurnBody(...)
```

**Step 2: Add the HTTP router**

Mount `GET /api/agent-sessions/:sessionId/timeline` and `GET /api/agent-sessions/:sessionId/turns/:turnId`.

**Step 3: Replace `sdk.history` at attach/create time**

Send:
- `sdk.created`
- `sdk.session.snapshot`
- live status/permission/question events

**Step 4: Run the tests to verify pass**

```bash
npm run test:server -- test/unit/server/agent-timeline/service.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/server/ws-handler-sdk.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/agent-timeline/service.ts server/agent-timeline/router.ts server/ws-handler.ts server/index.ts
git commit -m "feat(agent-chat): serve timelines and snapshot-based attach"
```

---

### Task 25: Write Failing Agent Chat Client Tests

**Files:**
- Modify: `test/unit/client/agentChatSlice.test.ts`
- Modify: `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Modify: `test/unit/client/ws-client-sdk.test.ts`

**Step 1: Write the failing tests**

Cover:
- reload shows recent turn summaries first
- `sdk.session.snapshot` seeds metadata without `sdk.history`
- switching sessions aborts stale timeline fetches
- session loss still triggers immediate recovery handling
- `ws-client` dispatches snapshot/live events without replay-history fallback

**Step 2: Run the tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/ws-client-sdk.test.ts
```

Expected: FAIL because the client still expects replay arrays.

**Step 3: Add assertions for on-demand body hydration**

Collapsed turns must fetch bodies only when opened.

**Step 4: Run the tests again**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/ws-client-sdk.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/ws-client-sdk.test.ts
git commit -m "test(agent-chat): define visible-first timeline client state"
```

---

### Task 26: Implement Timeline-Based Agent Chat Client State

**Files:**
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/lib/sdk-message-handler.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/agent-chat/CollapsedTurn.tsx`

**Step 1: Replace replay-based state**

Use:

```ts
type ChatSessionState = {
  timeline: AgentTurnSummary[]
  hydratedTurnBodies: Record<string, AgentTurnBody>
  nextCursor?: string
  timelineLoaded: boolean
  status: ...
}
```

**Step 2: Handle `sdk.session.snapshot`**

It should seed metadata and live status without loading historical bodies.

**Step 3: Fetch older pages and turn bodies only on scroll or expand**

Abort stale requests on session switch.

**Step 4: Run the tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/lib/sdk-message-handler.ts src/components/agent-chat/AgentChatView.tsx src/components/agent-chat/CollapsedTurn.tsx
git commit -m "refactor(agent-chat): hydrate visible turns instead of replaying history"
```

---

### Task 27: Write Failing Terminal Mirror Tests

**Files:**
- Create: `test/unit/server/terminal-view/mirror.test.ts`
- Modify: `test/unit/server/terminal-registry.test.ts`

**Step 1: Write the failing tests**

Cover:
- PTY output is mirrored into a headless terminal model
- viewport snapshots are deterministic
- ANSI-heavy and alternate-screen output stays correct
- replay retention becomes short-tail recovery only

**Step 2: Run the tests to verify failure**

```bash
npm run test:server -- test/unit/server/terminal-view/mirror.test.ts test/unit/server/terminal-registry.test.ts
```

Expected: FAIL because the mirror does not exist.

**Step 3: Add a test for explicit short-tail recovery limits**

Make the new scope visible in code and tests.

**Step 4: Run the tests again**

```bash
npm run test:server -- test/unit/server/terminal-view/mirror.test.ts test/unit/server/terminal-registry.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/server/terminal-view/mirror.test.ts test/unit/server/terminal-registry.test.ts
git commit -m "test(terminal): define server-side viewport mirror"
```

---

### Task 28: Implement The Terminal Mirror And Short-Tail Replay

**Files:**
- Modify: `package.json`
- Create: `server/terminal-view/mirror.ts`
- Create: `server/terminal-view/types.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `server/terminal-stream/constants.ts`

**Step 1: Add the headless terminal dependency**

Use `@xterm/headless` and `@xterm/addon-serialize`.

**Step 2: Implement the mirror registry**

Expose:

```ts
applyOutput(terminalId: string, seqStart: number, data: string): void
getViewportSnapshot(input: { terminalId: string; cols: number; rows: number }): TerminalViewportSnapshot
```

**Step 3: Shrink replay scope**

Keep only short reconnect deltas in the replay path. Older state must come from HTTP read models.

**Step 4: Run the tests to verify pass**

```bash
npm run test:server -- test/unit/server/terminal-view/mirror.test.ts test/unit/server/terminal-registry.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add package.json server/terminal-view/mirror.ts server/terminal-view/types.ts server/terminal-registry.ts server/terminal-stream/broker.ts server/terminal-stream/constants.ts
git commit -m "feat(terminal): mirror viewport server-side and shorten replay"
```

---

### Task 29: Write Failing Terminal Read-Model Route Tests

**Files:**
- Create: `test/integration/server/terminal-view-router.test.ts`
- Modify: `test/server/terminals-api.test.ts`

**Step 1: Write the failing tests**

Cover:
- `/api/terminals/:terminalId/viewport` returns visible state and `tailSeq`
- `/api/terminals/:terminalId/scrollback` returns bounded older pages
- `/api/terminals/:terminalId/search` performs server-side search
- background search/scrollback work is abortable

**Step 2: Run the tests to verify failure**

```bash
npm run test:server -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts
```

Expected: FAIL because the routes do not exist.

**Step 3: Make search behavior explicit**

Assert that terminal search no longer depends on client-only addons.

**Step 4: Run the tests again**

```bash
npm run test:server -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts
git commit -m "test(terminal): define viewport, scrollback, and search routes"
```

---

### Task 30: Implement Terminal Viewport, Scrollback, And Search Routes

**Files:**
- Create: `server/terminal-view/service.ts`
- Modify: `server/terminals-router.ts`
- Modify: `server/index.ts`

**Step 1: Implement the terminal-view service**

Expose:

```ts
getTerminalViewport(...)
getTerminalScrollbackPage(...)
searchTerminalView(...)
```

**Step 2: Extend `server/terminals-router.ts`**

Keep terminal route ownership in the existing router rather than adding a parallel top-level router.

**Step 3: Route work through the scheduler**

Viewport is visible priority. Scrollback and search are background unless the caller explicitly requests a focused jump.

**Step 4: Run the tests to verify pass**

```bash
npm run test:server -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-view/service.ts server/terminals-router.ts server/index.ts
git commit -m "feat(terminal): serve viewport, scrollback, and server-side search"
```

---

### Task 31: Write Failing Terminal Client Restore And Search Tests

**Files:**
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/unit/client/components/TerminalView.search.test.tsx`
- Modify: `test/unit/client/components/terminal/terminal-runtime.test.ts`
- Create: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`

**Step 1: Write the failing tests**

Cover:
- mount or reattach fetches `/viewport` before websocket attach
- `sinceSeq` uses `tailSeq` from the viewport snapshot
- search UI calls the server instead of `SearchAddon`
- background terminal work does not block live input

**Step 2: Run the tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: FAIL because restore is still replay-first and search is still client-side.

**Step 3: Add an assertion that `SearchAddon` is not loaded**

The dependency removal is part of the architectural end state.

**Step 4: Run the tests again**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/e2e/terminal-flaky-network-responsiveness.test.tsx
git commit -m "test(terminal): define viewport-first restore and server search"
```

---

### Task 32: Implement Viewport-First Terminal Restore And Server Search

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/terminal/terminal-runtime.ts`
- Modify: `src/lib/terminal-attach-seq-state.ts`
- Modify: `src/lib/ws-client.ts`

**Step 1: Remove client-side terminal search ownership**

Delete `SearchAddon` usage from `src/components/terminal/terminal-runtime.ts`.

**Step 2: Make restore viewport-first**

Use:

```ts
const snapshot = await api.getTerminalViewport(terminalId, cols, rows)
terminal.reset()
terminal.write(snapshot.serialized)
ws.send({ type: 'terminal.attach', terminalId, cols, rows, sinceSeq: snapshot.tailSeq })
```

**Step 3: Keep background work abortable**

Terminal scrollback and search requests must cancel on pane switch or query change.

**Step 4: Run the tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx src/components/terminal/terminal-runtime.ts src/lib/terminal-attach-seq-state.ts src/lib/ws-client.ts
git commit -m "refactor(terminal): paint viewport before replay and search server-side"
```

---

### Task 33: Write Failing Legacy Transport Cleanup Tests

**Files:**
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/unit/server/ws-chunking.test.ts`
- Modify: `test/server/ws-sessions-patch.test.ts`
- Modify: `test/unit/server/sessions-router-pagination.test.ts`

**Step 1: Write the failing tests**

Cover:
- no v4 path emits `sessions.updated`, `sessions.page`, `sessions.patch`, `sessions.fetch`, or `sdk.history`
- session sync emits revisions only
- websocket chunking code is no longer used
- no route test treats `/api/sessions/search` as the authoritative sidebar/history contract

**Step 2: Run the tests to verify failure**

```bash
npm run test:server -- test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-chunking.test.ts test/server/ws-sessions-patch.test.ts test/unit/server/sessions-router-pagination.test.ts
```

Expected: FAIL because the legacy paths still exist.

**Step 3: Add dead-code protection**

Make the tests fail if old chunking helpers or snapshot broadcasts are reintroduced.

**Step 4: Run the tests again**

```bash
npm run test:server -- test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-chunking.test.ts test/server/ws-sessions-patch.test.ts test/unit/server/sessions-router-pagination.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-chunking.test.ts test/server/ws-sessions-patch.test.ts test/unit/server/sessions-router-pagination.test.ts
git commit -m "test(transport): forbid legacy bulk websocket flows"
```

---

### Task 34: Remove Legacy Bulk Transport Paths And Dead Modules

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `src/App.tsx`
- Delete: `server/ws-chunking.ts`
- Delete: `server/routes/sessions.ts`
- Modify: `server/session-pagination.ts`

**Step 1: Delete the legacy session socket flow**

Remove:
- `sessions.updated`
- `sessions.page`
- `sessions.patch`
- `sessions.fetch`
- `sdk.history`

**Step 2: Remove dead code and imports**

Delete `server/ws-chunking.ts` and the duplicate unused `server/routes/sessions.ts` module. Remove `/api/sessions/search` if no runtime callers remain. Reduce `server/session-pagination.ts` to only what still supports HTTP read-model cursoring, or delete the dead parts if nothing remains.

**Step 3: Simplify client startup and message handling**

`src/App.tsx` must no longer buffer chunked session snapshots or reconcile them after connect.

**Step 4: Run the tests to verify pass**

```bash
npm run test:server -- test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-chunking.test.ts test/server/ws-sessions-patch.test.ts test/unit/server/sessions-router-pagination.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/ws-handler.ts src/App.tsx server/session-pagination.ts
git rm server/ws-chunking.ts server/routes/sessions.ts
git commit -m "refactor(transport): delete legacy bulk websocket architecture"
```

---

### Task 35: Write Failing Slow-Network Instrumentation And E2E Tests

**Files:**
- Create: `test/e2e/slow-network-end-to-end.test.tsx`
- Modify: `test/e2e/agent-chat-polish-flow.test.tsx`
- Modify: `test/e2e/terminal-search-flow.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify: `test/e2e/auth-required-bootstrap-flow.test.tsx`
- Modify: `test/unit/server/perf-logger.test.ts`
- Modify: `test/unit/client/lib/perf-logger.test.ts`

**Step 1: Write the failing tests**

Cover:
- payload bytes and queue-depth logging exists for bootstrap, session-directory, agent timeline, terminal routes, and realtime terminal output
- app becomes interactive before background work completes
- terminal restore shows current screen without replaying the full backlog
- agent chat shows recent turns before older bodies
- background work does not delay terminal input
- auth-required startup still renders the login path before any protected bootstrap payload is consumed

**Step 2: Run the tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/e2e/slow-network-end-to-end.test.tsx test/e2e/agent-chat-polish-flow.test.tsx test/e2e/terminal-search-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/unit/server/perf-logger.test.ts test/unit/client/lib/perf-logger.test.ts
```

Expected: FAIL until instrumentation and the full cutover are in place.

**Step 3: Make the performance budgets explicit in assertions**

Do not settle for generic "faster" checks.

**Step 4: Run the tests again**

```bash
NODE_ENV=test npx vitest run test/e2e/slow-network-end-to-end.test.tsx test/e2e/agent-chat-polish-flow.test.tsx test/e2e/terminal-search-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/unit/server/perf-logger.test.ts test/unit/client/lib/perf-logger.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/e2e/slow-network-end-to-end.test.tsx test/e2e/agent-chat-polish-flow.test.tsx test/e2e/terminal-search-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/unit/server/perf-logger.test.ts test/unit/client/lib/perf-logger.test.ts
git commit -m "test(perf): define slow-network architecture regressions"
```

---

### Task 36: Implement Instrumentation, Update Docs, And Run Full Verification

**Files:**
- Modify: `server/perf-logger.ts`
- Modify: `src/lib/perf-logger.ts`
- Modify: `docs/index.html`

**Step 1: Add instrumentation**

Log:
- payload bytes and durations for bootstrap and read-model HTTP routes
- realtime queue depth and dropped bytes for terminal output
- client parse/paint timing around visible bootstrap and viewport restore

**Step 2: Update the docs mock**

Reflect:
- server-side session search
- recent-turn-first agent chat restore
- viewport-first terminal restore

**Step 3: Run the full verification matrix**

```bash
npm run lint
npm run check
npm test
npm run verify
```

**Step 4: Confirm all commands pass**

Expected: all PASS. If anything fails, stop and fix it before closing the work.

**Step 5: Commit**

```bash
git add server/perf-logger.ts src/lib/perf-logger.ts docs/index.html
git commit -m "test(perf): lock in slow-network visible-first architecture"
```

## Final Notes For The Implementer

1. Keep the tasks in order. This is a direct cutover plan, not a compatibility-bridge plan.
2. When the UI needs a field, add it to the server response; do not recreate large client derivations after introducing the read models.
3. Prefer refetching the visible server window over maintaining clever client reconciliation logic.
4. Treat `version`, network diagnostics, and any other non-visible startup work as background unless a failing test proves they are required for first paint.
5. If a file becomes dead, delete it instead of leaving the old architecture in place beside the new one.
6. Rename or replace legacy-named tests when the name encodes the old architecture. Keeping a `session-search` test file around for the new directory contract is a maintenance bug, not a convenience.

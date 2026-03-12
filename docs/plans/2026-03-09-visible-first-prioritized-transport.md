# Visible-First Prioritized Transport Implementation Plan

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

This revision replaces the earlier draft rather than lightly editing it. The earlier draft had the right architectural direction, but it was not excellent yet for seventeen reasons:

1. The tasks were still too coarse for disciplined red-green-refactor execution.
2. It treated all ordering/filtering as server-owned, even when some ordering depends on client-only state such as open tabs and local activity pinning.
3. It did not explicitly simplify websocket ownership on the client, so the startup race that currently forces reconciliation logic could survive the transport rewrite under a different name.
4. It did not explicitly account for several existing test surfaces that encode the old transport contract, especially `test/unit/client/ws-client-sdk.test.ts`, `test/e2e/auth-required-bootstrap-flow.test.tsx`, `test/unit/server/ws-chunking.test.ts`, and `test/server/ws-sessions-patch.test.ts`.
5. It reused legacy "session search" naming for the new server-owned directory read model, which makes it too easy for the execution agent to preserve the wrong API shape or keep duplicate endpoints alive.
6. It did not explicitly move read-model fetch ownership out of leaf components and into the store/API layer, which would let client-side orchestration sprawl survive even after the server becomes authoritative.
7. It did not explicitly carry `server/cli/index.ts` and its tests off `/api/sessions` and `/api/sessions/search`, which means the old routes could remain alive as hidden compatibility debt.
8. It left the websocket-owned terminal summary paths (`terminal.list`, `terminal.list.response`, and the boot-time `terminal.meta.list` snapshot) alive, which means the app could still overfetch offscreen terminal data at startup and on sidebar/overview refreshes.
9. It did not define how focused-pane runtime metadata would arrive once the global terminal-meta snapshot is gone, which makes it too easy for execution to preserve the old boot-time terminal snapshot behind a different name.
10. It did not replace `terminal.list.updated` with a revision-based invalidation model, which would leave terminal-directory refresh semantics inconsistent with the new server-owned session-directory contract.
11. It did not explicitly remove the duplicate terminal REST wiring in `server/routes/terminals.ts`, so the transport cleanup could still leave two route stacks and two invalidation sources alive.
12. It did not call out several existing test surfaces that still encode the old terminal snapshot contract, especially `test/e2e/pane-header-runtime-meta-flow.test.tsx`, `test/server/ws-terminal-meta.test.ts`, `test/server/ws-terminal-create-session-repair.test.ts`, `test/server/ws-terminal-create-reuse-running-claude.test.ts`, and `test/server/ws-terminal-create-reuse-running-codex.test.ts`.
13. It did not call out bootstrap-adjacent tests that still stub `/api/sessions`, especially `test/unit/client/components/App.ws-extensions.test.tsx`, `test/e2e/terminal-font-settings.test.tsx`, and `test/e2e/mobile-sidebar-fullwidth-flow.test.tsx`, which invites late failures or pressure to keep the old startup API alive.
14. It did not explicitly move terminal-directory query ownership into client store thunks or a shared transport helper, which would let `Sidebar.tsx`, `OverviewView.tsx`, and `BackgroundSessions.tsx` keep building `/api/terminals` requests and preserving leaf-owned transport choreography.
15. It did not explicitly carry `server/ws-schemas.ts`, `test/unit/client/lib/ws-client.test.ts`, or the `hello.capabilities` cleanup needed to remove `sessionsPatchV1` and `sessionsPaginationV1`, which would leave negotiation state for a bulk-session protocol the app is deleting.
16. It did not call out `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`, which still models attach recovery around `sdk.history` and would either fail late or pressure execution into a replay compatibility shim.
17. It named a new startup router without explicitly separating it from the existing `server/bootstrap.ts` pre-dotenv environment bootstrap module, which creates avoidable risk of execution touching the wrong bootstrap seam.

The direct end state is still correct. What changes here is the execution shape and a sharper boundary:

1. Heavy query work moves to the server.
2. Small visible-window adornment based on client-only state may stay in the client.
3. `App.tsx` becomes the sole websocket owner; child components stop calling `ws.connect()`.
4. Focused-pane HTTP hydration must begin immediately after shell bootstrap and must not wait for websocket `ready`.
5. Read-model fetch orchestration lives in store thunks or shared client transport helpers, not in leaf components.

## Codebase Findings

1. **Startup is both heavy and racy.**
   - `src/App.tsx` fetches settings, platform, version, sessions, and network status separately.
   - `src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/OverviewView.tsx`, `src/components/BackgroundSessions.tsx`, `src/components/SessionView.tsx`, `src/components/TerminalView.tsx`, and `src/store/codingCliThunks.ts` all participate in websocket connection behavior.
   - The app therefore needs late-handler reconciliation for messages that can arrive before `App.tsx` finishes bootstrapping.
   - The current startup path also over-assumes that the session directory is always the first thing worth paying for, even when the visible pane is a terminal or agent chat. That is not aligned with the user goal of sending only what is visible now.

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
   - `src/App.tsx`, `src/components/OverviewView.tsx`, `src/components/BackgroundSessions.tsx`, and `src/components/Sidebar.tsx` also still request websocket terminal lists or a global terminal-meta snapshot, so terminal summary data is still being shipped broadly instead of only to the visible surfaces that need it.

5. **Transport priority exists only in fragments.**
   - `server/terminal-stream/client-output-queue.ts` already bounds queued output, but it is not priority-aware.
   - There is no shared server concept of visible versus background read-model work.

6. **There is dead or overlapping surface area that should not survive the cutover.**
   - `server/routes/sessions.ts` duplicates logic already owned by `server/sessions-router.ts`.
   - `server/ws-chunking.ts`, `server/session-pagination.ts`, `sessions.updated`, `sessions.page`, and `sessions.patch` are compatibility scaffolding for the old transport model.

7. **The current test suite already hardcodes the old behavior in more places than the earlier draft acknowledged.**
   - `test/unit/client/ws-client-sdk.test.ts`, `test/unit/client/components/App.test.tsx`, `test/unit/client/store/sessionsSlice.test.ts`, `test/unit/server/ws-chunking.test.ts`, `test/server/ws-sessions-patch.test.ts`, and `test/e2e/auth-required-bootstrap-flow.test.tsx` will all need direct rewrites or deletion as part of the cutover.
   - Leaving those suites outside the plan would create predictable red bars late in execution and invite accidental compatibility shims.
   - `src/components/context-menu/ContextMenuProvider.tsx` also still calls `GET /api/sessions` after rename/archive/delete actions, so the plan must cut mutation refresh flows over as well or the old snapshot route will survive through a side door.

8. **The CLI and some remaining UI surfaces still depend on the legacy sessions routes.**
   - `server/cli/index.ts` still uses `/api/sessions` and `/api/sessions/search` for `list-sessions` and `search-sessions`.
   - Several `App` and session-browsing test files still stub `/api/sessions` as part of bootstrap, including `test/unit/client/components/App.lazy-views.test.tsx`, `test/unit/client/components/App.mobile.test.tsx`, `test/unit/client/components/App.mobile-landscape.test.tsx`, `test/unit/client/components/App.swipe-sidebar.test.tsx`, and `test/unit/client/components/App.swipe-tabs.test.tsx`.
   - If those paths are not called out explicitly, the execution agent will either leave the legacy routes in place or discover the failures too late.

9. **Terminal directory invalidation and pane-header metadata are still encoded with old semantics.**
   - `server/ws-handler.ts`, `server/terminals-router.ts`, and `server/routes/terminals.ts` still broadcast `terminal.list.updated`.
   - `test/server/ws-terminal-meta.test.ts`, `test/e2e/pane-header-runtime-meta-flow.test.tsx`, `test/server/ws-terminal-create-session-repair.test.ts`, `test/server/ws-terminal-create-reuse-running-claude.test.ts`, and `test/server/ws-terminal-create-reuse-running-codex.test.ts` still assume the global terminal-meta snapshot and legacy terminal-directory invalidation path.
   - Without an explicit revision invalidation contract plus targeted runtime metadata deltas, execution could easily preserve the old snapshot model under a different name.

10. **Terminal directory reads are still component-owned.**
   - `src/components/Sidebar.tsx`, `src/components/OverviewView.tsx`, and `src/components/BackgroundSessions.tsx` still build terminal-directory fetch behavior directly instead of dispatching store-owned query-window intents.
   - If this is not fixed in the plan, the transport rewrite would still leave leaf components responsible for abort policy, refresh policy, and invalidation choreography.

11. **The websocket handshake still negotiates dead session transport features.**
   - `shared/ws-protocol.ts`, `server/ws-schemas.ts`, `src/lib/ws-client.ts`, and `server/ws-handler.ts` still advertise or track `sessionsPatchV1` and `sessionsPaginationV1`.
   - Those flags are specific to the bulk session snapshot architecture and should not survive websocket v4.

12. **The codebase already has a different concept called bootstrap.**
   - `server/bootstrap.ts` is the pre-dotenv environment bootstrap module and must remain separate from the new shell bootstrap HTTP route.
   - The plan must name and wire the HTTP route clearly enough that execution does not blur those concerns.

## End-State Architecture

### Transport Split

1. `GET /api/bootstrap` returns only shell-critical first-paint data:
   - settings
   - platform and feature flags
   - config fallback/perf flags
   - startup readiness/auth shell state already needed by `App.tsx`
   - no session-directory window, agent timeline, terminal viewport, or terminal list payloads
2. `GET /api/version` and network diagnostics remain background startup work because they are not required for first paint.
3. After shell bootstrap, the client hydrates only currently visible surfaces:
   - `GET /api/session-directory` for sidebar/history only when that surface is on-screen
   - `GET /api/terminals` for overview/background terminal summaries and terminal pickers only when those surfaces are on-screen
   - `GET /api/agent-sessions/:sessionId/timeline` and `GET /api/agent-sessions/:sessionId/turns/:turnId` for the visible agent chat pane
   - `GET /api/terminals/:terminalId/viewport`, `/scrollback`, and `/search` for the visible terminal pane, with viewport responses carrying the runtime metadata needed for pane chrome
4. Startup fan-out is explicit:
   - finish `GET /api/bootstrap`
   - immediately start focused-pane HTTP hydration in the `critical` lane
   - immediately start websocket connect in parallel for live deltas
   - start secondary on-screen surfaces such as sidebar/history in the `visible` lane
   - leave version checks, network diagnostics, offscreen panes, and load-more work in `background`
5. Offscreen tabs and panes do not pre-hydrate by default. They hydrate only on selection or after visible work is idle and explicitly budgeted.
6. Session mutations return focused invalidation signals or enough local confirmation data to refresh only the active query window; they never trigger a full `/api/sessions` reload.
7. WebSocket v4 carries only:
   - `ready`
   - live terminal deltas and lifecycle events
   - lightweight SDK live events and `sdk.session.snapshot`
   - `sessions.changed`
   - `terminals.changed`
   - targeted `terminal.runtime.updated` deltas for already-hydrated visible terminals
   - extension lifecycle
   - never `terminal.list`, `terminal.list.response`, `terminal.list.updated`, `terminal.meta.list`, or `terminal.meta.list.response`

### Priority Rules

1. Read-model work has three lanes: `critical`, `visible`, and `background`.
2. `critical` is reserved for shell bootstrap and the focused pane's first visible payload.
3. `visible` is for on-screen secondary surfaces such as sidebar/history refreshes.
4. Live terminal input and output outrank all read-model work.
5. Background requests are abortable on both client and server.
6. WebSocket readiness is not a prerequisite for painting HTTP-owned visible data; it only gates live delta delivery.
7. Any frame that routinely exceeds the realtime budget is in the wrong transport lane.

### Ownership Rules

1. The server owns expensive directory shaping: search, pagination, snippets, and stable canonical order.
2. The client decides which surfaces are actually visible from local layout state, but the server owns the shape of every fetched read model.
3. The client may still do tiny, client-only adornment on the already-fetched visible window:
   - pinning sessions that already have open tabs
   - displaying local activity state
   - expansion UI state in `HistoryView`
4. The server owns agent turn folding and turn-body hydration.
5. The server owns terminal viewport serialization, scrollback paging, and terminal search.
6. The server also owns terminal directory ordering/filtering and the runtime metadata returned with focused-terminal viewport reads.
7. The server also owns terminal-directory invalidation revisions and the targeted runtime metadata deltas for already-visible terminals.
8. `App.tsx` owns websocket lifecycle. Child components and thunks stop calling `ws.connect()`.
9. Leaf React components dispatch intents and render selectors; they do not build read-model URLs, own fetch cancellation policy, or reconcile revision state locally.
10. Terminal directory query windows and revision refresh policy live in store thunks/selectors or a shared client transport helper, not in `Sidebar.tsx`, `OverviewView.tsx`, or `BackgroundSessions.tsx`.
11. `hello.capabilities` advertises only still-live websocket features; legacy session snapshot and pagination capability flags are removed.

### Cutover Invariants

1. `WS_PROTOCOL_VERSION = 4`.
2. Startup does one shell bootstrap request before websocket connect.
3. Bootstrap never embeds session-directory windows, agent timelines, terminal viewports, or other pane payloads.
4. Immediately after shell bootstrap, the app starts focused-pane HTTP hydration and websocket connect in parallel; focused-pane paint must not wait for websocket `ready`.
5. Secondary on-screen surfaces may start after bootstrap in the `visible` lane, but they must not delay focused-pane paint.
6. `version` and network status no longer block websocket readiness or first paint.
7. No runtime path emits or consumes `sessions.updated`, `sessions.page`, `sessions.patch`, `sessions.fetch`, or `sdk.history`.
8. No runtime path emits or consumes `terminal.list.updated`; terminal-directory invalidation happens through `terminals.changed` revisions instead.
9. No runtime path performs websocket terminal directory or terminal-meta snapshot fetches (`terminal.list`, `terminal.list.response`, `terminal.meta.list`, `terminal.meta.list.response`).
10. Focused-terminal runtime metadata comes from viewport HTTP reads and targeted `terminal.runtime.updated` deltas, not from a global websocket snapshot.
11. Terminal reconnect paints the current viewport first, then requests only the short missed tail with `sinceSeq`.
12. Session and terminal search are server-side only.
13. Session rename/archive/delete flows refetch or invalidate only the active directory window, never a full session snapshot.
14. Terminal patch/delete/create flows invalidate only active terminal-directory windows through `terminals.changed`, never through websocket list snapshots.
15. When state is uncertain, refetch the active visible window instead of rebuilding large client reconciliation logic.
16. CLI list/search flows use the same server-owned session-directory read model family rather than keeping `/api/sessions` and `/api/sessions/search` alive as shadow APIs.
17. No client hello advertises `sessionsPatchV1` or `sessionsPaginationV1`; if `capabilities` remains, it is limited to still-live independent features such as `uiScreenshotV1`.
18. No leaf component constructs `/api/terminals` requests or owns terminal-directory invalidation, cursoring, or abort policy directly.

## Budgets And Invariants

```ts
export const MAX_REALTIME_MESSAGE_BYTES = 16 * 1024
export const MAX_BOOTSTRAP_PAYLOAD_BYTES = 12 * 1024
export const MAX_DIRECTORY_PAGE_ITEMS = 50
export const MAX_AGENT_TIMELINE_ITEMS = 30
export const MAX_TERMINAL_SCROLLBACK_PAGE_BYTES = 64 * 1024
```

Additional invariants:

1. `GET /api/bootstrap` must stay under `MAX_BOOTSTRAP_PAYLOAD_BYTES` and remain shell-only.
2. Realtime queues are bounded; overflow yields gaps or invalidations, never unbounded buffering.
3. Offscreen data is fetched later or on demand, never before the visible window is rendered.

## Wire Contracts That Must Land

These contracts are intentionally explicit so execution does not preserve legacy naming or payload shapes by accident.

```ts
export type SessionsChangedMessage = {
  type: 'sessions.changed'
  revision: number
}

export type TerminalsChangedMessage = {
  type: 'terminals.changed'
  revision: number
}

export type TerminalRuntimeUpdatedMessage = {
  type: 'terminal.runtime.updated'
  terminalId: string
  revision: number
  status: 'running' | 'detached' | 'exited'
  title: string
  cwd?: string
  pid?: number
}

export type TerminalViewportSnapshot = {
  terminalId: string
  revision: number
  serialized: string
  cols: number
  rows: number
  tailSeq: number
  runtime: {
    title: string
    status: 'running' | 'detached' | 'exited'
    cwd?: string
    pid?: number
  }
}
```

Notes:

1. `sessions.changed` and `terminals.changed` are invalidation signals only. They never embed rows or list payloads.
2. `terminal.runtime.updated` is only for terminals the client has already hydrated or attached. It replaces the global `terminal.meta.list` snapshot model.
3. `tailSeq` is the only replay anchor the client uses after painting a viewport snapshot.
4. Any additional field needed by visible pane chrome must be added to `TerminalViewportSnapshot.runtime` or `terminal.runtime.updated`, not recovered through a global list/meta fetch.

## Heavy Test Program

Every task below follows red-green-refactor and adds coverage at the seam being changed. In addition to per-task tests, the execution agent must end with all of these passing:

1. Protocol tests proving websocket v4 rejects old clients and never emits legacy bulk socket messages.
2. Unit tests for realtime queue prioritization and realtime payload budget enforcement.
3. Unit tests for read-model scheduler priority and abort handling.
4. Integration tests for bootstrap, session-directory, agent-timeline, and terminal-view HTTP routes.
5. Client tests proving:
   - `App.tsx` performs one shell bootstrap request and then hydrates only the actually visible surfaces
   - focused-pane HTTP hydration starts after bootstrap without waiting for websocket `ready`
   - child components no longer own websocket connection setup
   - `hello.capabilities` no longer advertises session snapshot or pagination features
   - startup does not request `terminal.meta.list` or any websocket terminal directory snapshot
   - sessions state is visible-window oriented, not snapshot oriented
   - agent chat no longer depends on `sdk.history`
   - split-pane attach recovery no longer depends on `sdk.history`
   - terminal search no longer depends on `SearchAddon`
   - terminal directory state is store-owned, and `Sidebar.tsx`, `OverviewView.tsx`, and `BackgroundSessions.tsx` fetch through `GET /api/terminals` only by dispatching store-owned intents when visible
   - terminal-directory invalidation uses `terminals.changed`, not `terminal.list.updated`
   - pane-header runtime metadata comes from viewport payloads plus targeted runtime deltas, not a global terminal-meta snapshot
   - session rename/archive/delete flows never call `GET /api/sessions`
   - `ws-client` SDK handling no longer depends on replay-history messages
6. Slow-network e2e tests proving:
   - the app becomes interactive before offscreen work completes
   - the focused pane can paint from HTTP read models before websocket `ready` under an artificially delayed handshake
   - focused-pane requests in the `critical` lane complete ahead of merely visible or background work
   - terminal reconnect shows the current screen without replaying the entire backlog
   - runtime pane metadata is available without a global terminal-meta websocket snapshot
   - agent chat reload shows recent turns before older bodies
   - background fetches do not delay terminal input or visible updates
   - token-protected bootstrap still gates first paint correctly
7. Legacy cleanup tests proving:
   - no test or runtime path still imports `server/ws-chunking.ts`
   - no route test still exercises `/api/sessions/search` as the sidebar/history source of truth
   - no test or runtime path still emits or expects `terminal.list.updated`
8. CLI tests proving:
   - `list-sessions` and `search-sessions` no longer call `/api/sessions` or `/api/sessions/search`
   - CLI output still exposes the server-owned directory/search results users expect
9. Final verification:

```bash
npm run lint
npm run check
npm test
npm run verify
```

## Non-Goals

1. Do not keep the legacy socket snapshot protocol alive behind a compatibility shim.
2. Do not move search or heavy pagination back into the browser.
3. Do not bloat bootstrap with directory, timeline, viewport, or other pane payloads.
4. Do not preserve duplicate server route modules after the new architecture lands.

---

### Task 1: Write Failing WebSocket V4 Contract Tests

**Files:**
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/unit/client/lib/ws-client-error-code.test.ts`
- Modify: `test/unit/client/lib/ws-client.test.ts`

**Step 1: Write the failing tests**

Cover:
- protocol version `4` is required
- mismatched clients close with `4010`
- legacy bulk message types are absent from the v4 runtime contract
- new lightweight messages `sessions.changed`, `terminals.changed`, `terminal.runtime.updated`, and `sdk.session.snapshot` are present
- `hello.capabilities` no longer advertises `sessionsPatchV1` or `sessionsPaginationV1`

**Step 2: Run the tests to verify failure**

```bash
npm run test:server -- test/server/ws-protocol.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client-error-code.test.ts test/unit/client/lib/ws-client.test.ts
```

Expected: FAIL because protocol v4 does not exist yet.

**Step 3: Refine the assertions until they describe the exact end state**

Add explicit assertions that no successful attach/create path ever expects `sessions.updated`, `sessions.page`, `sessions.patch`, `sdk.history`, or `terminal.list.updated`.

**Step 4: Run the tests again**

```bash
npm run test:server -- test/server/ws-protocol.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client-error-code.test.ts test/unit/client/lib/ws-client.test.ts
```

Expected: still FAIL, but now for the correct missing contract.

**Step 5: Commit**

```bash
git add test/server/ws-protocol.test.ts test/unit/client/lib/ws-client-error-code.test.ts test/unit/client/lib/ws-client.test.ts
git commit -m "test(protocol): define websocket v4 slow-network contract"
```

---

### Task 2: Implement The WebSocket V4 Contract

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-schemas.ts`
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

export type TerminalsChangedMessage = {
  type: 'terminals.changed'
  revision: number
}

export type TerminalRuntimeUpdatedMessage = {
  type: 'terminal.runtime.updated'
  terminalId: string
  revision: number
  status: 'running' | 'detached' | 'exited'
  title: string
  cwd?: string
  pid?: number
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

Also prune `HelloSchema.capabilities` to only still-live websocket features.

**Step 2: Remove bulk-session capability negotiation**

Delete `sessionsPatchV1` and `sessionsPaginationV1` from client hello generation, schema validation, and handler state. Keep unrelated websocket capabilities only if they still serve a live v4 feature.

**Step 3: Make the server reject mismatched clients immediately**

Close mismatches with `4010` and `PROTOCOL_MISMATCH`.

**Step 4: Make the client speak only v4 and treat `4010` as fatal**

`src/lib/ws-client.ts` must stop retrying protocol-mismatch connections.

**Step 5: Run the tests to verify pass**

```bash
npm run test:server -- test/server/ws-protocol.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client-error-code.test.ts test/unit/client/lib/ws-client.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add shared/ws-protocol.ts server/ws-schemas.ts server/ws-handler.ts src/lib/ws-client.ts
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
- critical jobs start before visible and background jobs
- visible jobs start before background jobs
- background concurrency is capped
- request abort cancels queued work and aborts request-bound work correctly
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
export type ReadModelPriority = 'critical' | 'visible' | 'background'

export class ReadModelWorkScheduler {
  run<T>(priority: ReadModelPriority, job: (signal: AbortSignal) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>
  snapshot(): {
    criticalQueued: number
    visibleQueued: number
    backgroundQueued: number
    runningCritical: number
    runningVisible: number
    runningBackground: number
  }
}
```

**Step 2: Implement request-bound abort signals**

`server/read-models/request-abort.ts` should turn request close/abort into an `AbortSignal`.

**Step 3: Keep policy explicit**

`critical` work may jump ahead of queued `visible` and `background` work. `visible` work may jump ahead of queued `background` work. No lane cancels already-running work except through the owning request abort signal.

**Step 4: Run the test to verify pass**

```bash
npm run test:server -- test/unit/server/read-models/work-scheduler.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/read-models/work-scheduler.ts server/read-models/request-abort.ts
git commit -m "feat(server): add priority-aware read-model scheduler"
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
- `TerminalDirectoryQuery`
- `TerminalDirectoryItem`
- `TerminalDirectoryPage`
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
getTerminalDirectoryPage(...)
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
- `GET /api/bootstrap` returns only shell-critical first-paint data
- bootstrap excludes session-directory, agent timeline, terminal viewport, and terminal list payloads
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
- Create: `server/shell-bootstrap-router.ts`
- Modify: `server/index.ts`

**Step 1: Implement `GET /api/bootstrap`**

Use the new shared contract and return:
- settings
- platform/available CLI/feature flags data
- config fallback/perf flags
- startup readiness/auth shell state already needed before visible surfaces hydrate
- no session-directory, agent timeline, terminal viewport, or terminal list payloads
- data that currently arrives through websocket handshake snapshots (`perf.logging`, `config.fallback`, and similar shell-only flags) must move here so the websocket can stay realtime-only

**Step 2: Keep lower-priority startup work out of bootstrap**

Do not include version/update checks or network diagnostics.

**Step 3: Mount the route in `server/index.ts`**

Use the existing app wiring style; do not introduce a parallel boot path.

**Step 4: Keep it separate from environment bootstrap**

Do not repurpose or rename `server/bootstrap.ts`; that file is the pre-dotenv environment bootstrap seam, not the HTTP shell bootstrap route.

**Step 5: Run the test to verify pass**

```bash
npm run test:server -- test/integration/server/bootstrap-router.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add server/shell-bootstrap-router.ts server/index.ts
git commit -m "feat(api): add shell-only bootstrap route"
```

---

### Task 11: Write Failing App Bootstrap Tests

**Files:**
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/unit/client/components/App.ws-extensions.test.tsx`
- Modify: `test/unit/client/components/App.lazy-views.test.tsx`
- Modify: `test/unit/client/components/App.mobile.test.tsx`
- Modify: `test/unit/client/components/App.mobile-landscape.test.tsx`
- Modify: `test/unit/client/components/App.swipe-sidebar.test.tsx`
- Modify: `test/unit/client/components/App.swipe-tabs.test.tsx`
- Modify: `test/unit/client/components/App.sidebar-resize.test.tsx`

**Step 1: Write the failing tests**

Cover:
- app uses one shell bootstrap request before websocket connect
- visible surfaces hydrate after shell bootstrap based on the current layout instead of being inlined into bootstrap
- focused-pane HTTP hydration starts after bootstrap without waiting for websocket `ready`
- `version` and network status are demoted to background work
- `App.tsx` owns websocket connection lifecycle
- child components no longer need to call `ws.connect()`
- app no longer requests `terminal.meta.list` during bootstrap
- all app bootstrap-oriented tests stop treating `/api/sessions` as a startup prerequisite

**Step 2: Run the tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx
```

Expected: FAIL because startup is still a waterfall and connection ownership is fragmented.

**Step 3: Add assertions around ordering**

Shell bootstrap must finish before focused-pane hydration and websocket connect begin. Focused-pane HTTP hydration must start immediately after bootstrap and before websocket `ready` resolves. Sidebar or other secondary on-screen hydration must remain separate follow-up work in the `visible` lane.

**Step 4: Run the tests again**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx
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
dispatch(hydrateFocusedPaneFromLayout())
dispatch(hydrateVisibleSurfacesFromLayout())
const wsReadyPromise = ws.connect()
void hydrateBackgroundShellData()
await wsReadyPromise
```

**Step 3: Keep shell bootstrap narrow and move other work to the right lanes**

Run `GET /api/version` and network status in the background after shell bootstrap; do not let them wait on websocket `ready`, and do not let websocket `ready` gate focused-pane paint. Let sidebar/history, terminal viewport, terminal directory, and agent timeline fetch through their own read-model requests based on what is actually visible, with the focused pane dispatched first in the `critical` lane and secondary on-screen surfaces in the `visible` lane. Remove the bootstrap-time `terminal.meta.list` request and seed config-fallback/perf state from `GET /api/bootstrap` instead of a websocket handshake snapshot.

**Step 4: Remove bootstrap-time `/api/sessions` assumptions from the remaining App surfaces**

`App.lazy-views`, mobile, swipe, and resize paths must read the new bootstrap contract and visible-surface hydration flow instead of a preloaded sessions snapshot.

**Step 5: Run the tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx
```

Expected: PASS.

**Step 6: Commit**

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
- Create: `test/unit/client/store/sessionsThunks.test.ts`

**Step 1: Write the failing tests**

Cover:
- state stores query window data instead of `ProjectGroup[]`
- invalidation refreshes the visible window instead of merging snapshots
- selectors annotate visible items without reconstructing full project trees
- store-owned thunks own fetch, cursor, abort, and revision refresh policy instead of leaf components

**Step 2: Run the tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/unit/client/store/sessionsThunks.test.ts
```

Expected: FAIL because the slice and selectors still assume full snapshots.

**Step 3: Preserve client-only adornment in the assertions**

Keep tests for tab pinning and visibility filters on the visible window only.

**Step 4: Run the tests again**

```bash
NODE_ENV=test npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/unit/client/store/sessionsThunks.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/unit/client/store/sessionsThunks.test.ts
git commit -m "test(client): define visible-window sessions state"
```

---

### Task 18: Implement Query-Window Sessions State And Selectors

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Create: `src/store/sessionsThunks.ts`

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

**Step 3: Move fetch orchestration into store thunks**

`src/store/sessionsThunks.ts` should own:
- initial visible-window fetch
- load-more
- refresh-on-revision
- request abort wiring through `AbortSignal`

Components should dispatch these thunks and stop owning transport details.

**Step 4: Keep selectors narrow**

Selectors may annotate and locally pin already-fetched visible items, but must not perform search or deep pagination.

**Step 5: Run the tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/unit/client/store/sessionsThunks.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/store/sessionsSlice.ts src/store/selectors/sidebarSelectors.ts src/store/sessionsThunks.ts
git commit -m "refactor(client): store session directory windows instead of snapshots"
```

---

### Task 19: Write Failing Sidebar And HistoryView Tests

**Files:**
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/Sidebar.mobile.test.tsx`
- Modify: `test/unit/client/components/Sidebar.render-stability.test.tsx`
- Modify: `test/unit/client/components/HistoryView.a11y.test.tsx`
- Modify: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify: `test/e2e/refresh-context-menu-flow.test.tsx`

**Step 1: Write the failing tests**

Cover:
- all search tiers call `/api/session-directory`
- load-more uses returned cursors
- stale requests are aborted
- `sessions.changed` triggers a bounded refresh of the active window
- `HistoryView` keeps only UI expansion state locally
- rename/archive/delete actions refresh only the active directory window and never call `GET /api/sessions`
- sidebar and history views dispatch store intents instead of owning fetch choreography directly

**Step 2: Run the tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/refresh-context-menu-flow.test.tsx
```

Expected: FAIL because both components still derive from local snapshots.

**Step 3: Keep accessibility assertions intact**

The transport rewrite must not degrade discoverability or keyboard access.

**Step 4: Run the tests again**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/refresh-context-menu-flow.test.tsx
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/refresh-context-menu-flow.test.tsx
git commit -m "test(ui): define server-driven session browsing flow"
```

---

### Task 20: Implement Server-Driven Sidebar And HistoryView

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/App.tsx`
- Modify: `src/store/sessionsThunks.ts`

**Step 1: Move session search, paging, and mutation refresh to store-owned HTTP read models**

Use `priority=visible` for active searches and `priority=background` for load-more.

**Step 2: Keep components thin**

`Sidebar.tsx`, `HistoryView.tsx`, and `ContextMenuProvider.tsx` should dispatch session-directory intents and render selector output; they must not build request URLs or own revision reconciliation.

**Step 3: Add abortable request ownership**

Each active query gets its own `AbortController`. Session rename/archive/delete flows must invalidate or refetch only the active window rather than calling `GET /api/sessions`.

**Step 4: Keep only small local UI state**

Local state may cover search box text, project expansion, and selected item; heavy query results stay server-authored.

**Step 5: Run the tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/refresh-context-menu-flow.test.tsx
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/components/Sidebar.tsx src/components/HistoryView.tsx src/components/context-menu/ContextMenuProvider.tsx src/App.tsx src/store/sessionsThunks.ts
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
- Modify: `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`
- Modify: `test/unit/client/ws-client-sdk.test.ts`
- Create: `test/unit/client/store/agentChatThunks.test.ts`

**Step 1: Write the failing tests**

Cover:
- reload shows recent turn summaries first
- `sdk.session.snapshot` seeds metadata without `sdk.history`
- switching sessions aborts stale timeline fetches
- session loss still triggers immediate recovery handling
- split-pane remount and reattach recover from `sdk.session.snapshot` plus live status without replay-history fallback
- `ws-client` dispatches snapshot/live events without replay-history fallback
- store-owned thunks own timeline/body fetch cancellation instead of `AgentChatView` doing transport choreography inline

**Step 2: Run the tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/unit/client/ws-client-sdk.test.ts test/unit/client/store/agentChatThunks.test.ts
```

Expected: FAIL because the client still expects replay arrays.

**Step 3: Add assertions for on-demand body hydration**

Collapsed turns must fetch bodies only when opened.

**Step 4: Run the tests again**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/unit/client/ws-client-sdk.test.ts test/unit/client/store/agentChatThunks.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/unit/client/ws-client-sdk.test.ts test/unit/client/store/agentChatThunks.test.ts
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
- Create: `src/store/agentChatThunks.ts`

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

**Step 3: Move HTTP timeline/body fetches into store thunks**

`src/store/agentChatThunks.ts` should own:
- initial timeline page fetch for the visible session
- older-page fetches
- on-demand turn-body hydration
- abort-on-session-switch behavior

`AgentChatView.tsx` should dispatch intents and render selector state rather than managing request lifecycle directly.

**Step 4: Fetch older pages and turn bodies only on scroll or expand**

Abort stale requests on session switch.

**Step 5: Run the tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/unit/client/store/agentChatThunks.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/lib/sdk-message-handler.ts src/components/agent-chat/AgentChatView.tsx src/components/agent-chat/CollapsedTurn.tsx src/store/agentChatThunks.ts
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
- Modify: `test/server/ws-terminal-meta.test.ts`

**Step 1: Write the failing tests**

Cover:
- `GET /api/terminals` returns cursorable terminal-directory windows for overview/background/picker surfaces
- `/api/terminals/:terminalId/viewport` returns visible state and `tailSeq`
- `/api/terminals/:terminalId/scrollback` returns bounded older pages
- `/api/terminals/:terminalId/search` performs server-side search
- viewport responses include the runtime metadata needed for visible pane chrome
- terminal create/patch/delete paths emit `terminals.changed` revision invalidations instead of `terminal.list.updated`
- already-visible terminals receive targeted `terminal.runtime.updated` deltas instead of a global metadata snapshot
- background search/scrollback work is abortable

**Step 2: Run the tests to verify failure**

```bash
npm run test:server -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts test/server/ws-terminal-meta.test.ts
```

Expected: FAIL because the terminal read-model contract does not exist yet.

**Step 3: Make search behavior explicit**

Assert that terminal search no longer depends on client-only addons and that terminal-directory payloads stay separate from viewport payloads.

**Step 4: Run the tests again**

```bash
npm run test:server -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts test/server/ws-terminal-meta.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts test/server/ws-terminal-meta.test.ts
git commit -m "test(terminal): define directory, viewport, scrollback, and search routes"
```

---

### Task 30: Implement Terminal Viewport, Scrollback, And Search Routes

**Files:**
- Create: `server/terminal-view/service.ts`
- Modify: `server/terminals-router.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`

**Step 1: Implement the terminal-view service**

Expose:

```ts
getTerminalDirectoryPage(...)
getTerminalViewport(...)
getTerminalScrollbackPage(...)
searchTerminalView(...)
```

**Step 2: Extend `server/terminals-router.ts`**

Keep terminal route ownership in the existing router rather than adding a parallel top-level router. `GET /api/terminals` becomes the server-owned terminal directory read model for overview/background/picker surfaces, while `PATCH` and `DELETE` keep their existing mutation responsibilities.

**Step 3: Route work through the scheduler**

Viewport is `critical` priority. Visible terminal-directory reads are `visible`, background terminal-directory refreshes are `background`. Scrollback is `background`. Search is `visible` only when the user is actively focused in terminal search; otherwise it stays `background`.

**Step 4: Replace terminal-directory invalidation and metadata broadcast semantics**

`server/terminals-router.ts` and `server/ws-handler.ts` must emit `terminals.changed` revision invalidations for directory-affecting terminal mutations and `terminal.runtime.updated` only for already-visible terminals whose runtime metadata changes. Do not preserve `terminal.list.updated` or reintroduce a global metadata snapshot.

**Step 5: Run the tests to verify pass**

```bash
npm run test:server -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts test/server/ws-terminal-meta.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add server/terminal-view/service.ts server/terminals-router.ts server/ws-handler.ts server/index.ts
git commit -m "feat(terminal): serve terminal directory, viewport, scrollback, and server-side search"
```

---

### Task 31: Write Failing Terminal Client Restore And Search Tests

**Files:**
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/Sidebar.mobile.test.tsx`
- Create: `test/unit/client/components/OverviewView.test.tsx`
- Modify: `test/unit/client/components/BackgroundSessions.test.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/unit/client/components/TerminalView.search.test.tsx`
- Modify: `test/unit/client/components/terminal/terminal-runtime.test.ts`
- Create: `test/unit/client/store/terminalDirectorySlice.test.ts`
- Create: `test/unit/client/store/terminalDirectoryThunks.test.ts`
- Modify: `test/unit/client/store/terminalMetaSlice.test.ts`
- Modify: `test/unit/client/components/component-edge-cases.test.tsx`
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`
- Modify: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`

**Step 1: Write the failing tests**

Cover:
- bootstrap does not request `terminal.meta.list`
- terminal directory query windows are store-owned rather than component-owned
- sidebar, overview, and background terminal surfaces fetch `GET /api/terminals` only by dispatching store-owned intents when visible instead of sending websocket `terminal.list`
- mount or reattach fetches `/viewport` before websocket attach
- `sinceSeq` uses `tailSeq` from the viewport snapshot
- viewport responses seed the runtime metadata needed for visible pane chrome without a global websocket terminal-meta snapshot
- terminal-directory invalidation listens for `terminals.changed`, not `terminal.list.updated`
- pane-header metadata updates flow from `terminal.runtime.updated` for already-visible terminals
- search UI calls the server instead of `SearchAddon`
- background terminal work does not block live input

**Step 2: Run the tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/OverviewView.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: FAIL because restore is still replay-first and search is still client-side.

**Step 3: Add an assertion that `SearchAddon` is not loaded**

The dependency removal is part of the architectural end state.

**Step 4: Run the tests again**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/OverviewView.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/OverviewView.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
git commit -m "test(terminal): define visible-only terminal summaries and viewport restore"
```

---

### Task 32: Implement Viewport-First Terminal Restore And Server Search

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/OverviewView.tsx`
- Modify: `src/components/BackgroundSessions.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/terminal/terminal-runtime.ts`
- Modify: `src/lib/terminal-attach-seq-state.ts`
- Modify: `src/lib/ws-client.ts`
- Create: `src/store/terminalDirectorySlice.ts`
- Create: `src/store/terminalDirectoryThunks.ts`
- Modify: `src/store/terminalMetaSlice.ts`
- Modify: `src/store/store.ts`

**Step 1: Remove client-side terminal search ownership**

Delete `SearchAddon` usage from `src/components/terminal/terminal-runtime.ts`.

**Step 2: Move terminal-directory window ownership out of leaf components**

Create a store-owned terminal-directory slice and thunk layer that owns:
- initial visible fetch
- manual refresh
- refresh-on-`terminals.changed`
- cursoring if the directory grows beyond one window
- abort behavior for stale visible/background requests

`Sidebar.tsx`, `OverviewView.tsx`, and `BackgroundSessions.tsx` should dispatch these intents rather than building `/api/terminals` requests or websocket `terminal.list` flows directly.

**Step 3: Make restore viewport-first**

Use:

```ts
const snapshot = await api.getTerminalViewport(terminalId, cols, rows)
terminal.reset()
terminal.write(snapshot.serialized)
ws.send({ type: 'terminal.attach', terminalId, cols, rows, sinceSeq: snapshot.tailSeq })
```

**Step 4: Move terminal summaries and focused runtime metadata onto HTTP read models**

`Sidebar.tsx`, `OverviewView.tsx`, and `BackgroundSessions.tsx` must stop sending websocket `terminal.list` requests. `App.tsx` must stop requesting `terminal.meta.list` on connect. `src/store/terminalMetaSlice.ts` should become a scoped cache fed by viewport responses and delta upserts for already-visible terminals instead of a global startup snapshot.

**Step 5: Consume the new terminal invalidation and runtime delta model**

`src/App.tsx`, `src/components/Sidebar.tsx`, `src/components/OverviewView.tsx`, `src/components/BackgroundSessions.tsx`, `src/store/terminalDirectorySlice.ts`, `src/store/terminalDirectoryThunks.ts`, and `src/store/terminalMetaSlice.ts` must listen for `terminals.changed` to refetch only active terminal-directory windows and for `terminal.runtime.updated` to refresh already-visible pane chrome. No client path may still expect `terminal.list.updated`.

**Step 6: Keep background work abortable**

Terminal scrollback and search requests must cancel on pane switch or query change.

**Step 7: Run the tests to verify pass**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/OverviewView.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: PASS.

**Step 8: Commit**

```bash
git add src/App.tsx src/components/Sidebar.tsx src/components/OverviewView.tsx src/components/BackgroundSessions.tsx src/components/TerminalView.tsx src/components/terminal/terminal-runtime.ts src/lib/terminal-attach-seq-state.ts src/lib/ws-client.ts src/store/terminalDirectorySlice.ts src/store/terminalDirectoryThunks.ts src/store/terminalMetaSlice.ts src/store/store.ts
git commit -m "refactor(terminal): fetch visible summaries and paint viewport before replay"
```

---

### Task 33: Write Failing Legacy Transport Cleanup Tests

**Files:**
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/server/ws-terminal-meta.test.ts`
- Modify: `test/server/ws-terminal-create-session-repair.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/unit/server/ws-chunking.test.ts`
- Modify: `test/server/ws-sessions-patch.test.ts`
- Modify: `test/unit/server/sessions-router-pagination.test.ts`
- Modify: `test/unit/cli/http.test.ts`
- Modify: `test/unit/cli/commands.test.ts`
- Modify: `test/e2e/terminal-font-settings.test.tsx`
- Modify: `test/e2e/mobile-sidebar-fullwidth-flow.test.tsx`
- Create: `test/integration/session-directory-e2e.test.ts`
- Delete: `test/integration/session-search-e2e.test.ts`

**Step 1: Write the failing tests**

Cover:
- no v4 path emits `sessions.updated`, `sessions.page`, `sessions.patch`, `sessions.fetch`, or `sdk.history`
- no runtime path still sends websocket `terminal.list` requests, emits `terminal.list.updated`, or consumes `terminal.meta.list` snapshots
- session sync emits revisions only
- websocket chunking code is no longer used
- no route test treats `/api/sessions/search` as the authoritative sidebar/history contract
- CLI list/search commands no longer call legacy session snapshot routes
- leftover bootstrap/e2e scaffolds no longer stub `/api/sessions` as a required startup request

**Step 2: Run the tests to verify failure**

```bash
npm run test:server -- test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-meta.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-chunking.test.ts test/server/ws-sessions-patch.test.ts test/unit/server/sessions-router-pagination.test.ts
NODE_ENV=test npx vitest run test/unit/cli/http.test.ts test/unit/cli/commands.test.ts test/e2e/terminal-font-settings.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/integration/session-directory-e2e.test.ts
```

Expected: FAIL because the legacy paths still exist.

**Step 3: Add dead-code protection**

Make the tests fail if old chunking helpers or snapshot broadcasts are reintroduced.

**Step 4: Run the tests again**

```bash
npm run test:server -- test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-meta.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-chunking.test.ts test/server/ws-sessions-patch.test.ts test/unit/server/sessions-router-pagination.test.ts
NODE_ENV=test npx vitest run test/unit/cli/http.test.ts test/unit/cli/commands.test.ts test/e2e/terminal-font-settings.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/integration/session-directory-e2e.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-meta.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-chunking.test.ts test/server/ws-sessions-patch.test.ts test/unit/server/sessions-router-pagination.test.ts test/unit/cli/http.test.ts test/unit/cli/commands.test.ts test/e2e/terminal-font-settings.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/integration/session-directory-e2e.test.ts
git rm test/integration/session-search-e2e.test.ts
git commit -m "test(transport): forbid legacy bulk websocket flows"
```

---

### Task 34: Remove Legacy Bulk Transport Paths And Dead Modules

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `server/ws-schemas.ts`
- Modify: `src/App.tsx`
- Modify: `src/lib/ws-client.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `server/cli/index.ts`
- Modify: `server/index.ts`
- Modify: `server/terminals-router.ts`
- Delete: `server/ws-chunking.ts`
- Delete: `server/routes/sessions.ts`
- Delete: `server/routes/terminals.ts`
- Modify: `server/session-pagination.ts`

**Step 1: Delete the legacy session socket flow**

Remove:
- `sessions.updated`
- `sessions.page`
- `sessions.patch`
- `sessions.fetch`
- `sdk.history`
- `sessionsPatchV1` and `sessionsPaginationV1` hello capability negotiation
- websocket terminal-directory request/response flows (`terminal.list`, `terminal.list.response`) and the boot-time terminal-meta snapshot path (`terminal.meta.list`, `terminal.meta.list.response`)
- `terminal.list.updated`

**Step 2: Remove dead code and imports**

Delete `server/ws-chunking.ts`, `server/routes/sessions.ts`, and the duplicate `server/routes/terminals.ts` module. Remove `/api/sessions/search` if no runtime callers remain. Remove websocket handshake snapshot plumbing from `server/index.ts`, `server/ws-handler.ts`, `server/ws-schemas.ts`, `shared/ws-protocol.ts`, and `server/terminals-router.ts` once bootstrap owns shell-only flags and terminal invalidation uses revisions. Reduce `server/session-pagination.ts` to only what still supports HTTP read-model cursoring, or delete the dead parts if nothing remains.

**Step 3: Carry the CLI onto the new session-directory contract**

`server/cli/index.ts` must use the server-owned directory/search routes for `list-sessions` and `search-sessions` so the legacy endpoints can actually die.

**Step 4: Simplify client startup and message handling**

`src/App.tsx` must no longer buffer chunked session snapshots or request global terminal-meta websocket snapshots after connect. `src/lib/ws-client.ts` must no longer advertise dead session transport capabilities. `src/App.tsx` and all terminal-directory UI surfaces must no longer listen for or emit `terminal.list.updated`.

**Step 5: Run the tests to verify pass**

```bash
npm run test:server -- test/server/ws-handshake-snapshot.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-meta.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-chunking.test.ts test/server/ws-sessions-patch.test.ts test/unit/server/sessions-router-pagination.test.ts
NODE_ENV=test npx vitest run test/unit/cli/http.test.ts test/unit/cli/commands.test.ts test/e2e/terminal-font-settings.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/integration/session-directory-e2e.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add server/ws-handler.ts server/ws-schemas.ts src/App.tsx src/lib/ws-client.ts shared/ws-protocol.ts server/cli/index.ts server/index.ts server/terminals-router.ts server/session-pagination.ts
git rm server/ws-chunking.ts server/routes/sessions.ts server/routes/terminals.ts
git commit -m "refactor(transport): delete legacy bulk websocket architecture"
```

---

### Task 35: Write Failing Slow-Network Instrumentation And E2E Tests

**Files:**
- Create: `test/e2e/slow-network-end-to-end.test.tsx`
- Modify: `test/e2e/agent-chat-polish-flow.test.tsx`
- Modify: `test/e2e/agent-cli-flow.test.ts`
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`
- Modify: `test/e2e/terminal-search-flow.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify: `test/e2e/auth-required-bootstrap-flow.test.tsx`
- Modify: `test/unit/server/perf-logger.test.ts`
- Modify: `test/unit/client/lib/perf-logger.test.ts`

**Step 1: Write the failing tests**

Cover:
- payload bytes and queue-depth logging exists for bootstrap, session-directory, agent timeline, terminal routes, and realtime terminal output
- app becomes interactive before background work completes
- shell bootstrap stays below the bootstrap byte budget and does not inline pane payloads
- terminal restore shows current screen without replaying the full backlog
- pane-header metadata updates without any global terminal-meta websocket snapshot
- agent chat shows recent turns before older bodies
- background work does not delay terminal input
- focused-pane `critical` requests complete before queued `visible` and `background` work
- auth-required startup still renders the login path before any protected bootstrap payload is consumed
- CLI session discovery/search still works over the new server-owned directory/search contract

**Step 2: Run the tests to verify failure**

```bash
NODE_ENV=test npx vitest run test/e2e/slow-network-end-to-end.test.tsx test/e2e/agent-chat-polish-flow.test.tsx test/e2e/agent-cli-flow.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-search-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/unit/server/perf-logger.test.ts test/unit/client/lib/perf-logger.test.ts
```

Expected: FAIL until instrumentation and the full cutover are in place.

**Step 3: Make the performance budgets explicit in assertions**

Do not settle for generic "faster" checks.

**Step 4: Run the tests again**

```bash
NODE_ENV=test npx vitest run test/e2e/slow-network-end-to-end.test.tsx test/e2e/agent-chat-polish-flow.test.tsx test/e2e/agent-cli-flow.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-search-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/unit/server/perf-logger.test.ts test/unit/client/lib/perf-logger.test.ts
```

Expected: still FAIL.

**Step 5: Commit**

```bash
git add test/e2e/slow-network-end-to-end.test.tsx test/e2e/agent-chat-polish-flow.test.tsx test/e2e/agent-cli-flow.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-search-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/unit/server/perf-logger.test.ts test/unit/client/lib/perf-logger.test.ts
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
- route priority lane for every scheduled read-model job
- realtime queue depth and dropped bytes for terminal output
- client parse/paint timing around shell bootstrap and viewport restore

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
6. Do not reintroduce a global terminal summary or terminal-meta bootstrap snapshot just because a pane-title or overview test is inconvenient; visible-surface reads are the architecture, not an optimization pass.
7. Rename or replace legacy-named tests when the name encodes the old architecture. Keeping a `session-search` test file around for the new directory contract is a maintenance bug, not a convenience.
8. Keep startup choreography honest: a delayed websocket handshake must not prevent the focused pane from painting from its HTTP read model.

# Visible-First Prioritized Transport Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Land the full visible-first prioritized transport spec directly, prove it with enforced quality gates, and produce a trusted post-cutover audit artifact that compares cleanly against a trusted pre-cutover baseline with no `mobile_restricted` regressions.

**Architecture:** Hard-cut Freshell to server-owned visible/read-model transport. HTTP owns shell bootstrap, session-directory windows, agent timelines, turn bodies, terminal viewports, scrollback, and search; WebSocket v4 owns only live control messages, invalidations, targeted runtime deltas, and live terminal/SDK events. The server owns shaping, ordering, budgets, scheduling, and instrumentation; the client owns only visibility, selection, optimistic UI, and light client-only adornment that depends on browser-local state.

**Tech Stack:** Node.js, Express, `ws`, React 18, Redux Toolkit, TypeScript, Zod, Vitest, Playwright/Chromium audit harness, `tsx`

---

## Why This Rewrite Exists

The previous completion plan had the right destination, but it was not excellent by trycycle standards:

1. Several tasks ended on committed red states. That violates the requirement to end each task green and invites stacked failures.
2. Too many tasks were still “change a whole subsystem” sized rather than one seam at a time.
3. Multiple tests were named without listing the production files that would actually have to change.
4. The plan did not explicitly pull a few important files into scope:
   - `src/components/HistoryView.tsx`
   - `src/components/context-menu/ContextMenuProvider.tsx`
   - `server/session-directory/service.ts`
   - `server/session-directory/types.ts`
   - `server/agent-timeline/types.ts`
   - `test/unit/server/session-directory/service.test.ts`
   - `test/unit/server/agent-timeline/service.test.ts`
   - `test/server/ws-terminal-create-session-repair.test.ts`
   - `test/server/ws-terminal-create-reuse-running-claude.test.ts`
   - `test/server/ws-terminal-create-reuse-running-codex.test.ts`

This revision preserves the accepted architecture and hard-cut direction. What changes is the execution shape:

1. Every task is red-green-refactor and ends green.
2. No task commits failing tests.
3. The direct landing path stays intact. There is no “stabilize before cutover” phase.
4. The mobile restricted profile remains the decision rule.

## Source Of Truth

Treat these four documents as the authoritative spec set, in this order:

1. `docs/plans/2026-03-09-visible-first-prioritized-transport.md`
2. `docs/plans/2026-03-09-visible-first-prioritized-transport-test-plan.md`
3. `docs/plans/2026-03-10-visible-first-performance-audit.md`
4. `docs/plans/2026-03-10-visible-first-performance-audit-test-plan.md`

## Strategy Gate

The problem to solve is not “make the old transport somewhat cheaper.” The problem is “delete the hybrid transport and make visible-first authoritative.”

Non-negotiable direction:

1. Do not preserve compatibility shims for legacy bulk WebSocket payloads.
2. Do not narrow the performance audit matrix. Keep six scenarios across `desktop_local` and `mobile_restricted`.
3. `mobile_restricted` is the user’s decision rule. A mobile regression is a failed landing even if desktop improves.
4. `src/App.tsx` is the only WebSocket owner.
5. Hidden panes and offscreen tabs do not prehydrate. Visibility or explicit selection is the trigger.
6. The server owns search, pagination, turn folding, terminal viewport serialization, runtime metadata, invalidation revisions, lane scheduling, payload budgets, and transport instrumentation.
7. Generated audit artifacts are never committed.

## Machine Gate

The landing is complete only when all of the following are true:

1. The pre-cutover baseline artifact is trusted.
2. The post-cutover candidate artifact is trusted.
3. Every scenario/profile pair is present in both artifacts.
4. Every sample in both artifacts has `status === "ok"`.
5. No `mobile_restricted.focusedReadyMs` delta is positive.
6. No `mobile_restricted.terminalInputToFirstOutputMs` delta is positive for:
   - `terminal-cold-boot`
   - `terminal-reconnect-backlog`
7. No positive delta appears in either profile for:
   - `offscreenHttpRequestsBeforeReady`
   - `offscreenHttpBytesBeforeReady`
   - `offscreenWsFramesBeforeReady`
   - `offscreenWsBytesBeforeReady`
8. Production code no longer emits or consumes:
   - `sessions.updated`
   - `sessions.page`
   - `sessions.patch`
   - `sessions.fetch`
   - `sdk.history`
   - `terminal.list`
   - `terminal.list.response`
   - `terminal.list.updated`
   - `terminal.meta.list`
   - `terminal.meta.list.response`
   - `sessionsPatchV1`
   - `sessionsPaginationV1`
9. No production code uses `/api/sessions/search` or `/api/sessions/query`.
10. Only `src/App.tsx` calls `ws.connect()`.

## Execution Rules

1. Every task follows this order:
   - write failing tests
   - run the narrow lane and watch it fail
   - write the minimal implementation
   - rerun the narrow lane and make it pass
   - delete dead code or refactor while green
   - rerun the narrow lane
   - commit
2. Every task ends green. Do not commit red states.
3. If a task reveals an omitted test or production file that clearly belongs to that seam, add it to that task before committing.
4. If a later full-suite run fails, fix the real defect at the narrowest seam, add the missing regression if needed, and rerun the full gate. Do not waive failures.
5. Do not commit generated audit artifacts under `artifacts/perf/`.

## Files That Matter

Shared transport contracts:

- `shared/ws-protocol.ts`
- `shared/read-models.ts`

Server bootstrap, directory, timeline, terminal, and instrumentation seams:

- `server/index.ts`
- `server/shell-bootstrap-router.ts`
- `server/sessions-router.ts`
- `server/session-pagination.ts`
- `server/session-directory/service.ts`
- `server/session-directory/types.ts`
- `server/agent-timeline/router.ts`
- `server/agent-timeline/service.ts`
- `server/agent-timeline/types.ts`
- `server/terminals-router.ts`
- `server/terminal-view/service.ts`
- `server/terminal-stream/broker.ts`
- `server/terminal-stream/client-output-queue.ts`
- `server/read-models/work-scheduler.ts`
- `server/request-logger.ts`
- `server/perf-logger.ts`
- `server/session-history-loader.ts`
- `server/sessions-sync/service.ts`
- `server/cli/index.ts`
- `server/routes/sessions.ts`
- `server/routes/terminals.ts`
- `server/ws-handler.ts`
- `server/ws-chunking.ts`

Client bootstrap, session, agent chat, and terminal seams:

- `src/App.tsx`
- `src/lib/api.ts`
- `src/lib/ws-client.ts`
- `src/lib/sdk-message-handler.ts`
- `src/lib/terminal-attach-seq-state.ts`
- `src/lib/perf-logger.ts`
- `src/components/SessionView.tsx`
- `src/components/Sidebar.tsx`
- `src/components/OverviewView.tsx`
- `src/components/BackgroundSessions.tsx`
- `src/components/HistoryView.tsx`
- `src/components/TabContent.tsx`
- `src/components/TerminalView.tsx`
- `src/components/terminal/terminal-runtime.ts`
- `src/components/terminal/TerminalSearchBar.tsx`
- `src/components/context-menu/ContextMenuProvider.tsx`
- `src/components/agent-chat/AgentChatView.tsx`
- `src/components/agent-chat/CollapsedTurn.tsx`
- `src/store/sessionsSlice.ts`
- `src/store/sessionsThunks.ts`
- `src/store/selectors/sidebarSelectors.ts`
- `src/store/agentChatTypes.ts`
- `src/store/agentChatSlice.ts`
- `src/store/agentChatThunks.ts`
- `src/store/terminalDirectorySlice.ts`
- `src/store/terminalDirectoryThunks.ts`
- `src/store/terminalMetaSlice.ts`
- `src/store/store.ts`

Audit gate tooling:

- `test/e2e-browser/perf/audit-contract.ts`
- `test/e2e-browser/perf/compare-visible-first-audits.ts`
- `test/e2e-browser/perf/visible-first-audit-gate.ts`
- `scripts/assert-visible-first-audit-gate.ts`
- `package.json`

## Preflight: Trusted Baseline Artifact

Do this before editing runtime code.

1. Create the artifact directory:

```bash
mkdir -p artifacts/perf
```

2. Capture the pre-cutover baseline:

```bash
npm run perf:audit:visible-first -- --output artifacts/perf/visible-first-baseline.pre-cutover.json
```

3. Validate that the baseline is trusted:

```bash
npx tsx --eval "import fs from 'node:fs'; import { VisibleFirstAuditSchema, assertVisibleFirstAuditTrusted } from './test/e2e-browser/perf/audit-contract.ts'; const artifact = VisibleFirstAuditSchema.parse(JSON.parse(fs.readFileSync('artifacts/perf/visible-first-baseline.pre-cutover.json', 'utf8'))); assertVisibleFirstAuditTrusted(artifact);"
```

Expected: exit `0`.

If this fails, stop transport work and fix the audit harness first. A candidate artifact is meaningless without a trusted baseline.

### Task 1: Add The Machine-Enforced Audit Gate

**Files:**
- Create: `test/e2e-browser/perf/visible-first-audit-gate.ts`
- Create: `scripts/assert-visible-first-audit-gate.ts`
- Create: `test/unit/lib/visible-first-audit-gate.test.ts`
- Modify: `package.json`

**Step 1: Write the failing gate tests**

The tests must fail until all of these are true:

1. Both artifacts are validated with `assertVisibleFirstAuditTrusted(...)`.
2. Missing scenario/profile pairs fail.
3. Positive `mobile_restricted.focusedReadyMs` deltas fail.
4. Positive `mobile_restricted.terminalInputToFirstOutputMs` deltas fail for the two terminal scenarios.
5. Positive offscreen-before-ready deltas fail for either profile.
6. The CLI prints JSON only and exits non-zero on violations.

**Step 2: Run the gate lane**

```bash
NODE_ENV=test npx vitest run test/unit/lib/visible-first-audit-gate.test.ts
```

Expected: FAIL because the helper and CLI do not exist yet.

**Step 3: Implement the helper and CLI**

Use this result shape exactly:

```ts
export type VisibleFirstAuditGateResult = {
  ok: boolean
  violations: Array<{
    scenarioId: string
    profileId: string
    metric:
      | 'focusedReadyMs'
      | 'terminalInputToFirstOutputMs'
      | 'offscreenHttpRequestsBeforeReady'
      | 'offscreenHttpBytesBeforeReady'
      | 'offscreenWsFramesBeforeReady'
      | 'offscreenWsBytesBeforeReady'
    base: number
    candidate: number
    delta: number
  }>
}
```

Add this script:

```json
"perf:audit:gate": "tsx scripts/assert-visible-first-audit-gate.ts"
```

**Step 4: Re-run the gate lane**

```bash
NODE_ENV=test npx vitest run test/unit/lib/visible-first-audit-gate.test.ts
```

Expected: PASS.

**Step 5: Smoke the CLI against the same trusted artifact**

```bash
npm run perf:audit:gate -- --base artifacts/perf/visible-first-baseline.pre-cutover.json --candidate artifacts/perf/visible-first-baseline.pre-cutover.json
```

Expected: JSON only, exit `0`, and `"ok": true`.

**Step 6: Commit**

```bash
git add test/e2e-browser/perf/visible-first-audit-gate.ts scripts/assert-visible-first-audit-gate.ts test/unit/lib/visible-first-audit-gate.test.ts package.json
git commit -m "test(perf): add visible-first audit landing gate"
```

### Task 2: Remove Legacy Capability Negotiation And Invalid Client Commands

**Files:**
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/lib/ws-client.ts`

**Step 1: Write the failing protocol tests**

The tests must fail until all of these are true:

1. `hello.capabilities` does not advertise `sessionsPatchV1` or `sessionsPaginationV1`.
2. Client messages `sessions.fetch`, `terminal.list`, and `terminal.meta.list` are rejected.
3. The shared server-message union no longer includes the removed legacy types.
4. The client types no longer expose the removed legacy types.

**Step 2: Run the protocol lane**

```bash
npm run test:server:standard -- test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client.test.ts
```

Expected: FAIL against the current hybrid protocol.

**Step 3: Implement the minimal protocol cutover**

Keep the handshake capabilities narrow:

```ts
type HelloCapabilities = {
  uiScreenshotV1?: boolean
}
```

Delete these protocol entries from the shared unions and validators:

1. `sessions.fetch`
2. `terminal.list`
3. `terminal.list.response`
4. `terminal.meta.list`
5. `terminal.meta.list.response`
6. `sessionsPatchV1`
7. `sessionsPaginationV1`

**Step 4: Re-run the protocol lane**

```bash
npm run test:server:standard -- test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts test/unit/client/lib/ws-client.test.ts shared/ws-protocol.ts server/ws-handler.ts src/lib/ws-client.ts
git commit -m "refactor(protocol): remove legacy websocket capabilities"
```

### Task 3: Delete Legacy Bulk WebSocket Delivery Paths

**Files:**
- Modify: `test/server/ws-sidebar-snapshot-refresh.test.ts`
- Modify: `test/server/ws-terminal-meta.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
- Modify: `test/unit/client/ws-client-sdk.test.ts`
- Delete: `test/unit/server/ws-chunking.test.ts`
- Delete: `test/server/ws-sessions-patch.test.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/session-history-loader.ts`
- Modify: `server/sessions-sync/service.ts`
- Delete: `server/ws-chunking.ts`

**Step 1: Write the failing deletion tests**

The tests must fail until all of these are true:

1. Successful transcripts never emit `sessions.updated`, `sessions.page`, `sessions.patch`, `sdk.history`, `terminal.list.updated`, or `terminal.meta.list.response`.
2. Session invalidation is revision-only.
3. SDK attach/create relies on `sdk.session.snapshot` plus live deltas, never replay arrays.
4. Chunking-specific tests are deleted instead of preserved as compatibility debt.

**Step 2: Run the deletion lane**

```bash
npm run test:server:standard -- test/server/ws-sidebar-snapshot-refresh.test.ts test/server/ws-terminal-meta.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/server/ws-handler-sdk.test.ts
NODE_ENV=test npx vitest run test/unit/client/ws-client-sdk.test.ts
```

Expected: FAIL because the hybrid handler still has legacy branches.

**Step 3: Implement the minimal deletion**

After this task, the surviving invalidation and runtime messages must look like this:

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
```

Delete the matching dead branches from `server/ws-handler.ts`, remove `sdk.history` replay shaping from `server/session-history-loader.ts`, and remove patch-broadcast logic from `server/sessions-sync/service.ts`.

**Step 4: Re-run the deletion lane**

```bash
npm run test:server:standard -- test/server/ws-sidebar-snapshot-refresh.test.ts test/server/ws-terminal-meta.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/server/ws-handler-sdk.test.ts
NODE_ENV=test npx vitest run test/unit/client/ws-client-sdk.test.ts
```

Expected: PASS.

**Step 5: Prove the legacy strings are gone from production code**

```bash
rg -n "sessions\\.updated|sessions\\.page|sessions\\.patch|sessions\\.fetch|sdk\\.history|terminal\\.list(\\.updated|\\.response)?|terminal\\.meta\\.list(\\.response)?" shared server src
```

Expected: no matches.

**Step 6: Commit**

```bash
git add test/server/ws-sidebar-snapshot-refresh.test.ts test/server/ws-terminal-meta.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/client/ws-client-sdk.test.ts server/ws-handler.ts server/session-history-loader.ts server/sessions-sync/service.ts
git rm test/unit/server/ws-chunking.test.ts test/server/ws-sessions-patch.test.ts server/ws-chunking.ts
git commit -m "feat(protocol): delete legacy bulk websocket delivery"
```

### Task 4: Make Session Directory The Only Read-Model Authority

**Files:**
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/unit/server/session-directory/service.test.ts`
- Modify: `test/unit/cli/http.test.ts`
- Modify: `test/unit/cli/commands.test.ts`
- Modify: `test/unit/client/lib/api.test.ts`
- Delete: `test/integration/session-search-e2e.test.ts`
- Modify: `server/index.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/session-pagination.ts`
- Modify: `server/session-directory/service.ts`
- Modify: `server/session-directory/types.ts`
- Modify: `server/cli/index.ts`
- Modify: `src/lib/api.ts`
- Delete: `server/routes/sessions.ts`

**Step 1: Write the failing directory tests**

The tests must fail until all of these are true:

1. `GET /api/session-directory` is the only list/search read-model contract.
2. CLI list/search commands do not call `/api/sessions`, `/api/sessions/search`, or `/api/sessions/query`.
3. Shared client API helpers no longer export the removed read-model routes.
4. The mutation route `/api/sessions/:sessionId` remains for rename/archive/delete and is not treated as a list authority.

**Step 2: Run the session-directory lane**

```bash
npm run test:server:standard -- test/integration/server/session-directory-router.test.ts
NODE_ENV=test npx vitest run test/unit/server/session-directory/service.test.ts test/unit/cli/http.test.ts test/unit/cli/commands.test.ts test/unit/client/lib/api.test.ts
```

Expected: FAIL because the old routes and helpers still exist.

**Step 3: Implement the minimal server and API cutover**

Shape the shared query model around the surviving endpoint family:

```ts
type SessionDirectoryQuery = {
  q?: string
  cursor?: string
  limit?: number
  priority?: 'visible' | 'background'
}
```

Delete `/api/sessions/search` and `/api/sessions/query` as runtime read paths. Keep `/api/sessions/:sessionId` for mutations only.

**Step 4: Re-run the session-directory lane**

```bash
npm run test:server:standard -- test/integration/server/session-directory-router.test.ts
NODE_ENV=test npx vitest run test/unit/server/session-directory/service.test.ts test/unit/cli/http.test.ts test/unit/cli/commands.test.ts test/unit/client/lib/api.test.ts
```

Expected: PASS.

**Step 5: Prove the shadow read-model routes are gone**

```bash
rg -n "/api/sessions/search|/api/sessions/query" server src
```

Expected: no matches.

**Step 6: Commit**

```bash
git add test/integration/server/session-directory-router.test.ts test/unit/server/session-directory/service.test.ts test/unit/cli/http.test.ts test/unit/cli/commands.test.ts test/unit/client/lib/api.test.ts server/index.ts server/sessions-router.ts server/session-pagination.ts server/session-directory/service.ts server/session-directory/types.ts server/cli/index.ts src/lib/api.ts
git rm test/integration/session-search-e2e.test.ts server/routes/sessions.ts
git commit -m "feat(session-directory): make server directory routes authoritative"
```

### Task 5: Make `/api/bootstrap` Shell-Only And `App.tsx` The Sole WebSocket Owner

**Files:**
- Modify: `test/integration/server/bootstrap-router.test.ts`
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/unit/client/components/App.ws-extensions.test.tsx`
- Modify: `test/unit/client/components/App.perf-audit-bootstrap.test.tsx`
- Modify: `test/unit/client/components/App.lazy-views.test.tsx`
- Modify: `test/unit/client/components/App.mobile.test.tsx`
- Modify: `test/unit/client/components/App.mobile-landscape.test.tsx`
- Modify: `test/unit/client/components/App.swipe-sidebar.test.tsx`
- Modify: `test/unit/client/components/App.swipe-tabs.test.tsx`
- Modify: `test/unit/client/components/App.sidebar-resize.test.tsx`
- Modify: `test/e2e/auth-required-bootstrap-flow.test.tsx`
- Modify: `test/e2e/mobile-sidebar-fullwidth-flow.test.tsx`
- Modify: `test/e2e/terminal-font-settings.test.tsx`
- Modify: `server/index.ts`
- Modify: `server/shell-bootstrap-router.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/SessionView.tsx`
- Modify: `src/lib/ws-client.ts`

**Step 1: Write the failing bootstrap tests**

The tests must fail until all of these are true:

1. `/api/bootstrap` returns shell-only first-paint data.
2. Focused-pane HTTP hydration can begin before WebSocket `ready`.
3. `/api/version` and network diagnostics are background work.
4. `src/App.tsx` is the only caller of `ws.connect()`.
5. `src/components/SessionView.tsx` no longer calls `ws.connect()`.

**Step 2: Run the bootstrap lane**

```bash
npm run test:server:standard -- test/integration/server/bootstrap-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: FAIL because legacy startup choreography still survives.

**Step 3: Implement the minimal bootstrap cutover**

Keep the bootstrap payload shell-only:

```ts
type BootstrapPayload = {
  settings: unknown
  platform: unknown
  auth: { required: boolean }
  features?: Record<string, boolean>
}
```

Do not embed session-directory windows, agent timelines, terminal viewports, version checks, or network diagnostics in `/api/bootstrap`.

**Step 4: Re-run the bootstrap lane**

```bash
npm run test:server:standard -- test/integration/server/bootstrap-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: PASS.

**Step 5: Prove `App.tsx` is the only WebSocket owner**

```bash
rg -n "ws\\.connect\\(" src
```

Expected: only `src/App.tsx`.

**Step 6: Commit**

```bash
git add test/integration/server/bootstrap-router.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/e2e/terminal-font-settings.test.tsx server/index.ts server/shell-bootstrap-router.ts src/App.tsx src/components/SessionView.tsx src/lib/ws-client.ts
git commit -m "refactor(app): make bootstrap shell-only and centralize websocket ownership"
```

### Task 6: Move Session Hydration And Mutation Refresh Into Store-Owned Visible Windows

**Files:**
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/Sidebar.mobile.test.tsx`
- Modify: `test/unit/client/components/BackgroundSessions.test.tsx`
- Modify: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Modify: `test/unit/client/components/HistoryView.a11y.test.tsx`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/OverviewView.tsx`
- Modify: `src/components/BackgroundSessions.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/sessionsThunks.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`

**Step 1: Write the failing visibility-window tests**

The tests must fail until all of these are true:

1. Sidebar and background surfaces fetch session-directory windows only when visible.
2. Search and load-more are thunk-owned window operations, not leaf-owned transport choreography.
3. Rename, archive, and delete refresh only the active window.
4. Leaf components stop treating `/api/sessions*` as list authorities.

**Step 2: Run the session-visibility lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: FAIL because visible-window ownership is still spread across components.

**Step 3: Implement the minimal store-owned window model**

The component-level intent should collapse to calls like:

```ts
dispatch(requestSessionDirectoryWindow({
  surface: 'sidebar',
  visibility: 'visible',
  query,
  cursor
}))
```

Leaf components may dispatch intents. They may not own fetch cancellation policy, route construction, or invalidation sequencing.

**Step 4: Re-run the session-visibility lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx src/components/Sidebar.tsx src/components/OverviewView.tsx src/components/BackgroundSessions.tsx src/components/HistoryView.tsx src/components/context-menu/ContextMenuProvider.tsx src/store/sessionsSlice.ts src/store/sessionsThunks.ts src/store/selectors/sidebarSelectors.ts
git commit -m "refactor(session-ui): hydrate only visible directory windows"
```

### Task 7: Make Agent Timeline And Turn Bodies Server-Owned

**Files:**
- Modify: `test/integration/server/agent-timeline-router.test.ts`
- Modify: `test/unit/server/agent-timeline/service.test.ts`
- Modify: `server/index.ts`
- Modify: `server/agent-timeline/router.ts`
- Modify: `server/agent-timeline/service.ts`
- Modify: `server/agent-timeline/types.ts`

**Step 1: Write the failing agent-timeline tests**

The tests must fail until all of these are true:

1. Timeline pages are recent-first and cursorable.
2. Turn bodies are hydrated only on demand.
3. The server route shape is sufficient for client restore without replay arrays.

**Step 2: Run the agent-timeline server lane**

```bash
npm run test:server:standard -- test/integration/server/agent-timeline-router.test.ts
NODE_ENV=test npx vitest run test/unit/server/agent-timeline/service.test.ts
```

Expected: FAIL until the service and router fully own the read model.

**Step 3: Implement the minimal timeline contract**

Keep the route family explicit:

```ts
GET /api/agent-sessions/:sessionId/timeline
GET /api/agent-sessions/:sessionId/turns/:turnId
```

The timeline returns summaries and cursors. The turn-body route returns full body content only when requested.

**Step 4: Re-run the agent-timeline server lane**

```bash
npm run test:server:standard -- test/integration/server/agent-timeline-router.test.ts
NODE_ENV=test npx vitest run test/unit/server/agent-timeline/service.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/integration/server/agent-timeline-router.test.ts test/unit/server/agent-timeline/service.test.ts server/index.ts server/agent-timeline/router.ts server/agent-timeline/service.ts server/agent-timeline/types.ts
git commit -m "feat(agent-timeline): serve recent-first timeline windows and turn bodies"
```

### Task 8: Restore Agent Chat From Snapshot Plus Visible Timeline Windows

**Files:**
- Modify: `test/unit/client/agentChatSlice.test.ts`
- Modify: `test/unit/client/store/agentChatThunks.test.ts`
- Modify: `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/store/agentChatThunks.ts`
- Modify: `src/lib/sdk-message-handler.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/agent-chat/CollapsedTurn.tsx`
- Modify: `src/components/TabContent.tsx`
- Modify: `server/ws-handler.ts`

**Step 1: Write the failing agent-chat client tests**

The tests must fail until all of these are true:

1. `sdk.session.snapshot` plus HTTP timeline pages is enough to restore reloads and split-pane remounts.
2. Hidden panes do not prefetch timeline pages.
3. Expanding older turns fetches bodies on demand.
4. Session switches abort stale requests.

**Step 2: Run the agent-chat lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: FAIL because client state still assumes replay-oriented recovery in some paths.

**Step 3: Implement the minimal snapshot-plus-window client model**

Keep the attach snapshot small and structural:

```ts
type SdkSessionSnapshotMessage = {
  type: 'sdk.session.snapshot'
  sessionId: string
  latestTurnId: string | null
  status: string
}
```

Store turn summaries separately from hydrated turn bodies. Hidden panes stay idle until selected.

**Step 4: Re-run the agent-chat lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/store/agentChatThunks.ts src/lib/sdk-message-handler.ts src/components/agent-chat/AgentChatView.tsx src/components/agent-chat/CollapsedTurn.tsx src/components/TabContent.tsx server/ws-handler.ts
git commit -m "feat(agent-chat): restore from snapshots and visible timeline windows"
```

### Task 9: Make Terminal Routes, Viewports, And Runtime Invalidations Authoritative

**Files:**
- Modify: `test/integration/server/terminal-view-router.test.ts`
- Modify: `test/server/terminals-api.test.ts`
- Modify: `test/server/ws-terminal-meta.test.ts`
- Modify: `test/server/ws-terminal-create-session-repair.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Modify: `server/index.ts`
- Modify: `server/terminals-router.ts`
- Modify: `server/terminal-view/service.ts`
- Modify: `server/terminal-stream/broker.ts`
- Delete: `server/routes/terminals.ts`

**Step 1: Write the failing terminal-server tests**

The tests must fail until all of these are true:

1. `GET /api/terminals` is the terminal-directory authority.
2. `GET /api/terminals/:terminalId/viewport` returns the runtime metadata needed for pane chrome.
3. Directory invalidation uses `terminals.changed`.
4. Visible-pane runtime changes use `terminal.runtime.updated`.
5. No path emits `terminal.list.updated` or relies on a global terminal-meta snapshot.

**Step 2: Run the terminal-server lane**

```bash
npm run test:server:standard -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts test/server/ws-terminal-meta.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts
```

Expected: FAIL until the terminal route family and invalidation model are fully cut over.

**Step 3: Implement the minimal authoritative terminal contract**

Use this viewport shape:

```ts
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

Keep directory, viewport, scrollback, and search as separate routes. Remove `server/routes/terminals.ts` instead of keeping duplicate routing.

**Step 4: Re-run the terminal-server lane**

```bash
npm run test:server:standard -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts test/server/ws-terminal-meta.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts test/server/ws-terminal-meta.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts server/index.ts server/terminals-router.ts server/terminal-view/service.ts server/terminal-stream/broker.ts
git rm server/routes/terminals.ts
git commit -m "feat(terminal-server): serve authoritative viewport and directory read models"
```

### Task 10: Paint Terminals Viewport-First And Move Search To The Server

**Files:**
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/Sidebar.mobile.test.tsx`
- Modify: `test/unit/client/components/BackgroundSessions.test.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/unit/client/components/TerminalView.search.test.tsx`
- Modify: `test/unit/client/components/terminal/terminal-runtime.test.ts`
- Modify: `test/unit/client/store/terminalDirectorySlice.test.ts`
- Modify: `test/unit/client/store/terminalDirectoryThunks.test.ts`
- Modify: `test/unit/client/store/terminalMetaSlice.test.ts`
- Modify: `test/unit/client/components/component-edge-cases.test.tsx`
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`
- Modify: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/OverviewView.tsx`
- Modify: `src/components/BackgroundSessions.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/terminal/terminal-runtime.ts`
- Modify: `src/components/terminal/TerminalSearchBar.tsx`
- Modify: `src/lib/terminal-attach-seq-state.ts`
- Modify: `src/store/terminalDirectorySlice.ts`
- Modify: `src/store/terminalDirectoryThunks.ts`
- Modify: `src/store/terminalMetaSlice.ts`
- Modify: `src/store/store.ts`

**Step 1: Write the failing terminal-client tests**

The tests must fail until all of these are true:

1. The HTTP viewport paints before replay or WebSocket recovery.
2. Reconnect uses `sinceSeq = tailSeq`.
3. Terminal search uses server routes and does not depend on `SearchAddon`.
4. Hidden or offscreen terminal panes do not pre-create or pre-attach.
5. Runtime metadata comes from the viewport snapshot and `terminal.runtime.updated`.

**Step 2: Run the terminal-client lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: FAIL because replay-first or client-search behavior still survives.

**Step 3: Implement the minimal viewport-first client path**

The restore order is fixed:

1. fetch viewport
2. paint viewport
3. attach with `sinceSeq = tailSeq`
4. apply only the short missed tail

Delete `SearchAddon` usage from `src/components/terminal/terminal-runtime.ts` and route search through the server.

**Step 4: Re-run the terminal-client lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: PASS.

**Step 5: Prove the dead terminal transport strings are gone**

```bash
rg -n "SearchAddon|terminal\\.meta\\.list|terminal\\.list\\.updated" src server
```

Expected: no matches.

**Step 6: Commit**

```bash
git add test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx src/App.tsx src/components/Sidebar.tsx src/components/OverviewView.tsx src/components/BackgroundSessions.tsx src/components/TerminalView.tsx src/components/terminal/terminal-runtime.ts src/components/terminal/TerminalSearchBar.tsx src/lib/terminal-attach-seq-state.ts src/store/terminalDirectorySlice.ts src/store/terminalDirectoryThunks.ts src/store/terminalMetaSlice.ts src/store/store.ts
git commit -m "feat(terminal-client): paint viewport first and search server-side"
```

### Task 11: Make Read-Model Lane Ordering And Abort Propagation Authoritative

**Files:**
- Modify: `test/unit/server/read-models/work-scheduler.test.ts`
- Modify: `test/integration/server/bootstrap-router.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/integration/server/terminal-view-router.test.ts`
- Modify: `shared/read-models.ts`
- Modify: `server/read-models/work-scheduler.ts`
- Modify: `server/shell-bootstrap-router.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/agent-timeline/router.ts`
- Modify: `server/terminals-router.ts`

**Step 1: Write the failing scheduler tests**

The tests must fail until all of these are true:

1. `critical` outranks `visible`.
2. `visible` outranks `background`.
3. Background work is concurrency-bounded.
4. Abort from the owning HTTP request cancels queued or running background work cleanly.

**Step 2: Run the scheduler lane**

```bash
npm run test:server:standard -- test/unit/server/read-models/work-scheduler.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts
```

Expected: FAIL until lane ordering is real and shared.

**Step 3: Implement the minimal shared lane model**

Use one shared lane definition:

```ts
export const READ_MODEL_LANES = ['critical', 'visible', 'background'] as const

export const READ_MODEL_LANE_PRIORITY = {
  critical: 0,
  visible: 1,
  background: 2,
} as const
```

Do not create a second scheduler. Finish the existing `server/read-models/work-scheduler.ts` seam and wire every read-model route to it.

**Step 4: Re-run the scheduler lane**

```bash
npm run test:server:standard -- test/unit/server/read-models/work-scheduler.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/server/read-models/work-scheduler.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts shared/read-models.ts server/read-models/work-scheduler.ts server/shell-bootstrap-router.ts server/sessions-router.ts server/agent-timeline/router.ts server/terminals-router.ts
git commit -m "feat(scheduler): enforce critical visible background lane ordering"
```

### Task 12: Enforce Payload Budgets, Queue Bounds, And Audit-Facing Instrumentation

**Files:**
- Modify: `test/unit/server/request-logger.test.ts`
- Modify: `test/unit/server/perf-logger.test.ts`
- Modify: `test/unit/server/terminal-stream/client-output-queue.test.ts`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`
- Modify: `test/unit/client/lib/perf-logger.test.ts`
- Modify: `test/integration/server/bootstrap-router.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/integration/server/terminal-view-router.test.ts`
- Modify: `server/request-logger.ts`
- Modify: `server/perf-logger.ts`
- Modify: `server/terminal-stream/client-output-queue.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/shell-bootstrap-router.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/terminals-router.ts`
- Modify: `src/lib/perf-logger.ts`

**Step 1: Write the failing budget and instrumentation tests**

The tests must fail until all of these are true:

1. Bootstrap payload stays under `12 * 1024` bytes.
2. Realtime frames stay under `16 * 1024` bytes or degrade to gap/invalidation behavior.
3. Queue overflow does not produce unbounded buffering.
4. Request and perf logging capture lane, payload bytes, duration, queue depth, and dropped bytes where applicable.
5. Terminal input/output still outranks background read-model work under pressure.

**Step 2: Run the budget lane**

```bash
npm run test:server:standard -- test/unit/server/request-logger.test.ts test/unit/server/perf-logger.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/perf-logger.test.ts
```

Expected: FAIL until the real seams enforce the budgets.

**Step 3: Implement the minimal shared budgets and instrumentation**

Use these constants:

```ts
export const MAX_REALTIME_MESSAGE_BYTES = 16 * 1024
export const MAX_BOOTSTRAP_PAYLOAD_BYTES = 12 * 1024
export const MAX_DIRECTORY_PAGE_ITEMS = 50
export const MAX_AGENT_TIMELINE_ITEMS = 30
export const MAX_TERMINAL_SCROLLBACK_PAGE_BYTES = 64 * 1024
```

Overflow must degrade through explicit gap or invalidation behavior, never unbounded buffering. Reuse the existing request and perf logger seams; do not create a parallel telemetry path.

**Step 4: Re-run the budget lane**

```bash
npm run test:server:standard -- test/unit/server/request-logger.test.ts test/unit/server/perf-logger.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/perf-logger.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/server/request-logger.test.ts test/unit/server/perf-logger.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/client/lib/perf-logger.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts server/request-logger.ts server/perf-logger.ts server/terminal-stream/client-output-queue.ts server/ws-handler.ts server/shell-bootstrap-router.ts server/sessions-router.ts server/terminals-router.ts src/lib/perf-logger.ts
git commit -m "feat(transport): enforce payload budgets and audit instrumentation"
```

### Task 13: Run The Full Gate And Keep Fixing Until It Passes

**Files:**
- No planned source edits.
- Generated, uncommitted artifacts:
  - `artifacts/perf/visible-first-baseline.pre-cutover.json`
  - `artifacts/perf/visible-first-candidate.post-cutover.json`
  - `artifacts/perf/visible-first-diff.post-cutover.json`
  - `artifacts/perf/visible-first-gate.post-cutover.json`

**Step 1: Re-prove the static invariants**

```bash
rg -n "sessions\\.updated|sessions\\.page|sessions\\.patch|sessions\\.fetch|sdk\\.history|terminal\\.list(\\.updated|\\.response)?|terminal\\.meta\\.list(\\.response)?|sessionsPatchV1|sessionsPaginationV1" shared server src
rg -n "/api/sessions/search|/api/sessions/query" server src
rg -n "ws\\.connect\\(" src
```

Expected:

1. first command: no matches
2. second command: no matches
3. third command: only `src/App.tsx`

**Step 2: Run the full quality suite**

```bash
npm run lint
npm test
npm run verify
```

Expected: all PASS.

If any command fails, fix the narrowest real defect, add the missing regression if needed, commit the fix, and rerun Step 2.

**Step 3: Capture and validate the post-cutover candidate artifact**

```bash
npm run perf:audit:visible-first -- --output artifacts/perf/visible-first-candidate.post-cutover.json
npx tsx --eval "import fs from 'node:fs'; import { VisibleFirstAuditSchema, assertVisibleFirstAuditTrusted } from './test/e2e-browser/perf/audit-contract.ts'; const artifact = VisibleFirstAuditSchema.parse(JSON.parse(fs.readFileSync('artifacts/perf/visible-first-candidate.post-cutover.json', 'utf8'))); assertVisibleFirstAuditTrusted(artifact);"
```

Expected: both commands exit `0`.

If this fails, fix the audit trust defect and rerun Step 3.

**Step 4: Produce the diff and run the machine gate**

```bash
npm run perf:audit:compare -- --base artifacts/perf/visible-first-baseline.pre-cutover.json --candidate artifacts/perf/visible-first-candidate.post-cutover.json > artifacts/perf/visible-first-diff.post-cutover.json
npm run perf:audit:gate -- --base artifacts/perf/visible-first-baseline.pre-cutover.json --candidate artifacts/perf/visible-first-candidate.post-cutover.json > artifacts/perf/visible-first-gate.post-cutover.json
```

Expected:

1. both commands exit `0`
2. `artifacts/perf/visible-first-gate.post-cutover.json` reports `"ok": true`

If the gate fails, go back to the narrowest failing seam, add or tighten the missing regression test, fix the product, commit the fix, and rerun Task 13 from Step 1. Do not stop at the first bad comparison.

**Step 5: Confirm audit artifacts stay uncommitted**

```bash
git status --short
```

Expected: source changes only if Step 2 through Step 4 required a real fix; `artifacts/perf/*.json` remain untracked or ignored, never staged.

## Final Verification Checklist

- [ ] trusted pre-cutover baseline artifact exists
- [ ] trusted post-cutover candidate artifact exists
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run verify` passes
- [ ] production grep finds no legacy bulk WebSocket strings
- [ ] production grep finds no `/api/sessions/search` or `/api/sessions/query`
- [ ] only `src/App.tsx` calls `ws.connect()`
- [ ] bootstrap payload stays under `12 * 1024` bytes
- [ ] scheduler tests prove `critical > visible > background`
- [ ] background work is abortable and concurrency-bounded
- [ ] realtime queue overflow degrades by gap or invalidation instead of unbounded buffering
- [ ] request and perf logs expose lane, payload bytes, duration, queue depth, and dropped bytes where applicable
- [ ] diff JSON exists
- [ ] gate JSON exists
- [ ] gate JSON reports `"ok": true`
- [ ] no `mobile_restricted.focusedReadyMs` regression remains
- [ ] no terminal input-to-first-output regression remains in the two terminal scenarios
- [ ] no offscreen-before-ready regression remains in either profile
- [ ] no generated audit artifact is committed

## Notes For The Executor

1. Prefer deletion over compatibility shims. The previous regression happened because both the new and old transport paths were active.
2. Finish existing seams instead of creating parallel route stacks, schedulers, or telemetry channels.
3. When a test encodes legacy behavior that should not survive, rewrite or delete it in the same task that removes the runtime path.
4. Do not create “temporary” fallbacks for offscreen hydration, terminal metadata snapshots, or bulk session payloads.
5. Do not create no-op commits. Commit only green states with real code or test changes.

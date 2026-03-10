# Visible-First Prioritized Transport Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Land the accepted visible-first prioritized transport spec directly, enforce the quality gates that were previously skipped or softened, and only finish when the post-cutover audit is trusted and shows no `mobile_restricted` regression.

**Architecture:** Keep the accepted hard-cut destination: server-owned visible/read-model transport over HTTP, with WebSocket v4 reserved for live control, invalidation, and targeted deltas. Build or tighten the new HTTP-owned consumers first, switch every client surface to them, then delete the legacy websocket bulk transport in one explicit cleanup pass so the branch never lands hybrid again.

**Tech Stack:** Node.js, Express, `ws`, React 18, Redux Toolkit, TypeScript, Zod, Vitest, Playwright/Chromium audit harness, `tsx`

---

## Why This Revision Exists

The previous completion plan was strong on destination, but it was still not excellent for execution:

1. It deleted legacy websocket delivery too early, before every new HTTP-owned consumer was fully switched. That is the same sequencing class that previously produced a hybrid landing and mobile regressions.
2. Several tasks were still too coarse for trycycle. They bundled protocol, server, client, and cleanup work into one commit-sized step instead of a single seam.
3. It still treated a few now-missing test files as if they already existed, which is not execution-safe.
4. It did not fully adapt to the current worktree state, where parts of the visible-first transport already exist and now need tightening, cutover, or deletion of old peers rather than greenfield creation.
5. It did not isolate the final hard-delete of legacy websocket bulk transport into a dedicated, machine-checkable cleanup phase.
6. It still skipped the shared harness-first TDD foundation required by the accepted transport test plan, even though those harnesses do not already exist in this repo.

This revision keeps the accepted architecture and machine gate, but changes the execution shape:

1. Build the shared visible-first test harnesses first so the high-value scenario and integration tests can actually be written before product code.
2. Build or tighten the new authoritative HTTP and store-owned seams first.
3. Switch the client surfaces to the new seams while the old paths still exist temporarily inside the branch.
4. Delete the legacy websocket transport only after every visible consumer has been moved.
5. End with a full quality gate plus trusted pre/post audit comparison, with `mobile_restricted` as the decision rule.

## Source Of Truth

Treat these four documents as the authoritative spec set, in this order:

1. `docs/plans/2026-03-09-visible-first-prioritized-transport.md`
2. `docs/plans/2026-03-09-visible-first-prioritized-transport-test-plan.md`
3. `docs/plans/2026-03-10-visible-first-performance-audit.md`
4. `docs/plans/2026-03-10-visible-first-performance-audit-test-plan.md`

## Strategy Gate

The problem to solve is not "trim a few large payloads." The problem is "finish the server-authoritative visible-first transport, prove it, and delete the hybrid architecture."

Non-negotiable direction:

1. Do not preserve compatibility shims for legacy bulk websocket session, SDK, or terminal snapshot delivery at landing.
2. Do not narrow the audit matrix. Keep all six scenarios across `desktop_local` and `mobile_restricted`.
3. `mobile_restricted` is the user’s decision rule. A mobile regression is a failed landing even if desktop improves.
4. `src/App.tsx` is the only websocket owner.
5. Hidden panes and offscreen tabs do not prehydrate. Visibility or explicit selection is the trigger.
6. The server owns search, pagination, timeline shaping, terminal viewport serialization, scheduler lanes, payload budgets, and transport instrumentation.
7. The client owns visibility, selection, optimistic UI, and tiny client-only adornment based on browser-local state.
8. Temporary coexistence inside the branch is acceptable only while new consumers are being switched. The final cleanup tasks must remove the old transport entirely.

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
10. No production code imports or instantiates `SearchAddon`.
11. Only `src/App.tsx` calls `ws.connect()`.

## Execution Rules

1. Every task follows this order:
   - write failing tests
   - run the narrow lane and watch it fail
   - write the minimal implementation
   - rerun the same lane and make it pass
   - run any listed grep or smoke proof for that seam
   - commit a green state
2. Every task ends green on its named lane. Do not commit red states.
3. Work from the current worktree state. If a listed seam already partially exists, tighten or replace it instead of re-creating it.
4. If a listed test file does not exist yet, create it in the task that needs it. Do not silently swap to a different file without updating the plan.
5. Finish existing seams instead of creating parallel route stacks, schedulers, or telemetry channels.
6. If a later full-suite run fails, fix the narrowest real defect, add the missing regression if needed, commit the fix, and restart the full gate.
7. Generated audit artifacts under `artifacts/perf/` are never committed.
8. All later scenario and integration tests must reuse the shared harness modules from Task 1. Do not create ad hoc websocket stubs, route fixtures, scheduler fakes, or app boot shims once the shared harness exists.

## Files That Matter

Shared contracts:

- `shared/read-models.ts`
- `shared/ws-protocol.ts`

Shared visible-first test harnesses:

- `test/helpers/visible-first/protocol-harness.ts`
- `test/helpers/visible-first/read-model-route-harness.ts`
- `test/helpers/visible-first/app-hydration-harness.tsx`
- `test/helpers/visible-first/slow-network-controller.ts`
- `test/helpers/visible-first/terminal-mirror-fixture.ts`
- `test/helpers/visible-first/cli-command-harness.ts`
- `test/unit/visible-first/protocol-harness.test.ts`
- `test/unit/visible-first/read-model-route-harness.test.ts`
- `test/unit/visible-first/app-hydration-harness.test.tsx`
- `test/unit/visible-first/slow-network-controller.test.ts`
- `test/unit/visible-first/terminal-mirror-fixture.test.ts`
- `test/unit/visible-first/cli-command-harness.test.ts`

Server transport, read models, and instrumentation:

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
- `server/terminal-view/types.ts`
- `server/terminal-view/mirror.ts`
- `server/terminal-stream/broker.ts`
- `server/terminal-stream/replay-ring.ts`
- `server/terminal-stream/client-output-queue.ts`
- `server/read-models/work-scheduler.ts`
- `server/read-models/request-abort.ts`
- `server/request-logger.ts`
- `server/perf-logger.ts`
- `server/session-history-loader.ts`
- `server/sessions-sync/service.ts`
- `server/cli/index.ts`
- `server/routes/sessions.ts`
- `server/routes/terminals.ts`
- `server/ws-handler.ts`
- `server/ws-chunking.ts`

Client bootstrap, session, agent-chat, and terminal seams:

- `src/App.tsx`
- `src/lib/api.ts`
- `src/lib/ws-client.ts`
- `src/lib/sdk-message-handler.ts`
- `src/lib/terminal-attach-seq-state.ts`
- `src/lib/terminal-restore.ts`
- `src/lib/perf-logger.ts`
- `src/components/SessionView.tsx`
- `src/components/Sidebar.tsx`
- `src/components/OverviewView.tsx`
- `src/components/BackgroundSessions.tsx`
- `src/components/HistoryView.tsx`
- `src/components/TerminalView.tsx`
- `src/components/terminal/terminal-runtime.ts`
- `src/components/terminal/TerminalSearchBar.tsx`
- `src/components/context-menu/ContextMenuProvider.tsx`
- `src/components/agent-chat/AgentChatView.tsx`
- `src/components/agent-chat/CollapsedTurn.tsx`
- `src/components/TabContent.tsx`
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

Audit gate and comparison tooling:

- `test/e2e-browser/perf/audit-contract.ts`
- `test/e2e-browser/perf/run-visible-first-audit.ts`
- `test/e2e-browser/perf/run-sample.ts`
- `test/e2e-browser/perf/compare-visible-first-audits.ts`
- `test/e2e-browser/perf/visible-first-audit-gate.ts`
- `scripts/visible-first-audit.ts`
- `scripts/compare-visible-first-audit.ts`
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

If this fails, stop runtime work and fix the audit harness first. The final comparison is meaningless without a trusted baseline.

### Task 1: Build Shared Visible-First Test Harnesses

**Files:**
- Create: `test/helpers/visible-first/protocol-harness.ts`
- Create: `test/helpers/visible-first/read-model-route-harness.ts`
- Create: `test/helpers/visible-first/app-hydration-harness.tsx`
- Create: `test/helpers/visible-first/slow-network-controller.ts`
- Create: `test/helpers/visible-first/terminal-mirror-fixture.ts`
- Create: `test/helpers/visible-first/cli-command-harness.ts`
- Create: `test/unit/visible-first/protocol-harness.test.ts`
- Create: `test/unit/visible-first/read-model-route-harness.test.ts`
- Create: `test/unit/visible-first/app-hydration-harness.test.tsx`
- Create: `test/unit/visible-first/slow-network-controller.test.ts`
- Create: `test/unit/visible-first/terminal-mirror-fixture.test.ts`
- Create: `test/unit/visible-first/cli-command-harness.test.ts`

**Step 1: Write the failing harness contract tests**

Cover:

1. `ProtocolHarness` starts the real websocket handler with fake session and terminal publishers, captures the raw transcript, sends `hello`, and can assert that forbidden legacy message types were never emitted
2. `ReadModelRouteHarness` mounts auth plus the bootstrap, session-directory, agent-timeline, and terminal-view routers with fake services and records scheduler lane events, aborts, revisions, and response bytes
3. `AppHydrationHarness` renders `App.tsx` with a real Redux store, gated HTTP promises, seeded layout state, and a programmable websocket stub whose `ready` can be held independently from HTTP
4. `SlowNetworkController` can hold and release `critical`, `visible`, and `background` requests independently and delay websocket `ready` independently from HTTP
5. `TerminalMirrorFixture` can apply deterministic ANSI output, expose viewport serialization and `tailSeq`, answer scrollback and search queries, and simulate replay overflow
6. `CliCommandHarness` captures invoked URLs, stdout, stderr, JSON output, and exit code without needing a real external server

**Step 2: Run the harness lanes**

```bash
npm run test:server:standard -- test/unit/visible-first/protocol-harness.test.ts test/unit/visible-first/read-model-route-harness.test.ts test/unit/visible-first/terminal-mirror-fixture.test.ts test/unit/visible-first/cli-command-harness.test.ts
NODE_ENV=test npx vitest run test/unit/visible-first/app-hydration-harness.test.tsx test/unit/visible-first/slow-network-controller.test.ts
```

Expected: FAIL because the shared harness modules do not exist yet.

**Step 3: Implement the minimal shared harness foundation**

Keep the shared import surface explicit and stable:

```ts
import { createProtocolHarness } from '@test/helpers/visible-first/protocol-harness'
import { createReadModelRouteHarness } from '@test/helpers/visible-first/read-model-route-harness'
import { createAppHydrationHarness } from '@test/helpers/visible-first/app-hydration-harness'
import { createSlowNetworkController } from '@test/helpers/visible-first/slow-network-controller'
import { createTerminalMirrorFixture } from '@test/helpers/visible-first/terminal-mirror-fixture'
import { createCliCommandHarness } from '@test/helpers/visible-first/cli-command-harness'
```

These harnesses are the only approved foundation for the later scenario and integration tests in this plan. Extend them when a later seam needs more control; do not fork them into one-off local fixtures.

**Step 4: Re-run the harness lanes**

```bash
npm run test:server:standard -- test/unit/visible-first/protocol-harness.test.ts test/unit/visible-first/read-model-route-harness.test.ts test/unit/visible-first/terminal-mirror-fixture.test.ts test/unit/visible-first/cli-command-harness.test.ts
NODE_ENV=test npx vitest run test/unit/visible-first/app-hydration-harness.test.tsx test/unit/visible-first/slow-network-controller.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/helpers/visible-first/protocol-harness.ts test/helpers/visible-first/read-model-route-harness.ts test/helpers/visible-first/app-hydration-harness.tsx test/helpers/visible-first/slow-network-controller.ts test/helpers/visible-first/terminal-mirror-fixture.ts test/helpers/visible-first/cli-command-harness.ts test/unit/visible-first/protocol-harness.test.ts test/unit/visible-first/read-model-route-harness.test.ts test/unit/visible-first/app-hydration-harness.test.tsx test/unit/visible-first/slow-network-controller.test.ts test/unit/visible-first/terminal-mirror-fixture.test.ts test/unit/visible-first/cli-command-harness.test.ts
git commit -m "test(visible-first): add shared transport harness foundation"
```

### Task 2: Add The Machine-Enforced Audit Gate

**Files:**
- Create: `test/e2e-browser/perf/visible-first-audit-gate.ts`
- Create: `scripts/assert-visible-first-audit-gate.ts`
- Create: `test/unit/lib/visible-first-audit-gate.test.ts`
- Modify: `package.json`

**Step 1: Write the failing gate tests**

Cover:

1. both artifacts are validated with `assertVisibleFirstAuditTrusted(...)`
2. missing scenario/profile pairs fail
3. positive `mobile_restricted.focusedReadyMs` deltas fail
4. positive `mobile_restricted.terminalInputToFirstOutputMs` deltas fail for the two terminal scenarios
5. positive offscreen-before-ready deltas fail for either profile
6. the CLI prints JSON only and exits non-zero on violations

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

Add this script entry:

```json
"perf:audit:gate": "tsx scripts/assert-visible-first-audit-gate.ts"
```

**Step 4: Re-run the gate lane**

```bash
NODE_ENV=test npx vitest run test/unit/lib/visible-first-audit-gate.test.ts
```

Expected: PASS.

**Step 5: Smoke the CLI against the trusted baseline**

```bash
npm run perf:audit:gate -- --base artifacts/perf/visible-first-baseline.pre-cutover.json --candidate artifacts/perf/visible-first-baseline.pre-cutover.json
```

Expected: JSON only, exit `0`, and `"ok": true`.

**Step 6: Commit**

```bash
git add test/e2e-browser/perf/visible-first-audit-gate.ts scripts/assert-visible-first-audit-gate.ts test/unit/lib/visible-first-audit-gate.test.ts package.json
git commit -m "test(perf): add visible-first audit landing gate"
```

### Task 3: Tighten Shared Read-Model Contracts And API Helpers

**Files:**
- Modify: `test/unit/client/lib/api.test.ts`
- Modify: `shared/read-models.ts`
- Modify: `src/lib/api.ts`

**Step 1: Write the failing API contract tests**

Cover:

1. `getBootstrap`, `getSessionDirectoryPage`, `getTerminalDirectoryPage`, `getAgentTimelinePage`, `getAgentTurnBody`, `getTerminalViewport`, `getTerminalScrollbackPage`, and `searchTerminalView` target only the new route family
2. each helper forwards `AbortSignal`
3. session and terminal directory query helpers encode `cursor`, `revision`, `limit`, and `priority` consistently
4. the old snapshot helper surface is not required by visible-first read paths

**Step 2: Run the API lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/lib/api.test.ts
```

Expected: FAIL until the helper surface is aligned to the accepted contracts.

**Step 3: Implement the minimal contract tightening**

Keep `critical` as a server scheduler lane, not a client query value. The public directory queries stay:

```ts
export const SessionDirectoryQuerySchema = z.object({
  query: z.string().optional(),
  cursor: z.string().min(1).optional(),
  priority: z.enum(['visible', 'background']),
  revision: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(50).optional(),
})
```

Apply the same rule to `TerminalDirectoryQuerySchema`, and ensure every helper accepts `options?: { signal?: AbortSignal }`.

**Step 4: Re-run the API lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/lib/api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/client/lib/api.test.ts shared/read-models.ts src/lib/api.ts
git commit -m "refactor(api): tighten visible-first read-model contracts"
```

### Task 4: Make `/api/bootstrap` Shell-Only And Budgeted

**Files:**
- Modify: `test/integration/server/bootstrap-router.test.ts`
- Modify: `server/index.ts`
- Modify: `server/shell-bootstrap-router.ts`
- Modify: `shared/read-models.ts`

**Step 1: Write the failing bootstrap route tests**

Cover:

1. `GET /api/bootstrap` returns only shell-critical first-paint data
2. it excludes session-directory rows, agent timelines, terminal viewports, terminal directories, version checks, and network diagnostics
3. the payload remains under `12 * 1024` bytes
4. auth failures remain clean and do not leak protected data

**Step 2: Run the bootstrap server lane**

```bash
npm run test:server:standard -- test/integration/server/bootstrap-router.test.ts
```

Expected: FAIL until the route is shell-only and budgeted.

**Step 3: Implement the minimal bootstrap contract**

Keep the payload shape explicit:

```ts
type BootstrapPayload = {
  settings: unknown
  platform: unknown
  shell: { authenticated: boolean; ready?: boolean; tasks?: Record<string, boolean> }
  perf?: { logging: boolean }
  configFallback?: { reason: string; backupExists: boolean }
}
```

Do not include session-directory, timeline, terminal, version, or network payloads.

**Step 4: Re-run the bootstrap server lane**

```bash
npm run test:server:standard -- test/integration/server/bootstrap-router.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/integration/server/bootstrap-router.test.ts server/index.ts server/shell-bootstrap-router.ts shared/read-models.ts
git commit -m "feat(bootstrap): make shell bootstrap authoritative and bounded"
```

### Task 5: Make `App.tsx` The Sole WebSocket Owner And Start Focused Hydration Before `ready`

**Files:**
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
- Modify: `src/App.tsx`
- Modify: `src/components/SessionView.tsx`
- Modify: `src/lib/ws-client.ts`

**Step 1: Write the failing app bootstrap tests**

Cover:

1. `App.tsx` performs one shell bootstrap request before it seeds shell state
2. focused-pane HTTP hydration starts immediately after bootstrap and does not wait for websocket `ready`
3. `src/App.tsx` is the only caller of `ws.connect()`
4. `src/components/SessionView.tsx` no longer calls `ws.connect()`
5. `/api/version` and network diagnostics are background work
6. offscreen tabs remain idle at startup

**Step 2: Run the app bootstrap lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: FAIL until startup ownership and ordering are correct.

**Step 3: Implement the minimal bootstrap cutover**

The ordering must be:

```ts
const bootstrap = await getBootstrap()
dispatch(seedBootstrap(bootstrap))
dispatch(hydrateFocusedPaneFromLayout())
const wsReadyPromise = ws.connect()
dispatch(hydrateVisibleSurfacesFromLayout())
void hydrateBackgroundShellData()
await wsReadyPromise
```

Only `src/App.tsx` calls `ws.connect()`.

**Step 4: Re-run the app bootstrap lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: PASS.

**Step 5: Prove `App.tsx` is the only websocket owner**

```bash
rg -n "ws\\.connect\\(" src
```

Expected: only `src/App.tsx`.

**Step 6: Commit**

```bash
git add test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/e2e/terminal-font-settings.test.tsx src/App.tsx src/components/SessionView.tsx src/lib/ws-client.ts
git commit -m "refactor(app): centralize websocket ownership and focused bootstrap hydration"
```

### Task 6: Finish The Session Directory Query Service

**Files:**
- Modify: `test/unit/server/session-directory/service.test.ts`
- Modify: `server/session-directory/service.ts`
- Modify: `server/session-directory/types.ts`

**Step 1: Write the failing session-directory service tests**

Cover:

1. canonical server-owned ordering
2. server-side title and snippet search
3. bounded snippets and bounded page size
4. deterministic cursor rejection
5. joined running metadata needed by the visible directory window

**Step 2: Run the session-directory service lane**

```bash
npm run test:server:standard -- test/unit/server/session-directory/service.test.ts
```

Expected: FAIL until the service fully owns the query shape.

**Step 3: Implement the minimal service contract**

Keep the service boundary explicit:

```ts
type SessionDirectoryQuery = {
  query?: string
  cursor?: string
  limit?: number
  priority: 'visible' | 'background'
  revision?: number
}
```

The service returns only a window plus `nextCursor` and `revision`.

**Step 4: Re-run the session-directory service lane**

```bash
npm run test:server:standard -- test/unit/server/session-directory/service.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/server/session-directory/service.test.ts server/session-directory/service.ts server/session-directory/types.ts
git commit -m "feat(session-directory): finish authoritative query service"
```

### Task 7: Make `/api/session-directory` The Only Read-Model Authority

**Files:**
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/unit/server/sessions-router-pagination.test.ts`
- Delete: `test/integration/session-search-e2e.test.ts`
- Modify: `server/index.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/session-pagination.ts`
- Delete: `server/routes/sessions.ts`

**Step 1: Write the failing session-directory route tests**

Cover:

1. `GET /api/session-directory` is the only list/search read-model route
2. query validation accepts only the visible-first cursor window contract
3. `/api/sessions/search` and `/api/sessions/query` are gone as runtime read paths
4. mutation routes remain separate from the read-model authority

**Step 2: Run the session-directory route lane**

```bash
npm run test:server:standard -- test/integration/server/session-directory-router.test.ts test/unit/server/sessions-router-pagination.test.ts
```

Expected: FAIL until the route family is authoritative.

**Step 3: Implement the minimal route cutover**

Keep the public route surface explicit:

```ts
GET /api/session-directory
PATCH /api/sessions/:sessionId
DELETE /api/sessions/:sessionId
```

Do not keep `/api/sessions/search` or `/api/sessions/query` alive through alias routes.

**Step 4: Re-run the session-directory route lane**

```bash
npm run test:server:standard -- test/integration/server/session-directory-router.test.ts test/unit/server/sessions-router-pagination.test.ts
```

Expected: PASS.

**Step 5: Prove the shadow read-model routes are gone**

```bash
rg -n "/api/sessions/search|/api/sessions/query" server src
```

Expected: no matches.

**Step 6: Commit**

```bash
git add test/integration/server/session-directory-router.test.ts test/unit/server/sessions-router-pagination.test.ts server/index.ts server/sessions-router.ts server/session-pagination.ts
git rm test/integration/session-search-e2e.test.ts server/routes/sessions.ts
git commit -m "feat(session-directory): make session-directory routes authoritative"
```

### Task 8: Move The CLI To The Session Directory Contract

**Files:**
- Modify: `test/unit/cli/http.test.ts`
- Modify: `test/unit/cli/commands.test.ts`
- Modify: `server/cli/index.ts`

**Step 1: Write the failing CLI tests**

Cover:

1. `list-sessions` calls the session-directory contract
2. `search-sessions` calls the session-directory contract family, not legacy snapshot routes
3. user-visible CLI output remains stable

**Step 2: Run the CLI lane**

```bash
NODE_ENV=test npx vitest run test/unit/cli/http.test.ts test/unit/cli/commands.test.ts
```

Expected: FAIL until the CLI stops depending on `/api/sessions` and `/api/sessions/search`.

**Step 3: Implement the minimal CLI cutover**

Reuse the server-owned window contract. Do not keep separate CLI-only read paths.

**Step 4: Re-run the CLI lane**

```bash
NODE_ENV=test npx vitest run test/unit/cli/http.test.ts test/unit/cli/commands.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/cli/http.test.ts test/unit/cli/commands.test.ts server/cli/index.ts
git commit -m "refactor(cli): use visible-first session-directory routes"
```

### Task 9: Move Session Window Hydration Into Store-Owned Visible Intents

**Files:**
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/Sidebar.mobile.test.tsx`
- Modify: `test/unit/client/components/BackgroundSessions.test.tsx`
- Modify: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Modify: `test/unit/client/components/HistoryView.a11y.test.tsx`
- Modify: `test/unit/client/components/Sidebar.perf-audit.test.tsx`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`
- Modify: `test/unit/client/store/sessionsThunks.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/OverviewView.tsx`
- Modify: `src/components/BackgroundSessions.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/sessionsThunks.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`

**Step 1: Write the failing visible-window tests**

Cover:

1. sidebar and history fetch only when visible
2. background surfaces use windowed session-directory refresh instead of full snapshots
3. search and load-more are thunk-owned window operations
4. leaf components do not construct session-directory URLs directly

**Step 2: Run the session window lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts
```

Expected: FAIL until the store owns visible-window orchestration.

**Step 3: Implement the minimal store-owned window model**

Collapse component intent to a thunk call like:

```ts
dispatch(fetchSessionWindow({
  surface: 'sidebar',
  priority: 'visible',
  query,
  cursor,
}))
```

Leaf components may dispatch intents. They may not own fetch cancellation, route construction, or invalidation sequencing.

**Step 4: Re-run the session window lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/client/components/Sidebar.perf-audit.test.tsx test/unit/client/store/sessionsSlice.test.ts test/unit/client/store/sessionsThunks.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts src/components/Sidebar.tsx src/components/OverviewView.tsx src/components/BackgroundSessions.tsx src/components/HistoryView.tsx src/store/sessionsSlice.ts src/store/sessionsThunks.ts src/store/selectors/sidebarSelectors.ts
git commit -m "refactor(session-ui): hydrate only visible session windows"
```

### Task 10: Scope Session Mutation Refresh To The Active Window

**Files:**
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/sessionsThunks.ts`

**Step 1: Write the failing mutation refresh tests**

Cover:

1. rename, archive, and delete refresh only the active session window
2. no mutation flow triggers a full `/api/sessions` reload
3. visible selection stays stable after the targeted refresh

**Step 2: Run the session mutation lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: FAIL until mutation refresh is window-scoped.

**Step 3: Implement the minimal targeted refresh behavior**

Use the active query window revision or cursor context to refetch only the visible window after a successful mutation.

**Step 4: Re-run the session mutation lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx src/components/context-menu/ContextMenuProvider.tsx src/store/sessionsSlice.ts src/store/sessionsThunks.ts
git commit -m "fix(session-ui): scope mutation refresh to the active window"
```

### Task 11: Finish The Agent Timeline Server Read Model

**Files:**
- Modify: `test/integration/server/agent-timeline-router.test.ts`
- Modify: `test/unit/server/agent-timeline/service.test.ts`
- Modify: `server/index.ts`
- Modify: `server/agent-timeline/router.ts`
- Modify: `server/agent-timeline/service.ts`
- Modify: `server/agent-timeline/types.ts`

**Step 1: Write the failing agent timeline tests**

Cover:

1. timeline pages are recent-first and cursorable
2. turn bodies hydrate on demand
3. route contracts are sufficient for reload without replay arrays

**Step 2: Run the agent timeline server lane**

```bash
npm run test:server:standard -- test/integration/server/agent-timeline-router.test.ts test/unit/server/agent-timeline/service.test.ts
```

Expected: FAIL until the server fully owns the visible timeline model.

**Step 3: Implement the minimal route family**

Keep the route surface explicit:

```ts
GET /api/agent-sessions/:sessionId/timeline
GET /api/agent-sessions/:sessionId/turns/:turnId
```

Timeline pages return summaries and cursors only. Turn bodies return full content on demand.

**Step 4: Re-run the agent timeline server lane**

```bash
npm run test:server:standard -- test/integration/server/agent-timeline-router.test.ts test/unit/server/agent-timeline/service.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/integration/server/agent-timeline-router.test.ts test/unit/server/agent-timeline/service.test.ts server/index.ts server/agent-timeline/router.ts server/agent-timeline/service.ts server/agent-timeline/types.ts
git commit -m "feat(agent-timeline): finish recent-first timeline read model"
```

### Task 12: Restore Agent Chat From Snapshot Plus Visible Timeline Windows

**Files:**
- Modify: `test/unit/client/agentChatSlice.test.ts`
- Modify: `test/unit/client/store/agentChatThunks.test.ts`
- Modify: `test/unit/client/sdk-message-handler.test.ts`
- Modify: `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/store/agentChatThunks.ts`
- Modify: `src/lib/sdk-message-handler.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/agent-chat/CollapsedTurn.tsx`
- Modify: `src/components/TabContent.tsx`
- Modify: `server/ws-handler.ts`

**Step 1: Write the failing agent chat client tests**

Cover:

1. `sdk.session.snapshot` plus HTTP timeline pages restore reloads and split-pane remounts
2. hidden panes do not prefetch timeline pages
3. expanding older turns fetches bodies on demand
4. session switches abort stale requests
5. no runtime path waits for `sdk.history`

**Step 2: Run the agent chat lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx
```

Expected: FAIL until snapshot-plus-window restore is authoritative.

**Step 3: Implement the minimal client model**

Keep the websocket attach snapshot small and structural:

```ts
type SdkSessionSnapshotMessage = {
  type: 'sdk.session.snapshot'
  sessionId: string
  latestTurnId: string | null
  status: string
}
```

Store turn summaries separately from hydrated turn bodies.

**Step 4: Re-run the agent chat lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/store/agentChatThunks.ts src/lib/sdk-message-handler.ts src/components/agent-chat/AgentChatView.tsx src/components/agent-chat/CollapsedTurn.tsx src/components/TabContent.tsx server/ws-handler.ts
git commit -m "feat(agent-chat): restore from snapshots and visible timeline windows"
```

### Task 13: Finish The Terminal Directory, Viewport, Scrollback, And Search Routes

**Files:**
- Modify: `test/integration/server/terminal-view-router.test.ts`
- Modify: `test/server/terminals-api.test.ts`
- Modify: `test/unit/server/terminal-view/mirror.test.ts`
- Modify: `test/unit/server/terminal-stream/replay-ring.test.ts`
- Modify: `server/index.ts`
- Modify: `server/terminals-router.ts`
- Modify: `server/terminal-view/service.ts`
- Modify: `server/terminal-view/types.ts`
- Modify: `server/terminal-view/mirror.ts`

**Step 1: Write the failing terminal route tests**

Cover:

1. directory, viewport, scrollback, and search stay separate routes
2. viewport responses include `tailSeq` and runtime metadata
3. search is server-side only
4. replay anchor behavior remains deterministic

**Step 2: Run the terminal route lane**

```bash
npm run test:server:standard -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts test/unit/server/terminal-view/mirror.test.ts test/unit/server/terminal-stream/replay-ring.test.ts
```

Expected: FAIL until the terminal route family is authoritative.

**Step 3: Implement the minimal terminal route contract**

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

**Step 4: Re-run the terminal route lane**

```bash
npm run test:server:standard -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts test/unit/server/terminal-view/mirror.test.ts test/unit/server/terminal-stream/replay-ring.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts test/unit/server/terminal-view/mirror.test.ts test/unit/server/terminal-stream/replay-ring.test.ts server/index.ts server/terminals-router.ts server/terminal-view/service.ts server/terminal-view/types.ts server/terminal-view/mirror.ts
git commit -m "feat(terminal-server): finish visible-first terminal routes"
```

### Task 14: Make Terminal Invalidations And Runtime Deltas Authoritative

**Files:**
- Modify: `test/server/ws-terminal-meta.test.ts`
- Modify: `test/server/ws-terminal-create-session-repair.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-stream/broker.ts`
- Delete: `server/routes/terminals.ts`

**Step 1: Write the failing terminal invalidation tests**

Cover:

1. directory-affecting mutations emit `terminals.changed`
2. already-hydrated visible terminals update through `terminal.runtime.updated`
3. runtime recovery uses the short tail rather than a global snapshot
4. no surviving path requires `terminal.list.updated` or `terminal.meta.list`

**Step 2: Run the terminal invalidation lane**

```bash
npm run test:server:standard -- test/server/ws-terminal-meta.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-stream-v2-replay.test.ts
```

Expected: FAIL until terminal invalidation and replay behavior are fully cut over.

**Step 3: Implement the minimal websocket/runtime contract**

The surviving messages are:

```ts
type TerminalsChangedMessage = { type: 'terminals.changed'; revision: number }

type TerminalRuntimeUpdatedMessage = {
  type: 'terminal.runtime.updated'
  terminalId: string
  revision: number
  status: 'running' | 'detached' | 'exited'
  title: string
  cwd?: string
  pid?: number
}
```

Delete `server/routes/terminals.ts` instead of keeping duplicate routing alive.

**Step 4: Re-run the terminal invalidation lane**

```bash
npm run test:server:standard -- test/server/ws-terminal-meta.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-stream-v2-replay.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/server/ws-terminal-meta.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-stream-v2-replay.test.ts shared/ws-protocol.ts server/ws-handler.ts server/terminal-stream/broker.ts
git rm server/routes/terminals.ts
git commit -m "feat(terminal-server): switch to targeted invalidations and runtime deltas"
```

### Task 15: Paint Terminals Viewport-First

**Files:**
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/unit/client/components/TerminalView.resumeSession.test.tsx`
- Modify: `test/unit/client/components/TerminalView.mobile-viewport.test.tsx`
- Modify: `test/unit/client/components/TerminalView.visibility.test.tsx`
- Modify: `test/unit/client/components/component-edge-cases.test.tsx`
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`
- Modify: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/lib/terminal-attach-seq-state.ts`
- Modify: `src/lib/terminal-restore.ts`
- Modify: `src/store/terminalMetaSlice.ts`
- Modify: `src/store/store.ts`

**Step 1: Write the failing viewport-first terminal tests**

Cover:

1. HTTP viewport paints before websocket replay or `ready`
2. attach uses `sinceSeq = tailSeq`
3. reconnect overflow yields a gap/invalidation path instead of replaying the full backlog
4. pane chrome is seeded from viewport runtime metadata

**Step 2: Run the viewport-first client lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.mobile-viewport.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx test/unit/client/components/component-edge-cases.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: FAIL until the client paints viewport-first.

**Step 3: Implement the minimal restore order**

The restore order is fixed:

1. fetch viewport
2. paint viewport
3. attach with `sinceSeq = tailSeq`
4. apply only the short missed tail

**Step 4: Re-run the viewport-first client lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.mobile-viewport.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx test/unit/client/components/component-edge-cases.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/components/TerminalView.mobile-viewport.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx test/unit/client/components/component-edge-cases.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx src/components/TerminalView.tsx src/lib/terminal-attach-seq-state.ts src/lib/terminal-restore.ts src/store/terminalMetaSlice.ts src/store/store.ts
git commit -m "feat(terminal-client): paint viewport first and recover from tailSeq"
```

### Task 16: Move Terminal Directory Surfaces And Search To Store-Owned HTTP

**Files:**
- Create: `test/unit/client/store/terminalDirectorySlice.test.ts`
- Create: `test/unit/client/store/terminalDirectoryThunks.test.ts`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/Sidebar.mobile.test.tsx`
- Modify: `test/unit/client/components/BackgroundSessions.test.tsx`
- Modify: `test/unit/client/components/TerminalView.search.test.tsx`
- Modify: `test/unit/client/components/terminal/terminal-runtime.test.ts`
- Modify: `test/unit/client/components/terminal/TerminalSearchBar.mobile.test.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/OverviewView.tsx`
- Modify: `src/components/BackgroundSessions.tsx`
- Modify: `src/components/terminal/terminal-runtime.ts`
- Modify: `src/components/terminal/TerminalSearchBar.tsx`
- Modify: `src/store/terminalDirectorySlice.ts`
- Modify: `src/store/terminalDirectoryThunks.ts`

**Step 1: Write the failing terminal directory/search tests**

Cover:

1. visible terminal-directory surfaces fetch only through store-owned thunks
2. hidden or offscreen terminal surfaces do not prehydrate
3. terminal search goes to `/api/terminals/:terminalId/search`
4. client-side `SearchAddon` is no longer required

**Step 2: Run the terminal directory/search lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/components/terminal/TerminalSearchBar.mobile.test.tsx
```

Expected: FAIL until directory ownership and server-side search are complete.

**Step 3: Implement the minimal store-owned directory/search model**

Collapse component intent to a thunk call like:

```ts
dispatch(fetchTerminalDirectoryWindow({
  priority: 'visible',
  cursor,
}))
```

Delete `SearchAddon` usage from `src/components/terminal/terminal-runtime.ts`.

**Step 4: Re-run the terminal directory/search lane**

```bash
NODE_ENV=test npx vitest run test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/components/terminal/TerminalSearchBar.mobile.test.tsx
```

Expected: PASS.

**Step 5: Prove the old client-search and terminal list strings are gone from runtime code**

```bash
rg -n "SearchAddon|terminal\\.meta\\.list|terminal\\.list\\.updated" src server
```

Expected: no matches for `SearchAddon` and no surviving legacy terminal list/meta strings in active runtime code.

**Step 6: Commit**

```bash
git add test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/components/terminal/TerminalSearchBar.mobile.test.tsx src/components/Sidebar.tsx src/components/OverviewView.tsx src/components/BackgroundSessions.tsx src/components/terminal/terminal-runtime.ts src/components/terminal/TerminalSearchBar.tsx src/store/terminalDirectorySlice.ts src/store/terminalDirectoryThunks.ts
git commit -m "refactor(terminal-ui): move directory and search to store-owned HTTP"
```

### Task 17: Enforce Shared Lane Ordering And Abort Propagation

**Files:**
- Modify: `test/unit/server/read-models/work-scheduler.test.ts`
- Modify: `test/integration/server/bootstrap-router.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/integration/server/terminal-view-router.test.ts`
- Modify: `shared/read-models.ts`
- Modify: `server/read-models/work-scheduler.ts`
- Modify: `server/read-models/request-abort.ts`
- Modify: `server/shell-bootstrap-router.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/agent-timeline/router.ts`
- Modify: `server/terminals-router.ts`

**Step 1: Write the failing scheduler tests**

Cover:

1. `critical` outranks `visible`
2. `visible` outranks `background`
3. background work is concurrency-bounded
4. abort from the owning HTTP request cancels queued or running background work

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

Wire every read-model route to the same scheduler and request-bound abort helper.

**Step 4: Re-run the scheduler lane**

```bash
npm run test:server:standard -- test/unit/server/read-models/work-scheduler.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/server/read-models/work-scheduler.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts shared/read-models.ts server/read-models/work-scheduler.ts server/read-models/request-abort.ts server/shell-bootstrap-router.ts server/sessions-router.ts server/agent-timeline/router.ts server/terminals-router.ts
git commit -m "feat(scheduler): enforce shared visible-first lane ordering"
```

### Task 18: Enforce Payload Budgets And Audit-Facing Instrumentation

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

Cover:

1. bootstrap payload stays under `12 * 1024` bytes
2. realtime frames stay under `16 * 1024` bytes or degrade through gap/invalidation behavior
3. queue overflow does not produce unbounded buffering
4. request and perf logs capture lane, payload bytes, duration, queue depth, and dropped bytes
5. live terminal input/output still outranks background read-model work

**Step 2: Run the budget lane**

```bash
npm run test:server:standard -- test/unit/server/request-logger.test.ts test/unit/server/perf-logger.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/perf-logger.test.ts
```

Expected: FAIL until the budgets are enforced in the real seams.

**Step 3: Implement the minimal shared budgets**

Use these constants:

```ts
export const MAX_REALTIME_MESSAGE_BYTES = 16 * 1024
export const MAX_BOOTSTRAP_PAYLOAD_BYTES = 12 * 1024
export const MAX_DIRECTORY_PAGE_ITEMS = 50
export const MAX_AGENT_TIMELINE_ITEMS = 30
export const MAX_TERMINAL_SCROLLBACK_PAGE_BYTES = 64 * 1024
```

Reuse the existing request and perf logger seams. Do not create a second telemetry path.

**Step 4: Re-run the budget lane**

```bash
npm run test:server:standard -- test/unit/server/request-logger.test.ts test/unit/server/perf-logger.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/perf-logger.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/unit/server/request-logger.test.ts test/unit/server/perf-logger.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/client/lib/perf-logger.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts server/request-logger.ts server/perf-logger.ts server/terminal-stream/client-output-queue.ts server/ws-handler.ts server/shell-bootstrap-router.ts server/sessions-router.ts server/terminals-router.ts src/lib/perf-logger.ts
git commit -m "feat(transport): enforce budgets and audit-facing instrumentation"
```

### Task 19: Delete Legacy Bulk WebSocket Delivery And Chunking

**Files:**
- Modify: `test/server/ws-sidebar-snapshot-refresh.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
- Modify: `test/unit/server/session-history-loader.test.ts`
- Delete: `test/server/ws-sessions-patch.test.ts`
- Delete: `test/unit/server/ws-chunking.test.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/session-history-loader.ts`
- Modify: `server/sessions-sync/service.ts`
- Delete: `server/ws-chunking.ts`

**Step 1: Write the failing legacy-delivery cleanup tests**

Cover:

1. successful transcripts never emit `sessions.updated`, `sessions.page`, `sessions.patch`, `sdk.history`, `terminal.list.updated`, or `terminal.meta.list.response`
2. session invalidation is revision-only
3. SDK attach/create relies on `sdk.session.snapshot` plus live deltas, never replay arrays
4. chunking-specific tests are deleted instead of preserved as compatibility debt

**Step 2: Run the legacy-delivery lane**

```bash
npm run test:server:standard -- test/server/ws-sidebar-snapshot-refresh.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/session-history-loader.test.ts
```

Expected: FAIL until the bulk websocket delivery paths are gone.

**Step 3: Implement the minimal deletion**

After this task, the surviving session and SDK websocket paths are invalidation or live-delta only. Remove `sdk.history` replay shaping from `server/session-history-loader.ts`, remove chunking, and remove patch-broadcast logic from `server/sessions-sync/service.ts`.

**Step 4: Re-run the legacy-delivery lane**

```bash
npm run test:server:standard -- test/server/ws-sidebar-snapshot-refresh.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/session-history-loader.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/server/ws-sidebar-snapshot-refresh.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/session-history-loader.test.ts server/ws-handler.ts server/session-history-loader.ts server/sessions-sync/service.ts
git rm test/server/ws-sessions-patch.test.ts test/unit/server/ws-chunking.test.ts server/ws-chunking.ts
git commit -m "refactor(protocol): delete bulk websocket delivery and chunking"
```

### Task 20: Remove Legacy Capabilities, Commands, And Static Compatibility Paths

**Files:**
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/App.tsx`

**Step 1: Write the failing protocol cleanup tests**

Cover:

1. `hello.capabilities` no longer advertises `sessionsPatchV1` or `sessionsPaginationV1`
2. client messages `sessions.fetch`, `terminal.list`, and `terminal.meta.list` are rejected because they no longer exist
3. the client and server no longer expose legacy bulk message unions
4. `src/App.tsx` no longer carries compatibility handlers for `sessions.updated`

**Step 2: Run the protocol cleanup lane**

```bash
npm run test:server:standard -- test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client.test.ts
```

Expected: FAIL until the remaining compatibility protocol is gone.

**Step 3: Implement the minimal protocol cleanup**

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

**Step 4: Re-run the protocol cleanup lane**

```bash
npm run test:server:standard -- test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client.test.ts
```

Expected: PASS.

**Step 5: Prove the legacy strings are gone from production code**

```bash
rg -n "sessions\\.updated|sessions\\.page|sessions\\.patch|sessions\\.fetch|sdk\\.history|terminal\\.list(\\.updated|\\.response)?|terminal\\.meta\\.list(\\.response)?|sessionsPatchV1|sessionsPaginationV1" shared server src
rg -n "/api/sessions/search|/api/sessions/query" server src
rg -n "ws\\.connect\\(" src
```

Expected:

1. first command: no matches
2. second command: no matches
3. third command: only `src/App.tsx`

**Step 6: Commit**

```bash
git add test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts test/unit/client/lib/ws-client.test.ts shared/ws-protocol.ts server/ws-handler.ts src/lib/ws-client.ts src/App.tsx
git commit -m "refactor(protocol): remove legacy websocket capabilities and commands"
```

### Task 21: Run The Full Quality Gate And Audit Loop Until It Passes

**Files:**
- No planned source edits.
- Generated, uncommitted artifacts:
  - `artifacts/perf/visible-first-baseline.pre-cutover.json`
  - `artifacts/perf/visible-first-candidate.post-cutover.json`
  - `artifacts/perf/visible-first-diff.post-cutover.json`
  - `artifacts/perf/visible-first-gate.post-cutover.json`

**Step 1: Run the full quality suite**

```bash
npm run lint
npm test
npm run verify
```

Expected: all PASS.

If any command fails, fix the narrowest real defect, add the missing regression if needed, commit the fix, and rerun Step 1.

**Step 2: Capture and validate the post-cutover candidate artifact**

```bash
npm run perf:audit:visible-first -- --output artifacts/perf/visible-first-candidate.post-cutover.json
npx tsx --eval "import fs from 'node:fs'; import { VisibleFirstAuditSchema, assertVisibleFirstAuditTrusted } from './test/e2e-browser/perf/audit-contract.ts'; const artifact = VisibleFirstAuditSchema.parse(JSON.parse(fs.readFileSync('artifacts/perf/visible-first-candidate.post-cutover.json', 'utf8'))); assertVisibleFirstAuditTrusted(artifact);"
```

Expected: both commands exit `0`.

If this fails, fix the audit trust defect and rerun Step 2.

**Step 3: Produce the diff and run the machine gate**

```bash
npm run perf:audit:compare -- --base artifacts/perf/visible-first-baseline.pre-cutover.json --candidate artifacts/perf/visible-first-candidate.post-cutover.json > artifacts/perf/visible-first-diff.post-cutover.json
npm run perf:audit:gate -- --base artifacts/perf/visible-first-baseline.pre-cutover.json --candidate artifacts/perf/visible-first-candidate.post-cutover.json > artifacts/perf/visible-first-gate.post-cutover.json
```

Expected:

1. both commands exit `0`
2. `artifacts/perf/visible-first-gate.post-cutover.json` reports `"ok": true`

If the gate fails, go back to the narrowest failing seam, add or tighten the missing regression, fix the product, commit the fix, and restart Task 21 from Step 1. Do not stop at the first bad comparison.

**Step 4: Confirm audit artifacts stay uncommitted**

```bash
git status --short
```

Expected: source changes only if Step 1 through Step 3 required a real fix; `artifacts/perf/*.json` remain untracked or ignored, never staged.

## Final Verification Checklist

- [ ] trusted pre-cutover baseline artifact exists
- [ ] trusted post-cutover candidate artifact exists
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run verify` passes
- [ ] production grep finds no legacy bulk websocket strings
- [ ] production grep finds no `/api/sessions/search` or `/api/sessions/query`
- [ ] no production code imports `SearchAddon`
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

1. Prefer deletion over compatibility shims. The previous regression happened because both the new and old transport paths were active at landing.
2. Keep temporary coexistence only long enough to switch the next consumer. Tasks 18 and 19 are the non-negotiable hard-delete phase.
3. When a test encodes legacy behavior that should not survive, rewrite or delete it in the same task that removes the runtime path.
4. Do not create “temporary” fallbacks for offscreen hydration, terminal metadata snapshots, bulk session payloads, or `sdk.history`.
5. Do not create no-op commits. Commit only green states with real code or test changes.

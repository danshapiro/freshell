# Visible-First Prioritized Transport Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Land the full visible-first prioritized transport spec directly: server-owned visible/read-model transport, no hybrid websocket bulk paths, `App.tsx` as the sole websocket owner, priority-aware hydration that favors `mobile_restricted`, and a passing repeatable audit diff against a trusted baseline.

**Architecture:** Keep the March 9 architecture and finish it completely rather than repairing the old hybrid tree. Reuse the existing bootstrap router, session-directory router, terminal-view router, read-model scheduler, and audit harness seams already in this worktree, then tighten them until they enforce the final cutover and reject any fallback to bulk websocket snapshots or offscreen hydration.

**Tech Stack:** Node.js, Express, `ws`, React 18, Redux Toolkit, TypeScript, Zod, Vitest, Playwright/Chromium audit harness, `tsx`

---

## Why This Revision Exists

- The previous completion plan had the right destination, but it still left too much room for a "mostly migrated" hybrid landing.
- The biggest missing seam was not transport deletion. It was proving the supporting rules that make visible-first safe:
  - lane ordering through the existing read-model scheduler
  - payload budgets and queue bounds at the transport seam
  - explicit logging and instrumentation the audit can trust
- Several real files already in the tree were omitted from the ownership map:
  - `server/read-models/work-scheduler.ts`
  - `server/request-logger.ts`
  - `server/perf-logger.ts`
  - `server/terminal-stream/client-output-queue.ts`
  - `test/unit/server/read-models/work-scheduler.test.ts`
  - `test/unit/server/request-logger.test.ts`
  - `test/unit/server/perf-logger.test.ts`
  - `test/unit/server/terminal-stream/client-output-queue.test.ts`
- Trycycle plans need narrower, directly executable red-green-refactor slices than the previous version provided. This revision keeps the good architecture, but decomposes execution into seams that another engineer can land without improvising.

## Strategy Gate

1. Treat these four documents as the source of truth, in this order:
   - `docs/plans/2026-03-09-visible-first-prioritized-transport.md`
   - `docs/plans/2026-03-09-visible-first-prioritized-transport-test-plan.md`
   - `docs/plans/2026-03-10-visible-first-performance-audit.md`
   - `docs/plans/2026-03-10-visible-first-performance-audit-test-plan.md`
2. Land the direct end state now. Do not keep hybrid compatibility, "temporary" fallbacks, or a stabilization phase.
3. Reuse the scheduler, bootstrap router, session-directory router, terminal-view router, and audit harness already in the tree. Finish and tighten them instead of inventing parallel infrastructure.
4. Keep the full audit matrix: six scenarios times `desktop_local` and `mobile_restricted`. Do not narrow it.
5. The machine gate fails when any of these are true:
   - either artifact is untrusted
   - any sample has `status !== "ok"`
   - any scenario/profile pair is missing
   - any `mobile_restricted.focusedReadyMs` delta is positive
   - any `mobile_restricted.terminalInputToFirstOutputMs` delta is positive in `terminal-cold-boot` or `terminal-reconnect-backlog`
   - any positive delta appears in `offscreenHttpRequestsBeforeReady`, `offscreenHttpBytesBeforeReady`, `offscreenWsFramesBeforeReady`, or `offscreenWsBytesBeforeReady` for either profile
6. The gate rules above are intentional:
   - `mobile_restricted` is the user’s decision rule
   - the prior rollback was driven by mobile restricted regressions
   - offscreen-before-ready work is the architectural smell this cutover must eliminate
7. No runtime path may emit or consume:
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
8. `src/App.tsx` is the only websocket owner. Child components and thunks may dispatch intents, but they may not call `ws.connect()`.
9. Hidden panes and offscreen tabs do not pre-create, pre-attach, prefetch timeline pages, or prehydrate terminal data. Visibility or explicit selection is the trigger.
10. The server owns search, pagination, timeline shaping, terminal viewport serialization, runtime metadata, invalidation revisions, read-model lane scheduling, payload budgets, and transport instrumentation.
11. End every task green. Do not leave the repository red across task boundaries.
12. Do not commit generated audit artifacts.

## Files That Matter

- Source-of-truth docs:
  - `docs/plans/2026-03-09-visible-first-prioritized-transport.md`
  - `docs/plans/2026-03-09-visible-first-prioritized-transport-test-plan.md`
  - `docs/plans/2026-03-10-visible-first-performance-audit.md`
  - `docs/plans/2026-03-10-visible-first-performance-audit-test-plan.md`
- Shared transport and read-model contracts:
  - `shared/ws-protocol.ts`
  - `shared/read-models.ts`
- Server transport and read models:
  - `server/index.ts`
  - `server/ws-handler.ts`
  - `server/session-history-loader.ts`
  - `server/sessions-sync/service.ts`
  - `server/sessions-router.ts`
  - `server/session-pagination.ts`
  - `server/shell-bootstrap-router.ts`
  - `server/agent-timeline/router.ts`
  - `server/agent-timeline/service.ts`
  - `server/terminals-router.ts`
  - `server/terminal-view/service.ts`
  - `server/terminal-stream/broker.ts`
  - `server/terminal-stream/client-output-queue.ts`
  - `server/read-models/work-scheduler.ts`
  - `server/request-logger.ts`
  - `server/perf-logger.ts`
  - `server/cli/index.ts`
  - `server/routes/sessions.ts`
  - `server/routes/terminals.ts`
  - `server/ws-chunking.ts`
- Client bootstrap and hydration ownership:
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
  - `src/components/TabContent.tsx`
- Agent chat client state:
  - `src/store/agentChatTypes.ts`
  - `src/store/agentChatSlice.ts`
  - `src/store/agentChatThunks.ts`
  - `src/components/agent-chat/AgentChatView.tsx`
  - `src/components/agent-chat/CollapsedTurn.tsx`
- Session and terminal client state:
  - `src/store/sessionsSlice.ts`
  - `src/store/sessionsThunks.ts`
  - `src/store/selectors/sidebarSelectors.ts`
  - `src/store/terminalDirectorySlice.ts`
  - `src/store/terminalDirectoryThunks.ts`
  - `src/store/terminalMetaSlice.ts`
  - `src/store/store.ts`
  - `src/components/TerminalView.tsx`
  - `src/components/terminal/terminal-runtime.ts`
  - `src/components/terminal/TerminalSearchBar.tsx`
- Perf gate tooling:
  - `test/e2e-browser/perf/audit-contract.ts`
  - `test/e2e-browser/perf/compare-visible-first-audits.ts`
  - `test/e2e-browser/perf/visible-first-audit-gate.ts`
  - `scripts/assert-visible-first-audit-gate.ts`
  - `scripts/compare-visible-first-audit.ts`
  - `package.json`
- Test seams that must stay aligned with the cutover:
  - protocol and invalidation: `test/server/ws-protocol.test.ts`, `test/server/ws-edge-cases.test.ts`, `test/server/ws-handshake-snapshot.test.ts`, `test/server/ws-sidebar-snapshot-refresh.test.ts`, `test/server/ws-terminal-meta.test.ts`, `test/unit/server/sessions-sync/service.test.ts`, `test/unit/server/ws-handler-backpressure.test.ts`, `test/unit/server/ws-handler-sdk.test.ts`, `test/unit/client/lib/ws-client.test.ts`, `test/unit/client/ws-client-sdk.test.ts`
  - shadow session routes and CLI: `test/integration/server/session-directory-router.test.ts`, `test/unit/cli/http.test.ts`, `test/unit/cli/commands.test.ts`, `test/unit/client/lib/api.test.ts`, `test/unit/client/components/ContextMenuProvider.test.tsx`, `test/unit/client/components/HistoryView.mobile.test.tsx`
  - bootstrap and visible hydration: `test/integration/server/bootstrap-router.test.ts`, `test/unit/client/components/App.test.tsx`, `test/unit/client/components/App.ws-bootstrap.test.tsx`, `test/unit/client/components/App.ws-extensions.test.tsx`, `test/unit/client/components/App.perf-audit-bootstrap.test.tsx`, `test/unit/client/components/App.lazy-views.test.tsx`, `test/unit/client/components/App.mobile.test.tsx`, `test/unit/client/components/App.mobile-landscape.test.tsx`, `test/unit/client/components/App.swipe-sidebar.test.tsx`, `test/unit/client/components/App.swipe-tabs.test.tsx`, `test/unit/client/components/App.sidebar-resize.test.tsx`, `test/unit/client/components/Sidebar.test.tsx`, `test/unit/client/components/Sidebar.mobile.test.tsx`, `test/unit/client/components/BackgroundSessions.test.tsx`, `test/e2e/auth-required-bootstrap-flow.test.tsx`, `test/e2e/mobile-sidebar-fullwidth-flow.test.tsx`, `test/e2e/terminal-font-settings.test.tsx`
  - agent chat: `test/integration/server/agent-timeline-router.test.ts`, `test/unit/client/agentChatSlice.test.ts`, `test/unit/client/store/agentChatThunks.test.ts`, `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`, `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`, `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`, `test/e2e/open-tab-session-sidebar-visibility.test.tsx`, `test/e2e/sidebar-click-opens-pane.test.tsx`
  - terminals: `test/integration/server/terminal-view-router.test.ts`, `test/server/terminals-api.test.ts`, `test/server/ws-terminal-meta.test.ts`, `test/unit/client/components/TerminalView.lifecycle.test.tsx`, `test/unit/client/components/TerminalView.search.test.tsx`, `test/unit/client/components/terminal/terminal-runtime.test.ts`, `test/unit/client/store/terminalMetaSlice.test.ts`, `test/unit/client/store/terminalDirectorySlice.test.ts`, `test/unit/client/store/terminalDirectoryThunks.test.ts`, `test/e2e/pane-header-runtime-meta-flow.test.tsx`, `test/e2e/terminal-flaky-network-responsiveness.test.tsx`
  - scheduler, budgets, instrumentation: `test/unit/server/read-models/work-scheduler.test.ts`, `test/unit/server/request-logger.test.ts`, `test/unit/server/perf-logger.test.ts`, `test/unit/server/terminal-stream/client-output-queue.test.ts`, `test/unit/client/lib/perf-logger.test.ts`

## Preflight: Trusted Baseline Artifact

Do this before any runtime code edits. Do not commit generated artifacts.

1. Create the artifact directory:

```bash
mkdir -p artifacts/perf
```

2. Capture the current baseline:

```bash
npm run perf:audit:visible-first -- --output artifacts/perf/visible-first-baseline.pre-cutover.json
```

3. Validate that the baseline is trusted:

```bash
npx tsx --eval "import fs from 'node:fs'; import { VisibleFirstAuditSchema, assertVisibleFirstAuditTrusted } from './test/e2e-browser/perf/audit-contract.ts'; const artifact = VisibleFirstAuditSchema.parse(JSON.parse(fs.readFileSync('artifacts/perf/visible-first-baseline.pre-cutover.json', 'utf8'))); assertVisibleFirstAuditTrusted(artifact);"
```

Expected: exit `0`.

If this fails, fix the audit harness or environment first. Do not start transport work on an untrusted baseline.

### Task 1: Add the machine-enforced audit gate

**Files:**
- Create: `test/e2e-browser/perf/visible-first-audit-gate.ts`
- Create: `scripts/assert-visible-first-audit-gate.ts`
- Create: `test/unit/lib/visible-first-audit-gate.test.ts`
- Modify: `package.json`

**Step 1: Write the failing gate tests**

Make the tests fail until all of these are true:
- both artifacts pass `assertVisibleFirstAuditTrusted(...)`
- the full scenario/profile matrix is present
- any positive delta in `mobile_restricted.focusedReadyMs` fails
- any positive delta in `mobile_restricted.terminalInputToFirstOutputMs` fails for `terminal-cold-boot` and `terminal-reconnect-backlog`
- any positive delta in `offscreenHttpRequestsBeforeReady`, `offscreenHttpBytesBeforeReady`, `offscreenWsFramesBeforeReady`, or `offscreenWsBytesBeforeReady` fails for either profile
- the CLI prints JSON only and exits non-zero on violations

**Step 2: Run the gate lane**

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-gate.test.ts
```

Expected: FAIL because the gate helper and CLI do not exist yet.

**Step 3: Implement the helper and CLI**

Build the gate on top of `compareVisibleFirstAudits(...)` and emit JSON shaped like:

```json
{
  "ok": false,
  "violations": [
    {
      "scenarioId": "terminal-cold-boot",
      "profileId": "mobile_restricted",
      "metric": "focusedReadyMs",
      "base": 1000,
      "candidate": 1200,
      "delta": 200
    }
  ]
}
```

Add:

```json
"perf:audit:gate": "tsx scripts/assert-visible-first-audit-gate.ts"
```

**Step 4: Re-run the gate lane**

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-gate.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/visible-first-audit-gate.ts scripts/assert-visible-first-audit-gate.ts test/unit/lib/visible-first-audit-gate.test.ts package.json
git commit -m "test(perf): add visible-first landing gate"
```

### Task 2: Lock the websocket protocol against hybrid fallbacks

**Files:**
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/server/ws-sidebar-snapshot-refresh.test.ts`
- Modify: `test/server/ws-terminal-meta.test.ts`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Modify: `test/unit/client/ws-client-sdk.test.ts`
- Delete: `test/unit/server/ws-chunking.test.ts`
- Delete: `test/server/ws-sessions-patch.test.ts`

**Step 1: Rewrite the protocol tests to make the hybrid transport fail**

Make the tests fail until all of these are true:
- `hello.capabilities` does not advertise `sessionsPatchV1` or `sessionsPaginationV1`
- client messages `sessions.fetch`, `terminal.list`, and `terminal.meta.list` are invalid
- successful transcripts never emit `sessions.updated`, `sessions.page`, `sessions.patch`, `sdk.history`, `terminal.list.response`, or `terminal.meta.list.response`
- session-sync tests prove revision invalidation replaces patch payload broadcasts
- chunking- and session-patch-specific tests are deleted instead of preserved as compatibility debt
- `sdk.attach` and `sdk.create` prove `sdk.session.snapshot` survives without replay fallback

**Step 2: Run the protocol lane**

```bash
npm run test:server:standard -- test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/server/ws-terminal-meta.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/server/ws-handler-sdk.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client.test.ts test/unit/client/ws-client-sdk.test.ts
```

Expected: FAIL against the current hybrid tree.

**Step 3: Commit the red expectations**

```bash
git add test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/server/ws-terminal-meta.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/client/lib/ws-client.test.ts test/unit/client/ws-client-sdk.test.ts
git rm test/unit/server/ws-chunking.test.ts test/server/ws-sessions-patch.test.ts
git commit -m "test(protocol): make hybrid websocket transport fail"
```

### Task 3: Delete the legacy bulk websocket surface

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/session-history-loader.ts`
- Modify: `server/sessions-sync/service.ts`
- Delete: `server/ws-chunking.ts`

**Step 1: Remove the shared websocket contract**

Delete:
- `sessions.updated`
- `sessions.page`
- `sessions.patch`
- `sessions.fetch`
- `terminal.list`
- `terminal.list.response`
- `terminal.list.updated`
- `terminal.meta.list`
- `terminal.meta.list.response`
- `sessionsPatchV1`
- `sessionsPaginationV1`

**Step 2: Remove the matching server branches**

Delete from `server/ws-handler.ts`:
- chunked session snapshot send paths
- session pagination fetch handling
- terminal directory request or response handling
- terminal meta snapshot handling
- `sdk.history` replay emission

Reduce `server/session-history-loader.ts` so it no longer preserves replay-array shaping for websocket delivery. Update `server/sessions-sync/service.ts` so it no longer models `sessions.patch` broadcasts.

**Step 3: Re-run the protocol lane**

```bash
npm run test:server:standard -- test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/server/ws-terminal-meta.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/server/ws-handler-sdk.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/ws-client.test.ts test/unit/client/ws-client-sdk.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts server/session-history-loader.ts server/sessions-sync/service.ts
git rm server/ws-chunking.ts
git commit -m "feat(protocol): delete legacy bulk websocket transport"
```

### Task 4: Lock session-directory, CLI, and shadow-route regressions

**Files:**
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/unit/cli/http.test.ts`
- Modify: `test/unit/cli/commands.test.ts`
- Modify: `test/unit/client/lib/api.test.ts`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Modify: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Delete: `test/integration/session-search-e2e.test.ts`

**Step 1: Rewrite the tests around the session-directory contract**

Make the tests fail until all of these are true:
- `GET /api/session-directory` is the only authoritative list and search contract
- CLI list and search commands no longer call `/api/sessions` or `/api/sessions/search`
- session rename, archive, and delete refresh only the active directory window
- no client API helper still exports `/api/sessions`, `/api/sessions/search`, or `/api/sessions/query` as startup or directory authorities

**Step 2: Run the session-directory lane**

```bash
npm run test:server:standard -- test/integration/server/session-directory-router.test.ts
NODE_ENV=test npx vitest run test/unit/cli/http.test.ts test/unit/cli/commands.test.ts test/unit/client/lib/api.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx
```

Expected: FAIL because shadow session paths still exist.

**Step 3: Commit the red expectations**

```bash
git add test/integration/server/session-directory-router.test.ts test/unit/cli/http.test.ts test/unit/cli/commands.test.ts test/unit/client/lib/api.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx
git rm test/integration/session-search-e2e.test.ts
git commit -m "test(session-directory): forbid shadow session routes"
```

### Task 5: Delete shadow session routes and migrate the CLI

**Files:**
- Modify: `server/index.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/session-pagination.ts`
- Modify: `server/cli/index.ts`
- Modify: `src/lib/api.ts`
- Delete: `server/routes/sessions.ts`

**Step 1: Delete the shadow HTTP routes**

Remove `/api/sessions`, `/api/sessions/search`, and `/api/sessions/query` as authoritative runtime paths. Keep the session-directory family as the single read-model authority.

**Step 2: Move the CLI and shared client helpers to the surviving contract**

`server/cli/index.ts` and `src/lib/api.ts` must use the session-directory endpoints only. Do not preserve aliases.

**Step 3: Re-run the session-directory lane**

```bash
npm run test:server:standard -- test/integration/server/session-directory-router.test.ts
NODE_ENV=test npx vitest run test/unit/cli/http.test.ts test/unit/cli/commands.test.ts test/unit/client/lib/api.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/HistoryView.mobile.test.tsx
```

Expected: PASS.

**Step 4: Commit**

```bash
git add server/index.ts server/sessions-router.ts server/session-pagination.ts server/cli/index.ts src/lib/api.ts
git rm server/routes/sessions.ts
git commit -m "feat(session-directory): remove shadow session APIs and migrate CLI"
```

### Task 6: Lock shell bootstrap, sole websocket ownership, and visible-first hydration

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
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/Sidebar.mobile.test.tsx`
- Modify: `test/unit/client/components/BackgroundSessions.test.tsx`
- Modify: `test/e2e/auth-required-bootstrap-flow.test.tsx`
- Modify: `test/e2e/mobile-sidebar-fullwidth-flow.test.tsx`
- Modify: `test/e2e/terminal-font-settings.test.tsx`

**Step 1: Make startup and visibility rules explicit in the tests**

Make the tests fail until all of these are true:
- `src/App.tsx` is the sole websocket owner
- `src/components/SessionView.tsx` no longer calls `ws.connect()`
- startup uses `/api/bootstrap` as the shell bootstrap, not legacy fallback bootstraps
- focused-pane hydration can start before websocket `ready`
- `/api/version` and network diagnostics are background work
- sidebar, projects, and background session surfaces fetch only when visible
- no bootstrap or mobile test still treats `/api/sessions` as a required startup request

**Step 2: Run the bootstrap and visibility lane**

```bash
npm run test:server:standard -- test/integration/server/bootstrap-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: FAIL because compatibility branches and mount-time fetches still exist.

**Step 3: Commit the red expectations**

```bash
git add test/integration/server/bootstrap-router.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/e2e/terminal-font-settings.test.tsx
git commit -m "test(app): require visible-first bootstrap and sole websocket ownership"
```

### Task 7: Implement shell bootstrap ownership and visible-only session hydration

**Files:**
- Modify: `server/index.ts`
- Modify: `server/shell-bootstrap-router.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/SessionView.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/OverviewView.tsx`
- Modify: `src/components/BackgroundSessions.tsx`
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/sessionsThunks.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`

**Step 1: Remove child websocket ownership and legacy bootstrap fallbacks**

`src/App.tsx` remains the only caller of `ws.connect()`. Delete any fallback startup path that rebuilds the shell from shadow APIs.

**Step 2: Move session-directory fetch ownership into store thunks and selectors**

Sidebar, projects, and background session surfaces may dispatch intents, but they do not own mount-time transport choreography, abort policy, or direct route construction.

**Step 3: Re-run the bootstrap and visibility lane**

```bash
npm run test:server:standard -- test/integration/server/bootstrap-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: PASS.

**Step 4: Commit**

```bash
git add server/index.ts server/shell-bootstrap-router.ts src/App.tsx src/components/SessionView.tsx src/components/Sidebar.tsx src/components/OverviewView.tsx src/components/BackgroundSessions.tsx src/store/sessionsSlice.ts src/store/sessionsThunks.ts src/store/selectors/sidebarSelectors.ts
git commit -m "refactor(app): make bootstrap and session hydration visible-first"
```

### Task 8: Lock snapshot-only agent restore and hidden-pane chat gating

**Files:**
- Modify: `test/integration/server/agent-timeline-router.test.ts`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
- Modify: `test/unit/client/agentChatSlice.test.ts`
- Modify: `test/unit/client/store/agentChatThunks.test.ts`
- Modify: `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`

**Step 1: Make the snapshot-only agent flow explicit**

Make the tests fail until all of these are true:
- timeline pages are recent-first and cursorable
- turn bodies hydrate on demand
- `sdk.attach` and `sdk.create` never replay `sdk.history`
- `sdk.session.snapshot` plus HTTP timeline state is enough to recover reloads and split-pane remounts
- hidden agent panes do not prefetch timeline pages or create websocket activity before selection

**Step 2: Run the agent-chat lane**

```bash
npm run test:server:standard -- test/integration/server/agent-timeline-router.test.ts test/unit/server/ws-handler-sdk.test.ts
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: FAIL because replay fallbacks and early hidden-pane hydration are still present.

**Step 3: Commit the red expectations**

```bash
git add test/integration/server/agent-timeline-router.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "test(agent-chat): require snapshot-only restore and hidden-pane gating"
```

### Task 9: Implement snapshot-only agent chat restore

**Files:**
- Modify: `server/agent-timeline/service.ts`
- Modify: `server/agent-timeline/router.ts`
- Modify: `server/index.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/store/agentChatThunks.ts`
- Modify: `src/lib/sdk-message-handler.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/agent-chat/CollapsedTurn.tsx`
- Modify: `src/components/TabContent.tsx`

**Step 1: Keep the server on snapshot plus timeline pages**

Serve recent-first timeline pages and turn bodies through HTTP. Websocket attach or create emits `sdk.session.snapshot` plus live deltas, never replay arrays.

**Step 2: Replace replay-oriented client state**

The client stores metadata plus timeline summaries separately from hydrated bodies. `src/store/agentChatThunks.ts` owns timeline fetch and cancellation. Hidden panes do not hydrate until selected.

**Step 3: Re-run the agent-chat lane**

```bash
npm run test:server:standard -- test/integration/server/agent-timeline-router.test.ts test/unit/server/ws-handler-sdk.test.ts
NODE_ENV=test npx vitest run test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 4: Commit**

```bash
git add server/agent-timeline/service.ts server/agent-timeline/router.ts server/index.ts server/ws-handler.ts src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/store/agentChatThunks.ts src/lib/sdk-message-handler.ts src/components/agent-chat/AgentChatView.tsx src/components/agent-chat/CollapsedTurn.tsx src/components/TabContent.tsx
git commit -m "feat(agent-chat): restore from snapshots and hydrate only visible panes"
```

### Task 10: Lock terminal directory, viewport-first restore, and server-side search

**Files:**
- Modify: `test/integration/server/terminal-view-router.test.ts`
- Modify: `test/server/terminals-api.test.ts`
- Modify: `test/server/ws-terminal-meta.test.ts`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/Sidebar.mobile.test.tsx`
- Modify: `test/unit/client/components/BackgroundSessions.test.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/unit/client/components/TerminalView.search.test.tsx`
- Modify: `test/unit/client/components/terminal/terminal-runtime.test.ts`
- Modify: `test/unit/client/store/terminalMetaSlice.test.ts`
- Modify: `test/unit/client/components/component-edge-cases.test.tsx`
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`
- Modify: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`
- Create: `test/unit/client/store/terminalDirectorySlice.test.ts`
- Create: `test/unit/client/store/terminalDirectoryThunks.test.ts`

**Step 1: Make the terminal end state explicit**

Make the tests fail until all of these are true:
- `GET /api/terminals` is the terminal directory authority
- `GET /api/terminals/:terminalId/viewport` paints the visible terminal before replay
- reconnect uses `sinceSeq = tailSeq`
- visible pane chrome comes from viewport payloads and `terminal.runtime.updated`
- directory invalidation uses `terminals.changed`, not `terminal.list.updated`
- search uses server routes, not `SearchAddon`
- hidden or offscreen terminal panes do not pre-create or pre-attach

**Step 2: Run the terminal lane**

```bash
npm run test:server:standard -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts test/server/ws-terminal-meta.test.ts
NODE_ENV=test npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: FAIL because restore is still replay-first or search is still client-owned somewhere.

**Step 3: Commit the red expectations**

```bash
git add test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts test/server/ws-terminal-meta.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
git commit -m "test(terminal): require viewport-first restore and server search"
```

### Task 11: Implement terminal read models and targeted invalidations

**Files:**
- Modify: `server/terminal-view/service.ts`
- Modify: `server/terminals-router.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `server/index.ts`
- Delete: `server/routes/terminals.ts`
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

**Step 1: Serve the terminal read models directly**

Keep directory, viewport, scrollback, and search in `server/terminals-router.ts` plus `server/terminal-view/service.ts`. Remove the duplicate top-level route module.

**Step 2: Make the client restore path viewport-first**

Use the HTTP viewport snapshot to paint first, then attach with `sinceSeq = tailSeq`. Delete `SearchAddon` usage from `src/components/terminal/terminal-runtime.ts` and route search through the server.

**Step 3: Consume the new invalidation model**

Directory-affecting terminal mutations emit `terminals.changed`. Already-visible terminal chrome updates through `terminal.runtime.updated`. Hidden panes do not hydrate until selected.

**Step 4: Re-run the terminal lane**

```bash
npm run test:server:standard -- test/integration/server/terminal-view-router.test.ts test/server/terminals-api.test.ts test/server/ws-terminal-meta.test.ts
NODE_ENV=test npx vitest run test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.mobile.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.search.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
git add server/terminal-view/service.ts server/terminals-router.ts server/terminal-stream/broker.ts server/index.ts src/App.tsx src/components/Sidebar.tsx src/components/OverviewView.tsx src/components/BackgroundSessions.tsx src/components/TerminalView.tsx src/components/terminal/terminal-runtime.ts src/components/terminal/TerminalSearchBar.tsx src/lib/terminal-attach-seq-state.ts src/store/terminalDirectorySlice.ts src/store/terminalDirectoryThunks.ts src/store/terminalMetaSlice.ts src/store/store.ts
git rm server/routes/terminals.ts
git commit -m "feat(terminal): paint viewport first and invalidate by revision"
```

### Task 12: Lock scheduler, payload-budget, and queue-bound invariants

**Files:**
- Modify: `test/unit/server/read-models/work-scheduler.test.ts`
- Modify: `test/unit/server/request-logger.test.ts`
- Modify: `test/unit/server/perf-logger.test.ts`
- Modify: `test/unit/server/terminal-stream/client-output-queue.test.ts`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`
- Modify: `test/unit/client/lib/perf-logger.test.ts`
- Modify: `test/integration/server/bootstrap-router.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/integration/server/terminal-view-router.test.ts`

**Step 1: Make the quality-gate invariants executable**

Make the tests fail until all of these are true:
- `critical` work outranks `visible`, and `visible` outranks `background`
- background work is abortable and concurrency-bounded
- bootstrap payload stays under `12 * 1024` bytes
- websocket realtime frames stay under `16 * 1024` bytes or fall back to gaps or invalidation instead of unbounded buffering
- request and perf logging captures lane, payload bytes, duration, queue depth, and dropped bytes where applicable
- terminal input and output still outrank background read-model work under backpressure

**Step 2: Run the scheduler and budget lane**

```bash
npm run test:server:standard -- test/unit/server/read-models/work-scheduler.test.ts test/unit/server/request-logger.test.ts test/unit/server/perf-logger.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/perf-logger.test.ts
```

Expected: FAIL until the instrumentation and bounds are fully enforced.

**Step 3: Commit the red expectations**

```bash
git add test/unit/server/read-models/work-scheduler.test.ts test/unit/server/request-logger.test.ts test/unit/server/perf-logger.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/client/lib/perf-logger.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts
git commit -m "test(transport): require scheduler ordering and payload budgets"
```

### Task 13: Finish the scheduler, transport budgets, and audit-facing instrumentation

**Files:**
- Modify: `shared/read-models.ts`
- Modify: `server/read-models/work-scheduler.ts`
- Modify: `server/request-logger.ts`
- Modify: `server/perf-logger.ts`
- Modify: `server/terminal-stream/client-output-queue.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/shell-bootstrap-router.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/terminals-router.ts`
- Modify: `src/lib/perf-logger.ts`

**Step 1: Finish the read-model scheduler contract**

Keep the existing scheduler seam and make it authoritative for lane ordering, lane snapshots, abort propagation, and background concurrency limits. Do not invent a second scheduler.

**Step 2: Enforce the transport budgets at the real seams**

Bootstrap must stay shell-only under `12 * 1024` bytes. Oversize realtime frames or replay queues must degrade to gaps or invalidation, not unbounded buffering or blocked focused paint.

**Step 3: Emit the instrumentation the audit and tests rely on**

Request and perf logs must expose enough structured data to prove lane, payload bytes, durations, queue depth, and dropped bytes. Reuse the existing perf logger surfaces instead of adding a parallel telemetry channel.

**Step 4: Re-run the scheduler and budget lane**

```bash
npm run test:server:standard -- test/unit/server/read-models/work-scheduler.test.ts test/unit/server/request-logger.test.ts test/unit/server/perf-logger.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/perf-logger.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/read-models.ts server/read-models/work-scheduler.ts server/request-logger.ts server/perf-logger.ts server/terminal-stream/client-output-queue.ts server/ws-handler.ts server/shell-bootstrap-router.ts server/sessions-router.ts server/terminals-router.ts src/lib/perf-logger.ts
git commit -m "feat(transport): enforce scheduler ordering and payload budgets"
```

### Task 14: Run static invariants, the full suite, and the performance gate until they pass

**Files:**
- No planned source edits.
- Generated, uncommitted artifacts:
  - `artifacts/perf/visible-first-baseline.pre-cutover.json`
  - `artifacts/perf/visible-first-candidate.post-cutover.json`
  - `artifacts/perf/visible-first-diff.post-cutover.json`
  - `artifacts/perf/visible-first-gate.post-cutover.json`

**Step 1: Prove the legacy transport strings are gone from production code**

```bash
rg -n "sessions\\.updated|sessions\\.page|sessions\\.patch|sessions\\.fetch|sdk\\.history|terminal\\.list(\\.updated|\\.response)?|terminal\\.meta\\.list(\\.response)?|sessionsPatchV1|sessionsPaginationV1" shared server src
```

Expected: no matches.

**Step 2: Prove the shadow session APIs are gone and `App.tsx` is the only websocket owner**

```bash
rg -n "/api/sessions|/api/sessions/search|/api/sessions/query" src server
rg -n "ws\\.connect\\(" src
```

Expected:
- first command: no matches
- second command: only `src/App.tsx`

**Step 3: Run the full quality suite**

```bash
npm run lint
npm test
npm run verify
```

Expected: all PASS.

If any command fails, fix the real defect, then rerun all three commands. Do not waive failures.

**Step 4: Capture and validate the post-cutover candidate artifact**

```bash
npm run perf:audit:visible-first -- --output artifacts/perf/visible-first-candidate.post-cutover.json
npx tsx --eval "import fs from 'node:fs'; import { VisibleFirstAuditSchema, assertVisibleFirstAuditTrusted } from './test/e2e-browser/perf/audit-contract.ts'; const artifact = VisibleFirstAuditSchema.parse(JSON.parse(fs.readFileSync('artifacts/perf/visible-first-candidate.post-cutover.json', 'utf8'))); assertVisibleFirstAuditTrusted(artifact);"
```

Expected: both commands exit `0`.

**Step 5: Produce the raw diff and run the machine gate**

```bash
npm run perf:audit:compare -- --base artifacts/perf/visible-first-baseline.pre-cutover.json --candidate artifacts/perf/visible-first-candidate.post-cutover.json > artifacts/perf/visible-first-diff.post-cutover.json
npm run perf:audit:gate -- --base artifacts/perf/visible-first-baseline.pre-cutover.json --candidate artifacts/perf/visible-first-candidate.post-cutover.json > artifacts/perf/visible-first-gate.post-cutover.json
```

Expected:
- both commands exit `0`
- `artifacts/perf/visible-first-gate.post-cutover.json` reports `"ok": true`

If the gate fails, go back to the narrowest failing seam, add or tighten the missing regression test if needed, fix the product, and repeat Task 14 from Step 1. Do not stop at the first bad comparison.

**Step 6: Commit the verified code state**

Do not add generated audit artifacts.

```bash
git status --short
git add shared server src test scripts package.json
git commit -m "feat(perf): complete visible-first prioritized transport cutover"
```

## Final Verification Checklist

- [ ] baseline artifact exists and is trusted
- [ ] candidate artifact exists and is trusted
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run verify` passes
- [ ] production grep has no legacy transport strings
- [ ] no production `/api/sessions*` shadow API usage remains
- [ ] only `src/App.tsx` calls `ws.connect()`
- [ ] bootstrap stays under `12 * 1024` bytes
- [ ] scheduler tests prove `critical > visible > background`
- [ ] background read-model work is abortable and concurrency-bounded
- [ ] realtime queue tests prove oversize or overflow traffic degrades via gaps or invalidation instead of unbounded buffering
- [ ] request and perf logs expose lane, payload bytes, duration, queue depth, and dropped bytes where applicable
- [ ] raw diff JSON exists
- [ ] gate JSON exists and reports `"ok": true`
- [ ] `mobile_restricted.focusedReadyMs` regressed nowhere
- [ ] `mobile_restricted.terminalInputToFirstOutputMs` regressed nowhere in the two terminal scenarios
- [ ] offscreen-before-ready metrics regressed nowhere for either profile
- [ ] no generated audit artifact is committed

## Notes For The Executor

- Prefer deletion over compatibility shims. The prior regression came from shipping both the new and old transport at once.
- When a seam already exists, finish it. Do not create parallel route stacks, schedulers, loggers, or telemetry channels.
- If a test still encodes legacy behavior and no runtime path should preserve that behavior, rewrite or delete the test in the same task.
- If a runtime choice would preserve both a visible-first HTTP read model and an old snapshot or replay path "just in case," delete the old path instead.
- When Task 14 fails, return to the narrowest failing seam, tighten the missing regression if needed, fix it, and rerun the full gate.
- Generated audit artifacts are debugging and comparison outputs, not source files. Leave them uncommitted.

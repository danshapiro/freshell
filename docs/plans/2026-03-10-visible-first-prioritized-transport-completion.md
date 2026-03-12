# Visible-First Prioritized Transport Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Finish the accepted visible-first prioritized transport from the current partially cut over branch state by deleting the remaining hybrid websocket bulk paths, locking the spec into machine-checked contradiction gates, enforcing the surviving transport budgets, and only finishing when the trusted `mobile_restricted` audit gate passes.

**Architecture:** Treat this as a completion pass, not a redesign. The branch already contains the new HTTP-owned read-model routes, App-owned websocket startup, agent timeline read models, terminal viewport-first restore, server-side terminal search, and shared scheduler; the remaining work is to make the branch non-hybrid by proving and deleting every legacy bulk websocket/session-terminal compatibility path, then tightening the surviving HTTP plus invalidation/delta model until the audit gate is green. The landed shape remains the accepted hard cutover: HTTP owns visible snapshots, windowed directories, search, and terminal viewport or scrollback restore; WebSocket owns control, invalidation, and small live deltas only.

**Tech Stack:** Node.js, Express, `ws`, React 18, Redux Toolkit, TypeScript, Zod, Vitest, Playwright/Chromium, `tsx`

---

## Why This Revision Exists

The previous completion plan is no longer execution-safe for this worktree.

1. The branch has already landed the shared harnesses, audit-gate helper, shell bootstrap cutover, App-owned websocket bootstrap, session-directory routes and store wiring, agent timeline and snapshot restore, terminal HTTP read models, viewport-first terminal paint, terminal directory and search HTTP cutover, and the shared scheduler. Re-running the old Tasks 1 through 17 literally would tell the executor to recreate or re-delete seams that already moved.
2. The branch is still hybrid in exactly the way that caused the earlier performance failure. Current `rg` output still shows `sessions.updated`, `sessions.page`, `sessions.patch`, `sdk.history`, `terminal.list`, `terminal.meta.list`, and legacy hello capability flags in production files such as `shared/ws-protocol.ts`, `server/ws-handler.ts`, `src/App.tsx`, `src/lib/ws-client.ts`, and `src/lib/sdk-message-handler.ts`.
3. The old plan assumed the pre-cutover baseline could still be captured from this worktree before runtime edits. That is no longer true. A safe completion plan must reuse an existing trusted baseline artifact or rebuild it from a clean `main` worktree before the final compare.
4. The biggest trycycle-process miss was the lack of a first-class acceptance-contract gate. This revision makes that the first remaining task so execution cannot again claim completion while the old and new transport both still exist.
5. The previous revision still left too much of that contract as prose and ad hoc grep output, and it still omitted active branch seams such as `test/unit/client/ws-client-sdk.test.ts`, `test/e2e-browser/perf/scenarios.ts`, and `server/read-models/work-scheduler.ts`. This revision fixes the stale file lists and makes the contradiction gate executable instead of interpretive.

## Current Branch Snapshot

Already true on this branch:

1. `/api/bootstrap` is shell-only and budgeted.
2. `src/App.tsx` is already the only `ws.connect()` caller.
3. Session-directory routes, store-owned session windows, and the CLI session-directory cutover are already in place.
4. Agent timeline routes and snapshot-plus-window chat restore already exist.
5. Terminal directory, viewport, scrollback, and search routes already exist, and the client already paints terminals viewport-first from HTTP.
6. Shared read-model lane ordering already exists.
7. `/api/sessions/search`, `/api/sessions/query`, and client `SearchAddon` usage are already gone.

Still false on this branch:

1. Startup and runtime still carry legacy websocket session bulk delivery.
2. Agent chat still carries `sdk.history` compatibility.
3. Shared websocket protocol still advertises legacy capabilities and commands.
4. Terminal directory or runtime compatibility messages still survive.
5. The final full quality gate and trusted audit compare have not yet been rerun on a fully non-hybrid tree.

## Source Of Truth

Treat these documents as the authoritative spec set, in this order:

1. `docs/plans/2026-03-09-visible-first-prioritized-transport.md`
2. `docs/plans/2026-03-09-visible-first-prioritized-transport-test-plan.md`
3. `docs/plans/2026-03-10-visible-first-performance-audit.md`
4. `docs/plans/2026-03-10-visible-first-performance-audit-test-plan.md`

## Strategy Gate

This is not a stabilization branch and not a narrowing pass. It is the direct completion of the accepted hard cutover.

1. Do not redo already-landed read-model work unless a new failing test proves a regression in that seam.
2. From this point onward, every task must shrink the hybrid surface, never preserve it.
3. The direct end state is full hard cutover. No landing compatibility shims remain for bulk websocket session, SDK history, or terminal directory snapshot delivery.
4. `mobile_restricted` remains the release decision rule. If the audit gate fails there, the branch is not done.
5. `src/App.tsx` remains the sole websocket owner.
6. Hidden panes and offscreen tabs stay lazy. Visibility or explicit selection is the trigger for HTTP hydration.
7. When a task deletes a runtime path, it must rewrite or delete the positive legacy test in the same commit.
8. The accepted transport plan and test plan are authoritative. If the current code conflicts with them, the code changes, not the spec.

## Acceptance Contract

This is the branch-level acceptance contract. The executor and reviewer should use this exact list when deciding whether the branch is complete.

Required behaviors that must exist:

1. `GET /api/bootstrap` returns shell-only startup data, not session, agent, or terminal read models.
2. Session browsing and search use `/api/session-directory` only.
3. Agent chat reload uses `sdk.session.snapshot` plus HTTP timeline windows and turn-body hydration.
4. Terminal restore uses HTTP viewport first, then websocket tail replay from `tailSeq`.
5. Terminal search is server-side only.
6. WebSocket is limited to control, invalidation, and tiny live deltas. It is not a bulk snapshot transport.

Forbidden behaviors that must not exist in production code or successful transcripts:

1. `sessions.updated`
2. `sessions.page`
3. `sessions.patch`
4. `sessions.fetch`
5. `sdk.history`
6. `terminal.list`
7. `terminal.list.response`
8. `terminal.list.updated`
9. `terminal.meta.list`
10. `terminal.meta.list.response`
11. `sessionsPatchV1`
12. `sessionsPaginationV1`
13. `/api/sessions/search`
14. `/api/sessions/query`
15. `SearchAddon`
16. Any `ws.connect()` caller outside `src/App.tsx`

Required measurable outcomes:

1. Both baseline and candidate audit artifacts are trusted.
2. Every scenario and profile pair is present and `status === "ok"` in both artifacts.
3. No `mobile_restricted.focusedReadyMs` delta is positive.
4. No `mobile_restricted.terminalInputToFirstOutputMs` delta is positive for `terminal-cold-boot` or `terminal-reconnect-backlog`.
5. No positive delta appears in either profile for `offscreenHttpRequestsBeforeReady`, `offscreenHttpBytesBeforeReady`, `offscreenWsFramesBeforeReady`, or `offscreenWsBytesBeforeReady`.

Task 1 must turn this contract into two executable gates:

1. `npm run test:visible-first:contract` for focused unit or integration coverage of shared contract helpers plus real websocket transcript capture.
2. `npm run visible-first:contract:check -- --output <path>` for a JSON report that statically scans production code, checks websocket ownership, and verifies the audit-scenario allowlists do not still bless the hybrid transport.

The final reviewer should rely on that JSON report plus the audit-gate JSON, not on ad hoc grep interpretation.

## Execution Rules

1. Every task follows the same order: write failing tests, run the narrow lane and watch it fail, write the minimal implementation, rerun the same lane and watch it pass, run the listed smoke or grep proof, then commit a green state.
2. Do not reopen completed tasks from the old plan just because they existed there. Work from the current branch state.
3. If a listed task proves to contain two independent seams, split it immediately into consecutive child tasks and keep both child tasks green and separately committed.
4. If a full-suite or audit failure reveals a defect in an already-landed seam, fix the narrowest real defect, add the missing regression, commit that fix, and resume from the relevant quality gate.
5. Do not commit generated artifacts from `artifacts/perf/`.
6. Do not preserve contradictory tests. If a test still positively encodes a forbidden legacy behavior, rewrite or delete it in the same task that removes the runtime path.
7. Prefer deletion over compatibility code. The earlier regression came from paying for both the old websocket bulk path and the new HTTP read-model path at the same time.

## Files That Matter Now

Acceptance and contradiction gates:

- `test/helpers/visible-first/protocol-harness.ts`
- `test/helpers/visible-first/acceptance-contract.ts`
- `scripts/assert-visible-first-acceptance.ts`
- `test/unit/visible-first/protocol-harness.test.ts`
- `test/unit/visible-first/acceptance-contract.test.ts`
- `test/unit/lib/visible-first-acceptance-report.test.ts`
- `test/unit/client/components/App.ws-bootstrap.test.tsx`
- `test/e2e-browser/perf/scenarios.ts`
- `test/server/ws-protocol.test.ts`
- `test/server/ws-edge-cases.test.ts`
- `test/server/ws-handshake-snapshot.test.ts`
- `test/unit/client/lib/ws-client.test.ts`
- `package.json`

Remaining legacy websocket cleanup:

- `shared/ws-protocol.ts`
- `server/ws-handler.ts`
- `server/sessions-sync/service.ts`
- `server/session-history-loader.ts`
- `server/ws-chunking.ts`
- `server/terminals-router.ts`
- `server/sessions-router.ts`
- `server/agent-api/router.ts`
- `src/App.tsx`
- `src/lib/ws-client.ts`
- `src/lib/sdk-message-handler.ts`
- `src/store/agentChatTypes.ts`
- `src/store/agentChatSlice.ts`
- `src/store/agentChatThunks.ts`
- `src/components/OverviewView.tsx`
- `test/server/ws-sidebar-snapshot-refresh.test.ts`
- `test/server/ws-sessions-patch.test.ts`
- `test/server/ws-terminal-meta.test.ts`
- `test/server/ws-terminal-create-session-repair.test.ts`
- `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- `test/server/ws-terminal-stream-v2-replay.test.ts`
- `test/server/ws-protocol.test.ts`
- `test/server/ws-edge-cases.test.ts`
- `test/server/ws-handshake-snapshot.test.ts`
- `test/server/agent-panes-write.test.ts`
- `test/server/terminals-api.test.ts`
- `test/unit/server/ws-handler-sdk.test.ts`
- `test/unit/server/session-history-loader.test.ts`
- `test/unit/server/sessions-sync/service.test.ts`
- `test/unit/server/ws-chunking.test.ts`
- `test/unit/server/ws-handler-backpressure.test.ts`
- `test/unit/client/ws-client-sdk.test.ts`
- `test/unit/client/lib/ws-client.test.ts`
- `test/unit/client/sdk-message-handler.test.ts`
- `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`
- `test/unit/client/agentChatSlice.test.ts`
- `test/unit/client/store/agentChatThunks.test.ts`
- `test/unit/client/store/sessionsSlice.test.ts`
- `test/unit/client/store/terminalMetaSlice.test.ts`
- `test/unit/client/components/App.test.tsx`
- `test/unit/client/components/App.ws-bootstrap.test.tsx`
- `test/unit/client/components/component-edge-cases.test.tsx`
- `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`
- `test/e2e/auth-required-bootstrap-flow.test.tsx`
- `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- `test/e2e/sidebar-click-opens-pane.test.tsx`
- `test/e2e/pane-header-runtime-meta-flow.test.tsx`

Budget and instrumentation seams:

- `shared/read-models.ts`
- `server/read-models/work-scheduler.ts`
- `server/read-models/request-abort.ts`
- `server/request-logger.ts`
- `server/perf-logger.ts`
- `server/terminal-stream/client-output-queue.ts`
- `server/shell-bootstrap-router.ts`
- `server/sessions-router.ts`
- `server/terminals-router.ts`
- `src/lib/perf-logger.ts`
- `test/unit/server/read-models/work-scheduler.test.ts`
- `test/unit/server/request-logger.test.ts`
- `test/unit/server/perf-logger.test.ts`
- `test/unit/server/ws-handler-backpressure.test.ts`
- `test/unit/server/terminal-stream/client-output-queue.test.ts`
- `test/unit/lib/visible-first-audit-contract.test.ts`
- `test/unit/lib/visible-first-audit-network-recorder.test.ts`
- `test/unit/lib/visible-first-audit-derived-metrics.test.ts`
- `test/unit/lib/visible-first-audit-scenarios.test.ts`
- `test/integration/server/bootstrap-router.test.ts`
- `test/integration/server/session-directory-router.test.ts`
- `test/integration/server/terminal-view-router.test.ts`
- `test/e2e-browser/perf/scenarios.ts`
- `test/unit/client/lib/perf-logger.test.ts`

Final audit and compare:

- `test/e2e-browser/perf/audit-contract.ts`
- `test/e2e-browser/perf/visible-first-audit-gate.ts`
- `test/e2e-browser/perf/run-visible-first-audit.ts`
- `test/e2e-browser/perf/run-sample.ts`
- `test/e2e-browser/perf/compare-visible-first-audits.ts`
- `scripts/visible-first-audit.ts`
- `scripts/compare-visible-first-audit.ts`
- `scripts/assert-visible-first-audit-gate.ts`

## Preflight: Trusted Pre-Cutover Baseline From Clean `main`

Do this before touching more runtime code. The old preflight is stale because this worktree is already mid-cutover.

1. Ensure the artifact directory exists:

```bash
mkdir -p artifacts/perf
```

2. If `artifacts/perf/visible-first-baseline.pre-cutover.json` already exists, validate it:

```bash
npx tsx --eval "import fs from 'node:fs'; import { VisibleFirstAuditSchema, assertVisibleFirstAuditTrusted } from './test/e2e-browser/perf/audit-contract.ts'; const artifact = VisibleFirstAuditSchema.parse(JSON.parse(fs.readFileSync('artifacts/perf/visible-first-baseline.pre-cutover.json', 'utf8'))); assertVisibleFirstAuditTrusted(artifact);"
```

Expected: exit `0`.

3. If the file is missing or the validation fails, rebuild it from a disposable clean `main` worktree, not from this branch:

```bash
git -C /home/user/code/freshell worktree add /home/user/code/freshell/.worktrees/codex-visible-first-transport-baseline main
cd /home/user/code/freshell/.worktrees/codex-visible-first-transport-baseline
npm run perf:audit:visible-first -- --output /home/user/code/freshell/.worktrees/codex-visible-first-transport-v2/artifacts/perf/visible-first-baseline.pre-cutover.json
cd /home/user/code/freshell/.worktrees/codex-visible-first-transport-v2
npx tsx --eval "import fs from 'node:fs'; import { VisibleFirstAuditSchema, assertVisibleFirstAuditTrusted } from './test/e2e-browser/perf/audit-contract.ts'; const artifact = VisibleFirstAuditSchema.parse(JSON.parse(fs.readFileSync('artifacts/perf/visible-first-baseline.pre-cutover.json', 'utf8'))); assertVisibleFirstAuditTrusted(artifact);"
git -C /home/user/code/freshell worktree remove /home/user/code/freshell/.worktrees/codex-visible-first-transport-baseline
```

Expected: both audit-validation commands exit `0`.

4. Never commit the baseline artifact. It is a local comparison input only.

### Task 1: Build A Machine-Checked Acceptance-Contract Gate

**Files:**
- Create: `test/helpers/visible-first/acceptance-contract.ts`
- Create: `scripts/assert-visible-first-acceptance.ts`
- Create: `test/unit/lib/visible-first-acceptance-report.test.ts`
- Create: `test/unit/visible-first/acceptance-contract.test.ts`
- Modify: `test/helpers/visible-first/protocol-harness.ts`
- Modify: `test/unit/visible-first/protocol-harness.test.ts`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `package.json`

**Step 1: Write the failing acceptance-contract tests**

Cover:

1. the forbidden websocket types, capabilities, route strings, and ownership invariants are defined once in a shared helper
2. transcript assertions deterministically report forbidden websocket types separately from forbidden hello capabilities
3. a report evaluator merges static production-code scan results, websocket-ownership violations, and stale audit-scenario allowlists into one JSON result
4. narrow script entries exist both for the focused contract test lane and for the repo-wide JSON report command

**Step 2: Run the acceptance-contract lane**

```bash
npm run test:visible-first:contract
```

Expected: FAIL because the helper, report evaluator, and script entry do not exist yet.

**Step 3: Implement the minimal shared acceptance-contract helper and report script**

Keep the shared surface explicit:

```ts
export const FORBIDDEN_VISIBLE_FIRST_WS_TYPES = [
  'sessions.updated',
  'sessions.page',
  'sessions.patch',
  'sessions.fetch',
  'sdk.history',
  'terminal.list',
  'terminal.list.response',
  'terminal.list.updated',
  'terminal.meta.list',
  'terminal.meta.list.response',
] as const

export const FORBIDDEN_VISIBLE_FIRST_CAPABILITIES = [
  'sessionsPatchV1',
  'sessionsPaginationV1',
] as const
```

Add a report shape that the final reviewer can consume mechanically:

```ts
export type VisibleFirstAcceptanceReport = {
  ok: boolean
  staticViolations: Array<{ file: string; match: string }>
  wsOwnershipViolations: string[]
  auditScenarioViolations: Array<{
    scenarioId: string
    field: 'allowedApiRouteIdsBeforeReady' | 'allowedWsTypesBeforeReady'
    offenders: string[]
  }>
}
```

Use `test/helpers/visible-first/protocol-harness.ts` as the shared runtime-transcript seam instead of hardcoding a second forbidden list elsewhere. The script should scan `shared/`, `server/`, and `src/`, verify only `src/App.tsx` calls `ws.connect()`, inspect `test/e2e-browser/perf/scenarios.ts`, write JSON to `--output`, and exit non-zero when `ok` is `false`.

Add this script entry:

```json
"test:visible-first:contract": "vitest run test/unit/visible-first/acceptance-contract.test.ts test/unit/visible-first/protocol-harness.test.ts test/unit/lib/visible-first-acceptance-report.test.ts",
"visible-first:contract:check": "tsx scripts/assert-visible-first-acceptance.ts"
```

**Step 4: Re-run the acceptance-contract lane**

```bash
npm run test:visible-first:contract
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/helpers/visible-first/acceptance-contract.ts scripts/assert-visible-first-acceptance.ts test/unit/lib/visible-first-acceptance-report.test.ts test/unit/visible-first/acceptance-contract.test.ts test/helpers/visible-first/protocol-harness.ts test/unit/visible-first/protocol-harness.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx package.json
git commit -m "test(visible-first): add machine-checked acceptance contract gate"
```

### Task 2: Delete Legacy Session Bulk Delivery And `sdk.history`

**Files:**
- Modify: `test/server/ws-sidebar-snapshot-refresh.test.ts`
- Modify: `test/e2e/auth-required-bootstrap-flow.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `test/unit/server/sessions-sync/service.test.ts`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
- Modify: `test/unit/server/session-history-loader.test.ts`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`
- Modify: `test/unit/client/sdk-message-handler.test.ts`
- Modify: `test/unit/client/ws-client-sdk.test.ts`
- Modify: `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`
- Modify: `test/unit/client/agentChatSlice.test.ts`
- Modify: `test/unit/client/store/agentChatThunks.test.ts`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Delete: `test/server/ws-sessions-patch.test.ts`
- Delete: `test/unit/server/ws-chunking.test.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/session-history-loader.ts`
- Modify: `server/sessions-sync/service.ts`
- Delete: `server/ws-chunking.ts`
- Modify: `src/App.tsx`
- Modify: `src/lib/sdk-message-handler.ts`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/store/agentChatThunks.ts`

**Pre-approved split if the red proof exposes two seams:**

1. `Task 2A`: remove `sessions.updated`, `sessions.page`, `sessions.patch`, and chunking
2. `Task 2B`: remove `sdk.history` compatibility from server and client restore flows

If split, finish `Task 2A` fully green before `Task 2B`.

**Step 1: Write the failing cleanup tests**

Cover:

1. successful startup transcripts never emit `sessions.updated`, `sessions.page`, or `sessions.patch`
2. agent-session attach and reload never emit or consume `sdk.history`
3. `src/App.tsx` no longer buffers or applies legacy session bulk messages
4. auth-required and session-browsing flows no longer assume a websocket session snapshot arrives during bootstrap
5. positive legacy patch or chunking tests are deleted rather than preserved as compatibility debt

**Step 2: Run the session and SDK cleanup lane**

```bash
npm run test:server:standard -- test/server/ws-sidebar-snapshot-refresh.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/session-history-loader.test.ts test/unit/server/ws-handler-backpressure.test.ts
NODE_ENV=test npx vitest run test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/unit/client/sdk-message-handler.test.ts test/unit/client/ws-client-sdk.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
npm run test:visible-first:contract
```

Expected: FAIL until the legacy session and SDK bulk paths are gone.

**Step 3: Implement the minimal deletion**

The surviving agent restore model stays:

```ts
type SdkSessionSnapshotMessage = {
  type: 'sdk.session.snapshot'
  sessionId: string
  latestTurnId: string | null
  status: string
}
```

Session browsing refreshes through the existing HTTP window model, not websocket bulk snapshots. Delete chunking instead of keeping a dormant helper.

**Step 4: Re-run the session and SDK cleanup lane**

```bash
npm run test:server:standard -- test/server/ws-sidebar-snapshot-refresh.test.ts test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/session-history-loader.test.ts test/unit/server/ws-handler-backpressure.test.ts
NODE_ENV=test npx vitest run test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/unit/client/sdk-message-handler.test.ts test/unit/client/ws-client-sdk.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
npm run test:visible-first:contract
```

Expected: PASS.

**Step 5: Prove the legacy session and SDK strings are gone from production code**

```bash
rg -n "sessions\\.updated|sessions\\.page|sessions\\.patch|sdk\\.history" shared server src
```

Expected: no matches.

**Step 6: Commit**

```bash
git add test/server/ws-sidebar-snapshot-refresh.test.ts test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/unit/server/sessions-sync/service.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/session-history-loader.test.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/ws-client-sdk.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/store/sessionsSlice.test.ts test/unit/client/components/App.test.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx server/ws-handler.ts server/session-history-loader.ts server/sessions-sync/service.ts src/App.tsx src/lib/sdk-message-handler.ts src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/store/agentChatThunks.ts
git rm test/server/ws-sessions-patch.test.ts test/unit/server/ws-chunking.test.ts server/ws-chunking.ts
git commit -m "refactor(protocol): delete legacy session bulk delivery and sdk history"
```

### Task 3: Delete Legacy Terminal Commands, Terminal Meta Messages, And Hello Capabilities

**Files:**
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify: `test/server/agent-panes-write.test.ts`
- Modify: `test/server/terminals-api.test.ts`
- Modify: `test/server/ws-terminal-meta.test.ts`
- Modify: `test/server/ws-terminal-create-session-repair.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/unit/client/store/terminalMetaSlice.test.ts`
- Modify: `test/unit/client/components/component-edge-cases.test.tsx`
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminals-router.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/agent-api/router.ts`
- Modify: `src/App.tsx`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/components/OverviewView.tsx`

**Pre-approved split if the red proof exposes two seams:**

1. `Task 3A`: remove legacy hello capabilities and client commands
2. `Task 3B`: remove terminal list or meta compatibility messages and listeners

If split, finish `Task 3A` fully green before `Task 3B`.

**Step 1: Write the failing protocol cleanup tests**

Cover:

1. `hello.capabilities` no longer advertises `sessionsPatchV1` or `sessionsPaginationV1`
2. the client and server reject `sessions.fetch`, `terminal.list`, and `terminal.meta.list`
3. terminal mutations emit only the surviving tiny invalidations and runtime deltas
4. `src/App.tsx`, `src/components/OverviewView.tsx`, pane-header flows, and terminal mutation tests no longer request or consume `terminal.meta.list*` or `terminal.list.updated`

**Step 2: Run the protocol cleanup lane**

```bash
npm run test:server:standard -- test/server/agent-panes-write.test.ts test/server/terminals-api.test.ts test/server/ws-terminal-meta.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts
NODE_ENV=test npx vitest run test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/unit/client/lib/ws-client.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx
npm run test:visible-first:contract
```

Expected: FAIL until the remaining legacy protocol entries are gone.

**Step 3: Implement the minimal protocol cleanup**

Keep the handshake narrow:

```ts
type HelloCapabilities = {
  uiScreenshotV1?: boolean
}
```

Keep the surviving terminal notifications narrow:

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

Delete the shared union members and route aliases instead of leaving them dormant.

**Step 4: Re-run the protocol cleanup lane**

```bash
npm run test:server:standard -- test/server/agent-panes-write.test.ts test/server/terminals-api.test.ts test/server/ws-terminal-meta.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts
NODE_ENV=test npx vitest run test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/unit/client/lib/ws-client.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx
npm run test:visible-first:contract
```

Expected: PASS.

**Step 5: Prove the legacy terminal and capability strings are gone**

```bash
rg -n "terminal\\.list(\\.updated|\\.response)?|terminal\\.meta\\.list(\\.response)?|sessions\\.fetch|sessionsPatchV1|sessionsPaginationV1" shared server src
rg -n "ws\\.connect\\(" src
```

Expected:

1. first command: no matches
2. second command: only `src/App.tsx`

**Step 6: Commit**

```bash
git add test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/server/agent-panes-write.test.ts test/server/terminals-api.test.ts test/server/ws-terminal-meta.test.ts test/server/ws-terminal-create-session-repair.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/unit/client/lib/ws-client.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx shared/ws-protocol.ts server/ws-handler.ts server/terminals-router.ts server/sessions-router.ts server/agent-api/router.ts src/App.tsx src/lib/ws-client.ts src/components/OverviewView.tsx
git commit -m "refactor(protocol): remove legacy terminal commands and capabilities"
```

### Task 4: Enforce Scheduler Priority, Budgets, And Audit-Facing Instrumentation On The Surviving Transport

**Files:**
- Create: `test/unit/lib/visible-first-audit-scenarios.test.ts`
- Modify: `test/e2e-browser/perf/scenarios.ts`
- Modify: `test/unit/server/read-models/work-scheduler.test.ts`
- Modify: `test/unit/server/request-logger.test.ts`
- Modify: `test/unit/server/perf-logger.test.ts`
- Modify: `test/unit/server/terminal-stream/client-output-queue.test.ts`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`
- Modify: `test/unit/lib/visible-first-audit-contract.test.ts`
- Modify: `test/unit/lib/visible-first-audit-network-recorder.test.ts`
- Modify: `test/unit/lib/visible-first-audit-derived-metrics.test.ts`
- Modify: `test/unit/client/lib/perf-logger.test.ts`
- Modify: `test/integration/server/bootstrap-router.test.ts`
- Modify: `test/integration/server/session-directory-router.test.ts`
- Modify: `test/integration/server/terminal-view-router.test.ts`
- Modify: `shared/read-models.ts`
- Modify: `server/read-models/work-scheduler.ts`
- Modify: `server/read-models/request-abort.ts`
- Modify: `server/request-logger.ts`
- Modify: `server/perf-logger.ts`
- Modify: `server/terminal-stream/client-output-queue.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/shell-bootstrap-router.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/terminals-router.ts`
- Modify: `src/lib/perf-logger.ts`

**Pre-approved split if the red proof exposes two seams:**

1. `Task 4A`: payload ceilings, websocket backpressure, and bounded queue behavior
2. `Task 4B`: request and perf logging fields needed by the audit

If split, finish `Task 4A` fully green before `Task 4B`.

**Step 1: Write the failing budget and instrumentation tests**

Cover:

1. bootstrap payload stays under `12 * 1024` bytes
2. realtime frames stay under `16 * 1024` bytes or degrade through gap or invalidation behavior
3. queue overflow does not produce unbounded buffering
4. request and perf logs capture lane, payload bytes, duration, queue depth, and dropped bytes where applicable
5. live terminal input or output still outranks background read-model work
6. the audit scenario allowlists now describe the hard-cut transport: `/api/bootstrap` replaces `/api/settings`, `/api/session-directory` replaces `/api/sessions*`, and no legacy websocket types are still allowed before ready

**Step 2: Run the budget lane**

```bash
npm run test:server:standard -- test/unit/server/read-models/work-scheduler.test.ts test/unit/server/request-logger.test.ts test/unit/server/perf-logger.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/perf-logger.test.ts test/unit/lib/visible-first-audit-contract.test.ts test/unit/lib/visible-first-audit-scenarios.test.ts test/unit/lib/visible-first-audit-network-recorder.test.ts test/unit/lib/visible-first-audit-derived-metrics.test.ts
```

Expected: FAIL until the surviving transport enforces the budgets and logs the right data.

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

When updating `test/e2e-browser/perf/scenarios.ts`, remove every legacy pre-ready allowance that exists only to tolerate the hybrid transport. The scenario allowlists should describe the accepted end state, not the broken branch history.

**Step 4: Re-run the budget lane**

```bash
npm run test:server:standard -- test/unit/server/read-models/work-scheduler.test.ts test/unit/server/request-logger.test.ts test/unit/server/perf-logger.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts
NODE_ENV=test npx vitest run test/unit/client/lib/perf-logger.test.ts test/unit/lib/visible-first-audit-contract.test.ts test/unit/lib/visible-first-audit-scenarios.test.ts test/unit/lib/visible-first-audit-network-recorder.test.ts test/unit/lib/visible-first-audit-derived-metrics.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add test/e2e-browser/perf/scenarios.ts test/unit/server/read-models/work-scheduler.test.ts test/unit/server/request-logger.test.ts test/unit/server/perf-logger.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/lib/visible-first-audit-contract.test.ts test/unit/lib/visible-first-audit-scenarios.test.ts test/unit/lib/visible-first-audit-network-recorder.test.ts test/unit/lib/visible-first-audit-derived-metrics.test.ts test/unit/client/lib/perf-logger.test.ts test/integration/server/bootstrap-router.test.ts test/integration/server/session-directory-router.test.ts test/integration/server/terminal-view-router.test.ts shared/read-models.ts server/read-models/work-scheduler.ts server/read-models/request-abort.ts server/request-logger.ts server/perf-logger.ts server/terminal-stream/client-output-queue.ts server/ws-handler.ts server/shell-bootstrap-router.ts server/sessions-router.ts server/terminals-router.ts src/lib/perf-logger.ts
git commit -m "feat(transport): enforce scheduler budgets and audit instrumentation"
```

### Task 5: Run The Full Contradiction Gate, Quality Gate, And Audit Loop Until It Passes

**Files:**
- No planned source edits.
- Generated, uncommitted artifacts:
  - `artifacts/perf/visible-first-baseline.pre-cutover.json`
  - `artifacts/perf/visible-first-acceptance-report.post-cutover.json`
  - `artifacts/perf/visible-first-candidate.post-cutover.json`
  - `artifacts/perf/visible-first-diff.post-cutover.json`
  - `artifacts/perf/visible-first-gate.post-cutover.json`

**Step 1: Run the contradiction proofs**

```bash
npm run test:visible-first:contract
npm run visible-first:contract:check -- --output artifacts/perf/visible-first-acceptance-report.post-cutover.json
```

Expected:

1. contract lane: PASS
2. acceptance report command: exit `0`
3. `artifacts/perf/visible-first-acceptance-report.post-cutover.json` reports `"ok": true` with empty `staticViolations`, empty `wsOwnershipViolations`, and empty `auditScenarioViolations`

**Step 2: Run the full quality suite**

```bash
npm run lint
npm test
npm run verify
```

Expected: all PASS.

If any command fails, fix the narrowest real defect, add the missing regression if needed, commit the fix, and restart Task 5 from Step 1.

**Step 3: Capture and validate the post-cutover candidate artifact**

```bash
npm run perf:audit:visible-first -- --output artifacts/perf/visible-first-candidate.post-cutover.json
npx tsx --eval "import fs from 'node:fs'; import { VisibleFirstAuditSchema, assertVisibleFirstAuditTrusted } from './test/e2e-browser/perf/audit-contract.ts'; const artifact = VisibleFirstAuditSchema.parse(JSON.parse(fs.readFileSync('artifacts/perf/visible-first-candidate.post-cutover.json', 'utf8'))); assertVisibleFirstAuditTrusted(artifact);"
```

Expected: both commands exit `0`.

If this fails, fix the audit trust defect, commit the fix, and restart Task 5 from Step 1.

**Step 4: Produce the diff and run the machine gate**

```bash
npm run perf:audit:compare -- --base artifacts/perf/visible-first-baseline.pre-cutover.json --candidate artifacts/perf/visible-first-candidate.post-cutover.json > artifacts/perf/visible-first-diff.post-cutover.json
npm run perf:audit:gate -- --base artifacts/perf/visible-first-baseline.pre-cutover.json --candidate artifacts/perf/visible-first-candidate.post-cutover.json > artifacts/perf/visible-first-gate.post-cutover.json
```

Expected:

1. both commands exit `0`
2. `artifacts/perf/visible-first-gate.post-cutover.json` reports `"ok": true`

If the gate fails, go back to the narrowest failing seam, add or tighten the missing regression, fix the product, commit the fix, and restart Task 5 from Step 1. Do not stop at the first bad comparison.

**Step 5: Confirm generated artifacts stay uncommitted**

```bash
git status --short
```

Expected: source changes only if Step 1 through Step 4 required a real fix; `artifacts/perf/*.json` remain untracked or ignored and never staged.

## Final Verification Checklist

- [ ] trusted pre-cutover baseline artifact exists
- [ ] acceptance-report JSON exists
- [ ] trusted post-cutover candidate artifact exists
- [ ] `npm run test:visible-first:contract` passes
- [ ] `npm run visible-first:contract:check -- --output artifacts/perf/visible-first-acceptance-report.post-cutover.json` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] `npm run verify` passes
- [ ] acceptance-report JSON reports `"ok": true`
- [ ] bootstrap payload stays under `12 * 1024` bytes
- [ ] realtime queue overflow degrades by gap or invalidation instead of unbounded buffering
- [ ] request and perf logs expose lane, payload bytes, duration, queue depth, and dropped bytes where applicable
- [ ] scheduler still prioritizes `critical` over `visible` over `background`
- [ ] audit scenario allowlists no longer bless `/api/settings`, `/api/sessions*`, `sdk.history`, `sessions.updated`, `sessions.patch`, `terminal.list*`, or `terminal.meta.list*` before ready
- [ ] both audit artifacts validate as trusted
- [ ] diff JSON exists
- [ ] gate JSON exists
- [ ] gate JSON reports `"ok": true`
- [ ] no `mobile_restricted.focusedReadyMs` regression remains
- [ ] no terminal input-to-first-output regression remains in `terminal-cold-boot` or `terminal-reconnect-backlog`
- [ ] no offscreen-before-ready regression remains in either profile
- [ ] no generated audit artifact is committed

## Notes For The Executor

1. The remaining work is not “finish some cleanup later.” The remaining work is the cleanup. The branch is not done until the hybrid transport is gone.
2. The acceptance-contract task comes first because that is the highest-leverage trycycle-process correction from the previous failure. Use it as the contradiction gate for the rest of the branch.
3. Do not preserve old runtime tests as documentation. If they encode forbidden behavior positively, rewrite or delete them.
4. Do not reintroduce compatibility messages to make a test or audit easier. Fix the surviving HTTP or delta path instead.
5. If the audit gate fails, continue the loop until it passes. The user explicitly asked for completion, not a partial landing plus a report.
6. When you delete a legacy transport path, update the audit scenario allowlists in the same commit. Leaving the audit harness tolerant of the hybrid transport recreates the exact trycycle failure this revision is fixing.

# Visible-First Prioritized Transport Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Finish the visible-first prioritized transport cutover in one pass, remove every remaining hybrid legacy transport path, enforce visibility-gated hydration, and block landing unless the full automated suite plus the mobile-restricted performance audit gate pass.

**Architecture:** Keep the 2026-03-09 server-authoritative visible-first architecture. The failure was not the end state; it was landing a hybrid tree that still shipped legacy websocket/session snapshot behavior and extra hidden-surface startup work. This replan therefore does not add another transition layer. It completes the cutover directly: server-owned read-model HTTP for visible state, websocket v4 for live deltas only, and explicit machine-enforced pre/post audit gates.

**Tech Stack:** Node.js, Express, `ws`, React 18, Redux Toolkit, TypeScript, Zod, Vitest, Playwright/Chromium audit harness, `tsx`

---

## Strategy Gate

- Treat `docs/plans/2026-03-09-visible-first-prioritized-transport.md` as the architecture and wire-contract source of truth. Do not invent a new protocol.
- Treat `docs/plans/2026-03-09-visible-first-prioritized-transport-test-plan.md` as the coverage source of truth. Any stale test that still encodes legacy behavior must be rewritten or deleted in the same cutover, not worked around.
- Treat `docs/plans/2026-03-10-visible-first-performance-audit.md` and `docs/plans/2026-03-10-visible-first-performance-audit-test-plan.md` as the performance source of truth. The audit stays six scenarios times two profiles. Do not narrow the matrix.
- Do not preserve hybrid compatibility:
  - no `sessions.updated`, `sessions.page`, `sessions.patch`, `sessions.fetch`
  - no `terminal.list*` or `terminal.meta.list*`
  - no `sdk.history`
  - no legacy `/api/sessions`, `/api/sessions/search`, or `/api/sessions/query` shadow paths
  - no child `ws.connect()` ownership
  - no hidden or offscreen pane hydration during startup
- The postmortem gap around secondary startup chatter is real. Explicitly fix it:
  - sidebar and session-directory fetches only when the sidebar or projects view is visible
  - terminal-directory fetches only when a surface that renders terminal lists is visible
  - offscreen tabs do not create, attach, or timeline-hydrate until selected
  - `/api/version`, network diagnostics, codex activity, and other secondary shell work stay background and must not win races against focused-surface paint
- Do not stop on the first failed performance compare. Keep fixing and rerunning in the same trycycle until the quality gates pass.

## Files That Matter

- Architecture and test sources:
  - `docs/plans/2026-03-09-visible-first-prioritized-transport.md`
  - `docs/plans/2026-03-09-visible-first-prioritized-transport-test-plan.md`
  - `docs/plans/2026-03-10-visible-first-performance-audit.md`
  - `docs/plans/2026-03-10-visible-first-performance-audit-test-plan.md`
- Protocol and server:
  - `shared/ws-protocol.ts`
  - `server/ws-handler.ts`
  - `server/index.ts`
  - `server/sessions-router.ts`
  - `server/terminals-router.ts`
  - `server/shell-bootstrap-router.ts`
  - `server/session-history-loader.ts`
  - `server/terminal-view/service.ts`
  - `server/terminal-stream/broker.ts`
  - `server/ws-chunking.ts`
  - `server/session-pagination.ts`
  - `server/routes/sessions.ts`
  - `server/routes/terminals.ts`
- Client bootstrap and visible hydration:
  - `src/App.tsx`
  - `src/lib/api.ts`
  - `src/lib/ws-client.ts`
  - `src/lib/sdk-message-handler.ts`
  - `src/components/Sidebar.tsx`
  - `src/components/OverviewView.tsx`
  - `src/components/BackgroundSessions.tsx`
  - `src/components/SessionView.tsx`
  - `src/components/TabContent.tsx`
  - `src/components/TerminalView.tsx`
  - `src/components/agent-chat/AgentChatView.tsx`
  - `src/components/terminal/terminal-runtime.ts`
  - `src/components/terminal/TerminalSearchBar.tsx`
  - `src/store/sessionsSlice.ts`
  - `src/store/sessionsThunks.ts`
  - `src/store/terminalDirectoryThunks.ts`
  - `src/store/agentChatThunks.ts`
  - `src/store/selectors/sidebarSelectors.ts`
  - `src/store/terminalMetaSlice.ts`
- Perf gate tooling:
  - `test/e2e-browser/perf/audit-contract.ts`
  - `test/e2e-browser/perf/compare-visible-first-audits.ts`
  - `scripts/compare-visible-first-audit.ts`
  - `package.json`
  - create `test/e2e-browser/perf/visible-first-audit-gate.ts`
  - create `scripts/assert-visible-first-audit-gate.ts`
- High-risk stale tests to rewrite or delete in the same pass:
  - `test/server/ws-protocol.test.ts`
  - `test/server/ws-edge-cases.test.ts`
  - `test/server/ws-handshake-snapshot.test.ts`
  - `test/server/ws-sidebar-snapshot-refresh.test.ts`
  - `test/server/ws-terminal-meta.test.ts`
  - `test/unit/server/ws-chunking.test.ts`
  - `test/unit/server/ws-handler-backpressure.test.ts`
  - `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
  - `test/e2e/sidebar-click-opens-pane.test.tsx`
  - `test/e2e/pane-header-runtime-meta-flow.test.tsx`
  - `test/unit/client/components/BackgroundSessions.test.tsx`
  - `test/unit/client/components/component-edge-cases.test.tsx`
  - `test/unit/client/store/terminalMetaSlice.test.ts`
  - `test/unit/client/lib/api.test.ts`
  - bootstrap and app tests under `test/unit/client/components/App*.test.tsx` and `test/e2e/*bootstrap*`

## Preflight: Baseline Artifact

Do this before changing runtime code, and do not commit the generated files.

1. Create the artifact directory if it is missing:

```bash
mkdir -p artifacts/perf
```

2. Capture the current baseline:

```bash
npm run perf:audit:visible-first -- --output artifacts/perf/visible-first-baseline.pre-cutover.json
```

3. Validate the baseline is trustworthy:

```bash
npx tsx --eval "import fs from 'node:fs'; import { VisibleFirstAuditSchema, assertVisibleFirstAuditTrusted } from './test/e2e-browser/perf/audit-contract.ts'; const artifact = VisibleFirstAuditSchema.parse(JSON.parse(fs.readFileSync('artifacts/perf/visible-first-baseline.pre-cutover.json', 'utf8'))); assertVisibleFirstAuditTrusted(artifact);"
```

Expected: exit `0`. If this fails, fix the audit harness or environment first and rerun until the baseline is trusted.

### Task 1: Add A Machine-Enforced Visible-First Landing Gate

**Files:**
- Create: `test/e2e-browser/perf/visible-first-audit-gate.ts`
- Create: `scripts/assert-visible-first-audit-gate.ts`
- Create: `test/unit/lib/visible-first-audit-gate.test.ts`
- Modify: `package.json`

**Step 1: Write the failing gate tests**

Cover these exact rules:
- both artifacts must pass `assertVisibleFirstAuditTrusted(...)`
- any positive delta in `mobile_restricted.focusedReadyMs` fails
- any positive delta in `offscreenHttpRequestsBeforeReady`, `offscreenHttpBytesBeforeReady`, `offscreenWsFramesBeforeReady`, or `offscreenWsBytesBeforeReady` fails for either profile
- the script prints JSON only and exits non-zero on violations

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-gate.test.ts
```

Expected: FAIL because the gate helper and CLI do not exist yet.

**Step 2: Implement the gate helper and CLI**

- Build the gate helper on top of `compareVisibleFirstAudits(...)`.
- Keep the output machine-readable:
  - `ok: boolean`
  - `violations: []`
  - include per-scenario, per-profile metric deltas for every violation
- Add a package script:

```json
"perf:audit:gate": "tsx scripts/assert-visible-first-audit-gate.ts"
```

**Step 3: Re-run the gate tests**

Run:

```bash
npm run test:client:standard -- test/unit/lib/visible-first-audit-gate.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add test/e2e-browser/perf/visible-first-audit-gate.ts scripts/assert-visible-first-audit-gate.ts test/unit/lib/visible-first-audit-gate.test.ts package.json
git commit -m "test(perf): add visible-first landing gate"
```

### Task 2: Make The Hybrid Transport Failure Red In Server And Client Tests

**Files:**
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/server/ws-sidebar-snapshot-refresh.test.ts`
- Modify: `test/server/ws-terminal-meta.test.ts`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Modify: `test/unit/client/ws-client-sdk.test.ts`

**Step 1: Rewrite the protocol tests to forbid legacy messages entirely**

Make the failing assertions explicit:
- `hello.capabilities` no longer mentions `sessionsPatchV1` or `sessionsPaginationV1`
- `terminal.list`, `terminal.meta.list`, and `sessions.fetch` are invalid client messages
- successful transcripts never emit `sessions.updated`, `sessions.page`, `sessions.patch`, `terminal.list.response`, `terminal.meta.list.response`, or `sdk.history`

**Step 2: Run the focused protocol lane**

```bash
npm test -- test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/server/ws-terminal-meta.test.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/client/lib/ws-client.test.ts test/unit/client/ws-client-sdk.test.ts
```

Expected: FAIL against the current hybrid tree.

**Step 3: Commit the red protocol expectations**

```bash
git add test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-handshake-snapshot.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/server/ws-terminal-meta.test.ts test/unit/server/ws-handler-backpressure.test.ts test/unit/client/lib/ws-client.test.ts test/unit/client/ws-client-sdk.test.ts
git commit -m "test(protocol): make hybrid visible-first transport fail"
```

### Task 3: Delete Legacy WebSocket And Shadow REST Paths In One Cutover

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/session-history-loader.ts`
- Delete: `server/ws-chunking.ts`
- Delete: `server/session-pagination.ts`
- Delete: `server/routes/sessions.ts`
- Delete: `server/routes/terminals.ts`

**Step 1: Remove legacy protocol surface from the shared schema**

Delete:
- `sessions.updated`, `sessions.page`, `sessions.patch`, `sessions.fetch`
- `terminal.list`, `terminal.list.response`, `terminal.list.updated`
- `terminal.meta.list`, `terminal.meta.list.response`
- `sessionsPatchV1`, `sessionsPaginationV1`
- any remaining server message or comment that still frames turn replay as `sdk.history`

**Step 2: Remove the matching server branches**

Delete from `WsHandler`:
- chunked session snapshot send paths
- session pagination fetch path
- terminal list request and response path
- terminal meta snapshot request and response path
- legacy capability bookkeeping

Keep:
- websocket v4 `ready`
- terminal live deltas and lifecycle
- `sessions.changed`
- `terminals.changed`
- `terminal.runtime.updated`
- SDK live messages plus `sdk.session.snapshot`

**Step 3: Remove shadow REST APIs and dead helpers**

- Delete `/api/sessions`, `/api/sessions/search`, and `/api/sessions/query`
- keep only `/api/session-directory` for session read models
- keep only `/api/terminals` read-model routes from `server/terminals-router.ts`
- clean `server/index.ts` so no deleted router or module is still imported or mounted

**Step 4: Re-run the focused protocol lane**

Run the same command from Task 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts server/index.ts server/sessions-router.ts server/session-history-loader.ts
git rm server/ws-chunking.ts server/session-pagination.ts server/routes/sessions.ts server/routes/terminals.ts
git commit -m "feat(protocol): remove legacy bulk transport and shadow routes"
```

### Task 4: Remove Legacy Bootstrap Fallbacks And Make Visibility The Hydration Trigger

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/lib/api.ts`
- Modify: `src/components/SessionView.tsx`
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/e2e/auth-required-bootstrap-flow.test.tsx`

**Step 1: Add failing app and bootstrap regressions for the missing cutover rules**

Make the tests fail until all of these are true:
- `App` does not consume `sessions.updated` or `sessions.patch`
- `App` does not call `loadLegacyBootstrap()` or fall back to `/api/settings` plus `/api/platform`
- `SessionView` no longer calls `ws.connect()`
- auth failure after `/api/bootstrap` stops focused-pane hydration instead of recovering through websocket state
- `/api/version` and network diagnostics do not gate focused-pane startup

Run:

```bash
npm test -- test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx
```

Expected: FAIL on the still-live compatibility branches.

**Step 2: Remove the legacy fallback and child websocket ownership**

- `App.tsx` remains the sole websocket owner.
- Delete `loadLegacyBootstrap()`.
- Keep `/api/bootstrap` as the single shell bootstrap request.
- Remove `SessionView`'s `ws.connect()` path.
- Do not start secondary shell work before the focused pane and visible-surface hydration intents are scheduled.

**Step 3: Re-run the focused app and bootstrap lane**

Run the same command as above.

Expected: PASS.

**Step 4: Commit**

```bash
git add src/App.tsx src/lib/api.ts src/components/SessionView.tsx test/unit/client/components/App.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx
git commit -m "refactor(app): remove legacy bootstrap and child ws ownership"
```

### Task 5: Stop Secondary Startup Chatter From Sidebar And Terminal Directory Surfaces

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/OverviewView.tsx`
- Modify: `src/components/BackgroundSessions.tsx`
- Modify: `src/store/sessionsThunks.ts`
- Modify: `src/store/terminalDirectoryThunks.ts`
- Modify: `src/store/sessionsSlice.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `test/unit/client/components/Sidebar.test.tsx`
- Modify: `test/unit/client/components/BackgroundSessions.test.tsx`
- Modify: `test/unit/client/components/App.lazy-views.test.tsx`
- Modify: `test/unit/client/components/App.mobile.test.tsx`
- Modify: `test/unit/client/components/App.mobile-landscape.test.tsx`
- Modify: `test/unit/client/components/App.swipe-sidebar.test.tsx`
- Modify: `test/unit/client/components/App.swipe-tabs.test.tsx`

**Step 1: Write the failing visibility-gate tests**

Lock in these rules:
- Sidebar does not fetch session-directory or terminal-directory windows until the sidebar or projects surface is actually visible.
- `OverviewView` and `BackgroundSessions` do not poll or hydrate while offscreen.
- Hidden and collapsed startup must not trigger terminal-directory fetches just because the component mounted.
- legacy `/api/sessions*` helpers are no longer used by any startup test.

**Step 2: Implement the visibility gates**

- Remove the unconditional mount-time `fetch*Window()` effects and interval refresh loops.
- Use actual visibility state:
  - sidebar open or projects view
  - overview view active
  - background sessions surface active
- Keep refresh via websocket invalidations and explicit user actions, not polling.

**Step 3: Re-run the focused visibility lane**

```bash
npm test -- test/unit/client/components/Sidebar.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/components/Sidebar.tsx src/components/OverviewView.tsx src/components/BackgroundSessions.tsx src/store/sessionsThunks.ts src/store/terminalDirectoryThunks.ts src/store/sessionsSlice.ts src/store/selectors/sidebarSelectors.ts test/unit/client/components/Sidebar.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/unit/client/components/App.swipe-sidebar.test.tsx test/unit/client/components/App.swipe-tabs.test.tsx
git commit -m "refactor(client): gate directory hydration by visible surfaces"
```

### Task 6: Finish Viewport-First Terminal Restore And Remove Client-Side Search

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/terminal/terminal-runtime.ts`
- Modify: `src/components/terminal/TerminalSearchBar.tsx`
- Modify: `src/lib/api.ts`
- Modify: `server/terminals-router.ts`
- Modify: `server/terminal-view/service.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/unit/client/components/terminal/terminal-runtime.test.ts`
- Modify: `test/integration/server/terminal-view-router.test.ts`
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`

**Step 1: Add the failing terminal cutover tests**

Make the tests red until all of these are true:
- `TerminalView` hydrates from `GET /api/terminals/:terminalId/viewport` before websocket replay
- reconnect uses `tailSeq` from the viewport snapshot and only requests the short tail over websocket
- pane chrome and runtime metadata come from viewport payloads plus `terminal.runtime.updated`, not a meta snapshot request
- search no longer depends on `SearchAddon`

**Step 2: Implement the real viewport-first path**

- Replace the pseudo-viewport `terminal.attach { sinceSeq: 0 }` path with HTTP viewport hydration.
- Keep websocket attach only for live tail recovery and ongoing deltas.
- Remove `SearchAddon` from `terminal-runtime.ts`.
- Route terminal search through the server read-model APIs.
- Keep the search bar UI, but back it with server results instead of client buffer scanning.

**Step 3: Re-run the focused terminal lane**

```bash
npm test -- test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/integration/server/terminal-view-router.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/components/TerminalView.tsx src/components/terminal/terminal-runtime.ts src/components/terminal/TerminalSearchBar.tsx src/lib/api.ts server/terminals-router.ts server/terminal-view/service.ts server/terminal-stream/broker.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/terminal/terminal-runtime.test.ts test/integration/server/terminal-view-router.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx
git commit -m "feat(terminal): ship viewport-first restore and server search"
```

### Task 7: Prevent Hidden Tabs And Hidden Agent Panes From Hydrating Early

**Files:**
- Modify: `src/components/TabContent.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/store/agentChatThunks.ts`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`

**Step 1: Add failing hidden-pane and offscreen-tab regressions**

Lock in:
- hidden terminal panes do not send `terminal.create` or `terminal.attach`
- hidden agent panes do not send `sdk.create`, `sdk.attach`, or timeline fetches
- selecting an offscreen tab triggers the first hydration for that tab
- the old test mocks that auto-reply to `terminal.list` or `sessions.updated` are removed

**Step 2: Implement the hidden-pane gate**

- `hidden` must block create, attach, and timeline hydrate effects, not just layout and focus.
- When a tab becomes visible, hydrate once and then switch to live delta mode.
- Preserve persisted state so selection still restores the correct pane and session quickly.

**Step 3: Re-run the focused hidden-pane lane**

```bash
npm test -- test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/components/TabContent.tsx src/components/TerminalView.tsx src/components/agent-chat/AgentChatView.tsx src/store/agentChatThunks.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "refactor(client): defer hidden pane hydration until selection"
```

### Task 8: Remove Legacy Client Session Helpers And Clean The Remaining Test Surface

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `test/unit/client/lib/api.test.ts`
- Modify: `test/unit/client/store/terminalMetaSlice.test.ts`
- Modify: `test/unit/client/components/component-edge-cases.test.tsx`
- Modify: `test/e2e/terminal-font-settings.test.tsx`
- Modify: `test/e2e/mobile-sidebar-fullwidth-flow.test.tsx`
- Modify: `test/unit/client/components/App.ws-extensions.test.tsx`

**Step 1: Delete the stale public client helpers**

Remove `fetchSidebarSessionsSnapshot()` and `searchSessions()` from `src/lib/api.ts` if nothing in production uses them. Update the tests to assert only the visible-first endpoints.

**Step 2: Remove snapshot-oriented terminal meta test expectations**

- `terminalMetaSlice` should keep delta upsert and remove behavior only.
- rewrite tests that still assume snapshot replacement from `terminal.meta.list.response`

**Step 3: Re-run the focused cleanup lane**

```bash
npm test -- test/unit/client/lib/api.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/e2e/terminal-font-settings.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/unit/client/components/App.ws-extensions.test.tsx
```

Expected: PASS.

**Step 4: Commit**

```bash
git add src/lib/api.ts test/unit/client/lib/api.test.ts test/unit/client/store/terminalMetaSlice.test.ts test/unit/client/components/component-edge-cases.test.tsx test/e2e/terminal-font-settings.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/unit/client/components/App.ws-extensions.test.tsx
git commit -m "test(client): remove remaining legacy transport assumptions"
```

### Task 9: Run The Full Quality Gates Until They Pass

**Files:**
- No deliberate source edits in this task.
- Generated, uncommitted artifacts:
  - `artifacts/perf/visible-first-baseline.pre-cutover.json`
  - `artifacts/perf/visible-first-candidate.post-cutover.json`
  - `artifacts/perf/visible-first-diff.post-cutover.json`
  - `artifacts/perf/visible-first-gate.post-cutover.json`

**Step 1: Run the full automated suite**

```bash
npm test
npm run verify
```

Expected: both PASS.

If either command fails, fix the real defect and rerun both commands before continuing. Do not waive failures.

**Step 2: Run the static legacy-transport invariants**

Production code must have no remaining legacy transport strings:

```bash
rg -n "sessions\\.updated|sessions\\.page|sessions\\.patch|sessions\\.fetch|terminal\\.list\\.updated|terminal\\.list\\.response|terminal\\.meta\\.list|terminal\\.meta\\.list\\.response|sdk\\.history|sessionsPatchV1|sessionsPaginationV1" shared server src
```

Expected: no matches.

Only `src/App.tsx` may own websocket connect:

```bash
rg -n "ws\\.connect\\(" src
```

Expected: the only app and runtime caller is `src/App.tsx`.

No production code may still use the deleted sessions shadow APIs:

```bash
rg -n "/api/sessions|/api/sessions/search|/api/sessions/query" src server
```

Expected: no matches.

**Step 3: Capture the post-cutover candidate artifact**

```bash
npm run perf:audit:visible-first -- --output artifacts/perf/visible-first-candidate.post-cutover.json
```

**Step 4: Produce the raw diff and gate result**

```bash
npm run perf:audit:compare -- --base artifacts/perf/visible-first-baseline.pre-cutover.json --candidate artifacts/perf/visible-first-candidate.post-cutover.json > artifacts/perf/visible-first-diff.post-cutover.json
npm run perf:audit:gate -- --base artifacts/perf/visible-first-baseline.pre-cutover.json --candidate artifacts/perf/visible-first-candidate.post-cutover.json > artifacts/perf/visible-first-gate.post-cutover.json
```

Expected:
- both commands exit `0`
- `artifacts/perf/visible-first-gate.post-cutover.json` reports `"ok": true`

If the gate fails, keep fixing the product and rerunning Task 9 from Step 1 until the gate passes. Do not stop at the first bad comparison.

**Step 5: Commit the verified code state**

Do not add generated audit artifacts.

```bash
git status --short
git add shared server src test scripts package.json
git commit -m "feat(perf): complete visible-first prioritized transport cutover"
```

## Final Verification Checklist

- [ ] `npm test` passes
- [ ] `npm run verify` passes
- [ ] production grep has no legacy transport strings
- [ ] only `src/App.tsx` calls `ws.connect()`
- [ ] no production `/api/sessions*` shadow API usage remains
- [ ] baseline and candidate audit artifacts are both trusted
- [ ] raw diff JSON exists
- [ ] gate JSON exists and reports `"ok": true`
- [ ] mobile restricted `focusedReadyMs` regressed nowhere
- [ ] offscreen before-ready metrics regressed nowhere
- [ ] no generated audit artifact is committed

## Notes For The Executor

- Use the 2026-03-09 architecture and test-plan docs for the exact route contracts, message contracts, and scenario expectations. This completion plan exists to force direct execution against the current hybrid tree and to make the landing gate explicit.
- Prefer deletion over compatibility shims. If a deleted path is still needed by a test, the test is stale until proven otherwise.
- If a runtime choice seems to preserve both the new read-model path and an old snapshot path "just in case," choose the deletion path. The previous regression came from exactly that compromise.

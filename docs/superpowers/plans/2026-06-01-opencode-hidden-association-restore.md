# OpenCode Hidden Association Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a tested fix for OpenCode tabs that fail to restore after browser refresh/reopen when the server learns the OpenCode session association while the browser page is closed or the OpenCode pane is hidden.

**Current State:** The production reconciliation code from PR #380 is already merged into `origin/main`. Do not recreate it. This plan implements and lands the missing browser-level regression coverage that proves the real failure red on a pre-fix base and green on the current branch.

**Architecture:** The server remains authoritative for terminal-to-session ownership. The browser reconciles every authoritative `{ terminalId, sessionRef }` association from WebSocket events, including the `terminal.inventory` WebSocket message, into pane layout and single-pane tab metadata, then flushes durable layout state. Hidden panes must be reconciled even when `TerminalView` is unmounted.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, WebSocket messages, Playwright browser E2E, Node fake OpenCode fixture.

---

## Scope

This plan covers the OpenCode refresh/reopen failure only. It does not add sidebar project/session search matching, generic `resumeSessionId` fallback, or new end-user features.

The remaining code changes should be limited to:

- `test/e2e-browser/fixtures/fake-opencode.cjs`
- `test/e2e-browser/specs/opencode-restart-recovery.spec.ts`
- This plan file, if it needs execution notes updated

The production reconciliation files should be verified, not edited, unless the audit in Task 1 proves the current branch is missing code:

- `src/lib/terminal-session-association.ts`
- `src/store/panesSlice.ts`
- `src/App.tsx`
- `src/components/TerminalView.tsx`
- `test/unit/client/components/App.ws-bootstrap.test.tsx`
- `test/unit/client/components/TerminalView.resumeSession.test.tsx`

If any production reconciliation prerequisite is missing, stop and update this plan before implementing. Do not add duplicate reducers, imports, WebSocket handlers, helper files, or tests.

---

## Task 1: Audit The Existing Production Fix

Purpose: confirm the branch already has the merged production behavior that the E2E regression is meant to protect.

- [ ] Run:

```bash
git status --short --branch
git rev-list --left-right --count origin/main...HEAD
```

Expected:

- The branch may be ahead by plan/test commits.
- It must include `origin/main`.
- There should be no unrelated production edits.

- [ ] Verify the shared reconciliation helper exists:

```bash
rg -n "export function reconcileTerminalSessionAssociation|sessionRefByTerminalId|flushPersistedLayoutNow" src/lib/terminal-session-association.ts
```

Expected:

- The file exists.
- It exports `reconcileTerminalSessionAssociation`.
- It can reconcile a terminal by `terminalId`.
- It flushes persistence after updating layout state.

- [ ] Verify the pane reducer exists exactly once:

```bash
rg -n "reconcileTerminalSessionRefByTerminalId" src/store/panesSlice.ts
```

Expected:

- Exactly one reducer definition.
- Exactly one generated action export or action usage for that reducer.

- [ ] Verify App-level authoritative association replay:

```bash
rg -n "reconcileTerminalSessionAssociation|terminal\\.session\\.associated|terminal\\.attach\\.ready|terminal\\.created|terminal\\.inventory" src/App.tsx
```

Expected:

- `App.tsx` imports `reconcileTerminalSessionAssociation`.
- `terminal.created`, `terminal.attach.ready`, and `terminal.session.associated` route server-provided session refs through the helper.
- Startup terminal inventory routes existing server session refs through the helper.

- [ ] Verify active `TerminalView` code uses the same helper:

```bash
rg -n "reconcileTerminalSessionAssociation|terminal\\.created|terminal\\.session\\.associated|terminal\\.attach\\.ready" src/components/TerminalView.tsx
```

Expected:

- `TerminalView.tsx` imports `reconcileTerminalSessionAssociation`.
- Active pane events use the same helper as hidden pane events.

- [ ] Verify existing unit coverage for the production reconciliation:

```bash
rg -n "recovers an OpenCode sessionRef from inventory|terminal\\.session\\.associated|terminal\\.attach\\.ready|tracks OpenCode session associations|uses associated OpenCode session identity" test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx
```

Expected:

- App tests cover inventory and WebSocket association replay.
- TerminalView tests cover active pane association behavior.

Do not add new unit tests in this task unless one of the expected existing tests is absent. If a test is absent, first inspect the current file harness and add a test using the actual local helper APIs in that file.

---

## Task 2: Add The Fake OpenCode Session Event Gate

Purpose: allow the browser E2E test to create a real OpenCode terminal, send input to it, close the page before the server learns the canonical session, then release the delayed OpenCode session events.

File: `test/e2e-browser/fixtures/fake-opencode.cjs`

- [ ] Add these environment controls near the existing `sessionArg` setup:

```js
const sessionEventGatePath = process.env.FAKE_OPENCODE_SESSION_EVENT_GATE_PATH
```

- [ ] Add `emitSessionEvents(res)` and `scheduleSessionEvents(res)` near the SSE event-client setup.

Required behavior:

- Without `FAKE_OPENCODE_SESSION_EVENT_GATE_PATH`, preserve existing behavior and emit `session.created` plus `session.idle` after the original 100ms delay.
- With `FAKE_OPENCODE_SESSION_EVENT_GATE_PATH`, poll for that file and emit events only after it exists.
- If the response is destroyed before release, stop polling.
- Append one audit event when the session events are emitted:

```js
appendAudit({
  event: 'session_events_emitted',
  rootSessionId,
  childSessionId,
})
```

- [ ] Replace the existing inline `setTimeout` in the `/event` route with:

```js
scheduleSessionEvents(res)
```

- [ ] Keep launch and stdin audit behavior unchanged. The regression test depends on the launch audit having no `sessionArg` and on stdin audit records being keyed to the root session id.

---

## Task 3: Add Browser E2E Coverage For Refresh Survival

Purpose: prove the actual user-visible behavior with browser state, server inventory, tab persistence, and real fake-OpenCode process IO.

File: `test/e2e-browser/specs/opencode-restart-recovery.spec.ts`

- [ ] Extend `createServerOptions` with optional `fakeOpencodeSessionEventGatePath` and pass it as `FAKE_OPENCODE_SESSION_EVENT_GATE_PATH` when provided.

- [ ] Add:

```ts
const TAB_REGISTRY_SYNC_INTERVAL_MS = 5000
```

Use this constant only where the test must wait for the tab-registry sync loop.

- [ ] Preserve or add the UI refresh helper:

```ts
async function addOpenCodeTabThroughUi(page: any, cwd: string): Promise<string>
```

Required behavior:

- Creates an OpenCode tab through the real UI.
- Returns the created tab id.
- Avoids test-only direct Redux state setup for this UI-path test.

- [ ] Preserve or add the audit helpers:

```ts
async function waitForInitialOpenCodeLaunch(auditLogPath: string): Promise<FakeAuditEvent>
async function waitForSessionEventsEmitted(auditLogPath: string, sessionId: string): Promise<void>
```

Required behavior:

- `waitForInitialOpenCodeLaunch` finds a launch event with no `sessionArg` and a root session id.
- `waitForSessionEventsEmitted` waits for the gate-release audit for the expected root session id.

- [ ] Preserve or add this UI-path refresh test:

```ts
test('reattaches a UI-created OpenCode pane across browser refresh', async ({ page }) => {
  // ...
})
```

Required proof:

- Creates an OpenCode pane through the UI.
- Verifies the pane is associated with an OpenCode session.
- Refreshes the browser.
- Verifies the same pane/tab reattaches to the same OpenCode session.

- [ ] Add the hidden association regression test:

```ts
test('recovers a hidden OpenCode sessionRef when association lands while the browser is closed', async ({ page }) => {
  // ...
})
```

Required proof:

- Starts an isolated `TestServer` with the fake OpenCode session-event gate.
- Creates an actual OpenCode tab through the E2E harness.
- Waits only for the terminal to be running and asserts the pane naturally has no `sessionRef` yet.
- Waits for the initial fake OpenCode launch audit and records its root session id.
- Sends input to the OpenCode terminal and verifies the fake process receives it for that root session.
- Creates a shell tab and makes it active so the OpenCode pane is hidden.
- Flushes persisted layout and asserts the persisted OpenCode tab and pane do not yet have `sessionRef`.
- Closes the browser page.
- Releases the fake OpenCode session event gate.
- Verifies `/api/terminals` reports the original terminal id now has `{ provider: 'opencode', sessionId: expectedRootSessionId }`.
- Opens a new page in the same browser context while the shell tab is active.
- Verifies the hidden OpenCode pane/tab regains the same `sessionRef` and terminal id from server inventory.
- Verifies `tabs.sync.push` sends that recovered `sessionRef`.
- Activates the OpenCode tab, sends input again, and verifies the same root session receives it.

- [ ] Preserve or add this associated refresh test:

```ts
test('preserves an associated OpenCode pane across browser refresh', async ({ page }) => {
  // ...
})
```

Required proof:

- Starts with an already associated OpenCode pane.
- Refreshes the browser.
- Verifies the association survives and the pane remains usable.

Do not assert a hard-coded total number of tests in this spec. The expected count is whatever Playwright reports after the current branch's spec contents are finalized.

---

## Task 4: Prove The Regression Test Is Red On The Pre-Client-Reconciliation Base

Purpose: prove the new hidden-association test reproduces the real browser failure before the client-side hidden-pane reconciliation fix, not just a synthetic missing-localStorage theory.

- [ ] Create a temporary worktree at `8e1492b4`, the pre-client-reconciliation base used for this red proof:

```bash
git worktree add /tmp/freshell-opencode-hidden-association-red 8e1492b4
```

This base already contains the server-side session reference exposure from PR #380. That is intentional: the failure being reproduced is the browser failing to reconcile a server-known OpenCode `sessionRef` into a hidden pane. If `8e1492b4` is unavailable, use a commit after `/api/terminals` exposes OpenCode `sessionRef` but before `src/lib/terminal-session-association.ts` exists.

- [ ] From the feature worktree, export only the E2E fixture/spec patch:

```bash
git diff origin/main -- test/e2e-browser/fixtures/fake-opencode.cjs test/e2e-browser/specs/opencode-restart-recovery.spec.ts > /tmp/freshell-opencode-hidden-association-e2e.patch
```

- [ ] Apply that patch in the temporary red worktree:

```bash
cd /tmp/freshell-opencode-hidden-association-red
git apply /tmp/freshell-opencode-hidden-association-e2e.patch
```

- [ ] Install dependencies in the temporary red worktree before running Playwright:

```bash
cd /tmp/freshell-opencode-hidden-association-red
timeout 600s env NODE_ENV=development npm ci --include=dev
timeout 300s env NODE_ENV=development npx playwright install chromium
```

Expected:

- Dependency installation completes successfully.
- The Chromium browser binary required by Playwright is present.
- If dependency installation fails, report that setup failure separately. Do not count it as the intended red test failure.

- [ ] Run the focused hidden-association test:

```bash
cd /tmp/freshell-opencode-hidden-association-red
timeout 420s npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts -g "recovers a hidden OpenCode sessionRef when association lands while the browser is closed"
```

Expected:

- The test fails.
- The failure occurs after the server has the canonical OpenCode `sessionRef`.
- The browser does not restore the hidden pane/tab association.
- A timeout at the hidden-pane `waitForFunction` assertion is an acceptable red failure.

- [ ] Capture the failing command and failure summary in the execution notes.

- [ ] Remove the temporary worktree:

```bash
cd /home/dan/code/freshell
git worktree remove --force /tmp/freshell-opencode-hidden-association-red
```

Do not leave the temp worktree or patch file as part of the branch.

---

## Task 5: Prove The Regression Test Is Green On The Current Branch

Purpose: prove the current production reconciliation plus the new browser coverage fixes the actual behavior.

- [ ] Run the focused hidden-association test in the feature worktree:

```bash
timeout 420s npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts -g "recovers a hidden OpenCode sessionRef when association lands while the browser is closed"
```

Expected:

- The test passes.
- The logs show no server restart, broad process kill, or self-hosted dev-server restart.

- [ ] Run the full OpenCode restart recovery spec:

```bash
timeout 480s npm run test:e2e:chromium -- test/e2e-browser/specs/opencode-restart-recovery.spec.ts
```

Expected:

- All tests in the spec pass.
- Record the actual Playwright count from the output instead of assuming a fixed number.

- [ ] Run focused unit coverage for the already-merged production reconciliation:

```bash
timeout 240s npm run test:vitest -- test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx --run
```

Expected:

- The relevant App and TerminalView unit tests pass.

- [ ] Run whitespace and diff sanity checks:

```bash
git diff --check
git diff --stat origin/main
git diff --name-only origin/main
```

Expected:

- No whitespace errors.
- Diff is limited to the fake fixture, E2E spec, and plan file unless a production prerequisite was actually missing and this plan was updated.

---

## Task 6: Refactor And Finalize

Purpose: keep the branch focused and shippable after the red/green proof.

- [ ] Review the E2E helpers for duplication and naming clarity. Keep helpers local to `opencode-restart-recovery.spec.ts` unless another spec needs them now.

- [ ] Confirm the fake fixture gate is opt-in. Existing tests must keep their old session-event timing when `FAKE_OPENCODE_SESSION_EVENT_GATE_PATH` is unset.

- [ ] Confirm no production code introduces or expands a fallback that guesses OpenCode sessions from sidebar/project metadata.

- [ ] Confirm no README or `docs/index.html` change is needed. This is a correctness fix for existing behavior, not an end-user feature or major UI change.

- [ ] Commit the final branch changes:

```bash
git add test/e2e-browser/fixtures/fake-opencode.cjs test/e2e-browser/specs/opencode-restart-recovery.spec.ts docs/superpowers/plans/2026-06-01-opencode-hidden-association-restore.md
git commit -m "test: cover OpenCode refresh session recovery"
```

If the plan file was already committed separately, amend or add a follow-up plan-fix commit according to the current branch history. Do not squash away useful red/green evidence unless the user asks.

---

## Completion Evidence

The executor must report:

- The pre-fix red command and concise failure summary.
- The current-branch focused green command and result.
- The current-branch full OpenCode restart recovery spec command and result.
- The focused unit-test command and result.
- The final files changed.
- Any deviations from this plan and why they were necessary.

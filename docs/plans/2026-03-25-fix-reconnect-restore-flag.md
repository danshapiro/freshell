# Fix INVALID_TERMINAL_ID Reconnect Restore Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Always mark terminal recreations triggered by INVALID_TERMINAL_ID as `restore: true` so they bypass the server's rate limit, preventing burst failures when the server restarts and all panes simultaneously reconnect.

**Architecture:** The fix is a one-line production change in `TerminalView.tsx` -- remove the `wasRestore` conditional guard so `addTerminalRestoreRequestId(newRequestId)` is always called when recreating after INVALID_TERMINAL_ID. Any INVALID_TERMINAL_ID-triggered recreation is, by definition, restoring a terminal that existed before the server lost state. The `restore` flag's only server-side effect is bypassing the rate limit check at `ws-handler.ts:1254`, making this safe. Tests are added red-first to prove the bug exists, then go green with the fix, plus an e2e-browser test for multi-pane server restart recovery.

**Tech Stack:** React 18, Vitest, Testing Library, Playwright (e2e-browser), xterm.js

---

### Task 1: Add failing unit test -- INVALID_TERMINAL_ID reconnect always marks new request as restore

**Files:**
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx` (add new test near line 1792)

This test proves the bug: when a non-restore terminal (the common case -- terminals created normally, not from localStorage restore) receives INVALID_TERMINAL_ID, the new createRequestId should be added to the restore set so the subsequent `terminal.create` message includes `restore: true`.

- [ ] **Step 1: Write the failing test**

Add a new test case after the existing "recreates terminal once after INVALID_TERMINAL_ID for the current terminal" test (line 1792). The test sets `consumeTerminalRestoreRequestId` to return `false` (the default -- simulating a non-restore terminal), triggers INVALID_TERMINAL_ID, and asserts that `addTerminalRestoreRequestId` was called with the new request ID.

```typescript
it('always marks INVALID_TERMINAL_ID reconnects as restore regardless of wasRestore', async () => {
  // consumeTerminalRestoreRequestId returns false by default (non-restore terminal)
  // This is the common case: terminals created fresh, not from localStorage restore
  restoreMocks.consumeTerminalRestoreRequestId.mockReturnValue(false)
  const tabId = 'tab-reconnect-restore'
  const paneId = 'pane-reconnect-restore'

  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-reconnect-restore',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId: 'term-reconnect-restore',
    initialCwd: '/tmp',
  }

  const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: tabId,
          mode: 'shell',
          status: 'running',
          title: 'Shell',
          titleSetByUser: false,
          terminalId: 'term-reconnect-restore',
          createRequestId: 'req-reconnect-restore',
        }],
        activeTabId: tabId,
      },
      panes: {
        layouts: { [tabId]: root },
        activePane: { [tabId]: paneId },
        paneTitles: {},
      },
      settings: createSettingsState(),
      connection: { status: 'connected', error: null },
    },
  })

  const { rerender } = render(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
    </Provider>
  )

  await waitFor(() => {
    expect(messageHandler).not.toBeNull()
  })

  restoreMocks.addTerminalRestoreRequestId.mockClear()

  messageHandler!({
    type: 'error',
    code: 'INVALID_TERMINAL_ID',
    message: 'Unknown terminalId',
    terminalId: 'term-reconnect-restore',
  })

  await waitFor(() => {
    const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: any }
    expect(layout.content.createRequestId).not.toBe('req-reconnect-restore')
  })

  // The key assertion: addTerminalRestoreRequestId MUST be called even when
  // the original terminal was NOT a restore (wasRestore=false).
  expect(restoreMocks.addTerminalRestoreRequestId).toHaveBeenCalledTimes(1)
  const newRequestId = (store.getState().panes.layouts[tabId] as any).content.createRequestId
  expect(restoreMocks.addTerminalRestoreRequestId).toHaveBeenCalledWith(newRequestId)

  // Rerender with new content to trigger sendCreate
  const newPaneContent = (store.getState().panes.layouts[tabId] as any).content as TerminalPaneContent
  rerender(
    <Provider store={store}>
      <TerminalView tabId={tabId} paneId={paneId} paneContent={newPaneContent} />
    </Provider>
  )

  // Verify the terminal.create message includes restore: true
  await waitFor(() => {
    const createCalls = wsMocks.send.mock.calls.filter(([msg]) =>
      msg?.type === 'terminal.create' && msg.requestId === newRequestId
    )
    expect(createCalls.length).toBeGreaterThanOrEqual(1)
    expect(createCalls[0][0].restore).toBe(true)
  })
})
```

**Why this test catches the bug:** With the current code, `addTerminalRestoreRequestId` is only called when `wasRestore` is true. For non-restore terminals (the majority), `addTerminalRestoreRequestId` is never called, so the subsequent `terminal.create` won't include `restore: true`, and the rate limiter will reject burst reconnections. This test asserts that `addTerminalRestoreRequestId` is always called regardless of `wasRestore`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/user/code/freshell/.worktrees/fix-reconnect-restore-flag && npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx -t "always marks INVALID_TERMINAL_ID reconnects as restore"`
Expected: FAIL -- `addTerminalRestoreRequestId` is not called when `wasRestore` is false (the current behavior)

- [ ] **Step 3: Implement the fix**

In `src/components/TerminalView.tsx`, lines 1836-1842, change:

```typescript
// BEFORE (buggy):
// Preserve the restore flag so the re-creation bypasses rate limiting.
// The original createRequestId's flag was never consumed (we went
// through attach, not sendCreate), so check the old ID first.
const wasRestore = consumeTerminalRestoreRequestId(requestIdRef.current)
if (wasRestore) {
  addTerminalRestoreRequestId(newRequestId)
}
```

to:

```typescript
// AFTER (fixed):
// Any INVALID_TERMINAL_ID reconnect is restoring a terminal that existed
// before the server lost state. Always mark it as restore so the
// subsequent terminal.create bypasses the server's rate limit.
// Consume the old ID's flag (if any) to clean up the set, but mark the
// new request regardless — non-restore terminals also need rate-limit
// bypass when burst-reconnecting after a server restart.
consumeTerminalRestoreRequestId(requestIdRef.current)
addTerminalRestoreRequestId(newRequestId)
```

**Justification:** The `restore` flag's only server-side effect is bypassing the rate limit check (`ws-handler.ts:1254`: `if (!m.restore) { ... rate limit ... }`). There is no other behavioral difference. An INVALID_TERMINAL_ID reconnect is semantically identical to a restore: the terminal existed, the server lost it, and the client needs to recreate it. The old guard was overly conservative -- it only preserved an existing `restore` flag but never set one for fresh terminals. This caused all non-restore terminals to hit the rate limiter when burst-reconnecting after a server restart.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/fix-reconnect-restore-flag && npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx -t "always marks INVALID_TERMINAL_ID reconnects as restore"`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Verify the existing related tests still pass -- these guard against regressions:
- "recreates terminal once after INVALID_TERMINAL_ID for the current terminal" -- still reconnects correctly
- "marks restored terminal.create requests" -- still marks originally-restored terminals
- "does not reconnect after terminal.exit when INVALID_TERMINAL_ID is received" -- still blocks reconnect for exited terminals
- "ignores INVALID_TERMINAL_ID errors for other terminals" -- still ignores mismatched terminal IDs
- "retries terminal.create after RATE_LIMITED errors" -- retry mechanism unchanged
- "clears tab terminalId and sets status to creating on INVALID_TERMINAL_ID reconnect" -- state clearing unchanged

Run: `cd /home/user/code/freshell/.worktrees/fix-reconnect-restore-flag && npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
cd /home/user/code/freshell/.worktrees/fix-reconnect-restore-flag
git add test/unit/client/components/TerminalView.lifecycle.test.tsx src/components/TerminalView.tsx
git commit -m "fix: always mark INVALID_TERMINAL_ID reconnects as restore to bypass rate limit

INVALID_TERMINAL_ID-triggered recreations are restoring terminals that
existed before the server lost state. Always set the restore flag so the
subsequent terminal.create bypasses the server's 10-per-10s rate limit,
preventing burst failures when all panes reconnect simultaneously after
a server restart."
```

---

### Task 2: Add e2e-browser test -- multi-pane recovery after server restart

**Files:**
- Create: `test/e2e-browser/specs/server-restart-recovery.spec.ts`

This test verifies the end-to-end behavior: multiple panes exist, server restarts (losing all terminal state), and all panes recover without hitting the rate limit.

- [ ] **Step 1: Write the failing e2e test**

Create a new e2e-browser spec that:
1. Creates 3+ terminal panes (via tab creation and/or splits)
2. Waits for all terminals to be running and functional
3. Stops the TestServer and starts a new one on the same port
4. Waits for all panes to reconnect and become functional
5. Verifies no "[Error]" messages appear in any terminal output

```typescript
import { test, expect } from '../helpers/fixtures.js'
import { TestServer } from '../helpers/test-server.js'

test.describe('Server Restart Recovery', () => {
  // This test needs its own server lifecycle, so we override the worker-scoped server.
  test('all panes recover after server restart without rate limit errors', async ({ page, browser }) => {
    const server = new TestServer()
    const info = await server.start()

    try {
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)

      // Wait for initial connection
      await expect(async () => {
        const status = await page.evaluate(() =>
          window.__FRESHELL_TEST_HARNESS__?.getConnectionStatus()
        )
        expect(status).toBe('ready')
      }).toPass({ timeout: 15_000 })

      // Wait for the first terminal to be ready
      await expect(page.locator('.xterm')).toBeVisible({ timeout: 15_000 })

      // Create 2 more tabs (total 3 panes)
      const addButton = page.locator('[data-context="tab-add"]')
      await addButton.click()
      await page.waitForTimeout(1000)
      await addButton.click()
      await page.waitForTimeout(1000)

      // Verify 3 tabs exist
      await expect(async () => {
        const tabCount = await page.evaluate(() =>
          window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.tabs?.length
        )
        expect(tabCount).toBe(3)
      }).toPass({ timeout: 10_000 })

      // Wait for all terminals to have terminalIds
      await expect(async () => {
        const state = await page.evaluate(() =>
          window.__FRESHELL_TEST_HARNESS__?.getState()
        )
        for (const tab of state!.tabs.tabs) {
          const layout = state!.panes.layouts[tab.id] as any
          expect(layout?.content?.terminalId).toBeTruthy()
        }
      }).toPass({ timeout: 20_000 })

      // Stop the server (all PTYs and terminal state are lost)
      await server.stop()

      // Start a fresh server on the same port -- simulates server restart
      const server2 = new TestServer({ port: info.port })
      const info2 = await server2.start()

      try {
        // Wait for WS to reconnect and all terminals to recover
        await expect(async () => {
          const status = await page.evaluate(() =>
            window.__FRESHELL_TEST_HARNESS__?.getConnectionStatus()
          )
          expect(status).toBe('ready')
        }).toPass({ timeout: 30_000 })

        // Wait for all panes to get new terminalIds (server restart means
        // INVALID_TERMINAL_ID -> recreate flow for each pane)
        await expect(async () => {
          const state = await page.evaluate(() =>
            window.__FRESHELL_TEST_HARNESS__?.getState()
          )
          for (const tab of state!.tabs.tabs) {
            const layout = state!.panes.layouts[tab.id] as any
            // Terminal should be running or creating -- NOT error
            expect(layout?.content?.status).not.toBe('error')
            // Eventually should have a new terminalId
            expect(layout?.content?.terminalId).toBeTruthy()
          }
        }).toPass({ timeout: 30_000 })

        // Verify no rate limit errors appeared -- check terminal output
        // by switching to each tab and verifying no "[Error]" text
        const state = await page.evaluate(() =>
          window.__FRESHELL_TEST_HARNESS__?.getState()
        )
        for (const tab of state!.tabs.tabs) {
          // Click on each tab to make it active
          await page.locator(`[data-context="tab"][data-tab-id="${tab.id}"]`).click()
          await page.waitForTimeout(500)
          // Check that no error messages are in the terminal
          const xtermContent = await page.locator('.xterm').first().textContent()
          expect(xtermContent).not.toContain('[Error]')
        }
      } finally {
        await server2.stop()
      }
    } finally {
      // Safety net: stop original server if still running
      await server.stop().catch(() => {})
    }
  })
})
```

**Note:** The `TestServer` constructor may need a `port` option to start the new server on the same port. Check the existing `TestServer` API -- it already accepts options including `port` in `TestServerOptions`. The test also needs its own server lifecycle rather than using the shared worker-scoped server, so it creates and manages `TestServer` instances directly (following the pattern in `settings-persistence-split.spec.ts`).

- [ ] **Step 2: Run the test to confirm it reflects the fix**

Run: `cd /home/user/code/freshell/.worktrees/fix-reconnect-restore-flag && npx playwright test test/e2e-browser/specs/server-restart-recovery.spec.ts`

If the production fix from Task 1 is in place, this test should PASS. If the fix is not in place (revert temporarily to verify), it should FAIL with rate limit errors.

**Important:** This e2e test is designed to pass with the fix from Task 1. It validates the end-to-end behavior rather than catching the bug in isolation. Run it after the fix is applied.

- [ ] **Step 3: Refactor and verify**

Review the test for:
- Proper cleanup: both servers are stopped in `finally` blocks
- Adequate timeouts: server restart takes time, 30s is reasonable
- No flakiness: use `.toPass()` polling patterns, not fixed waits
- Tab selector robustness: verify the `data-tab-id` attribute exists in the codebase

Run the full existing e2e-browser reconnection suite to ensure no regressions:
Run: `cd /home/user/code/freshell/.worktrees/fix-reconnect-restore-flag && npx playwright test test/e2e-browser/specs/reconnection.spec.ts test/e2e-browser/specs/server-restart-recovery.spec.ts`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
cd /home/user/code/freshell/.worktrees/fix-reconnect-restore-flag
git add test/e2e-browser/specs/server-restart-recovery.spec.ts
git commit -m "test: add e2e-browser test for multi-pane recovery after server restart

Verifies that all panes recover their terminals without rate limit errors
when the server restarts and all terminals are simultaneously recreated
via INVALID_TERMINAL_ID -> restore flow."
```

---

### Task 3: Run full test suite and final verification

**Files:** (no new changes -- verification only)

- [ ] **Step 1: Run the complete unit test suite**

Run: `cd /home/user/code/freshell/.worktrees/fix-reconnect-restore-flag && npm run test:vitest -- --run test/unit`
Expected: all PASS

- [ ] **Step 2: Run the complete server integration test suite**

Run: `cd /home/user/code/freshell/.worktrees/fix-reconnect-restore-flag && npm run test:vitest -- --config vitest.config.server.ts --run test/server`
Expected: all PASS

- [ ] **Step 3: Run the coordinated full suite**

Run: `cd /home/user/code/freshell/.worktrees/fix-reconnect-restore-flag && npm test`
Expected: all PASS

- [ ] **Step 4: Verify the diff is minimal and correct**

Run: `cd /home/user/code/freshell/.worktrees/fix-reconnect-restore-flag && git diff main...HEAD --stat`

Expected changed files:
- `src/components/TerminalView.tsx` -- 1 line change (remove `if (wasRestore)` guard)
- `test/unit/client/components/TerminalView.lifecycle.test.tsx` -- new test case
- `test/e2e-browser/specs/server-restart-recovery.spec.ts` -- new e2e test file

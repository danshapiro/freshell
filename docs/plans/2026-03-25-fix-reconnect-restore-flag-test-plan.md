# Test Plan: Fix INVALID_TERMINAL_ID Reconnect Restore Flag

## Strategy reconciliation

The agreed testing strategy called for:
1. Extending the existing unit test at line ~1701 to assert `addTerminalRestoreRequestId` is called
2. A focused unit test for INVALID_TERMINAL_ID when `wasRestore=false`
3. An e2e-browser test for multi-pane server restart recovery
4. Verifying existing tests remain green

After reading the implementation plan, the strategy holds without changes. The plan confirms a one-line production change in `TerminalView.tsx` (lines 1836-1842) and two test artifacts (unit + e2e). The interfaces match: the restore mock (`restoreMocks.addTerminalRestoreRequestId`) is already wired in the unit test file, and the `TestServer` helper supports the `port`/`token` options needed for the e2e restart simulation. No external dependencies, paid APIs, or scope changes are involved.

One minor adjustment: strategy item 1 (extend line ~1701 test) and item 2 (focused unit test for `wasRestore=false`) are best served as a single new test rather than modifying the existing test. The existing "recreates terminal once after INVALID_TERMINAL_ID" test at line 1697 verifies the recreation mechanism itself and should remain untouched as a regression guard. A new dedicated test makes the red-green cycle cleaner and avoids coupling the restore-flag assertion to the recreation-mechanics test.

---

## Test plan

### 1. INVALID_TERMINAL_ID reconnect always marks new request as restore (red-green acceptance gate)

- **Name**: Non-restore terminal receives INVALID_TERMINAL_ID and the new createRequestId is added to the restore set
- **Type**: regression
- **Disposition**: new
- **Harness**: Vitest + Testing Library with mocked `@/lib/terminal-restore` (`restoreMocks`), mocked `@/lib/ws-client` (`wsMocks`), and Redux store with `tabs`/`panes`/`settings`/`connection` reducers
- **Preconditions**: A `TerminalView` is rendered with `status: 'running'`, a valid `terminalId`, and `consumeTerminalRestoreRequestId` returning `false` (the default -- simulating a terminal created normally, not from localStorage restore). The `messageHandler` callback has been captured.
- **Actions**:
  1. Clear `restoreMocks.addTerminalRestoreRequestId`
  2. Deliver an `INVALID_TERMINAL_ID` error message via the captured `messageHandler` matching the pane's `terminalId`
  3. Wait for the pane's `createRequestId` to change in the Redux store (proving the INVALID_TERMINAL_ID handler ran)
  4. Rerender the component with the new `paneContent` to trigger `sendCreate`
- **Expected outcome**:
  - `restoreMocks.addTerminalRestoreRequestId` was called exactly once with the new `createRequestId` (source of truth: the fix description -- "always call `addTerminalRestoreRequestId(newRequestId)` when recreating after INVALID_TERMINAL_ID")
  - The subsequent `terminal.create` WS message includes `restore: true` (source of truth: `TerminalView.tsx` sendCreate logic which reads `consumeTerminalRestoreRequestId` to set the `restore` field; since `addTerminalRestoreRequestId` was called, `consumeTerminalRestoreRequestId` will return `true` for the new ID)
  - **Before the fix**: this test fails because `addTerminalRestoreRequestId` is only called when `wasRestore` is true
  - **After the fix**: this test passes
- **Interactions**: Exercises the `terminal-restore` module API (mocked) and the Redux `panes` slice's `updateContent` action

### 2. Existing "recreates terminal once after INVALID_TERMINAL_ID" still passes

- **Name**: Terminal recreation after INVALID_TERMINAL_ID produces exactly one terminal.create with a new requestId
- **Type**: regression
- **Disposition**: existing
- **Harness**: Same as test 1 (Vitest + Testing Library + mocked WS + Redux store)
- **Preconditions**: A `TerminalView` with `status: 'running'` and a valid `terminalId`
- **Actions**: Deliver INVALID_TERMINAL_ID, rerender with new content, check WS sends
- **Expected outcome**: Exactly one `terminal.create` message sent with the new `requestId`. `createRequestId` in the store differs from the original. (Source of truth: existing passing test at line 1697 in `TerminalView.lifecycle.test.tsx`)
- **Interactions**: Same as test 1 minus the restore-flag assertion

### 3. Existing "marks restored terminal.create requests" still passes

- **Name**: Terminal created from localStorage restore sends terminal.create with restore: true
- **Type**: regression
- **Disposition**: existing
- **Harness**: Same as test 1, with `consumeTerminalRestoreRequestId` mocked to return `true`
- **Preconditions**: A `TerminalView` with `status: 'creating'` and `consumeTerminalRestoreRequestId` returning `true`
- **Actions**: Wait for `terminal.create` WS message
- **Expected outcome**: The `terminal.create` message has `restore: true`. (Source of truth: existing passing test at line 1794)
- **Interactions**: Exercises the normal restore path (localStorage-originated terminals)

### 4. Existing "does not reconnect after terminal.exit when INVALID_TERMINAL_ID is received" still passes

- **Name**: Exited terminal ignores INVALID_TERMINAL_ID and does not trigger recreation
- **Type**: regression
- **Disposition**: existing
- **Harness**: Same as test 1
- **Preconditions**: A `TerminalView` that has received `terminal.exit` and has `status: 'exited'`
- **Actions**: Deliver INVALID_TERMINAL_ID after exit
- **Expected outcome**: No `terminal.create` message sent, no state changes. (Source of truth: existing passing test at line 1929)
- **Interactions**: Validates the exit guard in the INVALID_TERMINAL_ID handler is unaffected by the fix

### 5. Existing "ignores INVALID_TERMINAL_ID errors for other terminals" still passes

- **Name**: INVALID_TERMINAL_ID with a non-matching terminalId is ignored
- **Type**: regression
- **Disposition**: existing
- **Harness**: Same as test 1
- **Preconditions**: A `TerminalView` with `terminalId: 'term-1'`
- **Actions**: Deliver INVALID_TERMINAL_ID with `terminalId: 'term-2'`
- **Expected outcome**: No state changes, no WS sends. (Source of truth: existing passing test at line ~1665)
- **Interactions**: Validates the terminal ID matching guard

### 6. Existing "retries terminal.create after RATE_LIMITED errors" still passes

- **Name**: RATE_LIMITED error triggers retry with backoff
- **Type**: regression
- **Disposition**: existing
- **Harness**: Same as test 1 with `vi.useFakeTimers()`
- **Preconditions**: A `TerminalView` with `status: 'creating'` that has sent an initial `terminal.create`
- **Actions**: Deliver RATE_LIMITED error, advance timers by 250ms
- **Expected outcome**: A second `terminal.create` message is sent after the backoff delay. (Source of truth: existing passing test at line 1851)
- **Interactions**: Validates the retry mechanism is unaffected by the fix

### 7. Server bypasses rate limit for restore: true requests

- **Name**: Burst of terminal.create requests with restore: true all succeed without rate limiting
- **Type**: regression
- **Disposition**: existing
- **Harness**: Vitest server integration test (`vitest.config.server.ts`) with real WebSocket connection to a test server
- **Preconditions**: An authenticated WS connection to the test server
- **Actions**: Send 10 `terminal.create` messages with `restore: true`, then one more without `restore`
- **Expected outcome**: All 11 get `terminal.created` responses, zero RATE_LIMITED errors. (Source of truth: existing passing test at line 920 of `ws-protocol.test.ts`)
- **Interactions**: Validates the server-side rate limit bypass at `ws-handler.ts:1254` which is the destination of the `restore` flag set by the client-side fix

### 8. Multi-pane recovery after server restart (e2e-browser)

- **Name**: All panes recover their terminals without rate limit errors when the server restarts
- **Type**: scenario
- **Disposition**: new
- **Harness**: Playwright (e2e-browser) with custom `TestServer` lifecycle management. Requires `TestServerOptions.port` and `TestServerOptions.token` fields (added by the implementation plan) to start a replacement server on the same endpoint.
- **Preconditions**: A Freshell instance loaded in the browser with 3 tabs, each containing a running terminal with a valid `terminalId`. The `TestServer` supports `port` and `token` options.
- **Actions**:
  1. Navigate to Freshell with `?token=...&e2e=1`
  2. Wait for the first terminal to be ready
  3. Create 2 additional tabs (selecting a shell from PanePicker for each)
  4. Verify 3 tabs exist and all have `terminalId` values
  5. Stop the server (all PTYs and terminal state lost)
  6. Start a new `TestServer` on the **same port** with the **same token**
  7. Wait for WS to reconnect and reach `ready` state
  8. Wait for all panes to get new `terminalId` values (INVALID_TERMINAL_ID -> recreate with `restore: true`)
  9. Verify no pane has `status: 'error'`
  10. Switch to each tab and verify no `[Error]` text in terminal output
- **Expected outcome**:
  - All 3 panes recover with new `terminalId` values (source of truth: the fix -- `addTerminalRestoreRequestId` is always called, so all recreations include `restore: true`, bypassing the 10/10s rate limit)
  - No pane enters error state
  - No rate limit error text appears in any terminal output
  - The WS connection reaches `ready` state after the server restart
- **Interactions**: Exercises the full reconnection flow end-to-end: WS auto-reconnect -> `hello`/`ready` handshake -> `terminal.attach` -> `INVALID_TERMINAL_ID` -> `addTerminalRestoreRequestId` -> `terminal.create` with `restore: true` -> server rate limit bypass -> `terminal.created`. Also exercises `TestServer` `port`/`token` options, the `selectShellFromPicker` pattern, and the `__FRESHELL_TEST_HARNESS__` Redux state inspection API.

### 9. Existing reconnection e2e tests still pass

- **Name**: WebSocket reconnection and terminal reattach still work for non-restart scenarios
- **Type**: regression
- **Disposition**: existing
- **Harness**: Playwright (e2e-browser) with the standard worker-scoped `TestServer` fixture
- **Preconditions**: Freshell loaded in the browser with the standard fixture
- **Actions**: Run the full `reconnection.spec.ts` suite (5 tests: reconnect after drop, terminal output resumes, connection status updates, multiple rapid disconnects, tabs preserved across reconnect)
- **Expected outcome**: All pass. (Source of truth: existing passing tests in `test/e2e-browser/specs/reconnection.spec.ts`)
- **Interactions**: Validates that the fix does not regress the non-restart reconnection paths

---

## Coverage summary

### Covered

| Area | Tests | Coverage |
|------|-------|----------|
| Bug reproduction (non-restore terminal + INVALID_TERMINAL_ID -> restore flag) | #1 | New red-green acceptance gate |
| Server-side rate limit bypass for `restore: true` | #7 | Existing integration test |
| End-to-end multi-pane server restart recovery | #8 | New scenario test |
| INVALID_TERMINAL_ID recreation mechanics | #2 | Existing regression guard |
| localStorage restore path | #3 | Existing regression guard |
| Exited terminal guard | #4 | Existing regression guard |
| Terminal ID matching guard | #5 | Existing regression guard |
| Rate limit retry mechanism | #6 | Existing regression guard |
| Non-restart WS reconnection flows | #9 | Existing e2e regression suite |

### Explicitly excluded per agreed strategy

| Area | Reason | Risk |
|------|--------|------|
| Visual/screenshot testing | Text assertions suffice for this bug fix; no UI layout changes | Low -- the fix is a flag-setting change with no visual impact |
| Performance testing | The fix changes a boolean flag assignment, no measurable performance impact | Negligible |
| Server-side unit test for rate limit logic changes | No server code is changed; the existing integration test (#7) already covers the server behavior | Low -- the `if (!m.restore)` guard is unchanged |

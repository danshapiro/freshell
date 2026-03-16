# Fix Claude Session Green - Test Plan

**Implementation plan:** `docs/plans/2026-03-16-fix-claude-session-green.md`
**Test file:** `test/unit/client/components/TerminalView.lifecycle.test.tsx`
**Source under test:** `src/components/TerminalView.tsx`

---

## Scope

The fix adds a `turnCompletedSinceLastInputRef` boolean ref to `TerminalView.tsx` that prevents the `handleTerminalOutput` callback from re-entering the "working" activity phase after a turn-complete BEL signal has fired and before the user submits new input. The test plan covers:

1. The core bug fix (output after BEL must not re-trigger busy)
2. Regression: the existing pending->working->cleared lifecycle still works
3. Regression: a second user turn after the fix still transitions correctly
4. Edge case: replay mode still suppresses activity (existing guard preserved)
5. Do NOT test: server-side, agent-chat path, Codex path (tracked by `CodexActivityTracker`)

All tests are in `test/unit/client/components/TerminalView.lifecycle.test.tsx` within the existing `TerminalView lifecycle updates` describe block. They use the same harness pattern as the existing `tracks claude terminal runtime activity from submit to output to turn completion` test at line 787.

---

## Test Cases

### Test 1: Post-BEL output does not re-enter working state (NEW - Core Bug Fix)

**Test name:** `does not re-enter working state when claude output arrives after turn completion BEL`

**What it verifies:** When Claude finishes its turn (BEL signal), subsequent terminal output (e.g., Claude rendering its next prompt) does not flip the activity indicator back to blue/busy. This is the primary user-visible bug being fixed.

**Setup:**
1. Create a Redux store with `tabsReducer`, `panesReducer`, `settingsReducer`, `connectionReducer`, `turnCompletionReducer`, `paneRuntimeActivityReducer`
2. Preload a Claude terminal pane (`mode: 'claude'`, `status: 'running'`, with `terminalId` and `resumeSessionId`)
3. Preload `paneRuntimeActivity: { byPaneId: {} }` (no initial activity)
4. Render `<TerminalView>` with Provider

**Actions:**
1. Wait for `messageHandler` and `terminalInstances` to be ready
2. Extract `onData` callback from mock terminal
3. Call `onData('\r')` (user submits input)
4. Complete attach handshake via `terminal.attach.ready` message
5. Send `terminal.output` with regular text (`'Claude is thinking...'`)
6. Send `terminal.output` with BEL (`'\x07'`)
7. Send `terminal.output` with post-BEL text (`'\r\n> '`, simulating Claude's next prompt)

**Assertions:**
1. After step 3: `paneRuntimeActivity.byPaneId[paneId]` matches `{ source: 'terminal', phase: 'pending' }`
2. After step 5: `paneRuntimeActivity.byPaneId[paneId]` matches `{ source: 'terminal', phase: 'working' }`
3. After step 6: `paneRuntimeActivity.byPaneId[paneId]` is `undefined` (cleared)
4. After step 7: `paneRuntimeActivity.byPaneId[paneId]` is **still** `undefined` (not re-set to working)

**Phase:** RED (should fail before the fix, pass after)

---

### Test 2: Full pending->working->cleared lifecycle (EXISTING - Regression)

**Test name:** `tracks claude terminal runtime activity from submit to output to turn completion`

**What it verifies:** The basic happy path: user submits input (pending), Claude produces output (working), Claude emits BEL (cleared). This existing test at line 787 must continue to pass unchanged.

**Setup:** Same pattern as Test 1 (Claude terminal pane, same reducers).

**Actions:**
1. `onData('\r')` (user submits)
2. Complete attach handshake
3. Send `terminal.output` with regular text
4. Send `terminal.output` with BEL

**Assertions:**
1. After submit: phase is `pending`
2. After output: phase is `working`
3. After BEL: activity is `undefined` (cleared)

**Phase:** GREEN (must still pass after the fix; no modification needed)

---

### Test 3: Second turn works correctly after the guard resets (NEW - Regression)

**Test name:** `allows working state again after user submits new input following a completed turn`

**What it verifies:** After a turn completes (BEL sets the guard), the user can submit new input and the pending->working->cleared cycle works normally again. This confirms the guard resets on `sendInput` when `isClaudeTurnSubmit` is true.

**Setup:** Same pattern as Test 1 (Claude terminal pane, all activity-related reducers).

**Actions:**
1. Wait for message handler and terminal instances
2. Extract `onData` callback
3. Call `onData('\r')` (first user turn)
4. Complete attach handshake
5. Send `terminal.output` with regular text -- asserts working
6. Send `terminal.output` with BEL -- asserts cleared
7. Send `terminal.output` with post-BEL prompt text -- asserts still cleared (guard active)
8. Call `onData('\r')` again (second user turn -- resets guard)
9. Send `terminal.output` with new regular text

**Assertions:**
1. After step 3: phase is `pending`
2. After step 5: phase is `working`
3. After step 6: activity is `undefined`
4. After step 7: activity is still `undefined` (guard prevents re-trigger)
5. After step 8: phase is `pending` (new turn submitted, guard reset)
6. After step 9: phase is `working` (guard is off, output correctly sets working)

**Phase:** RED (depends on the guard implementation)

---

### Test 4: Initial terminal output does not trigger working before user input (NEW - Edge Case)

**Test name:** `does not show working state for initial prompt output before any user input`

**What it verifies:** When a Claude terminal first renders (before the user has typed anything), the initial prompt output does not set the pane to "working". This validates the `true` initialization of `turnCompletedSinceLastInputRef`.

**Setup:** Same pattern as Test 1, but with a terminal that has not yet received any user input.

**Actions:**
1. Wait for message handler and terminal instances
2. Complete attach handshake
3. Send `terminal.output` with initial prompt text (e.g., `'Welcome to Claude\r\n> '`)

**Assertions:**
1. `paneRuntimeActivity.byPaneId[paneId]` is `undefined` (no activity set, because the guard starts as `true`)

**Phase:** This test verifies correct initialization. It should PASS with the fix (guard starts `true`). If the ref were initialized to `false` instead, this test would fail.

---

### Test 5: Shell mode output with BEL does not record turn completion (EXISTING - Regression)

**Test name:** `does not record turn completion for shell mode output`

**What it verifies:** Shell-mode terminals ignore BEL for turn-completion tracking. The fix must not affect shell terminals.

**Setup:** Shell terminal pane (`mode: 'shell'`), `turnCompletionReducer` only (no `paneRuntimeActivityReducer` needed).

**Actions:**
1. Complete attach handshake
2. Send `terminal.output` with `'hello\x07world'`

**Assertions:**
1. `turnCompletion.lastEvent` is `null` (no turn completion recorded)
2. Terminal's `write` was called with the raw data (BEL not stripped for shell)

**Phase:** GREEN (existing test at line 906, must still pass unchanged)

---

### Test 6: Pane activity indicator visual flow (EXISTING - Integration Regression)

**Test name (describe):** `pane activity indicator flow (e2e)` -- specifically `keeps claude terminals non-blue while pending, blue while working, and clears on idle`

**What it verifies:** The visual presentation layer: pending phase does NOT show blue, working phase shows blue, cleared shows no blue. This test is in `test/e2e/pane-activity-indicator-flow.test.tsx` at line 253.

**Setup:** Uses `renderHarness` with mocked `TerminalView`, `TabBar`, and `PaneContainer`. Directly dispatches `setPaneRuntimeActivity` / `clearPaneRuntimeActivity` actions.

**Actions:**
1. Render with `phase: 'pending'` preloaded
2. Dispatch `setPaneRuntimeActivity({ phase: 'working' })`
3. Dispatch `clearPaneRuntimeActivity`

**Assertions:**
1. Pending: pane icon class does NOT contain `text-blue-500`
2. Working: pane icon class contains `text-blue-500`
3. Cleared: pane icon class does NOT contain `text-blue-500`

**Phase:** GREEN (existing test, unchanged by this fix; validates the visual layer is correct)

---

## Out of Scope

The following are explicitly NOT tested as part of this fix:

- **Server-side activity tracking** -- The bug is entirely client-side in `TerminalView.tsx`
- **Agent-chat (FreshClaude) path** -- Uses a different activity tracking mechanism
- **Codex path** -- Codex activity is tracked server-side by `CodexActivityTracker` with its own state machine; not affected by this bug
- **WebSocket protocol changes** -- No protocol changes in this fix
- **Redux slice changes** -- No slice logic changes; existing `setPaneRuntimeActivity` / `clearPaneRuntimeActivity` actions are used as-is

## Test Execution

```bash
# Run the specific new tests
cd /home/user/code/freshell/.worktrees/fix-claude-session-green
npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx \
  -t "does not re-enter working state when claude output arrives after turn completion BEL"

npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx \
  -t "allows working state again after user submits new input following a completed turn"

npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx \
  -t "does not show working state for initial prompt output before any user input"

# Run the full lifecycle test file (includes regression tests)
npx vitest run test/unit/client/components/TerminalView.lifecycle.test.tsx

# Run integration tests
npx vitest run test/e2e/pane-activity-indicator-flow.test.tsx
npx vitest run test/unit/client/lib/pane-activity.test.ts

# Full coordinated suite (before merge)
FRESHELL_TEST_SUMMARY="fix-claude-session-green: post-BEL activity guard" npm test
```

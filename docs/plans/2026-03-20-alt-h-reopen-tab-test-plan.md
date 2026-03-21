# Alt+H Reopen Closed Tab - Test Plan

## Strategy Reconciliation

The implementation plan aligns with the approved 7-layer testing strategy. Key observations:

- **Layer 1 (Shortcut detection)** maps directly to Task 1. The existing `test/unit/client/lib/tab-switch-shortcuts.test.ts` already tests `getTabLifecycleAction` for Alt+T and Alt+W with modifier rejection. Adding Alt+H follows the identical pattern. Existing infrastructure is reusable as-is.
- **Layer 2 (Redux closed-tab stack)** maps to Task 2. The existing `test/unit/client/store/tabRegistrySlice.test.ts` tests `recordClosedTabSnapshot` and snapshot grouping. The new `reopenStack` tests follow the same reducer-level pattern with `pushReopenEntry`/`popReopenEntry` actions.
- **Layer 3 (App-level dispatch)** maps to Task 5. The implementation plan notes that full App.tsx unit testing is complex and defers verification to the E2E layer. This is acceptable because the wiring is a 3-line addition to an existing `if/else` chain, and the shortcut detection itself is fully covered in Layer 1.
- **Layer 4 (Terminal passthrough)** requires no new code. The existing `TerminalView.tsx` line 1166 already calls `getTabLifecycleAction(event)` and returns `false` for any truthy result. Once Task 1 makes `getTabLifecycleAction` return `'reopen'` for Alt+H, the passthrough works automatically. A dedicated unit test confirming the xterm handler's existing guard is sufficient.
- **Layer 5 (Shortcut display)** maps to Task 6. The `KEYBOARD_SHORTCUTS` array is static data. A unit test asserting the entry exists is low-cost and provides regression protection.
- **Layer 6 (Registry interaction)** maps to Task 7. Tests that `localClosed` entries are cleared on reopen, preventing stale "recently closed" entries. Uses the same `configureStore` pattern as `tabsSlice.closed-registry.test.ts`.
- **Layer 7 (Playwright E2E)** maps to Task 8. Uses the existing `freshellPage`/`harness`/`terminal` fixtures from `test/e2e-browser/helpers/fixtures.ts`. The E2E test covers the full vertical slice: keyboard input, Redux dispatch, state mutation, and UI response.

**Additional coverage beyond the 7 layers:** The implementation plan introduces a `restoreLayout` reducer in `panesSlice` with `stripStaleIds` and `normalizeRestoredTree` helpers. These require dedicated unit tests (covered by Task 3) to verify content normalization, stale ID stripping, split-layout preservation, and the "don't overwrite existing layout" guard. This is an 8th test group not explicitly in the strategy but critical for correctness.

## Sources of Truth

- **Approved testing strategy:** 7-layer list provided to this subagent.
- **Implementation plan:** `docs/plans/2026-03-20-alt-h-reopen-tab.md` -- Tasks 1-9 with exact code, file paths, and test specifications.
- **Existing shortcut tests:** `test/unit/client/lib/tab-switch-shortcuts.test.ts` -- pattern for modifier-key detection assertions.
- **Existing registry tests:** `test/unit/client/store/tabRegistrySlice.test.ts` -- pattern for slice reducer testing with `makeRecord`.
- **Existing panes tests:** `test/unit/client/store/panesSlice.test.ts` -- pattern for pane layout assertions, `nanoid` mocking, and `PanesState` construction.
- **Existing tabs tests:** `test/unit/client/store/tabsSlice.test.ts` and `tabsSlice.closed-registry.test.ts` -- pattern for `configureStore` with multi-slice integration, `closeTab` thunk dispatch.
- **Existing E2E tests:** `test/e2e-browser/specs/tab-management.spec.ts` -- pattern for tab lifecycle E2E (create, switch, close) using `harness.waitForTabCount`, `harness.getState`, and keyboard shortcuts.
- **Source types:** `src/store/paneTypes.ts` (PaneNode, PaneContent unions), `src/store/types.ts` (Tab, TabMode, ShellType).

## Test Plan

### 1. Alt+H maps to 'reopen' lifecycle action

- **Name:** `getTabLifecycleAction` returns `'reopen'` for Alt+H keydown
- **Layer:** 1 (Shortcut detection)
- **Type:** unit
- **Disposition:** extend
- **Harness:** `test/unit/client/lib/tab-switch-shortcuts.test.ts` -- add tests to existing `describe('getTabLifecycleAction')` block
- **Preconditions:** None (pure function, no setup).
- **Actions:** Call `getTabLifecycleAction({ altKey: true, ctrlKey: false, shiftKey: false, metaKey: false, code: 'KeyH' })`.
- **Expected outcome:** Returns `'reopen'`.
- **Interactions:** None.
- **Source of truth:** Implementation plan Task 1 Step 1.

### 2. Alt+Ctrl+H rejected (modifier combo)

- **Name:** `getTabLifecycleAction` returns `null` when Ctrl is also pressed with Alt+H
- **Layer:** 1 (Shortcut detection)
- **Type:** unit
- **Disposition:** extend
- **Harness:** `test/unit/client/lib/tab-switch-shortcuts.test.ts`
- **Preconditions:** None.
- **Actions:** Call `getTabLifecycleAction({ altKey: true, ctrlKey: true, shiftKey: false, metaKey: false, code: 'KeyH' })`.
- **Expected outcome:** Returns `null`.
- **Interactions:** None.
- **Source of truth:** Implementation plan Task 1 Step 1 (modifier combo rejection).

### 3. Alt+Shift+H rejected (modifier combo)

- **Name:** `getTabLifecycleAction` returns `null` when Shift is also pressed with Alt+H
- **Layer:** 1 (Shortcut detection)
- **Type:** unit
- **Disposition:** extend
- **Harness:** `test/unit/client/lib/tab-switch-shortcuts.test.ts`
- **Preconditions:** None.
- **Actions:** Call `getTabLifecycleAction({ altKey: true, ctrlKey: false, shiftKey: true, metaKey: false, code: 'KeyH' })`.
- **Expected outcome:** Returns `null`.
- **Interactions:** None.
- **Source of truth:** Implementation plan Task 1 Step 1 (modifier combo rejection).

### 4. pushReopenEntry adds entry and popReopenEntry removes most recent (LIFO)

- **Name:** Reopen stack push/pop maintains LIFO ordering
- **Layer:** 2 (Redux closed-tab stack)
- **Type:** unit
- **Disposition:** extend
- **Harness:** `test/unit/client/store/tabRegistrySlice.test.ts` -- add `describe('reopenStack')` block
- **Preconditions:** Import `pushReopenEntry`, `popReopenEntry` from `tabRegistrySlice`. Create helper `makeTab()` and `makeLeafLayout()` to construct test data.
- **Actions:** Push two entries (tab-a at `closedAt: 100`, tab-b at `closedAt: 200`). Pop once.
- **Expected outcome:** After push: stack length is 2. After pop: stack length is 1, remaining entry is tab-a (the older one).
- **Interactions:** `tabRegistrySlice` reducer.
- **Source of truth:** Implementation plan Task 2 Step 1.

### 5. popReopenEntry on empty stack is a no-op

- **Name:** Popping from an empty reopen stack does not crash
- **Layer:** 2 (Redux closed-tab stack)
- **Type:** unit (boundary)
- **Disposition:** extend
- **Harness:** `test/unit/client/store/tabRegistrySlice.test.ts`
- **Preconditions:** Default initial state (empty stack).
- **Actions:** Dispatch `popReopenEntry()`.
- **Expected outcome:** Stack length remains 0. No error thrown.
- **Interactions:** `tabRegistrySlice` reducer.
- **Source of truth:** Implementation plan Task 2 Step 1.

### 6. Reopen stack caps at 20 entries, evicting oldest

- **Name:** Stack overflow evicts oldest entries when exceeding 20-entry cap
- **Layer:** 2 (Redux closed-tab stack)
- **Type:** unit (boundary)
- **Disposition:** extend
- **Harness:** `test/unit/client/store/tabRegistrySlice.test.ts`
- **Preconditions:** Default initial state.
- **Actions:** Push 25 entries with sequential IDs (tab-0 through tab-24).
- **Expected outcome:** Stack length is 20. First entry is tab-5 (entries 0-4 evicted). Last entry is tab-24.
- **Interactions:** `tabRegistrySlice` reducer.
- **Source of truth:** Implementation plan D2 (20-entry cap), Task 2 Step 1.

### 7. restoreLayout injects single-leaf layout with normalized content

- **Name:** `restoreLayout` reducer strips stale terminal IDs and generates fresh createRequestId for a single-pane layout
- **Layer:** (Supplemental -- restoreLayout reducer)
- **Type:** unit
- **Disposition:** new
- **Harness:** `test/unit/client/store/panesSlice.restore-layout.test.ts` -- new file
- **Preconditions:** Empty `PanesState`. Construct a leaf `PaneNode` with stale `terminalId: 'stale-term-id'`, `createRequestId: 'stale-crq'`, `status: 'running'`.
- **Actions:** Dispatch `restoreLayout({ tabId: 'tab-1', layout, paneTitles: { p1: 'My Shell' } })`.
- **Expected outcome:** `layouts['tab-1']` exists and is type `'leaf'`. Terminal content has `terminalId` undefined, `status` `'creating'`, `createRequestId` different from `'stale-crq'`. `paneTitles['tab-1'].p1` is `'My Shell'`. `activePane['tab-1']` is `'p1'`.
- **Interactions:** `stripStaleIds`, `normalizePaneContent`, `normalizeRestoredTree`.
- **Source of truth:** Implementation plan D5 (two-step normalization), Task 3 Step 1.

### 8. restoreLayout injects split layout and sets activePane to first leaf

- **Name:** `restoreLayout` correctly handles a horizontal split with terminal + browser panes
- **Layer:** (Supplemental -- restoreLayout reducer)
- **Type:** unit
- **Disposition:** new
- **Harness:** `test/unit/client/store/panesSlice.restore-layout.test.ts`
- **Preconditions:** Empty `PanesState`. Construct a split `PaneNode` with two children: terminal leaf (stale IDs) and browser leaf (stale `browserInstanceId`).
- **Actions:** Dispatch `restoreLayout({ tabId: 'tab-2', layout, paneTitles: { p1: 'Shell', p2: 'Browser' } })`.
- **Expected outcome:** Root is `'split'`. Left child terminal has `terminalId` undefined, `status` `'creating'`. Right child browser has `browserInstanceId` different from `'old-browser'`. `activePane['tab-2']` is `'p1'` (first leaf).
- **Interactions:** `stripStaleIds` for both terminal and browser content kinds, `normalizeRestoredTree` recursive traversal.
- **Source of truth:** Implementation plan D3, D5, Task 3 Step 1.

### 9. restoreLayout does not overwrite an existing layout

- **Name:** `restoreLayout` is a no-op when the tab already has a layout
- **Layer:** (Supplemental -- restoreLayout reducer)
- **Type:** unit (boundary)
- **Disposition:** new
- **Harness:** `test/unit/client/store/panesSlice.restore-layout.test.ts`
- **Preconditions:** `PanesState` with an existing layout for `'tab-1'` (leaf with `createRequestId: 'keep-me'`).
- **Actions:** Dispatch `restoreLayout({ tabId: 'tab-1', layout: newLayout, paneTitles: {} })`.
- **Expected outcome:** `layouts['tab-1']` retains the original layout (`id` is `'existing-pane'`), not the new one. This matches the `initLayout` guard behavior.
- **Interactions:** None (early return).
- **Source of truth:** Implementation plan D3 ("Don't overwrite existing layout -- same guard as initLayout").

### 10. reopenClosedTab does nothing when reopen stack is empty

- **Name:** Dispatching `reopenClosedTab` with empty stack creates no tabs
- **Layer:** 3 (App-level dispatch) / 6 (Registry interaction)
- **Type:** unit (boundary)
- **Disposition:** new
- **Harness:** `test/unit/client/store/tabsSlice.reopen-tab.test.ts` -- new file, uses `configureStore` with `tabs`, `panes`, `tabRegistry` reducers
- **Preconditions:** Empty store (no tabs, no stack entries).
- **Actions:** `await store.dispatch(reopenClosedTab())`.
- **Expected outcome:** `tabs.tabs` is empty. No errors thrown.
- **Interactions:** `reopenClosedTab` thunk early return.
- **Source of truth:** Implementation plan Task 4 Step 1.

### 11. reopenClosedTab reopens most recently closed tab in LIFO order

- **Name:** Close two tabs, reopen twice -- tabs return in reverse close order with correct titles
- **Layer:** 3 (App-level dispatch) / 2 (Redux closed-tab stack)
- **Type:** integration (multi-slice)
- **Disposition:** new
- **Harness:** `test/unit/client/store/tabsSlice.reopen-tab.test.ts`
- **Preconditions:** Create two tabs ("First" and "Second") with `initLayout`. Close both (second then first).
- **Actions:** Dispatch `reopenClosedTab()` twice.
- **Expected outcome:** First reopen restores "First" (closed last). Second reopen restores "Second" (closed first). After both reopens, stack is empty. Each reopened tab has a layout in `panes.layouts`. Active tab is set to the most recently reopened tab.
- **Interactions:** `closeTab` thunk (pushes to reopen stack), `reopenClosedTab` thunk (pops from stack, dispatches `addTab` + `restoreLayout`), `tabRegistrySlice` (push/pop), `panesSlice` (restoreLayout).
- **Source of truth:** Implementation plan Task 4 Step 1.

### 12. reopenClosedTab preserves multi-pane layout structure

- **Name:** Close a tab with a split layout, reopen it -- layout type is preserved as 'split'
- **Layer:** 3 (App-level dispatch) / (Supplemental -- layout restoration)
- **Type:** integration (multi-slice)
- **Disposition:** new
- **Harness:** `test/unit/client/store/tabsSlice.reopen-tab.test.ts`
- **Preconditions:** Create a tab, `initLayout` with terminal, then `addPane` to create a split. Verify `layoutBefore.type === 'split'`.
- **Actions:** Close the tab, then `reopenClosedTab()`.
- **Expected outcome:** Reopened tab's layout has `type === 'split'`.
- **Interactions:** Full thunk chain including `restoreLayout` with `normalizeRestoredTree`.
- **Source of truth:** Implementation plan D3, D5.

### 13. reopenClosedTab restores titleSetByUser flag

- **Name:** A tab with a user-set title retains that flag after close and reopen
- **Layer:** 3 (App-level dispatch)
- **Type:** integration (multi-slice)
- **Disposition:** new
- **Harness:** `test/unit/client/store/tabsSlice.reopen-tab.test.ts`
- **Preconditions:** Create a tab with title "Custom Title", set `titleSetByUser: true` via `updateTab`, init layout.
- **Actions:** Close the tab, then `reopenClosedTab()`.
- **Expected outcome:** Reopened tab has `titleSetByUser === true` and `title === 'Custom Title'`.
- **Interactions:** `AddTabPayload.titleSetByUser` field, `reopenClosedTab` thunk payload construction.
- **Source of truth:** Implementation plan D4.

### 14. reopenClosedTab clears corresponding localClosed entry

- **Name:** Reopening a tab removes its entry from `localClosed` registry
- **Layer:** 6 (Registry interaction)
- **Type:** integration (multi-slice)
- **Disposition:** new
- **Harness:** `test/unit/client/store/tabsSlice.reopen-tab.test.ts`
- **Preconditions:** Create a tab with `titleSetByUser: true` (so `shouldKeepClosedTab` returns true and the tab enters `localClosed`). Init layout. Close the tab.
- **Actions:** Verify `localClosed` has an entry. Dispatch `reopenClosedTab()`.
- **Expected outcome:** `localClosed` no longer contains the entry for the reopened tab. `reopenStack` is empty.
- **Interactions:** `clearClosedTabSnapshot` dispatch from within `reopenClosedTab` thunk.
- **Source of truth:** Implementation plan Task 7 Step 1.

### 15. Terminal passthrough: xterm handler returns false for Alt+H

- **Name:** The existing `getTabLifecycleAction` guard in TerminalView prevents Alt+H from reaching the terminal
- **Layer:** 4 (Terminal passthrough)
- **Type:** unit (verification of existing behavior with new input)
- **Disposition:** extend (covered by Layer 1 tests)
- **Harness:** `test/unit/client/lib/tab-switch-shortcuts.test.ts` -- test case 1 above implicitly covers this. The TerminalView code at line 1166 calls `if (getTabLifecycleAction(event)) { return false }`, so any truthy return (including `'reopen'`) triggers the passthrough.
- **Preconditions:** None.
- **Actions:** Confirm `getTabLifecycleAction({ altKey: true, ..., code: 'KeyH' })` is truthy.
- **Expected outcome:** Returns `'reopen'` (truthy), which causes `return false` in the xterm custom key handler, preventing the keystroke from reaching the terminal.
- **Interactions:** `getTabLifecycleAction` function. No TerminalView rendering needed.
- **Source of truth:** Implementation plan Task 6 note ("existing block already handles Alt+H correctly -- no code change needed").
- **Note:** This layer is covered by test case 1 above. The xterm handler's behavior is a consequence of `getTabLifecycleAction` returning a truthy value. No additional test file or test case is needed beyond what Layer 1 provides.

### 16. Alt+H appears in KEYBOARD_SHORTCUTS array

- **Name:** `KEYBOARD_SHORTCUTS` contains an entry for Alt+H with description 'Reopen closed tab' in category 'tabs'
- **Layer:** 5 (Shortcut display)
- **Type:** unit
- **Disposition:** new
- **Harness:** `test/unit/client/lib/tab-switch-shortcuts.test.ts` -- add a test importing `KEYBOARD_SHORTCUTS` from `@/lib/keyboard-shortcuts`
- **Preconditions:** None (static data).
- **Actions:** Find the entry in `KEYBOARD_SHORTCUTS` where `keys` includes `'H'` and `keys` includes `'Alt'`.
- **Expected outcome:** Entry exists with `description` containing `'Reopen'` (case-insensitive) and `category === 'tabs'`.
- **Interactions:** None.
- **Source of truth:** Implementation plan Task 6 Step 1.

### 17. E2E: Reopen most recently closed tab with Alt+H in LIFO order

- **Name:** Create 3 tabs, close 2, Alt+H reopens them in reverse close order
- **Layer:** 7 (Playwright E2E)
- **Type:** e2e-browser
- **Disposition:** new
- **Harness:** `test/e2e-browser/specs/reopen-tab.spec.ts` -- new file using `test`/`expect` from `../helpers/fixtures.js`
- **Preconditions:** `freshellPage` fixture provides initial page with 1 tab. Wait for `waitForTabCount(1)`.
- **Actions:**
  1. Press `Alt+t` twice to create tabs 2 and 3. Wait for `waitForTabCount(3)`.
  2. Record `tab2Title` and `tab3Title` from `harness.getState()`.
  3. Press `Alt+w` to close tab 3. Wait for `waitForTabCount(2)`.
  4. Press `Alt+w` to close tab 2. Wait for `waitForTabCount(1)`.
  5. Press `Alt+h`. Wait for `waitForTabCount(2)`.
  6. Assert reopened tab title matches `tab2Title` and is the active tab.
  7. Press `Alt+h` again. Wait for `waitForTabCount(3)`.
  8. Assert newest tab title matches `tab3Title`.
- **Expected outcome:** Tabs reappear in LIFO order (most recently closed first). Each reopened tab becomes the active tab.
- **Interactions:** Full stack: keyboard event capture, `getTabLifecycleAction`, `App.tsx` dispatch, `reopenClosedTab` thunk, `tabRegistrySlice` push/pop, `panesSlice` restoreLayout, React re-render.
- **Source of truth:** Implementation plan Task 8 Step 1.

### 18. E2E: Alt+H with empty reopen stack does nothing

- **Name:** Pressing Alt+H when no tabs have been closed does not create or destroy tabs
- **Layer:** 7 (Playwright E2E)
- **Type:** e2e-browser (boundary)
- **Disposition:** new
- **Harness:** `test/e2e-browser/specs/reopen-tab.spec.ts`
- **Preconditions:** `freshellPage` fixture with 1 tab. Nothing closed.
- **Actions:** Press `Alt+h`. Check state.
- **Expected outcome:** `tabs.tabs` still has length 1. No errors in console.
- **Interactions:** `reopenClosedTab` thunk early return.
- **Source of truth:** Implementation plan Task 8 Step 1.

### 19. E2E: Reopen tab with browser pane preserves split layout

- **Name:** Close a tab containing a terminal+browser split, Alt+H restores the split with both pane types
- **Layer:** 7 (Playwright E2E)
- **Type:** e2e-browser
- **Disposition:** new
- **Harness:** `test/e2e-browser/specs/reopen-tab.spec.ts`
- **Preconditions:** `freshellPage` with initial terminal. Split horizontally via context menu, select Browser pane type. Verify split layout with `layoutBefore.type === 'split'` and a child with `content.kind === 'browser'`.
- **Actions:**
  1. Create a second tab (so closing the first leaves at least 1 tab).
  2. Switch back to first tab, press `Alt+w`. Wait for `waitForTabCount(1)`.
  3. Press `Alt+h`. Wait for `waitForTabCount(2)`.
- **Expected outcome:** Reopened tab has `layout.type === 'split'`. One child has `content.kind === 'browser'`. One child has `content.kind === 'terminal'` with `status === 'creating'` (fresh terminal lifecycle).
- **Interactions:** Full stack including `stripStaleIds` for both terminal and browser pane kinds.
- **Source of truth:** Implementation plan Task 8 Step 1, D5.

## File Summary

| File | Disposition | Tests |
|------|-------------|-------|
| `test/unit/client/lib/tab-switch-shortcuts.test.ts` | Extend | #1, #2, #3, #16 |
| `test/unit/client/store/tabRegistrySlice.test.ts` | Extend | #4, #5, #6 |
| `test/unit/client/store/panesSlice.restore-layout.test.ts` | New | #7, #8, #9 |
| `test/unit/client/store/tabsSlice.reopen-tab.test.ts` | New | #10, #11, #12, #13, #14 |
| `test/e2e-browser/specs/reopen-tab.spec.ts` | New | #17, #18, #19 |

## Layer Coverage Matrix

| Layer | Tests | Status |
|-------|-------|--------|
| 1. Shortcut detection | #1, #2, #3 | Covered by extending existing file |
| 2. Redux closed-tab stack | #4, #5, #6 | Covered by extending existing file |
| 3. App-level dispatch | #10, #11, #12, #13 | Covered via thunk integration tests |
| 4. Terminal passthrough | #15 (via #1) | Covered implicitly -- no new test needed |
| 5. Shortcut display | #16 | Covered by new assertion |
| 6. Registry interaction | #14 | Covered by new assertion |
| 7. Playwright E2E | #17, #18, #19 | Covered by new spec file |
| (Supplemental) restoreLayout | #7, #8, #9 | Covered by new test file |

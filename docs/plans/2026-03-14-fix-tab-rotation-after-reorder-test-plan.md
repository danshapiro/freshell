# Fix Tab Rotation After Reorder Test Plan

Strategy reconciliation: no changes are required. The implementation plan matches the approved strategy: `state.tabs.tabs` remains the only tab-order source, the bug is in shortcut ownership between `TerminalView` and `App`, no paid or external services are involved, and the existing browser and unit harnesses are sufficient.

## Harness requirements

No new harnesses need to be built for this work. Reuse the existing harnesses below.

### Existing harnesses to reuse

1. **Playwright browser tab + terminal harness**
   - **What it does:** Boots an isolated Freshell server, opens a real browser, exposes Redux state through `window.__FRESHELL_TEST_HARNESS__`, and focuses xterm through the existing `terminal` helper.
   - **What it exposes:** Programmatic navigation, drag-and-drop, keyboard input, terminal focus assertions, and Redux state inspection through `TestHarness` and `TerminalHelper`.
   - **Estimated complexity to build:** None; already present in `test/e2e-browser/helpers/fixtures.ts`, `test/e2e-browser/helpers/test-harness.ts`, and `test/e2e-browser/helpers/terminal-helpers.ts`.
   - **Tests that depend on it:** 1, 6.

2. **App DOM keyboard harness**
   - **What it does:** Renders `App` with a controlled Redux store and lets tests dispatch bubbling DOM keyboard events from focused inputs.
   - **What it exposes:** Focus control for textarea targets, `window` keydown handling, and direct store-state inspection after each simulated shortcut.
   - **Estimated complexity to build:** None; already present in `test/unit/client/components/App.test.tsx` and reused by `test/e2e/agent-chat-tab-shortcut-focus.test.tsx`.
   - **Tests that depend on it:** 2, 3.

3. **TerminalView mocked xterm keyboard harness**
   - **What it does:** Renders `TerminalView` with a mocked xterm `Terminal`, captures `attachCustomKeyEventHandler`, and inspects the resulting store and mocked WS traffic.
   - **What it exposes:** Direct invocation of the terminal-owned keyboard handler, `preventDefault` spies, store-state inspection, and terminal-input message assertions.
   - **Estimated complexity to build:** None; already present in `test/unit/client/components/TerminalView.keyboard.test.tsx`.
   - **Tests that depend on it:** 4, 5.

4. **Pure shortcut utility harness**
   - **What it does:** Calls the extracted shortcut matcher directly with keyboard-event-shaped objects.
   - **What it exposes:** Pure return values only.
   - **Estimated complexity to build:** Low; a new Vitest file only, with no DOM or browser setup.
   - **Tests that depend on it:** 7.

### Named sources of truth

- **ST1 User goal:** After the user reorders tabs, `Ctrl+Shift+[` and `Ctrl+Shift+]` must rotate tabs in the correct current order.
- **ST2 Strategy gate from the implementation plan:** `state.tabs.tabs` is the only tab-order source; `TerminalView` owns terminal-focused shortcuts; `App` is the fallback owner and must ignore already-consumed events.
- **ST3 Acceptance mapping from the implementation plan:** terminal-focused `Ctrl+Shift+[` moves to the immediate left neighbor in the reordered list; terminal-focused `Ctrl+Shift+]` moves to the immediate right neighbor; the same shortcuts still work from non-terminal focused inputs; one physical keypress yields one tab switch.
- **ST4 Shared matcher contract from Task 3 of the implementation plan:** the extracted helper maps only `Ctrl+Shift+BracketLeft` and `Ctrl+Shift+BracketRight` to `prev` and `next`; repeat suppression and keydown/keyup filtering remain caller responsibilities.

## Test plan

1. **Name:** Reordered terminal shortcuts move one visible neighbor at a time
   - **Type:** scenario
   - **Harness:** Playwright browser tab + terminal harness
   - **Preconditions:** Freshell is open through `freshellPage`; the browser test harness is installed and connected; the active tab has a running terminal; three tabs exist.
   - **Actions:**
     1. Click the new-tab button twice to create three tabs total.
     2. Record the initial `state.tabs.tabs` order through `TestHarness.getState()`.
     3. Drag the first visible tab onto the last visible tab to create a non-default order.
     4. Wait until `state.tabs.tabs` differs from the pre-drag order and record the reordered tab IDs plus the starting `activeTabId`.
     5. Click the terminal container, confirm the xterm helper textarea is focused, and press `Ctrl+Shift+[`.
     6. Re-focus the terminal and press `Ctrl+Shift+]`.
     7. Re-focus the terminal and press `Ctrl+Shift+]` again.
   - **Expected outcome:**
     - Dragging changes the visible order and the harness-observed `state.tabs.tabs` order from the pre-drag sequence. `[ST1, ST2]`
     - The first shortcut press changes `activeTabId` to the tab immediately to the left of the starting tab in the reordered `state.tabs.tabs` list, not two positions away. `[ST1, ST3]`
     - The second shortcut press returns `activeTabId` to the starting tab, proving the previous keypress advanced exactly one step. `[ST3]`
     - The third shortcut press changes `activeTabId` to the immediate right neighbor of the starting tab in the reordered list. `[ST1, ST3]`
   - **Interactions:** Tab drag-and-drop via `dnd-kit`, `TabBar` reorder dispatch, `tabsSlice` next/previous rotation, `TerminalView` xterm keyboard ownership, and `App` window-level fallback handling.

2. **Name:** FreshClaude composer focus still rotates tabs through the non-terminal fallback path
   - **Type:** scenario
   - **Harness:** App DOM keyboard harness reusing the existing `agent-chat-tab-shortcut-focus` setup
   - **Preconditions:** `App` is rendered with at least three tabs in a known order; the FreshClaude tab is active; the composer textarea is visible and focused.
   - **Actions:**
     1. Focus the FreshClaude composer textarea.
     2. Fire a bubbling `keydown` event for `Ctrl+Shift+]`.
     3. Reset or re-render to the FreshClaude tab as the active tab.
     4. Focus the composer again and fire a bubbling `keydown` event for `Ctrl+Shift+[`.
   - **Expected outcome:**
     - With the composer focused, `Ctrl+Shift+]` advances to the next tab in the current tab order. `[ST3]`
     - With the composer focused, `Ctrl+Shift+[` moves to the previous tab in the current tab order. `[ST3]`
     - Text-input focus does not block tab switching on non-terminal surfaces because `App` remains the fallback owner outside xterm. `[ST2, ST3]`
   - **Interactions:** DOM bubbling from a focused textarea, `App` global keyboard listener, text-input detection, and `tabsSlice` next/previous reducers.

3. **Name:** App ignores a tab-switch event that xterm already consumed
   - **Type:** integration
   - **Harness:** App DOM keyboard harness
   - **Preconditions:** `App` is rendered with three tabs and the middle tab active; a focused `.xterm-helper-textarea` surrogate exists in the document; the dispatched keyboard event is cancelable.
   - **Actions:**
     1. Focus the xterm helper textarea surrogate.
     2. Create a bubbling `keydown` event for `Ctrl+Shift+]`.
     3. Call `preventDefault()` on the event before dispatch to model `TerminalView` owning the shortcut.
     4. Dispatch the event from the focused textarea surrogate.
   - **Expected outcome:**
     - `activeTabId` remains on the starting tab because `App` must treat a prevented tab-switch event as already handled. `[ST2, ST3]`
     - No fallback tab rotation occurs after the consumed event bubbles to `window`. `[ST2, ST3]`
   - **Interactions:** DOM event propagation, `App` window keydown listener, xterm helper textarea classification, and `tabsSlice` next-tab reducer boundary.

4. **Name:** TerminalView claims bracket shortcuts before xterm can translate them into terminal input
   - **Type:** integration
   - **Harness:** TerminalView mocked xterm keyboard harness
   - **Preconditions:** `TerminalView` is rendered for an active terminal tab in a three-tab store with a captured xterm custom key handler; the middle tab is active; WS sends are observable through the mock.
   - **Actions:**
     1. Invoke the captured xterm key handler with a non-repeated `keydown` event for `Ctrl+Shift+[`.
     2. Reset or recreate the middle-tab-active state.
     3. Invoke the captured xterm key handler with a non-repeated `keydown` event for `Ctrl+Shift+]`.
   - **Expected outcome:**
     - Each handled shortcut returns `false` and calls `preventDefault()`, which is the xterm-facing contract for “this key is claimed by the app, not terminal input.” `[ST2, ST4]`
     - The store’s `activeTabId` moves exactly one tab left for `[` and one tab right for `]`. `[ST3, ST4]`
     - No `terminal.input` WS message is sent for either bracket shortcut, so the key does not leak into the shell session. `[ST2]`
   - **Interactions:** xterm custom key handler contract, `TerminalView` dispatch path, mocked WS client, and `tabsSlice` next/previous reducers.

5. **Name:** TerminalView ignores repeated or non-keydown bracket shortcut events
   - **Type:** boundary
   - **Harness:** TerminalView mocked xterm keyboard harness
   - **Preconditions:** `TerminalView` is rendered with a captured xterm custom key handler and a known active tab.
   - **Actions:**
     1. Invoke the captured handler with a repeated `keydown` event for `Ctrl+Shift+]`.
     2. Invoke the captured handler with a `keyup` event for `Ctrl+Shift+]`.
   - **Expected outcome:**
     - Neither event changes `activeTabId`, because repeat suppression and keydown-only handling stay in `TerminalView` rather than the shared matcher. `[ST4]`
     - Neither ignored event claims the shortcut path that belongs only to the first non-repeated `keydown`. `[ST4]`
   - **Interactions:** xterm event lifecycle handling, `TerminalView` repeat filtering, and reducer no-op behavior when the shortcut is not claimed.

6. **Name:** Keyboard rotation preserves the reordered tab list while active selection moves
   - **Type:** invariant
   - **Harness:** Playwright browser tab + terminal harness
   - **Preconditions:** The three-tab browser setup from Test 1 has already been reordered into a non-default order and the reordered tab IDs are captured.
   - **Actions:**
     1. Focus the terminal and press `Ctrl+Shift+[`.
     2. Read `state.tabs.tabs` and `activeTabId` from the harness.
     3. Focus the terminal and press `Ctrl+Shift+]` twice, reading the same state after each press.
   - **Expected outcome:**
     - After every shortcut press, `state.tabs.tabs.map((tab) => tab.id)` remains exactly equal to the post-drag reordered list. `[ST2]`
     - After every shortcut press, `activeTabId` remains one of those reordered tab IDs and matches the immediate neighbor selected by that keypress. `[ST2, ST3]`
   - **Interactions:** Browser-level drag reorder state, terminal-focused keyboard routing, Redux state observation through the browser harness, and reducer postconditions across multiple transitions.

7. **Name:** Shared tab-switch matcher recognizes only the supported modifier and bracket combinations
   - **Type:** unit
   - **Harness:** Pure shortcut utility harness
   - **Preconditions:** The extracted shared shortcut matcher is imported directly into a Vitest unit test.
   - **Actions:**
     1. Call the matcher with `Ctrl+Shift+BracketLeft`.
     2. Call the matcher with `Ctrl+Shift+BracketRight`.
     3. Call the matcher with unsupported combinations: missing `Shift`, `Alt` present, `Meta` present, and a non-bracket `code`.
   - **Expected outcome:**
     - `Ctrl+Shift+BracketLeft` resolves to `prev` and `Ctrl+Shift+BracketRight` resolves to `next`. `[ST4]`
     - Unsupported modifier combinations and non-bracket codes resolve to `null`. `[ST4]`
   - **Interactions:** None beyond the public matcher interface.

## Coverage summary

- **Covered action space:**
  - Creating enough tabs to make order meaningful.
  - Drag reordering tabs into a non-default visible order.
  - Focusing xterm and triggering `Ctrl+Shift+[` and `Ctrl+Shift+]`.
  - Verifying left and right rotation against the live reordered `state.tabs.tabs` list.
  - Verifying non-terminal fallback from the FreshClaude composer path.
  - Verifying the handoff boundary between `TerminalView` and `App`.
  - Verifying the extracted shared shortcut matcher contract.

- **Explicit exclusions from the agreed strategy:**
  - No new reducer-level reordered-traversal test for `tabsSlice`.
    - **Why excluded:** The strategy gate explicitly rejects it as tautological because `reorderTabs`, `switchToNextTab`, and `switchToPrevTab` already operate on the same `state.tabs.tabs` array.
    - **Risk carried by exclusion:** A reducer-only regression would need to surface through the integration and browser layers instead of a dedicated reducer spec, but that is acceptable because the reported bug is in event routing rather than order storage.
  - No additional browser-only composer shortcut test.
    - **Why excluded:** The strategy gate explicitly says to reuse the existing `test/e2e/agent-chat-tab-shortcut-focus.test.tsx` regression instead of cloning it.
    - **Risk carried by exclusion:** The non-terminal fallback path remains covered at the component/e2e boundary rather than in Playwright, which is lower fidelity but cheaper and already targeted at the exact contract that must stay unchanged.
  - No performance benchmark or external-service test.
    - **Why excluded:** This is a local client-side keyboard-routing bug with no strategy requirement for performance work and no external dependencies beyond the local test server.
    - **Risk carried by exclusion:** None material for the user’s stated goal; a catastrophic slowdown would still surface during the browser regression.

- **Differential coverage:** None planned. The strategy does not provide a runnable external reference implementation for tab rotation, so the highest-value verification is end-to-end browser behavior plus focused ownership tests at the `App` and `TerminalView` boundaries.

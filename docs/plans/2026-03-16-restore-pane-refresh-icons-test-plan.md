# Restore Pane Refresh Icons Test Plan

## Strategy Reconciliation
No strategy changes requiring user approval are needed.

This is a regression fix: commit `96330ebf` ("feat(panes): add refresh button to PaneHeader") added an `onRefresh` prop and RefreshCw icon button to `PaneHeader`, but a parallel branch commit `e43e069e` ("feat: use blue icon color for busy terminals instead of pulse animation") landed on main from a stale base that lacked the refresh button, silently overwriting the PaneHeader back to a version without `onRefresh`. The refresh infrastructure (Redux actions `requestPaneRefresh`/`requestTabRefresh`/`consumePaneRefreshRequest`, `buildPaneRefreshTarget`, context menu wiring, and individual pane view consumers like `TerminalView` and `BrowserPane`) is fully intact on main. Only the PaneHeader UI button and the prop threading from `PaneContainer` through `Pane` to `PaneHeader` were lost.

The fix restores the original design from `96330ebf` and additionally threads the `onRefresh` callback through the `Pane` intermediate component and wires it from `PaneContainer`, which the original commit did not do (the original commit added the PaneHeader prop/button but never wired it from PaneContainer/Pane). This plan completes the original feature by wiring `onRefresh` end-to-end.

## Architecture

The refresh icon is a convenience affordance that dispatches the same `requestPaneRefresh` action the context menu already dispatches. The button appears in the PaneHeader action icon row (between the search button and the zoom button) for any pane whose content produces a non-null `buildPaneRefreshTarget()` -- currently `terminal` panes with a `terminalId` and `browser` panes with a non-empty URL. Panes that do not support refresh (picker, editor, agent-chat, extension) show no button.

The prop threading path is: `PaneContainer` computes `canRefresh` using `buildPaneRefreshTarget(content)` and creates an `onRefresh` callback that dispatches `requestPaneRefresh({ tabId, paneId })`. It passes this to `Pane`, which forwards it to `PaneHeader`. `PaneHeader` conditionally renders the RefreshCw icon button when `onRefresh` is provided.

## Sources Of Truth
- `S1 Original feature commit`: Commit `96330ebf` defines the intended PaneHeader prop interface (`onRefresh?: () => void`), the button markup (RefreshCw icon, "Refresh pane" title/aria-label), its placement (after search, before zoom), and the test expectations.
- `S2 Refresh infrastructure contract`: The existing `buildPaneRefreshTarget()` in `src/lib/pane-utils.ts`, `requestPaneRefresh` / `consumePaneRefreshRequest` in `src/store/panesSlice.ts`, and the consumer hooks in `TerminalView.tsx` and `BrowserPane.tsx` define which pane types support refresh and how the Redux-driven one-shot refresh request flows from dispatch to consumption.
- `S3 Context menu contract`: The context menu already shows "Refresh pane" for terminal and browser panes using the same `buildPaneRefreshTarget` gate and the same `requestPaneRefresh` dispatch. The PaneHeader icon must use the identical gate and dispatch so both paths remain consistent.
- `S4 PaneContainer wiring contract`: `PaneContainer` already computes pane-specific callbacks (`onClose`, `onFocus`, `onToggleZoom`, `onSearch`) and passes them through `Pane` to `PaneHeader`. The `onRefresh` callback must follow the same pattern.

## Action Space
- `src/components/panes/PaneHeader.tsx`: Add `onRefresh?: () => void` prop, add RefreshCw to lucide-react import, render the button between search and zoom buttons.
- `src/components/panes/Pane.tsx`: Add `onRefresh?: () => void` prop to `PaneProps`, accept it in the component, forward it to `PaneHeader`.
- `src/components/panes/PaneContainer.tsx`: Import `buildPaneRefreshTarget` and `requestPaneRefresh`, compute whether the leaf pane supports refresh, create the `onRefresh` callback, pass it to `<Pane>`.
- `test/unit/client/components/panes/PaneHeader.test.tsx`: Add RefreshCw mock to the lucide-react mock, add the refresh button test suite from `S1` (adapted for current test conventions).

## Harness Requirements
No new standalone harness is required.

| Harness | What it exercises | Notes |
| --- | --- | --- |
| `H1 PaneHeader render harness` | Existing PaneHeader unit test harness in `test/unit/client/components/panes/PaneHeader.test.tsx`; uses RTL `render`, lucide-react mocks, and `fireEvent`. | Add `RefreshCw` to the existing lucide-react mock block. |
| `H2 PaneContainer integration harness` | Existing PaneContainer tests (if any) or a new focused test that renders PaneContainer with a Redux store providing pane state. | Verifies the end-to-end wiring from PaneContainer through Pane to PaneHeader. |
| `H3 Broad verification harness` | Lint, typecheck, focused suites, then coordinated full-suite verification. | Use `npm run test:status` before `npm test`; set `FRESHELL_TEST_SUMMARY`. |

## Test Plan
### Unit Tests
1. **Name:** Refresh button renders when onRefresh is provided.
   **Type:** unit
   **Harness:** `H1`
   **Preconditions:** PaneHeader rendered with `onRefresh={vi.fn()}` and terminal content.
   **Actions:** Render PaneHeader.
   **Expected outcome:** A button with title "Refresh pane" and the RefreshCw icon (data-testid "refresh-icon") is present in the DOM. Source of truth: `S1`.
   **Interactions:** `PaneHeader` rendering path.

2. **Name:** Refresh button does not render when onRefresh is not provided.
   **Type:** unit
   **Harness:** `H1`
   **Preconditions:** PaneHeader rendered without `onRefresh`.
   **Actions:** Render PaneHeader.
   **Expected outcome:** No element with title "Refresh pane" exists. Source of truth: `S1`.
   **Interactions:** `PaneHeader` rendering path.

3. **Name:** Clicking refresh button calls onRefresh exactly once.
   **Type:** unit
   **Harness:** `H1`
   **Preconditions:** PaneHeader rendered with `onRefresh` spy.
   **Actions:** Click the "Refresh pane" button.
   **Expected outcome:** The `onRefresh` spy has been called once. Source of truth: `S1`.
   **Interactions:** `PaneHeader` click handler.

4. **Name:** Refresh button click stops propagation.
   **Type:** unit
   **Harness:** `H1`
   **Preconditions:** PaneHeader wrapped in a parent div with onClick spy.
   **Actions:** Click the "Refresh pane" button.
   **Expected outcome:** `onRefresh` called once; parent onClick not called. Source of truth: `S1`.
   **Interactions:** `e.stopPropagation()` in refresh button handler.

5. **Name:** Refresh button renders for browser panes when onRefresh is provided.
   **Type:** unit
   **Harness:** `H1`
   **Preconditions:** PaneHeader rendered with browser content and `onRefresh`.
   **Actions:** Render PaneHeader.
   **Expected outcome:** Button with title "Refresh pane" is present. Source of truth: `S1`, `S2`.
   **Interactions:** `PaneHeader` rendering path -- confirms button is not gated by content kind.

6. **Name:** Refresh button appears in correct DOM order: search, refresh, zoom, close.
   **Type:** unit
   **Harness:** `H1`
   **Preconditions:** PaneHeader rendered with `onSearch`, `onRefresh`, `onToggleZoom`, and `onClose`.
   **Actions:** Query all buttons and compare indices.
   **Expected outcome:** Search button index < refresh button index < zoom button index < close button index. Source of truth: `S1`.
   **Interactions:** DOM ordering of PaneHeader action buttons.

7. **Name:** Refresh button has correct aria-label for accessibility.
   **Type:** unit
   **Harness:** `H1`
   **Preconditions:** PaneHeader rendered with `onRefresh`.
   **Actions:** Query the button by title.
   **Expected outcome:** Button has `aria-label="Refresh pane"`. Source of truth: `S1`.
   **Interactions:** `PaneHeader` a11y attributes.

### Integration Tests
8. **Name:** PaneContainer passes onRefresh to Pane for terminal panes with terminalId.
   **Type:** integration
   **Harness:** `H2`
   **Preconditions:** Redux store has a tab with a leaf pane containing terminal content with a `terminalId` set.
   **Actions:** Render PaneContainer and inspect the rendered DOM.
   **Expected outcome:** The "Refresh pane" button is present in the rendered output. Source of truth: `S2`, `S4`.
   **Interactions:** `PaneContainer` -> `buildPaneRefreshTarget()` -> `Pane` -> `PaneHeader`.

9. **Name:** PaneContainer does not pass onRefresh for terminal panes without terminalId.
   **Type:** integration
   **Harness:** `H2`
   **Preconditions:** Redux store has a tab with a leaf pane containing terminal content with `status: 'creating'` and no `terminalId`.
   **Actions:** Render PaneContainer and inspect the rendered DOM.
   **Expected outcome:** No "Refresh pane" button is present. Source of truth: `S2`, `S4`.
   **Interactions:** `PaneContainer` -> `buildPaneRefreshTarget()` returns null -> no `onRefresh`.

10. **Name:** PaneContainer does not pass onRefresh for agent-chat, editor, or picker panes.
    **Type:** integration
    **Harness:** `H2`
    **Preconditions:** Redux store has leaf panes of non-refreshable content kinds.
    **Actions:** Render PaneContainer for each.
    **Expected outcome:** No "Refresh pane" button for any of them. Source of truth: `S2`.
    **Interactions:** `buildPaneRefreshTarget()` returns null for these kinds.

### Invariants
11. **Name:** The refresh icon gate in PaneHeader matches the context menu refresh gate.
    **Type:** invariant
    **Harness:** `H3`
    **Preconditions:** The branch has completed all code changes.
    **Actions:** Verify that `PaneContainer` uses `buildPaneRefreshTarget()` from the same module the context menu uses, and dispatches `requestPaneRefresh` from the same slice action.
    **Expected outcome:** Both paths use identical gating logic and dispatch the same action, ensuring they always agree on which panes are refreshable. Source of truth: `S3`.
    **Interactions:** Code review / grep verification during test run.

### Regressions
12. **Name:** Existing search and zoom buttons remain functional after refresh button insertion.
    **Type:** regression
    **Harness:** `H1`
    **Preconditions:** PaneHeader rendered with `onSearch`, `onRefresh`, `onToggleZoom`.
    **Actions:** Click search and zoom buttons.
    **Expected outcome:** Both still fire their respective callbacks. Source of truth: existing test suite.
    **Interactions:** PaneHeader action button row.

13. **Name:** Context menu "Refresh pane" still works.
    **Type:** regression
    **Harness:** `H3`
    **Preconditions:** Full test suite passes.
    **Actions:** Run the existing context menu test suite.
    **Expected outcome:** All existing tests pass unchanged. Source of truth: `S3`.
    **Interactions:** Context menu -> `requestPaneRefresh` -> `TerminalView` / `BrowserPane` consumer.

## Coverage Summary
This plan covers the full regression:
- PaneHeader: onRefresh prop, RefreshCw icon button, placement, a11y, propagation behavior.
- Pane: prop threading from PaneContainer to PaneHeader.
- PaneContainer: computation of refresh eligibility using the shared `buildPaneRefreshTarget` gate, dispatch of `requestPaneRefresh`.
- All pane content kinds: terminal (with/without terminalId), browser (with/without URL), agent-chat, editor, picker, extension.
- Consistency invariant: the icon button and context menu use the same gate and action.
- Regression: existing search/zoom buttons and context menu refresh remain unaffected.

The plan intentionally does not add new test infrastructure for the end-to-end refresh flow (Redux action -> terminal reconnect / browser reload) because that flow is already covered by existing tests and was never broken -- only the UI icon entry point was lost.

Broad verification should finish with:
- `npm run lint`
- `npx tsc --noEmit`
- Focused suite: `npm run test:vitest -- --run test/unit/client/components/panes/PaneHeader.test.tsx`
- `npm run test:status`
- `FRESHELL_TEST_SUMMARY="restore pane refresh icons" CI=true npm test`

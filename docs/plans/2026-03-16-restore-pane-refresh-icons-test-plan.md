# Restore Pane Refresh Icons - Test Plan

## Strategy Reconciliation

The agreed strategy allocates:
- **40% PaneHeader unit tests** (render conditions, click handler, propagation, ARIA, DOM ordering)
- **30% PaneContainer integration tests** (eligibility per content type)
- **15% Pane forwarding test**
- **15% Mock updates and regression**

After reading the implementation plan and the full codebase (current source, existing tests, original commits `96330ebf` and `061c8518`, and the overwriting commit `e43e069e`), I confirm this allocation is sound. The original feature introduced tests at the PaneHeader and PaneContainer levels but never added a Pane forwarding test -- which is exactly why the Pane gap went undetected when the overwrite landed. The 15% Pane allocation fills that gap.

No strategy changes requiring user approval.

## Sources of Truth

- **S1**: Commit `96330ebf` -- Original PaneHeader `onRefresh` prop, RefreshCw icon button, `title="Refresh pane"`, `aria-label="Refresh pane"`, placement after search and before zoom.
- **S2**: `src/lib/pane-utils.ts` `buildPaneRefreshTarget()` -- Returns non-null for terminal panes with `terminalId` and browser panes with non-empty URL. Returns null for all other content kinds.
- **S3**: Context menu in `src/components/context-menu/menu-defs.ts` and `ContextMenuProvider.tsx` -- Uses `buildPaneRefreshTarget()` for gating and `requestPaneRefresh` for dispatch. The PaneHeader icon must use the identical gate and dispatch.
- **S4**: Commit `061c8518` -- PaneContainer wiring: compute `refreshTarget` via `buildPaneRefreshTarget(node.content)`, create `handleRefresh` callback dispatching `requestPaneRefresh({ tabId, paneId: node.id })`, pass as `onRefresh` to `<Pane>`.
- **S5**: Existing PaneContainer prop-threading pattern -- `onClose`, `onFocus`, `onToggleZoom`, `onSearch` all flow `PaneContainer -> Pane -> PaneHeader`. `onRefresh` must follow the same pattern.

## Harnesses

| ID | Harness | Infrastructure | Notes |
|----|---------|---------------|-------|
| H1 | PaneHeader unit test harness | `test/unit/client/components/panes/PaneHeader.test.tsx`, RTL `render`, lucide-react mocks, `fireEvent` | Must add `RefreshCw` to existing lucide-react mock block |
| H2 | Pane unit test harness | `test/unit/client/components/panes/Pane.test.tsx`, RTL `render`, lucide-react mocks, `fireEvent` | Must add `RefreshCw`, `Search`, `Maximize2`, `Minimize2` to lucide-react mock (currently only has `X` and `Circle`) |
| H3 | PaneContainer integration harness | `test/unit/client/components/panes/PaneContainer.test.tsx`, RTL `render` with Redux `Provider` + `configureStore` | Must add `RefreshCw` to existing lucide-react mock block |
| H4 | Existing test suite | `npm run test:vitest -- --run <path>` for focused runs, `npm test` for broad verification | No changes needed |

## Mock Updates Required (15% allocation -- regression/infra)

Before any new tests can pass, these mock updates are required in existing test files:

1. **PaneHeader.test.tsx lucide-react mock**: Add `RefreshCw` entry:
   ```tsx
   RefreshCw: ({ className }: { className?: string }) => (
     <svg data-testid="refresh-icon" className={className} />
   ),
   ```

2. **Pane.test.tsx lucide-react mock**: Add `Search`, `Maximize2`, `Minimize2`, `RefreshCw` entries so that PaneHeader can render its full button set when Pane forwards props.

3. **PaneContainer.test.tsx lucide-react mock**: Add `RefreshCw` entry (same as above).

4. **PaneContainer.createContent.test.tsx** and **PaneLayout.test.tsx**: Add `RefreshCw` to lucide-react mock if they render PaneHeader. (Per original commit `061c8518`, both needed a one-line mock addition.)

## Test Plan

### PaneHeader Unit Tests (40%)

#### T01: Refresh button renders when onRefresh is provided
- **Type:** unit
- **Harness:** H1
- **Preconditions:** PaneHeader rendered with `onRefresh={vi.fn()}` and terminal content.
- **Actions:** Render PaneHeader.
- **Expected outcome:** A button with `title="Refresh pane"` is present. An element with `data-testid="refresh-icon"` is present.
- **Source of truth:** S1

#### T02: Refresh button does not render when onRefresh is omitted
- **Type:** unit
- **Harness:** H1
- **Preconditions:** PaneHeader rendered without `onRefresh` prop (or `onRefresh={undefined}`).
- **Actions:** Render PaneHeader.
- **Expected outcome:** `screen.queryByTitle('Refresh pane')` returns null.
- **Source of truth:** S1

#### T03: Clicking refresh button calls onRefresh exactly once
- **Type:** unit
- **Harness:** H1
- **Preconditions:** PaneHeader rendered with `onRefresh` spy.
- **Actions:** `fireEvent.click(screen.getByTitle('Refresh pane'))`.
- **Expected outcome:** `onRefresh` spy called exactly once.
- **Source of truth:** S1

#### T04: Refresh button click stops propagation to parent
- **Type:** unit
- **Harness:** H1
- **Preconditions:** PaneHeader wrapped in `<div onClick={parentClick}>`. `onRefresh` and `parentClick` are both `vi.fn()`.
- **Actions:** Click the "Refresh pane" button.
- **Expected outcome:** `onRefresh` called once; `parentClick` not called.
- **Source of truth:** S1

#### T05: Refresh button renders for browser panes when onRefresh is provided
- **Type:** unit
- **Harness:** H1
- **Preconditions:** PaneHeader rendered with `content={{ kind: 'browser', browserInstanceId: 'b1', url: 'https://example.com', devToolsOpen: false }}` and `onRefresh={vi.fn()}`.
- **Actions:** Render PaneHeader.
- **Expected outcome:** Button with `title="Refresh pane"` is present.
- **Source of truth:** S1, S2 (PaneHeader itself is not gated by content kind -- gating is in PaneContainer. This confirms PaneHeader shows the button for any content when `onRefresh` is provided.)

#### T06: Refresh button appears in correct DOM order (search < refresh < zoom < close)
- **Type:** unit
- **Harness:** H1
- **Preconditions:** PaneHeader rendered with `onSearch`, `onRefresh`, `onToggleZoom`, and `onClose` all provided. Terminal content so search button is visible.
- **Actions:** `screen.getAllByRole('button')` and find indices of each button by title.
- **Expected outcome:** indexOf("Search in terminal") < indexOf("Refresh pane") < indexOf("Maximize pane") < indexOf("Close pane").
- **Source of truth:** S1

#### T07: Refresh button has correct aria-label
- **Type:** unit
- **Harness:** H1
- **Preconditions:** PaneHeader rendered with `onRefresh={vi.fn()}`.
- **Actions:** Query button by title "Refresh pane".
- **Expected outcome:** `btn.getAttribute('aria-label')` equals `'Refresh pane'`.
- **Source of truth:** S1

### Pane Forwarding Tests (15%)

#### T08: Pane forwards onRefresh to PaneHeader
- **Type:** unit
- **Harness:** H2
- **Preconditions:** Pane rendered with `title="Test"`, `status="running"`, `content={makeTerminalContent()}`, `onRefresh={vi.fn()}`, `onClose={vi.fn()}`, `onFocus={vi.fn()}`.
- **Actions:** Render Pane. Query for "Refresh pane" button.
- **Expected outcome:** Button with `title="Refresh pane"` is present in the DOM. Clicking it calls the `onRefresh` spy exactly once.
- **Source of truth:** S5 (prop-threading pattern)

#### T09: Pane does not render refresh button when onRefresh is omitted
- **Type:** unit
- **Harness:** H2
- **Preconditions:** Pane rendered with `title="Test"`, `status="running"`, `content={makeTerminalContent()}`, no `onRefresh` prop.
- **Actions:** Render Pane.
- **Expected outcome:** `screen.queryByTitle('Refresh pane')` returns null.
- **Source of truth:** S5

### PaneContainer Integration Tests (30%)

#### T10: Renders refresh button for terminal pane with terminalId
- **Type:** integration
- **Harness:** H3
- **Preconditions:** Redux store with a tab and leaf pane: `content.kind === 'terminal'`, `terminalId: 'term-1'`, `status: 'running'`.
- **Actions:** Render PaneContainer with this leaf node.
- **Expected outcome:** Button with `title="Refresh pane"` is present.
- **Source of truth:** S2, S4

#### T11: Does not render refresh button for terminal pane without terminalId
- **Type:** integration
- **Harness:** H3
- **Preconditions:** Redux store with a tab and leaf pane: `content.kind === 'terminal'`, no `terminalId`, `status: 'creating'`.
- **Actions:** Render PaneContainer.
- **Expected outcome:** `screen.queryByTitle('Refresh pane')` returns null.
- **Source of truth:** S2

#### T12: Renders refresh button for browser pane with URL
- **Type:** integration
- **Harness:** H3
- **Preconditions:** Redux store with leaf pane: `content.kind === 'browser'`, `url: 'https://example.com'`.
- **Actions:** Render PaneContainer.
- **Expected outcome:** Button with `title="Refresh pane"` is present.
- **Source of truth:** S2

#### T13: Does not render refresh button for picker pane
- **Type:** integration
- **Harness:** H3
- **Preconditions:** Redux store with leaf pane: `content.kind === 'picker'`.
- **Actions:** Render PaneContainer.
- **Expected outcome:** No "Refresh pane" button.
- **Source of truth:** S2

#### T14: Clicking refresh button dispatches requestPaneRefresh to Redux store
- **Type:** integration
- **Harness:** H3
- **Preconditions:** Redux store with terminal pane with `terminalId`.
- **Actions:** Render PaneContainer. Click "Refresh pane" button. Read `store.getState().panes.refreshRequestsByPane`.
- **Expected outcome:** `refreshRequestsByPane['tab-1']['pane-1']` is defined, with `target` matching `{ kind: 'terminal', createRequestId: '<the pane createRequestId>' }`.
- **Source of truth:** S3, S4

### Regression Tests (15% -- shared with mock updates)

#### T15: Existing search and zoom buttons remain functional after refresh button insertion
- **Type:** regression
- **Harness:** H1
- **Preconditions:** PaneHeader rendered with `onSearch`, `onRefresh`, `onToggleZoom`, and `onClose`.
- **Actions:** Click search button. Click zoom button.
- **Expected outcome:** `onSearch` called once. `onToggleZoom` called once. Neither call is affected by the presence of `onRefresh`.
- **Source of truth:** Existing PaneHeader test suite (search and zoom describe blocks)

#### T16: Context menu "Refresh pane" tests still pass
- **Type:** regression
- **Harness:** H4
- **Preconditions:** Code changes complete.
- **Actions:** Run full test suite.
- **Expected outcome:** All existing context-menu tests pass unchanged, confirming the PaneHeader icon uses the same gating logic and dispatch as the context menu.
- **Source of truth:** S3

### Invariant (code review verification)

#### T17: PaneContainer uses same gate and dispatch as context menu
- **Type:** invariant (manual verification during code review)
- **Harness:** N/A (grep/code inspection)
- **Preconditions:** All code changes applied.
- **Actions:** Verify `PaneContainer.tsx` imports `buildPaneRefreshTarget` from `@/lib/pane-utils` (same as `menu-defs.ts`) and `requestPaneRefresh` from `@/store/panesSlice` (same as `ContextMenuProvider.tsx`).
- **Expected outcome:** Both paths use identical imports. No separate/duplicated gating logic.
- **Source of truth:** S3

## Verification Sequence

1. `npm run lint` -- catch a11y violations
2. `npx tsc --noEmit` -- typecheck all changes
3. `npm run test:vitest -- --run test/unit/client/components/panes/PaneHeader.test.tsx` -- focused PaneHeader suite
4. `npm run test:vitest -- --run test/unit/client/components/panes/Pane.test.tsx` -- focused Pane suite
5. `npm run test:vitest -- --run test/unit/client/components/panes/PaneContainer.test.tsx` -- focused PaneContainer suite
6. `npm run test:status` -- check coordinator availability
7. `FRESHELL_TEST_SUMMARY="restore pane refresh icons" CI=true npm test` -- coordinated full suite

## Coverage Summary

| Layer | Tests | What it covers |
|-------|-------|---------------|
| PaneHeader (unit) | T01-T07 | Conditional render, click handler, propagation, ARIA, DOM order, content-kind independence |
| Pane (unit) | T08-T09 | Prop forwarding from Pane to PaneHeader (the gap that allowed the original regression) |
| PaneContainer (integration) | T10-T14 | End-to-end wiring: buildPaneRefreshTarget gating, Redux dispatch, per-content-type eligibility |
| Regression | T15-T16 | Existing buttons unaffected, context menu unaffected |
| Invariant | T17 | Gate/dispatch consistency between icon and context menu paths |

Total: 17 tests covering 4 layers, aligned with the 40/30/15/15 strategy.

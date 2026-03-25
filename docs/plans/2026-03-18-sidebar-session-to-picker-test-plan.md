# Test Plan: Sidebar Session Click Routes to Picker Pane

**Feature:** When a picker pane (`{ kind: 'picker' }`) exists in the active tab, clicking a sidebar session rehydrates into that pane instead of splitting a new one. When multiple picker panes exist, the leftmost-then-uppermost (tree traversal order) wins.

**Strategy reconciliation:** The agreed testing strategy assumed all logic lived in `handleItemClick` in `Sidebar.tsx` with no new harness infrastructure needed, using the existing React Testing Library + Redux store harness in `test/e2e/sidebar-click-opens-pane.test.tsx`. The implementation plan confirms this exactly:
- Three files change: `src/lib/pane-utils.ts` (new `findFirstPickerPane` utility), `src/components/Sidebar.tsx` (new picker step between dedup and split), and `test/e2e/sidebar-click-opens-pane.test.tsx` (new test cases).
- No server, no WebSocket, no backend changes.
- `updatePaneContent` from `panesSlice` is the correct dispatch action (same as `PickerWrapper.handleSelect`).
- `collectPaneEntries` left-first traversal order already implements the tiebreak rule.

The strategy holds unchanged. No strategy changes requiring user approval.

---

## Harness Requirements

No new harness infrastructure needed. The existing harness in `test/e2e/sidebar-click-opens-pane.test.tsx` is sufficient:

- **Harness:** `createStore(options)` — configures a real Redux store with `configureStore`, accepts pre-built pane layouts, returns a store with real reducers for tabs, panes, settings, sessions.
- **Render:** `renderSidebar(store)` — renders the real `Sidebar` component inside a `Provider`. Returns the store and an `onNavigate` mock.
- **Input simulation:** `fireEvent.click` on sidebar session buttons drives the real `handleItemClick` path.
- **Output inspection:** `store.getState()` after each click gives the full Redux state, including pane tree shape and content, active tab, and active pane. This is the primary assertion surface.

All tests below depend on this harness. No new harness work is needed before writing tests.

---

## Test Plan

### 1. Picker-present, single picker pane (happy path)

- **Name:** Clicking a session fills an existing picker pane instead of splitting a new pane
- **Type:** scenario
- **Disposition:** new
- **Harness:** `createStore` + `renderSidebar` in `test/e2e/sidebar-click-opens-pane.test.tsx`
- **Preconditions:** Active tab `tab-1` has a single leaf pane with `{ kind: 'picker' }` as content. One Claude session exists in the sidebar.
- **Actions:** `fireEvent.click` on the session button.
- **Expected outcome:**
  - Source of truth: user's description ("put it in the panel picker instead of a new panel").
  - `state.panes.layouts['tab-1'].type` remains `'leaf'` (no split was created).
  - `state.panes.layouts['tab-1'].content.kind` is `'terminal'` (picker was replaced).
  - `state.panes.layouts['tab-1'].content.resumeSessionId` matches the clicked session's ID.
  - `state.panes.layouts['tab-1'].content.mode` is `'claude'`.
  - `state.tabs.tabs` has length 1 (no new tab created).
  - `state.panes.activePane['tab-1']` is the picker pane ID (now filled).
- **Interactions:** `updatePaneContent` reducer, `setActivePane` reducer, `buildResumeContent` utility.

### 2. Picker-present, picker plus non-picker pane

- **Name:** Clicking a session fills the picker pane without disturbing other panes in the split
- **Type:** integration
- **Disposition:** new
- **Harness:** `createStore` + `renderSidebar` in `test/e2e/sidebar-click-opens-pane.test.tsx`
- **Preconditions:** Active tab `tab-1` has a horizontal split: left child is a shell terminal pane, right child is a picker pane. Active pane is the shell pane.
- **Actions:** `fireEvent.click` on a sidebar session button.
- **Expected outcome:**
  - Source of truth: user's description ("put it in the panel picker").
  - `state.panes.layouts['tab-1'].type` is `'split'` (tree shape unchanged, no extra pane added).
  - Left child content is still `{ kind: 'terminal', mode: 'shell' }` (untouched).
  - Right child content has `kind: 'terminal'` with correct `resumeSessionId` (picker was replaced in-place).
  - `state.tabs.tabs` has length 1.
  - `state.panes.activePane['tab-1']` is the picker pane ID.
- **Interactions:** `updatePaneContent` reducer replaces only the picker leaf; `collectPaneEntries` traversal order (picker is right child, shell is left).

### 3. Two picker panes — tiebreak selects leftmost

- **Name:** With two picker panes, the leftmost one is filled and the right one stays a picker
- **Type:** boundary
- **Disposition:** new
- **Harness:** `createStore` + `renderSidebar` in `test/e2e/sidebar-click-opens-pane.test.tsx`
- **Preconditions:** Active tab `tab-1` has a horizontal split: left child is `{ kind: 'picker' }`, right child is `{ kind: 'picker' }`. Active pane is the right picker pane.
- **Actions:** `fireEvent.click` on a sidebar session button.
- **Expected outcome:**
  - Source of truth: user's description ("choose the leftmost and then uppermost to tiebreak").
  - `state.panes.layouts['tab-1'].type` is `'split'`.
  - Left child content has `kind: 'terminal'` with the correct `resumeSessionId`.
  - Right child content remains `{ kind: 'picker' }` (untouched).
  - `state.panes.activePane['tab-1']` is the left picker pane ID.
- **Interactions:** `findFirstPickerPane` traversal order (left-child-first depth-first) determines which pane is selected.

### 4. Dedup takes precedence over picker

- **Name:** When a session is already open elsewhere, dedup fires and the picker pane is untouched
- **Type:** invariant
- **Disposition:** new
- **Harness:** `createStore` + `renderSidebar` in `test/e2e/sidebar-click-opens-pane.test.tsx`
- **Preconditions:** Two tabs exist. Active tab `tab-1` has a single picker pane. Tab `tab-2` has a terminal pane with `resumeSessionId` matching the session in the sidebar.
- **Actions:** `fireEvent.click` on the session button.
- **Expected outcome:**
  - Source of truth: user's description + plan design decision ("Dedup: if session is already open in a pane, focus it" runs before picker check).
  - `state.tabs.activeTabId` is `'tab-2'` (switched to the tab holding the existing session).
  - `state.panes.activePane['tab-2']` is the existing terminal pane.
  - `state.panes.layouts['tab-1']` still has `{ kind: 'picker' }` as content (picker not used).
- **Interactions:** `findPaneForSession` utility, `setActiveTab` dispatch, `setActivePane` dispatch.

### 5. No picker present — existing split behavior is unchanged (regression)

- **Name:** Clicking a session when no picker pane exists still splits a new pane (regression)
- **Type:** regression
- **Disposition:** existing (`'clicking a session splits a pane in the current tab'` in `sidebar-click-opens-pane.test.tsx`)
- **Harness:** `createStore` + `renderSidebar` in `test/e2e/sidebar-click-opens-pane.test.tsx`
- **Preconditions:** Active tab `tab-1` has a single shell terminal pane (no picker).
- **Actions:** `fireEvent.click` on a sidebar session button.
- **Expected outcome:**
  - Source of truth: existing behavior contract confirmed by prior test.
  - `state.panes.layouts['tab-1'].type` is `'split'` (new pane was added).
  - New split child has `resumeSessionId` matching the clicked session.
  - `state.tabs.tabs` has length 1 (no new tab).
- **Interactions:** `addPane` reducer (not `updatePaneContent`), confirming picker path is correctly skipped when no picker exists.

### 6. Agent-chat session type (freshclaude) fills a picker pane

- **Name:** Clicking a freshclaude session fills a picker pane with agent-chat content
- **Type:** integration
- **Disposition:** new
- **Harness:** `createStore` + `renderSidebar` in `test/e2e/sidebar-click-opens-pane.test.tsx`
- **Preconditions:** Active tab `tab-1` has a single picker pane. One session with `sessionType: 'freshclaude'` exists in the sidebar.
- **Actions:** `fireEvent.click` on the freshclaude session button.
- **Expected outcome:**
  - Source of truth: user's description ("anything else — it should rehydrate into the pane").
  - `state.panes.layouts['tab-1'].type` is `'leaf'` (no split).
  - `state.panes.layouts['tab-1'].content.kind` is `'agent-chat'`.
  - `state.panes.layouts['tab-1'].content.provider` is `'freshclaude'`.
  - `state.panes.layouts['tab-1'].content.resumeSessionId` matches the clicked session's ID.
  - `state.tabs.tabs` has length 1.
- **Interactions:** `buildResumeContent` routes `sessionType: 'freshclaude'` → `kind: 'agent-chat'`; `updatePaneContent` writes the result to the picker slot.

### 7. `findFirstPickerPane` — returns undefined for a non-picker leaf

- **Name:** `findFirstPickerPane` returns undefined when the tree has no picker pane
- **Type:** unit
- **Disposition:** new
- **Harness:** Direct import + Vitest assertions in `test/unit/client/lib/pane-utils.test.ts`
- **Preconditions:** A single leaf `PaneNode` with `kind: 'terminal'` content.
- **Actions:** Call `findFirstPickerPane(node)`.
- **Expected outcome:** Returns `undefined`. Source of truth: function contract (no picker present → no match).
- **Interactions:** None (pure function).

### 8. `findFirstPickerPane` — returns id for a single picker leaf

- **Name:** `findFirstPickerPane` returns the pane id for a single picker leaf
- **Type:** unit
- **Disposition:** new
- **Harness:** Direct import + Vitest assertions in `test/unit/client/lib/pane-utils.test.ts`
- **Preconditions:** A single leaf `PaneNode` with `kind: 'picker'` content and id `'pane-picker'`.
- **Actions:** Call `findFirstPickerPane(node)`.
- **Expected outcome:** Returns `'pane-picker'`. Source of truth: function contract (picker leaf → return its id).
- **Interactions:** None (pure function).

### 9. `findFirstPickerPane` — tiebreak: left picker wins in a split with two pickers

- **Name:** `findFirstPickerPane` returns the left child's id when both children are pickers
- **Type:** unit
- **Disposition:** new
- **Harness:** Direct import + Vitest assertions in `test/unit/client/lib/pane-utils.test.ts`
- **Preconditions:** A split `PaneNode` with two picker leaf children (ids `'left'` and `'right'`).
- **Actions:** Call `findFirstPickerPane(node)`.
- **Expected outcome:** Returns `'left'`. Source of truth: user's tiebreak rule (leftmost first) + left-child-first traversal.
- **Interactions:** None (pure function).

### 10. `findFirstPickerPane` — finds picker in right subtree when left has none

- **Name:** `findFirstPickerPane` finds a picker in the right subtree when the left has no picker
- **Type:** unit
- **Disposition:** new
- **Harness:** Direct import + Vitest assertions in `test/unit/client/lib/pane-utils.test.ts`
- **Preconditions:** A split `PaneNode` — left child is a shell terminal leaf, right child is a picker leaf.
- **Actions:** Call `findFirstPickerPane(node)`.
- **Expected outcome:** Returns `'right'`. Source of truth: function contract (left exhausted, falls back to right).
- **Interactions:** None (pure function).

### 11. `findFirstPickerPane` — returns undefined for a split with no pickers

- **Name:** `findFirstPickerPane` returns undefined when neither child in a split is a picker
- **Type:** unit
- **Disposition:** new
- **Harness:** Direct import + Vitest assertions in `test/unit/client/lib/pane-utils.test.ts`
- **Preconditions:** A split `PaneNode` with two terminal leaf children, neither `kind: 'picker'`.
- **Actions:** Call `findFirstPickerPane(node)`.
- **Expected outcome:** Returns `undefined`. Source of truth: function contract.
- **Interactions:** None (pure function).

### 12. `findFirstPickerPane` — finds picker deep in a nested left subtree

- **Name:** `findFirstPickerPane` finds a picker pane nested inside the left subtree of a split
- **Type:** boundary
- **Disposition:** new
- **Harness:** Direct import + Vitest assertions in `test/unit/client/lib/pane-utils.test.ts`
- **Preconditions:** Outer split: left child is itself a vertical split (top: shell, bottom: picker), right child is a shell leaf.
- **Actions:** Call `findFirstPickerPane(node)`.
- **Expected outcome:** Returns the bottom-left picker pane's id. Source of truth: left-child-first depth-first traversal (left subtree is searched before right).
- **Interactions:** None (pure function).

### 13. Fix `BackgroundTerminal` import in test file

- **Name:** Test file compiles without missing type import
- **Type:** regression
- **Disposition:** extend
- **Harness:** TypeScript compiler (`npx tsc --noEmit`) and Vitest run
- **Preconditions:** `test/e2e/sidebar-click-opens-pane.test.tsx` references `BackgroundTerminal` in the `createStore` function signature but does not import it from `@/store/types`.
- **Actions:** Add `BackgroundTerminal` to the existing `import type { ProjectGroup } from '@/store/types'` import. Run typecheck.
- **Expected outcome:** No type errors on that import. Source of truth: TypeScript compiler contract.
- **Interactions:** No runtime behavior change; compile-time correctness only.

### 14. Full file suite — all existing tests remain green

- **Name:** All pre-existing sidebar-click tests continue to pass after implementation
- **Type:** regression
- **Disposition:** existing
- **Harness:** `npm run test:vitest -- --run test/e2e/sidebar-click-opens-pane.test.tsx`
- **Preconditions:** Implementation is complete. All new test cases have been added.
- **Actions:** Run the full file.
- **Expected outcome:** All tests pass (existing + new). Source of truth: pre-existing tests as the regression baseline for dedup, no-active-tab fallback, and normal split paths.
- **Interactions:** Full `handleItemClick` branch coverage.

---

## Coverage Summary

### Action space covered

| User action / behavior | Covered by | Test # |
|---|---|---|
| Click session → picker fills (single picker pane) | Scenario test | 1 |
| Click session → picker fills (split with picker + non-picker) | Integration test | 2 |
| Click session → leftmost picker selected (two pickers) | Boundary test | 3 |
| Click session already open → dedup wins, picker untouched | Invariant test | 4 |
| Click session → no picker → existing split behavior | Regression test | 5 |
| Click freshclaude session → picker fills with agent-chat content | Integration test | 6 |
| `findFirstPickerPane` (non-picker leaf) | Unit test | 7 |
| `findFirstPickerPane` (single picker leaf) | Unit test | 8 |
| `findFirstPickerPane` (tiebreak: left wins) | Unit test | 9 |
| `findFirstPickerPane` (right subtree fallback) | Unit test | 10 |
| `findFirstPickerPane` (no pickers in split) | Unit test | 11 |
| `findFirstPickerPane` (deep nested left subtree) | Unit test | 12 |
| Missing type import fix | Regression test | 13 |
| Full regression baseline | Regression suite | 14 |

### Areas explicitly excluded per agreed strategy

- **Server/WebSocket behavior:** The feature is pure client-side Redux state manipulation. No backend changes. Not tested here.
- **Visual rendering / DOM assertions:** The Redux state is the direct proxy for what the user sees (pane tree shape + content). DOM assertions on rendered pane content would add fragility without adding confidence.
- **Performance timing assertions:** Pane trees are small (rarely more than 8 leaves). `findFirstPickerPane` traversal is O(n) with negligible cost. No timing assertion needed.
- **Picker in non-active tab:** By design, the feature only searches the active tab's layout. A picker in a background tab is invisible to `handleItemClick`. This is intentional scope matching with the existing split behavior.
- **Session metadata tracking via `mergeSessionMetadataByKey`:** The plan includes this in the picker path for consistency with the split path, but it is not directly observable through this test harness without simulating a second store read after a tab metadata refresh. The primary correctness evidence (pane content replaced, no split) is sufficient to confirm the picker path ran; metadata tracking is a secondary consistency concern covered by the plan's design decision documentation.

### Risks from exclusions

- **Metadata omission risk (low):** If `mergeSessionMetadataByKey` is accidentally missing from the picker path, the session won't be tracked in the tab's `sessionMetadataByKey`. This would be observable via a tab header that doesn't show the session label. Not covered by automated tests here; covered by the plan's explicit design decision (step 4 in the plan) and code review.
- **Visual rendering gap (negligible):** The tests assert on Redux state, not rendered output. If `PaneContainer` fails to re-render after `updatePaneContent`, the state would be correct but the UI would be stale. This class of bug is covered by the existing `PaneContainer` test suite and is not introduced by this feature.

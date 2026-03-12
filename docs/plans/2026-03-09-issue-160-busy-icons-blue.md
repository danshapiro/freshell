# Issue 160 Busy Icons Blue Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Replace the pulsing busy icon treatment with a static blue treatment for creating/busy terminal indicators.

**Architecture:** Move the creating/busy icon styling behind one shared status-style helper so tab items and pane headers cannot drift. Prove the change with unit tests for the shared surfaces and an integration-style e2e harness that renders both tab and pane busy indicators together.

**Tech Stack:** React 18, Redux Toolkit, Vitest, Testing Library, TypeScript

---

### Task 1: Capture the busy-icon regression in unit tests

**Files:**
- Modify: `test/unit/client/components/panes/PaneHeader.test.tsx`
- Modify: `test/unit/client/components/TabBar.test.tsx`
- Modify: `test/unit/client/components/TabItem.test.tsx`

**Step 1: Write the failing tests**

Update the existing creating-status assertions so they expect a blue class and explicitly reject `animate-pulse`. Add a `TabItem` unit test for the fallback status-dot path when pane icons are unavailable.

**Step 2: Run targeted tests to verify they fail**

Run: `npx vitest run test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabItem.test.tsx`

Expected: FAIL because the current creating/busy icon classes still use pulsing muted styling.

### Task 2: Capture the same behavior in an integration-style e2e harness

**Files:**
- Create: `test/e2e/busy-indicator-color-flow.test.tsx`

**Step 1: Write the failing test**

Render a creating tab in `TabBar` alongside a creating `PaneHeader`, inspect the busy icons in the rendered DOM, and expect a blue class without `animate-pulse`.

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/e2e/busy-indicator-color-flow.test.tsx`

Expected: FAIL because both surfaces still render pulsing busy icons.

### Task 3: Implement shared busy-icon styling

**Files:**
- Create: `src/lib/terminal-status-indicator.ts`
- Modify: `src/components/TabItem.tsx`
- Modify: `src/components/panes/PaneHeader.tsx`

**Step 1: Write the minimal implementation**

Create a shared helper that maps terminal statuses to icon classes and dot classes, with `creating` returning the new static blue treatment. Update `TabItem` and `PaneHeader` to use the shared helper instead of duplicating status-style switches.

**Step 2: Run targeted tests to verify it passes**

Run: `npx vitest run test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabItem.test.tsx`

Expected: PASS

Run: `npx vitest run test/e2e/busy-indicator-color-flow.test.tsx`

Expected: PASS

### Task 4: Refactor and verify the wider surface

**Files:**
- Modify as needed from prior tasks only

**Step 1: Keep the status styling centralized**

Refactor only as needed so `creating` status styling is defined once and reused consistently.

**Step 2: Run broader verification**

Run: `npx vitest run test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabItem.test.tsx test/e2e/busy-indicator-color-flow.test.tsx`

Expected: PASS

Run: `CI=true npm test`

Expected: PASS

### Task 5: Commit the issue fix

**Files:**
- Stage the plan, tests, helper, and component updates from this issue only

**Step 1: Commit**

Run:

```bash
git add docs/plans/2026-03-09-issue-160-busy-icons-blue.md \
  docs/plans/2026-03-09-issue-160-busy-icons-blue-test-plan.md \
  src/lib/terminal-status-indicator.ts \
  src/components/TabItem.tsx \
  src/components/panes/PaneHeader.tsx \
  test/unit/client/components/panes/PaneHeader.test.tsx \
  test/unit/client/components/TabBar.test.tsx \
  test/unit/client/components/TabItem.test.tsx \
  test/e2e/busy-indicator-color-flow.test.tsx
git commit -m "style(ui): make busy indicators blue"
```

Expected: commit created with only the issue `#160` changes.

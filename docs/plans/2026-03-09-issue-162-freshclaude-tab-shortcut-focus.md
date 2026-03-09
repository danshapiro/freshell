# Issue 162 FreshClaude Tab Shortcut Focus Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Make Freshell's tab-switch keyboard shortcuts work while focus is inside a FreshClaude composer textarea.

**Architecture:** Keep tab switching centralized in `src/App.tsx`, but narrow the keyboard filter so the existing tab-switch shortcut is handled before the generic text-input early return. Add both a unit regression and an app-level e2e regression so the fix is locked in from the focused-textarea path that currently fails.

**Tech Stack:** React 18, Redux Toolkit, Vitest, Testing Library, TypeScript

---

### Task 1: Capture the focused-textarea regression in the unit suite

**Files:**
- Modify: `test/unit/client/components/App.test.tsx`

**Step 1: Write the failing test**

Add a regression that renders `App` with multiple tabs, focuses a real `<textarea>`, dispatches `Ctrl+Shift+[` and `Ctrl+Shift+]` from that focused textarea, and expects the active tab to change.

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/App.test.tsx --testNamePattern "focused textarea"`

Expected: FAIL because `src/App.tsx` returns early for text inputs before checking the tab-switch shortcut.

### Task 2: Capture the same regression in an app-level e2e flow

**Files:**
- Create: `test/e2e/agent-chat-tab-shortcut-focus.test.tsx`

**Step 1: Write the failing test**

Render `App` with a FreshClaude pane mocked as an agent-chat view containing a textarea labelled `Chat message input`. Focus that textarea, send the existing tab-switch shortcut, and assert the Redux tab state moves to the next/previous tab.

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/e2e/agent-chat-tab-shortcut-focus.test.tsx`

Expected: FAIL for the same reason as the unit regression.

### Task 3: Implement the focused-input shortcut handling

**Files:**
- Modify: `src/App.tsx`

**Step 1: Write the minimal implementation**

Extract a small helper that recognizes Freshell's tab-switch shortcuts and invoke it before the text-input guard so only those shortcuts bypass the text-input early return. Keep all other typing behavior unchanged.

**Step 2: Run targeted tests to verify it passes**

Run: `npx vitest run test/unit/client/components/App.test.tsx --testNamePattern "focused textarea"`

Expected: PASS

Run: `npx vitest run test/e2e/agent-chat-tab-shortcut-focus.test.tsx`

Expected: PASS

### Task 4: Refactor and verify the full surface

**Files:**
- Modify as needed from prior tasks only

**Step 1: Keep the shortcut logic explicit**

Refactor only if needed so the handler reads clearly and does not broaden keyboard handling beyond tab switching.

**Step 2: Run broader verification**

Run: `npx vitest run test/unit/client/components/App.test.tsx test/e2e/agent-chat-tab-shortcut-focus.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx`

Expected: PASS

Run: `npm test`

Expected: PASS

### Task 5: Commit the issue fix

**Files:**
- Stage the plan, tests, and implementation files from this issue only

**Step 1: Commit**

Run:

```bash
git add docs/plans/2026-03-09-issue-162-freshclaude-tab-shortcut-focus.md \
  docs/plans/2026-03-09-issue-162-freshclaude-tab-shortcut-focus-test-plan.md \
  src/App.tsx \
  test/unit/client/components/App.test.tsx \
  test/e2e/agent-chat-tab-shortcut-focus.test.tsx
git commit -m "fix(agent-chat): honor tab shortcuts from focused composer"
```

Expected: commit created with only the issue `#162` changes.

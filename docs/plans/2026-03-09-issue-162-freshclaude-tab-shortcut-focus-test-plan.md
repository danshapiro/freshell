# Issue 162 FreshClaude Tab Shortcut Focus Test Plan

## Scope

Validate that Freshell's existing tab-switch shortcuts continue to work when focus is inside FreshClaude's composer textarea, without changing unrelated text-input behavior.

## Targeted Red-Green Checks

1. `npx vitest run test/unit/client/components/App.test.tsx --testNamePattern "focused textarea"`
   - Red: fails before the `App` shortcut handler fix.
   - Green: passes after the fix.
2. `npx vitest run test/e2e/agent-chat-tab-shortcut-focus.test.tsx`
   - Red: fails before the fix.
   - Green: passes after the fix.

## Regression Verification

1. `npx vitest run test/unit/client/components/App.test.tsx test/e2e/agent-chat-tab-shortcut-focus.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx`
   - Confirms the new focused-composer flow and the existing pane-header app harness both still pass.
2. `npm test`
   - Confirms the issue does not break the broader repo test suite.

## Notes

- No end-user documentation change is expected because this fixes the existing shortcut behavior rather than introducing a new shortcut.

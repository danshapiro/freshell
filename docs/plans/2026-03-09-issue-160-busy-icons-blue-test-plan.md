# Issue 160 Busy Icons Blue Test Plan

## Scope

Validate that creating/busy terminal indicators no longer pulse and instead use a static blue treatment across the tab and pane chrome surfaces.

## Targeted Red-Green Checks

1. `npx vitest run test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabItem.test.tsx`
   - Red: fails before the shared status-style change.
   - Green: passes after the change.
2. `npx vitest run test/e2e/busy-indicator-color-flow.test.tsx`
   - Red: fails before the change.
   - Green: passes after the change.

## Regression Verification

1. `npx vitest run test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/TabBar.test.tsx test/unit/client/components/TabItem.test.tsx test/e2e/busy-indicator-color-flow.test.tsx`
   - Confirms both unit and integration coverage for the new styling.
2. `CI=true npm test`
   - Confirms the style change does not regress the broader client/server suite.

## Notes

- This issue changes styling only; no end-user documentation update is expected.

# Issue 158 Settings Devices Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Fix the Settings > Devices section so duplicate machines collapse into one entry, each remote device entry can be deleted, and the Devices section moves to the end of the settings page.

**Architecture:** Extract the device-list normalization into a small pure helper that groups device records before rendering. Persist dismissed remote device IDs in the existing tab-registry local storage layer so deletion survives reloads. Keep `SettingsView` responsible only for rendering grouped entries and wiring save/delete actions.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, Vitest, Testing Library

---

### Task 1: Capture duplicate grouping, delete, and ordering regressions

**Files:**
- Create: `test/unit/client/lib/known-devices.test.ts`
- Modify: `test/unit/client/components/SettingsView.test.tsx`
- Create: `test/e2e/settings-devices-flow.test.tsx`

**Step 1: Write the failing tests**

Add a pure unit test that proves two stored device IDs with the same machine label should collapse into one known-device entry. Update the SettingsView unit coverage so the Devices section is expected after Network Access and each remote device row exposes a Delete action that hides the row and persists dismissed IDs. Add an integration-style flow test that renders the real SettingsView with duplicate device records and exercises the dedupe/delete behavior end-to-end.

**Step 2: Run targeted tests to verify they fail**

Run: `npx vitest run test/unit/client/lib/known-devices.test.ts test/unit/client/components/SettingsView.test.tsx`

Expected: FAIL because the helper does not exist yet, the section is still ordered near the top, and there is no Delete action.

Run: `npx vitest run test/e2e/settings-devices-flow.test.tsx`

Expected: FAIL because duplicate machine labels still render as duplicate rows and the Devices section is not last.

### Task 2: Add persisted dismissed-device support and grouped known-device derivation

**Files:**
- Create: `src/lib/known-devices.ts`
- Modify: `src/store/storage-keys.ts`
- Modify: `src/store/tabRegistrySlice.ts`

**Step 1: Write the minimal implementation**

Add a dedicated helper that groups remote devices by their stored machine label while keeping the current machine separate. Extend the tab-registry storage helpers with a persisted dismissed-device ID list and grouped alias persistence so a deleted device row can stay removed across reloads.

**Step 2: Run targeted unit tests**

Run: `npx vitest run test/unit/client/lib/known-devices.test.ts`

Expected: PASS

### Task 3: Update SettingsView to use grouped devices, delete remote devices, and move the section

**Files:**
- Modify: `src/components/SettingsView.tsx`

**Step 1: Wire the UI to the new device model**

Render grouped device entries from the new helper, persist rename/delete actions through the tab-registry helpers, and move the Devices section to the bottom of the settings page after Network Access. The local machine keeps its Save action; remote devices get both Save and Delete actions.

**Step 2: Run targeted view tests**

Run: `npx vitest run test/unit/client/components/SettingsView.test.tsx`

Expected: PASS

Run: `npx vitest run test/e2e/settings-devices-flow.test.tsx`

Expected: PASS

### Task 4: Refactor and verify the combined surface

**Files:**
- Modify only files already touched for this issue

**Step 1: Keep grouping and persistence logic centralized**

Refactor only as needed so the duplicate-device rules and dismissed-device persistence live outside the component and can be exercised directly in tests.

**Step 2: Run broader verification**

Run: `npx vitest run test/unit/client/lib/known-devices.test.ts test/unit/client/components/SettingsView.test.tsx test/e2e/settings-devices-flow.test.tsx`

Expected: PASS

Run: `CI=true npm test`

Expected: PASS

### Task 5: Commit the issue fix

**Files:**
- Stage the plan, helper, storage, component, and test changes from this issue only

**Step 1: Commit**

Run:

```bash
git add docs/plans/2026-03-09-issue-158-settings-devices-management.md \
  docs/plans/2026-03-09-issue-158-settings-devices-management-test-plan.md \
  src/lib/known-devices.ts \
  src/store/storage-keys.ts \
  src/store/tabRegistrySlice.ts \
  src/components/SettingsView.tsx \
  test/unit/client/lib/known-devices.test.ts \
  test/unit/client/components/SettingsView.test.tsx \
  test/e2e/settings-devices-flow.test.tsx
git commit -m "fix(settings): clean up device management"
```

Expected: commit created with only the issue `#158` changes.

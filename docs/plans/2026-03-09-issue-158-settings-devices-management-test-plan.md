# Issue 158 Settings Devices Management Test Plan

## Scope

Validate that Settings > Devices collapses duplicate machine records, allows remote devices to be deleted, and appears at the end of the settings page.

## Targeted Red-Green Checks

1. `npx vitest run test/unit/client/lib/known-devices.test.ts test/unit/client/components/SettingsView.test.tsx`
   - Red: fails before the helper/storage/UI changes.
   - Green: passes after the grouped-device and delete-action implementation lands.
2. `npx vitest run test/e2e/settings-devices-flow.test.tsx`
   - Red: fails before the Devices UI is updated.
   - Green: passes after the real SettingsView flow collapses duplicates, deletes remote devices, and renders last.

## Regression Verification

1. `npx vitest run test/unit/client/lib/known-devices.test.ts test/unit/client/components/SettingsView.test.tsx test/e2e/settings-devices-flow.test.tsx`
   - Confirms the focused helper, component, and integration coverage together.
2. `CI=true npm test`
   - Confirms the broader client/server suite still passes.

## Notes

- This issue is limited to settings/device-management behavior; no README change is expected.

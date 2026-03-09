# Issue 151 Disable WSL Port-Forward Startup in Tests Test Plan

## Scope

Validate that automatic WSL2 port-forward repair can be explicitly disabled during server startup and that the logger test harness applies that opt-out by default for spawned child processes.

## Targeted Red-Green Checks

1. `npx vitest run --config vitest.server.config.ts test/unit/server/wsl-port-forward-startup.test.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/logger.separation.harness.test.ts`
   - Red: fails before the startup gate exists and before `server/index.ts` uses it.
   - Green: passes after the startup gate is implemented and wired into startup.

## Regression Verification

1. `npx vitest run --config vitest.server.config.ts test/unit/server/wsl-port-forward-startup.test.ts test/unit/server/wsl-port-forward.test.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/logger.separation.harness.test.ts test/integration/server/logger.separation.test.ts`
   - Confirms the startup helper, WSL port-forward logic, and logger harness behavior remain aligned.
2. `CI=true npm test`
   - Confirms the full client/server suite still passes.

## Notes

- This is a server startup/test-isolation fix; no README update is expected.

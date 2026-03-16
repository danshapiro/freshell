# Test Plan: Restore FRESHELL_DISABLE_WSL_PORT_FORWARD Environment Variable

**Implementation plan:** `docs/plans/2026-03-16-restore-wsl-disable-env-var.md`

**Strategy:** The implementation adds a `disabled` status discriminant to `WslPortForwardingPlan` and `WslPortForwardingTeardownPlan`, an `isWslPortForwardingDisabledByEnv()` helper in `wsl-port-forward.ts`, and handler updates in `network-manager.ts` and `network-router.ts`. Tests follow Red-Green-Refactor ordering per task.

---

## Task 1 Tests: `disabled` Status and Env Var Check in `wsl-port-forward.ts`

### Test 1.1 — computeWslPortForwardingPlan returns disabled when env var is "1"

| Field | Value |
|---|---|
| **Name** | `computeWslPortForwardingPlan returns disabled when env var is "1"` |
| **Type** | Unit |
| **Harness** | `vitest.server.config.ts`, file `test/unit/server/wsl-port-forward.test.ts` |
| **Preconditions** | `isWSL2()` mocked to return `true`. `process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = '1'`. |
| **Actions** | Call `computeWslPortForwardingPlan([3001])`. |
| **Expected outcome** | Returns `{ status: 'disabled' }`. No `execSync` calls for IP detection, portproxy, or firewall queries. |
| **Source of truth** | `wsl-port-forward.ts` — the env check must short-circuit before any system calls. |

### Test 1.2 — computeWslPortForwardingPlan returns disabled when env var is "True" (case-insensitive)

| Field | Value |
|---|---|
| **Name** | `computeWslPortForwardingPlan returns disabled when env var is "True" (case-insensitive)` |
| **Type** | Unit |
| **Harness** | `vitest.server.config.ts`, file `test/unit/server/wsl-port-forward.test.ts` |
| **Preconditions** | `isWSL2()` mocked to return `true`. `process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = 'True'`. |
| **Actions** | Call `computeWslPortForwardingPlan([3001])`. |
| **Expected outcome** | Returns `{ status: 'disabled' }`. |
| **Source of truth** | `wsl-port-forward.ts` — the helper must lower-case before comparing. |

### Test 1.3 — computeWslPortForwardingPlan returns disabled when env var is "yes"

| Field | Value |
|---|---|
| **Name** | `computeWslPortForwardingPlan returns disabled when env var is "yes"` |
| **Type** | Unit |
| **Harness** | `vitest.server.config.ts`, file `test/unit/server/wsl-port-forward.test.ts` |
| **Preconditions** | `isWSL2()` mocked to return `true`. `process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = 'yes'`. |
| **Actions** | Call `computeWslPortForwardingPlan([3001])`. |
| **Expected outcome** | Returns `{ status: 'disabled' }`. |
| **Source of truth** | `wsl-port-forward.ts` — "yes" is an accepted truthy value. |

### Test 1.4 — computeWslPortForwardingPlan proceeds normally when env var is unset

| Field | Value |
|---|---|
| **Name** | `computeWslPortForwardingPlan proceeds normally when env var is unset` |
| **Type** | Unit |
| **Harness** | `vitest.server.config.ts`, file `test/unit/server/wsl-port-forward.test.ts` |
| **Preconditions** | `isWSL2()` mocked to return `false`. `FRESHELL_DISABLE_WSL_PORT_FORWARD` not set. |
| **Actions** | Call `computeWslPortForwardingPlan([3001])`. |
| **Expected outcome** | Returns `{ status: 'not-wsl2' }` — normal non-WSL path unchanged. |
| **Source of truth** | `wsl-port-forward.ts` — the env check must not interfere with normal flow. |

### Test 1.5 — computeWslPortForwardingPlan proceeds normally when env var is "0"

| Field | Value |
|---|---|
| **Name** | `computeWslPortForwardingPlan proceeds normally when env var is "0"` |
| **Type** | Unit |
| **Harness** | `vitest.server.config.ts`, file `test/unit/server/wsl-port-forward.test.ts` |
| **Preconditions** | `isWSL2()` mocked to return `false`. `process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = '0'`. |
| **Actions** | Call `computeWslPortForwardingPlan([3001])`. |
| **Expected outcome** | Returns `{ status: 'not-wsl2' }` — "0" is not a truthy value. |
| **Source of truth** | `wsl-port-forward.ts` — only "1", "true", "yes" are truthy. |

### Test 1.6 — computeWslPortForwardingPlanAsync returns disabled when env var is set

| Field | Value |
|---|---|
| **Name** | `computeWslPortForwardingPlanAsync returns disabled when env var is set` |
| **Type** | Unit |
| **Harness** | `vitest.server.config.ts`, file `test/unit/server/wsl-port-forward.test.ts` |
| **Preconditions** | `isWSL2()` mocked to return `true`. `process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = '1'`. |
| **Actions** | Call `await computeWslPortForwardingPlanAsync([3001])`. |
| **Expected outcome** | Returns `{ status: 'disabled' }`. No async IP/portproxy/firewall probes. |
| **Source of truth** | `wsl-port-forward.ts` — the async variant must also respect the env var. |

### Test 1.7 — computeWslPortForwardingTeardownPlan returns disabled when env var is set

| Field | Value |
|---|---|
| **Name** | `computeWslPortForwardingTeardownPlan returns disabled when env var is set` |
| **Type** | Unit |
| **Harness** | `vitest.server.config.ts`, file `test/unit/server/wsl-port-forward.test.ts` |
| **Preconditions** | `isWSL2()` mocked to return `true`. `process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = '1'`. |
| **Actions** | Call `computeWslPortForwardingTeardownPlan([3001])`. |
| **Expected outcome** | Returns `{ status: 'disabled' }`. |
| **Source of truth** | `wsl-port-forward.ts` — teardown sync variant must also respect the env var. |

### Test 1.8 — computeWslPortForwardingTeardownPlanAsync returns disabled when env var is set

| Field | Value |
|---|---|
| **Name** | `computeWslPortForwardingTeardownPlanAsync returns disabled when env var is set` |
| **Type** | Unit |
| **Harness** | `vitest.server.config.ts`, file `test/unit/server/wsl-port-forward.test.ts` |
| **Preconditions** | `isWSL2()` mocked to return `true`. `process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = '1'`. |
| **Actions** | Call `await computeWslPortForwardingTeardownPlanAsync([3001])`. |
| **Expected outcome** | Returns `{ status: 'disabled' }`. |
| **Source of truth** | `wsl-port-forward.ts` — teardown async variant must also respect the env var. |

**Run command:** `npm run test:vitest -- --config vitest.server.config.ts test/unit/server/wsl-port-forward.test.ts`

**Red phase:** Tests 1.1-1.3 and 1.6-1.8 fail because the `disabled` status does not exist. Tests 1.4-1.5 pass (existing behavior).

**Green phase:** Add the `disabled` discriminant to both union types, add `isWslPortForwardingDisabledByEnv()`, and gate all four public functions.

---

## Task 2 Tests: Handle `disabled` Status in NetworkManager

### Test 2.1 — getStatus treats disabled WSL port forwarding plan as no stale exposure

| Field | Value |
|---|---|
| **Name** | `treats disabled WSL port forwarding plan as no stale exposure` |
| **Type** | Unit |
| **Harness** | `vitest.server.config.ts`, file `test/unit/server/network-manager.test.ts` |
| **Preconditions** | `detectFirewall` mocked to return `{ platform: 'wsl2', active: true }`. `isPortReachable` mocked to return `true`. `computeWslPortForwardingPlanAsync` mocked to return `{ status: 'disabled' }`. Server bound to `0.0.0.0`. Config `host: '0.0.0.0'`, `configured: true`. |
| **Actions** | Call `await manager.getStatus()`. |
| **Expected outcome** | `status.remoteAccessNeedsRepair` is `false`. The `disabled` plan is treated the same as `noop` — no stale-managed-exposure flag is set. |
| **Source of truth** | `network-manager.ts` line 335: `staleManagedWindowsExposure = wslPlan.status === 'ready'` — `disabled` is not `ready`, so `staleManagedWindowsExposure` stays false. This test confirms the implicit correctness and guards against future regressions if the condition is changed. |

**Run command:** `npm run test:vitest -- --config vitest.server.config.ts test/unit/server/network-manager.test.ts`

**Red phase:** The test may pass immediately because the existing `=== 'ready'` check already handles `disabled` by exclusion. If it does pass, this is a "green-from-the-start" guard test. If TypeScript compilation fails because `disabled` is not yet in the type (mocked module returning an undeclared discriminant), the compilation error is the red signal.

**Green phase:** Ensure the type update from Task 1 is applied. If the code already works, no runtime change needed in `network-manager.ts`.

---

## Task 3 Tests: Handle `disabled` Status in Network Router

### Test 3.1 — configure-firewall returns no configuration required when WSL port forwarding is disabled

| Field | Value |
|---|---|
| **Name** | `returns no configuration required when WSL port forwarding is disabled by env var` |
| **Type** | Integration |
| **Harness** | `vitest.server.config.ts`, file `test/integration/server/network-api.test.ts` |
| **Preconditions** | `detectFirewall` mocked to return `{ platform: 'wsl2', active: true }`. `isPortReachable` mocked to return `false`. `computeWslPortForwardingPlanAsync` mocked to return `{ status: 'disabled' }`. Config: `host: '0.0.0.0'`, `configured: true`. |
| **Actions** | `POST /api/network/configure-firewall` with auth token. |
| **Expected outcome** | HTTP 200. Response body: `{ method: 'none', message: 'No configuration changes required' }`. No PowerShell spawn. |
| **Source of truth** | `network-router.ts` `resolveRepairAction` — `disabled` must be handled alongside `noop` and `not-wsl2` on line 284. |

### Test 3.2 — disable-remote-access returns no-op when WSL port forwarding teardown is disabled

| Field | Value |
|---|---|
| **Name** | `returns no-op when WSL port forwarding teardown is disabled by env var` |
| **Type** | Integration |
| **Harness** | `vitest.server.config.ts`, file `test/integration/server/network-api.test.ts` |
| **Preconditions** | `detectFirewall` mocked to return `{ platform: 'wsl2', active: true }`. `computeWslPortForwardingTeardownPlanAsync` mocked to return `{ status: 'disabled' }`. Config: `host: '0.0.0.0'`, `configured: true`. |
| **Actions** | `POST /api/network/disable-remote-access` with auth token. |
| **Expected outcome** | HTTP 200. Response body `method` is `'none'`. No PowerShell spawn. |
| **Source of truth** | `network-router.ts` `resolveRemoteAccessDisableAction` — `disabled` must be handled alongside `not-wsl2` on line 361. |

**Run command:** `npm run test:vitest -- --config vitest.server.config.ts test/integration/server/network-api.test.ts`

**Red phase:** Test 3.1 fails because `resolveRepairAction` does not include `disabled` in the `noop`/`not-wsl2` check (line 284), so the `disabled` plan falls through to the `return { kind: 'confirmable', ... }` branch and tries to read `plan.script` on a `{ status: 'disabled' }` object (which has no `script` property). Test 3.2 fails because `resolveRemoteAccessDisableAction` does not include `disabled` in the `not-wsl2` check (line 361), so the `disabled` teardown plan falls through to the `noop` check and then to `return { kind: 'confirmable', ... }`.

**Green phase:** Add `|| plan.status === 'disabled'` to the noop/not-wsl2 condition in `resolveRepairAction`. Add `|| teardownPlan.status === 'disabled'` to the not-wsl2 condition in `resolveRemoteAccessDisableAction`.

---

## Task 4 Tests: Existing Integration Guards (Regression)

### Test 4.1 — Boot-time WSL repair remains removed

| Field | Value |
|---|---|
| **Name** | `keeps boot-time WSL repair removed from the server startup path` |
| **Type** | Integration (existing) |
| **Harness** | `vitest.server.config.ts`, file `test/integration/server/wsl-port-forward.test.ts` |
| **Preconditions** | None (reads filesystem). |
| **Actions** | Run existing test. |
| **Expected outcome** | PASS. `server/index.ts` has no WSL port-forward imports. `server/wsl-port-forward-startup.ts` does not exist. |
| **Source of truth** | Integration guard ensuring deleted startup helper stays deleted. |

### Test 4.2 — Env var is not injected into child processes

| Field | Value |
|---|---|
| **Name** | `does not inject a startup-only WSL port-forward suppression env var` |
| **Type** | Integration (existing) |
| **Harness** | `vitest.server.config.ts`, file `test/integration/server/logger.separation.harness.test.ts` |
| **Preconditions** | None. |
| **Actions** | Run existing test. |
| **Expected outcome** | PASS. `buildServerProcessEnv({}, {})` does not include `FRESHELL_DISABLE_WSL_PORT_FORWARD`. The env var is opt-in by the operator, not auto-injected. |
| **Source of truth** | Integration guard ensuring no auto-injection of the env var into child processes. |

### Test 4.3 — Full WSL port forward unit suite passes

| Field | Value |
|---|---|
| **Name** | Full `wsl-port-forward.test.ts` suite |
| **Type** | Unit (existing + new) |
| **Harness** | `vitest.server.config.ts`, file `test/unit/server/wsl-port-forward.test.ts` |
| **Preconditions** | All Task 1 changes applied. |
| **Actions** | Run full test file. |
| **Expected outcome** | All tests PASS. |
| **Source of truth** | No regressions in existing WSL port forwarding logic. |

### Test 4.4 — Full network manager unit suite passes

| Field | Value |
|---|---|
| **Name** | Full `network-manager.test.ts` suite |
| **Type** | Unit (existing + new) |
| **Harness** | `vitest.server.config.ts`, file `test/unit/server/network-manager.test.ts` |
| **Preconditions** | All Task 1-2 changes applied. |
| **Actions** | Run full test file. |
| **Expected outcome** | All tests PASS. |
| **Source of truth** | No regressions in network manager behavior. |

### Test 4.5 — Full network API integration suite passes

| Field | Value |
|---|---|
| **Name** | Full `network-api.test.ts` suite |
| **Type** | Integration (existing + new) |
| **Harness** | `vitest.server.config.ts`, file `test/integration/server/network-api.test.ts` |
| **Preconditions** | All Task 1-3 changes applied. |
| **Actions** | Run full test file. |
| **Expected outcome** | All tests PASS. |
| **Source of truth** | No regressions in network API behavior. |

**Run command:** `npm run test:vitest -- --config vitest.server.config.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/logger.separation.harness.test.ts test/unit/server/wsl-port-forward.test.ts test/unit/server/network-manager.test.ts test/integration/server/network-api.test.ts`

---

## Task 5: Refactor Verification

### Test 5.1 — TypeScript compilation passes

| Field | Value |
|---|---|
| **Name** | Full typecheck |
| **Type** | Static analysis |
| **Harness** | `npm run check` (runs `tsc --noEmit` then full test suite) |
| **Preconditions** | All implementation changes applied. |
| **Actions** | Run `npm run check`. |
| **Expected outcome** | PASS. No type errors from unhandled `disabled` discriminant in exhaustive checks or switch statements. |
| **Source of truth** | TypeScript compiler. |

### Test 5.2 — Coordinated full test suite passes

| Field | Value |
|---|---|
| **Name** | Full coordinated test run |
| **Type** | Full suite |
| **Harness** | `npm test` |
| **Preconditions** | All changes applied. |
| **Actions** | Run `npm test`. |
| **Expected outcome** | PASS. No regressions anywhere in the codebase. |
| **Source of truth** | Coordinated test runner (both default and server configs). |

---

## Test Ordering Summary (Red-Green-Refactor)

| Phase | Tests | Expected Result |
|---|---|---|
| **Task 1 Red** | 1.1, 1.2, 1.3, 1.6, 1.7, 1.8 | FAIL (type/runtime missing) |
| **Task 1 Red** | 1.4, 1.5 | PASS (existing behavior) |
| **Task 1 Green** | 1.1-1.8 | All PASS |
| **Task 2 Red** | 2.1 | PASS or type-error (implicit correctness) |
| **Task 2 Green** | 2.1 | PASS |
| **Task 3 Red** | 3.1, 3.2 | FAIL (unhandled `disabled` in router) |
| **Task 3 Green** | 3.1, 3.2 | PASS |
| **Task 4** | 4.1-4.5 | All PASS (regression verification) |
| **Task 5** | 5.1, 5.2 | All PASS (refactor verification) |

## Files Modified by Tests

| File | Tests Added |
|---|---|
| `test/unit/server/wsl-port-forward.test.ts` | 1.1-1.8 (new `describe('FRESHELL_DISABLE_WSL_PORT_FORWARD', ...)` block) |
| `test/unit/server/network-manager.test.ts` | 2.1 (new test in existing `getStatus` area) |
| `test/integration/server/network-api.test.ts` | 3.1 (in `POST /api/network/configure-firewall` block), 3.2 (in `POST /api/network/disable-remote-access` block) |

## Files Modified by Implementation

| File | Changes |
|---|---|
| `server/wsl-port-forward.ts` | Add `disabled` to both union types, add `isWslPortForwardingDisabledByEnv()`, gate 4 public functions |
| `server/network-router.ts` | Add `disabled` to noop/not-wsl2 conditions in `resolveRepairAction` and `resolveRemoteAccessDisableAction` |
| `server/network-manager.ts` | No runtime changes expected (implicit correctness), but verify type compilation |

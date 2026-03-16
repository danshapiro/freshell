# Restore FRESHELL_DISABLE_WSL_PORT_FORWARD Environment Variable

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Re-introduce the `FRESHELL_DISABLE_WSL_PORT_FORWARD` environment variable so operators can opt out of all WSL2 port forwarding behavior (both status-driven repair prompts and user-initiated repair actions) without modifying config files or source code.

**Architecture:** The env var check is placed in the two public `computeWslPortForwardingPlan*` entry points and their teardown counterparts inside `server/wsl-port-forward.ts`. When `FRESHELL_DISABLE_WSL_PORT_FORWARD` is truthy (`1`, `true`, `yes`), the plan functions return `{ status: 'disabled' }`, a new discriminant that the rest of the system treats as a no-op. This single choke point covers every consumer: `NetworkManager.getStatus()` (status display), `network-router.ts` (repair actions), and verification callbacks. No new module is created; no startup helper is reintroduced.

**Tech Stack:** Node.js, TypeScript, Vitest

---

## Strategy Gate

The original `FRESHELL_DISABLE_WSL_PORT_FORWARD` lived in a now-deleted `server/wsl-port-forward-startup.ts` that gated boot-time automatic port forwarding. That boot-time path was intentionally removed in the windows-privilege-fixes PR (the current architecture only performs WSL port forwarding on explicit user request through the configure-firewall API). The integration test at `test/integration/server/wsl-port-forward.test.ts` explicitly asserts that boot-time repair and the startup helper file are gone.

This plan does not reintroduce boot-time repair or the startup helper module. Instead, it restores the env var as a broader kill switch that prevents WSL port forwarding from being offered, prompted, or executed at all. When the env var is set:

- `NetworkManager.getStatus()` will not flag WSL remote access as needing repair (because `computeWslPortForwardingPlanAsync` returns `disabled` instead of `ready`).
- `POST /api/network/configure-firewall` will resolve to `{ method: 'none', message: 'No configuration changes required' }` for WSL2 platforms (because the plan is `disabled`, treated like `noop`).
- `POST /api/network/disable-remote-access` teardown will also resolve to noop (because the teardown plan returns `disabled`).
- The setup wizard and settings UI will not show "fix firewall" prompts for WSL2 when the env var is active.

Direct decisions:

- Add `{ status: 'disabled' }` as a new discriminant on both `WslPortForwardingPlan` and `WslPortForwardingTeardownPlan` union types. This is preferable to reusing `not-wsl2` (which would be semantically misleading) or `noop` (which implies the rules are already correct).
- Place the env var check inside all four public plan/teardown functions (`computeWslPortForwardingPlan`, `computeWslPortForwardingPlanAsync`, `computeWslPortForwardingTeardownPlan`, `computeWslPortForwardingTeardownPlanAsync`), immediately after the `isWSL2()` guard and before any system calls. This is the narrowest choke point that covers all consumers.
- Extract a small `isWslPortForwardingDisabledByEnv()` helper within `wsl-port-forward.ts` (not a separate module) to centralize the env var parsing. Accept `1`, `true`, `yes` (case-insensitive) as truthy values.
- Update `NetworkManager.getStatus()` to handle `disabled` the same as `noop` — no stale-managed-exposure flag, no repair-needed signal.
- Update `network-router.ts` `resolveRepairAction` and `resolveRemoteAccessDisableAction` to handle `disabled` the same as `noop` — return `NO_CONFIGURATION_CHANGES_REQUIRED` or the appropriate no-op response.
- The existing integration test asserting `wsl-port-forward-startup.ts` does not exist stays unchanged and continues to pass.
- The existing harness test asserting `FRESHELL_DISABLE_WSL_PORT_FORWARD` is not injected into child processes stays unchanged and continues to pass (the env var is opt-in, not auto-injected).
- No `docs/index.html` update. This is an operator-facing env var, not a user-facing UI feature.

Rejected approaches:

- Reintroducing `server/wsl-port-forward-startup.ts` as a startup gate. The boot-time repair path was intentionally removed and is guarded by integration tests. The env var should work at the plan computation level, not the startup level.
- Checking the env var in `NetworkManager` or `network-router.ts` instead of `wsl-port-forward.ts`. This would scatter the check across multiple consumers and miss future consumers. The plan computation functions are the single choke point.
- Reusing `{ status: 'not-wsl2' }` when the env var is set. This is semantically wrong (the system is WSL2, just deliberately disabled) and could confuse diagnostic logging.
- Making the env var a runtime config setting. The user asked for an environment variable, and it serves an operational purpose (CI, testing, specialized deployments) where config files may not be available.

### Task 1: Add the `disabled` Status to WSL Plan Types and Env Var Check

**Files:**
- Modify: `server/wsl-port-forward.ts`
- Modify: `test/unit/server/wsl-port-forward.test.ts`

**Step 1: Write the failing tests**

Add these tests to `test/unit/server/wsl-port-forward.test.ts`:

```ts
describe('FRESHELL_DISABLE_WSL_PORT_FORWARD', () => {
  afterEach(() => {
    delete process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD
  })

  it('computeWslPortForwardingPlan returns disabled when env var is "1"', () => {
    vi.mocked(isWSL2).mockReturnValue(true)
    process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = '1'

    const plan = computeWslPortForwardingPlan([3001])

    expect(plan).toEqual({ status: 'disabled' })
  })

  it('computeWslPortForwardingPlan returns disabled when env var is "true" (case-insensitive)', () => {
    vi.mocked(isWSL2).mockReturnValue(true)
    process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = 'True'

    const plan = computeWslPortForwardingPlan([3001])

    expect(plan).toEqual({ status: 'disabled' })
  })

  it('computeWslPortForwardingPlan returns disabled when env var is "yes"', () => {
    vi.mocked(isWSL2).mockReturnValue(true)
    process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = 'yes'

    const plan = computeWslPortForwardingPlan([3001])

    expect(plan).toEqual({ status: 'disabled' })
  })

  it('computeWslPortForwardingPlan proceeds normally when env var is unset', () => {
    vi.mocked(isWSL2).mockReturnValue(false)

    const plan = computeWslPortForwardingPlan([3001])

    expect(plan).toEqual({ status: 'not-wsl2' })
  })

  it('computeWslPortForwardingPlan proceeds normally when env var is "0"', () => {
    vi.mocked(isWSL2).mockReturnValue(false)
    process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = '0'

    const plan = computeWslPortForwardingPlan([3001])

    expect(plan).toEqual({ status: 'not-wsl2' })
  })

  it('computeWslPortForwardingPlanAsync returns disabled when env var is set', async () => {
    vi.mocked(isWSL2).mockReturnValue(true)
    process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = '1'

    const plan = await computeWslPortForwardingPlanAsync([3001])

    expect(plan).toEqual({ status: 'disabled' })
  })

  it('computeWslPortForwardingTeardownPlan returns disabled when env var is set', () => {
    vi.mocked(isWSL2).mockReturnValue(true)
    process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = '1'

    const plan = computeWslPortForwardingTeardownPlan([3001])

    expect(plan).toEqual({ status: 'disabled' })
  })

  it('computeWslPortForwardingTeardownPlanAsync returns disabled when env var is set', async () => {
    vi.mocked(isWSL2).mockReturnValue(true)
    process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = '1'

    const plan = await computeWslPortForwardingTeardownPlanAsync([3001])

    expect(plan).toEqual({ status: 'disabled' })
  })
})
```

**Step 2: Run the targeted tests to verify they fail**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/wsl-port-forward.test.ts
```

Expected: FAIL because `WslPortForwardingPlan` and `WslPortForwardingTeardownPlan` do not have a `disabled` status, and the env var check does not exist.

**Step 3: Implement the env var check and disabled status**

In `server/wsl-port-forward.ts`:

1. Add `{ status: 'disabled' }` to the `WslPortForwardingPlan` union type:

```ts
export type WslPortForwardingPlan =
  | { status: 'not-wsl2' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'noop'; wslIp: string }
  | {
    status: 'ready'
    wslIp: string
    scriptKind: 'full' | 'firewall-only'
    script: string
  }
```

2. Add `{ status: 'disabled' }` to the `WslPortForwardingTeardownPlan` union type:

```ts
export type WslPortForwardingTeardownPlan =
  | { status: 'not-wsl2' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'noop' }
  | { status: 'ready'; script: string }
```

3. Add the env var parsing helper (module-private):

```ts
function isWslPortForwardingDisabledByEnv(): boolean {
  const value = process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD
  if (!value) return false
  return ['1', 'true', 'yes'].includes(value.toLowerCase())
}
```

4. Add the env var check to each of the four public functions, immediately after the `isWSL2()` early return (so non-WSL2 systems still get `not-wsl2` without consulting the env var, and WSL2 systems with the env var get `disabled` before any expensive system calls):

In `computeWslPortForwardingPlan`:
```ts
export function computeWslPortForwardingPlan(...): WslPortForwardingPlan {
  if (!isWSL2()) {
    return { status: 'not-wsl2' }
  }
  if (isWslPortForwardingDisabledByEnv()) {
    return { status: 'disabled' }
  }
  // ... rest unchanged
}
```

Apply the same pattern to `computeWslPortForwardingPlanAsync`, `computeWslPortForwardingTeardownPlan`, and `computeWslPortForwardingTeardownPlanAsync`.

**Step 4: Run the targeted tests**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/wsl-port-forward.test.ts
```

Expected: PASS

### Task 2: Handle `disabled` Status in NetworkManager

**Files:**
- Modify: `server/network-manager.ts`
- Modify: `test/unit/server/network-manager.test.ts`

**Step 1: Write the failing tests**

Add a test to `test/unit/server/network-manager.test.ts` within the existing `getStatus` describe block:

```ts
it('treats disabled WSL port forwarding plan as no stale exposure', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'wsl2', active: true })
  vi.mocked(isPortReachable).mockResolvedValue(true)
  vi.mocked(computeWslPortForwardingPlanAsync).mockResolvedValue({ status: 'disabled' })

  const status = await manager.getStatus()

  expect(status.remoteAccessNeedsRepair).toBe(false)
})
```

Note: the mock for `isPortReachable` must be imported and `vi.mocked` at the test level. Check the existing test file to match the established pattern for mocking `computeWslPortForwardingPlanAsync`.

**Step 2: Run the targeted test to verify it fails**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/network-manager.test.ts
```

Expected: FAIL because `NetworkManager.getStatus()` checks `wslPlan.status === 'ready'` and does not handle `disabled`.

**Step 3: Update NetworkManager.getStatus()**

In `server/network-manager.ts`, find the block inside `getStatus()` that computes `staleManagedWindowsExposure` for WSL2:

```ts
if (firewallInfo.platform === 'wsl2' && rawPortOpen === true) {
  const wslPlan = await computeWslPortForwardingPlanAsync(remoteAccessPorts, this.getRelevantPorts())
  staleManagedWindowsExposure = wslPlan.status === 'ready'
}
```

This already handles `disabled` correctly by accident: `wslPlan.status === 'ready'` will be false for `disabled`, so `staleManagedWindowsExposure` stays `false`. The test should therefore PASS without changes. If it does, skip to Step 4.

If the test fails for some other reason (e.g., TypeScript compilation because the type discriminant `disabled` is not handled in a switch/exhaustive check), add explicit handling:

```ts
if (firewallInfo.platform === 'wsl2' && rawPortOpen === true) {
  const wslPlan = await computeWslPortForwardingPlanAsync(remoteAccessPorts, this.getRelevantPorts())
  staleManagedWindowsExposure = wslPlan.status === 'ready'
}
```

No change needed in the runtime code since the equality check is sufficient, but verify the type compiles cleanly.

**Step 4: Run the targeted tests**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/network-manager.test.ts
```

Expected: PASS

### Task 3: Handle `disabled` Status in Network Router

**Files:**
- Modify: `server/network-router.ts`
- Modify: `test/integration/server/network-api.test.ts`

**Step 1: Write the failing tests**

Add tests to the existing `POST /api/network/configure-firewall` describe block in `test/integration/server/network-api.test.ts`. These tests must mock `computeWslPortForwardingPlanAsync` to return `{ status: 'disabled' }` and verify the route returns `{ method: 'none' }`:

```ts
it('returns no configuration required when WSL port forwarding is disabled by env var', async () => {
  // Mock platform as WSL2 with port forwarding disabled
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'wsl2', active: true })
  vi.mocked(isPortReachable).mockResolvedValue(false)
  vi.mocked(computeWslPortForwardingPlanAsync).mockResolvedValue({ status: 'disabled' })

  const res = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({})

  expect(res.status).toBe(200)
  expect(res.body).toEqual({
    method: 'none',
    message: 'No configuration changes required',
  })
})
```

Add a similar test in the `POST /api/network/disable-remote-access` describe block for the teardown path, mocking `computeWslPortForwardingTeardownPlanAsync` to return `{ status: 'disabled' }`:

```ts
it('returns no-op when WSL port forwarding teardown is disabled by env var', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'wsl2', active: true })
  vi.mocked(computeWslPortForwardingTeardownPlanAsync).mockResolvedValue({ status: 'disabled' })

  const res = await request(app)
    .post('/api/network/disable-remote-access')
    .set('x-auth-token', token)
    .send({})

  expect(res.status).toBe(200)
  expect(res.body.method).toBe('none')
})
```

**Step 2: Run the targeted tests to verify they fail**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/integration/server/network-api.test.ts
```

Expected: FAIL because `resolveRepairAction` and `resolveRemoteAccessDisableAction` in `network-router.ts` do not handle `disabled` as a plan status — the code only checks for `error`, `noop`, and `not-wsl2`.

**Step 3: Update network-router.ts**

In `server/network-router.ts`, update `resolveRepairAction` to handle `disabled`:

Find the block:
```ts
if (plan.status === 'error') {
  return { kind: 'error', error: plan.message }
}
if (plan.status === 'noop' || plan.status === 'not-wsl2') {
  return { kind: 'none', response: NO_CONFIGURATION_CHANGES_REQUIRED }
}
```

Change to:
```ts
if (plan.status === 'error') {
  return { kind: 'error', error: plan.message }
}
if (plan.status === 'noop' || plan.status === 'not-wsl2' || plan.status === 'disabled') {
  return { kind: 'none', response: NO_CONFIGURATION_CHANGES_REQUIRED }
}
```

Update `resolveRemoteAccessDisableAction` similarly. Find:
```ts
if (teardownPlan.status === 'not-wsl2') {
  return { kind: 'none', response: REMOTE_ACCESS_DISABLED }
}
```

Change to:
```ts
if (teardownPlan.status === 'not-wsl2' || teardownPlan.status === 'disabled') {
  return { kind: 'none', response: REMOTE_ACCESS_DISABLED }
}
```

Also update `verifyWslRepairSuccess` and `verifyWslDisableSuccess` to handle `disabled` as a success condition (no need to verify when forwarding is disabled):

In `verifyWslRepairSuccess`:
```ts
if (plan.status === 'ready') {
  throw new Error('WSL2 port forwarding verification failed')
}
```

No change needed — `disabled` is not `ready`, so verification will pass. But double-check the exhaustive handling.

In `verifyWslDisableSuccess`:
```ts
if (teardownPlan.status === 'ready') {
  throw new Error('WSL2 remote access teardown verification failed')
}
```

Same reasoning — `disabled` is not `ready`.

**Step 4: Run the targeted tests**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/integration/server/network-api.test.ts
```

Expected: PASS

### Task 4: Verify Existing Integration Guards Still Pass

**Files:**
- No modifications expected. Only modify if a test fails.

**Step 1: Run the existing WSL integration and harness tests**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/logger.separation.harness.test.ts
```

Expected: PASS. Specifically:

- `keeps boot-time WSL repair removed from the server startup path` still passes because `server/index.ts` has no WSL port forwarding imports and `server/wsl-port-forward-startup.ts` does not exist.
- `does not inject a startup-only WSL port-forward suppression env var` still passes because `buildServerProcessEnv` does not inject `FRESHELL_DISABLE_WSL_PORT_FORWARD` into child processes. The env var is opt-in by the operator, not auto-injected.

**Step 2: Run the full WSL port forward unit test suite**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/wsl-port-forward.test.ts
```

Expected: PASS

**Step 3: Run the full network manager and network API test suites**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/network-manager.test.ts test/integration/server/network-api.test.ts test/unit/server/network-access.test.ts
```

Expected: PASS

**Step 4: Run the coordinated full test suite**

Run:

```bash
npm test
```

Expected: PASS

### Task 5: Refactor — Clean Up Any Redundant Checks

**Files:**
- Modify only files touched in Tasks 1-3, if needed.

**Step 1: Review the implementation for redundancy**

Ensure:

- The `isWslPortForwardingDisabledByEnv()` helper is called in exactly four places (the four public plan/teardown functions) and nowhere else.
- No consumer of the plan types has a `switch` or exhaustive check that would need updating for the new `disabled` discriminant. If there is one, add the `disabled` case.
- The test descriptions are clear and non-overlapping.

**Step 2: Run final verification**

Run:

```bash
npm run check
```

Expected: PASS (typecheck + full test suite).

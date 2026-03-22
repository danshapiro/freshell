# WSL Repair False-Positive Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop stale WSL managed-port metadata from falsely marking healthy NAT-mode LAN access as needing repair, so healthy WSL remote access no longer warns, prompts for elevation, or fails post-repair verification.

**Architecture:** Fix the bug at the shared planning choke point in `server/wsl-port-forward.ts`. The planner must treat `managedPorts` as an ownership hint only when the corresponding live Windows rule still exists; metadata alone must never create repair-needed drift. Once that contract is correct, the existing consumers in `NetworkManager.getStatus()`, `POST /api/network/configure-firewall`, and `verifyWslRepairSuccess()` become correct without a verifier-only codepath, without reordering `onSuccess()`, and without changing the WSL managed-file format.

**Tech Stack:** Node.js, TypeScript, Express, Vitest

---

**Execution note:** Use @trycycle-executing and keep the red-green-refactor order below. This plan assumes work stays in `/home/user/code/freshell/.worktrees/codex-wsl-verification-analysis`.

## User-Visible Target

After this lands:

- Healthy WSL remote access with correct live Windows exposure for the current port set must report as healthy: no startup repair warning, no Settings "Fix firewall" prompt, and no `confirmation-required` response from `POST /api/network/configure-firewall`.
- Actual live stale exposure must still be repairable. Extra live `portproxy` rules or extra live `FreshellLANAccess` ports must still return `status: 'ready'` and generate cleanup scripts.
- A confirmed WSL repair that leaves live Windows state correct must pass post-repair verification even if the managed-port file was stale before the repair.
- This patch does not redesign WSL bookkeeping scope. `~/.freshell/wsl-managed-remote-access-ports.json` stays global; the change is purely about how planner semantics interpret it.

## Contracts And Invariants

1. `managedPorts` is bookkeeping, not evidence of current exposure. Metadata alone must never flip the planner from `noop` to `ready`.
2. Live `FreshellLANAccess` ports remain authoritative for firewall drift. Extra live firewall ports must still trigger repair.
3. `managedPorts` still matters for live `portproxy` cleanup, but only when the same port still exists in the live `portproxy` table.
4. `knownOwnedPorts` legacy cleanup logic must stay intact so older internal-port ownership still gets cleaned up when the live `portproxy` rule exists.
5. The async planner remains the single source of truth for WSL status, repair preflight, and post-repair verification. Do not add a verifier-only interpretation of WSL health.
6. Do not move `persistManagedWslRemoteAccessPorts(...)` ahead of verification. Writing bookkeeping before success is proven would hide failures instead of fixing semantics.
7. Do not scope the WSL managed-port file per worktree or per server port in this patch. That is a separate design decision and not required to fix the proven false positive.

## Root Cause Summary

The current false positive comes from `buildWslPortForwardingPlan(...)` in `server/wsl-port-forward.ts`:

```ts
const staleOwnedPorts = Array.from(new Set([...existingFirewallPorts, ...managedPorts]))
  .filter((port) => !requiredPortSet.has(port))

const firewallNeedsUpdate = needsFirewallUpdate(requiredPorts, existingFirewallPorts)
  || staleOwnedPorts.length > 0
```

That makes stale metadata in `managedPorts` indistinguishable from live firewall drift. On the live machine documented in `docs/lab-notes/2026-03-21-wsl-verification-and-repair-false-positive-analysis.md`, Windows already exposed `3001` correctly, but the global managed file still contained `5173`. That metadata-only mismatch was enough to keep the planner in `status: 'ready', scriptKind: 'firewall-only'`, which in turn caused:

- `NetworkManager.getStatus()` to set `firewall.portOpen = false` and `remoteAccessNeedsRepair = true`
- `POST /api/network/configure-firewall` to return `confirmation-required`
- `verifyWslRepairSuccess()` to fail before `onSuccess()` could rewrite the managed file

The correct steady-state model is: live Windows state determines whether repair is needed, while managed metadata only helps identify which live `portproxy` rules still belong to Freshell.

## Strategy Gate

**Chosen approach:** repair the semantics in `server/wsl-port-forward.ts`.

- This is the narrowest change that fixes all proven manifestations of the bug: planner output, status output, configure-firewall prompting, startup warning, and post-repair verification.
- Existing consumers already key on `plan.status === 'ready'`. Once the planner stops returning `ready` for metadata-only drift, those consumers naturally become correct.

**Rejected approaches:**

- **Verifier-only live-state check:** too narrow. It would fix the post-repair failure but would leave `/api/network/status`, `/api/network/configure-firewall`, and the startup banner coupled to the same false positive.
- **Persist managed ports before verification:** wrong failure boundary. It would make bookkeeping look correct before success is proven and would still leave the status and prompt path wrong.
- **Per-instance WSL managed-file scoping in the same patch:** larger architectural change than the evidence requires. It may still be worth doing later, but it is not needed to fix the proven metadata-only false positive.
- **Consumer-side special cases in `network-manager.ts` or `network-router.ts`:** duplicates semantics in the wrong layer. The planner is already the contract boundary; fix it there once.

No user decision is required.

## File Structure

### Files to Modify

1. **`server/wsl-port-forward.ts`**
   - Refine `buildWslPortForwardingPlan(...)` so only live firewall ports contribute to firewall drift.
   - Keep `managedPorts` as an ownership hint only for live `portproxy` cleanup.

2. **`test/unit/server/wsl-port-forward.test.ts`**
   - Add sync and async regressions for metadata-only stale managed ports.
   - Add a regression proving stale managed metadata still triggers repair when the stale live `portproxy` rule still exists.

3. **`test/unit/server/network-manager.test.ts`**
   - Lock the status contract that reachable, requested WSL access stays healthy when the planner is `noop`.

4. **`test/integration/server/network-api.test.ts`**
   - Lock the API contract that healthy WSL access reports healthy status and returns `{ method: 'none' }` from `POST /api/network/configure-firewall`.

### Files Expected To Stay Unchanged

- **`server/network-manager.ts`**
- **`server/network-router.ts`**
- **`server/startup-banner.ts`**

These files already consume planner output correctly. The new tests exist to prove that the single planner fix is sufficient. Only touch them if a failing regression proves a duplicated stale-state bug remains after the planner change.

### Files Not To Touch

- **`docs/index.html`**

This is a correctness fix for existing remote-access behavior, not a new user-facing feature.

## Task 1: Add Red Regression Coverage For Planner, Status, And API Contracts

**Files:**
- Modify: `test/unit/server/wsl-port-forward.test.ts`
- Modify: `test/unit/server/network-manager.test.ts`
- Modify: `test/integration/server/network-api.test.ts`

- [ ] **Step 1: Add planner regressions for metadata-only drift in `test/unit/server/wsl-port-forward.test.ts`**

Add these tests near the existing `computeWslPortForwardingPlan` and `computeWslPortForwardingPlanAsync` coverage:

```ts
it('returns noop for the sync planner when live Windows exposure is correct and only managed metadata is stale', async () => {
  await persistManagedWslRemoteAccessPorts([5173])
  vi.mocked(isWSL2).mockReturnValue(true)
  vi.mocked(execSync)
    .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n')
    .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
`)
    .mockReturnValueOnce('Rule Name: FreshellLANAccess\nLocalPort: 3001\n')

  expect(computeWslPortForwardingPlan([3001], [3001])).toEqual({
    status: 'noop',
    wslIp: '172.30.149.249',
  })
})

it('returns noop for the async planner when live Windows exposure is correct and only managed metadata is stale', async () => {
  await persistManagedWslRemoteAccessPorts([5173])
  vi.mocked(isWSL2).mockReturnValue(true)
  vi.mocked(execFile).mockImplementation((cmd: any, args: any, _opts: any, cb: any) => {
    if (cmd === 'ip') {
      cb?.(null, 'inet 172.30.149.249/20 scope global eth0\n', '')
      return {} as any
    }

    if (args[0] === 'interface') {
      cb?.(null, `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
`, '')
      return {} as any
    }

    cb?.(null, 'Rule Name: FreshellLANAccess\nLocalPort: 3001\n', '')
    return {} as any
  })

  await expect(computeWslPortForwardingPlanAsync([3001], [3001])).resolves.toEqual({
    status: 'noop',
    wslIp: '172.30.149.249',
  })
})

it('still returns full when a stale managed port still has a live portproxy rule', async () => {
  await persistManagedWslRemoteAccessPorts([5173])
  vi.mocked(isWSL2).mockReturnValue(true)
  vi.mocked(execFile).mockImplementation((cmd: any, args: any, _opts: any, cb: any) => {
    if (cmd === 'ip') {
      cb?.(null, 'inet 172.30.149.249/20 scope global eth0\n', '')
      return {} as any
    }

    if (args[0] === 'interface') {
      cb?.(null, `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
0.0.0.0         5173        172.30.149.249  5173
`, '')
      return {} as any
    }

    cb?.(null, 'Rule Name: FreshellLANAccess\nLocalPort: 3001\n', '')
    return {} as any
  })

  const plan = await computeWslPortForwardingPlanAsync([3001], [3001])
  expect(plan).toEqual({
    status: 'ready',
    wslIp: '172.30.149.249',
    scriptKind: 'full',
    script: expect.stringContaining('listenport=5173'),
  })
})
```

- [ ] **Step 2: Add downstream contract tests in `test/unit/server/network-manager.test.ts` and `test/integration/server/network-api.test.ts`**

Add this unit test to `test/unit/server/network-manager.test.ts`:

```ts
it('keeps requested WSL remote access healthy when the port is reachable and the planner says noop', async () => {
  const firewallModule = await import('../../../server/firewall.js')
  const portReachable = await import('is-port-reachable')
  vi.mocked(firewallModule.detectFirewall).mockResolvedValue({
    platform: 'wsl2',
    active: true,
  })
  vi.mocked(portReachable.default).mockResolvedValue(true)
  vi.mocked(computeWslPortForwardingPlanAsync).mockResolvedValue({
    status: 'noop',
    wslIp: '172.30.149.249',
  })
  mockConfigStore = createMockConfigStore({
    network: {
      host: '0.0.0.0',
      configured: true,
    },
  })
  manager = new NetworkManager(server, mockConfigStore, testPort)
  await new Promise<void>((resolve) => server.listen(testPort, '0.0.0.0', resolve))

  const status = await manager.getStatus()

  expect(status.remoteAccessEnabled).toBe(true)
  expect(status.remoteAccessRequested).toBe(true)
  expect(status.remoteAccessNeedsRepair).toBe(false)
  expect(status.firewall.portOpen).toBe(true)
  expect(status.accessUrl).toContain(`192.168.1.100:${testPort}`)
})
```

Add this integration test to `test/integration/server/network-api.test.ts`:

```ts
it('reports healthy WSL remote access and skips repair prompting when the planner is noop', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({
    platform: 'wsl2',
    active: true,
  })
  networkManager.resetFirewallCache()
  await configStore.patchSettings({
    network: {
      configured: true,
      host: '0.0.0.0',
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  vi.mocked(isPortReachable).mockResolvedValue(true)
  vi.mocked(wslModule.computeWslPortForwardingPlanAsync).mockResolvedValue({
    status: 'noop',
    wslIp: '172.24.0.2',
  })

  const statusRes = await request(app)
    .get('/api/network/status')
    .set('x-auth-token', token)

  expect(statusRes.status).toBe(200)
  expect(statusRes.body.remoteAccessEnabled).toBe(true)
  expect(statusRes.body.remoteAccessRequested).toBe(true)
  expect(statusRes.body.remoteAccessNeedsRepair).toBe(false)
  expect(statusRes.body.firewall.portOpen).toBe(true)
  expect(statusRes.body.accessUrl).toContain('192.168.1.100')

  const repairRes = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({})

  expect(repairRes.status).toBe(200)
  expect(repairRes.body).toEqual({
    method: 'none',
    message: 'No configuration changes required',
  })
})
```

- [ ] **Step 3: Run the combined focused server pack and confirm it is red for the planner bug**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts \
  test/unit/server/wsl-port-forward.test.ts \
  test/unit/server/network-manager.test.ts \
  test/integration/server/network-api.test.ts
```

Expected:

- `test/unit/server/wsl-port-forward.test.ts` fails on the new metadata-only drift assertions because the current planner still returns `ready`.
- The new `network-manager` and `network-api` contract tests may already pass; that is acceptable because they are proving the existing consumers do not need source changes once the planner is fixed.

- [ ] **Step 4: Commit the red regression coverage**

```bash
git add test/unit/server/wsl-port-forward.test.ts test/unit/server/network-manager.test.ts test/integration/server/network-api.test.ts
git commit -m "test(server): add WSL metadata-only drift regressions"
```

## Task 2: Fix `server/wsl-port-forward.ts` So Metadata Alone Cannot Create Drift

**Files:**
- Modify: `server/wsl-port-forward.ts`
- Modify: `test/unit/server/wsl-port-forward.test.ts`
- Modify: `test/unit/server/network-manager.test.ts`
- Modify: `test/integration/server/network-api.test.ts`

- [ ] **Step 1: Replace the metadata-driven stale-firewall logic in `buildWslPortForwardingPlan(...)`**

In `server/wsl-port-forward.ts`, keep the public function signatures unchanged and rewrite the stale-port calculation like this:

```ts
function getStaleFirewallPorts(
  requiredPorts: number[],
  existingFirewallPorts: Set<number>,
): number[] {
  const requiredPortSet = new Set(requiredPorts)
  return Array.from(existingFirewallPorts).filter((port) => !requiredPortSet.has(port))
}

function getStaleManagedPortProxyPorts(
  requiredPorts: number[],
  managedPorts: Set<number>,
  existingRules: Map<number, PortProxyRule>,
): number[] {
  const requiredPortSet = new Set(requiredPorts)
  return Array.from(managedPorts)
    .filter((port) => !requiredPortSet.has(port) && existingRules.has(port))
}
```

Then update `buildWslPortForwardingPlan(...)` to use those helpers:

```ts
const staleFirewallPorts = getStaleFirewallPorts(requiredPorts, existingFirewallPorts)
const staleManagedPortProxyPorts = getStaleManagedPortProxyPorts(
  requiredPorts,
  managedPorts,
  existingRules,
)
const staleOwnedPortProxyPorts = Array.from(new Set([
  ...staleFirewallPorts.filter((port) => existingRules.has(port)),
  ...staleManagedPortProxyPorts,
  ...getLegacyOwnedPortProxyPorts(requiredPorts, knownOwnedPorts, existingRules),
]))

const portsNeedUpdate = needsPortForwardingUpdate(wslIp, requiredPorts, existingRules)
  || staleOwnedPortProxyPorts.length > 0

const firewallNeedsUpdate = needsFirewallUpdate(requiredPorts, existingFirewallPorts)
  || staleFirewallPorts.length > 0

if (!portsNeedUpdate && !firewallNeedsUpdate) {
  return {
    status: 'noop',
    wslIp,
  }
}

const cleanupPorts = Array.from(new Set([
  ...requiredPorts,
  ...staleFirewallPorts,
  ...staleOwnedPortProxyPorts,
]))
```

Delete the old `staleOwnedPorts`-based logic entirely.

Why this exact shape:

- `existingFirewallPorts` is live Freshell firewall state, so it is authoritative for firewall drift.
- `managedPorts` remains useful only for stale live `portproxy` cleanup, which is why it is filtered through `existingRules.has(port)`.
- `cleanupPorts` no longer includes raw `managedPorts`, because dead metadata with no matching live rule must not trigger work.

- [ ] **Step 2: Run the same focused pack and confirm it goes green**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts \
  test/unit/server/wsl-port-forward.test.ts \
  test/unit/server/network-manager.test.ts \
  test/integration/server/network-api.test.ts
```

Expected: PASS. The planner now returns `noop` for metadata-only drift, while still returning `ready` when a stale live `portproxy` rule actually exists.

- [ ] **Step 3: Commit the green fix**

```bash
git add server/wsl-port-forward.ts test/unit/server/wsl-port-forward.test.ts test/unit/server/network-manager.test.ts test/integration/server/network-api.test.ts
git commit -m "fix(server): ignore metadata-only WSL repair drift"
```

## Task 3: Prove No Consumer Or Broad-Suite Regression Remains

**Files:**
- Test: `test/unit/server/wsl-port-forward.test.ts`
- Test: `test/unit/server/network-manager.test.ts`
- Test: `test/integration/server/network-api.test.ts`
- Test: `test/unit/server/startup-banner.test.ts`

- [ ] **Step 1: Run the focused server regression pack, including the startup banner consumer**

Run:

```bash
npm run test:vitest -- --config vitest.server.config.ts \
  test/unit/server/wsl-port-forward.test.ts \
  test/unit/server/network-manager.test.ts \
  test/integration/server/network-api.test.ts \
  test/unit/server/startup-banner.test.ts
```

Expected: PASS. `startup-banner.ts` itself should need no source change because it only reflects `remoteAccessNeedsRepair`.

- [ ] **Step 2: Run the coordinated full suite before any merge/rebase work**

Run:

```bash
FRESHELL_TEST_SUMMARY="WSL repair false-positive fix" npm test
```

Expected: PASS after waiting for the shared coordinator gate if needed.

- [ ] **Step 3: Resolve any failing suite before landing; otherwise stop without extra code churn**

Rules for this step:

- If the focused pack fails, fix the specific failing consumer before rerunning. Do not add speculative fallbacks.
- If the coordinated suite fails anywhere, stop and resolve the failure before attempting any merge work, even if the failure looks unrelated.
- If both commands pass, do not create an empty commit. The branch is ready for the next trycycle phase.

## Final Checks

- [ ] Healthy WSL remote access with correct live exposure no longer reports `remoteAccessNeedsRepair`.
- [ ] `POST /api/network/configure-firewall` returns `{ method: 'none', message: 'No configuration changes required' }` for the healthy WSL case.
- [ ] Metadata-only stale managed ports no longer force `scriptKind: 'firewall-only'`.
- [ ] Stale live `portproxy` rules still return `status: 'ready'` and generate cleanup.
- [ ] `verifyWslRepairSuccess()` now naturally succeeds after a repair when live Windows state is correct, even if the managed file was stale beforehand.
- [ ] No change was made to managed-file scoping, startup-banner logic, or repair ordering.

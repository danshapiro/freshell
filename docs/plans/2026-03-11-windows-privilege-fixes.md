# Windows Privilege Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Remove unsolicited Windows elevation during startup/tests, require an explicit in-product confirmation before any manual Windows/WSL firewall repair can elevate, and ensure Windows daemon tasks run at least privilege.

**Architecture:** Delete the boot-time WSL auto-repair path entirely so privilege elevation can only happen from the existing manual repair buttons; startup should detect stale network state through the normal `NetworkManager` status flow, not by launching UAC. Keep the useful non-elevating WSL drift-detection logic in `server/wsl-port-forward.ts` so the manual repair API can recompute current WSL state both before and after the user confirms. Reset Windows/WSL repair around a server-enforced two-step protocol: the first response returns `confirmation-required` plus a one-time `confirmationToken`, and only a second request that round-trips both `confirmElevation: true` and that token, under a single-flight server lock and after recomputing current repair state, may spawn the shared elevated PowerShell helper. Keep least privilege enforced in both the task XML and the Windows daemon manager so new and existing scheduled tasks stop asking for `HighestAvailable`.

**Tech Stack:** TypeScript, Express, Zod, React, Redux Toolkit, Vitest, Testing Library, supertest, Electron scheduled tasks

---

## Strategy Gate

- The user approved removing startup auto-elevation. Do not preserve `FRESHELL_DISABLE_WSL_PORT_FORWARD` or any other boot-only suppression layer; delete the boot path instead.
- Do not replace startup repair with a one-time setup task. WSL IPs drift across boots, and the existing `NetworkManager` firewall status is already the right place to detect drift and surface the manual fix button.
- Manual repair stays in-product. The accepted UX is a one-click repair flow preceded by an explicit confirmation modal warning that a Windows admin prompt is next.
- The API must enforce the two-step flow itself. A bare `confirmElevation` boolean is not enough because a first-call `POST` can still bypass the UI. Issue a one-time server token from the first response and require that token on the confirmed retry.
- `firewall.configuring` is status for the live elevated child process, not a lock. Protect the confirmed retry path with a dedicated single-flight guard from fresh state revalidation through `spawnElevatedPowerShell(...)`.
- Recompute current repair state after confirmation instead of caching a script across the modal. That is required for WSL IP drift, port-open drift, and "remote access disabled mid-flow" correctness.
- Reuse the existing repair entry points in `SetupWizard` and `SettingsView`. Do not add new settings, banners, or script-copy workflows.
- Centralize the `Start-Process ... -Verb RunAs` argument construction in one server helper. The current duplication is the most fragile code in the affected path.
- Reuse the shared `Button` variant system inside `ConfirmModal`; do not invent a one-off styling prop when the repo already has `ButtonVariant`.
- The daemon fix is not documentation-only. Update both the scheduled task definition and the runtime manager so existing elevated tasks are normalized before `schtasks /Run`.
- No `docs/index.html` update is needed. This is a privilege-boundary correction inside an existing workflow, not a new headline feature.

## Acceptance Mapping

- Starting `server/index.ts` on WSL never attempts Windows portproxy/firewall repair and never depends on `FRESHELL_DISABLE_WSL_PORT_FORWARD`.
- `server/wsl-port-forward.ts` exports only helpers that are still live in the manual repair path, including a pure `computeWslPortForwardingPlan(ports)` helper; dead startup-only helpers are gone.
- `POST /api/network/configure-firewall` returns `confirmation-required` with a fresh `confirmationToken` for both `wsl2` and `windows` whenever repair is still needed and the caller has not yet round-tripped a valid token.
- First-call `{ confirmElevation: true }`, missing tokens, expired tokens, or replayed tokens never elevate; they return a fresh `confirmation-required` response when repair is still needed.
- `POST /api/network/configure-firewall` rejects malformed acknowledgement bodies (for example `{ confirmElevation: false }` or a non-string `confirmationToken`) with `400`.
- The first `confirmation-required` response does not mark firewall repair as in progress; `firewall.configuring` stays reserved for the actual elevated child process, and a separate single-flight guard ensures concurrent confirmed requests can spawn at most one elevated child.
- WSL2 returns `none` instead of `confirmation-required` when the WSL repair-plan helper determines that portproxy/firewall state is already correct by the time the button is clicked or re-clicked after confirmation.
- The confirmation payload copy is explicit: `To complete this, you will need to accept the Windows administrator prompt on the next screen.` A cancel path performs no elevated action.
- `SetupWizard` and `SettingsView` both use the existing accessible modal infrastructure instead of `window.confirm()`, the modal shows `Continue` plus `Cancel` with the primary action styled through the shared `Button` variant system rather than destructive red styling, and the confirmed retry sends both `confirmElevation: true` and the server-issued `confirmationToken`.
- Linux/macOS repair continues to return terminal commands exactly as before.
- The Windows scheduled-task template uses `LeastPrivilege`, and `WindowsServiceDaemonManager.start()` normalizes the task to limited run level before launching it.

## Scope Notes

- Keep the pure/manual WSL helpers in `server/wsl-port-forward.ts` that still matter after the startup path dies: the rule parsers, script builders, and a new `computeWslPortForwardingPlan(ports)` helper that encapsulates non-elevating drift detection.
- Delete the synchronous `setupWslPortForwarding()` wrapper, the dead `getRequiredPorts()` helper, and the startup helper module entirely. The manual route already has `NetworkManager.getRelevantPorts()`, so the WSL module should no longer parse ports from process env.
- Keep `NetworkManager` as the source of truth for `firewall.active`, `firewall.portOpen`, and `firewall.configuring`, but add router-local state for pending confirmation tokens and the single-flight confirmed-repair lock. Do not pretend `firewall.configuring` alone is sufficient protocol state.
- Keep confirmation copy and `confirmationToken` sourced from the server response so both UI entry points stay consistent.
- Keep the confirmation contract intentionally small but real: `confirmationToken` is one-time proof that the prompt was shown, not remembered consent. Do not add persistence, remembered consent, or a separate setup wizard just for UAC.
- Execution note: use `@trycycle-executing` and keep the task-level commits below intact unless a later task forces a smaller follow-up fix.

### Task 1: Remove the Boot-Time WSL Auto-Repair Entry Point While Preserving Manual WSL Repair Planning

**Files:**
- Delete: `server/wsl-port-forward-startup.ts`
- Delete: `test/unit/server/wsl-port-forward-startup.test.ts`
- Modify: `server/index.ts`
- Modify: `server/wsl-port-forward.ts`
- Modify: `test/integration/server/wsl-port-forward.test.ts`
- Modify: `test/unit/server/wsl-port-forward.test.ts`

**Step 1: Write the failing regression tests**

In `test/integration/server/wsl-port-forward.test.ts`, replace the startup-era assertions with:

```ts
it('exports only the manual WSL helper surface', async () => {
  const wslModule = await import('../../../server/wsl-port-forward.js')

  expect(typeof wslModule.computeWslPortForwardingPlan).toBe('function')
  expect(typeof wslModule.getWslIp).toBe('function')
  expect(typeof wslModule.buildPortForwardingScript).toBe('function')
  expect(typeof wslModule.buildFirewallOnlyScript).toBe('function')
  expect('getRequiredPorts' in wslModule).toBe(false)
  expect('setupWslPortForwarding' in wslModule).toBe(false)
})

it('server/index.ts does not import or call the startup-only WSL helper path', () => {
  const indexPath = path.resolve(__dirname, '../../../server/index.ts')
  const indexContent = fs.readFileSync(indexPath, 'utf8')

  expect(indexContent).not.toContain("from './wsl-port-forward-startup.js'")
  expect(indexContent).not.toContain('setupWslPortForwarding(')
  expect(indexContent).not.toContain('shouldSetupWslPortForwardingAtStartup')
})
```

In `test/unit/server/wsl-port-forward.test.ts`, replace the dead `getRequiredPorts` and `setupWslPortForwarding` coverage with a `describe('computeWslPortForwardingPlan', ...)` block that preserves the important scenarios without any elevation side effects:

```ts
it('returns noop when port forwarding and firewall are already correct', () => {
  vi.mocked(isWSL2).mockReturnValue(true)
  vi.mocked(execSync)
    .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n')
    .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
`)
    .mockReturnValueOnce(`Rule Name: FreshellLANAccess\nLocalPort: 3001\n`)

  expect(computeWslPortForwardingPlan([3001])).toEqual({
    status: 'noop',
    wslIp: '172.30.149.249',
  })
})

it('returns a firewall-only repair plan when only the firewall drifted', () => {
  vi.mocked(isWSL2).mockReturnValue(true)
  vi.mocked(execSync)
    .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n')
    .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
`)
    .mockReturnValueOnce(`Rule Name: FreshellLANAccess\nLocalPort: 3011\n`)

  expect(computeWslPortForwardingPlan([3001])).toEqual({
    status: 'ready',
    wslIp: '172.30.149.249',
    scriptKind: 'firewall-only',
    script: expect.stringContaining('FreshellLANAccess'),
  })
})
```

Also keep explicit cases for:
- `status: 'not-wsl2'` when `isWSL2()` is false
- `status: 'error'` when WSL IP detection fails
- `status: 'ready'` with `scriptKind: 'full'` when portproxy rules are missing or point at the wrong IP/port

The red condition for this task should come from both the integration assertions and the new pure-plan expectations.

**Step 2: Run the targeted server tests and confirm failure**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/unit/server/wsl-port-forward.test.ts
```

Expected:
- FAIL because `server/index.ts` still imports/calls the startup helper, and `server/wsl-port-forward.ts` still exports dead startup-only helpers instead of the pure manual planning helper.

**Step 3: Write the minimal implementation**

Implement these changes:

- In `server/index.ts`, delete the `shouldSetupWslPortForwardingAtStartup(...)` block and all imports from `./wsl-port-forward-startup.js` and `./wsl-port-forward.js` that existed only for startup repair.
- Replace the adjacent comment with one sentence explaining that Windows/WSL repair is exposed only through the manual network-repair API/UI.
- In `server/wsl-port-forward.ts`, delete `DEFAULT_PORT`, `getRequiredPorts()`, `SetupResult`, `setupWslPortForwarding()`, and any imports/constants that become unused (`POWERSHELL_PATH` must disappear; `execSync` and `isWSL2` stay because the new pure helper uses them).
- In `server/wsl-port-forward.ts`, add:

```ts
export type WslPortForwardingPlan =
  | { status: 'not-wsl2' }
  | { status: 'error'; message: string }
  | { status: 'noop'; wslIp: string }
  | {
      status: 'ready'
      wslIp: string
      scriptKind: 'full' | 'firewall-only'
      script: string
    }
```

- In `server/wsl-port-forward.ts`, implement `computeWslPortForwardingPlan(requiredPorts: number[]): WslPortForwardingPlan` by moving the non-elevating decision logic out of `setupWslPortForwarding()`: detect WSL2, resolve the WSL IP, inspect existing portproxy/firewall rules, choose between `buildPortForwardingScript(...)` and `buildFirewallOnlyScript(...)`, and return `noop` when nothing needs changing.
- Normalize the returned `script` for the async PowerShell helper inside `computeWslPortForwardingPlan(...)` by converting `\$null` back to `$null` there. Do not duplicate that quoting/unescaping rule inside `network-router.ts`.
- In `test/unit/server/wsl-port-forward.test.ts`, keep the parser/script tests intact, delete the dead startup wrapper/env-port coverage, and replace it with assertions for the new pure plan helper.
- Delete `server/wsl-port-forward-startup.ts` and `test/unit/server/wsl-port-forward-startup.test.ts`.

**Step 4: Re-run the targeted server tests**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/unit/server/wsl-port-forward.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add server/index.ts \
  server/wsl-port-forward.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/unit/server/wsl-port-forward.test.ts
git rm server/wsl-port-forward-startup.ts test/unit/server/wsl-port-forward-startup.test.ts
git commit -m "refactor(server): remove WSL auto-repair startup path"
```

### Task 2: Remove Boot-Only WSL Suppression From Test Harnesses

**Files:**
- Modify: `test/integration/server/logger.separation.harness.ts`
- Modify: `test/integration/server/logger.separation.harness.test.ts`
- Modify: `test/e2e-browser/helpers/test-server.ts`

**Step 1: Write the failing harness regression test**

In `test/integration/server/logger.separation.harness.test.ts`, replace the env-default assertions with:

```ts
it('does not inject a startup-only WSL port-forward suppression env var', () => {
  const childEnv = buildServerProcessEnv({}, {})
  expect(childEnv.FRESHELL_DISABLE_WSL_PORT_FORWARD).toBeUndefined()
})
```

Keep the explicit-env override test only if it still exercises another env-cleanup behavior; otherwise delete it.

**Step 2: Run the targeted harness test and confirm failure**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/logger.separation.harness.test.ts
```

Expected:
- FAIL because the harness still defaults `FRESHELL_DISABLE_WSL_PORT_FORWARD=1`.

**Step 3: Write the minimal implementation**

Implement these changes:

- In `test/integration/server/logger.separation.harness.ts`, remove every reference to `FRESHELL_DISABLE_WSL_PORT_FORWARD`.
- In `test/e2e-browser/helpers/test-server.ts`, keep `FRESHELL_BIND_HOST='127.0.0.1'` if it still helps local test isolation, but update the comment so it no longer claims this is required to suppress startup UAC.

**Step 4: Re-run the targeted harness test**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/logger.separation.harness.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add test/integration/server/logger.separation.harness.ts \
  test/integration/server/logger.separation.harness.test.ts \
  test/e2e-browser/helpers/test-server.ts
git commit -m "test(server): remove dead WSL startup suppression env"
```

### Task 3: Extract a Shared Elevated PowerShell Helper

**Files:**
- Create: `server/elevated-powershell.ts`
- Create: `test/unit/server/elevated-powershell.test.ts`

**Step 1: Write the failing unit tests**

Create `test/unit/server/elevated-powershell.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))

import { execFile } from 'node:child_process'
import {
  buildElevatedPowerShellArgs,
  ELEVATED_POWERSHELL_TIMEOUT_MS,
  spawnElevatedPowerShell,
} from '../../../server/elevated-powershell.js'

it('escapes single quotes for Start-Process -Verb RunAs', () => {
  expect(buildElevatedPowerShellArgs("Write-Host 'hi'")).toEqual([
    '-Command',
    "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', 'Write-Host ''hi'''",
  ])
})

it('spawns execFile with a 120s timeout', () => {
  const cb = vi.fn()

  spawnElevatedPowerShell('powershell.exe', "Write-Host 'hi'", cb)

  expect(execFile).toHaveBeenCalledWith(
    'powershell.exe',
    buildElevatedPowerShellArgs("Write-Host 'hi'"),
    { timeout: ELEVATED_POWERSHELL_TIMEOUT_MS },
    cb,
  )
})
```

**Step 2: Run the targeted unit test and confirm failure**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/unit/server/elevated-powershell.test.ts
```

Expected:
- FAIL because `server/elevated-powershell.ts` does not exist yet.

**Step 3: Write the minimal implementation**

Create `server/elevated-powershell.ts` with:

```ts
import { execFile, type ExecFileException } from 'node:child_process'

export const ELEVATED_POWERSHELL_TIMEOUT_MS = 120_000

export type ElevatedPowerShellCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void

export function buildElevatedPowerShellArgs(script: string): string[] {
  const escaped = script.replace(/'/g, "''")
  return [
    '-Command',
    `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '${escaped}'`,
  ]
}

export function spawnElevatedPowerShell(
  command: string,
  script: string,
  callback: ElevatedPowerShellCallback,
) {
  return execFile(
    command,
    buildElevatedPowerShellArgs(script),
    { timeout: ELEVATED_POWERSHELL_TIMEOUT_MS },
    callback,
  )
}
```

**Step 4: Re-run the targeted unit test**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/unit/server/elevated-powershell.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add server/elevated-powershell.ts test/unit/server/elevated-powershell.test.ts
git commit -m "refactor(server): share elevated powershell helper"
```

### Task 4: Reset the Firewall Repair API Around a Real Confirmation Contract

**Files:**
- Create: `server/firewall-repair-coordinator.ts`
- Create: `test/unit/server/firewall-repair-coordinator.test.ts`
- Modify: `server/network-router.ts`
- Modify: `server/firewall.ts`
- Modify: `test/integration/server/network-api.test.ts`

**Step 1: Write the failing unit and integration tests**

Create `test/unit/server/firewall-repair-coordinator.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  createFirewallRepairCoordinator,
  FIREWALL_CONFIRMATION_TTL_MS,
  FIREWALL_REPAIR_LOCKED,
} from '../../../server/firewall-repair-coordinator.js'

it('issues one-time confirmation tokens scoped to the repair platform', () => {
  const coordinator = createFirewallRepairCoordinator(() => 1_000)

  const confirmation = coordinator.issueConfirmation('wsl2')

  expect(confirmation).toMatchObject({
    method: 'confirmation-required',
    confirmationToken: expect.any(String),
  })
  expect(
    coordinator.consumeConfirmation(confirmation.confirmationToken, 'windows'),
  ).toBe(false)
  expect(
    coordinator.consumeConfirmation(confirmation.confirmationToken, 'wsl2'),
  ).toBe(true)
  expect(
    coordinator.consumeConfirmation(confirmation.confirmationToken, 'wsl2'),
  ).toBe(false)
})

it('expires stale confirmation tokens', () => {
  let now = 1_000
  const coordinator = createFirewallRepairCoordinator(() => now)
  const confirmation = coordinator.issueConfirmation('windows')

  now += FIREWALL_CONFIRMATION_TTL_MS + 1

  expect(
    coordinator.consumeConfirmation(confirmation.confirmationToken, 'windows'),
  ).toBe(false)
})

it('returns locked while a confirmed repair is already running and releases afterwards', async () => {
  const coordinator = createFirewallRepairCoordinator()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })

  const first = coordinator.withConfirmedRepairLock(async () => {
    await blocked
    return 'started'
  })

  expect(
    await coordinator.withConfirmedRepairLock(async () => 'second'),
  ).toBe(FIREWALL_REPAIR_LOCKED)

  release()

  await expect(first).resolves.toBe('started')
  await expect(
    coordinator.withConfirmedRepairLock(async () => 'after-release'),
  ).resolves.toBe('after-release')
})
```

In `test/integration/server/network-api.test.ts`:

- Replace the WSL mock factory with one centered on the async manual helper:

```ts
vi.mock('../../../server/wsl-port-forward.js', () => ({
  computeWslPortForwardingPlanAsync: vi.fn().mockResolvedValue({
    status: 'ready',
    wslIp: '172.24.0.2',
    scriptKind: 'full',
    script: '$null # mock script',
  }),
}))
```

- Add these confirmation-contract tests:

```ts
it('returns confirmation-required for WSL2 until the caller confirms elevation', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'wsl2', active: true })
  networkManager.resetFirewallCache()

  const cp = await import('node:child_process')
  const res = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({})

  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({
    method: 'confirmation-required',
    title: 'Administrator approval required',
    body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
    confirmLabel: 'Continue',
    confirmationToken: expect.any(String),
  })
  expect(cp.execFile).not.toHaveBeenCalled()
})

it('does not elevate on a first-call confirmed WSL2 request without a server token', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'wsl2', active: true })
  networkManager.resetFirewallCache()

  const cp = await import('node:child_process')
  const res = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({ confirmElevation: true })

  expect(res.status).toBe(200)
  expect(res.body.method).toBe('confirmation-required')
  expect(res.body.confirmationToken).toEqual(expect.any(String))
  expect(cp.execFile).not.toHaveBeenCalled()
})

it('starts WSL2 repair only after a confirmed retry with the issued token', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'wsl2', active: true })
  networkManager.resetFirewallCache()

  const firstRes = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({})

  const cp = await import('node:child_process')
  vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, _cb: any) => {
    return { on: vi.fn() } as any
  })

  const res = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({
      confirmElevation: true,
      confirmationToken: firstRes.body.confirmationToken,
    })

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ method: 'wsl2', status: 'started' })
})

it('returns none for WSL2 when the confirmed retry recomputes to noop', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'wsl2', active: true })
  networkManager.resetFirewallCache()

  const wslModule = await import('../../../server/wsl-port-forward.js')
  vi.mocked(wslModule.computeWslPortForwardingPlanAsync)
    .mockResolvedValueOnce({
      status: 'ready',
      wslIp: '172.24.0.2',
      scriptKind: 'full',
      script: '$null # mock script',
    })
    .mockResolvedValueOnce({
      status: 'noop',
      wslIp: '172.24.0.2',
    })

  const firstRes = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({})

  const cp = await import('node:child_process')
  const confirmedRes = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({
      confirmElevation: true,
      confirmationToken: firstRes.body.confirmationToken,
    })

  expect(confirmedRes.status).toBe(200)
  expect(confirmedRes.body).toEqual({ method: 'none', message: 'No configuration changes required' })
  expect(cp.execFile).not.toHaveBeenCalled()
})

it('returns none when remote access is disabled before the confirmed retry', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'windows', active: true })
  networkManager.resetFirewallCache()

  const firstRes = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({})

  await configStore.patchSettings({
    network: {
      configured: true,
      host: '127.0.0.1',
    },
  })

  const cp = await import('node:child_process')
  const confirmedRes = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({
      confirmElevation: true,
      confirmationToken: firstRes.body.confirmationToken,
    })

  expect(confirmedRes.status).toBe(200)
  expect(confirmedRes.body).toEqual({ method: 'none', message: 'Remote access is not enabled' })
  expect(cp.execFile).not.toHaveBeenCalled()
})

it('does not elevate on a first-call confirmed Windows request without a server token', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'windows', active: true })
  networkManager.resetFirewallCache()

  const cp = await import('node:child_process')
  const res = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({ confirmElevation: true })

  expect(res.status).toBe(200)
  expect(res.body.method).toBe('confirmation-required')
  expect(res.body.confirmationToken).toEqual(expect.any(String))
  expect(cp.execFile).not.toHaveBeenCalled()
})

it('starts native Windows repair only after a confirmed retry with the issued token', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'windows', active: true })
  networkManager.resetFirewallCache()

  const firstRes = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({})

  const cp = await import('node:child_process')
  vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, _cb: any) => {
    return { on: vi.fn() } as any
  })

  const res = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({
      confirmElevation: true,
      confirmationToken: firstRes.body.confirmationToken,
    })

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ method: 'windows-elevated', status: 'started' })
})

it('allows only one confirmed repair request through the single-flight lock', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'wsl2', active: true })
  networkManager.resetFirewallCache()

  const wslModule = await import('../../../server/wsl-port-forward.js')
  const firstPrompt = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({})
  const secondPrompt = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({})

  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let enteredLockedSection!: () => void
  const enteredLockedSectionPromise = new Promise<void>((resolve) => {
    enteredLockedSection = resolve
  })

  vi.mocked(wslModule.computeWslPortForwardingPlanAsync)
    .mockImplementationOnce(async () => {
      enteredLockedSection()
      await blocked
      return {
        status: 'ready',
        wslIp: '172.24.0.2',
        scriptKind: 'full',
        script: '$null # mock script',
      }
    })
    .mockResolvedValueOnce({
      status: 'ready',
      wslIp: '172.24.0.2',
      scriptKind: 'full',
      script: '$null # mock script',
    })

  const cp = await import('node:child_process')
  vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, _cb: any) => {
    return { on: vi.fn() } as any
  })

  const firstConfirmed = request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({
      confirmElevation: true,
      confirmationToken: firstPrompt.body.confirmationToken,
    })

  await enteredLockedSectionPromise

  const secondConfirmedPromise = request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({
      confirmElevation: true,
      confirmationToken: secondPrompt.body.confirmationToken,
    })

  release()
  const [firstConfirmedRes, secondConfirmed] = await Promise.all([
    firstConfirmed,
    secondConfirmedPromise,
  ])

  expect(firstConfirmedRes.status).toBe(200)
  expect(secondConfirmed.status).toBe(409)
  expect(secondConfirmed.body.method).toBe('in-progress')
  expect(cp.execFile).toHaveBeenCalledTimes(1)
})

it('rejects malformed confirmation payloads', async () => {
  const res = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({ confirmElevation: false })

  expect(res.status).toBe(400)
  expect(res.body.error).toBe('Invalid request')
})
```

**Step 2: Run the targeted integration test and confirm failure**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/integration/server/network-api.test.ts
npx vitest run --config vitest.server.config.ts test/unit/server/firewall-repair-coordinator.test.ts
```

Expected:
- FAIL because `server/firewall-repair-coordinator.ts` does not exist yet and the route still treats `confirmElevation: true` as sufficient on the first call, does not issue one-time confirmation tokens, and does not hold a real single-flight lock across the confirmed repair path.

**Step 3: Write the minimal implementation**

Create `server/firewall-repair-coordinator.ts` with:

```ts
import { randomUUID } from 'node:crypto'

export const FIREWALL_CONFIRMATION_TTL_MS = 5 * 60_000
export const FIREWALL_REPAIR_LOCKED = Symbol('FIREWALL_REPAIR_LOCKED')

type RepairPlatform = 'windows' | 'wsl2'

export function createFirewallRepairCoordinator(now: () => number = () => Date.now()) {
  const confirmations = new Map<string, { platform: RepairPlatform; expiresAt: number }>()
  let confirmedRepairInFlight = false

  function pruneExpired() {
    const currentTime = now()
    for (const [token, entry] of confirmations) {
      if (entry.expiresAt <= currentTime) {
        confirmations.delete(token)
      }
    }
  }

  return {
    issueConfirmation(platform: RepairPlatform) {
      pruneExpired()
      const confirmationToken = randomUUID()
      confirmations.set(confirmationToken, {
        platform,
        expiresAt: now() + FIREWALL_CONFIRMATION_TTL_MS,
      })
      return {
        method: 'confirmation-required' as const,
        title: 'Administrator approval required',
        body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
        confirmLabel: 'Continue',
        confirmationToken,
      }
    },
    consumeConfirmation(token: string | undefined, platform: RepairPlatform) {
      pruneExpired()
      if (!token) return false
      const entry = confirmations.get(token)
      if (!entry || entry.platform !== platform) {
        return false
      }
      confirmations.delete(token)
      return true
    },
    async withConfirmedRepairLock<T>(fn: () => Promise<T>) {
      if (confirmedRepairInFlight) {
        return FIREWALL_REPAIR_LOCKED
      }
      confirmedRepairInFlight = true
      try {
        return await fn()
      } finally {
        confirmedRepairInFlight = false
      }
    },
  }
}
```

In `server/network-router.ts`:

- Instantiate one `const repairCoordinator = createFirewallRepairCoordinator()` inside `createNetworkRouter(...)`.
- Expand the request schema to:

```ts
const ConfigureFirewallRequestSchema = z.object({
  confirmElevation: z.literal(true).optional(),
  confirmationToken: z.string().uuid().optional(),
}).strict()
```

- Parse `req.body ?? {}` at the top of the route and return `400` on invalid bodies.
- Add a small local helper that converts the current platform-specific state into one of three repair actions:
  - `{ kind: 'none', response: { method: 'none', ... } }`
  - `{ kind: 'confirmable', platform: 'wsl2' | 'windows', script: string, responseMethod: 'wsl2' | 'windows-elevated' }`
  - `{ kind: 'error', status: 500, body: { error: string } }`
- For WSL2, that helper must await `computeWslPortForwardingPlanAsync(networkManager.getRelevantPorts())` on every call:
  - `status: 'error'` -> `500`
  - `status: 'noop'` or `status: 'not-wsl2'` -> `{ method: 'none', message: 'No configuration changes required' }`
  - `status: 'ready'` -> carry the returned `script`
- For Windows, the helper must re-read `status.firewall.commands` and `status.firewall.portOpen` each time:
  - no commands -> `{ method: 'none', message: 'No firewall detected' }`
  - `portOpen === true` -> `{ method: 'none', message: 'No configuration changes required' }`
  - otherwise -> confirmable action with `script = commands.join('; ')`
- Before any platform-specific repair work, keep the existing remote-access-disabled check and return `{ method: 'none', message: 'Remote access is not enabled' }`.
- If the request is missing either `confirmElevation: true` or a valid `confirmationToken`, and repair is still needed, return `repairCoordinator.issueConfirmation(platform)` without calling `spawnElevatedPowerShell(...)`. This includes first-call `{ confirmElevation: true }`.
- For confirmed requests, wrap the whole fresh-state revalidation and spawn decision inside `repairCoordinator.withConfirmedRepairLock(...)`.
  - If the lock returns `FIREWALL_REPAIR_LOCKED`, respond with `409` and `{ method: 'in-progress', error: 'Firewall configuration already in progress' }`.
  - Once inside the lock, re-fetch fresh `status` and `settings`, re-run the repair-action helper, and only then decide whether to return `none`, `confirmation-required`, or start repair.
  - Only if `repairCoordinator.consumeConfirmation(confirmationToken, platform)` succeeds may the route call `spawnElevatedPowerShell(...)`.
  - Keep `networkManager.setFirewallConfiguring(true)` inside the confirmed path immediately before spawning the child, not on the first prompt.
- Keep the existing cache reset and async completion behavior after the child exits or spawn fails.
- Do not describe `confirmationToken` as durable consent; it is one-time proof that the prompt was shown by the product flow.

In `server/firewall.ts`, update the Windows/WSL comments so they describe the new explicit-confirmation contract rather than unconditional elevation.

**Step 4: Re-run the targeted integration test**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/integration/server/network-api.test.ts
npx vitest run --config vitest.server.config.ts test/unit/server/firewall-repair-coordinator.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add server/network-router.ts \
  server/firewall-repair-coordinator.ts \
  server/firewall.ts \
  test/integration/server/network-api.test.ts \
  test/unit/server/firewall-repair-coordinator.test.ts
git commit -m "fix(server): enforce two-step windows repair contract"
```

### Task 5: Refactor `ConfirmModal` to Reuse Shared Button Variants

**Files:**
- Modify: `src/components/ui/confirm-modal.tsx`
- Create: `test/unit/client/components/ui/confirm-modal.test.tsx`

**Step 1: Write the failing modal tests**

Create `test/unit/client/components/ui/confirm-modal.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConfirmModal } from '@/components/ui/confirm-modal'

it('defaults the confirm button to destructive styling', () => {
  render(
    <ConfirmModal
      open
      title="Delete session"
      body="This cannot be undone."
      confirmLabel="Delete"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  )

  expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('bg-destructive')
})

it('renders a non-destructive primary button when confirmVariant is default', () => {
  render(
    <ConfirmModal
      open
      title="Administrator approval required"
      body="To complete this, you will need to accept the Windows administrator prompt on the next screen."
      confirmLabel="Continue"
      confirmVariant="default"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  )

  expect(screen.getByRole('button', { name: 'Continue' })).toHaveClass('bg-primary')
})
```

**Step 2: Run the targeted client test and confirm failure**

Run:

```bash
npx vitest run test/unit/client/components/ui/confirm-modal.test.tsx
```

Expected:
- FAIL because `ConfirmModal` does not accept `confirmVariant` or reuse the shared `Button` variants.

**Step 3: Write the minimal implementation**

In `src/components/ui/confirm-modal.tsx`:

- Import `Button` and `type ButtonVariant` from `@/components/ui/button`.
- Add `confirmVariant?: ButtonVariant` to `ConfirmModalProps`.
- Default it to `'destructive'`.
- Replace the raw action buttons with shared `Button` components, preserving the existing focus handling and destructive default behavior.
- Keep cancel visually secondary (`ghost` or `outline` is fine), but do not change the modal API beyond the new `confirmVariant`.

**Step 4: Re-run the targeted client test**

Run:

```bash
npx vitest run test/unit/client/components/ui/confirm-modal.test.tsx
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/components/ui/confirm-modal.tsx test/unit/client/components/ui/confirm-modal.test.tsx
git commit -m "refactor(ui): reuse button variants in confirm modal"
```

### Task 6: Extend the Client Firewall Helper for the Tokenized Confirmation Contract

**Files:**
- Modify: `src/lib/firewall-configure.ts`
- Modify: `test/unit/client/lib/firewall-configure.test.ts`

**Step 1: Write the failing helper tests**

In `test/unit/client/lib/firewall-configure.test.ts`, add:

```ts
it('returns confirmation-required payloads', async () => {
  vi.mocked(api.post).mockResolvedValue({
    method: 'confirmation-required',
    title: 'Administrator approval required',
    body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
    confirmLabel: 'Continue',
    confirmationToken: 'confirm-1',
  })

  const result = await fetchFirewallConfig()
  expect(result.method).toBe('confirmation-required')
})

it('passes confirmElevation and confirmationToken when explicitly requested', async () => {
  vi.mocked(api.post).mockResolvedValue({ method: 'windows-elevated', status: 'started' })

  await fetchFirewallConfig({
    confirmElevation: true,
    confirmationToken: 'confirm-1',
  })

  expect(api.post).toHaveBeenCalledWith('/api/network/configure-firewall', {
    confirmElevation: true,
    confirmationToken: 'confirm-1',
  })
})
```

**Step 2: Run the targeted helper test and confirm failure**

Run:

```bash
npx vitest run test/unit/client/lib/firewall-configure.test.ts
```

Expected:
- FAIL because the client helper does not accept a request body or the `confirmation-required` result type.

**Step 3: Write the minimal implementation**

In `src/lib/firewall-configure.ts`:

- Extend `ConfigureFirewallResult` with:

```ts
| {
    method: 'confirmation-required'
    title: string
    body: string
    confirmLabel: string
    confirmationToken: string
  }
```

- Change the helper signature to:

```ts
export async function fetchFirewallConfig(
  body: { confirmElevation?: true; confirmationToken?: string } = {},
): Promise<ConfigureFirewallResult> {
  return api.post<ConfigureFirewallResult>('/api/network/configure-firewall', body)
}
```

**Step 4: Re-run the targeted helper test**

Run:

```bash
npx vitest run test/unit/client/lib/firewall-configure.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/lib/firewall-configure.ts test/unit/client/lib/firewall-configure.test.ts
git commit -m "refactor(client): support firewall elevation confirmation"
```

### Task 7: Add the Pre-UAC Confirmation Flow to `SetupWizard`

**Files:**
- Modify: `src/components/SetupWizard.tsx`
- Modify: `test/unit/client/SetupWizard.test.tsx`
- Modify: `test/e2e/network-setup.test.tsx`

**Step 1: Write the failing wizard tests**

In `test/unit/client/SetupWizard.test.tsx`, add:

```ts
it('shows an admin-approval modal before starting WSL2 repair', async () => {
  mockFetchFirewallConfig
    .mockResolvedValueOnce({
      method: 'confirmation-required',
      title: 'Administrator approval required',
      body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
      confirmLabel: 'Continue',
      confirmationToken: 'confirm-1',
    })
    .mockResolvedValueOnce({ method: 'wsl2', status: 'started' })

  const store = createTestStore({
    status: {
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
      rebinding: false,
    },
  })

  render(
    <Provider store={store}>
      <SetupWizard onComplete={vi.fn()} initialStep={2} />
    </Provider>,
  )

  await waitFor(() => {
    expect(screen.getByRole('button', { name: /configure firewall/i })).toBeInTheDocument()
  })

  fireEvent.click(screen.getByRole('button', { name: /configure firewall/i }))

  expect(await screen.findByRole('dialog', { name: /administrator approval required/i })).toBeInTheDocument()
  expect(mockFetchFirewallConfig).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('button', { name: /continue/i }))

  await waitFor(() => {
    expect(mockFetchFirewallConfig).toHaveBeenNthCalledWith(2, {
      confirmElevation: true,
      confirmationToken: 'confirm-1',
    })
  })
})

it('does nothing when the user cancels the admin-approval modal', async () => {
  mockFetchFirewallConfig.mockResolvedValue({
    method: 'confirmation-required',
    title: 'Administrator approval required',
    body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
    confirmLabel: 'Continue',
    confirmationToken: 'confirm-1',
  })

  const store = createTestStore({
    status: {
      ...defaultNetworkStatus,
      configured: true,
      host: '0.0.0.0',
      firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
      rebinding: false,
    },
  })

  render(
    <Provider store={store}>
      <SetupWizard onComplete={vi.fn()} initialStep={2} />
    </Provider>,
  )

  await waitFor(() => {
    expect(screen.getByRole('button', { name: /configure firewall/i })).toBeInTheDocument()
  })

  fireEvent.click(screen.getByRole('button', { name: /configure firewall/i }))
  fireEvent.click(await screen.findByRole('button', { name: /cancel/i }))

  expect(mockFetchFirewallConfig).toHaveBeenCalledTimes(1)
})
```

In `test/e2e/network-setup.test.tsx`, add a wizard-path flow that asserts the confirmation dialog appears before the second firewall request is sent and that the retry body includes the issued `confirmationToken`.

**Step 2: Run the targeted wizard tests and confirm failure**

Run:

```bash
npx vitest run \
  test/unit/client/SetupWizard.test.tsx \
  test/e2e/network-setup.test.tsx
```

Expected:
- FAIL because `SetupWizard` currently calls the elevated repair path immediately and never opens a confirmation modal.

**Step 3: Write the minimal implementation**

In `src/components/SetupWizard.tsx`:

- Add local state for the pending confirmation payload and whether the modal is open.
- On the first `fetchFirewallConfig()` call, if the result is `confirmation-required`, open `ConfirmModal` with the returned `title`, `body`, and `confirmLabel`, using `confirmVariant="default"`.
- Store the full confirmation payload, including `confirmationToken`, in state.
- On confirm, call `fetchFirewallConfig({ confirmElevation: true, confirmationToken })` and then reuse the existing WSL/Windows polling path.
- Treat any repeated `confirmation-required` response from that retry as a fresh prompt update rather than assuming the second call always starts repair.
- On cancel, close the modal and do nothing else.
- Keep the Linux/macOS terminal-pane flow unchanged.

Important:
- Do not use `window.confirm()`.
- Keep the existing accessible wizard dialog intact; the confirmation modal should layer on top via the existing portal-based modal system.

**Step 4: Re-run the targeted wizard tests**

Run:

```bash
npx vitest run \
  test/unit/client/SetupWizard.test.tsx \
  test/e2e/network-setup.test.tsx
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/components/SetupWizard.tsx \
  test/unit/client/SetupWizard.test.tsx \
  test/e2e/network-setup.test.tsx
git commit -m "feat(ui): confirm windows elevation from setup wizard"
```

### Task 8: Add the Pre-UAC Confirmation Flow to `SettingsView`

**Files:**
- Modify: `src/components/SettingsView.tsx`
- Modify: `test/unit/client/components/SettingsView.network-access.test.tsx`
- Modify: `test/e2e/network-setup.test.tsx`

**Step 1: Write the failing settings tests**

In `test/unit/client/components/SettingsView.network-access.test.tsx`, add the mock near the top of the file:

```ts
const mockFetchFirewallConfig = vi.fn()
vi.mock('@/lib/firewall-configure', () => ({
  fetchFirewallConfig: (...args: any[]) => mockFetchFirewallConfig(...args),
}))
```

Then add:

```ts
it('shows an admin-approval modal before starting Windows firewall repair', async () => {
  mockFetchFirewallConfig
    .mockResolvedValueOnce({
      method: 'confirmation-required',
      title: 'Administrator approval required',
      body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
      confirmLabel: 'Continue',
      confirmationToken: 'confirm-1',
    })
    .mockResolvedValueOnce({ method: 'windows-elevated', status: 'started' })

  const store = createSettingsViewStore({
    extraPreloadedState: {
      network: createNetworkState({
        status: createNetworkStatus({
          firewall: {
            platform: 'windows',
            active: true,
            portOpen: false,
            commands: ['netsh advfirewall firewall add rule name="Freshell (port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=private'],
            configuring: false,
          },
        }),
      }),
    },
  })

  renderSettingsView(store, { onNavigate: vi.fn() })

  fireEvent.click(screen.getByRole('button', { name: /fix firewall/i }))

  expect(await screen.findByRole('dialog', { name: /administrator approval required/i })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /continue/i }))

  await waitFor(() => {
    expect(mockFetchFirewallConfig).toHaveBeenNthCalledWith(2, {
      confirmElevation: true,
      confirmationToken: 'confirm-1',
    })
  })
})

it('does not re-issue the firewall request when the modal is cancelled', async () => {
  mockFetchFirewallConfig.mockResolvedValue({
    method: 'confirmation-required',
    title: 'Administrator approval required',
    body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
    confirmLabel: 'Continue',
    confirmationToken: 'confirm-1',
  })

  const store = createSettingsViewStore({
    extraPreloadedState: {
      network: createNetworkState({
        status: createNetworkStatus({
          firewall: {
            platform: 'windows',
            active: true,
            portOpen: false,
            commands: ['netsh advfirewall firewall add rule name="Freshell (port 3001)" dir=in action=allow protocol=TCP localport=3001 profile=private'],
            configuring: false,
          },
        }),
      }),
    },
  })

  renderSettingsView(store, { onNavigate: vi.fn() })

  fireEvent.click(screen.getByRole('button', { name: /fix firewall/i }))
  fireEvent.click(await screen.findByRole('button', { name: /cancel/i }))

  expect(mockFetchFirewallConfig).toHaveBeenCalledTimes(1)
})
```

In `test/e2e/network-setup.test.tsx`, extend the settings flow so it also checks for the confirmation modal before the second request and asserts that the retry includes the server-issued `confirmationToken`.

**Step 2: Run the targeted settings tests and confirm failure**

Run:

```bash
npx vitest run \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
```

Expected:
- FAIL because `SettingsView` still triggers elevated repair immediately.

**Step 3: Write the minimal implementation**

In `src/components/SettingsView.tsx`:

- Add local state for the confirmation modal.
- On the first `fetchFirewallConfig()` call, if the result is `confirmation-required`, open `ConfirmModal` with `confirmVariant="default"`.
- Store the full confirmation payload, including `confirmationToken`, in state.
- On confirm, call `fetchFirewallConfig({ confirmElevation: true, confirmationToken })`, then reuse the existing follow-up behavior:
  - open a terminal tab for `terminal`
  - schedule `fetchNetworkStatus()` for `wsl2` / `windows-elevated`
- Treat any repeated `confirmation-required` response from that retry as a fresh prompt update rather than assuming the second call always starts repair.
- On cancel, close the modal and exit without side effects.

**Step 4: Re-run the targeted settings tests**

Run:

```bash
npx vitest run \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/components/SettingsView.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
git commit -m "feat(ui): confirm windows elevation from settings"
```

### Task 9: Enforce Least Privilege for the Windows Daemon Scheduled Task

**Files:**
- Modify: `installers/windows/freshell-task.xml.template`
- Modify: `electron/daemon/windows-service.ts`
- Modify: `test/unit/electron/daemon/windows-service.test.ts`

**Step 1: Write the failing daemon tests**

In `test/unit/electron/daemon/windows-service.test.ts`, add:

```ts
it('writes a least-privilege task definition', async () => {
  setupExecFileSuccess()
  await manager.install(testPaths, 3001)

  const writtenContent = mockWriteFile.mock.calls[0][1] as string
  expect(writtenContent).toContain('<RunLevel>LeastPrivilege</RunLevel>')
  expect(writtenContent).not.toContain('<RunLevel>HighestAvailable</RunLevel>')
})

it('normalizes the scheduled task to LIMITED before start', async () => {
  setupExecFileSuccess()
  await manager.start()

  expect(mockExecFile.mock.calls[0][0]).toBe('schtasks')
  expect(mockExecFile.mock.calls[0][1]).toEqual(
    expect.arrayContaining(['/Change', '/TN', 'Freshell Server', '/RL', 'LIMITED']),
  )
  expect(mockExecFile.mock.calls[1][1]).toEqual(
    expect.arrayContaining(['/Run', '/TN', 'Freshell Server']),
  )
})
```

**Step 2: Run the targeted daemon test and confirm failure**

Run:

```bash
npx vitest run --config vitest.electron.config.ts test/unit/electron/daemon/windows-service.test.ts
```

Expected:
- FAIL because the template still requests `HighestAvailable` and `start()` does not normalize the run level.

**Step 3: Write the minimal implementation**

Implement these changes:

- In `installers/windows/freshell-task.xml.template`, change `<RunLevel>HighestAvailable</RunLevel>` to `<RunLevel>LeastPrivilege</RunLevel>`.
- In `electron/daemon/windows-service.ts`, add:

```ts
private async ensureLeastPrivilege(): Promise<void> {
  await execFilePromise('schtasks', ['/Change', '/TN', TASK_NAME, '/RL', 'LIMITED'])
}
```

- Call `ensureLeastPrivilege()` after `/Create` in `install()` and before `/Run` in `start()`.

**Step 4: Re-run the targeted daemon test**

Run:

```bash
npx vitest run --config vitest.electron.config.ts test/unit/electron/daemon/windows-service.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add installers/windows/freshell-task.xml.template \
  electron/daemon/windows-service.ts \
  test/unit/electron/daemon/windows-service.test.ts
git commit -m "fix(electron): run windows daemon with least privilege"
```

### Task 10: Refactor Comments, Run Broader Verification, and Prepare for Landing

**Files:**
- Modify only files already touched in Tasks 1-9

**Step 1: Refactor for clarity only where it reduces future privilege regressions**

- Keep the confirmation copy sourced from the server payload.
- Keep the one-time token issuance and single-flight lock in `server/firewall-repair-coordinator.ts`; do not re-spread that protocol logic across `network-router.ts`, `NetworkManager`, and the UI.
- Keep all `Start-Process ... -Verb RunAs` quoting in `server/elevated-powershell.ts`.
- Keep `ConfirmModal` aligned with `src/components/ui/button.tsx` instead of reintroducing ad-hoc button classes.
- Remove stale comments that still describe startup auto-repair, boot-only suppression env vars, or unconditional Windows elevation.

Do not add new settings, feature flags, or fallback script flows.

**Step 2: Run the broader targeted matrix**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.test.ts \
  test/integration/server/network-api.test.ts \
  test/unit/server/firewall-repair-coordinator.test.ts \
  test/unit/server/wsl-port-forward.test.ts \
  test/unit/server/elevated-powershell.test.ts
```

Expected:
- PASS

Run:

```bash
npx vitest run \
  test/unit/client/components/ui/confirm-modal.test.tsx \
  test/unit/client/lib/firewall-configure.test.ts \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
```

Expected:
- PASS

Run:

```bash
npx vitest run --config vitest.electron.config.ts \
  test/unit/electron/daemon/windows-service.test.ts \
  test/unit/electron/startup.test.ts
```

Expected:
- PASS

**Step 3: Run repo-level verification**

Run:

```bash
npm run lint
npm run verify
npm test
```

Expected:
- PASS

**Step 4: Commit the final polish**

```bash
git add server/index.ts \
  server/wsl-port-forward.ts \
  server/elevated-powershell.ts \
  server/firewall-repair-coordinator.ts \
  server/network-router.ts \
  server/firewall.ts \
  src/components/ui/confirm-modal.tsx \
  src/lib/firewall-configure.ts \
  src/components/SetupWizard.tsx \
  src/components/SettingsView.tsx \
  electron/daemon/windows-service.ts \
  installers/windows/freshell-task.xml.template \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.ts \
  test/integration/server/logger.separation.harness.test.ts \
  test/integration/server/network-api.test.ts \
  test/unit/server/firewall-repair-coordinator.test.ts \
  test/unit/server/wsl-port-forward.test.ts \
  test/unit/server/elevated-powershell.test.ts \
  test/unit/client/components/ui/confirm-modal.test.tsx \
  test/unit/client/lib/firewall-configure.test.ts \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/unit/electron/daemon/windows-service.test.ts \
  test/e2e/network-setup.test.tsx \
  test/e2e-browser/helpers/test-server.ts
git commit -m "fix(windows): tighten privilege boundaries for repair flows"
```

**Step 5: Final sanity check before handoff**

- `git status --short` is clean.
- `server/wsl-port-forward.ts` no longer exports `setupWslPortForwarding` or `getRequiredPorts`, and does export `computeWslPortForwardingPlan`.
- `server/wsl-port-forward-startup.ts` is gone.
- `POST /api/network/configure-firewall` has exactly five interactive outcomes:
  - `terminal` for Linux/macOS
  - `none` when no repair is needed
  - `confirmation-required` with a one-time `confirmationToken` while Windows/WSL repair still needs user approval
  - `wsl2` / `windows-elevated` after a validated confirmed retry
  - `in-progress` when another confirmed repair is already active
- `installers/windows/freshell-task.xml.template` contains `LeastPrivilege`.

# Windows Privilege Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use @trycycle-executing to implement this plan task-by-task.

**Goal:** Finish the Windows privilege-boundary fixes by making `POST /api/network/configure-firewall` a server-enforced two-step confirmation flow, round-tripping the server-issued confirmation token through the existing manual UI repair flows, and re-verifying the already-landed startup and daemon least-privilege changes.

**Architecture:** This branch already removed boot-time WSL repair, added the manual confirmation modal UX in `SetupWizard` and `SettingsView`, and lowered the Windows scheduled task to least privilege. The remaining defects are concentrated in `server/network-router.ts`: a bare `confirmElevation` boolean still starts elevation on the first call, and the route treats `status.firewall.configuring` as a lock even though it is only a UI status snapshot. Fix that by adding a small router-local coordinator that owns one-time confirmation tokens and the confirmed-repair single-flight lock, while keeping repair-need detection in `network-router.ts` and current network/firewall facts in `networkManager`.

**Tech Stack:** TypeScript, Express, Zod, React, Redux Toolkit, Vitest, Testing Library, supertest, Electron scheduled tasks

---

## Strategy Gate

- Solve the actual remaining bug, not already-landed work. Keep the branch’s removal of boot-time WSL repair, the existing manual confirmation modal, and the daemon least-privilege changes unless a regression test proves drift.
- The right boundary is the server contract for `POST /api/network/configure-firewall`. UI confirmation alone is not sufficient because other callers can hit the route directly.
- Keep manual repair in-product. The user explicitly wants the app to warn before elevation and then launch the normal Windows prompt. Do not replace that with copy-paste instructions or a separate setup-only flow.
- Do not reintroduce startup WSL repair, `FRESHELL_DISABLE_WSL_PORT_FORWARD`, or any boot-only suppression flag. Startup should detect status only; any privileged repair must stay manual.
- Keep `spawnElevatedPowerShell(...)` as the only place that constructs `Start-Process ... -Verb RunAs`.
- Do not move confirmation state into Redux or `NetworkManager`. The confirmation proof and single-flight lock are request-protocol concerns that belong next to the route.
- No `docs/index.html` update is needed. This is a privilege-boundary correction in existing flows, not a new user-facing feature.

## Design Reset

The review findings point to one missing protocol. Implement that protocol directly:

1. Initial request: `POST /api/network/configure-firewall` with `{}`.
Expected behavior:
   - return `terminal` for Linux/macOS command-based repair
   - return `none` if remote access is disabled or no repair is needed
   - return `confirmation-required` with a fresh one-time `confirmationToken` if native Windows or WSL repair still needs elevation
   - never spawn elevated PowerShell
2. Confirmed retry: `POST /api/network/configure-firewall` with `{ confirmElevation: true, confirmationToken }`.
Expected behavior:
   - take a real single-flight lock before any confirmed elevation work
   - recompute current repair need inside the lock
   - return `none` if the situation changed and no repair is needed anymore
   - return `confirmation-required` again if the token is missing, expired, replayed, or wrong for the current repair platform
   - return `wsl2` or `windows-elevated` only after both a valid token and a successful lock acquisition
3. Lock precedence:
Expected behavior:
   - if another confirmed repair already owns the single-flight lock, return `409 { method: 'in-progress' }`
   - `status.firewall.configuring` remains a status flag for live elevated work, not the synchronization primitive
4. WSL/manual repair drift:
Expected behavior:
   - recompute the WSL port-forward plan on the first click and on the confirmed retry
   - recompute native Windows firewall need on the confirmed retry
   - stale tokens never authorize elevation by themselves

This is the simplest direct fix for the user’s request: the app still presents an in-product confirmation modal, still elevates only when the user accepts, and no longer surprises Windows with elevation at server boot or on a first-call boolean.

## Acceptance Mapping

- Starting the server on WSL never attempts Windows portproxy/firewall repair and never depends on `FRESHELL_DISABLE_WSL_PORT_FORWARD`.
- `POST /api/network/configure-firewall` has these interactive outcomes:
  - `terminal` for Linux/macOS command-based repair
  - `none` when remote access is disabled or no configuration changes are needed
  - `confirmation-required` with a fresh one-time `confirmationToken`
  - `wsl2` or `windows-elevated` only after a validated confirmed retry
  - `in-progress` when another confirmed repair already owns the single-flight lock
- A first-call body of `{ confirmElevation: true }` never elevates. Absent an active confirmed repair, it returns a fresh `confirmation-required` response.
- A missing token, expired token, replayed token, or platform-mismatched token never elevates. Absent an active confirmed repair, the route returns a fresh `confirmation-required` response if repair is still needed.
- `confirmation-required` responses never set `firewall.configuring`; that flag is reserved for a live elevated child process.
- WSL repair is recomputed on both the first click and the confirmed retry. Either call may legitimately collapse to `{ method: 'none', message: 'No configuration changes required' }`.
- Both UI entry points keep the existing accessible modal and exact copy: `To complete this, you will need to accept the Windows administrator prompt on the next screen.`
- The confirm button path from both UI entry points sends both `confirmElevation: true` and the server-issued `confirmationToken`.
- The cancel path from both UI entry points performs no elevated action and makes no second API call.
- The Windows scheduled task remains least privilege: `<RunLevel>LeastPrivilege</RunLevel>` in XML and `/RL LIMITED` before `schtasks /Run`.

## Scope Notes

- Treat the branch’s current state as the starting point. `server/wsl-port-forward-startup.ts` is already gone, the manual WSL planning helpers already exist, `ConfirmModal` already has the required UX, and the daemon code already normalizes the scheduled task run level.
- Keep `server/wsl-port-forward.ts` purely non-elevating. If a regression test fails there, repair it without reintroducing any startup wrapper or env-derived suppression logic.
- Keep comments accurate, but do not pad the change set with broad cleanup. Only touch comments that would be wrong after the route contract changes.
- Execution note: use @trycycle-executing and keep commits small and frequent.

### Task 1: Add the Confirmation Coordinator and Prove Its Semantics

**Files:**
- Create: `server/firewall-repair-coordinator.ts`
- Create: `test/unit/server/firewall-repair-coordinator.test.ts`

**Step 1: Write the failing coordinator unit tests**

Create `test/unit/server/firewall-repair-coordinator.test.ts`:

```ts
import { expect, it } from 'vitest'
import {
  createFirewallRepairCoordinator,
  FIREWALL_CONFIRMATION_TTL_MS,
  FIREWALL_REPAIR_LOCKED,
} from '../../../server/firewall-repair-coordinator.js'

it('issues one-time confirmation tokens scoped to a repair platform', () => {
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

it('allows only one confirmed repair through the single-flight lock at a time', async () => {
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
})
```

**Step 2: Run the new unit test and verify it fails**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/unit/server/firewall-repair-coordinator.test.ts
```

Expected:
- FAIL because `server/firewall-repair-coordinator.ts` does not exist yet.

**Step 3: Write the minimal coordinator implementation**

Create `server/firewall-repair-coordinator.ts`:

```ts
import { randomUUID } from 'node:crypto'

export const FIREWALL_CONFIRMATION_TTL_MS = 5 * 60_000
export const FIREWALL_REPAIR_LOCKED = Symbol('FIREWALL_REPAIR_LOCKED')

type RepairPlatform = 'windows' | 'wsl2'

export function createFirewallRepairCoordinator(
  now: () => number = () => Date.now(),
) {
  const confirmations = new Map<
    string,
    { platform: RepairPlatform; expiresAt: number }
  >()
  let confirmedRepairInFlight = false

  function pruneExpired() {
    const currentTime = now()
    for (const [token, entry] of confirmations) {
      if (entry.expiresAt <= currentTime) confirmations.delete(token)
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
      if (!entry || entry.platform !== platform) return false
      confirmations.delete(token)
      return true
    },
    async withConfirmedRepairLock<T>(fn: () => Promise<T>) {
      if (confirmedRepairInFlight) return FIREWALL_REPAIR_LOCKED
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

**Step 4: Re-run the coordinator unit test**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/unit/server/firewall-repair-coordinator.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add server/firewall-repair-coordinator.ts \
  test/unit/server/firewall-repair-coordinator.test.ts
git commit -m "refactor(server): add firewall repair coordinator"
```

### Task 2: Enforce the Tokenized Confirmation Contract in `server/network-router.ts`

**Files:**
- Modify: `server/network-router.ts`
- Modify: `test/integration/server/network-api.test.ts`

**Step 1: Tighten the integration tests around `POST /api/network/configure-firewall`**

In `test/integration/server/network-api.test.ts`, update the existing `describe('POST /api/network/configure-firewall', ...)` block so it asserts the full contract:

```ts
it('re-prompts when the first call sends confirmElevation without a server token', async () => {
  const cp = await import('node:child_process')

  const res = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({ confirmElevation: true })

  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({
    method: 'confirmation-required',
    confirmationToken: expect.any(String),
  })
  expect(cp.execFile).not.toHaveBeenCalled()
})

it('starts WSL2 repair only after a confirmed retry with the issued token', async () => {
  const firstRes = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({})

  const confirmedRes = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({
      confirmElevation: true,
      confirmationToken: firstRes.body.confirmationToken,
    })

  expect(confirmedRes.status).toBe(200)
  expect(confirmedRes.body).toEqual({ method: 'wsl2', status: 'started' })
})
```

Also add assertions for:

- first WSL click returns `confirmation-required` with `confirmationToken`
- confirmed WSL retry can recompute to `none`
- confirmed WSL retry returns `none` if remote access was disabled between calls
- first native-Windows click returns `confirmation-required` with `confirmationToken`
- first native-Windows `{ confirmElevation: true }` re-prompts instead of elevating
- confirmed native-Windows retry with the issued token starts repair
- replayed or platform-mismatched tokens re-prompt instead of elevating
- malformed bodies such as `{ confirmElevation: false }` or `{ confirmationToken: 7 }` return `400`
- two concurrent confirmed requests produce one started response and one `409 { method: 'in-progress' }`

**Step 2: Run the targeted server tests and verify they fail**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/unit/server/firewall-repair-coordinator.test.ts \
  test/integration/server/network-api.test.ts
```

Expected:
- FAIL because `server/network-router.ts` still treats a bare `confirmElevation: true` as sufficient, does not issue or validate confirmation tokens, and still relies on `status.firewall.configuring` as the in-flight guard.

**Step 3: Update the request schema and confirmation helpers**

In `server/network-router.ts`, replace the request schema with:

```ts
const ConfigureFirewallRequestSchema = z.object({
  confirmElevation: z.literal(true).optional(),
  confirmationToken: z.string().uuid().optional(),
}).strict()
```

Instantiate one coordinator inside `createNetworkRouter(...)`:

```ts
const repairCoordinator = createFirewallRepairCoordinator()
```

Add local helpers for shared responses:

```ts
const NO_CONFIGURATION_CHANGES_REQUIRED = {
  method: 'none',
  message: 'No configuration changes required',
} as const

const REMOTE_ACCESS_DISABLED = {
  method: 'none',
  message: 'Remote access is not enabled',
} as const
```

**Step 4: Factor repair-action resolution so both calls use the same fresh-state logic**

In `server/network-router.ts`, add a local helper with this shape:

```ts
type ConfirmableRepairAction = {
  kind: 'confirmable'
  platform: 'windows' | 'wsl2'
  script: string
  responseMethod: 'windows-elevated' | 'wsl2'
}

type RepairActionResolution =
  | { kind: 'none'; response: { method: 'none'; message: string } }
  | { kind: 'terminal'; response: { method: 'terminal'; command: string } }
  | ConfirmableRepairAction

async function resolveRepairAction(
  status: Awaited<ReturnType<NetworkRouterDeps['networkManager']['getStatus']>>,
  settings: Awaited<ReturnType<NetworkRouterDeps['configStore']['getSettings']>>,
): Promise<RepairActionResolution> {
  if (!isRemoteAccessEnabled(settings, status.host, status.firewall.platform)) {
    return { kind: 'none', response: REMOTE_ACCESS_DISABLED }
  }

  if (status.firewall.platform === 'wsl2') {
    if (status.firewall.portOpen === true) {
      return { kind: 'none', response: NO_CONFIGURATION_CHANGES_REQUIRED }
    }
    const plan = await computeWslPortForwardingPlanAsync(
      networkManager.getRelevantPorts(),
    )
    if (plan.status === 'error') throw new Error(plan.message)
    if (plan.status === 'noop' || plan.status === 'not-wsl2') {
      return { kind: 'none', response: NO_CONFIGURATION_CHANGES_REQUIRED }
    }
    return {
      kind: 'confirmable',
      platform: 'wsl2',
      script: plan.script,
      responseMethod: 'wsl2',
    }
  }

  if (status.firewall.platform === 'windows') {
    const commands = status.firewall.commands
    if (commands.length === 0) {
      return { kind: 'none', response: { method: 'none', message: 'No firewall detected' } }
    }
    if (status.firewall.portOpen === true) {
      return { kind: 'none', response: NO_CONFIGURATION_CHANGES_REQUIRED }
    }
    return {
      kind: 'confirmable',
      platform: 'windows',
      script: commands.join('; '),
      responseMethod: 'windows-elevated',
    }
  }

  const commands = status.firewall.commands
  if (commands.length === 0) {
    return { kind: 'none', response: { method: 'none', message: 'No firewall detected' } }
  }
  return {
    kind: 'terminal',
    response: { method: 'terminal', command: commands.join(' && ') },
  }
}
```

Notes:
- This keeps WSL/manual repair recomputed on each call.
- `status.firewall.configuring` should no longer be read as a lock before repair resolution.

**Step 5: Enforce the confirmed retry contract and real single-flight lock**

Patch the route so the decision tree is:

```ts
const confirmElevation = parsed.data.confirmElevation === true
const confirmationToken = parsed.data.confirmationToken
const [status, settings] = await Promise.all([
  networkManager.getStatus(),
  configStore.getSettings(),
])
const action = await resolveRepairAction(status, settings)

if (action.kind === 'none' || action.kind === 'terminal') {
  return res.json(action.response)
}

if (!confirmElevation) {
  return res.json(repairCoordinator.issueConfirmation(action.platform))
}

const lockedResult = await repairCoordinator.withConfirmedRepairLock(async () => {
  const [freshStatus, freshSettings] = await Promise.all([
    networkManager.getStatus(),
    configStore.getSettings(),
  ])
  const freshAction = await resolveRepairAction(freshStatus, freshSettings)

  if (freshAction.kind === 'none' || freshAction.kind === 'terminal') {
    return { status: 200 as const, body: freshAction.response }
  }

  if (!repairCoordinator.consumeConfirmation(confirmationToken, freshAction.platform)) {
    return {
      status: 200 as const,
      body: repairCoordinator.issueConfirmation(freshAction.platform),
    }
  }

  networkManager.setFirewallConfiguring(true)
  startElevatedRepair(
    freshAction.platform === 'wsl2'
      ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
      : 'powershell.exe',
    freshAction.script,
    freshAction.platform === 'wsl2'
      ? {
        completedLog: 'WSL2 port forwarding completed successfully',
        failedLog: 'WSL2 port forwarding failed',
        spawnFailedLog: 'Failed to spawn PowerShell for WSL2 port forwarding',
      }
      : {
        completedLog: 'Windows firewall configured successfully',
        failedLog: 'Windows firewall configuration failed',
        spawnFailedLog: 'Failed to spawn PowerShell for Windows firewall',
      },
  )

  return {
    status: 200 as const,
    body: { method: freshAction.responseMethod, status: 'started' as const },
  }
})

if (lockedResult === FIREWALL_REPAIR_LOCKED) {
  return res.status(409).json({
    error: 'Firewall configuration already in progress',
    method: 'in-progress',
  })
}

return res.status(lockedResult.status).json(lockedResult.body)
```

Important constraints:

- A first-call `{ confirmElevation: true }` still falls through to `issueConfirmation(...)` because there is no valid token.
- `networkManager.setFirewallConfiguring(true)` happens only immediately before the real spawn.
- The existing `startElevatedRepair(...)` cleanup continues to reset the firewall cache and clear `firewall.configuring` on exit or spawn failure.
- Keep the existing outer `try/catch` around the route so WSL plan errors still log and return `500`.

**Step 6: Re-run the targeted server tests**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/unit/server/firewall-repair-coordinator.test.ts \
  test/integration/server/network-api.test.ts
```

Expected:
- PASS

**Step 7: Commit**

```bash
git add server/network-router.ts \
  test/integration/server/network-api.test.ts
git commit -m "fix(server): enforce tokenized firewall confirmation"
```

### Task 3: Round-Trip the Confirmation Token Through the Shared Client Helper

**Files:**
- Modify: `src/lib/firewall-configure.ts`
- Modify: `test/unit/client/lib/firewall-configure.test.ts`

**Step 1: Tighten the client helper tests**

In `test/unit/client/lib/firewall-configure.test.ts`, update the confirmation coverage:

```ts
it('returns confirmation-required payloads with a confirmation token', async () => {
  vi.mocked(api.post).mockResolvedValue({
    method: 'confirmation-required',
    title: 'Administrator approval required',
    body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
    confirmLabel: 'Continue',
    confirmationToken: 'confirm-1',
  })

  const result = await fetchFirewallConfig()

  expect(result).toMatchObject({
    method: 'confirmation-required',
    confirmationToken: 'confirm-1',
  })
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

**Step 2: Run the targeted client helper test and verify it fails**

Run:

```bash
npx vitest run test/unit/client/lib/firewall-configure.test.ts
```

Expected:
- FAIL because the helper type and request body still know only about `confirmElevation`.

**Step 3: Patch the shared client helper**

In `src/lib/firewall-configure.ts`, update the result type and helper signature:

```ts
export type ConfigureFirewallResult =
  | { method: 'terminal'; command: string }
  | { method: 'wsl2' | 'windows-elevated'; status: string }
  | {
    method: 'confirmation-required'
    title: string
    body: string
    confirmLabel: string
    confirmationToken: string
  }
  | { method: 'none'; message?: string }
  | { method: 'in-progress'; error: string }

export async function fetchFirewallConfig(
  body: { confirmElevation?: true; confirmationToken?: string } = {},
): Promise<ConfigureFirewallResult> {
  return api.post<ConfigureFirewallResult>('/api/network/configure-firewall', body)
}
```

Update the contract comment so it explicitly says the confirmed retry must send both `confirmElevation: true` and the server-issued `confirmationToken`.

**Step 4: Re-run the targeted client helper test**

Run:

```bash
npx vitest run test/unit/client/lib/firewall-configure.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/lib/firewall-configure.ts \
  test/unit/client/lib/firewall-configure.test.ts
git commit -m "fix(client): add firewall confirmation tokens"
```

### Task 4: Send the Token From `SetupWizard` and `SettingsView`

**Files:**
- Modify: `src/components/SetupWizard.tsx`
- Modify: `src/components/SettingsView.tsx`
- Modify: `test/unit/client/SetupWizard.test.tsx`
- Modify: `test/unit/client/components/SettingsView.network-access.test.tsx`
- Modify: `test/e2e/network-setup.test.tsx`

**Step 1: Update the wizard, settings, and e2e tests to expect token round-trip**

Update the existing confirmation tests in:

- `test/unit/client/SetupWizard.test.tsx`
- `test/unit/client/components/SettingsView.network-access.test.tsx`
- `test/e2e/network-setup.test.tsx`

Use `confirmationToken: 'confirm-1'` in the mocked confirmation payloads, and change the second-call assertions to:

```ts
expect(mockFetchFirewallConfig).toHaveBeenNthCalledWith(2, {
  confirmElevation: true,
  confirmationToken: 'confirm-1',
})
```

Keep the existing cancel-path tests intact.

**Step 2: Run the targeted UI tests and verify they fail**

Run:

```bash
npx vitest run \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
```

Expected:
- FAIL because both components still retry with `{ confirmElevation: true }` only.

**Step 3: Patch `src/components/SetupWizard.tsx`**

Keep using the existing `FirewallConfirmation` extracted type and `ConfirmModal`. Change the request body type and confirm handler:

```ts
const requestFirewallConfig = useCallback(async (
  body: { confirmElevation?: true; confirmationToken?: string } = {},
) => {
  const result = await fetchFirewallConfig(body)
  handleFirewallResult(result)
}, [handleFirewallResult])

const handleConfirmFirewall = useCallback(async () => {
  if (!firewallConfirmation) return
  const confirmationToken = firewallConfirmation.confirmationToken
  setFirewallConfirmation(null)
  try {
    await requestFirewallConfig({
      confirmElevation: true,
      confirmationToken,
    })
  } catch (err: any) {
    setFirewallStatus('error')
    setFirewallDetail(err?.message || 'Firewall configuration failed')
  }
}, [firewallConfirmation, requestFirewallConfig])
```

Do not change the modal copy, label, or cancel behavior.

**Step 4: Patch `src/components/SettingsView.tsx`**

Mirror the same request-body widening and tokenized confirm path:

```ts
const requestFirewallFix = useCallback(async (
  body: { confirmElevation?: true; confirmationToken?: string } = {},
) => {
  setFirewallRefreshDetail(null)
  try {
    const result = await fetchFirewallConfig(body)
    handleFirewallFixResult(result)
  } catch {
    // Silently fail — user can retry
  }
}, [handleFirewallFixResult])

const handleConfirmFirewallFix = useCallback(() => {
  if (!firewallConfirmation) return
  const confirmationToken = firewallConfirmation.confirmationToken
  setFirewallConfirmation(null)
  void requestFirewallFix({
    confirmElevation: true,
    confirmationToken,
  })
}, [firewallConfirmation, requestFirewallFix])
```

Keep the existing behavior where a repeated `confirmation-required` response simply reopens the modal with the fresh payload.

**Step 5: Re-run the targeted UI tests**

Run:

```bash
npx vitest run \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
```

Expected:
- PASS

**Step 6: Commit**

```bash
git add src/components/SetupWizard.tsx \
  src/components/SettingsView.tsx \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
git commit -m "fix(ui): confirm elevated repair with server tokens"
```

### Task 5: Re-Verify the Already-Landed Startup and Least-Privilege Changes

**Files:**
- Modify only if a regression test fails: `server/index.ts`
- Modify only if a regression test fails: `server/wsl-port-forward.ts`
- Modify only if a regression test fails: `test/integration/server/wsl-port-forward.test.ts`
- Modify only if a regression test fails: `test/integration/server/logger.separation.harness.ts`
- Modify only if a regression test fails: `test/integration/server/logger.separation.harness.test.ts`
- Modify only if a regression test fails: `test/unit/server/elevated-powershell.test.ts`
- Modify only if a regression test fails: `src/components/ui/confirm-modal.tsx`
- Modify only if a regression test fails: `test/unit/client/components/ui/confirm-modal.test.tsx`
- Modify only if a regression test fails: `electron/daemon/windows-service.ts`
- Modify only if a regression test fails: `installers/windows/freshell-task.xml.template`
- Modify only if a regression test fails: `test/unit/electron/daemon/windows-service.test.ts`

**Step 1: Run the focused regression matrix first**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.test.ts \
  test/unit/server/elevated-powershell.test.ts
```

Expected:
- PASS, confirming there is still no boot-time WSL repair path and no dead startup suppression env dependency.

Run:

```bash
npx vitest run \
  test/unit/client/components/ui/confirm-modal.test.tsx
```

Expected:
- PASS, confirming the existing accessible confirmation modal still matches the manual elevation UX.

Run:

```bash
npx vitest run --config vitest.electron.config.ts \
  test/unit/electron/daemon/windows-service.test.ts
```

Expected:
- PASS, confirming the scheduled task remains least privilege.

**Step 2: If a regression fails, repair only the minimal drift**

If any Step 1 test fails:

- fix only the regression the test exposed
- do not reintroduce boot-time WSL repair or `FRESHELL_DISABLE_WSL_PORT_FORWARD`
- do not loosen the daemon run level away from `LeastPrivilege` or `/RL LIMITED`
- update stale comments only when the test failure or code change makes them incorrect

If all Step 1 tests pass, make no file changes in this task.

**Step 3: Run the combined targeted verification matrix**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/unit/server/firewall-repair-coordinator.test.ts \
  test/integration/server/network-api.test.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.test.ts \
  test/unit/server/elevated-powershell.test.ts
```

Expected:
- PASS

Run:

```bash
npx vitest run \
  test/unit/client/lib/firewall-configure.test.ts \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/unit/client/components/ui/confirm-modal.test.tsx \
  test/e2e/network-setup.test.tsx
```

Expected:
- PASS

Run:

```bash
npx vitest run --config vitest.electron.config.ts \
  test/unit/electron/daemon/windows-service.test.ts
```

Expected:
- PASS

**Step 4: Run repo-level verification**

Run:

```bash
npm run lint
npm run verify
npm test
```

Expected:
- PASS

**Step 5: Commit only if this task changed files**

If Step 2 required code changes:

```bash
git add server/index.ts \
  server/wsl-port-forward.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.ts \
  test/integration/server/logger.separation.harness.test.ts \
  test/unit/server/elevated-powershell.test.ts \
  src/components/ui/confirm-modal.tsx \
  test/unit/client/components/ui/confirm-modal.test.tsx \
  electron/daemon/windows-service.ts \
  installers/windows/freshell-task.xml.template \
  test/unit/electron/daemon/windows-service.test.ts
git commit -m "chore: preserve windows privilege boundary regressions"
```

If Step 2 made no file changes, skip this commit and leave the worktree clean.

## Final Sanity Check

- `git status --short` is clean.
- `server/network-router.ts` no longer allows a first-call `{ confirmElevation: true }` to elevate.
- `server/network-router.ts` requires both `confirmElevation: true` and a valid one-time `confirmationToken` before any Windows/WSL elevation.
- `server/network-router.ts` uses a real single-flight confirmed-repair lock instead of trusting `status.firewall.configuring` as a lock.
- `src/lib/firewall-configure.ts`, `src/components/SetupWizard.tsx`, and `src/components/SettingsView.tsx` all round-trip the server-issued `confirmationToken`.
- `test/integration/server/wsl-port-forward.test.ts` still proves there is no startup WSL repair import path.
- `installers/windows/freshell-task.xml.template` still contains `LeastPrivilege`.

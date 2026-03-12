# Windows Privilege Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use @trycycle-executing to implement this plan task-by-task.

**Goal:** Finish the approved Windows privilege fixes by making `POST /api/network/configure-firewall` a server-enforced two-step confirmation flow, round-tripping the server token through both manual UI entry points, handling active-repair responses in the UI, and preserving the already-landed no-startup-elevation and least-privilege daemon behavior.

**Architecture:** The center of gravity is the public contract of `POST /api/network/configure-firewall`. Lock that contract in integration tests first, then implement it in `server/network-router.ts` with a small router-local confirmation coordinator that owns one latest-issued one-time token plus the confirmed-repair single-flight lock, while keeping repair-need detection in `network-router.ts`, WSL planning in `server/wsl-port-forward.ts`, and privileged process launch in `spawnElevatedPowerShell(...)`. The client stays thin: it shows the explicit pre-UAC confirmation modal the user approved, sends the server-issued `confirmationToken` on confirmation, and treats `in-progress` as already-started work instead of silently doing nothing.

**Tech Stack:** TypeScript, Express, Zod, React, Redux Toolkit, Vitest, Testing Library, supertest, Electron scheduled tasks

---

## Strategy Gate

- Solve the remaining privilege-boundary bug from the current branch state. Do not re-open or redesign the already-landed removal of boot-time WSL repair, the existing modal UX, or the daemon least-privilege normalization unless a regression test proves drift.
- Contract first. The last implementation/review loop diverged because the route protocol was not pinned down tightly enough. Write the failing `POST /api/network/configure-firewall` integration contract before introducing a helper abstraction.
- Keep manual repair in-product. The user explicitly approved: warn first, then let Windows show its normal administrator prompt. Do not switch to copy-paste scripts or a setup-only flow.
- Keep privileged spawn centralized in `spawnElevatedPowerShell(...)`. No other code path should build `Start-Process ... -Verb RunAs`.
- Keep confirmation proof and the single-flight lock on the server. Do not move either concern into Redux, `NetworkManager`, or browser-only state.
- Treat `method: 'in-progress'` as a first-class outcome. The server can legitimately return it during concurrent confirmed retries, so both UI entry points must react by following the already-running repair instead of dead-ending.
- Keep the token flow intentionally simple. An in-memory latest-issued one-time token is sufficient here; do not add persistence, per-client token stores, or TTL machinery in this pass.
- No `docs/index.html` update is needed. This is a privilege-boundary correction in existing flows, not a new user-facing feature.

## Design Reset

Implement one explicit route protocol and carry it all the way through the client:

1. Initial request: `POST /api/network/configure-firewall` with `{}`.
Expected behavior:
   - return `terminal` for Linux/macOS command-based repair
   - return `none` if remote access is disabled or no repair is needed
   - return `confirmation-required` with a fresh `confirmationToken` if native Windows or WSL repair still needs elevation
   - issuing a fresh token invalidates any earlier unconsumed token
   - never spawn elevated PowerShell
2. Confirmed retry: `POST /api/network/configure-firewall` with `{ confirmElevation: true, confirmationToken }`.
Expected behavior:
   - if the current repair path is non-confirmable (`none` or `terminal`), return that current result directly
   - if the token is missing, wrong, replayed, superseded, or for the wrong repair platform, return a fresh `confirmation-required` response immediately
   - only after a valid token is presented may the request try to take the confirmed-repair lock
   - once inside the lock, recompute the current repair need before spawning anything
   - if the recomputed state no longer needs elevation, return the current `none` or `terminal` result
   - only after both a valid token and a successful lock acquisition may the route spawn elevation and return `wsl2` or `windows-elevated`
3. Active repair behavior.
Expected behavior:
   - exactly one confirmed repair may own the single-flight lock at a time
   - a concurrent confirmed retry that loses the lock returns `409 { method: 'in-progress' }`
   - `status.firewall.configuring` remains a status signal for live elevated work, not the synchronization primitive
   - both UI entry points treat `in-progress` the same as an already-started repair: follow status until it settles, do not reopen the modal, and do not open a terminal
4. Already-landed guardrails.
Expected behavior:
   - startup on WSL never attempts Windows portproxy/firewall repair
   - child server launches and tests do not depend on `FRESHELL_DISABLE_WSL_PORT_FORWARD`
   - the Windows scheduled task stays least privilege in both the XML and the runtime `schtasks` calls

This is the simplest direct fix for the user’s approved direction: no surprise elevation on boot, explicit in-product warning before Windows UAC, server-side enforcement of the two-step flow, and least-privilege daemon startup.

## Acceptance Mapping

- Starting the server on WSL never attempts Windows portproxy/firewall repair and never depends on `FRESHELL_DISABLE_WSL_PORT_FORWARD`.
- `POST /api/network/configure-firewall` has these outcomes:
  - `terminal` for Linux/macOS command-based repair
  - `none` when remote access is disabled or no configuration changes are needed
  - `confirmation-required` with a fresh one-time `confirmationToken`
  - `wsl2` or `windows-elevated` only after a validated confirmed retry
  - `in-progress` only when another confirmed repair already owns the single-flight lock
- A first-call body of `{ confirmElevation: true }` never elevates. If repair is still needed, it returns a fresh `confirmation-required` response.
- A missing token, wrong token, replayed token, superseded token, or platform-mismatched token never elevates. If repair is still needed, the route returns a fresh `confirmation-required` response.
- Issuing a new `confirmationToken` invalidates any earlier unconsumed token.
- `confirmation-required` responses never set `firewall.configuring`; that flag is reserved for a live elevated child process.
- WSL and native Windows repair need are recomputed on the confirmed retry. Either path may legitimately collapse to `{ method: 'none', message: 'No configuration changes required' }` or to the current non-confirmable result if state drifted.
- Both UI entry points keep the existing accessible modal and approved copy: `To complete this, you will need to accept the Windows administrator prompt on the next screen.`
- The confirm path from both UI entry points sends both `confirmElevation: true` and the server-issued `confirmationToken`.
- The cancel path from both UI entry points performs no elevated action and makes no second API call.
- Both UI entry points treat `method: 'in-progress'` as active repair:
  - `SetupWizard` keeps the firewall checklist in its active/polling state
  - `SettingsView` schedules the same status refresh path it uses after a started Windows repair
- The Windows scheduled task remains least privilege: `<RunLevel>LeastPrivilege</RunLevel>` in the XML template and `/RL LIMITED` before `schtasks /Run`.

## Scope Notes

- Treat the current branch as the starting point. `server/wsl-port-forward-startup.ts` is already gone, the manual confirmation modal already exists, and the daemon code already normalizes the scheduled-task run level.
- Keep the companion plan at `docs/plans/2026-03-11-windows-privilege-fixes-test-plan.md` in sync with this contract, especially around tokenized confirmation and `in-progress` handling.
- Keep `server/wsl-port-forward.ts` purely non-elevating. If a regression test fails there, repair it without reintroducing any startup wrapper or env-derived suppression logic.
- Keep comments accurate, but do not pad the change set with unrelated cleanup. Touch comments only when they would become wrong after the contract changes.
- Execution note: use @trycycle-executing, keep the red-green-refactor loop explicit, and commit small green slices.

### Task 1: Lock the Server Contract in `network-api.test.ts` and Make the Route Pass

**Files:**
- Modify: `server/network-router.ts`
- Modify: `test/integration/server/network-api.test.ts`

**Step 1: Replace the current boolean-confirmation assertions with the tokenized route contract**

In `test/integration/server/network-api.test.ts`, update the existing `describe('POST /api/network/configure-firewall', ...)` block so it contains these exact behaviors:

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
  const cp = await import('node:child_process')
  vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, _cb: any) => {
    return { on: vi.fn() } as any
  })

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

it('returns 409 in-progress when two confirmed retries race for the same repair', async () => {
  const wslModule = await import('../../../server/wsl-port-forward.js')
  const cp = await import('node:child_process')
  let releasePlan!: () => void
  const planGate = new Promise<void>((resolve) => {
    releasePlan = resolve
  })

  vi.mocked(wslModule.computeWslPortForwardingPlanAsync)
    .mockResolvedValueOnce({
      status: 'ready',
      wslIp: '172.24.0.2',
      scriptKind: 'full',
      script: '$null # mock script',
    })
    .mockImplementationOnce(async () => {
      await planGate
      return {
        status: 'ready',
        wslIp: '172.24.0.2',
        scriptKind: 'full',
        script: '$null # mock script',
      }
    })

  vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
    cb?.(null, '', '')
    return { on: vi.fn() } as any
  })

  const firstRes = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({})

  const startedResPromise = request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({
      confirmElevation: true,
      confirmationToken: firstRes.body.confirmationToken,
    })

  await new Promise((resolve) => setImmediate(resolve))

  const inProgressRes = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({
      confirmElevation: true,
      confirmationToken: firstRes.body.confirmationToken,
    })

  expect(inProgressRes.status).toBe(409)
  expect(inProgressRes.body).toEqual({
    error: 'Firewall configuration already in progress',
    method: 'in-progress',
  })

  releasePlan()

  const startedRes = await startedResPromise
  expect(startedRes.status).toBe(200)
  expect(startedRes.body).toEqual({ method: 'wsl2', status: 'started' })
})
```

Also update or add exact tests for these remaining cases:

- first WSL click returns `confirmation-required` with `confirmationToken`
- confirmed WSL retry can recompute to `none`
- confirmed WSL retry returns `none` if remote access was disabled between calls
- first native-Windows click returns `confirmation-required` with `confirmationToken`
- confirmed native-Windows retry with the issued token starts repair
- first native-Windows `{ confirmElevation: true }` re-prompts instead of elevating
- superseded or replayed tokens re-prompt instead of elevating
- platform-mismatched tokens re-prompt instead of elevating
- malformed bodies such as `{ confirmElevation: false }` or `{ confirmationToken: 7 }` return `400`
- Linux/macOS paths remain `terminal` or `none` and never return `confirmation-required`

Delete or rewrite the old tests that still treat bare `confirmElevation: true` as sufficient.

**Step 2: Run the targeted integration test and verify it fails**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/network-api.test.ts
```

Expected:
- FAIL because `server/network-router.ts` still elevates on a first-call bare `confirmElevation: true`, does not issue/validate `confirmationToken`, and still uses `status.firewall.configuring` as the in-flight guard.

**Step 3: Patch `server/network-router.ts` minimally to satisfy the contract**

In `server/network-router.ts`, make the route enforce the protocol directly inside `createNetworkRouter(...)` first. Keep this implementation inline for now; Task 2 will extract the helper after the integration contract is green.

Add `import { randomUUID } from 'node:crypto'` at the top of the file.

Use this request schema:

```ts
const ConfigureFirewallRequestSchema = z.object({
  confirmElevation: z.literal(true).optional(),
  confirmationToken: z.string().min(1).optional(),
}).strict()
```

Add inline route-local state and helpers:

```ts
type RepairPlatform = 'windows' | 'wsl2'

const FIREWALL_REPAIR_LOCKED = Symbol('FIREWALL_REPAIR_LOCKED')

let currentConfirmation: { token: string; platform: RepairPlatform } | null = null
let confirmedRepairInFlight = false

function issueConfirmation(platform: RepairPlatform) {
  const confirmationToken = randomUUID()
  currentConfirmation = { token: confirmationToken, platform }
  return {
    method: 'confirmation-required' as const,
    title: 'Administrator approval required',
    body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
    confirmLabel: 'Continue',
    confirmationToken,
  }
}

function matchesConfirmation(token: string | undefined, platform: RepairPlatform) {
  return !!currentConfirmation
    && currentConfirmation.token === token
    && currentConfirmation.platform === platform
}

function consumeConfirmation(token: string | undefined, platform: RepairPlatform) {
  if (!matchesConfirmation(token, platform)) return false
  currentConfirmation = null
  return true
}

async function withConfirmedRepairLock<T>(fn: () => Promise<T>) {
  if (confirmedRepairInFlight) return FIREWALL_REPAIR_LOCKED
  confirmedRepairInFlight = true
  try {
    return await fn()
  } finally {
    confirmedRepairInFlight = false
  }
}
```

Factor shared repair resolution so both the first call and the confirmed retry use the same fresh-state logic:

```ts
type ConfirmableRepairAction = {
  kind: 'confirmable'
  platform: RepairPlatform
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

    const plan = await computeWslPortForwardingPlanAsync(networkManager.getRelevantPorts())
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
    if (status.firewall.commands.length === 0) {
      return { kind: 'none', response: { method: 'none', message: 'No firewall detected' } }
    }
    if (status.firewall.portOpen === true) {
      return { kind: 'none', response: NO_CONFIGURATION_CHANGES_REQUIRED }
    }

    return {
      kind: 'confirmable',
      platform: 'windows',
      script: status.firewall.commands.join('; '),
      responseMethod: 'windows-elevated',
    }
  }

  if (status.firewall.commands.length === 0) {
    return { kind: 'none', response: { method: 'none', message: 'No firewall detected' } }
  }

  return {
    kind: 'terminal',
    response: { method: 'terminal', command: status.firewall.commands.join(' && ') },
  }
}
```

Patch the route so its decision tree is:

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

if (!confirmElevation || !matchesConfirmation(confirmationToken, action.platform)) {
  return res.json(issueConfirmation(action.platform))
}

const lockedResult = await withConfirmedRepairLock(async () => {
  const [freshStatus, freshSettings] = await Promise.all([
    networkManager.getStatus(),
    configStore.getSettings(),
  ])
  const freshAction = await resolveRepairAction(freshStatus, freshSettings)

  if (freshAction.kind === 'none' || freshAction.kind === 'terminal') {
    return { status: 200 as const, body: freshAction.response }
  }

  if (!consumeConfirmation(confirmationToken, freshAction.platform)) {
    return {
      status: 200 as const,
      body: issueConfirmation(freshAction.platform),
    }
  }

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

- `status.firewall.configuring` is no longer consulted as a lock before confirmation handling.
- A first-call `{ confirmElevation: true }` still re-prompts because there is no valid server token.
- A newly issued token invalidates the previous outstanding token.
- `startElevatedRepair(...)` remains the only place that flips `firewall.configuring` to `true`, immediately before the real spawn.
- Keep the existing cleanup inside `startElevatedRepair(...)` so exit and spawn-failure paths still reset the firewall cache and clear `firewall.configuring`.

**Step 4: Re-run the targeted integration test**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/network-api.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add server/network-router.ts \
  test/integration/server/network-api.test.ts
git commit -m "fix(server): enforce firewall confirmation contract"
```

### Task 2: Extract the Confirmation Coordinator and Prove It With Unit Tests

**Files:**
- Create: `server/firewall-repair-coordinator.ts`
- Modify: `server/network-router.ts`
- Create: `test/unit/server/firewall-repair-coordinator.test.ts`

**Step 1: Write the failing coordinator unit tests**

Create `test/unit/server/firewall-repair-coordinator.test.ts`:

```ts
import { expect, it } from 'vitest'
import {
  createFirewallRepairCoordinator,
  FIREWALL_REPAIR_LOCKED,
} from '../../../server/firewall-repair-coordinator.js'

it('rotates the latest confirmation token and rejects superseded or wrong-platform tokens', () => {
  const coordinator = createFirewallRepairCoordinator()

  const first = coordinator.issueConfirmation('wsl2')
  const second = coordinator.issueConfirmation('wsl2')

  expect(second).toMatchObject({
    method: 'confirmation-required',
    confirmationToken: expect.any(String),
  })
  expect(
    coordinator.matchesConfirmation(first.confirmationToken, 'wsl2'),
  ).toBe(false)
  expect(
    coordinator.matchesConfirmation(second.confirmationToken, 'windows'),
  ).toBe(false)
  expect(
    coordinator.matchesConfirmation(second.confirmationToken, 'wsl2'),
  ).toBe(true)
  expect(
    coordinator.consumeConfirmation(second.confirmationToken, 'wsl2'),
  ).toBe(true)
  expect(
    coordinator.consumeConfirmation(second.confirmationToken, 'wsl2'),
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

**Step 3: Extract the coordinator without changing route behavior**

Create `server/firewall-repair-coordinator.ts`:

```ts
import { randomUUID } from 'node:crypto'

export const FIREWALL_REPAIR_LOCKED = Symbol('FIREWALL_REPAIR_LOCKED')

type RepairPlatform = 'windows' | 'wsl2'

export function createFirewallRepairCoordinator() {
  let currentConfirmation:
    | { token: string; platform: RepairPlatform }
    | null = null
  let confirmedRepairInFlight = false

  return {
    issueConfirmation(platform: RepairPlatform) {
      const confirmationToken = randomUUID()
      currentConfirmation = { token: confirmationToken, platform }
      return {
        method: 'confirmation-required' as const,
        title: 'Administrator approval required',
        body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
        confirmLabel: 'Continue',
        confirmationToken,
      }
    },
    matchesConfirmation(token: string | undefined, platform: RepairPlatform) {
      return !!currentConfirmation
        && currentConfirmation.token === token
        && currentConfirmation.platform === platform
    },
    consumeConfirmation(token: string | undefined, platform: RepairPlatform) {
      if (!currentConfirmation) return false
      if (currentConfirmation.token !== token || currentConfirmation.platform !== platform) {
        return false
      }
      currentConfirmation = null
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

Update `server/network-router.ts` to import and use `createFirewallRepairCoordinator()` plus `FIREWALL_REPAIR_LOCKED`, deleting the inline confirmation state from Task 1 and leaving the route behavior unchanged.

**Step 4: Re-run the unit plus integration tests**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/unit/server/firewall-repair-coordinator.test.ts \
  test/integration/server/network-api.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add server/firewall-repair-coordinator.ts \
  server/network-router.ts \
  test/unit/server/firewall-repair-coordinator.test.ts
git commit -m "refactor(server): extract firewall repair coordinator"
```

### Task 3: Round-Trip the Confirmation Token Through the Shared Client Helper

**Files:**
- Modify: `src/lib/firewall-configure.ts`
- Modify: `test/unit/client/lib/firewall-configure.test.ts`

**Step 1: Tighten the helper tests around the tokenized contract**

In `test/unit/client/lib/firewall-configure.test.ts`, update the confirmation coverage to this shape:

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

Keep the existing `terminal`, `none`, and `in-progress` coverage intact.

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

Update the contract comment so it explicitly says:

- `confirmation-required` callers must retry with both `confirmElevation: true` and the server-issued `confirmationToken`
- `in-progress` means another confirmed repair is already running and the caller should follow status instead of retrying blindly

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

### Task 4: Make `SetupWizard` and `SettingsView` Send the Token and Follow `in-progress`

**Files:**
- Modify: `src/components/SetupWizard.tsx`
- Modify: `src/components/SettingsView.tsx`
- Modify: `test/unit/client/SetupWizard.test.tsx`
- Modify: `test/unit/client/components/SettingsView.network-access.test.tsx`
- Modify: `test/e2e/network-setup.test.tsx`

**Step 1: Tighten the UI tests for token round-trip and active-repair behavior**

Update the existing confirmation tests in:

- `test/unit/client/SetupWizard.test.tsx`
- `test/unit/client/components/SettingsView.network-access.test.tsx`
- `test/e2e/network-setup.test.tsx`

Use `confirmationToken: 'confirm-1'` in the mocked confirmation payloads and change the second-call assertions to:

```ts
expect(mockFetchFirewallConfig).toHaveBeenNthCalledWith(2, {
  confirmElevation: true,
  confirmationToken: 'confirm-1',
})
```

Add exact unit-level assertions for `in-progress`:

Use fake timers in these cases because both components schedule their follow-up polling/refresh work.

```ts
it('treats an in-progress wizard repair as active work and starts polling', async () => {
  mockFetchFirewallConfig.mockResolvedValueOnce({
    method: 'in-progress',
    error: 'Firewall configuration already in progress',
  })

  renderWizardAtFirewallStep()
  await user.click(screen.getByRole('button', { name: /configure now/i }))
  vi.runOnlyPendingTimers()

  await waitFor(() => expect(mockFetchNetworkStatus).toHaveBeenCalled())
  expect(screen.getByText(/configuring firewall/i)).toBeInTheDocument()
})

it('treats an in-progress settings repair as a refresh path instead of a no-op', async () => {
  mockFetchFirewallConfig.mockResolvedValueOnce({
    method: 'in-progress',
    error: 'Firewall configuration already in progress',
  })

  renderSettingsView()
  await user.click(screen.getByRole('button', { name: /fix firewall configuration/i }))
  vi.runOnlyPendingTimers()

  await waitFor(() => expect(mockFetchNetworkStatus).toHaveBeenCalled())
})
```

Keep the cancel-path tests intact.

**Step 2: Run the targeted UI tests and verify they fail**

Run:

```bash
npx vitest run \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
```

Expected:
- FAIL because both components still retry with `{ confirmElevation: true }` only and neither component treats `method: 'in-progress'` as active repair.

**Step 3: Patch `src/components/SetupWizard.tsx`**

Keep using the existing `FirewallConfirmation` extracted type and `ConfirmModal`. Widen the request body type and send the stored token on confirmation:

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

Also make `handleFirewallResult(...)` treat `method: 'in-progress'` as the same follow-status path as a started Windows/WSL repair. The cleanest shape is to let `startFirewallPolling(initialDetail = 'Configuring firewall...')` accept an optional first detail so the `in-progress` path can say `Firewall configuration already in progress` before polling.

Do not change the modal copy, label, cancel behavior, or terminal-command path.

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

Also update `handleFirewallFixResult(...)` so `method: 'in-progress'` follows the same refresh path as a started Windows repair instead of falling through as a silent no-op. The cleanest approach is to factor the existing timer code into a small local `scheduleFirewallRefresh()` helper and call it for both `windows-elevated` and `in-progress`.

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

### Task 5: Re-Verify the Already-Landed Startup and Least-Privilege Guardrails

**Files:**
- Modify only if a regression test fails: `server/index.ts`
- Modify only if a regression test fails: `server/wsl-port-forward.ts`
- Modify only if a regression test fails: `test/unit/server/wsl-port-forward.test.ts`
- Modify only if a regression test fails: `test/integration/server/wsl-port-forward.test.ts`
- Modify only if a regression test fails: `test/integration/server/logger.separation.harness.ts`
- Modify only if a regression test fails: `test/integration/server/logger.separation.harness.test.ts`
- Modify only if a regression test fails: `test/unit/server/elevated-powershell.test.ts`
- Modify only if a regression test fails: `src/components/ui/confirm-modal.tsx`
- Modify only if a regression test fails: `test/unit/client/components/ui/confirm-modal.test.tsx`
- Modify only if a regression test fails: `electron/daemon/windows-service.ts`
- Modify only if a regression test fails: `electron/startup.ts`
- Modify only if a regression test fails: `installers/windows/freshell-task.xml.template`
- Modify only if a regression test fails: `test/unit/electron/daemon/windows-service.test.ts`
- Modify only if a regression test fails: `test/unit/electron/startup.test.ts`

**Step 1: Run the focused guardrail regression matrix first**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/unit/server/wsl-port-forward.test.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.test.ts \
  test/unit/server/elevated-powershell.test.ts
```

Expected:
- PASS, confirming there is still no boot-time WSL repair path, no env-based startup suppression dependency, and no drift in elevated PowerShell invocation.

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
  test/unit/electron/daemon/windows-service.test.ts \
  test/unit/electron/startup.test.ts
```

Expected:
- PASS, confirming the scheduled task remains least privilege and daemon startup still works after the run-level normalization.

**Step 2: If a guardrail regression fails, repair only the minimal drift**

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
  test/integration/server/network-api.test.ts \
  test/unit/server/firewall-repair-coordinator.test.ts \
  test/unit/server/wsl-port-forward.test.ts \
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
  test/unit/electron/daemon/windows-service.test.ts \
  test/unit/electron/startup.test.ts
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
  test/unit/server/wsl-port-forward.test.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.ts \
  test/integration/server/logger.separation.harness.test.ts \
  test/unit/server/elevated-powershell.test.ts \
  src/components/ui/confirm-modal.tsx \
  test/unit/client/components/ui/confirm-modal.test.tsx \
  electron/daemon/windows-service.ts \
  electron/startup.ts \
  installers/windows/freshell-task.xml.template \
  test/unit/electron/daemon/windows-service.test.ts \
  test/unit/electron/startup.test.ts
git commit -m "chore: preserve windows privilege boundary regressions"
```

If Step 2 made no file changes, skip this commit and leave the worktree clean.

## Final Sanity Check

- `git status --short` is clean.
- `server/network-router.ts` no longer allows a first-call `{ confirmElevation: true }` to elevate.
- `server/network-router.ts` requires both `confirmElevation: true` and a valid one-time `confirmationToken` before any Windows/WSL elevation.
- `server/network-router.ts` uses a real confirmed-repair single-flight lock instead of trusting `status.firewall.configuring` as a lock.
- `src/lib/firewall-configure.ts`, `src/components/SetupWizard.tsx`, and `src/components/SettingsView.tsx` all round-trip the server-issued `confirmationToken`.
- `src/components/SetupWizard.tsx` and `src/components/SettingsView.tsx` both follow `method: 'in-progress'` as active repair rather than silently doing nothing.
- `test/integration/server/wsl-port-forward.test.ts` still proves there is no startup WSL repair import path.
- `installers/windows/freshell-task.xml.template` still contains `LeastPrivilege`.

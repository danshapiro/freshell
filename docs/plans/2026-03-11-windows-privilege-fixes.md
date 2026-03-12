# Windows Privilege Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use @trycycle-executing to implement this plan task-by-task.

**Goal:** Finish the Windows privilege-boundary fixes by server-enforcing the manual elevation handshake, round-tripping its proof token through the existing UI confirmation flows, and re-verifying the already-landed startup and daemon least-privilege corrections.

**Architecture:** This branch already removed boot-time WSL auto-repair, removed the boot-only suppression env, added the manual confirmation modal UX in `SetupWizard` and `SettingsView`, and switched the Windows scheduled task to least privilege. The remaining defect is in `POST /api/network/configure-firewall`: it still trusts a bare `confirmElevation` boolean and uses a stale `firewall.configuring` snapshot as a lock. Fix that route first by introducing a router-local coordinator that issues one-time confirmation tokens and owns the confirmed-repair single-flight lock, then thread the token through the existing client helper and retry handlers. Keep WSL/manual repair recomputed at execution time so IP drift, no-op transitions, and remote-access changes cannot bypass the contract.

**Tech Stack:** TypeScript, Express, Zod, React, Redux Toolkit, Vitest, Testing Library, supertest, Electron scheduled tasks

---

## Strategy Gate

- Solve the remaining real bug, not already-landed work. Preserve the branch's existing startup-path removal, modal UI shell, and daemon least-privilege changes unless regression tests prove drift.
- Start with `POST /api/network/configure-firewall`. The last review loop failed because the server contract there was implicit and branchy.
- Two-step confirmation must be enforced by the server. A first-call `{ confirmElevation: true }` must never be enough to elevate.
- Use a one-time confirmation token plus a single-flight confirmed-repair lock. Recompute current repair need inside the lock before any spawn.
- Keep manual repair in-product. Reuse the existing accessible `ConfirmModal`; do not add script-copy workflows, new settings, or remembered consent.
- Do not resurrect startup WSL repair, `FRESHELL_DISABLE_WSL_PORT_FORWARD`, or any other boot-only suppression flag. Startup detection now lives through normal network status only.
- Least-privilege daemon work is already on the branch. Only revisit it if the regression tests show that `schtasks /Change /RL LIMITED` or the XML template drifted.
- No `docs/index.html` update is needed. This is a privilege-boundary correction inside existing flows.

## Acceptance Mapping

- Starting the server on WSL never attempts Windows portproxy/firewall repair and never depends on `FRESHELL_DISABLE_WSL_PORT_FORWARD`.
- `POST /api/network/configure-firewall` has exactly five interactive outcomes:
  - `terminal` for Linux/macOS command-based repair
  - `none` when nothing needs changing or remote access is no longer enabled
  - `confirmation-required` with a fresh one-time `confirmationToken`
  - `wsl2` / `windows-elevated` only after a validated confirmed retry
  - `in-progress` when another confirmed repair is already holding the single-flight lock
- A first-call body of `{ confirmElevation: true }`, a missing token, an expired token, a replayed token, or a platform-mismatched token never elevates. If repair is still needed, the server returns a fresh `confirmation-required` response instead.
- `confirmation-required` responses do not mark `firewall.configuring`; that flag remains reserved for a live elevated child process.
- WSL repair is recomputed on both the first click and the confirmed retry. Either call may legitimately collapse to `{ method: 'none', message: 'No configuration changes required' }`.
- `SetupWizard` and `SettingsView` keep the existing accessible modal and explicit copy: `To complete this, you will need to accept the Windows administrator prompt on the next screen.` The cancel path performs no elevated action.
- The confirmed retry from both UI entry points sends both `confirmElevation: true` and the server-issued `confirmationToken`.
- The Windows scheduled task remains least privilege (`<RunLevel>LeastPrivilege</RunLevel>` in XML and `/RL LIMITED` before `schtasks /Run`).

## Scope Notes

- Treat the branch's current state as the starting point. `server/wsl-port-forward-startup.ts` is already gone, the manual WSL planning helpers already exist, `ConfirmModal` already supports a non-destructive confirm button, and the daemon code already normalizes run level. Do not re-implement those pieces from scratch.
- The new protocol state belongs next to `createNetworkRouter(...)`, not in Redux, not in `NetworkManager`, and not spread across UI components. Keep `NetworkManager` responsible for network/firewall facts and cache invalidation; keep the coordinator responsible for confirmation proof and single-flight locking.
- Keep `spawnElevatedPowerShell(...)` as the only place that constructs `Start-Process ... -Verb RunAs`.
- Keep `server/wsl-port-forward.ts` purely non-elevating. If a regression test fails there, repair it without reintroducing any startup wrapper or env-derived port list.
- Execution note: use `@trycycle-executing` and keep commits small and frequent.

### Task 1: Lock Down the Server-Side Firewall Repair Contract

**Files:**
- Create: `server/firewall-repair-coordinator.ts`
- Create: `test/unit/server/firewall-repair-coordinator.test.ts`
- Modify: `server/network-router.ts`
- Modify: `server/firewall.ts`
- Modify: `test/integration/server/network-api.test.ts`

**Step 1: Write the failing server contract tests**

Create `test/unit/server/firewall-repair-coordinator.test.ts`:

```ts
import { expect, it } from 'vitest'
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

In `test/integration/server/network-api.test.ts`, update the existing `POST /api/network/configure-firewall` block so it asserts the actual remaining contract:

- first WSL click returns `confirmation-required` with `confirmationToken`, and `execFile` is not called
- first-call `{ confirmElevation: true }` without a server token still returns `confirmation-required`
- confirmed WSL retry with the issued token starts repair
- confirmed WSL retry can recompute to `none`
- confirmed Windows retry can collapse to `none` if remote access is disabled before the second call
- first-call `{ confirmElevation: true }` on native Windows still does not elevate
- confirmed Windows retry with the issued token starts repair
- two concurrent confirmed requests produce one `started` response and one `409 { method: 'in-progress' }`
- malformed bodies such as `{ confirmElevation: false }` or `{ confirmationToken: 7 }` return `400`

Use the WSL mock shape already present in the file, but make it include `confirmationToken` in the expected server responses.

**Step 2: Run the targeted server tests and confirm failure**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/network-api.test.ts \
  test/unit/server/firewall-repair-coordinator.test.ts
```

Expected:
- FAIL because `server/network-router.ts` still treats a bare `confirmElevation: true` as sufficient on the first call, does not issue one-time tokens, and relies on a racy `firewall.configuring` snapshot instead of a real confirmed-repair lock.

**Step 3: Write the minimal server implementation**

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

In `server/network-router.ts`:

- Expand the request schema to:

```ts
const ConfigureFirewallRequestSchema = z.object({
  confirmElevation: z.literal(true).optional(),
  confirmationToken: z.string().uuid().optional(),
}).strict()
```

- Instantiate one `const repairCoordinator = createFirewallRepairCoordinator()` inside `createNetworkRouter(...)`.
- Add a small local helper that converts the current platform-specific state into one of:
  - `{ kind: 'none', response: { method: 'none', ... } }`
  - `{ kind: 'confirmable', platform: 'wsl2' | 'windows', script: string, responseMethod: 'wsl2' | 'windows-elevated' }`
  - `{ kind: 'error', status: 500, body: { error: string } }`
- For WSL2, that helper must call `computeWslPortForwardingPlanAsync(networkManager.getRelevantPorts())` on every entry:
  - `status: 'error'` -> `500`
  - `status: 'noop'` or `status: 'not-wsl2'` -> `{ method: 'none', message: 'No configuration changes required' }`
  - `status: 'ready'` -> confirmable action carrying the returned `script`
- For Windows, the helper must re-read `status.firewall.commands` and `status.firewall.portOpen` on every entry:
  - no commands -> `{ method: 'none', message: 'No firewall detected' }`
  - `portOpen === true` -> `{ method: 'none', message: 'No configuration changes required' }`
  - otherwise -> confirmable action with `script = commands.join('; ')`
- Keep the remote-access-disabled check in front of any platform-specific repair action and return `{ method: 'none', message: 'Remote access is not enabled' }`.
- If repair is needed but the request is missing either `confirmElevation: true` or a valid `confirmationToken`, return `repairCoordinator.issueConfirmation(platform)` without spawning PowerShell. This includes the first-call `{ confirmElevation: true }` case.
- For confirmed requests, wrap the entire fresh-state revalidation and spawn decision inside `repairCoordinator.withConfirmedRepairLock(...)`.
  - If the lock returns `FIREWALL_REPAIR_LOCKED`, respond with `409` and `{ method: 'in-progress', error: 'Firewall configuration already in progress' }`.
  - Once inside the lock, re-fetch fresh `status` and `settings`, re-run the repair-action helper, and only then decide whether to return `none`, `confirmation-required`, or start repair.
  - Only if `repairCoordinator.consumeConfirmation(confirmationToken, platform)` succeeds may the route call `spawnElevatedPowerShell(...)`.
- Keep `networkManager.setFirewallConfiguring(true)` only immediately before the real spawn, not when issuing the prompt.
- Keep the existing cache reset and async completion behavior after the child exits or the spawn fails.
- In `server/firewall.ts`, update comments so they describe explicit user-confirmed Windows elevation rather than unconditional repair.

**Step 4: Re-run the targeted server tests**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/network-api.test.ts \
  test/unit/server/firewall-repair-coordinator.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add server/firewall-repair-coordinator.ts \
  server/network-router.ts \
  server/firewall.ts \
  test/integration/server/network-api.test.ts \
  test/unit/server/firewall-repair-coordinator.test.ts
git commit -m "fix(server): enforce tokenized windows repair confirmation"
```

### Task 2: Round-Trip the Confirmation Token Through the Existing UI Flows

**Files:**
- Modify: `src/lib/firewall-configure.ts`
- Modify: `src/components/SetupWizard.tsx`
- Modify: `src/components/SettingsView.tsx`
- Modify: `test/unit/client/lib/firewall-configure.test.ts`
- Modify: `test/unit/client/SetupWizard.test.tsx`
- Modify: `test/unit/client/components/SettingsView.network-access.test.tsx`
- Modify: `test/e2e/network-setup.test.tsx`

**Step 1: Write the failing client tests**

In `test/unit/client/lib/firewall-configure.test.ts`, tighten the existing confirmation coverage:

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

Update the existing wizard/settings/e2e confirmation tests so the second request now asserts the token round-trip:

```ts
expect(mockFetchFirewallConfig).toHaveBeenNthCalledWith(2, {
  confirmElevation: true,
  confirmationToken: 'confirm-1',
})
```

Keep the existing cancel-path tests intact.

**Step 2: Run the targeted client tests and confirm failure**

Run:

```bash
npx vitest run \
  test/unit/client/lib/firewall-configure.test.ts \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
```

Expected:
- FAIL because the shared client helper does not expose `confirmationToken`, and both UI retry handlers still send only `{ confirmElevation: true }`.

**Step 3: Write the minimal client implementation**

In `src/lib/firewall-configure.ts`:

- Extend the `confirmation-required` result type with `confirmationToken: string`.
- Change the helper signature to:

```ts
export async function fetchFirewallConfig(
  body: { confirmElevation?: true; confirmationToken?: string } = {},
): Promise<ConfigureFirewallResult> {
  return api.post<ConfigureFirewallResult>('/api/network/configure-firewall', body)
}
```

- Update the inline contract comment so it says the confirmed retry must send both `confirmElevation: true` and the server-issued `confirmationToken`.

In `src/components/SetupWizard.tsx` and `src/components/SettingsView.tsx`:

- Keep using the existing `FirewallConfirmation` extracted type and existing `ConfirmModal`.
- When the first `fetchFirewallConfig()` call returns `confirmation-required`, preserve the whole payload in state, including `confirmationToken`.
- On confirm, retry with:

```ts
{
  confirmElevation: true,
  confirmationToken: firewallConfirmation.confirmationToken,
}
```

- Keep the existing behavior where a repeated `confirmation-required` response simply updates modal state again instead of assuming the second call always starts repair.
- Keep cancel as a pure close/no-op path.
- Do not change the copy or button styling; those pieces are already correct on this branch.

**Step 4: Re-run the targeted client tests**

Run:

```bash
npx vitest run \
  test/unit/client/lib/firewall-configure.test.ts \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/lib/firewall-configure.ts \
  src/components/SetupWizard.tsx \
  src/components/SettingsView.tsx \
  test/unit/client/lib/firewall-configure.test.ts \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
git commit -m "fix(ui): round-trip windows repair confirmation tokens"
```

### Task 3: Re-Verify the Already-Landed Startup and Daemon Fixes While Cleaning Up Contract Comments

**Files:**
- Modify only if a regression test fails: `server/index.ts`
- Modify only if a regression test fails: `server/wsl-port-forward.ts`
- Modify only if a regression test fails: `test/integration/server/wsl-port-forward.test.ts`
- Modify only if a regression test fails: `test/integration/server/logger.separation.harness.ts`
- Modify only if a regression test fails: `test/integration/server/logger.separation.harness.test.ts`
- Modify only if a regression test fails: `test/e2e-browser/helpers/test-server.ts`
- Modify only if a regression test fails: `electron/daemon/windows-service.ts`
- Modify only if a regression test fails: `installers/windows/freshell-task.xml.template`
- Modify only if a regression test fails: `test/unit/electron/daemon/windows-service.test.ts`
- Modify only if a regression test fails: `test/unit/server/elevated-powershell.test.ts`
- Modify only if a regression test fails: `test/unit/client/components/ui/confirm-modal.test.tsx`

**Step 1: Run the focused regression matrix for the already-landed fixes**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.test.ts \
  test/unit/server/elevated-powershell.test.ts
```

Expected:
- PASS, confirming the branch still has no boot-time WSL repair path, no dead suppression env, and a working shared elevation helper.

Run:

```bash
npx vitest run \
  test/unit/client/components/ui/confirm-modal.test.tsx
```

Expected:
- PASS, confirming the existing modal behavior stays compatible with the manual confirmation flow.

Run:

```bash
npx vitest run --config vitest.electron.config.ts \
  test/unit/electron/daemon/windows-service.test.ts
```

Expected:
- PASS, confirming the scheduled task remains least privilege.

**Step 2: If any regression fails, repair only the minimal drift**

If either matrix fails, fix only the drift that broke the already-landed behavior:

- do not reintroduce startup WSL repair or `FRESHELL_DISABLE_WSL_PORT_FORWARD`
- do not loosen the daemon run level away from `LeastPrivilege` / `LIMITED`
- update stale comments if they still describe unconditional Windows elevation or boot-time auto-repair

If all matrices already pass, make no code changes in this task.

**Step 3: Run the combined targeted verification matrix**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/network-api.test.ts \
  test/unit/server/firewall-repair-coordinator.test.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.test.ts \
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

**Step 5: Commit final polish only if this task changed files**

If Step 2 required a repair or comment cleanup, commit it:

```bash
git add server/index.ts \
  server/wsl-port-forward.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.ts \
  test/integration/server/logger.separation.harness.test.ts \
  test/e2e-browser/helpers/test-server.ts \
  electron/daemon/windows-service.ts \
  installers/windows/freshell-task.xml.template \
  test/unit/electron/daemon/windows-service.test.ts \
  test/unit/server/elevated-powershell.test.ts \
  test/unit/client/components/ui/confirm-modal.test.tsx
git commit -m "chore: preserve windows privilege boundary regressions"
```

If Step 2 made no file changes, skip this commit and leave the worktree clean.

## Final Sanity Check

- `git status --short` is clean.
- `server/network-router.ts` no longer allows a first-call `{ confirmElevation: true }` to elevate.
- `server/network-router.ts` requires a one-time `confirmationToken` and a confirmed-repair lock before any Windows/WSL spawn.
- `src/lib/firewall-configure.ts`, `src/components/SetupWizard.tsx`, and `src/components/SettingsView.tsx` all round-trip the server-issued `confirmationToken`.
- `test/integration/server/wsl-port-forward.test.ts` still proves there is no startup WSL repair import path.
- `installers/windows/freshell-task.xml.template` still contains `LeastPrivilege`.

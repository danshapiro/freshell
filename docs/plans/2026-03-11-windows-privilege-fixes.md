# Windows Privilege Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Remove unsolicited Windows elevation during startup/tests, require an explicit in-product confirmation before any manual Windows/WSL firewall repair can elevate, and ensure Windows daemon tasks run at least privilege.

**Architecture:** Delete the boot-time WSL auto-repair path entirely so privilege elevation can only happen from the existing manual repair buttons. Convert Windows/WSL repair into a two-step contract: the first server response says administrator approval is required; only a second request with `confirmElevation: true` may spawn a shared elevated PowerShell helper. Keep least privilege enforced in both the task XML and the Windows daemon manager so new and existing scheduled tasks stop asking for `HighestAvailable`.

**Tech Stack:** TypeScript, Express, Zod, React, Redux Toolkit, Vitest, Testing Library, supertest, Electron scheduled tasks

---

## Strategy Gate

- The user approved removing startup auto-elevation. Do not preserve `FRESHELL_DISABLE_WSL_PORT_FORWARD` or any other boot-only suppression layer; delete the boot path instead.
- Manual repair stays in-product. The accepted UX is a one-click repair flow preceded by an explicit confirmation modal warning that a Windows admin prompt is next.
- The privilege boundary must be enforced server-side as well as in the UI. Browser confirmation alone is insufficient because other callers can hit the API directly.
- Reuse the existing repair entry points in `SetupWizard` and `SettingsView`. Do not add new settings, banners, or script-copy workflows.
- Centralize the `Start-Process ... -Verb RunAs` argument construction in one server helper. The current duplication is the most fragile code in the affected path.
- The daemon fix is not documentation-only. Update both the scheduled task definition and the runtime manager so existing elevated tasks are normalized before `schtasks /Run`.
- No `docs/index.html` update is needed. This is a privilege-boundary correction inside an existing workflow, not a new headline feature.

## Acceptance Mapping

- Starting `server/index.ts` on WSL never attempts Windows portproxy/firewall repair and never depends on `FRESHELL_DISABLE_WSL_PORT_FORWARD`.
- `server/wsl-port-forward.ts` exports only the pure/manual helpers still used by the manual repair route.
- `POST /api/network/configure-firewall` returns `confirmation-required` for both `wsl2` and `windows` until the caller sends `{ confirmElevation: true }`.
- The confirmation payload copy is explicit: `To complete this, you will need to accept the Windows administrator prompt on the next screen.` A cancel path performs no elevated action.
- `SetupWizard` and `SettingsView` both use the existing accessible modal infrastructure instead of `window.confirm()`.
- Linux/macOS repair continues to return terminal commands exactly as before.
- The Windows scheduled-task template uses `LeastPrivilege`, and `WindowsServiceDaemonManager.start()` normalizes the task to limited run level before launching it.

## Scope Notes

- Keep the pure/manual WSL helpers in `server/wsl-port-forward.ts`: `getWslIp`, `getRequiredPorts`, `buildPortForwardingScript`, `buildFirewallOnlyScript`, and the rule parsers.
- Delete the synchronous `setupWslPortForwarding()` wrapper and the startup helper module entirely. They exist only to support the rejected boot-time elevation flow.
- Keep `NetworkManager` as the source of truth for `firewall.active`, `firewall.portOpen`, and `firewall.configuring`. Do not add parallel repair state.
- Keep confirmation copy sourced from the server response so both UI entry points stay consistent.
- Execution note: use `@trycycle-executing` and keep the task-level commits below intact unless a later task forces a smaller follow-up fix.

### Task 1: Remove the Boot-Time WSL Auto-Repair Entry Point

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

  expect(typeof wslModule.getWslIp).toBe('function')
  expect(typeof wslModule.getRequiredPorts).toBe('function')
  expect(typeof wslModule.buildPortForwardingScript).toBe('function')
  expect(typeof wslModule.buildFirewallOnlyScript).toBe('function')
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

In `test/unit/server/wsl-port-forward.test.ts`, delete the existing `describe('setupWslPortForwarding', ...)` block so the suite fails on the removed export instead of continuing to pin a dead API.

**Step 2: Run the targeted server tests and confirm failure**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/unit/server/wsl-port-forward.test.ts
```

Expected:
- FAIL because `server/index.ts` still imports/calls the startup helper and `server/wsl-port-forward.ts` still exports `setupWslPortForwarding()`.

**Step 3: Write the minimal implementation**

Implement these changes:

- In `server/index.ts`, delete the `shouldSetupWslPortForwardingAtStartup(...)` block and all imports from `./wsl-port-forward-startup.js` and `./wsl-port-forward.js` that existed only for startup repair.
- Replace the adjacent comment with one sentence explaining that Windows/WSL repair is exposed only through the manual network-repair API/UI.
- In `server/wsl-port-forward.ts`, delete `SetupResult`, `setupWslPortForwarding()`, and any imports/constants that become unused (`execSync` stays if still needed by pure helpers; `isWSL2` and `POWERSHELL_PATH` do not).
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
import { buildElevatedPowerShellArgs, spawnElevatedPowerShell } from '../../../server/elevated-powershell.js'

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
    { timeout: 120000 },
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
import { execFile } from 'node:child_process'

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
  callback: Parameters<typeof execFile>[3],
) {
  return execFile(command, buildElevatedPowerShellArgs(script), { timeout: 120000 }, callback)
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

### Task 4: Require Explicit API Confirmation Before Any Windows/WSL Elevation

**Files:**
- Modify: `server/network-router.ts`
- Modify: `server/firewall.ts`
- Modify: `test/integration/server/network-api.test.ts`

**Step 1: Write the failing integration tests**

In `test/integration/server/network-api.test.ts`:

- Remove `setupWslPortForwarding` from the `vi.mock('../../../server/wsl-port-forward.js', ...)` factory, because that export is gone.
- Add these four confirmation-contract tests:

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
  expect(res.body).toEqual({
    method: 'confirmation-required',
    title: 'Administrator approval required',
    body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
    confirmLabel: 'Continue',
  })
  expect(cp.execFile).not.toHaveBeenCalled()
})

it('starts WSL2 repair after explicit confirmation', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'wsl2', active: true })
  networkManager.resetFirewallCache()

  const cp = await import('node:child_process')
  vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, _cb: any) => {
    return { on: vi.fn() } as any
  })

  const res = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({ confirmElevation: true })

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ method: 'wsl2', status: 'started' })
})

it('returns confirmation-required for native Windows until the caller confirms elevation', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'windows', active: true })
  networkManager.resetFirewallCache()

  const cp = await import('node:child_process')
  const res = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({})

  expect(res.status).toBe(200)
  expect(res.body.method).toBe('confirmation-required')
  expect(cp.execFile).not.toHaveBeenCalled()
})

it('starts native Windows repair after explicit confirmation', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'windows', active: true })
  networkManager.resetFirewallCache()

  const cp = await import('node:child_process')
  vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, _cb: any) => {
    return { on: vi.fn() } as any
  })

  const res = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({ confirmElevation: true })

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ method: 'windows-elevated', status: 'started' })
})
```

**Step 2: Run the targeted integration test and confirm failure**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/integration/server/network-api.test.ts
```

Expected:
- FAIL because the route still elevates immediately and there is no `confirmation-required` response.

**Step 3: Write the minimal implementation**

In `server/network-router.ts`:

- Add a request schema:

```ts
const ConfigureFirewallRequestSchema = z.object({
  confirmElevation: z.literal(true).optional(),
})
```

- Parse `req.body ?? {}` at the top of the route and return `400` on invalid bodies.
- Add a shared constant for the confirmation response:

```ts
const WINDOWS_ELEVATION_CONFIRMATION = {
  method: 'confirmation-required',
  title: 'Administrator approval required',
  body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
  confirmLabel: 'Continue',
} as const
```

- When `status.firewall.platform` is `'wsl2'` or `'windows'` and `confirmElevation !== true`, return that payload without calling `execFile`.
- When confirmation is present, use `spawnElevatedPowerShell(...)` from `server/elevated-powershell.ts` in both the WSL and native Windows branches.
- Keep the existing `firewall.configuring` guard, cache reset, and async completion behavior.

In `server/firewall.ts`, update the Windows/WSL comments so they describe the new explicit-confirmation contract rather than unconditional elevation.

**Step 4: Re-run the targeted integration test**

Run:

```bash
npx vitest run --config vitest.server.config.ts test/integration/server/network-api.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add server/network-router.ts \
  server/firewall.ts \
  test/integration/server/network-api.test.ts
git commit -m "fix(server): require confirmation before windows elevation"
```

### Task 5: Make `ConfirmModal` Support Non-Destructive Primary Actions

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

it('renders a non-destructive primary button when confirmTone is default', () => {
  render(
    <ConfirmModal
      open
      title="Administrator approval required"
      body="To complete this, you will need to accept the Windows administrator prompt on the next screen."
      confirmLabel="Continue"
      confirmTone="default"
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
    />,
  )

  expect(screen.getByRole('button', { name: 'Continue' })).not.toHaveClass('bg-destructive')
})
```

**Step 2: Run the targeted client test and confirm failure**

Run:

```bash
npx vitest run test/unit/client/components/ui/confirm-modal.test.tsx
```

Expected:
- FAIL because `ConfirmModal` does not accept `confirmTone`.

**Step 3: Write the minimal implementation**

In `src/components/ui/confirm-modal.tsx`:

- Add `confirmTone?: 'destructive' | 'default'` to `ConfirmModalProps`.
- Default it to `'destructive'`.
- Switch the confirm button class based on that prop, keeping the existing destructive styling unchanged for current callers.

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
git commit -m "refactor(ui): allow non-destructive confirm modal actions"
```

### Task 6: Extend the Client Firewall Helper for the Confirmation Contract

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
  })

  const result = await fetchFirewallConfig()
  expect(result.method).toBe('confirmation-required')
})

it('passes confirmElevation when explicitly requested', async () => {
  vi.mocked(api.post).mockResolvedValue({ method: 'windows-elevated', status: 'started' })

  await fetchFirewallConfig({ confirmElevation: true })

  expect(api.post).toHaveBeenCalledWith('/api/network/configure-firewall', { confirmElevation: true })
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
  }
```

- Change the helper signature to:

```ts
export async function fetchFirewallConfig(
  body: { confirmElevation?: true } = {},
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
    expect(mockFetchFirewallConfig).toHaveBeenNthCalledWith(2, { confirmElevation: true })
  })
})

it('does nothing when the user cancels the admin-approval modal', async () => {
  mockFetchFirewallConfig.mockResolvedValue({
    method: 'confirmation-required',
    title: 'Administrator approval required',
    body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
    confirmLabel: 'Continue',
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

In `test/e2e/network-setup.test.tsx`, add a wizard-path flow that asserts the confirmation dialog appears before the second firewall request is sent.

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
- On the first `fetchFirewallConfig()` call, if the result is `confirmation-required`, open `ConfirmModal` with the returned `title`, `body`, and `confirmLabel`, using `confirmTone="default"`.
- On confirm, call `fetchFirewallConfig({ confirmElevation: true })` and then reuse the existing WSL/Windows polling path.
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
    expect(mockFetchFirewallConfig).toHaveBeenNthCalledWith(2, { confirmElevation: true })
  })
})

it('does not re-issue the firewall request when the modal is cancelled', async () => {
  mockFetchFirewallConfig.mockResolvedValue({
    method: 'confirmation-required',
    title: 'Administrator approval required',
    body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
    confirmLabel: 'Continue',
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

In `test/e2e/network-setup.test.tsx`, extend the settings flow so it also checks for the confirmation modal before the second request.

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
- On the first `fetchFirewallConfig()` call, if the result is `confirmation-required`, open `ConfirmModal` with `confirmTone="default"`.
- On confirm, call `fetchFirewallConfig({ confirmElevation: true })`, then reuse the existing follow-up behavior:
  - open a terminal tab for `terminal`
  - schedule `fetchNetworkStatus()` for `wsl2` / `windows-elevated`
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
- Keep all `Start-Process ... -Verb RunAs` quoting in `server/elevated-powershell.ts`.
- Remove stale comments that still describe startup auto-repair, boot-only suppression env vars, or unconditional Windows elevation.

Do not add new settings, feature flags, or fallback script flows.

**Step 2: Run the broader targeted matrix**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.test.ts \
  test/integration/server/network-api.test.ts \
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
```

Expected:
- PASS

If the executor is rebasing or fast-forwarding this branch into `main` in the same session, run `npm test` immediately before the final fast-forward to satisfy repo policy.

**Step 4: Commit the final polish**

```bash
git add server/index.ts \
  server/wsl-port-forward.ts \
  server/elevated-powershell.ts \
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
- `server/wsl-port-forward.ts` no longer exports `setupWslPortForwarding`.
- `server/wsl-port-forward-startup.ts` is gone.
- `POST /api/network/configure-firewall` has exactly three manual behaviors:
  - `terminal` for Linux/macOS
  - `confirmation-required` until explicit confirmation on Windows/WSL
  - `wsl2` / `windows-elevated` after explicit confirmation
- `installers/windows/freshell-task.xml.template` contains `LeastPrivilege`.

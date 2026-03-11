# Windows Privilege Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Eliminate surprise Windows privilege escalation during startup and tests, keep manual Windows/WSL firewall repair in-product behind an explicit confirmation step, and force the Windows daemon task to run at least privilege.

**Architecture:** Remove the WSL startup auto-repair path entirely and delete the now-obsolete synchronous `setupWslPortForwarding()` wrapper, so server boot no longer crosses the Windows privilege boundary or leaves a dormant self-elevating API behind. Keep the existing manual repair affordances in `SetupWizard` and `SettingsView`, but make the privilege jump explicit at both layers: the API must return a safe `confirmation-required` response until the caller sends an explicit confirmation flag, and the UI must show an accessible modal before it sends that second request. For Electron daemon mode, make least privilege part of both the scheduled-task template and the runtime task-management code so new installs and future starts cannot request `HighestAvailable`.

**Tech Stack:** TypeScript, Express, React/Redux, Vitest, supertest, Electron scheduled-task management

---

## Strategy Gate

- The actual defect is not “tests need a better env flag”; it is that `server/index.ts` performs privileged Windows repair during normal boot. Delete that behavior instead of adding more suppression layers around it.
- Once the boot-time caller is gone, delete `setupWslPortForwarding()` too. It exists only for that boot path; leaving it exported would preserve a dead self-elevating footgun for no product value.
- Keep manual Windows/WSL repair in-product. The user explicitly wants a one-click flow, so do not replace it with copy-paste scripts or external shell instructions.
- Put the privilege boundary on both sides of the API. UI confirmation alone is not sufficient because a future caller could still hit `/api/network/configure-firewall` directly; server-side explicit confirmation is required as a backstop.
- Reuse the existing repair surfaces in `src/components/SetupWizard.tsx` and `src/components/SettingsView.tsx`. Do not add a third startup-only banner or wizard path for this issue.
- Centralize the `Start-Process ... -Verb RunAs` quoting/spawn logic in one helper. The current WSL and native Windows branches duplicate the most failure-prone code in `server/network-router.ts`.
- Treat the Windows daemon task as a definition-management problem, not a documentation problem. The task XML and the code that starts the task must both enforce limited run level.
- No `docs/index.html` update is needed. This change tightens an existing network-repair workflow; it does not add a new top-level product capability.

## Acceptance Mapping

- Launching `server/index.ts` on WSL with `host === '0.0.0.0'` never triggers a Windows UAC prompt.
- The obsolete startup-only WSL suppression path (`server/wsl-port-forward-startup.ts`, `FRESHELL_DISABLE_WSL_PORT_FORWARD`, and the sync `setupWslPortForwarding()` wrapper) is removed, so no dormant boot-only elevation helper remains.
- `POST /api/network/configure-firewall` never spawns an elevated Windows process unless the request explicitly confirms elevation.
- Clicking `Fix` in Settings or `Configure now` in the setup wizard on Windows/WSL first shows an accessible modal that warns the user an administrator approval dialog is coming next; cancelling performs no elevated action.
- Linux/macOS firewall repair continues to return terminal commands exactly as before.
- Windows daemon scheduled tasks are created with `LeastPrivilege`, and the daemon manager normalizes existing tasks to limited run level before starting them.

## Scope Notes

- Keep `server/wsl-port-forward.ts` as the home for the pure/manual WSL repair helpers (`getWslIp`, `getRequiredPorts`, script builders, rule parsers). Delete the sync `setupWslPortForwarding()` wrapper because the manual API route does not use it.
- Keep `NetworkManager` as the source of truth for whether repair is needed (`firewall.platform`, `firewall.portOpen`, `firewall.configuring`). Do not add a separate “pending Windows repair” state machine.
- Do not change the share-panel routing in `src/lib/share-utils.ts` for this issue. The problem being fixed is unsolicited elevation, not broader remote-access diagnosis UX.

### Task 1: Remove Boot-Time WSL Elevation and Delete the Obsolete Auto-Repair Wrapper

**Files:**
- Delete: `server/wsl-port-forward-startup.ts`
- Delete: `test/unit/server/wsl-port-forward-startup.test.ts`
- Modify: `server/index.ts`
- Modify: `server/wsl-port-forward.ts`
- Modify: `test/integration/server/wsl-port-forward.test.ts`
- Modify: `test/integration/server/logger.separation.harness.ts`
- Modify: `test/integration/server/logger.separation.harness.test.ts`
- Modify: `test/unit/server/wsl-port-forward.test.ts`
- Modify: `test/e2e-browser/helpers/test-server.ts`

**Step 1: Write the failing safety tests**

In `test/integration/server/wsl-port-forward.test.ts`, rewrite the existing export/startup assertions into two regression checks:

```ts
it('wsl-port-forward exports only the pure helper surface used by manual repair', async () => {
  const wslModule = await import('../../../server/wsl-port-forward.js')
  expect(typeof wslModule.getWslIp).toBe('function')
  expect(typeof wslModule.getRequiredPorts).toBe('function')
  expect(typeof wslModule.buildPortForwardingScript).toBe('function')
  expect(typeof wslModule.buildFirewallOnlyScript).toBe('function')
  expect('setupWslPortForwarding' in wslModule).toBe(false)
})

it('server/index.ts no longer imports or calls the startup-only WSL helper', () => {
  const indexPath = path.resolve(__dirname, '../../../server/index.ts')
  const indexContent = fs.readFileSync(indexPath, 'utf-8')

  expect(indexContent).not.toContain("from './wsl-port-forward-startup.js'")
  expect(indexContent).not.toContain('setupWslPortForwarding(')
  expect(indexContent).not.toContain('shouldSetupWslPortForwardingAtStartup')
})
```

In `test/integration/server/logger.separation.harness.test.ts`, replace the env-default assertions with:

```ts
it('does not inject a startup-only WSL port-forward suppression env var', () => {
  const childEnv = buildServerProcessEnv({}, {})
  expect(childEnv.FRESHELL_DISABLE_WSL_PORT_FORWARD).toBeUndefined()
})
```

**Step 2: Run the targeted server tests and confirm failure**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.test.ts
```

Expected:
- FAIL because `server/index.ts` still imports/calls the startup helper, `wsl-port-forward.ts` still exports `setupWslPortForwarding`, and the logger harness still injects `FRESHELL_DISABLE_WSL_PORT_FORWARD`.

**Step 3: Remove the boot-time caller, dead env suppression, and dead wrapper**

Implement these changes:

- In `server/index.ts`, delete the entire `shouldSetupWslPortForwardingAtStartup(...)` block and the related imports.
- Update the nearby comment to explain that WSL repair is surfaced through the manual network repair API/UI, not automatic at boot.
- In `server/wsl-port-forward.ts`, delete `SetupResult`, `setupWslPortForwarding()`, and any imports/constants that become unused (`execSync`, `isWSL2`, `POWERSHELL_PATH`). Keep the pure helper functions used by the manual route and unit tests.
- Delete `server/wsl-port-forward-startup.ts` and `test/unit/server/wsl-port-forward-startup.test.ts`.
- In `test/integration/server/logger.separation.harness.ts`, remove the `delete childEnv.FRESHELL_DISABLE_WSL_PORT_FORWARD` / default-to-`1` logic entirely.
- In `test/unit/server/wsl-port-forward.test.ts`, remove the `setupWslPortForwarding` import and the entire `describe('setupWslPortForwarding', ...)` block now that the wrapper no longer exists.
- In `test/e2e-browser/helpers/test-server.ts`, keep the local bind override if it still helps test isolation, but update the comment so it no longer claims startup UAC is expected.

**Step 4: Re-run the targeted tests**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/unit/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add server/index.ts \
  server/wsl-port-forward.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/logger.separation.harness.ts \
  test/integration/server/logger.separation.harness.test.ts \
  test/unit/server/wsl-port-forward.test.ts \
  test/e2e-browser/helpers/test-server.ts
git rm server/wsl-port-forward-startup.ts test/unit/server/wsl-port-forward-startup.test.ts
git commit -m "refactor(server): remove WSL auto-repair at startup"
```

### Task 2: Require Explicit API Confirmation Before Any Windows/WSL Elevation

**Files:**
- Create: `server/elevated-powershell.ts`
- Create: `test/unit/server/elevated-powershell.test.ts`
- Modify: `server/network-router.ts`
- Modify: `server/firewall.ts`
- Modify: `test/integration/server/network-api.test.ts`

**Step 1: Write the failing server tests**

In `test/integration/server/network-api.test.ts`, add both WSL and native Windows confirmation tests:

```ts
it('returns confirmation-required for WSL2 until the caller confirms elevation', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'wsl2', active: true })
  networkManager.resetFirewallCache()

  const res = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({})

  expect(res.status).toBe(200)
  expect(res.body).toMatchObject({
    method: 'confirmation-required',
    confirmLabel: 'Continue',
  })

  const cp = await import('node:child_process')
  expect(cp.execFile).not.toHaveBeenCalled()
})

it('starts native Windows firewall repair only after explicit confirmation', async () => {
  vi.mocked(detectFirewall).mockResolvedValue({ platform: 'windows', active: true })
  networkManager.resetFirewallCache()

  const cp = await import('node:child_process')
  vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
    return { on: vi.fn() } as any
  })

  const res = await request(app)
    .post('/api/network/configure-firewall')
    .set('x-auth-token', token)
    .send({ confirmElevation: true })

  expect(res.status).toBe(200)
  expect(res.body.method).toBe('windows-elevated')
})
```

Add `test/unit/server/elevated-powershell.test.ts` to pin the quoting/spawn contract:

```ts
it('wraps a script in Start-Process -Verb RunAs with single-quote escaping', () => {
  expect(buildElevatedPowerShellArgs("Write-Host 'hi'")).toEqual([
    '-Command',
    "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', 'Write-Host ''hi'''",
  ])
})
```

**Step 2: Run the targeted server tests and confirm failure**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/network-api.test.ts \
  test/unit/server/elevated-powershell.test.ts
```

Expected:
- FAIL because the route currently elevates immediately and there is no reusable elevated-PowerShell helper.

**Step 3: Implement the explicit confirmation contract and shared helper**

Create `server/elevated-powershell.ts` with a small, testable API:

```ts
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
  cb: Parameters<typeof execFile>[3],
) {
  return execFile(command, buildElevatedPowerShellArgs(script), { timeout: 120000 }, cb)
}
```

In `server/network-router.ts`:

- Add a `ConfigureFirewallRequestSchema` with `confirmElevation: z.literal(true).optional()`.
- When `status.firewall.platform` is `'wsl2'` or `'windows'` and `confirmElevation !== true`, return:

```ts
res.json({
  method: 'confirmation-required',
  title: 'Administrator approval required',
  body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
  confirmLabel: 'Continue',
})
```

- When confirmation is present, delegate the spawn to `spawnElevatedPowerShell(...)` instead of duplicating the `Start-Process ... -Verb RunAs` string in each branch.
- Keep the existing `firewall.configuring` guard, cache reset, and polling semantics.

In `server/firewall.ts`, update the Windows/WSL comments so they describe the new explicit-confirmation contract rather than “the route spawns elevated PowerShell async” unconditionally.

**Step 4: Re-run the targeted tests**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/network-api.test.ts \
  test/unit/server/elevated-powershell.test.ts
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add server/elevated-powershell.ts \
  server/network-router.ts \
  server/firewall.ts \
  test/unit/server/elevated-powershell.test.ts \
  test/integration/server/network-api.test.ts
git commit -m "refactor(server): require confirmation before windows elevation"
```

### Task 3: Add the Pre-UAC Confirmation Modal to SetupWizard and SettingsView

**Files:**
- Modify: `src/lib/firewall-configure.ts`
- Modify: `src/components/ui/confirm-modal.tsx`
- Modify: `src/components/SetupWizard.tsx`
- Modify: `src/components/SettingsView.tsx`
- Modify: `test/unit/client/lib/firewall-configure.test.ts`
- Create: `test/unit/client/components/ui/confirm-modal.test.tsx`
- Modify: `test/unit/client/SetupWizard.test.tsx`
- Modify: `test/unit/client/components/SettingsView.network-access.test.tsx`
- Modify: `test/e2e/network-setup.test.tsx`

**Step 1: Write the failing client tests**

In `test/unit/client/lib/firewall-configure.test.ts`, extend the union coverage:

```ts
it('passes confirmElevation when explicitly requested', async () => {
  vi.mocked(api.post).mockResolvedValue({ method: 'windows-elevated', status: 'started' })
  await fetchFirewallConfig({ confirmElevation: true })
  expect(api.post).toHaveBeenCalledWith('/api/network/configure-firewall', { confirmElevation: true })
})
```

Create `test/unit/client/components/ui/confirm-modal.test.tsx` with a regression test for the shared modal API:

```tsx
it('renders a non-destructive primary confirm button when confirmTone is default', () => {
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

  // ...render step 2 with a WSL2 blocked firewall...
  fireEvent.click(screen.getByRole('button', { name: /configure firewall/i }))

  expect(await screen.findByRole('dialog', { name: /administrator approval required/i })).toBeInTheDocument()
  expect(mockFetchFirewallConfig).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('button', { name: /continue/i }))

  await waitFor(() => {
    expect(mockFetchFirewallConfig).toHaveBeenNthCalledWith(2, { confirmElevation: true })
  })
})
```

In `test/unit/client/components/SettingsView.network-access.test.tsx`, add both confirm and cancel coverage for the `Fix` button on a Windows or WSL2 status.

In `test/e2e/network-setup.test.tsx`, add one high-level flow that exercises the real Settings/SetupWizard render path and verifies the confirmation modal appears before the elevated request is re-issued.

**Step 2: Run the targeted client tests and confirm failure**

Run:

```bash
npx vitest run \
  test/unit/client/lib/firewall-configure.test.ts \
  test/unit/client/components/ui/confirm-modal.test.tsx \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
```

Expected:
- FAIL because the client helper does not accept a confirmation payload, the route result type does not include `confirmation-required`, and neither UI flow renders a confirmation modal.

**Step 3: Implement the shared client-side confirmation flow**

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
  return api.post('/api/network/configure-firewall', body)
}
```

In `src/components/ui/confirm-modal.tsx`, add a `confirmTone?: 'destructive' | 'default'` prop so the Windows admin prompt can use a primary button instead of the current destructive red button. Keep `'destructive'` as the default so delete/close flows do not regress.

In both `src/components/SetupWizard.tsx` and `src/components/SettingsView.tsx`:

- On the first `fetchFirewallConfig()` call, if the result is `confirmation-required`, open `ConfirmModal` with the returned title/body/confirmLabel.
- Pass `confirmTone="default"` for this admin-approval flow; destructive styling is the wrong signal for “continue to the UAC prompt”.
- On confirm, re-issue `fetchFirewallConfig({ confirmElevation: true })` and continue the existing terminal/polling behavior.
- On cancel, clear the modal state and do nothing else.
- Preserve the current Linux/macOS terminal-command flow unchanged.

Important detail:
- Do not use `window.confirm()`. Use the existing accessible modal infrastructure so focus trapping, `Escape`, and screen-reader labeling remain correct.

**Step 4: Re-run the targeted client tests**

Run:

```bash
npx vitest run \
  test/unit/client/lib/firewall-configure.test.ts \
  test/unit/client/components/ui/confirm-modal.test.tsx \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
```

Expected:
- PASS

**Step 5: Commit**

```bash
git add src/lib/firewall-configure.ts \
  src/components/ui/confirm-modal.tsx \
  src/components/SetupWizard.tsx \
  src/components/SettingsView.tsx \
  test/unit/client/lib/firewall-configure.test.ts \
  test/unit/client/components/ui/confirm-modal.test.tsx \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/e2e/network-setup.test.tsx
git commit -m "feat(ui): confirm windows elevation before firewall repair"
```

### Task 4: Enforce Least Privilege for the Windows Daemon Scheduled Task

**Files:**
- Modify: `installers/windows/freshell-task.xml.template`
- Modify: `electron/daemon/windows-service.ts`
- Modify: `test/unit/electron/daemon/windows-service.test.ts`

**Step 1: Write the failing Electron tests**

In `test/unit/electron/daemon/windows-service.test.ts`, add:

```ts
it('writes a least-privilege task definition', async () => {
  setupExecFileSuccess()
  await manager.install(testPaths, 3001)
  const writtenContent = mockWriteFile.mock.calls[0][1] as string
  expect(writtenContent).toContain('<RunLevel>LeastPrivilege</RunLevel>')
  expect(writtenContent).not.toContain('<RunLevel>HighestAvailable</RunLevel>')
})

it('normalizes an installed task to LIMITED before starting it', async () => {
  setupExecFileSuccess()
  await manager.start()

  expect(mockExecFile.mock.calls[0][0]).toBe('schtasks')
  expect(mockExecFile.mock.calls[0][1]).toEqual(expect.arrayContaining(['/Change', '/TN', 'Freshell Server', '/RL', 'LIMITED']))
  expect(mockExecFile.mock.calls[1][1]).toEqual(expect.arrayContaining(['/Run', '/TN', 'Freshell Server']))
})
```

**Step 2: Run the targeted Electron test and confirm failure**

Run:

```bash
npx vitest run --config vitest.electron.config.ts test/unit/electron/daemon/windows-service.test.ts
```

Expected:
- FAIL because the template still requests `HighestAvailable` and `start()` does not normalize the run level.

**Step 3: Implement least-privilege task creation and migration**

Implement these changes:

- In `installers/windows/freshell-task.xml.template`, change:

```xml
<RunLevel>HighestAvailable</RunLevel>
```

to:

```xml
<RunLevel>LeastPrivilege</RunLevel>
```

- In `electron/daemon/windows-service.ts`, add a private helper such as:

```ts
private async ensureLeastPrivilege(): Promise<void> {
  await execFilePromise('schtasks', ['/Change', '/TN', TASK_NAME, '/RL', 'LIMITED'])
}
```

- Call `ensureLeastPrivilege()` after `/Create` in `install()` and before `/Run` in `start()`.
- Keep the helper scoped to the Windows manager; do not widen the cross-platform `DaemonManager` interface for this one Windows-only policy.

**Step 4: Re-run the targeted Electron test**

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
git commit -m "fix(electron): run windows daemon task with least privilege"
```

### Task 5: Refactor Comments, Run Broader Verification, and Land the Cutover

**Files:**
- Modify only files already touched in Tasks 1-4

**Step 1: Refactor for clarity only where it reduces future privilege regressions**

- Keep all Windows UAC copy in one place: the server response for `confirmation-required`.
- Keep the PowerShell quoting in `server/elevated-powershell.ts` only.
- Remove any stale comments that still describe startup auto-repair or unconditional Windows elevation.

Do not add new settings, feature flags, or alternate repair flows.

**Step 2: Run the broader targeted matrix**

Run:

```bash
npx vitest run --config vitest.server.config.ts \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/network-api.test.ts \
  test/unit/server/wsl-port-forward.test.ts \
  test/unit/server/elevated-powershell.test.ts
```

Expected:
- PASS

Run:

```bash
npx vitest run \
  test/unit/client/lib/firewall-configure.test.ts \
  test/unit/client/components/ui/confirm-modal.test.tsx \
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

If the executor is rebasing/merging this branch to `main` in the same session, rerun `npm test` immediately before the final fast-forward to satisfy repo policy.

**Step 4: Commit the final polish**

```bash
git add server/index.ts \
  server/wsl-port-forward.ts \
  server/elevated-powershell.ts \
  server/network-router.ts \
  server/firewall.ts \
  src/lib/firewall-configure.ts \
  src/components/ui/confirm-modal.tsx \
  src/components/SetupWizard.tsx \
  src/components/SettingsView.tsx \
  electron/daemon/windows-service.ts \
  installers/windows/freshell-task.xml.template \
  test/integration/server/wsl-port-forward.test.ts \
  test/integration/server/network-api.test.ts \
  test/integration/server/logger.separation.harness.ts \
  test/integration/server/logger.separation.harness.test.ts \
  test/unit/server/wsl-port-forward.test.ts \
  test/unit/server/elevated-powershell.test.ts \
  test/unit/client/lib/firewall-configure.test.ts \
  test/unit/client/components/ui/confirm-modal.test.tsx \
  test/unit/client/SetupWizard.test.tsx \
  test/unit/client/components/SettingsView.network-access.test.tsx \
  test/unit/electron/daemon/windows-service.test.ts \
  test/e2e/network-setup.test.tsx \
  test/e2e-browser/helpers/test-server.ts
git commit -m "fix(windows): tighten privilege boundaries for network repair"
```

**Step 5: Final sanity check before handoff**

- `git status --short` must be clean.
- Confirm the deleted startup helper files are gone.
- Confirm `server/wsl-port-forward.ts` no longer exports `setupWslPortForwarding`.
- Confirm `installers/windows/freshell-task.xml.template` contains `LeastPrivilege`.
- Confirm `/api/network/configure-firewall` has exactly three manual behaviors:
  - `terminal` for Linux/macOS
  - `confirmation-required` until explicit confirmation on Windows/WSL
  - `wsl2` / `windows-elevated` after explicit confirmation

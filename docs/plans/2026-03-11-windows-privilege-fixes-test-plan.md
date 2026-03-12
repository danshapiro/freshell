# Windows Privilege Fixes Test Plan

Date: 2026-03-11  
Implementation plan: `/home/user/code/freshell/.worktrees/trycycle-windows-privilege-fixes/docs/plans/2026-03-11-windows-privilege-fixes.md`

## Strategy reconciliation

No approval required. The approved strategy still fits the implementation plan and the current repo:

- The plan stays inside existing Vitest harnesses for jsdom, node, and electron. It does not require paid services, external infrastructure, or a live Windows runner.
- The highest-value scenario coverage is the two-step manual repair UX in `SetupWizard` and `SettingsView`; the existing `test/e2e/network-setup.test.tsx` harness is the right scenario harness for that flow.
- Startup safety is better verified as a regression/integration surface than as live UAC automation. The implementation deletes the startup elevation path entirely, so the strongest tests are source-surface assertions, pure WSL planning tests, and child-process env regression checks.

## Named sources of truth

- `Transcript`: the approved 2026-03-11 trycycle conversation, especially the user-approved decisions to remove startup auto-elevation, require explicit pre-UAC confirmation with accept/cancel copy, keep manual repair in-product, and run daemon tasks at least privilege.
- `Plan-SG`: `docs/plans/2026-03-11-windows-privilege-fixes.md`, sections `Strategy Gate` and `Scope Notes`.
- `Plan-AM`: `docs/plans/2026-03-11-windows-privilege-fixes.md`, section `Acceptance Mapping`.
- `Plan-T1` through `Plan-T5`: the task sections in `docs/plans/2026-03-11-windows-privilege-fixes.md`.
- `Client repair contract`: the documented contract in `src/lib/firewall-configure.ts` describing the existing `terminal`, `wsl2` / `windows-elevated`, and `none` flows that must stay intact where the implementation plan says behavior is unchanged.

## Harness requirements

### H1: Network UI scenario harness

- What it does: renders `SetupWizard` and `SettingsView` with real reducers and mocked repair/network APIs so the tests can drive clicks, confirmation modals, polling, and terminal-tab side effects.
- What it exposes: `render()` with Redux stores, accessible role/text queries, request-call inspection for `fetchFirewallConfig`, and status-poll inspection through mocked `fetchNetworkStatus`.
- Estimated complexity: low. `test/unit/client/SetupWizard.test.tsx`, `test/unit/client/components/settings-view-test-utils.tsx`, and `test/e2e/network-setup.test.tsx` already exist and only need extension.
- Tests that depend on it: 1, 2, 3, 4.

### H2: Network API integration harness

- What it does: mounts the real Express network router with auth middleware and a real `NetworkManager`, while mocking OS-specific helpers (`detectFirewall`, `computeWslPortForwardingPlan`, `execFile`).
- What it exposes: HTTP responses, request-body validation, `firewall.configuring` behavior through router responses, and verification that no elevated child process is spawned before confirmation.
- Estimated complexity: low-medium. `test/integration/server/network-api.test.ts` already provides the app, auth token, and `NetworkManager`.
- Tests that depend on it: 6, 7, 8, 9, 12.

### H3: WSL planning and startup-regression harness

- What it does: exercises the pure WSL planning helper and the startup/test-launch regression surfaces without requiring a real WSL/Windows environment.
- What it exposes: `computeWslPortForwardingPlan(...)` outputs, module-export surface checks for `server/wsl-port-forward.ts`, source-surface checks for `server/index.ts`, and child-env inspection through `buildServerProcessEnv(...)`.
- Estimated complexity: low. `test/unit/server/wsl-port-forward.test.ts`, `test/integration/server/wsl-port-forward.test.ts`, and `test/integration/server/logger.separation.harness.test.ts` already exist.
- Tests that depend on it: 10, 11.

### H4: Electron daemon harness

- What it does: mocks `child_process.execFile` and filesystem writes for `WindowsServiceDaemonManager`, then exercises `runStartup(...)` with mocked daemon-manager state.
- What it exposes: written task XML, scheduled-task command sequences, and startup orchestration behavior when daemon mode is selected.
- Estimated complexity: low. `test/unit/electron/daemon/windows-service.test.ts` and `test/unit/electron/startup.test.ts` already exist.
- Tests that depend on it: 5, 13.

### H5: Small unit contract harnesses

- What it does: uses plain Vitest mocks/jsdom renders for the new shared contracts that are too fragile to leave unguarded: confirmation button variants, client request forwarding, and elevated PowerShell argument construction.
- What it exposes: button class/variant assertions, `api.post(...)` payload inspection, and `execFile(...)` argv/timeout inspection.
- Estimated complexity: low. These are single-module tests with no new infrastructure.
- Tests that depend on it: 14, 15, 16.

## Test plan

1. Name: Setup Wizard requires explicit approval before starting WSL repair and completes the happy path
   Type: scenario
   Harness: H1
   Preconditions: `network.status` is already remote-enabled on WSL2, firewall is active with `portOpen: false`, and the mocked repair API returns `confirmation-required` on the first call and `{ method: 'wsl2', status: 'started' }` on the confirmed call. Mocked `fetchNetworkStatus()` eventually returns `firewall.configuring: false` and `portOpen: true`.
   Actions:
   1. Render `SetupWizard` at step 2.
   2. Click `Configure now`.
   3. Observe the admin-approval modal.
   4. Click `Continue`.
   5. Let the polling loop finish with `portOpen: true`.
   Expected outcome:
   - The first click opens an accessible modal titled `Administrator approval required` with the approved body copy and `Continue` plus `Cancel`; there is no second repair request yet. Sources: `Transcript`, `Plan-AM`, `Plan-T4`.
   - The second repair request is `fetchFirewallConfig({ confirmElevation: true, confirmationToken: '<token from first response>' })`. Sources: `Plan-AM`, `Plan-T3`, `Plan-T4`.
   - The wizard reports firewall progress only after confirmed elevation and ends in a success state once polling sees `configuring: false` and `portOpen: true`. Sources: `Plan-AM`, `Plan-T2`, `Plan-T4`.
   Interactions: `SetupWizard` <> `fetchFirewallConfig`, `SetupWizard` <> `fetchNetworkStatus`, modal layering over the wizard, Redux `network` state updates.

2. Name: Setup Wizard cancel path does not trigger elevation
   Type: scenario
   Harness: H1
   Preconditions: Same as test 1, except the mocked repair API only returns `confirmation-required`.
   Actions:
   1. Render `SetupWizard` at step 2.
   2. Click `Configure now`.
   3. Click `Cancel` in the admin-approval modal.
   Expected outcome:
   - The confirmation modal is shown before any confirmed repair begins. Sources: `Transcript`, `Plan-AM`, `Plan-T4`.
   - The repair API is called exactly once, no `{ confirmElevation: true, confirmationToken }` request is sent, and no firewall polling starts. Sources: `Plan-AM`, `Plan-T2`, `Plan-T4`.
   Interactions: `SetupWizard` <> `ConfirmModal`, `SetupWizard` <> repair API call-count boundary.

3. Name: Settings view requires explicit approval before starting native Windows firewall repair
   Type: scenario
   Harness: H1
   Preconditions: `network.status.host` is `0.0.0.0`, firewall platform is `windows`, `portOpen: false`, and the mocked repair API returns `confirmation-required` first and `{ method: 'windows-elevated', status: 'started' }` after confirmation.
   Actions:
   1. Render `SettingsView`.
   2. Click `Fix`.
   3. Observe the admin-approval modal.
   4. Click `Continue`.
   Expected outcome:
   - The first click shows the same approval copy and actions as the wizard flow. Sources: `Transcript`, `Plan-AM`, `Plan-T4`.
   - The confirmed request sends `{ confirmElevation: true, confirmationToken: '<token from first response>' }` and follows the existing Windows server-handled completion path by scheduling a status refresh instead of opening a terminal. Sources: `Plan-AM`, `Plan-T3`, `Plan-T4`, `Client repair contract`.
   Interactions: `SettingsView` <> `fetchFirewallConfig`, `SettingsView` <> `fetchNetworkStatus`, modal rendering inside an already-mounted settings view.

4. Name: Linux and macOS firewall repair stays on the existing terminal-command path
   Type: scenario
   Harness: H1
   Preconditions: `network.status.host` is `0.0.0.0`, firewall platform is `linux-ufw`, `linux-firewalld`, or `macos`, and the mocked repair API returns `{ method: 'terminal', command: '...' }`.
   Actions:
   1. Render `SettingsView` and click `Fix`.
   2. Repeat the same flow from `SetupWizard` by clicking `Configure now`.
   Expected outcome:
   - Neither UI shows the Windows admin-approval modal for terminal-command platforms. Sources: `Plan-AM`, `Plan-T4`.
   - Both UIs stay on the pre-existing terminal flow by routing the returned command into the terminal-pane entry point. Sources: `Plan-AM`, `Plan-SG`, `Client repair contract`.
   Interactions: UI repair entry points <> terminal-tab creation, UI repair entry points <> platform-specific result branching.

5. Name: Desktop startup in daemon mode still starts a stopped daemon after the least-privilege change
   Type: scenario
   Harness: H4
   Preconditions: `runStartup(...)` is invoked with `desktopConfig.serverMode === 'daemon'`, daemon status is `{ installed: true, running: false }`, and the daemon-manager mock resolves successfully.
   Actions:
   1. Call `runStartup(...)`.
   2. Observe the daemon-manager interactions and the returned startup result.
   Expected outcome:
   - Startup still calls `daemonManager.start()` when the daemon is installed but not running. Sources: `Plan-T5`.
   - Startup still returns the main-window path rather than failing because of the least-privilege normalization change. Sources: `Plan-T5`.
   Interactions: desktop startup orchestration <> daemon-manager state, daemon start decision <> browser window creation.

6. Name: WSL configure-firewall first call returns confirmation-required and does not spawn elevation
   Type: integration
   Harness: H2
   Preconditions: `detectFirewall()` reports `{ platform: 'wsl2', active: true }`; `computeWslPortForwardingPlan(...)` returns `{ status: 'ready', scriptKind: 'full', ... }`; the network manager cache is reset.
   Actions:
   1. POST `/api/network/configure-firewall` with an empty JSON body.
   2. Inspect the HTTP response and the mocked `execFile` calls.
   3. Re-read network status if needed to observe `firewall.configuring`.
   Expected outcome:
   - The route returns `{ method: 'confirmation-required', title, body, confirmLabel, confirmationToken }` with the approved copy and a server-issued token. Sources: `Transcript`, `Plan-AM`, `Plan-T2`.
   - No elevated child process is spawned and `firewall.configuring` is not consumed by the pre-confirmation response. Sources: `Plan-AM`, `Plan-T2`.
   Interactions: router <> `NetworkManager`, router <> WSL planning helper, router <> child-process boundary.

7. Name: WSL confirmation is recomputed and short-circuits to none when repair is no longer needed
   Type: boundary
   Harness: H2
   Preconditions: `detectFirewall()` reports WSL2. The first planning call can report `ready`, but the confirmed call recomputes to `{ status: 'noop', wslIp: '...' }`.
   Actions:
   1. POST `/api/network/configure-firewall` with `{}` and capture `confirmationToken`.
   2. POST `/api/network/configure-firewall` with `{ confirmElevation: true, confirmationToken }`.
   3. Inspect the response and process-spawn side effects.
   Expected outcome:
   - The route returns `{ method: 'none', message: 'No configuration changes required' }` when the recomputed plan is already satisfied. Sources: `Plan-AM`, `Plan-T2`.
   - No elevated child process is spawned and `firewall.configuring` stays false in this boundary case. Sources: `Plan-AM`, `Plan-T2`.
   Interactions: confirmation route <> pure WSL planning helper, race between user confirmation and current network state.

8. Name: Native Windows configure-firewall follows the same two-call confirmation contract
   Type: integration
   Harness: H2
   Preconditions: `detectFirewall()` reports `{ platform: 'windows', active: true }`; firewall commands are present; mocked `execFile` can record a started child process.
   Actions:
   1. POST `/api/network/configure-firewall` with `{}`.
   2. POST `/api/network/configure-firewall` with `{ confirmElevation: true, confirmationToken: '<token from step 1>' }`.
   Expected outcome:
   - The first response is `confirmation-required`, not `windows-elevated`. Sources: `Transcript`, `Plan-AM`, `Plan-T2`.
   - The confirmed response is `{ method: 'windows-elevated', status: 'started' }` and only then may the server mark firewall configuration as in progress. Sources: `Plan-AM`, `Plan-T2`.
   Interactions: router <> Windows firewall command list, router <> shared elevated PowerShell helper.

9. Name: Configure-firewall rotates tokens, rejects malformed confirmation bodies, and preserves the confirmed in-progress guard
   Type: boundary
   Harness: H2
   Preconditions: Authenticated router harness is mounted. For the guard case, the first confirmed request can hold the single-flight lock long enough for a concurrent second confirmed request to arrive.
   Actions:
   1. POST `/api/network/configure-firewall` with `{ confirmElevation: false }`.
   2. POST `/api/network/configure-firewall` with `{}` twice and keep both returned tokens.
   3. Retry with the superseded first token after the second token has been issued.
   4. Launch two concurrent confirmed retries with the still-current token.
   Expected outcome:
   - `{ confirmElevation: false }` is rejected with `400` and `error: 'Invalid request'`. Sources: `Plan-AM`, `Plan-T2`.
   - The first token is rejected after the second token is issued, and the route returns a fresh `confirmation-required` response instead of elevating. Sources: `Plan-AM`, `Plan-T1`, `Plan-T2`.
   - Of the two concurrent confirmed retries that both passed pre-lock validation, one returns started and the other returns `409 { method: 'in-progress' }`. Sources: `Plan-AM`, `Plan-T1`, `Plan-T2`.
   Interactions: request-body validation <> router branching, confirmation-token rotation <> router protocol, router <> confirmed single-flight lock.

10. Name: Pure WSL planning covers not-wsl2, detection failure, no-op, firewall-only drift, and full repair drift
    Type: integration
    Harness: H3
    Preconditions: The `execSync` and `isWSL2()` collaborators are mockable, and representative command output exists for current IP, existing portproxy rules, and existing firewall rules.
    Actions:
    1. Call `computeWslPortForwardingPlan(...)` with `isWSL2() === false`.
    2. Call it with WSL2 enabled but no detectable IP.
    3. Call it with matching rules/firewall.
    4. Call it with only firewall drift.
    5. Call it with missing or wrong portproxy rules.
    Expected outcome:
    - The helper returns `status: 'not-wsl2'`, `status: 'error'`, `status: 'noop'`, `status: 'ready'` with `scriptKind: 'firewall-only'`, and `status: 'ready'` with `scriptKind: 'full'` for the respective cases. Sources: `Plan-AM`, `Plan-T5`.
    - No case in this helper path executes elevation directly; it only computes the plan and normalized script. Sources: `Plan-SG`, `Plan-T5`.
    Interactions: pure WSL plan helper <> shell-command parsing, drift detection across portproxy and firewall state.

11. Name: Startup and spawned-test launches no longer have any boot-only WSL repair path
    Type: regression
    Harness: H3
    Preconditions: Source files and harness env builder are available.
    Actions:
    1. Inspect the exported surface of `server/wsl-port-forward.ts`.
    2. Inspect `server/index.ts`.
    3. Build child env with `buildServerProcessEnv({}, {})`.
    Expected outcome:
    - `server/wsl-port-forward.ts` exports the manual helper surface, including `computeWslPortForwardingPlan`, and no longer exports `setupWslPortForwarding` or `getRequiredPorts`. Sources: `Plan-AM`, `Plan-T5`.
    - `server/index.ts` no longer imports or calls the startup-only WSL helper path. Sources: `Plan-AM`, `Plan-T5`.
    - Child server launches do not inject `FRESHELL_DISABLE_WSL_PORT_FORWARD`. Sources: `Plan-AM`, `Plan-T5`.
    Interactions: startup server entrypoint <> WSL helper module surface, logger/test harness env composition.

12. Name: Linux and macOS configure-firewall responses stay unchanged at the API boundary
    Type: regression
    Harness: H2
    Preconditions: `detectFirewall()` is mocked for `linux-ufw`, `linux-firewalld`, `macos`, and `linux-none`.
    Actions:
    1. POST `/api/network/configure-firewall` for each platform case.
    2. Inspect the returned `method` and command payload.
    Expected outcome:
    - Linux/macOS continue to return `method: 'terminal'` with a command string, and `linux-none` continues to return `method: 'none'`. Sources: `Plan-AM`, `Plan-T2`, `Client repair contract`.
    - These platforms do not return `confirmation-required`. Sources: `Plan-AM`, `Plan-SG`.
    Interactions: router <> `detectFirewall`, router <> cross-platform firewall-command generation.

13. Name: Windows daemon install/start always normalizes to least privilege
    Type: integration
    Harness: H4
    Preconditions: The XML template can be read/written through mocked fs, and `execFile` records `schtasks` calls.
    Actions:
    1. Call `manager.install(...)`.
    2. Inspect the written XML content.
    3. Call `manager.start()`.
    4. Inspect the `schtasks` command sequence.
    Expected outcome:
    - The written task definition contains `<RunLevel>LeastPrivilege</RunLevel>` and not `HighestAvailable`. Sources: `Transcript`, `Plan-AM`, `Plan-T5`.
    - Startup normalizes the task with `schtasks /Change /RL LIMITED` before `schtasks /Run`. Sources: `Plan-AM`, `Plan-T5`.
    Interactions: daemon manager <> task XML template, daemon manager <> Windows Task Scheduler command surface.

14. Name: Confirm modal keeps destructive defaults while supporting a non-destructive admin-approval primary action
    Type: regression
    Harness: H5
    Preconditions: `ConfirmModal` can be rendered in jsdom.
    Actions:
    1. Render a destructive confirmation without `confirmVariant`.
    2. Render the Windows admin-approval confirmation with `confirmVariant="default"`.
    Expected outcome:
    - Destructive callers still receive destructive button styling by default. Sources: `Plan-SG`, `Plan-T5`.
    - The admin-approval dialog can render the primary button with the shared non-destructive `Button` variant system. Sources: `Transcript`, `Plan-AM`, `Plan-T5`.
    Interactions: `ConfirmModal` <> shared `Button` variants, existing destructive callers such as other confirmation flows.

15. Name: Client firewall helper forwards explicit confirmation and preserves the confirmation-required response type
    Type: regression
    Harness: H5
    Preconditions: `api.post(...)` is mocked.
    Actions:
    1. Mock a `confirmation-required` response and call `fetchFirewallConfig()`.
    2. Call `fetchFirewallConfig({ confirmElevation: true, confirmationToken: 'confirm-1' })`.
    Expected outcome:
    - The helper exposes `method: 'confirmation-required'` without narrowing it away. Sources: `Plan-AM`, `Plan-T3`.
    - The helper sends `{ confirmElevation: true, confirmationToken: 'confirm-1' }` verbatim on the follow-up call. Sources: `Plan-AM`, `Plan-T3`.
    Interactions: client helper <> server route contract, UI callers <> typed result union.

16. Name: Shared elevated PowerShell helper preserves quoting and timeout invariants
    Type: unit
    Harness: H5
    Preconditions: `execFile(...)` is mocked and a script containing single quotes is available.
    Actions:
    1. Build argv for a script containing single quotes.
    2. Call `spawnElevatedPowerShell(...)`.
    Expected outcome:
    - The helper escapes single quotes correctly for `Start-Process ... -Verb RunAs -ArgumentList ...`. Sources: `Plan-SG`, `Plan-T5`.
    - The helper uses the shared timeout constant instead of open-coded per-call timeouts. Sources: `Plan-SG`, `Plan-T5`.
    Interactions: shared helper <> Windows PowerShell quoting rules, shared helper <> child-process timeout handling.

## Coverage summary

Covered action space:
- Server startup surfaces that previously owned WSL boot-time repair, including spawned child-server/test launches.
- The full `/api/network/configure-firewall` contract: empty body, tokenized confirmed body, malformed body, token rotation, confirmed single-flight guard, WSL no-op recompute, Windows start, Linux/mac terminal commands, and no-firewall `none`.
- The WSL drift-detection planner across `not-wsl2`, `error`, `noop`, `firewall-only`, and `full`.
- User-facing repair actions in both manual entry points: `SetupWizard` `Configure now`, `Continue`, `Cancel`, and `SettingsView` `Fix`.
- Shared contracts that other callers can regress: confirmation-modal styling, client helper typing, elevated PowerShell quoting, and daemon least-privilege normalization.

Explicitly excluded per the agreed strategy:
- Real Windows UAC acceptance and actual Windows Task Scheduler execution on a Windows host.
- Real WSL IP drift across actual reboot cycles.
- Browser-automation coverage of the confirmation modal; the scenario harness remains jsdom component coverage rather than Playwright/browser-use.
- Performance benchmarks; this change is control-flow and privilege-boundary work, and the implementation plan does not introduce a performance-testing requirement.

Risks carried by the exclusions:
- PowerShell quoting or `schtasks` behavior could still differ on real Windows despite the unit/integration contracts.
- A real WSL environment could expose environment-specific command-output differences that mocked fixtures do not cover.
- Because the UI scenarios are not browser-driven, portal/focus behavior is validated at the jsdom accessibility layer rather than in a headed browser.

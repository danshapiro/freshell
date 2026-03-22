# WSL Repair False-Positive Fix Test Plan

## Harness requirements

Strategy reconciliation: the implementation plan still fits the agreed server-side strategy. The change surface remains the same shared choke point and its existing consumers: `server/wsl-port-forward.ts` -> `NetworkManager.getStatus()` -> `POST /api/network/configure-firewall` / startup banner state. No paid services, external infrastructure, or new harness build is required.

One adjustment is warranted without further user approval: add one direct integration regression for the confirmed-repair callback path. The implementation plan correctly covers planner semantics and downstream status/prompt contracts, but it does not directly exercise the user-reported failure surface where `verifyWslRepairSuccess()` reruns the planner after the elevated child exits. This stays inside the existing `network-api` harness and does not change scope or cost.

No new harnesses need to be built. Extend the existing harnesses below:

- `test/unit/server/wsl-port-forward.test.ts`
  What it does: models WSL IP discovery, Windows `portproxy` output, Windows firewall rule output, and the managed-port file behind a temp home directory.
  What it exposes: sync and async planner entry points plus generated repair script text.
  Estimated complexity to build: none; extend the current fixture and mocks.
  Tests depending on it: 1, 2.

- `test/unit/server/network-manager.test.ts`
  What it does: runs a real `NetworkManager` against an in-process `http.Server` while mocking OS-facing collaborators.
  What it exposes: the `getStatus()` contract that drives Settings and the startup banner.
  Estimated complexity to build: none; extend the current fixture and mocks.
  Tests depending on it: 3.

- `test/integration/server/network-api.test.ts`
  What it does: runs the real Express router with auth middleware, `ConfigStore`, and `NetworkManager`, while mocking only OS-facing boundaries and elevated-process spawning.
  What it exposes: `GET /api/network/status`, `POST /api/network/configure-firewall`, confirmation-token flow, and whether `powershell.exe` would be spawned.
  Estimated complexity to build: none; extend the current fixture and mocks.
  Tests depending on it: 4, 5, 6.

- `test/unit/server/startup-banner.test.ts`
  What it does: asserts the user-visible startup banner selection and note text from status input.
  What it exposes: returned banner `kind`, `url`, and `noteLines`.
  Estimated complexity to build: none; extend the current fixture if a healthy WSL case is missing.
  Tests depending on it: 7.

## Test plan

1. **Name**: Metadata-only stale WSL bookkeeping does not force repair in either planner entry point
   **Type**: regression
   **Disposition**: extend
   **Harness**: `test/unit/server/wsl-port-forward.test.ts`
   **Preconditions**: WSL2 is mocked on; the managed-port file contains `[5173]`; live Windows state is healthy for the current port set only (`0.0.0.0:3001 -> <current WSL IP>:3001` and `FreshellLANAccess` contains `3001`); required ports and relevant ports are `[3001]`.
   **Actions**: Persist `[5173]` via `persistManagedWslRemoteAccessPorts(...)`; call `computeWslPortForwardingPlan([3001], [3001])`; call `computeWslPortForwardingPlanAsync([3001], [3001])`.
   **Expected outcome**: Both entry points return `{ status: 'noop', wslIp: <current WSL IP> }` and do not emit a repair script. Source of truth: the implementation plan's "User-Visible Target" first bullet and "Contracts And Invariants" items 1 and 5, plus the analysis note's live reproduction showing that changing only the managed file must not keep healthy Windows state in repair mode.
   **Interactions**: Managed-port file parsing, WSL IP parsing, Windows `portproxy` parsing, Windows firewall rule parsing.

2. **Name**: Live stale WSL exposure still produces cleanup when the stale port is actually present in Windows state
   **Type**: regression
   **Disposition**: extend
   **Harness**: `test/unit/server/wsl-port-forward.test.ts`
   **Preconditions**: WSL2 is mocked on; the managed-port file contains `[5173]`; live Windows state contains the healthy `3001` rule and a stale live `5173` `portproxy` rule; the firewall rule only contains `3001`; required ports and relevant ports are `[3001]`.
   **Actions**: Call `computeWslPortForwardingPlanAsync([3001], [3001])`.
   **Expected outcome**: The async planner returns `status: 'ready'` with `scriptKind: 'full'`, and the generated script deletes the stale `listenport=5173` rule while preserving current-port exposure. Source of truth: the implementation plan's "User-Visible Target" second bullet and "Contracts And Invariants" items 2 through 4.
   **Interactions**: Ownership bookkeeping, live `portproxy` cleanup, repair script generation.

3. **Name**: Network status stays healthy for reachable WSL remote access when the planner resolves to `noop`
   **Type**: integration
   **Disposition**: extend
   **Harness**: `test/unit/server/network-manager.test.ts`
   **Preconditions**: A real in-process server is listening on `0.0.0.0`; saved settings request remote access (`host: '0.0.0.0', configured: true`); firewall detection returns `{ platform: 'wsl2', active: true }`; the reachability probe returns `true`; the planner mock returns `status: 'noop'`; LAN IP detection returns `192.168.1.100`.
   **Actions**: Call `manager.getStatus()`.
   **Expected outcome**: The returned status shows `remoteAccessEnabled: true`, `remoteAccessRequested: true`, `remoteAccessNeedsRepair: false`, `firewall.portOpen: true`, and a LAN `accessUrl` for the served port. Source of truth: the implementation plan's healthy-state target and the analysis note's healthy `/api/network/status` reproduction.
   **Interactions**: Server bind address, reachability probe, LAN IP selection, planner-to-status contract.

4. **Name**: `GET /api/network/status` stops advertising healthy WSL access as needing repair
   **Type**: integration
   **Disposition**: extend
   **Harness**: `test/integration/server/network-api.test.ts`
   **Preconditions**: The real router is mounted with auth; remote access is configured and the server is listening on `0.0.0.0`; firewall detection returns WSL2; the reachability probe returns `true`; the planner mock returns `status: 'noop'`.
   **Actions**: Send authenticated `GET /api/network/status`.
   **Expected outcome**: The response is `200` and reports `remoteAccessEnabled: true`, `remoteAccessRequested: true`, `remoteAccessNeedsRepair: false`, `firewall.portOpen: true`, and a LAN `accessUrl` rather than a localhost fallback. Source of truth: the implementation plan's first target bullet and the analysis note's "Live API Reproduction" healthy response.
   **Interactions**: Auth middleware, Express router, `NetworkManager`, `ConfigStore`, reachability probe.

5. **Name**: `POST /api/network/configure-firewall` returns no-op for healthy WSL access instead of prompting for elevation
   **Type**: integration
   **Disposition**: extend
   **Harness**: `test/integration/server/network-api.test.ts`
   **Preconditions**: Same healthy WSL setup as test 4; `powershell.exe` spawning is mocked and observable.
   **Actions**: Send authenticated `POST /api/network/configure-firewall` with an empty JSON body.
   **Expected outcome**: The response is `200` with `{ method: 'none', message: 'No configuration changes required' }`; no confirmation token is issued; `powershell.exe` is not spawned. Source of truth: the implementation plan's first and third target bullets and the analysis note's healthy `configure-firewall` reproduction.
   **Interactions**: Repair-action resolution, confirmation-token flow, elevated-process boundary.

6. **Name**: Confirmed WSL repair succeeds after the elevated child exits when callback-time verification recomputes to `noop`
   **Type**: integration
   **Disposition**: extend
   **Harness**: `test/integration/server/network-api.test.ts`
   **Preconditions**: Remote access is configured on WSL2; the first preflight planner call returns `ready`; the confirmed retry re-check returns `ready`; the callback-time verification call returns `noop`; the reachability probe flips from repair-needed to healthy after the mocked elevated child finishes; `persistManagedWslRemoteAccessPorts(...)` is mocked and observable.
   **Actions**: Request `POST /api/network/configure-firewall` to obtain a confirmation token; send the confirmed retry to start repair; complete the mocked elevated child callback; then re-check the user-visible surface with authenticated `POST /api/network/configure-firewall` or `GET /api/network/status`.
   **Expected outcome**: The confirmed retry starts WSL repair, the callback-time verification does not fail, the managed-port persistence hook runs with the current remote-access ports, and the follow-up user-visible surface reports the healthy no-op state instead of another repair prompt. Source of truth: the original incident sequence in the analysis note, plus the implementation plan's third target bullet and contract 5.
   **Interactions**: Confirmation-token flow, elevated PowerShell spawn, callback-time verification, managed-port persistence, follow-up status/prompt surface.

7. **Name**: Startup banner only shows the WSL repair copy when status actually says repair is needed
   **Type**: invariant
   **Disposition**: extend
   **Harness**: `test/unit/server/startup-banner.test.ts`
   **Preconditions**: One healthy WSL status fixture with LAN access and `remoteAccessNeedsRepair: false`; one repairing WSL fixture with `remoteAccessNeedsRepair: true`.
   **Actions**: Call `resolveStartupBanner(...)` for both fixtures.
   **Expected outcome**: The healthy case returns the remote banner without repair note lines; the repairing case keeps the current repair note lines. Source of truth: the implementation plan's first target bullet ("no startup repair warning") and the existing startup-banner copy contract.
   **Interactions**: None beyond the startup-banner consumer.

## Coverage summary

- Covered action space:
  - Planner semantics for healthy live Windows state with stale managed metadata.
  - Planner semantics for real stale live WSL exposure that still must be cleaned up.
  - `NetworkManager.getStatus()` projection of planner output into `remoteAccessEnabled`, `remoteAccessNeedsRepair`, `firewall.portOpen`, and `accessUrl`.
  - Authenticated HTTP status and repair endpoints that the user actually hits from Settings.
  - The confirmed WSL repair callback path that reruns verification after the elevated child exits.
  - Startup banner behavior driven by `remoteAccessNeedsRepair`.

- Explicitly excluded:
  - Browser/e2e UI automation. The bug is server-state logic with stable HTTP and pure-function surfaces already covered by higher-signal server harnesses; adding a browser layer would add cost without improving fault isolation.
  - Real Windows/WSL command execution in CI. The proven defect is planner semantics over observed command output, so deterministic mock-driven server tests are the right evidence here.
  - Performance checks. This is a low-risk correctness fix on planner state interpretation; no performance-sensitive contract was identified in the transcript, analysis note, or implementation plan.

- Residual risks from the exclusions:
  - If a separate defect exists in real-world `netsh` visibility timing, localization, or elevated-process behavior, this plan will not detect it; it is intentionally targeted at the proven metadata-only false positive and the router/status surfaces that consume it.
  - Startup-banner coverage remains consumer-level, not full-process startup coverage; the status and router tests are the primary proof that the banner input becomes healthy again.

- Execution gates after implementation:
  - Run the focused server pack covering `wsl-port-forward`, `network-manager`, `network-api`, and `startup-banner`.
  - Run coordinated `npm test` before any rebase or merge work.

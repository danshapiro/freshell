# WSL Verification and Repair False Positive Analysis

## Scope

This note examines the `WSL2 port forwarding verification failed` error logged on 2026-03-20 and the broader WSL repair state that Freshell reports on this machine today. The goal is to separate incident facts from current reproducible facts, then reassess which change the evidence supports.

## March 20 Incident Evidence

The original pasted log is present in the rotated production log at:

- `~/.freshell/logs/20260321-1440-01-server-debug.production.3001.jsonl`

The relevant sequence is:

- `2026-03-20T23:40:55.028Z` `POST /api/network/configure-firewall` returned `200` with `contentLength: "265"`
- `2026-03-20T23:40:58.142Z` the confirmed retry returned `200` with `contentLength: "36"`
- `2026-03-20T23:41:02.305Z` Freshell logged `WSL2 port forwarding verification failed`

That sequence matches the current `network-router.ts` control flow:

1. First request returns the confirmation-required response.
2. Confirmed retry starts the elevated repair.
3. The elevated callback returns without a process error.
4. `verifyWslRepairSuccess()` throws.

The incident log proves one narrow fact:

- At verification time on 2026-03-20, `computeWslPortForwardingPlanAsync(...)` still returned `status: 'ready'`.

The incident log does not prove why the plan stayed in `ready`. It does not record:

- the WSL managed-port file contents
- the live `portproxy` table
- the live `FreshellLANAccess` rule
- the elevated PowerShell child stdout or stderr

## Current Code Facts

`startElevatedRepair()` in `server/network-router.ts` runs repair steps in this order:

1. start elevated PowerShell
2. await the child callback
3. run `verifySuccess()`
4. log success
5. run `onSuccess()`

For WSL repair:

- `verifySuccess()` is `verifyWslRepairSuccess()`
- `onSuccess()` calls `persistManagedWslRemoteAccessPorts(networkManager.getRemoteAccessPorts())`

That means WSL verification reads the managed-port file before Freshell rewrites it for the current port set.

`verifyWslRepairSuccess()` does not inspect live Windows state directly. It simply reruns the same planner used elsewhere:

```ts
const plan = await computeWslPortForwardingPlanAsync(
  networkManager.getRemoteAccessPorts(),
  networkManager.getRelevantPorts(),
)
if (plan.status === 'ready') {
  throw new Error('WSL2 port forwarding verification failed')
}
```

The planner in `server/wsl-port-forward.ts` treats stale managed metadata as repair-needed drift:

```ts
const staleOwnedPorts = Array.from(new Set([...existingFirewallPorts, ...managedPorts]))
  .filter((port) => !requiredPortSet.has(port))

const firewallNeedsUpdate = needsFirewallUpdate(requiredPorts, existingFirewallPorts)
  || staleOwnedPorts.length > 0
```

Two direct consequences follow:

- a stale entry in `managedPorts` can keep the plan in `ready` even if Windows is already correct
- when that happens without stale `portproxy` rules, the plan becomes `scriptKind: 'firewall-only'`

## WSL Managed File Semantics

The WSL managed-port file is global:

- `server/wsl-port-forward.ts` reads and writes `~/.freshell/wsl-managed-remote-access-ports.json`
- the path does not include `process.cwd()`, server port, or any other instance key

The equivalent Windows bookkeeping is different. Managed Windows firewall ports are stored per instance in `server/network-manager.ts`, keyed by `process.cwd()` and server port.

This asymmetry matters because Freshell commonly runs in two modes:

- production on port `3001`
- dev on server port `3002` with Vite on `5173`

In dev mode, `NetworkManager.getRemoteAccessPorts()` returns the dev port. A successful dev-mode WSL repair therefore persists `[5173]` to the global WSL managed-port file.

The machine has local evidence of dev-mode Freshell use with `5173`:

- shell history contains repeated `PORT=3002 VITE_PORT=5173 npm run dev` commands in Freshell worktrees

That confirms this host has run Freshell in the mode that writes `[5173]`. It does not prove those commands occurred before the 2026-03-20 incident, because the shell history is not timestamped.

The current managed-port file also cannot be treated as a snapshot of March 20. Its current mtime is `2026-03-21 16:28:36 -0700`, which is after the incident.

## Live System Reproduction

The strongest evidence comes from the current machine state on 2026-03-21.

### Platform state

- `wsl.exe --status` reports WSL version `2`
- `.wslconfig` sets `networkingMode=nat`
- `ip -4 addr show eth0` reports `172.30.149.249/20`

This is the WSL NAT setup that Freshell's `portproxy` workflow targets.

### Live Windows state

At investigation time:

- `netsh interface portproxy show v4tov4` included `0.0.0.0 3001 -> 172.30.149.249 3001`
- `netsh advfirewall firewall show rule name=FreshellLANAccess` showed `LocalPort: 3001`
- `~/.freshell/wsl-managed-remote-access-ports.json` contained:

```json
{
  "ports": [
    5173
  ]
}
```

### Live planner result

With that live Windows state, `computeWslPortForwardingPlanAsync([3001], [3001])` returned:

```json
{
  "status": "ready",
  "wslIp": "172.30.149.249",
  "scriptKind": "firewall-only"
}
```

I then changed only the managed-port file to `[3001]`, reran the same planner call, and restored the original file. The result changed to:

```json
{
  "status": "noop",
  "wslIp": "172.30.149.249"
}
```

Between those two calls, the following inputs were unchanged:

- the WSL IP
- the Windows `portproxy` rule for `3001`
- the Windows `FreshellLANAccess` rule for `3001`

That proves a metadata-only mismatch is sufficient to keep the WSL planner in `ready` on the real machine.

## Live API Reproduction

The same stale-file change also flips the running production server's user-visible repair state.

With the current managed file set to `[5173]`, `GET /api/network/status` returned:

```json
{
  "remoteAccessEnabled": true,
  "remoteAccessRequested": true,
  "remoteAccessNeedsRepair": true,
  "firewall": {
    "platform": "wsl2",
    "portOpen": false,
    "configuring": false,
    "commands": []
  }
}
```

In the same state, `POST /api/network/configure-firewall` returned:

```json
{
  "method": "confirmation-required"
}
```

After changing only the managed-port file to `[3001]`, with no Windows networking changes, the same production server returned:

```json
{
  "remoteAccessEnabled": true,
  "remoteAccessRequested": true,
  "remoteAccessNeedsRepair": false,
  "firewall": {
    "platform": "wsl2",
    "portOpen": true,
    "configuring": false,
    "commands": []
  }
}
```

In that state, `POST /api/network/configure-firewall` returned:

```json
{
  "method": "none",
  "message": "No configuration changes required"
}
```

This is not only a post-repair verification bug. The same planner behavior currently drives:

- `remoteAccessNeedsRepair`
- `firewall.portOpen`
- the confirmation prompt on `POST /api/network/configure-firewall`

The startup banner uses `remoteAccessNeedsRepair` in `server/startup-banner.ts`, so the same false positive also drives:

- `Remote access is active but needs firewall/port-forward repair.`

## Why The Status Path Fails

`NetworkManager.getStatus()` treats the WSL planner as the authority on whether remote access is still open cleanly:

```ts
if (firewallInfo.platform === 'wsl2' && rawPortOpen === true) {
  const wslPlan = await computeWslPortForwardingPlanAsync(remoteAccessPorts, this.getRelevantPorts())
  staleManagedWindowsExposure = wslPlan.status === 'ready'
}

const portOpen = staleManagedWindowsExposure ? false : rawPortOpen
```

So a metadata-only `ready` plan forces:

- `firewall.portOpen = false`
- `remoteAccessNeedsRepair = true`

That is exactly what the live API experiment showed.

## Repo History and Regression Window

The current behavior was assembled in steps on 2026-03-13:

- `f47f1066` introduced the WSL managed-port file
- `175879b6` changed the planner so stale `managedPorts` contributes to repair-needed drift
- `14e7f4c4` added repair verification before `onSuccess()` persistence

The new test added in `175879b6` covers a stale old dev port that still exists in live Windows state:

- `portproxy` still has `5173`
- `FreshellLANAccess` still includes `5173`

That test does not cover metadata-only drift. I did not find a unit or integration test for this narrower case:

- live `portproxy` correct for `3001`
- live `FreshellLANAccess` correct for `3001`
- managed file stale to `[5173]`

That matters because the current false positive requires no live stale exposure at all.

## What The Evidence Proves

The current evidence supports these conclusions directly:

1. On 2026-03-20, the elevated WSL repair callback completed and the recomputed WSL plan still returned `status: 'ready'`.
2. The WSL planner currently treats stale managed metadata as repair-needed drift even when Windows already matches the required live exposure.
3. The WSL managed-port file is global across Freshell instances and modes.
4. On this machine today, live Windows state for `3001` is correct while the global WSL managed-port file still says `5173`.
5. On this machine today, changing only that file flips the planner from `ready` to `noop`.
6. On this machine today, changing only that file also flips `/api/network/status` from repair-needed to healthy and changes `/api/network/configure-firewall` from confirmation-required to no-op.
7. Because repair verification runs before `onSuccess()` updates the file, the same metadata-only mismatch is sufficient to cause a post-repair verification failure.

Items 5 through 7 are proven on the live machine, not inferred from tests alone.

## What Remains Unproven

The evidence still does not prove these stronger claims:

- the 2026-03-20 incident definitely used the same stale `[5173]` file state
- a dev-mode Freshell run definitely wrote that stale value before the incident
- Windows or PowerShell contributed nothing to that specific repair attempt

Those claims need contemporaneous state that the incident log does not contain.

## Fix Assessment

The earlier draft proposed a verifier-only fix. The newer evidence changes that assessment.

### Verifier Only Fix

A dedicated verifier that ignores the managed-port file would address the `WSL2 port forwarding verification failed` error. It would not address the broader false positive that is already live today:

- `/api/network/status` would still claim repair is needed
- `POST /api/network/configure-firewall` would still prompt for elevation
- the startup banner would still tell the user to repair LAN access

That is too narrow for the proven bug.

### Persist Before Verify Fix

Updating the managed-port file before verification would also let the current verification pass in the reproduced state. It has two drawbacks:

- it still leaves the status and prompt path coupled to metadata-only drift
- it writes bookkeeping before repair success is established

The live API evidence makes this option hard to justify as the primary fix.

### Planner fix

The evidence supports a planner change as the primary fix:

- treat stale WSL managed metadata as actionable only when it corresponds to live Windows exposure
- do not let metadata by itself keep the plan in `ready`

In practical terms, `managedPorts` should be an ownership hint for existing Windows state, not an independent source of current exposure.

That change addresses all proven manifestations of the bug:

- false `remoteAccessNeedsRepair`
- false `firewall.portOpen = false`
- false confirmation-required prompt
- false startup repair banner
- false post-repair verification failure

This is also the narrowest change that matches the current tests' intent. The stale-port tests added in `175879b6` and `9092bc65` are about cleaning up actual stale Windows exposure, not about treating a stale bookkeeping file as exposure by itself.

### Follow Up Design Question

The global WSL managed-port file remains a separate design risk even after the planner fix. Matching WSL bookkeeping to the per-instance Windows bookkeeping would reduce cross-instance contamination between dev and production runs. The evidence in this note shows why that risk exists. It does not show that file scoping must be changed in the same patch as the planner fix.

## Test Gap

I did not find coverage for the exact reproduced case:

- live `3001` `portproxy` correct
- live `FreshellLANAccess` correct for `3001`
- managed file stale to `[5173]`
- status should remain healthy
- configure-firewall should return no-op
- post-repair verification should succeed

That case should be added explicitly.

## Files Reviewed

- `server/network-router.ts`
- `server/wsl-port-forward.ts`
- `server/network-manager.ts`
- `server/elevated-powershell.ts`
- `server/startup-banner.ts`
- `test/unit/server/wsl-port-forward.test.ts`
- `test/integration/server/network-api.test.ts`
- `docs/plans/2026-02-03-wsl2-lan-access-design.md`
- `~/.freshell/logs/20260321-1440-01-server-debug.production.3001.jsonl`
- `~/.freshell/wsl-managed-remote-access-ports.json`
- shell history under `~/.bash_history`

## External Sources

- Microsoft Learn, WSL networking: https://learn.microsoft.com/en-us/windows/wsl/networking
- Microsoft Learn, `netsh interface`: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-interface
- Microsoft Learn, `netsh advfirewall`: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-advfirewall
- Microsoft Learn, `Start-Process`: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process?view=powershell-5.1

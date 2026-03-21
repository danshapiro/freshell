# WSL Verification False Negative Analysis

## Scope

This note traces the production error `WSL2 port forwarding verification failed` that was logged on March 20, 2026. The goal is to explain the failure mode, separate platform behavior from Freshell behavior, and identify the smallest defensible code change.

## Executive Summary

The failure is a false negative in Freshell's WSL repair verification path.

Windows state can already be correct:

- `netsh interface portproxy show v4tov4` can show `0.0.0.0:3001 -> <current WSL IP>:3001`
- `netsh advfirewall firewall show rule name=FreshellLANAccess` can show `LocalPort: 3001`

Freshell still reports repair as incomplete because the verification path calls `computeWslPortForwardingPlanAsync()`, and that planner treats stale values from `~/.freshell/wsl-managed-remote-access-ports.json` as if they were evidence of current Windows firewall drift.

The repair flow then verifies before it refreshes that managed-ports file. If the file still contains an old port such as `5173`, verification returns `ready` instead of `noop`, and the repair is marked as failed even though the live Windows rules already match the desired state.

## What The Code Does

The failing log comes from `verifyWslRepairSuccess()` in `server/network-router.ts`.

- `POST /api/network/configure-firewall` starts an elevated PowerShell repair when `resolveRepairAction()` returns `confirmationAction: 'wsl2-repair'`
- After the elevated PowerShell process exits, `startElevatedRepair()` runs `verifySuccess()`
- For the WSL repair path, `verifySuccess()` is `verifyWslRepairSuccess()`
- `verifyWslRepairSuccess()` reruns `computeWslPortForwardingPlanAsync()`
- If that planner returns `status: 'ready'`, Freshell throws `WSL2 port forwarding verification failed`

Relevant code paths:

- `server/network-router.ts`
- `server/wsl-port-forward.ts`
- `server/elevated-powershell.ts`

The order inside `startElevatedRepair()` matters:

1. Run elevated PowerShell.
2. Call `verifySuccess()`.
3. Only after verification passes, run `onSuccess()`.

For WSL repair, `onSuccess()` persists the current remote-access ports to `~/.freshell/wsl-managed-remote-access-ports.json`.

That means verification reads the old managed-port file, not the post-repair one.

## Planner Behavior

`computeWslPortForwardingPlanAsync()` combines three inputs:

- The current WSL IP
- The current Windows `portproxy` rules
- The current `FreshellLANAccess` firewall rule
- The managed-port file at `~/.freshell/wsl-managed-remote-access-ports.json`

The planner eventually reaches `buildWslPortForwardingPlan()` in `server/wsl-port-forward.ts`.

The critical logic is the stale-port calculation:

```ts
const staleOwnedPorts = Array.from(new Set([...existingFirewallPorts, ...managedPorts]))
  .filter((port) => !requiredPortSet.has(port))
```

That line treats every stale managed port as if it were still an active firewall port, even when Windows no longer exposes that port at all.

Later logic uses `staleOwnedPorts.length > 0` to decide whether the firewall still needs repair. That is why a stale bookkeeping file alone can produce a `firewall-only` repair plan.

## Local Reproduction

I reproduced the behavior against the local code and local Windows state.

Observed live Windows state during investigation:

- `netsh interface portproxy show v4tov4` included `0.0.0.0 3001 -> 172.30.149.249 3001`
- `netsh advfirewall firewall show rule name=FreshellLANAccess` showed `LocalPort: 3001`

I then forced the managed-port file through two states and reran `computeWslPortForwardingPlanAsync([3001], [3001])`.

With managed ports set to `[5173]`:

```json
{
  "managed": [5173],
  "plan": {
    "status": "ready",
    "wslIp": "172.30.149.249",
    "scriptKind": "firewall-only"
  }
}
```

With managed ports set to `[3001]`:

```json
{
  "managed": [3001],
  "plan": {
    "status": "noop",
    "wslIp": "172.30.149.249"
  }
}
```

The live Windows state did not change between those runs. The only difference was the managed-port file. That isolates the false negative to Freshell's own metadata handling.

One caution from the live session: another process rewrote the managed-port file while I was investigating. That did not affect the reproduced result because I forced both file states explicitly and restored the original contents afterward.

## Why This Is Not A Windows Or WSL Primitive Failure

The online research supports Freshell's general model.

Microsoft's WSL networking documentation says:

- WSL 2 NAT mode does not expose Linux services to the LAN by default
- LAN access in NAT mode can be enabled with a Windows `netsh interface portproxy` rule
- A Windows firewall rule is also required for remote access
- Mirrored mode is a separate networking model with different behavior

Source:

- https://learn.microsoft.com/en-us/windows/wsl/networking

Microsoft's `netsh interface` documentation shows that `portproxy add v4tov4`, `delete v4tov4`, and `show` are valid commands for the workflow Freshell uses.

Source:

- https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-interface

Microsoft's `netsh advfirewall` documentation shows that adding, deleting, and showing firewall rules by name is also a valid workflow.

Source:

- https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-advfirewall

Microsoft's `Start-Process` documentation also supports the use of `-Verb` and `-Wait`, which matches Freshell's elevated PowerShell wrapper.

Source:

- https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process?view=powershell-5.1

That leaves the false negative inside Freshell's verification logic rather than in Windows command semantics.

## Alternate Explanations Considered

### Elevated PowerShell did not wait for the repair to finish

This does not fit the code or the platform docs. Freshell launches PowerShell through `Start-Process ... -Verb RunAs -Wait`, and the verification callback runs after the child process returns.

### The `netsh` commands are wrong

The command family matches the Microsoft docs, and the local machine already showed the expected `portproxy` and firewall state for port `3001`.

### The repair script itself failed silently

That could happen in other incidents, but it does not explain the reproduced case where only the managed-port file changed and the planner flipped from `ready` to `noop` without any Windows state change.

### Mirrored networking made the NAT checks invalid

The WSL docs do describe mirrored mode as a different networking architecture. That is a real follow-up question for Freshell's broader network detection logic, but it is not needed to explain this incident. The local machine showed a standard NAT-style `portproxy` setup, and the false negative reproduced entirely within Freshell's own planner.

## Root Cause

The root cause is a mismatch between what verification is trying to prove and what the planner is allowed to consider.

Verification is meant to answer a narrow question:

- Do the live Windows `portproxy` and firewall rules now match the desired remote-access ports?

The planner answers a wider question:

- Do the live Windows rules match the desired state, and does Freshell's managed-port bookkeeping also look current?

That wider question is appropriate for cleanup planning, but it is not safe as a post-repair verification criterion when the bookkeeping refresh happens after verification.

## Proposed Change

The smallest fix is to stop treating stale managed ports as evidence of live Windows drift when those ports are not present in the current Windows rules.

In `buildWslPortForwardingPlan()`:

- Keep using `managedPorts` as an ownership hint
- Only treat a stale managed port as actionable drift if it still appears in `existingRules` or `existingFirewallPorts`
- Do not let metadata by itself create `firewallNeedsUpdate`

That means replacing the current stale-port calculation with something closer to:

```ts
const staleFirewallPorts = [...existingFirewallPorts].filter((port) => !requiredPortSet.has(port))
const staleManagedLivePorts = [...managedPorts].filter(
  (port) => !requiredPortSet.has(port) && (existingFirewallPorts.has(port) || existingRules.has(port))
)
const staleOwnedPorts = Array.from(new Set([...staleFirewallPorts, ...staleManagedLivePorts]))
```

This keeps legitimate cleanup behavior:

- If Windows still exposes an old managed port, Freshell will still plan cleanup.
- If only the metadata is stale, Freshell will no longer claim the firewall needs repair.

## Why I Prefer This Change

It fixes the verification failure at the source.

Other options are weaker:

- Reordering `onSuccess()` before verification would mutate bookkeeping before Freshell knows the repair worked.
- Making verification write the managed-port file itself would mix persistence into a read-style check.
- Special-casing the WSL verification path without fixing the planner would leave `network/status` and any other planner consumers exposed to the same false drift signal.

The planner change fixes verification, status reporting, and future repair decisions with one correction.

## Test Coverage To Add

Unit coverage in `test/unit/server/wsl-port-forward.test.ts`:

- Correct `portproxy` and firewall state for `3001`, stale managed file `[5173]`, expected plan `noop`
- Correct `portproxy` state for `3001`, stale firewall rule still including `5173`, expected plan `ready`
- Correct firewall rule for `3001`, stale `portproxy` rule still exposing `5173`, expected plan `ready`

Integration coverage in `test/integration/server/network-api.test.ts`:

- Confirmed WSL repair succeeds when Windows ends in the correct state but the pre-repair managed-port file is stale

## Files Reviewed

- `server/network-router.ts`
- `server/wsl-port-forward.ts`
- `server/network-manager.ts`
- `server/elevated-powershell.ts`
- `test/unit/server/wsl-port-forward.test.ts`
- `test/integration/server/network-api.test.ts`

## External Sources

- Microsoft Learn, WSL networking: https://learn.microsoft.com/en-us/windows/wsl/networking
- Microsoft Learn, `netsh interface`: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-interface
- Microsoft Learn, `netsh advfirewall`: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-advfirewall
- Microsoft Learn, `Start-Process`: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process?view=powershell-5.1

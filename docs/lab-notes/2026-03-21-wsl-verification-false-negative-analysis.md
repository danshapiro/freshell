# WSL Verification False Negative Analysis

## Scope

This note revisits the `WSL2 port forwarding verification failed` error logged on 2026-03-20. The earlier draft identified a plausible failure path. This revision narrows the claims to what the logs, code, repo history, live machine state, and Microsoft documentation support directly.

## March 20 Evidence

The pasted production logs establish these facts:

- Freshell 0.6.0 was running in `env: "production"`.
- The startup banner reported: `Remote access is active but needs firewall/port-forward repair.`
- `POST /api/network/configure-firewall` later logged `WSL2 port forwarding failed`.
- The thrown error message was `WSL2 port forwarding verification failed`.

The last point has a precise meaning in the current code. `verifyWslRepairSuccess()` in `server/network-router.ts` recomputes the WSL plan and throws that exact error only when `computeWslPortForwardingPlanAsync(...)` returns `status: 'ready'`.

That is the only incident level conclusion the log proves by itself:

- At verification time on 2026-03-20, Freshell still believed repair was needed.

The log does not identify which input kept the plan in `ready`. It does not record the managed-port file contents, the live `portproxy` state, or the live `FreshellLANAccess` rule at that moment.

## Current Code Facts

`startElevatedRepair()` in `server/network-router.ts` runs its steps in this order:

1. Start elevated PowerShell.
2. Await the child callback.
3. Run `verifySuccess()`.
4. Only after verification passes, run `onSuccess()`.

For WSL repair:

- `verifySuccess()` is `verifyWslRepairSuccess()`.
- `onSuccess()` calls `persistManagedWslRemoteAccessPorts(networkManager.getRemoteAccessPorts())`.

That means WSL verification always reads the pre-repair managed-port file, not the post-success one.

`buildWslPortForwardingPlan()` in `server/wsl-port-forward.ts` computes:

```ts
const staleOwnedPorts = Array.from(new Set([...existingFirewallPorts, ...managedPorts]))
  .filter((port) => !requiredPortSet.has(port))
```

Later it sets:

```ts
const firewallNeedsUpdate = needsFirewallUpdate(requiredPorts, existingFirewallPorts)
  || staleOwnedPorts.length > 0
```

Two direct consequences follow from that code:

- `managedPorts` metadata alone can make the planner return `ready`.
- A metadata-only mismatch produces `scriptKind: 'firewall-only'`, because the stale port is not required to exist in `portproxy`.

## Managed File Semantics

The WSL managed-port file is global:

- `server/wsl-port-forward.ts` writes to `~/.freshell/wsl-managed-remote-access-ports.json`
- The file path does not include `process.cwd()`, server port, or any instance key

The only production writers in this repo are:

- `persistManagedWslRemoteAccessPorts(...)`
- `clearManagedWslRemoteAccessPorts()`

Both are called from `server/network-router.ts`.

This rules out arbitrary third-party writers inside the repo. If the file changes unexpectedly, the cause is another Freshell process, an earlier Freshell run, or manual filesystem changes.

The Windows bookkeeping added later in `server/network-manager.ts` is different. It writes managed Windows ports to a per-instance file keyed by `process.cwd()` and server port. WSL bookkeeping has no equivalent scoping.

That asymmetry matters because Freshell commonly runs in two modes:

- Production mode on port `3001`
- Dev mode with server port `3002` and Vite on `5173`

In dev mode, `NetworkManager.getRemoteAccessPorts()` returns the dev port, not the API port. A successful WSL repair from a dev server therefore persists `[5173]` to the global WSL managed-port file.

That does not prove a dev server caused the 2026-03-20 incident. It does prove that a stale `5173` value is structurally consistent with Freshell's own dev-mode behavior.

## Live System Facts

The current machine state on 2026-03-21 provides a direct reproduction on real Windows and WSL state, not a mocked test harness.

### Platform mode

- `wsl.exe --status` reports default version `2`
- `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` shows this `.wslconfig`:

```ini
[wsl2]
networkingMode=nat
localhostForwarding=true
maxCrashDumpCount=2
defaultVhdSize=500GB
```

- `ip -4 addr show eth0` reports `172.30.149.249/20`

This machine is running the NAT style WSL setup that Freshell's `portproxy` workflow targets.

### Live Windows state

At the time of investigation:

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

With the live Windows state above, `computeWslPortForwardingPlanAsync([3001], [3001])` returned:

```json
{
  "status": "ready",
  "wslIp": "172.30.149.249",
  "scriptKind": "firewall-only",
  "script": "netsh advfirewall firewall delete rule name=FreshellLANAccess 2>$null; netsh advfirewall firewall add rule name=FreshellLANAccess dir=in action=allow protocol=tcp localport=3001 profile=private"
}
```

I then changed only the managed-port file to `[3001]`, reran the same planner call, and restored the original file. The result changed to:

```json
{
  "managed": [
    3001
  ],
  "plan": {
    "status": "noop",
    "wslIp": "172.30.149.249"
  }
}
```

The live Windows `portproxy` rule, the live firewall rule, and the WSL IP were unchanged between those runs.

This is a direct proof on the real machine:

- Live Windows state can already match the required `3001` exposure.
- The planner can still return `ready`.
- Changing only the managed-port file is sufficient to flip the result from `ready` to `noop`.

The `scriptKind` detail matters. The current Windows host also has unrelated stale `0.0.0.0` `portproxy` rules for other ports, but the planner returned `firewall-only`, not `full`. That shows those extra rules were not the reason this specific call stayed in `ready`.

## Repo History

The relevant behavior landed in three steps on 2026-03-13:

- `f47f1066` `Fix WSL teardown lock and drift handling`
  - introduced the WSL managed-port file
  - added `persistManagedWslRemoteAccessPorts(...)` as a WSL repair `onSuccess()` step
- `175879b6` `Clean up stale dev remote access ports`
  - changed `buildWslPortForwardingPlan()` so stale `managedPorts` contribute to `staleOwnedPorts`
- `9092bc65` `Fix stale remote-access upgrade drift`
  - widened plan and teardown calls to use `knownOwnedPorts`

The commit messages and tests added in those changes are about drift cleanup and stale exposure after upgrades. They are not about post-repair verification. That makes the current `verifyWslRepairSuccess() -> computeWslPortForwardingPlanAsync(...)` reuse a design shortcut, not a separately justified verification model.

## What The Evidence Proves

The current evidence supports these conclusions directly:

1. `verifyWslRepairSuccess()` fails whenever the recomputed plan stays in `status: 'ready'`.
2. The planner treats stale managed metadata as actionable drift.
3. WSL managed metadata is stored in a single global file shared across Freshell instances.
4. On this machine today, live Windows state for port `3001` is correct while the global managed file still says `5173`.
5. On this machine today, that metadata mismatch alone is enough to keep the plan in `ready` with `scriptKind: 'firewall-only'`.
6. Because WSL verification runs before `onSuccess()` updates the managed file, a repair executed in that state will re-read the same stale metadata during verification.

That last point is deterministic. In the metadata-only case above, the firewall-only repair script does not change the managed file, and the live firewall rule already matches `3001`. The verification callback therefore sees the same inputs that produced `ready` before the callback started.

## What Remains Unproven

The current evidence does not prove these stronger claims:

- The 2026-03-20 incident definitely used the same stale `5173` file state.
- The 2026-03-20 incident was caused by a dev instance writing the global file.
- Windows or PowerShell behavior played no part in that specific run.

Those claims need data that the pasted incident logs do not contain:

- the managed-port file contents at 2026-03-20 23:41 local time
- the exact `portproxy` and firewall state at that time
- the exact stdout and stderr from the elevated PowerShell child

There is no need to invoke extra Windows failure modes to explain the incident. The present code bug is sufficient. That is different from proving no extra Windows failure mode happened.

## Test Gap

The current tests cover several stale-exposure cases, including stale old dev ports and stale legacy `portproxy` drift. I did not find a test for this narrower case:

- live `portproxy` and firewall already correct for `3001`
- managed-port file stale to `[5173]`
- forwarding plan should still allow verification to pass

I also did not find an integration test that exercises the current `startElevatedRepair()` ordering with WSL verification before `onSuccess()` persistence.

## Proposed Change

The narrowest change justified by the evidence is to stop using the broad drift planner as the post-repair verifier.

Instead:

1. Add a dedicated WSL verification helper that checks only live state:
   - current WSL IP
   - current `portproxy` rules
   - current `FreshellLANAccess` rule
2. Have `verifyWslRepairSuccess()` use that helper.
3. Ignore the managed-port file during verification.

This change is justified by the evidence in this note:

- The incident failure is specifically a verification failure.
- The false negative is proven to come from metadata that verification reads before `onSuccess()` refreshes it.
- The broader planner semantics were introduced for drift cleanup, not for post-repair verification.

This proposal leaves one separate product question open:

- Should metadata-only WSL drift also keep `network/status` and the startup banner in a repair-needed state?

The live machine suggests that answer should probably be no, but the evidence collected here proves the verification bug more strongly than it proves the correct long-term status semantics. A follow-up change can address planner and status behavior after that decision is made.

## Files Reviewed

- `server/network-router.ts`
- `server/wsl-port-forward.ts`
- `server/network-manager.ts`
- `server/elevated-powershell.ts`
- `server/startup-banner.ts`
- `test/unit/server/wsl-port-forward.test.ts`
- `test/integration/server/network-api.test.ts`
- `docs/plans/2026-02-03-wsl2-lan-access-design.md`

## External Sources

- Microsoft Learn, WSL networking: https://learn.microsoft.com/en-us/windows/wsl/networking
- Microsoft Learn, `netsh interface`: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-interface
- Microsoft Learn, `netsh advfirewall`: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/netsh-advfirewall
- Microsoft Learn, `Start-Process`: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/start-process?view=powershell-5.1

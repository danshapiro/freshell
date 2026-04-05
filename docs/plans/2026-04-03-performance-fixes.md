# Performance Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the top performance bottlenecks causing Freshell to run slowly — spin locks, sync I/O blocking the event loop, missing build caching, eager-loaded heavy modules, and unnecessary React re-renders.

**Architecture:** Eight targeted fixes across server (Node.js/Express), build config (TypeScript), and client (React/Redux). Each task is independent and can be committed separately. The changes span three layers: (1) dev tooling — tsx watch exclude patterns and TypeScript incremental compilation; (2) server runtime — replacing CPU-burning spin locks with `Atomics.wait`, removing dead sync `execSync` code paths, converting sync file I/O to async in request handlers, and adding an async `detectLanIps` variant; (3) client runtime — lazy-loading Monaco editor and wrapping large components in `React.memo`.

**Tech Stack:** TypeScript 5.9.3, Node.js 22, Express 4.22, React 18, Redux Toolkit, Vite, Vitest

**Important context:** Server uses NodeNext/ESM — relative imports must include `.js` extensions. This project runs in WSL2. The `server/bootstrap.ts` module runs synchronously on import before `dotenv/config` loads, so the sync `detectLanIps` must be preserved for that path.

---

### Task 1: Add `--exclude` patterns to `tsx watch` in dev scripts

**Files:**
- Modify: `package.json` (the `dev` and `dev:server` script entries)

**Why:** `tsx watch` has no exclude patterns, so it watches `.worktrees` (58 GB, 2.66M files), `demo-projects` (203 MB), and `dist` (12 MB). Vite already ignores `.worktrees` but `tsx watch` does not. Note: `node_modules` is already ignored by tsx's built-in default, so we don't need to add it. The `--exclude` flag (not the deprecated `--ignore`) is the correct flag for tsx v4.21.0+.

- [ ] **Step 1: Identify failing condition**

This is a config-only change with no unit-testable behavior. The verification is that the dev server still starts correctly after the change.

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && grep '"dev"' package.json`
Expected: Shows the current `dev` script without `--exclude` patterns.

- [ ] **Step 2: Update `dev` script in `package.json`**

Change the `dev` script from:
```json
"dev": "cross-env PORT=3002 concurrently -n client,server -c blue,green \"vite\" \"tsx watch server/index.ts\""
```
to:
```json
"dev": "cross-env PORT=3002 concurrently -n client,server -c blue,green \"vite\" \"tsx watch --exclude '.worktrees/**' --exclude 'demo-projects/**' --exclude 'dist/**' server/index.ts\""
```

- [ ] **Step 3: Update `dev:server` script in `package.json`**

Change the `dev:server` script from:
```json
"dev:server": "cross-env PORT=3002 tsx watch server/index.ts"
```
to:
```json
"dev:server": "cross-env PORT=3002 tsx watch --exclude '.worktrees/**' --exclude 'demo-projects/**' --exclude 'dist/**' server/index.ts"
```

- [ ] **Step 4: Verify dev server starts correctly**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && timeout 15 npx tsx watch --exclude '.worktrees/**' --exclude 'demo-projects/**' --exclude 'dist/**' server/index.ts 2>&1 | head -20`
Expected: Server starts without errors (look for "listening on" or similar startup message, or at minimum no crash).

- [ ] **Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/performance-fixes add package.json
git -C /home/user/code/freshell/.worktrees/performance-fixes commit -m "perf: add --exclude patterns to tsx watch to skip .worktrees, demo-projects, dist

tsx watch had no exclude patterns, potentially watching 58 GB of worktree
data. Uses --exclude (not deprecated --ignore) with glob patterns."
```

---

### Task 2: Replace spin lock busy-wait with `Atomics.wait` in `config-writer.ts`

**Files:**
- Modify: `server/mcp/config-writer.ts` (the spin loop at lines 200-202)
- Test: `test/unit/server/mcp/config-writer.test.ts` (existing tests — no changes needed)

**Why:** `acquireLock` has a literal busy-wait `while (Date.now() < end) { /* spin */ }` that burns CPU for up to 100ms per retry iteration. `Atomics.wait` is a synchronous sleep that blocks the thread without CPU burn.

**Design decision — why not make acquireLock async:** Making it async would cascade through `generateMcpInjection` -> `providerNotificationArgs` -> `buildSpawnSpec` -> `TerminalRegistry.create()` -> `kill()` -> `remove()`, affecting 117+ test references and introducing race conditions with the module-level `_lockAcquired` flag. `Atomics.wait` is a one-line change with zero caller impact.

**`Atomics.wait` availability:** Available in all Node.js versions that support ESM (Node 12+). The project requires Node >= 22.5.0, so this is safe. It works by blocking the calling thread on a futex-like wait, yielding CPU time to other processes/threads. The `SharedArrayBuffer` + `Int32Array` are throwaway — they exist only to satisfy the API signature.

- [ ] **Step 1: Verify the spin lock exists and tests pass before change**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && grep -n 'while (Date.now' server/mcp/config-writer.ts`
Expected: Shows the busy-wait loop around line 202.

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run test/unit/server/mcp/config-writer.test.ts --reporter verbose 2>&1 | tail -20`
Expected: All existing tests pass (this is our baseline).

- [ ] **Step 2: Replace the busy-wait with `Atomics.wait`**

In `server/mcp/config-writer.ts`, replace lines 200-202:
```typescript
        // Brief busy-wait for non-stale lock
        const end = Date.now() + 100
        while (Date.now() < end) { /* spin */ }
```
with:
```typescript
        // Synchronous sleep without CPU burn (Atomics.wait blocks the thread
        // for the specified duration without spinning)
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
```

- [ ] **Step 3: Run tests to verify no regressions**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run test/unit/server/mcp/config-writer.test.ts --reporter verbose 2>&1 | tail -20`
Expected: All existing tests pass with no changes needed.

- [ ] **Step 4: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/performance-fixes add server/mcp/config-writer.ts
git -C /home/user/code/freshell/.worktrees/performance-fixes commit -m "perf: replace CPU-burning spin lock with Atomics.wait in MCP config writer

The acquireLock function used a busy-wait while loop that burned CPU for
up to 100ms per retry. Atomics.wait blocks the thread without spinning,
yielding CPU to other processes. Available in all Node.js >= 12."
```

---

### Task 3: Remove sync `execSync` exports from `wsl-port-forward.ts`

**Files:**
- Modify: `server/wsl-port-forward.ts` (remove 5 sync functions + private helper + `execSync` import + `fs` import)
- Modify: `test/unit/server/wsl-port-forward.test.ts` (remove sync test cases)
- Modify: `test/integration/server/wsl-port-forward.test.ts` (remove sync export assertions)
- Modify: `test/integration/server/network-api.test.ts` (remove dead sync mocks)

**Why:** The sync versions call `execSync` to Windows binaries (`netsh.exe`, `ip`, `hostname`) via the `/mnt/c/` 9P bridge — each takes 500ms-5s. Async variants already exist and are used by all runtime callers. Zero runtime callers exist for the sync versions (verified by grep — only definitions appear).

**Functions to remove:**
- `readManagedWslRemoteAccessPorts()` (private, line 83) — only called by sync plan functions
- `getWslIp()` (exported, line 159)
- `getExistingPortProxyRules()` (exported, line 227)
- `getExistingFirewallPorts()` (exported, line 324)
- `computeWslPortForwardingPlan()` (exported, line 585)
- `computeWslPortForwardingTeardownPlan()` (exported, line 660)

**Imports to clean up:**
- Remove `execSync` from the `child_process` import (keep `execFile`)
- Remove `import fs from 'node:fs'` (only used by `readManagedWslRemoteAccessPorts`; async code uses `fsp`)

**Pre-check requirement:** Before removing sync test cases, verify that the async test suites (`computeWslPortForwardingPlanAsync`, etc.) cover the same edge cases. If any sync-only edge case exists, port it to async first.

- [ ] **Step 1: Verify no runtime callers exist for sync functions**

Run:
```bash
cd /home/user/code/freshell/.worktrees/performance-fixes
grep -rn 'computeWslPortForwardingPlan\b[^A]' server/ --include='*.ts' | grep -v 'export function'
grep -rn 'computeWslPortForwardingTeardownPlan\b[^A]' server/ --include='*.ts' | grep -v 'export function'
grep -rn '\bgetWslIp\b' server/ --include='*.ts' | grep -v 'Async' | grep -v 'export function'
grep -rn '\bgetExistingPortProxyRules\b' server/ --include='*.ts' | grep -v 'Async' | grep -v 'export function'
grep -rn '\bgetExistingFirewallPorts\b' server/ --include='*.ts' | grep -v 'Async' | grep -v 'export function'
```
Expected: Each grep returns empty (no external callers).

- [ ] **Step 2: Verify async tests cover sync edge cases**

Compare describe blocks in `test/unit/server/wsl-port-forward.test.ts`:
- `computeWslPortForwardingPlan` sync tests vs `computeWslPortForwardingPlanAsync` tests
- `computeWslPortForwardingTeardownPlan` sync tests vs `computeWslPortForwardingTeardownPlanAsync` tests
- `getWslIp` sync tests vs `getWslIpAsync` tests
- `getExistingPortProxyRules` sync tests vs `getExistingPortProxyRulesAsync` tests
- `getExistingFirewallPorts` sync tests vs `getExistingFirewallPortsAsync` tests

If any edge case is only in the sync suite, port it to async before proceeding.

- [ ] **Step 3: Run all wsl-port-forward tests to establish baseline**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run test/unit/server/wsl-port-forward.test.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/network-api.test.ts --reporter verbose 2>&1 | tail -40`
Expected: All tests pass (baseline before removal).

- [ ] **Step 4: Remove sync functions from `server/wsl-port-forward.ts`**

Remove these functions and their JSDoc comments:
1. `readManagedWslRemoteAccessPorts()` (private helper)
2. `getWslIp()` (exported)
3. `getExistingPortProxyRules()` (exported)
4. `getExistingFirewallPorts()` (exported)
5. `computeWslPortForwardingPlan()` (exported)
6. `computeWslPortForwardingTeardownPlan()` (exported)

Update imports at top of file:
- Change `import { execFile, execSync } from 'child_process'` to `import { execFile } from 'child_process'`
- Remove `import fs from 'node:fs'` entirely (keep `import fsp from 'node:fs/promises'`)

- [ ] **Step 5: Update test files**

In `test/unit/server/wsl-port-forward.test.ts`:
- Remove imports of the 5 sync functions
- Remove all `describe` blocks for sync function tests
- Remove sync tests from `FRESHELL_DISABLE_WSL_PORT_FORWARD` section

In `test/integration/server/wsl-port-forward.test.ts`:
- Remove export-existence assertions for the sync functions

In `test/integration/server/network-api.test.ts`:
- Remove dead sync mocks for `computeWslPortForwardingPlan` and `computeWslPortForwardingTeardownPlan`

- [ ] **Step 6: Run all affected tests to verify no regressions**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run test/unit/server/wsl-port-forward.test.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/network-api.test.ts --reporter verbose 2>&1 | tail -40`
Expected: All remaining tests pass.

- [ ] **Step 7: Refactor and verify**

Check the remaining file for any orphaned helper functions or type definitions that were only used by the removed sync functions. Clean up any dead code. Re-run the tests.

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run test/unit/server/wsl-port-forward.test.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/network-api.test.ts --reporter verbose 2>&1 | tail -40`
Expected: All tests still pass.

- [ ] **Step 8: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/performance-fixes add server/wsl-port-forward.ts test/unit/server/wsl-port-forward.test.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/network-api.test.ts
git -C /home/user/code/freshell/.worktrees/performance-fixes commit -m "perf: remove sync execSync wrappers from wsl-port-forward

All runtime callers already use the async variants. The sync versions
called Windows binaries via /mnt/c/ which takes 500ms-5s per call
crossing the WSL2 9P bridge. Also removes readManagedWslRemoteAccessPorts
and the execSync/fs imports that are no longer needed."
```

---

### Task 4: Add async `detectLanIpsAsync` in `bootstrap.ts`

**Files:**
- Modify: `server/bootstrap.ts` (add `getWindowsHostIpsAsync`, `detectLanIpsAsync`)
- Modify: `server/network-manager.ts` (import and use async variant in `refreshLanIps`)
- Modify: `server/network-router.ts` (update dependency type + handler)
- Modify: `server/index.ts` (export and inject async variant)
- Test: `test/unit/server/bootstrap.test.ts` (add async variant tests)
- Modify: `test/unit/server/network-manager.test.ts` (update mocks for async)
- Modify: `test/integration/server/lan-info-api.test.ts` (update mock)
- Modify: `test/integration/server/network-api.test.ts` (update mocks)

**Why:** `detectLanIps()` calls `execSync('/mnt/c/Windows/System32/ipconfig.exe')` which blocks the event loop for 12-22ms (measured). It's called at runtime from `network-manager.ts` `refreshLanIps()` and the `/lan-info` API endpoint.

**Design decisions:**

1. **Keep sync `detectLanIps` for the bootstrap-on-import path.** The `ensureEnvFile()` function (line 249) calls `detectLanIps()` synchronously during module import, before `dotenv/config` loads. This MUST stay sync because it writes `.env` before any async code can run.

2. **`refreshLanIps` becomes async.** Currently `refreshLanIps(): void` is called from:
   - `configure()` (already async) — line 420
   - `initializeFromStartup()` (already async) — line 445
   - `ensureLanIps()` (sync, called from constructor line 239 and `getStatus()` line 286)

   Making `refreshLanIps` async requires handling `ensureLanIps`:
   - Constructor call at line 239: This runs once at startup for ALLOWED_ORIGINS migration. It must stay sync because constructors can't be async. **Keep the sync `detectLanIps` call here** by having `ensureLanIps` continue to use the sync variant directly.
   - `getStatus()` call at line 286: Already async, so `await ensureLanIps()` works if we make `ensureLanIps` async. But this would change the method signature. **Simpler approach:** have `refreshLanIps` call the async variant and `ensureLanIps` continue using the sync variant for the one-time init path, OR make `ensureLanIps` check a flag set by the constructor and use async in `getStatus`.

   **Chosen approach:** The cleanest solution is:
   - Keep `ensureLanIps()` sync — it only runs once (guarded by `lanIpsInitialized` flag) and only from the constructor
   - Rename `refreshLanIps()` to `refreshLanIpsAsync()`, make it async, have it call `detectLanIpsAsync()`
   - Update the two callers (`configure`, `initializeFromStartup`) to `await` it — both are already async
   - The `ensureLanIps()` in the constructor continues using sync `detectLanIps()` (one-time startup cost, acceptable)
   - `getStatus()` calls `ensureLanIps()` which is guarded by `lanIpsInitialized` — after the constructor sets it, this is a no-op

3. **`/lan-info` endpoint becomes async.** Change the type in `NetworkRouterDeps` from `() => string[]` to `() => Promise<string[]>`, and `await` the result.

4. **Use `execFile` (callback-based) wrapped in Promise** for the async variant, matching the existing pattern in `wsl-port-forward.ts` (`execFileSettledAsync`).

- [ ] **Step 1: Write failing test for `detectLanIpsAsync`**

In `test/unit/server/bootstrap.test.ts`, add a test for the new `detectLanIpsAsync` function. Pattern it after the existing `detectLanIps` tests but with async/await.

```typescript
describe('detectLanIpsAsync', () => {
  it('returns IPs from network interfaces on non-WSL', async () => {
    // Mock isWSL to return false, mock os.networkInterfaces
    const ips = await detectLanIpsAsync()
    expect(Array.isArray(ips)).toBe(true)
  })
})
```

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run test/unit/server/bootstrap.test.ts --reporter verbose 2>&1 | tail -20`
Expected: FAIL — `detectLanIpsAsync` does not exist yet.

- [ ] **Step 2: Implement `getWindowsHostIpsAsync` and `detectLanIpsAsync` in `server/bootstrap.ts`**

Add `import { execFile } from 'child_process'` alongside existing `import { execSync } from 'child_process'`.

Add `getWindowsHostIpsAsync()`:
```typescript
function getWindowsHostIpsAsync(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('/mnt/c/Windows/System32/ipconfig.exe', [], {
      encoding: 'utf-8',
      timeout: 5000,
    }, (error, stdout) => {
      if (error || !stdout) {
        resolve([])
        return
      }

      const ips: string[] = []
      let inPhysicalAdapter = false

      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.match(/adapter/i) && trimmed.endsWith(':')) {
          const isVirtual = /vEthernet|WSL|Docker|VirtualBox|VMware/i.test(trimmed)
          inPhysicalAdapter = !isVirtual
        }
        if (inPhysicalAdapter) {
          const ipv4Match = trimmed.match(/IPv4.*?:\s*(\d+\.\d+\.\d+\.\d+)/)
          if (ipv4Match) {
            ips.push(ipv4Match[1])
          }
        }
      }

      resolve(ips)
    })
  })
}
```

Add `detectLanIpsAsync()`:
```typescript
export async function detectLanIpsAsync(): Promise<string[]> {
  if (isWSL()) {
    const windowsIps = await getWindowsHostIpsAsync()
    if (windowsIps.length > 0) {
      const scored = windowsIps.map((ip) => ({ address: ip, netmask: '255.255.255.0' }))
      scored.sort((a, b) => scoreLanIp(b.address, b.netmask) - scoreLanIp(a.address, a.netmask))
      return scored.map((ip) => ip.address)
    }
  }

  // Non-WSL path or WSL fallback: use os.networkInterfaces() (no I/O, always fast)
  const interfaces = os.networkInterfaces()
  const ips: Array<{ address: string; netmask: string }> = []

  for (const [, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push({ address: addr.address, netmask: addr.netmask })
      }
    }
  }

  ips.sort((a, b) => scoreLanIp(b.address, b.netmask) - scoreLanIp(a.address, a.netmask))
  return ips.map((ip) => ip.address)
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run test/unit/server/bootstrap.test.ts --reporter verbose 2>&1 | tail -20`
Expected: New `detectLanIpsAsync` tests pass.

- [ ] **Step 4: Update `server/network-router.ts`**

Change the `detectLanIps` type in `NetworkRouterDeps` (line 83):
```typescript
detectLanIps: () => Promise<string[]>
```

Change the `/lan-info` handler (line 412):
```typescript
router.get('/lan-info', async (_req, res) => {
  try {
    res.json({ ips: await detectLanIps() })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 5: Update `server/network-manager.ts`**

Import `detectLanIpsAsync` alongside `detectLanIps` (line 8):
```typescript
import { detectLanIps, detectLanIpsAsync } from './bootstrap.js'
```

Rename `refreshLanIps` to be async and use the async variant:
```typescript
private async refreshLanIps(): Promise<void> {
  try {
    this.lanIps = await detectLanIpsAsync()
  } catch {
    this.lanIps = []
  }
}
```

Update callers in `configure()` and `initializeFromStartup()`:
```typescript
await this.refreshLanIps()
```

Update `ensureLanIps()` to inline the sync `detectLanIps()` call. It currently delegates to `this.refreshLanIps()`, which is now async — calling it without `await` would silently drop the promise and leave `lanIps` unset. The constructor cannot be async, so `ensureLanIps` must stay sync. Inline the sync call:
```typescript
private ensureLanIps(): void {
  if (!this.lanIpsInitialized) {
    try {
      this.lanIps = detectLanIps()
    } catch {
      this.lanIps = []
    }
    this.lanIpsInitialized = true
  }
}
```

- [ ] **Step 6: Update `server/index.ts`**

Import `detectLanIpsAsync` alongside `detectLanIps` (line 1):
```typescript
import { detectLanIps, detectLanIpsAsync } from './bootstrap.js'
```

Pass `detectLanIpsAsync` as the `detectLanIps` dependency to `createNetworkRouter` (line 424):
```typescript
detectLanIps: detectLanIpsAsync,
```

- [ ] **Step 7: Update test files**

In `test/unit/server/bootstrap.test.ts`: Add tests for `detectLanIpsAsync` covering WSL and non-WSL paths.

In `test/unit/server/network-manager.test.ts`: Change mock for `detectLanIps` to use `mockResolvedValue` for the async variant where `refreshLanIps` is exercised.

In `test/integration/server/lan-info-api.test.ts`: Update the `detectLanIps` mock to return a `Promise.resolve([...])`.

In `test/integration/server/network-api.test.ts`: Update all `detectLanIps`/`detectLanIpsAsync` mocks to async.

- [ ] **Step 8: Run all affected tests**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run test/unit/server/bootstrap.test.ts test/unit/server/network-manager.test.ts test/integration/server/lan-info-api.test.ts test/integration/server/network-api.test.ts --reporter verbose 2>&1 | tail -40`
Expected: All tests pass.

- [ ] **Step 9: Refactor and verify**

Review for duplication between `getWindowsHostIps` and `getWindowsHostIpsAsync`. The parsing logic is identical and could be extracted to a shared `parseIpconfigOutput(stdout: string): string[]` helper. If the extraction is clean, do it. Re-run tests.

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run test/unit/server/bootstrap.test.ts test/unit/server/network-manager.test.ts test/integration/server/lan-info-api.test.ts test/integration/server/network-api.test.ts --reporter verbose 2>&1 | tail -40`
Expected: All tests still pass.

- [ ] **Step 10: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/performance-fixes add server/bootstrap.ts server/network-manager.ts server/network-router.ts server/index.ts test/unit/server/bootstrap.test.ts test/unit/server/network-manager.test.ts test/integration/server/lan-info-api.test.ts test/integration/server/network-api.test.ts
git -C /home/user/code/freshell/.worktrees/performance-fixes commit -m "perf: add async detectLanIpsAsync to avoid blocking event loop

The sync detectLanIps calls execSync to ipconfig.exe which blocks for
12-22ms on WSL. Runtime callers now use the async variant; the sync
version is kept only for the one-shot bootstrap-on-import path and the
NetworkManager constructor's one-time ensureLanIps call."
```

---

### Task 5: Enable incremental TypeScript compilation across all configs

**Files:**
- Modify: `tsconfig.json`
- Modify: `tsconfig.server.json`
- Modify: `tsconfig.electron.json`
- Modify: `tsconfig.electron-preload.json`

**Why:** Every `tsc` invocation does a full recompile from scratch. Adding `incremental: true` caches type-checking results in `.tsbuildinfo` files. Benchmarked at approximately 3.5x speedup on warm runs (19.3s -> 5.5s for client typecheck). Compatible with TS 5.9.3 + `noEmit` (supported since TS 4.7).

**`tsBuildInfoFile` paths are required, not optional:**
- `tsconfig.json` has `noEmit: true` so there is no default output location for the build info file
- `tsconfig.electron.json` and `tsconfig.electron-preload.json` share `outDir: ./dist/electron` and would collide without explicit paths

**All paths use `node_modules/.cache/`:** This directory is gitignored, cleared on `npm ci`, and is the standard location for build caches (used by Vite, Babel, ESLint, etc.).

- [ ] **Step 1: Verify current typecheck works**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npm run typecheck 2>&1 | tail -10`
Expected: Typecheck passes (baseline).

- [ ] **Step 2: Add `incremental` to `tsconfig.json` (client)**

Add to `compilerOptions`:
```json
"incremental": true,
"tsBuildInfoFile": "./node_modules/.cache/tsconfig.client.tsbuildinfo"
```

- [ ] **Step 3: Add `incremental` to `tsconfig.server.json`**

Add to `compilerOptions`:
```json
"incremental": true,
"tsBuildInfoFile": "./node_modules/.cache/tsconfig.server.tsbuildinfo"
```

- [ ] **Step 4: Add `incremental` to `tsconfig.electron.json`**

Add to `compilerOptions`:
```json
"incremental": true,
"tsBuildInfoFile": "./node_modules/.cache/tsconfig.electron.tsbuildinfo"
```

- [ ] **Step 5: Add `incremental` to `tsconfig.electron-preload.json`**

Add to `compilerOptions`:
```json
"incremental": true,
"tsBuildInfoFile": "./node_modules/.cache/tsconfig.electron-preload.tsbuildinfo"
```

- [ ] **Step 6: Verify typecheck still works and measure speedup**

Run twice to see cold vs warm:
```bash
cd /home/user/code/freshell/.worktrees/performance-fixes
rm -f node_modules/.cache/tsconfig.*.tsbuildinfo
time npm run typecheck 2>&1 | tail -5
time npm run typecheck 2>&1 | tail -5
```
Expected: First run creates .tsbuildinfo files. Second run is noticeably faster.

- [ ] **Step 7: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/performance-fixes add tsconfig.json tsconfig.server.json tsconfig.electron.json tsconfig.electron-preload.json
git -C /home/user/code/freshell/.worktrees/performance-fixes commit -m "perf: enable incremental TypeScript compilation across all configs

Adds incremental: true with tsBuildInfoFile to all four tsconfig files.
Benchmarked at ~3.5x speedup on warm typechecks (19s -> 5.5s). Build info
cached in node_modules/.cache/ (gitignored, cleared on clean install).
Explicit tsBuildInfoFile paths required: client has noEmit, electron
configs share outDir."
```

---

### Task 6: Lazy-load EditorPane via `React.lazy` in `PaneContainer.tsx`

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx` (line 1 imports, line 10 EditorPane import, EditorPane render site)
- Test: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Test: `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`

**Why:** Monaco editor (~3 MB bundle) is imported eagerly even when the user never opens an editor pane. `React.lazy` defers the import to when an editor pane is first rendered.

**Scope narrowed:** Only lazy-load EditorPane. BrowserPane savings are negligible (<10 KB incremental) and not worth the test churn.

**Suspense fallback:** Use `fallback={null}` since the chunk loads from local filesystem in <1ms — no visible flash.

**Test impact:** Tests that mock EditorPane via `vi.mock` will still work because `vi.mock` intercepts at the module level before `React.lazy` resolves. Tests that render editor panes may need a `<Suspense>` boundary and async assertions (`waitFor`/`findBy*` instead of `getBy*`).

- [ ] **Step 1: Run PaneContainer tests to establish baseline**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx --reporter verbose 2>&1 | tail -30`
Expected: All existing tests pass (baseline).

- [ ] **Step 2: Convert EditorPane to lazy import**

In `src/components/panes/PaneContainer.tsx`:

Update line 1 — add `lazy` and `Suspense` to the React import:
```typescript
import { useRef, useCallback, useMemo, useState, useEffect, lazy, Suspense } from 'react'
```

Replace line 10:
```typescript
import EditorPane from './EditorPane'
```
with:
```typescript
const EditorPane = lazy(() => import('./EditorPane'))
```

- [ ] **Step 3: Wrap EditorPane render in Suspense**

Find where `<EditorPane` is rendered (around line 712 inside the `renderContent` function) and wrap it:
```tsx
if (content.kind === 'editor') {
  return (
    <ErrorBoundary key={paneId} label="Editor">
      <Suspense fallback={null}>
        <EditorPane
          paneId={paneId}
          tabId={tabId}
          filePath={content.filePath}
          language={content.language}
          readOnly={content.readOnly}
          content={content.content}
          viewMode={content.viewMode}
        />
      </Suspense>
    </ErrorBoundary>
  )
}
```

- [ ] **Step 4: Update tests to handle async rendering**

In test files that render editor panes, ensure:
1. Any test render wrapper includes a `<Suspense>` boundary
2. Switch from `getBy*` to `await findBy*` or `await waitFor(...)` for editor pane assertions

- [ ] **Step 5: Run tests to verify**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx --reporter verbose 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Step 6: Verify Vite produces a separate chunk**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npm run build:client 2>&1 | tail -15`
Expected: Vite output shows a separate chunk for EditorPane (look for a chunk with "Editor" or "monaco" in the name).

- [ ] **Step 7: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/performance-fixes add src/components/panes/PaneContainer.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx
git -C /home/user/code/freshell/.worktrees/performance-fixes commit -m "perf: lazy-load EditorPane via React.lazy

Monaco editor (~3MB) is now only loaded when the user actually opens an
editor pane, reducing initial bundle size. BrowserPane kept eager
(negligible savings). Uses fallback={null} since chunk loads from local
filesystem in <1ms."
```

---

### Task 7: Convert sync fs ops to async in `local-file-router.ts`

**Files:**
- Modify: `server/local-file-router.ts` (replace sync handler with async)

**Why:** `fs.existsSync` and `fs.statSync` in an Express GET handler block the event loop. Also fixes a TOCTOU race between the separate `existsSync` + `statSync` calls — a file could be deleted between the two calls.

**Express 4.22 async error handling:** Express 4.22 does not auto-catch rejected promises from async handlers. The proposed code wraps everything in `try/catch`, matching the established project pattern in `files-router.ts`, `ai-router.ts`, `sessions-router.ts`, etc. The catch block discriminates `ENOENT` from other errors to avoid masking permission/IO failures as 404s.

- [ ] **Step 1: Examine the current handler and check for existing tests**

Run:
```bash
cd /home/user/code/freshell/.worktrees/performance-fixes
cat server/local-file-router.ts
find test -name '*local-file*' -o -name '*localFile*' 2>/dev/null
```
Expected: Current handler uses `fs.existsSync` + `fs.statSync`. There may be no dedicated test file (the e2e suite covers it).

- [ ] **Step 2: Convert the handler to async with proper error discrimination**

Replace the `fs` import:
```typescript
import fsp from 'fs/promises'
```
(Remove `import fs from 'fs'` — no longer needed.)

Replace the second middleware handler:
```typescript
}, async (req, res) => {
  const filePath = req.query.path as string
  if (!filePath) {
    return res.status(400).json({ error: 'path query parameter required' })
  }

  const resolved = path.resolve(filePath)

  try {
    const stat = await fsp.stat(resolved)
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Cannot serve directories' })
    }
    res.sendFile(resolved)
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' })
    }
    return res.status(500).json({ error: err.message })
  }
})
```

- [ ] **Step 3: Run any related tests**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run --reporter verbose 2>&1 | grep -i 'local.file' | head -10`
Expected: Any matching tests pass. If none exist, rely on the broader test suite.

- [ ] **Step 4: Verify typecheck passes**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx tsc -p tsconfig.server.json --noEmit 2>&1 | tail -10`
Expected: No type errors.

- [ ] **Step 5: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/performance-fixes add server/local-file-router.ts
git -C /home/user/code/freshell/.worktrees/performance-fixes commit -m "perf: use async fs.promises.stat in local-file-router request handler

Replaces fs.existsSync + fs.statSync with a single await fsp.stat().
Eliminates event loop blocking and fixes a TOCTOU race between the
separate existence check and stat call. Discriminates ENOENT from
other errors to avoid masking permission/IO failures as 404s."
```

---

### Task 8: Wrap TerminalView and TabsView in `React.memo` + fix callback memoization

**Files:**
- Modify: `src/components/TerminalView.tsx` (line 217 — export, bottom of file)
- Modify: `src/components/TabsView.tsx` (line 474 — export, bottom of file)
- Modify: `src/App.tsx` (line 1073, 1080 — memoize `onOpenTab` callbacks)
- Test: `test/unit/client/components/TerminalView.test.tsx`
- Test: `test/unit/client/components/TabsView.test.tsx`

**Why:** These large components re-render on every parent re-render even when their props haven't changed. TerminalView (2,406 lines) has a parent PaneContainer with 23 `useAppSelector` calls. TabsView (807 lines) has parent App.tsx with 8 selectors.

**Effectiveness context:**
- Both components have internal `useAppSelector` calls (13 in TerminalView, 6 in TabsView) that trigger re-renders independently of props — `React.memo` only prevents re-renders from parent prop changes.
- TerminalView benefits most (~20-40% re-render reduction from parent changes).
- TabsView's memo is **completely defeated** without also fixing inline callbacks. `App.tsx` passes `onOpenTab={() => setView('terminal')}` which creates a new function reference on every render.
- The same inline callback pattern exists on `OverviewView` at line 1073. The memoized callback should be shared by both.

- [ ] **Step 1: Run component tests to establish baseline**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TabsView.test.tsx --reporter verbose 2>&1 | tail -30`
Expected: All tests pass (baseline).

- [ ] **Step 2: Wrap TerminalView in React.memo**

In `src/components/TerminalView.tsx`:

Change the function declaration (line 217):
```typescript
export default function TerminalView({ tabId, paneId, paneContent, hidden }: TerminalViewProps) {
```
to:
```typescript
function TerminalViewInner({ tabId, paneId, paneContent, hidden }: TerminalViewProps) {
```

At the bottom of the file (after the function's closing brace), add:
```typescript
const TerminalView = memo(TerminalViewInner)
export default TerminalView
```

Ensure `memo` is imported from `react` (check existing imports — if only named imports exist like `import { useRef, ... } from 'react'`, add `memo` to the destructuring).

- [ ] **Step 3: Wrap TabsView in React.memo**

In `src/components/TabsView.tsx`:

Change the function declaration (line 474):
```typescript
export default function TabsView({ onOpenTab }: { onOpenTab?: () => void }) {
```
to:
```typescript
function TabsViewInner({ onOpenTab }: { onOpenTab?: () => void }) {
```

At the bottom of the file, add:
```typescript
const TabsView = memo(TabsViewInner)
export default TabsView
```

Ensure `memo` is imported from `react`.

- [ ] **Step 4: Memoize `onOpenTab` callback in App.tsx**

In `src/App.tsx`, add a memoized callback in the component body (near the other `useCallback` declarations, around line 309-316):
```typescript
const handleOpenTab = useCallback(() => setView('terminal'), [])
```

Replace both inline callbacks:
- Line 1073: `<OverviewView onOpenTab={() => setView('terminal')} />` becomes `<OverviewView onOpenTab={handleOpenTab} />`
- Line 1080: `<TabsView onOpenTab={() => setView('terminal')} />` becomes `<TabsView onOpenTab={handleOpenTab} />`

Note: `useCallback` is already imported in `App.tsx` (line 1), so no import change needed.

- [ ] **Step 5: Run component tests to verify no regressions**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npx vitest run test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TabsView.test.tsx --reporter verbose 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Step 6: Verify typecheck passes**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npm run typecheck:client 2>&1 | tail -5`
Expected: No type errors.

- [ ] **Step 7: Commit**

```bash
git -C /home/user/code/freshell/.worktrees/performance-fixes add src/components/TerminalView.tsx src/components/TabsView.tsx src/App.tsx
git -C /home/user/code/freshell/.worktrees/performance-fixes commit -m "perf: wrap TerminalView and TabsView in React.memo

TerminalView's parent PaneContainer has 23 selectors causing frequent
re-renders unrelated to the terminal. React.memo prevents ~20-40% of
these. TabsView's inline onOpenTab callback is also memoized via
useCallback in App.tsx (shared with OverviewView) to avoid defeating
the memo boundary."
```

---

### Final verification

After all 8 tasks are complete:

- [ ] **Run the full test suite**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npm run test:vitest -- run 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Run the server config tests**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npm run test:vitest -- run --config vitest.server.config.ts 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Run typecheck**

Run: `cd /home/user/code/freshell/.worktrees/performance-fixes && npm run typecheck 2>&1 | tail -10`
Expected: No type errors.

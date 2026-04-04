# Performance Fixes Test Plan

**Plan under test:** `docs/plans/2026-04-03-performance-fixes.md`

**Harnesses:**
- `vitest` (default config, `vitest.config.ts`) -- jsdom environment, client-side tests
- `vitest:server` (server config, `vitest.server.config.ts`) -- node environment, server-side tests
- `tsc` -- TypeScript compiler for type-checking
- `vite build` -- Vite bundler for chunk-splitting verification

---

## Task 1: tsx watch --exclude patterns in dev scripts

No automated test infrastructure for npm script contents. Verified through the following invariant.

### T1.1 -- Dev scripts contain --exclude patterns for all three directories

- **Name**: Dev scripts exclude .worktrees, demo-projects, and dist from tsx watch
- **Type**: invariant
- **Disposition**: new
- **Harness**: vitest:server
- **Preconditions**: `package.json` exists at repo root.
- **Actions**: Read `package.json`, parse the `dev` and `dev:server` script strings.
- **Assertions**:
  - Both scripts contain `--exclude '.worktrees/**'`
  - Both scripts contain `--exclude 'demo-projects/**'`
  - Both scripts contain `--exclude 'dist/**'`
  - Neither script contains the deprecated `--ignore` flag
- **Why this matters**: If exclude patterns are dropped during a merge or refactor, tsx watch will scan 58 GB of worktree data, causing severe dev-server startup latency and continuous filesystem pressure.
- **File**: `test/unit/server/dev-scripts-exclude.test.ts`

---

## Task 2: Replace spin lock busy-wait with Atomics.wait

### T2.1 -- Existing lock contention tests pass after Atomics.wait replacement

- **Name**: MCP config-writer lock acquire/release cycle works with Atomics.wait sleep
- **Type**: regression
- **Disposition**: existing
- **Harness**: vitest:server
- **Preconditions**: `server/mcp/config-writer.ts` has `Atomics.wait` instead of busy-wait loop.
- **Actions**: Run `test/unit/server/mcp/config-writer.test.ts` (all ~15 describe blocks).
- **Assertions**: All existing tests pass, specifically:
  - "opencode injection acquires and releases a lock file to serialize sidecar access"
  - "lock retry exhaustion throws an error instead of proceeding without lock"
  - "releaseLock only removes lock if this process acquired it"
- **Why this matters**: The lock mechanism serializes concurrent MCP config writes. If Atomics.wait changes the timing characteristics in a way that breaks retry logic, sidecar config files can be corrupted.
- **File**: `test/unit/server/mcp/config-writer.test.ts`

### T2.2 -- Spin lock busy-wait is not present in source

- **Name**: config-writer does not contain CPU-burning busy-wait patterns
- **Type**: invariant
- **Disposition**: new
- **Harness**: vitest:server
- **Preconditions**: Source file exists.
- **Actions**: Read `server/mcp/config-writer.ts` source content.
- **Assertions**:
  - Source does NOT contain the pattern `while (Date.now()` (busy-wait)
  - Source DOES contain `Atomics.wait` (the replacement)
- **Why this matters**: A busy-wait spin loop burning CPU for 100ms per retry iteration directly degrades server responsiveness under lock contention. This invariant prevents reintroduction.
- **File**: `test/unit/server/mcp/config-writer-no-spinlock.test.ts`

---

## Task 3: Remove sync execSync exports from wsl-port-forward.ts

### T3.1 -- Async planning tests cover all edge cases formerly in sync suite

- **Name**: WSL port forwarding async planning covers all sync edge cases
- **Type**: differential
- **Disposition**: existing
- **Harness**: vitest:server
- **Preconditions**: Sync functions removed from `server/wsl-port-forward.ts`. Sync test describe blocks removed.
- **Actions**: Run `test/unit/server/wsl-port-forward.test.ts`.
- **Assertions**: All remaining tests pass. The `computeWslPortForwardingPlanAsync` and `computeWslPortForwardingTeardownPlanAsync` describe blocks cover:
  - WSL IP resolution success and failure
  - Port proxy rule parsing and matching
  - Firewall port detection
  - Noop vs ready vs error statuses
  - Disabled-by-env behavior
- **Why this matters**: If the sync suite contained edge cases not ported to async, removing the sync tests loses coverage of real failure modes that affect users enabling WSL remote access.
- **File**: `test/unit/server/wsl-port-forward.test.ts`

### T3.2 -- Integration export assertions updated for removed sync functions

- **Name**: WSL module exports only async planning helpers (no sync planning exports)
- **Type**: integration
- **Disposition**: extend
- **Harness**: vitest:server
- **Preconditions**: Sync functions removed from source.
- **Actions**: Run `test/integration/server/wsl-port-forward.test.ts`.
- **Assertions**:
  - `computeWslPortForwardingPlanAsync` is exported as a function
  - `computeWslPortForwardingTeardownPlanAsync` is exported as a function
  - `computeWslPortForwardingPlan` is NOT exported (removed)
  - `computeWslPortForwardingTeardownPlan` is NOT exported (removed)
  - `getWslIp` is NOT exported (removed)
  - `getExistingPortProxyRules` is NOT exported (removed)
  - `getExistingFirewallPorts` is NOT exported (removed)
  - `setupWslPortForwarding` is NOT exported (preexisting guard)
- **Why this matters**: If a sync function is accidentally left exported, a future developer might call it from a hot path, reintroducing event-loop blocking.
- **File**: `test/integration/server/wsl-port-forward.test.ts`

### T3.3 -- Network API integration tests pass without sync mocks

- **Name**: Network API works with async-only WSL port forwarding
- **Type**: regression
- **Disposition**: extend
- **Harness**: vitest:server
- **Preconditions**: Dead sync mocks for `computeWslPortForwardingPlan` and `computeWslPortForwardingTeardownPlan` removed from test setup.
- **Actions**: Run `test/integration/server/network-api.test.ts`.
- **Assertions**: All ~35 existing test cases pass, including:
  - Network status endpoint shape
  - WSL repair nag suppression
  - Firewall configuration flows
  - Remote access disable flows
- **Why this matters**: The network API is the primary interface for remote access management. Broken mocks would mask real failures.
- **File**: `test/integration/server/network-api.test.ts`

### T3.4 -- Source file has no execSync import or sync fs import

- **Name**: wsl-port-forward has no sync child_process or fs imports
- **Type**: invariant
- **Disposition**: new
- **Harness**: vitest:server
- **Preconditions**: Source file exists.
- **Actions**: Read `server/wsl-port-forward.ts` source content.
- **Assertions**:
  - Source does NOT import `execSync` from `child_process`
  - Source does NOT import `fs` (sync variant); only `fsp` from `node:fs/promises`
- **Why this matters**: The sync imports are the root cause of 500ms-5s event loop blocks when calling Windows binaries via the 9P bridge. This prevents reintroduction.
- **File**: `test/unit/server/wsl-port-forward-no-sync-imports.test.ts`

---

## Task 4: Add async detectLanIpsAsync in bootstrap.ts

### T4.1 -- detectLanIpsAsync returns IPs on non-WSL (os.networkInterfaces path)

- **Name**: Async LAN IP detection returns valid IPs from OS network interfaces
- **Type**: unit
- **Disposition**: new
- **Harness**: vitest:server
- **Preconditions**: `isWSL` mocked to return `false`. `os.networkInterfaces` mocked with test data.
- **Actions**: Call `await detectLanIpsAsync()`.
- **Assertions**:
  - Returns an array of IPv4 addresses
  - Excludes loopback/internal addresses
  - Matches the output of `detectLanIps()` given the same mock data (behavioral equivalence)
- **Why this matters**: Non-WSL is the common case. If async returns different results than sync, LAN URL advertisement breaks.
- **File**: `test/unit/server/bootstrap.test.ts`

### T4.2 -- detectLanIpsAsync returns IPs on WSL (ipconfig.exe path)

- **Name**: Async LAN IP detection calls ipconfig.exe asynchronously on WSL
- **Type**: unit
- **Disposition**: new
- **Harness**: vitest:server
- **Preconditions**: `isWSL` mocked to return `true`. `execFile` mocked to return ipconfig output.
- **Actions**: Call `await detectLanIpsAsync()`.
- **Assertions**:
  - Returns physical adapter IPs from ipconfig output
  - Excludes virtual adapters (vEthernet, WSL, Docker)
  - Falls back to `os.networkInterfaces()` when ipconfig fails
- **Why this matters**: WSL users see no LAN URL if ipconfig parsing fails. The async path must behave identically to the sync path.
- **File**: `test/unit/server/bootstrap.test.ts`

### T4.3 -- NetworkManager uses async detectLanIpsAsync in refreshLanIps

- **Name**: Network manager refreshes LAN IPs asynchronously
- **Type**: unit
- **Disposition**: extend
- **Harness**: vitest:server
- **Preconditions**: `detectLanIps` mock updated from `mockReturnValue` to `mockResolvedValue` for the async variant (or `detectLanIpsAsync` mock added).
- **Actions**: Run `test/unit/server/network-manager.test.ts`.
- **Assertions**: All existing NetworkManager tests pass, confirming:
  - `configure()` correctly awaits LAN IP refresh
  - `initializeFromStartup()` correctly awaits LAN IP refresh
  - `ensureLanIps()` still works synchronously in the constructor path
- **Why this matters**: If `refreshLanIps` silently drops the async promise (fire-and-forget), LAN IPs will be empty on first configure call, breaking remote access setup.
- **File**: `test/unit/server/network-manager.test.ts`

### T4.4 -- /lan-info endpoint returns async results

- **Name**: LAN info API endpoint returns IPs from async detectLanIps
- **Type**: integration
- **Disposition**: extend
- **Harness**: vitest:server
- **Preconditions**: `detectLanIps` dep in router changed to `() => Promise<string[]>`. Test setup mock updated to return `Promise.resolve(...)`.
- **Actions**: Run `test/integration/server/lan-info-api.test.ts`.
- **Assertions**:
  - GET `/api/lan-info` returns 200 with `{ ips: [...] }`
  - IP addresses are valid IPv4 format
  - Auth enforcement still works (401 for missing/invalid tokens)
- **Why this matters**: The LAN info endpoint is called by the client to display the remote access URL. If the async conversion breaks the handler, users cannot discover their LAN URL.
- **File**: `test/integration/server/lan-info-api.test.ts`

### T4.5 -- Network API integration passes with async bootstrap mock

- **Name**: Network API works with async detectLanIps mock
- **Type**: regression
- **Disposition**: extend
- **Harness**: vitest:server
- **Preconditions**: Bootstrap mock updated from `mockReturnValue` to async for `detectLanIpsAsync` usage.
- **Actions**: Run `test/integration/server/network-api.test.ts`.
- **Assertions**: All existing tests pass.
- **Why this matters**: The network API integration test exercises the full request lifecycle including detectLanIps mocks. Stale sync mocks would cause type errors or undefined results.
- **File**: `test/integration/server/network-api.test.ts`

---

## Task 5: Enable incremental TypeScript compilation

### T5.1 -- All four tsconfig files have incremental enabled

- **Name**: TypeScript configs enable incremental compilation with explicit tsBuildInfoFile paths
- **Type**: invariant
- **Disposition**: new
- **Harness**: vitest (default config, runs in node-compatible mode via setup)
- **Preconditions**: tsconfig files exist.
- **Actions**: Read and parse each of `tsconfig.json`, `tsconfig.server.json`, `tsconfig.electron.json`, `tsconfig.electron-preload.json`.
- **Assertions**:
  - Each has `compilerOptions.incremental === true`
  - Each has a `compilerOptions.tsBuildInfoFile` path under `node_modules/.cache/`
  - All four `tsBuildInfoFile` paths are distinct (no collisions)
- **Why this matters**: If incremental is removed during a merge, every typecheck goes back to full 19s cold builds. Colliding tsBuildInfoFile paths would cause one config to invalidate another's cache.
- **File**: `test/unit/server/tsconfig-incremental.test.ts`

### T5.2 -- Typecheck passes with incremental enabled

- **Name**: TypeScript typecheck succeeds with incremental compilation
- **Type**: scenario
- **Disposition**: existing
- **Harness**: tsc (invoked via `npm run typecheck` or `npm run check`)
- **Preconditions**: All four tsconfig files modified.
- **Actions**: Run `tsc --noEmit -p tsconfig.json` and `tsc --noEmit -p tsconfig.server.json`.
- **Assertions**: Exit code 0, no type errors.
- **Why this matters**: If `incremental: true` is incompatible with other compiler options, the build pipeline breaks entirely.
- **File**: N/A (CLI invocation, verified during implementation step)

---

## Task 6: Lazy-load EditorPane via React.lazy

### T6.1 -- PaneContainer tests pass with lazy EditorPane

- **Name**: Pane container renders all content types including lazy-loaded editor
- **Type**: regression
- **Disposition**: existing
- **Harness**: vitest (jsdom)
- **Preconditions**: `EditorPane` converted to `React.lazy` import, wrapped in `<Suspense>`.
- **Actions**: Run `test/unit/client/components/panes/PaneContainer.test.tsx`.
- **Assertions**: All ~40 existing tests pass, including:
  - "renders EditorPane for editor content" (T6.1a)
  - Terminal content rendering
  - Browser content rendering
  - Pane close behavior
  - Split pane rendering
  - Hidden prop propagation
- **Why this matters**: If `React.lazy` breaks the render path, users cannot open editor panes at all.
- **File**: `test/unit/client/components/panes/PaneContainer.test.tsx`

### T6.2 -- PaneContainer createContent tests pass

- **Name**: Pane content creation still works with lazy editor
- **Type**: regression
- **Disposition**: existing
- **Harness**: vitest (jsdom)
- **Preconditions**: Same as T6.1.
- **Actions**: Run `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`.
- **Assertions**: All 4 existing tests pass.
- **Why this matters**: Content creation logic must not be affected by the import change.
- **File**: `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`

### T6.3 -- Vite produces a separate chunk for EditorPane/Monaco

- **Name**: Editor code is split into a separate lazy-loaded chunk
- **Type**: scenario
- **Disposition**: new
- **Harness**: vite build (invoked via `npm run build:client`)
- **Preconditions**: EditorPane uses `React.lazy(() => import('./EditorPane'))`.
- **Actions**: Run `npm run build:client`, inspect output chunk listing.
- **Assertions**: Build output shows a separate chunk containing editor/Monaco code, distinct from the main application chunk.
- **Why this matters**: If Vite does not code-split the lazy import (e.g., due to re-export chains or barrel imports), the entire purpose of the change is defeated -- users still pay the 3 MB Monaco cost on initial load.
- **File**: N/A (build output inspection during implementation step)

### T6.4 -- EditorPane import is lazy, not static

- **Name**: PaneContainer uses React.lazy for EditorPane, not a static import
- **Type**: invariant
- **Disposition**: new
- **Harness**: vitest (jsdom)
- **Preconditions**: Source file exists.
- **Actions**: Read `src/components/panes/PaneContainer.tsx` source content.
- **Assertions**:
  - Source contains `lazy(() => import('./EditorPane'))` pattern
  - Source does NOT contain `import EditorPane from './EditorPane'` (static import)
  - Source contains `<Suspense` wrapping the EditorPane render
- **Why this matters**: A static import accidentally restored during a merge would silently negate the lazy-loading optimization.
- **File**: `test/unit/client/components/panes/PaneContainer.lazy-editor.test.ts`

---

## Task 7: Convert sync fs ops to async in local-file-router.ts

### T7.1 -- Local file endpoint returns files via async stat

- **Name**: Local file endpoint serves files using async filesystem operations
- **Type**: regression
- **Disposition**: existing
- **Harness**: vitest:server
- **Preconditions**: `local-file-router.ts` converted from `fs.existsSync` + `fs.statSync` to `fsp.stat`.
- **Actions**: Run the `/local-file auth` tests within `test/integration/server/network-api.test.ts`.
- **Assertions**:
  - Accepts requests with valid cookie (200)
  - Accepts requests with valid header (200)
  - Rejects requests without cookie or header (401)
  - Rejects requests with wrong cookie (401)
- **Why this matters**: The local file endpoint is used by the editor pane to load files. Auth or file-serving breakage would prevent file editing entirely.
- **File**: `test/integration/server/network-api.test.ts`

### T7.2 -- Local file endpoint handles missing files correctly

- **Name**: Local file endpoint returns 404 for nonexistent files
- **Type**: unit
- **Disposition**: new
- **Harness**: vitest:server
- **Preconditions**: Async handler deployed.
- **Actions**: Send GET to `/local-file?path=/nonexistent/file.txt` with valid auth.
- **Assertions**:
  - Returns 404 with `{ error: 'File not found' }` for nonexistent files
  - Returns 400 with `{ error: 'Cannot serve directories' }` for directories
  - Returns 400 with `{ error: 'path query parameter required' }` when path is missing
  - Returns 500 with an error message for permission errors (not masked as 404)
- **Why this matters**: The sync-to-async conversion also fixes a TOCTOU race. The new error discrimination (ENOENT vs other) must not mask permission or I/O errors as 404s, which would confuse users trying to open files they don't have access to.
- **File**: `test/unit/server/local-file-router.test.ts`

### T7.3 -- Source has no sync fs imports

- **Name**: local-file-router uses async fs only
- **Type**: invariant
- **Disposition**: new
- **Harness**: vitest:server
- **Preconditions**: Source file exists.
- **Actions**: Read `server/local-file-router.ts` source content.
- **Assertions**:
  - Source does NOT import `fs` from `'fs'` (sync)
  - Source does NOT contain `existsSync` or `statSync`
  - Source imports `fsp` from `'fs/promises'` or uses `fs/promises`
- **Why this matters**: Sync filesystem operations in an Express handler block the entire event loop. This prevents reintroduction of the blocking pattern.
- **File**: `test/unit/server/local-file-router-no-sync.test.ts`

---

## Task 8: Wrap TerminalView and TabsView in React.memo

### T8.1 -- TerminalView tests pass after React.memo wrapping

- **Name**: TerminalView behavior is preserved through React.memo
- **Type**: regression
- **Disposition**: existing
- **Harness**: vitest (jsdom)
- **Preconditions**: TerminalView wrapped in `React.memo`.
- **Actions**: Run all TerminalView test files:
  - `test/unit/client/components/TerminalView.test.tsx`
  - `test/unit/client/components/TerminalView.keyboard.test.tsx`
  - `test/unit/client/components/TerminalView.lifecycle.test.tsx`
  - `test/unit/client/components/TerminalView.search.test.tsx`
  - `test/unit/client/components/TerminalView.osc52.test.tsx`
  - `test/unit/client/components/TerminalView.linkWarning.test.tsx`
  - `test/unit/client/components/TerminalView.rateLimit.test.ts`
  - `test/unit/client/components/TerminalView.renderer.test.tsx`
  - `test/unit/client/components/TerminalView.resumeSession.test.tsx`
  - `test/unit/client/components/TerminalView.urlClick.test.tsx`
  - `test/unit/client/components/TerminalView.visibility.test.tsx`
  - `test/unit/client/components/TerminalView.lastInputAt.test.tsx`
  - `test/unit/client/components/TerminalView.mobile-viewport.test.tsx`
- **Assertions**: All existing tests pass. `React.memo` is transparent to test assertions since tests render the component directly with props.
- **Why this matters**: TerminalView is a 2400-line component handling the core terminal UX. Any behavioral regression would break the primary user workflow.
- **File**: `test/unit/client/components/TerminalView*.test.tsx` (all files matching this glob)

### T8.2 -- TabsView tests pass after React.memo wrapping

- **Name**: TabsView behavior is preserved through React.memo
- **Type**: regression
- **Disposition**: existing
- **Harness**: vitest (jsdom)
- **Preconditions**: TabsView wrapped in `React.memo`.
- **Actions**: Run all TabsView test files:
  - `test/unit/client/components/TabsView.test.tsx`
  - `test/unit/client/components/TabsView.ws-error.test.tsx`
- **Assertions**: All existing tests pass.
- **Why this matters**: TabsView is the tab management overview. Memo wrapping should be transparent but could interact with how tests set up Redux state.
- **File**: `test/unit/client/components/TabsView*.test.tsx`

### T8.3 -- App.tsx onOpenTab callback is memoized

- **Name**: App passes stable onOpenTab reference to TabsView and OverviewView
- **Type**: invariant
- **Disposition**: new
- **Harness**: vitest (jsdom)
- **Preconditions**: Source file exists.
- **Actions**: Read `src/App.tsx` source content.
- **Assertions**:
  - Source contains a `useCallback` wrapping the `setView('terminal')` call (pattern: `useCallback(() => setView('terminal')`)
  - The `<TabsView` render does NOT contain an inline `() =>` arrow function for `onOpenTab`
  - The `<OverviewView` render does NOT contain an inline `() =>` arrow function for `onOpenTab`
  - Both components receive the same memoized callback reference (same variable name)
- **Why this matters**: Without memoized callbacks, `React.memo` on TabsView is completely defeated -- every parent re-render creates a new function reference, causing TabsView to re-render anyway. The user sees no performance benefit from the memo wrapping.
- **File**: `test/unit/client/components/App.memoized-callbacks.test.ts`

---

## Cross-cutting: Full suite regression

### TX.1 -- Full test suite passes after all changes

- **Name**: Complete test suite passes after all 8 performance fixes
- **Type**: regression
- **Disposition**: existing
- **Harness**: vitest (default config) + vitest:server
- **Preconditions**: All 8 tasks complete.
- **Actions**: Run `npm run test:vitest -- run` (default config) and `npm run test:vitest -- run --config vitest.server.config.ts` (server config).
- **Assertions**: All tests pass in both configurations.
- **Why this matters**: Performance fixes touch server infrastructure (locks, I/O, imports), build config, and client rendering. Any unexpected interaction between changes would surface here.
- **File**: Full suite

### TX.2 -- TypeScript typecheck passes for all configs

- **Name**: Typecheck passes for client, server, and electron configs
- **Type**: regression
- **Disposition**: existing
- **Harness**: tsc
- **Preconditions**: All 8 tasks complete.
- **Actions**: Run `npm run typecheck` (or `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.server.json --noEmit`).
- **Assertions**: Exit code 0, no type errors.
- **Why this matters**: Tasks 3, 4, and 7 change function signatures and import types. Type errors would prevent builds and break the production server.
- **File**: N/A (CLI invocation)

---

## Test count summary

| Task | Existing | Extend | New | Total |
|------|----------|--------|-----|-------|
| 1 -- tsx watch exclude | 0 | 0 | 1 | 1 |
| 2 -- Atomics.wait | 1 | 0 | 1 | 2 |
| 3 -- Remove sync WSL | 1 | 2 | 1 | 4 |
| 4 -- Async detectLanIps | 0 | 3 | 2 | 5 |
| 5 -- Incremental TS | 0 | 0 | 1 | 1 |
| 6 -- Lazy EditorPane | 2 | 0 | 1 | 3 |
| 7 -- Async local-file-router | 1 | 0 | 2 | 3 |
| 8 -- React.memo | 2 | 0 | 1 | 3 |
| Cross-cutting | 2 | 0 | 0 | 2 |
| **Total** | **9** | **5** | **10** | **24** |

### New test files to create

1. `test/unit/server/dev-scripts-exclude.test.ts` (T1.1)
2. `test/unit/server/mcp/config-writer-no-spinlock.test.ts` (T2.2)
3. `test/unit/server/wsl-port-forward-no-sync-imports.test.ts` (T3.4)
4. `test/unit/server/tsconfig-incremental.test.ts` (T5.1)
5. `test/unit/client/components/panes/PaneContainer.lazy-editor.test.ts` (T6.4)
6. `test/unit/server/local-file-router.test.ts` (T7.2)
7. `test/unit/server/local-file-router-no-sync.test.ts` (T7.3)
8. `test/unit/client/components/App.memoized-callbacks.test.ts` (T8.3)

### Existing test files to extend

1. `test/integration/server/wsl-port-forward.test.ts` (T3.2 -- update export assertions)
2. `test/integration/server/network-api.test.ts` (T3.3 / T4.5 -- remove sync mocks, update async mocks)
3. `test/unit/server/bootstrap.test.ts` (T4.1 / T4.2 -- add detectLanIpsAsync tests)
4. `test/unit/server/network-manager.test.ts` (T4.3 -- update mock for async)
5. `test/integration/server/lan-info-api.test.ts` (T4.4 -- update mock to return Promise)

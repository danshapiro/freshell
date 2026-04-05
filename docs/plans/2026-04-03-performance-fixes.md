# Performance Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the confirmed runtime and build-time performance hotspots in Freshell without changing user-visible behavior, while preserving the few sync boundaries that are architecturally required.

**Architecture:** Keep `server/bootstrap.ts` synchronous for import-time `.env` creation and one-shot constructor initialization, but move every steady-state network and file-serving path onto async I/O. On the client, split Monaco behind a lazy editor boundary with an accessible loading shell and make `TabsView` and `TerminalView` respect memo boundaries by stabilizing parent props. Tooling work stays evidence-driven: add incremental TypeScript caches across all active configs, and explicitly do not touch `tsx watch` scripts unless execution-time reproduction proves the original concern is real.

**Tech Stack:** TypeScript 5.x, Node.js 22, Express 4, React 18, Redux Toolkit, Vite 6, Vitest, Playwright.

---

## Acceptance Criteria

- `package.json` remains unchanged unless an execution-time `tsx watch` probe proves that `.worktrees`, `demo-projects`, or `dist` actually trigger restarts from the current repo setup.
- The runtime LAN-detection path is async everywhere except the required sync bootstrap/import path and the constructor-only lazy initialization path.
- `server/wsl-port-forward.ts` no longer exports dead sync wrappers that shell out through `execSync`; runtime callers keep using async plan helpers only.
- `/api/lan-info` and `/local-file` preserve their success payloads and now return deterministic async 400/404/500 responses without sync filesystem or sync process execution in steady-state request handling.
- All four TypeScript configs write `.tsbuildinfo` files to `node_modules/.cache`, and warm reruns are materially faster than cold runs.
- Opening an editor pane loads Monaco lazily, shows an accessible loading state while the chunk resolves, and still produces a working editor in browser E2E.
- Stable parent rerenders do not rerender `TabsView` or `TerminalView` when their props are unchanged.
- `npm run build:client`, `npm run build:electron`, the targeted unit/integration/browser checks below, and `FRESHELL_TEST_SUMMARY="performance fixes" npm run check` all pass.

## Strategy Gate

- Do not implement the original `tsx watch --exclude` task up front. Current evidence does not establish a real bug, and adding cargo-cult flags to `package.json` is not a performance fix. If an execution-time probe later proves a real restart path, that is a separate, evidence-backed follow-up.
- Do not make bootstrap async. `server/bootstrap.ts` runs before `dotenv/config`; that sync boundary is real. The only acceptable split is sync bootstrap plus async steady-state runtime callers.
- Do not keep parallel public sync and async WSL planning APIs. The sync wrappers are dead runtime code; maintaining both surfaces increases cost without value.
- Do not use `fallback={null}` for the lazy editor. A blank pane is worse than a tiny loading shell, and the loading shell gives the tests and the user a stable contract.
- Do not weaken or delete valid tests to get green. Replace obsolete sync-surface tests with stronger async-surface or user-visible behavior checks.

## File Map

- `server/bootstrap.ts`
  Responsibility: sync bootstrap helpers plus shared LAN-detection logic. Add shared `ipconfig.exe` parsing and `detectLanIpsAsync()` while keeping `detectLanIps()` for bootstrap/import-time callers.
- `server/network-manager.ts`
  Responsibility: runtime LAN-IP refresh and allowed-origins rebuild. Convert steady-state refreshes to awaited async work and keep the constructor-only sync initialization path.
- `server/network-router.ts`
  Responsibility: `/api/network/*` routes. Change `/api/lan-info` to await an async dependency and return a controlled 500 on failure.
- `server/index.ts`
  Responsibility: wire the async LAN detector into the network router while preserving bootstrap import ordering.
- `server/wsl-port-forward.ts`
  Responsibility: pure parsing/script builders plus async WSL planning entry points. Remove dead sync wrappers and their sync-only private helper.
- `server/local-file-router.ts`
  Responsibility: authenticated local file serving. Replace sync `existsSync`/`statSync` flow with async `fsp.stat` and `sendFile` callback error mapping.
- `tsconfig.json`
  Responsibility: client typecheck cache (`node_modules/.cache/tsconfig.client.tsbuildinfo`).
- `tsconfig.server.json`
  Responsibility: server typecheck/build cache (`node_modules/.cache/tsconfig.server.tsbuildinfo`).
- `tsconfig.electron.json`
  Responsibility: electron build cache (`node_modules/.cache/tsconfig.electron.tsbuildinfo`).
- `tsconfig.electron-preload.json`
  Responsibility: preload build cache (`node_modules/.cache/tsconfig.electron-preload.tsbuildinfo`).
- `src/components/panes/PaneContainer.tsx`
  Responsibility: pane-type rendering boundary. Lazy-load `EditorPane` here and provide the editor loading shell.
- `src/App.tsx`
  Responsibility: stabilize `onOpenTab` so `TabsView`’s memo boundary can work.
- `src/components/TabsView.tsx`
  Responsibility: tab registry UI. Wrap export in `memo`.
- `src/components/TerminalView.tsx`
  Responsibility: terminal UI. Wrap export in `memo`.
- `test/unit/server/bootstrap.test.ts`
  Responsibility: LAN-detection unit coverage. Add async-path coverage and shared parser expectations.
- `test/unit/server/network-manager.test.ts`
  Responsibility: runtime LAN refresh behavior. Assert `configure()` / `initializeFromStartup()` await the async detector and mark LAN IPs initialized.
- `test/integration/server/lan-info-api.test.ts`
  Responsibility: `/api/lan-info` auth and async response/error behavior.
- `test/unit/server/wsl-port-forward.test.ts`
  Responsibility: pure WSL planning behavior. Keep async public entry-point coverage and remove sync-only expectations.
- `test/integration/server/wsl-port-forward.test.ts`
  Responsibility: public export-surface contract. Update it to the surviving async API.
- `test/integration/server/network-api.test.ts`
  Responsibility: router/network integration. Remove dead sync WSL mocks and keep async mocks only; keep `/local-file` auth regression.
- `test/integration/server/local-file-router.test.ts`
  Responsibility: real HTTP behavior for `/local-file` success and error semantics. Create this file.
- `test/unit/client/components/panes/PaneContainer.test.tsx`
  Responsibility: pane rendering behavior. Update editor assertions for lazy loading and the loading shell.
- `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`
  Responsibility: pane creation flow. Keep editor creation coverage green with lazy rendering.
- `test/unit/client/components/panes/PaneLayout.test.tsx`
  Responsibility: pane-layout rendering. Update editor assertions/mocks for lazy rendering.
- `test/e2e-browser/specs/editor-pane.spec.ts`
  Responsibility: real browser editor flow. Assert editor pane opens, an extra JS chunk loads when opening it, and the loaded editor is screenshot-stable.
- `test/unit/client/components/TabsView.memo.test.tsx`
  Responsibility: render-suppression characterization for `TabsView`. Create this file.
- `test/unit/client/components/TerminalView.memo.test.tsx`
  Responsibility: render-suppression characterization for `TerminalView`. Create this file.
- Existing behavior suites to keep green:
  `test/unit/client/components/TabsView.test.tsx`,
  `test/unit/client/components/TerminalView.visibility.test.tsx`,
  `test/unit/client/components/TerminalView.lifecycle.test.tsx`,
  `test/e2e/tabs-view-flow.test.tsx`.

## Task 1: Add Async LAN Detection for Steady-State Runtime Paths

**Files:**
- Modify: `server/bootstrap.ts`
- Modify: `server/network-manager.ts`
- Modify: `server/network-router.ts`
- Modify: `server/index.ts`
- Modify: `test/unit/server/bootstrap.test.ts`
- Modify: `test/unit/server/network-manager.test.ts`
- Modify: `test/integration/server/lan-info-api.test.ts`
- Modify: `test/integration/server/network-api.test.ts`

- [ ] **Step 1: Write the failing async-path tests**

In `test/unit/server/bootstrap.test.ts`, add `detectLanIpsAsync()` coverage for:
- non-WSL interface enumeration
- WSL `ipconfig.exe` parsing success
- WSL `ipconfig.exe` failure falling back to `os.networkInterfaces()`

In `test/unit/server/network-manager.test.ts`, add coverage proving:
- `configure()` awaits the async refresh before rebuilding allowed origins
- `initializeFromStartup()` awaits the async refresh
- async refresh sets `lanIpsInitialized` so later `getStatus()` does not re-enter the sync fallback path

In `test/integration/server/lan-info-api.test.ts`, add a 500-case where the injected async detector rejects.

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run test:vitest -- run test/unit/server/bootstrap.test.ts test/unit/server/network-manager.test.ts test/integration/server/lan-info-api.test.ts test/integration/server/network-api.test.ts
```

Expected: FAIL because `detectLanIpsAsync()` does not exist yet and `/api/lan-info` still expects a sync dependency.

- [ ] **Step 2: Implement the async detector and wire runtime callers**

In `server/bootstrap.ts`:
- extract the duplicated `ipconfig.exe` parser into a shared helper used by both sync and async paths
- add an async Windows-host helper using `execFile`
- add `detectLanIpsAsync(): Promise<string[]>`
- keep `detectLanIps()` intact for bootstrap/import-time callers and `ensureEnvFile()`

In `server/network-manager.ts`:
- import `detectLanIpsAsync`
- replace steady-state `refreshLanIps()` with an awaited async variant
- keep `ensureLanIps()` synchronous for the constructor-only path
- set `lanIpsInitialized = true` inside the async refresh as well as the sync initialization path so later callers do not regress back to sync work

In `server/network-router.ts` and `server/index.ts`:
- change the dependency contract from `() => string[]` to `() => Promise<string[]>`
- make `/api/lan-info` an async route with explicit `try/catch`
- inject `detectLanIpsAsync` into `createNetworkRouter(...)`

- [ ] **Step 3: Verify the async LAN detection surface**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run test:vitest -- run test/unit/server/bootstrap.test.ts test/unit/server/network-manager.test.ts test/integration/server/lan-info-api.test.ts test/integration/server/network-api.test.ts
```

Expected: PASS.

- [ ] **Step 4: Refactor the duplicated LAN-scoring logic and re-run**

Tighten `server/bootstrap.ts` so both sync and async paths share the same parsing and IPv4 scoring helpers instead of maintaining near-duplicate code. Re-run the same targeted command and keep it green.

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
git add server/bootstrap.ts server/network-manager.ts server/network-router.ts server/index.ts test/unit/server/bootstrap.test.ts test/unit/server/network-manager.test.ts test/integration/server/lan-info-api.test.ts test/integration/server/network-api.test.ts
git commit -m "perf: make runtime lan detection async"
```

## Task 2: Remove Dead Sync WSL Port-Forward Wrappers

**Files:**
- Modify: `server/wsl-port-forward.ts`
- Modify: `test/unit/server/wsl-port-forward.test.ts`
- Modify: `test/integration/server/wsl-port-forward.test.ts`
- Modify: `test/integration/server/network-api.test.ts`

- [ ] **Step 1: Prove the sync wrappers are dead runtime surface and make the tests red**

Confirm there are no runtime callers outside the defining module:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
rg -n "computeWslPortForwardingPlan\\b|computeWslPortForwardingTeardownPlan\\b|getWslIp\\b|getExistingPortProxyRules\\b|getExistingFirewallPorts\\b" server test --glob '!test/unit/server/wsl-port-forward.test.ts' --glob '!test/integration/server/wsl-port-forward.test.ts' --glob '!test/integration/server/network-api.test.ts'
```

Expected: no runtime callers in `server/` outside `server/wsl-port-forward.ts`; remaining hits are the tests that still encode the old sync surface.

Then update the tests so they describe the surviving async public contract:
- remove sync export expectations from `test/integration/server/wsl-port-forward.test.ts`
- remove sync import references and sync-only assertions from `test/unit/server/wsl-port-forward.test.ts`
- port any sync-only edge-case assertions onto `computeWslPortForwardingPlanAsync(...)` / `computeWslPortForwardingTeardownPlanAsync(...)`
- remove dead sync mocks from `test/integration/server/network-api.test.ts`

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run test:vitest -- run test/unit/server/wsl-port-forward.test.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/network-api.test.ts
```

Expected: FAIL because the code still exports the sync wrappers and the integration tests still see them.

- [ ] **Step 2: Remove the sync exec surface**

In `server/wsl-port-forward.ts`:
- remove `execSync` from the imports
- remove `fs` and the sync managed-ports reader
- delete these dead exported sync wrappers:
  `getWslIp`,
  `getExistingPortProxyRules`,
  `getExistingFirewallPorts`,
  `computeWslPortForwardingPlan`,
  `computeWslPortForwardingTeardownPlan`
- keep the pure parser/build-script helpers and the async public plan entry points

- [ ] **Step 3: Verify the async-only WSL surface**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run test:vitest -- run test/unit/server/wsl-port-forward.test.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/network-api.test.ts
```

Expected: PASS.

- [ ] **Step 4: Refactor imports and dead helpers**

Clean up any now-unused helper code or test scaffolding left behind by the sync removal, then rerun the same targeted command and keep it green.

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
git add server/wsl-port-forward.ts test/unit/server/wsl-port-forward.test.ts test/integration/server/wsl-port-forward.test.ts test/integration/server/network-api.test.ts
git commit -m "perf: remove dead sync wsl planning wrappers"
```

## Task 3: Convert `/local-file` to Async Filesystem Access With Dedicated HTTP Coverage

**Files:**
- Modify: `server/local-file-router.ts`
- Create: `test/integration/server/local-file-router.test.ts`
- Modify: `test/integration/server/network-api.test.ts`

- [ ] **Step 1: Add failing HTTP-level tests for `/local-file` behavior**

Create `test/integration/server/local-file-router.test.ts` with a minimal Express app mounting the real router and exercise:
- 401 without auth
- 400 when `path` is missing
- 404 when the file does not exist
- 400 when the path resolves to a directory
- 200 for a readable file
- 500 for an unexpected stat/send failure (use `vi.spyOn(fsp, 'stat')` or a send failure hook while still asserting through HTTP responses)

Keep the existing `/local-file` auth assertions in `test/integration/server/network-api.test.ts` green as regression coverage.

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run test:vitest -- run test/integration/server/local-file-router.test.ts test/integration/server/network-api.test.ts
```

Expected: FAIL because the router still uses sync `existsSync` / `statSync` and does not expose the new 500 semantics.

- [ ] **Step 2: Implement async stat plus sendFile error mapping**

In `server/local-file-router.ts`:
- replace `fs` with `fsp` from `node:fs/promises`
- keep auth exactly as-is
- validate `path` first
- `await fsp.stat(resolved)` to reject directories without blocking
- call `res.sendFile(resolved, callback)` and map callback errors to:
  - 404 for `ENOENT`
  - 400 for `EISDIR`
  - 500 with a clear message for everything else

This keeps the user-visible contract explicit and avoids silent Express 4 async rejection leaks.

- [ ] **Step 3: Verify the router behavior**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run test:vitest -- run test/integration/server/local-file-router.test.ts test/integration/server/network-api.test.ts
```

Expected: PASS.

- [ ] **Step 4: Refactor for clarity**

If the error mapping becomes repetitive, extract a tiny local helper inside `server/local-file-router.ts` rather than adding a new module. Re-run the same command and keep it green.

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
git add server/local-file-router.ts test/integration/server/local-file-router.test.ts test/integration/server/network-api.test.ts
git commit -m "perf: make local-file routing async"
```

## Task 4: Enable Incremental TypeScript Caches Across Active Configs

**Files:**
- Modify: `tsconfig.json`
- Modify: `tsconfig.server.json`
- Modify: `tsconfig.electron.json`
- Modify: `tsconfig.electron-preload.json`

- [ ] **Step 1: Confirm the current config has no incremental cache settings**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
rg -n "\"incremental\"|tsBuildInfoFile" tsconfig.json tsconfig.server.json tsconfig.electron.json tsconfig.electron-preload.json
```

Expected: no matches.

- [ ] **Step 2: Add explicit cache files for all four configs**

Add to each `compilerOptions` block:
- `tsconfig.json`
  `incremental: true`
  `tsBuildInfoFile: "./node_modules/.cache/tsconfig.client.tsbuildinfo"`
- `tsconfig.server.json`
  `incremental: true`
  `tsBuildInfoFile: "./node_modules/.cache/tsconfig.server.tsbuildinfo"`
- `tsconfig.electron.json`
  `incremental: true`
  `tsBuildInfoFile: "./node_modules/.cache/tsconfig.electron.tsbuildinfo"`
- `tsconfig.electron-preload.json`
  `incremental: true`
  `tsBuildInfoFile: "./node_modules/.cache/tsconfig.electron-preload.tsbuildinfo"`

- [ ] **Step 3: Verify cold/warm behavior and cache-file creation**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
rm -f node_modules/.cache/tsconfig*.tsbuildinfo
time npm run typecheck
ls node_modules/.cache/tsconfig.client.tsbuildinfo node_modules/.cache/tsconfig.server.tsbuildinfo
time npm run typecheck
npm run build:electron
ls node_modules/.cache/tsconfig.electron.tsbuildinfo node_modules/.cache/tsconfig.electron-preload.tsbuildinfo
```

Expected:
- first `npm run typecheck` succeeds and creates client/server cache files
- second `npm run typecheck` succeeds and is materially faster than the first
- `npm run build:electron` succeeds and creates the electron/preload cache files

- [ ] **Step 4: Refactor only if a config collision appears**

If any two configs contend for the same `.tsbuildinfo` path, fix the path collision and rerun the full verification block above. Do not add any extra build scripts.

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
git add tsconfig.json tsconfig.server.json tsconfig.electron.json tsconfig.electron-preload.json
git commit -m "perf: enable incremental typescript caches"
```

## Task 5: Lazy-Load `EditorPane` With a Visible Loading Shell

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`
- Modify: `test/unit/client/components/panes/PaneLayout.test.tsx`
- Modify: `test/e2e-browser/specs/editor-pane.spec.ts`

- [ ] **Step 1: Add the failing lazy-editor tests**

Update the pane unit tests so editor rendering is async instead of synchronous:
- `test/unit/client/components/panes/PaneContainer.test.tsx`
  - add a test that editor content first renders a loading shell with `role="status"` / `data-testid="editor-pane-loading"`
  - then `await screen.findByTestId('monaco-mock')`
- `test/unit/client/components/panes/PaneLayout.test.tsx`
  - update any editor assertions to use async queries so the lazy boundary is exercised
- `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`
  - keep editor-creation assertions green after the lazy boundary

In `test/e2e-browser/specs/editor-pane.spec.ts`, add a browser-level assertion that opening the editor causes at least one new `.js` asset request after the click, then wait for `[data-testid="editor-pane"]` and capture the editor-pane screenshot/assertion after load.

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run test:vitest -- run test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/panes/PaneLayout.test.tsx
```

Expected: FAIL because the editor still renders eagerly and no loading shell exists.

- [ ] **Step 2: Implement the lazy editor boundary**

In `src/components/panes/PaneContainer.tsx`:
- replace the eager `EditorPane` import with `lazy(() => import('./EditorPane'))`
- wrap the editor case in `Suspense`
- use an explicit loading shell, for example:

```tsx
<div
  data-testid="editor-pane-loading"
  role="status"
  aria-live="polite"
  className="flex h-full items-center justify-center text-sm text-muted-foreground"
>
  Loading editor…
</div>
```

Do not lazy-load `BrowserPane`; that adds churn without a meaningful win.

- [ ] **Step 3: Verify unit behavior and chunk splitting**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run test:vitest -- run test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/panes/PaneLayout.test.tsx
npm run build:client
find dist/client/assets -maxdepth 1 -type f | sort
```

Expected:
- pane tests PASS
- build succeeds
- build output includes at least one new editor-related lazy chunk instead of keeping Monaco/editor code exclusively in `index-*.js`

- [ ] **Step 4: Verify the real browser flow**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run test:e2e:chromium -- test/e2e-browser/specs/editor-pane.spec.ts
```

Expected: PASS, with the spec proving:
- editor pane still opens from the picker
- at least one additional JS asset is requested when the editor is opened
- the loaded editor UI is visible and stable enough for the screenshot/assertion

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
git add src/components/panes/PaneContainer.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/panes/PaneLayout.test.tsx test/e2e-browser/specs/editor-pane.spec.ts
git commit -m "perf: lazy-load editor pane"
```

## Task 6: Memoize `TabsView` and `TerminalView`, Then Stabilize `onOpenTab`

**Files:**
- Modify: `src/components/TabsView.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/App.tsx`
- Create: `test/unit/client/components/TabsView.memo.test.tsx`
- Create: `test/unit/client/components/TerminalView.memo.test.tsx`
- Modify: `test/unit/client/components/TabsView.test.tsx`
- Modify: `test/unit/client/components/TerminalView.visibility.test.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/e2e/tabs-view-flow.test.tsx`

- [ ] **Step 1: Add failing render-suppression tests**

Create `test/unit/client/components/TabsView.memo.test.tsx` that uses `React.Profiler` or an equivalent render counter to prove:
- with a stable `onOpenTab` prop, unrelated parent rerenders do not rerender `TabsView`
- with an inline callback prop, the memo boundary is defeated

Create `test/unit/client/components/TerminalView.memo.test.tsx` using the existing xterm/runtime mocks pattern to prove:
- a parent rerender with the same `tabId`, `paneId`, `hidden`, and `paneContent` object does not rerender the terminal
- a real prop change, such as `hidden` flipping, still rerenders it

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run test:vitest -- run test/unit/client/components/TabsView.memo.test.tsx test/unit/client/components/TerminalView.memo.test.tsx
```

Expected: FAIL because neither component is memoized yet and `App.tsx` still passes a fresh inline callback into `TabsView`.

- [ ] **Step 2: Implement the memo boundaries**

In `src/components/TabsView.tsx`:
- wrap the component export in `memo`

In `src/components/TerminalView.tsx`:
- wrap the component export in `memo`

Use default shallow-prop comparison; do not add a custom comparator unless a real failing test proves the default compare is insufficient.

In `src/App.tsx`:
- add `const handleOpenTab = useCallback(() => setView('terminal'), [])`
- pass `handleOpenTab` to both `OverviewView` and `TabsView`

- [ ] **Step 3: Verify memo behavior and existing functionality**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run test:vitest -- run test/unit/client/components/TabsView.memo.test.tsx test/unit/client/components/TerminalView.memo.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/tabs-view-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Refactor only if a memo boundary breaks a real prop-driven update**

If any legitimate prop change stops updating the UI, fix the prop identity or reducer structural sharing; do not remove `memo` as the first reaction. Re-run the same targeted command and keep it green.

- [ ] **Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
git add src/components/TabsView.tsx src/components/TerminalView.tsx src/App.tsx test/unit/client/components/TabsView.memo.test.tsx test/unit/client/components/TerminalView.memo.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/tabs-view-flow.test.tsx
git commit -m "perf: memoize large tab and terminal views"
```

## Task 7: Final Regression Sweep and Artifact Verification

**Files:**
- No new product code; this task verifies the landed end state.

- [ ] **Step 1: Re-run the focused server regression set**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run test:vitest -- run test/unit/server/bootstrap.test.ts test/unit/server/network-manager.test.ts test/unit/server/wsl-port-forward.test.ts test/integration/server/lan-info-api.test.ts test/integration/server/local-file-router.test.ts test/integration/server/network-api.test.ts
```

Expected: PASS.

- [ ] **Step 2: Re-run the focused client/browser regression set**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run test:vitest -- run test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/panes/PaneLayout.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/components/TabsView.memo.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.memo.test.tsx test/e2e/tabs-view-flow.test.tsx
npm run test:e2e:chromium -- test/e2e-browser/specs/editor-pane.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Re-run build and typecheck artifacts**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
npm run typecheck
npm run build:client
npm run build:electron
```

Expected: PASS, with the editor remaining split out of the main initial bundle and all four `.tsbuildinfo` files present in `node_modules/.cache`.

- [ ] **Step 4: Run the coordinated broad gate**

Run:

```bash
cd /home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404
FRESHELL_TEST_SUMMARY="performance fixes" npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit the final verification state if anything changed**

If any golden files, snapshots, or test fixtures changed legitimately during verification, commit them. Otherwise, do not create a no-op commit.


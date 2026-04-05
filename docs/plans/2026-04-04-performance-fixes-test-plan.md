# Performance Fixes Test Plan

Date: 2026-04-04  
Implementation plan: `/home/user/code/freshell/.worktrees/trycycle-performance-fixes-20260404/docs/plans/2026-04-03-performance-fixes.md`

## Strategy reconciliation

No approval required. The approved strategy still fits the implementation plan and the current repo:

- The plan does not add paid APIs, external infrastructure, or any manual-only acceptance step. The affected surfaces remain local shell commands, Express routes, browser UI flows, and existing Vitest/Playwright harnesses.
- The implementation plan confirms the strategy gate around `tsx watch`: the first acceptance check is still an execution-time probe, and `package.json` should remain unchanged unless that probe proves a real restart bug.
- The editor lazy-load browser proof does not need a brand-new shared harness. The existing Playwright fixtures plus either page-level request observation or the repo’s existing CDP network recorder are sufficient to assert that opening the editor causes a new JS asset request.
- The interaction surface is unchanged from the approved strategy: async LAN detection in steady-state server paths, async `/local-file` semantics, TypeScript cache artifacts, lazy editor loading, and memo boundaries for `TabsView` and `TerminalView`.

## Named sources of truth

- `Transcript`: the approved trycycle transcript in the dispatch payload, including the user-approved performance-fixes testing strategy.
- `Plan-AC`: `docs/plans/2026-04-03-performance-fixes.md`, section `Acceptance Criteria`.
- `Plan-SG`: `docs/plans/2026-04-03-performance-fixes.md`, section `Strategy Gate`.
- `Plan-FM`: `docs/plans/2026-04-03-performance-fixes.md`, section `File Map`.
- `Plan-T1` through `Plan-T7`: the task sections in `docs/plans/2026-04-03-performance-fixes.md`.
- `Repo-scripts`: `package.json`, especially `dev`, `dev:server`, `typecheck`, `build:client`, `build:electron`, `lint`, `test:vitest`, `test:e2e:chromium`, and `check`.
- `Repo-routes`: `server/network-router.ts`, `server/local-file-router.ts`, and `server/index.ts`.
- `Repo-ui`: `src/components/panes/PaneContainer.tsx`, `src/components/panes/EditorPane.tsx`, `src/components/panes/EditorToolbar.tsx`, `src/components/TabsView.tsx`, `src/components/TerminalView.tsx`, `src/App.tsx`, `test/e2e-browser/helpers/fixtures.ts`, `test/e2e-browser/helpers/test-harness.ts`, and `test/e2e-browser/perf/network-recorder.ts`.
- `Docs-tsx`: https://tsx.is/watch-mode
- `Docs-tsc`: https://www.typescriptlang.org/tsconfig/incremental.html and https://www.typescriptlang.org/tsconfig/tsBuildInfoFile.html
- `Docs-react`: https://react.dev/reference/react/lazy and https://react.dev/reference/react/memo
- `Docs-express`: https://expressjs.com/en/guide/migrating-5.html, used here only to show that rejected-promise auto-forwarding is an Express 5 feature and therefore cannot be assumed in this Express 4 repo.

## Harness requirements

### H1: Command and artifact harness

- What it does: runs isolated shell commands and captures observable artifacts for watch-mode behavior, typecheck timings, build outputs, cache files, lint, and the coordinated broad gate.
- What it exposes: process stdout/stderr, restart counts, generated files in `dist/client/assets` and `node_modules/.cache`, command durations, and `git diff -- package.json`.
- Estimated complexity: low. The repo already has the scripts and worktree-safe process guidance; this is orchestration, not new infrastructure.
- Tests that depend on it: 1, 2, 14, 15, 17, 22, 23, 24.

### H2: Server runtime harness

- What it does: extends the existing Vitest node/supertest harnesses around `bootstrap`, `NetworkManager`, `createNetworkRouter`, `createLocalFileRouter`, and `wsl-port-forward`.
- What it exposes: async detector results, router HTTP responses, module export surfaces, WSL plan outputs, auth behavior, filesystem error mapping, and process-env side effects such as `ALLOWED_ORIGINS`.
- Estimated complexity: low-medium. The relevant files already exist; the new work is additional cases plus one dedicated `/local-file` integration file.
- Tests that depend on it: 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 22.

### H3: Client pane-render harness

- What it does: extends the existing jsdom + Redux pane tests to exercise `PaneContainer`, `PaneLayout`, and pane-creation flows across a real `Suspense` boundary with mocked Monaco.
- What it exposes: rendered loading-shell DOM, async lazy resolution via `findBy*` queries, pane-layout state transitions, and preserved editor-pane behavior after creation.
- Estimated complexity: low. The current pane tests already mock Monaco and Redux state; they only need async assertions and a lazy-aware import path.
- Tests that depend on it: 16, 21, 23.

### H4: Browser editor/network harness

- What it does: reuses the existing Playwright `TestServer`, `TestHarness`, and terminal helpers to drive the real editor-pane flow, record network requests after the user clicks `Editor`, and capture a stable screenshot after the lazy chunk resolves.
- What it exposes: browser-visible DOM, pane-layout state through `window.__FRESHELL_TEST_HARNESS__`, per-request URL/type information, and screenshot artifacts.
- Estimated complexity: low-medium. The page fixture and test harness already exist; the only addition is request accounting scoped to the editor-open action.
- Tests that depend on it: 18, 23.

### H5: Memo characterization harness

- What it does: adds focused React render-count checks using `React.Profiler` or equivalent render counters around `TabsView` and `TerminalView` with realistic mocked dependencies.
- What it exposes: render counts across parent rerenders, proof that a stable callback preserves memo effectiveness, and proof that real prop changes still rerender.
- Estimated complexity: low. These are isolated unit tests layered on the existing xterm/runtime mocks and Redux store scaffolding.
- Tests that depend on it: 19, 20, 21, 23.

## Test plan

1. Name: `tsx watch` ignores `.worktrees`, `dist`, and `demo-projects` changes while still restarting on a real server-source change
   Type: differential
   Disposition: new command probe driven from the implementation task, not an existing test file
   Harness: H1
   Preconditions: an isolated port is available; timestamped probe files can be created under `.worktrees/`, `dist/`, and `demo-projects/`; the command under test is the current `tsx watch server/index.ts` surface from `Repo-scripts`.
   Actions: start `PORT=<isolated> npx tsx watch server/index.ts`; wait for the initial ready/startup output; touch one probe file under `.worktrees/`, one under `dist/`, and one under `demo-projects/`; observe rerun output after each touch; then touch `server/index.ts` or another imported server source file and observe the next rerun.
   Expected outcome: the command starts successfully, the three non-runtime touches do not trigger a rerun, and the server-source touch does trigger exactly one rerun. If any excluded-path touch restarts the watcher, the implementation can no longer satisfy `Plan-SG` or `Plan-AC` without changing scope. Sources: `Transcript`, `Plan-SG`, `Plan-AC`, `Repo-scripts`, `Docs-tsx`.
   Interactions: `tsx` watch mode, Node process startup, repo filesystem layout, isolated port binding.

2. Name: dev watch scripts stay unchanged when the watch probe proves no over-watching
   Type: invariant
   Disposition: new command artifact check
   Harness: H1
   Preconditions: test 1 passed without excluded-path restarts.
   Actions: inspect `git diff -- package.json` and compare the `dev` and `dev:server` scripts against the current `tsx watch server/index.ts` contract.
   Expected outcome: there is no diff to the watch scripts and no cargo-cult `--exclude` flags are added. Sources: `Plan-AC`, `Plan-SG`, `Repo-scripts`.
   Interactions: git worktree state, `package.json` script contract.

3. Name: async LAN detection returns the same ranked LAN candidates as the sync bootstrap path, including WSL Windows-host fallback behavior
   Type: unit
   Disposition: extend `test/unit/server/bootstrap.test.ts`
   Harness: H2
   Preconditions: `os.networkInterfaces()`, WSL platform detection, and child-process execution are mockable.
   Actions: call `detectLanIpsAsync()` once with non-WSL interface data, once with WSL `ipconfig.exe` output containing physical adapter IPv4s, and once with WSL `ipconfig.exe` failure plus fallback interface data.
   Expected outcome: the async detector returns non-loopback IPv4s sorted by LAN preference, prefers Windows-host physical adapter IPs inside WSL, and falls back to `os.networkInterfaces()` when the Windows query fails. Sources: `Plan-AC`, `Plan-T1`, `Plan-FM`, `Transcript`.
   Interactions: bootstrap LAN detector, WSL platform detection, child-process output parsing, OS network interface enumeration.

4. Name: `NetworkManager.configure()` and `initializeFromStartup()` await async LAN refresh and stop falling back to sync refresh after initialization
   Type: integration
   Disposition: extend `test/unit/server/network-manager.test.ts`
   Harness: H2
   Preconditions: `detectLanIpsAsync()` and `detectLanIps()` are mockable; `ConfigStore` is writable; `ALLOWED_ORIGINS` can be inspected after reconfiguration.
   Actions: construct a `NetworkManager`; call `configure(...)`; call `initializeFromStartup(...)`; then call `getStatus()` after the async refresh path has completed.
   Expected outcome: `configure()` and `initializeFromStartup()` do not rebuild allowed origins until the async refresh has completed, `lanIpsInitialized` remains satisfied so `getStatus()` does not re-enter the sync fallback path, and the resulting status/origins contain the refreshed LAN IPs. Sources: `Plan-AC`, `Plan-T1`, `Plan-FM`, `Transcript`.
   Interactions: `NetworkManager` <> async LAN detector, `ConfigStore`, `process.env.ALLOWED_ORIGINS`, runtime status generation.

5. Name: `GET /api/lan-info` enforces auth, returns LAN IPs on success, and returns a deterministic 500 when async detection rejects
   Type: integration
   Disposition: extend `test/integration/server/lan-info-api.test.ts`
   Harness: H2
   Preconditions: the router is mounted behind auth middleware with an injected async LAN detector; success and rejection cases are both injectable.
   Actions: call `GET /api/lan-info` without auth, with valid auth and a resolving detector, and with valid auth and a rejecting detector.
   Expected outcome: the endpoint returns `401` without a token, `200 { ips: [...] }` on success, and a controlled `500` JSON error on rejection rather than leaking an unhandled async error. Sources: `Plan-AC`, `Plan-T1`, `Repo-routes`, `Docs-express`.
   Interactions: auth middleware, network router, injected async LAN detector, Express 4 async error handling.

6. Name: the WSL port-forward module exposes only async public planning entry points plus pure parser/script helpers
   Type: regression
   Disposition: extend `test/integration/server/wsl-port-forward.test.ts`
   Harness: H2
   Preconditions: the module can be imported as a namespace object.
   Actions: import `server/wsl-port-forward.ts` and inspect the presence or absence of the current public exports.
   Expected outcome: the dead sync wrappers are absent, while `computeWslPortForwardingPlanAsync(...)`, `computeWslPortForwardingTeardownPlanAsync(...)`, the parser helpers, and the script builders remain available. Sources: `Plan-AC`, `Plan-T2`, `Plan-FM`.
   Interactions: public module contract used by the network router and tests.

7. Name: async WSL repair planning still returns the expected `not-wsl2`, `error`, `noop`, and `ready` outcomes after sync wrapper removal
   Type: integration
   Disposition: extend `test/unit/server/wsl-port-forward.test.ts`
   Harness: H2
   Preconditions: WSL platform detection, current-IP discovery, existing portproxy rules, and existing firewall rules are mockable.
   Actions: call `computeWslPortForwardingPlanAsync(...)` and `computeWslPortForwardingTeardownPlanAsync(...)` across representative non-WSL, missing-IP, fully-configured, firewall-drift, and full-repair cases.
   Expected outcome: the async public entry points preserve the existing observable plan statuses and script kinds, so runtime repair flows still receive the same plan semantics after the sync surface is removed. Sources: `Plan-AC`, `Plan-T2`, `Plan-FM`, `Transcript`.
   Interactions: WSL planning helpers, mocked command execution, firewall-rule parsing, portproxy-rule parsing.

8. Name: `GET /local-file` rejects missing auth before any filesystem work
   Type: integration
   Disposition: extend existing `/local-file` auth coverage and add dedicated coverage in `test/integration/server/local-file-router.test.ts`
   Harness: H2
   Preconditions: the real local-file router is mounted with `AUTH_TOKEN` set and a temporary readable file exists.
   Actions: call `GET /local-file?path=<real-file>` without a header token and without an auth cookie.
   Expected outcome: the route returns `401 { error: 'Unauthorized' }` before path validation or file serving. Sources: `Plan-AC`, `Plan-T3`, `Repo-routes`.
   Interactions: auth middleware inside the local-file router, Express query parsing, filesystem access boundary.

9. Name: `GET /local-file` returns a clear 400 when the `path` query is missing
   Type: boundary
   Disposition: new `test/integration/server/local-file-router.test.ts`
   Harness: H2
   Preconditions: the real local-file router is mounted with valid auth.
   Actions: call `GET /local-file` with a valid auth token but no `path` query parameter.
   Expected outcome: the route returns `400 { error: 'path query parameter required' }`. Sources: `Plan-AC`, `Plan-T3`, `Repo-routes`.
   Interactions: query parsing, route validation, auth-preserved request path.

10. Name: `GET /local-file` returns a clear 404 when the requested file does not exist
    Type: boundary
    Disposition: new `test/integration/server/local-file-router.test.ts`
    Harness: H2
    Preconditions: the router is mounted with valid auth and the requested path does not exist.
    Actions: call `GET /local-file?path=<missing-file>` with a valid token.
    Expected outcome: the route returns `404 { error: 'File not found' }` from the async stat/sendFile path. Sources: `Plan-AC`, `Plan-T3`, `Repo-routes`.
    Interactions: async filesystem stat, Express response mapping, missing-file boundary.

11. Name: `GET /local-file` returns a clear 400 when the requested path is a directory
    Type: boundary
    Disposition: new `test/integration/server/local-file-router.test.ts`
    Harness: H2
    Preconditions: the router is mounted with valid auth and the requested path resolves to a directory.
    Actions: call `GET /local-file?path=<directory>` with a valid token.
    Expected outcome: the route returns `400 { error: 'Cannot serve directories' }`. Sources: `Plan-AC`, `Plan-T3`, `Repo-routes`.
    Interactions: async filesystem stat, directory detection, HTTP error mapping.

12. Name: `GET /local-file` returns the file body with 200 for a readable file
    Type: integration
    Disposition: new `test/integration/server/local-file-router.test.ts`
    Harness: H2
    Preconditions: the router is mounted with valid auth and a temporary readable file exists.
    Actions: call `GET /local-file?path=<readable-file>` with a valid token.
    Expected outcome: the route returns `200` with the readable file contents and preserves the existing success contract while using async filesystem checks. Sources: `Plan-AC`, `Plan-T3`, `Repo-routes`.
    Interactions: async stat, `res.sendFile(...)`, filesystem read path, Express response delivery.

13. Name: `GET /local-file` maps unexpected stat or `sendFile` failures to a deterministic 500
    Type: boundary
    Disposition: new `test/integration/server/local-file-router.test.ts`
    Harness: H2
    Preconditions: the router is mounted with valid auth and the test can force either `fsp.stat` or `sendFile` to fail with a non-`ENOENT`/non-`EISDIR` error.
    Actions: inject an unexpected filesystem or send failure and call `GET /local-file?path=<path>` with a valid token.
    Expected outcome: the route returns `500` with a clear JSON error message instead of hanging or leaking an uncaught callback error. Sources: `Plan-AC`, `Plan-T3`, `Repo-routes`, `Docs-express`.
    Interactions: async filesystem error handling, `sendFile` callback mapping, Express 4 callback/error behavior.

14. Name: `npm run typecheck` creates dedicated client/server `.tsbuildinfo` files and the warm rerun is materially faster than the cold rerun
    Type: differential
    Disposition: new command artifact check
    Harness: H1
    Preconditions: remove `node_modules/.cache/tsconfig*.tsbuildinfo` and record wall-clock timings in the same local environment for both runs.
    Actions: delete the cache files; time `npm run typecheck`; confirm the client/server build-info files exist; time `npm run typecheck` again.
    Expected outcome: both runs succeed, `node_modules/.cache/tsconfig.client.tsbuildinfo` and `node_modules/.cache/tsconfig.server.tsbuildinfo` are created, and the warm rerun is materially faster without relying on a brittle absolute threshold. Sources: `Plan-AC`, `Plan-T4`, `Repo-scripts`, `Docs-tsc`.
    Interactions: TypeScript incremental compiler cache, repo cache directory, shell timing output.

15. Name: `npm run build:electron` creates distinct electron and preload `.tsbuildinfo` files without colliding with the client/server caches
    Type: regression
    Disposition: new command artifact check
    Harness: H1
    Preconditions: the tsconfig cache paths are configured and the worktree can run electron TypeScript builds.
    Actions: run `npm run build:electron`; inspect `node_modules/.cache/tsconfig.electron.tsbuildinfo` and `node_modules/.cache/tsconfig.electron-preload.tsbuildinfo`.
    Expected outcome: the build succeeds and both electron cache files exist at distinct paths, proving the four active configs do not contend for the same `.tsbuildinfo` file. Sources: `Plan-AC`, `Plan-T4`, `Repo-scripts`, `Docs-tsc`.
    Interactions: Electron TypeScript build configs, cache-file placement, dist/electron output.

16. Name: choosing `Editor` in a pane first shows an accessible loading shell and then resolves to a working editor pane
    Type: scenario
    Disposition: extend `test/unit/client/components/panes/PaneContainer.test.tsx`, `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`, and `test/unit/client/components/panes/PaneLayout.test.tsx`
    Harness: H3
    Preconditions: Monaco is mocked, Redux pane state is available, and the `PaneContainer` editor path is rendered through the lazy boundary instead of a synchronous import.
    Actions: drive the editor pane path through the existing pane tests, assert the initial loading shell via `role="status"` and `data-testid="editor-pane-loading"`, then await the resolved editor DOM such as `data-testid="monaco-mock"` or `data-testid="editor-pane"`.
    Expected outcome: the loading shell appears before the editor resolves, it is accessible and stable for assertions, and the existing pane-creation/editor-selection flows still end in a working editor pane. Sources: `Plan-AC`, `Plan-T5`, `Plan-FM`, `Repo-ui`, `Docs-react`.
    Interactions: `PaneContainer` <> React `lazy`/`Suspense`, Monaco mock, Redux pane-layout updates, pane picker/editor creation flow.

17. Name: `npm run build:client` splits editor/Monaco code out of the initial bundle
    Type: differential
    Disposition: new command artifact check
    Harness: H1
    Preconditions: the client build runs from the performance-fixes worktree and `dist/client/assets` can be inspected after the build.
    Actions: run `npm run build:client`; list the built JS assets in `dist/client/assets`; inspect whether editor-related code now appears in a separate chunk rather than only `index-*.js`.
    Expected outcome: the build succeeds and produces at least one additional editor-related lazy chunk so the editor/Monaco code is not loaded only through the initial index bundle. Sources: `Plan-AC`, `Plan-T5`, `Repo-scripts`, `Transcript`, `Docs-react`.
    Interactions: Vite/Rollup bundling, chunk emission, dist asset inspection.

18. Name: opening an editor pane in the browser triggers a new JS asset request and produces a stable loaded editor screenshot
    Type: scenario
    Disposition: extend `test/e2e-browser/specs/editor-pane.spec.ts`
    Harness: H4
    Preconditions: the Playwright `TestServer` is running, the harness is connected, a terminal pane is visible, and request recording starts immediately before the user clicks `Editor`.
    Actions: open the pane context menu, split horizontally, choose `Editor`, record JS asset requests before and after the click, wait for the editor loading shell and then `[data-testid="editor-pane"]`, and capture the loaded editor screenshot/assertion.
    Expected outcome: opening the editor causes at least one additional `.js` asset request after the click, the browser eventually renders the editor pane with its toolbar/empty state, and the final screenshot remains stable enough to serve as the visual contract. Sources: `Plan-AC`, `Plan-T5`, `Repo-ui`, `Transcript`, `Docs-react`.
    Interactions: browser UI, Vite production assets, Playwright request observation, `window.__FRESHELL_TEST_HARNESS__`, screenshot baselines.

19. Name: `TabsView` skips rerendering on unrelated parent rerenders when `onOpenTab` is stable and rerenders when the callback identity changes
    Type: unit
    Disposition: new `test/unit/client/components/TabsView.memo.test.tsx`
    Harness: H5
    Preconditions: `TabsView` is rendered with realistic props inside a parent component whose rerender can be triggered without changing child-visible data.
    Actions: rerender the parent once with a stable `onOpenTab` callback and once with a fresh inline callback while keeping the rest of the props unchanged.
    Expected outcome: the stable-callback case does not rerender `TabsView`, while the fresh-callback case does rerender it and demonstrates why `App.tsx` must stabilize `onOpenTab`. Sources: `Plan-AC`, `Plan-T6`, `Plan-FM`, `Docs-react`.
    Interactions: parent prop identity, `TabsView` memo boundary, React shallow prop comparison.

20. Name: `TerminalView` skips rerendering on identical props but still rerenders when a real prop change such as `hidden` occurs
    Type: unit
    Disposition: new `test/unit/client/components/TerminalView.memo.test.tsx`
    Harness: H5
    Preconditions: the existing xterm/runtime mocks are available and the same `paneContent` object instance can be reused across rerenders.
    Actions: rerender a parent around `TerminalView` with unchanged `tabId`, `paneId`, `hidden`, and `paneContent`; then rerender again with `hidden` flipped.
    Expected outcome: the identical-prop rerender does not rerender `TerminalView`, while the `hidden` flip does rerender and preserves the existing visibility behavior. Sources: `Plan-AC`, `Plan-T6`, `Repo-ui`, `Docs-react`.
    Interactions: React memo boundary, `TerminalView` visibility prop, xterm/runtime mock surfaces.

21. Name: existing tab-registry and terminal behavior suites stay green after memoization and lazy-editor changes
    Type: regression
    Disposition: existing suites kept green: `test/integration/client/editor-pane.test.tsx`, `test/unit/client/components/TabsView.test.tsx`, `test/unit/client/components/TerminalView.visibility.test.tsx`, `test/unit/client/components/TerminalView.lifecycle.test.tsx`, `test/e2e/tabs-view-flow.test.tsx`
    Harness: H3 and H5
    Preconditions: the memo and lazy-loading changes are landed.
    Actions: run the listed existing suites without relaxing assertions.
    Expected outcome: the user-visible tab copy/open flows, terminal visibility behavior, and terminal lifecycle/reconnect behavior remain unchanged after the performance work. Sources: `Plan-AC`, `Plan-T5`, `Plan-T6`, `Transcript`.
    Interactions: tab registry UI, pane/terminal reducers, xterm runtime mocks, tab-copy scenario behavior.

22. Name: the focused server regression suite passes after the async LAN, async local-file, and async-only WSL changes
    Type: regression
    Disposition: existing/extended suites run together
    Harness: H1 and H2
    Preconditions: the implementation for tasks 1 through 3 is landed in the worktree.
    Actions: run `npm run test:vitest -- --config vitest.server.config.ts run test/unit/server/bootstrap.test.ts test/unit/server/network-manager.test.ts test/unit/server/wsl-port-forward.test.ts test/integration/server/lan-info-api.test.ts test/integration/server/local-file-router.test.ts test/integration/server/network-api.test.ts`.
    Expected outcome: the focused server suite passes as the main red-to-green server acceptance gate. Sources: `Plan-T7`, `Plan-AC`, `Repo-scripts`.
    Interactions: Vitest coordinator path, server runtime modules, router integration tests, WSL planner mocks.

23. Name: the focused client and browser regression suite passes after lazy editor loading and memoization
    Type: regression
    Disposition: existing/extended suites run together
    Harness: H1, H3, H4, and H5
    Preconditions: the implementation for tasks 5 and 6 is landed in the worktree.
    Actions: run `npm run test:vitest -- run test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/panes/PaneLayout.test.tsx test/integration/client/editor-pane.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/components/TabsView.memo.test.tsx test/unit/client/components/TerminalView.visibility.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.memo.test.tsx test/e2e/tabs-view-flow.test.tsx`; then run `npm run test:e2e:chromium -- test/e2e-browser/specs/editor-pane.spec.ts`.
    Expected outcome: the focused client/browser suite passes and preserves user-visible behavior while proving the lazy editor and memo boundaries. Sources: `Plan-T7`, `Plan-AC`, `Repo-scripts`.
    Interactions: Vitest jsdom suites, Playwright browser harness, lazy chunk loading, tab/terminal UI behavior.

24. Name: lint and the coordinated broad gate pass for the full landed performance-fixes state
    Type: regression
    Disposition: existing command gates
    Harness: H1
    Preconditions: the targeted server and client/browser gates are already green and the test coordinator is available.
    Actions: run `npm run lint`; then run `FRESHELL_TEST_SUMMARY="performance fixes" npm run check`.
    Expected outcome: lint passes without frontend regressions and the coordinated `check` gate passes as the broad acceptance gate for the whole change set. Sources: `Plan-AC`, `Plan-T7`, `Repo-scripts`.
    Interactions: ESLint, test coordinator gate, full-suite orchestration, typecheck + test composite command path.

## Coverage summary

- Covered action space:
- `tsx watch server/index.ts` startup and rerun behavior from the real shell command.
- `package.json` watch-script invariants after the watch probe.
- Async LAN detection surfaces: `detectLanIpsAsync()`, `NetworkManager.configure()`, `NetworkManager.initializeFromStartup()`, and `GET /api/lan-info`.
- WSL planning surfaces: async repair and teardown planners plus their public export contract.
- `GET /local-file` through its real HTTP surface for unauthorized, missing-path, missing-file, directory, readable-file, and unexpected-error cases.
- `npm run typecheck`, `npm run build:electron`, `npm run build:client`, `npm run lint`, and `FRESHELL_TEST_SUMMARY="performance fixes" npm run check`.
- Pane picker `Editor` activation, editor loading shell visibility, editor chunk loading, browser-visible editor rendering, and editor screenshot stability.
- Memo-sensitive parent rerenders for `TabsView` and `TerminalView`, plus existing tab and terminal regression suites.

- Explicitly excluded per the approved strategy:
- No manual QA or human-only visual review. Visual proof is screenshot-based and browser-asserted.
- No live Windows UAC automation or real WSL/Windows firewall mutation. The plan stays on mocked WSL/firewall/process boundaries plus real router/module/browser surfaces.
- No change to `package.json` watch scripts unless test 1 proves a real restart bug.
- No hard absolute performance threshold for warm typecheck speedups; the acceptance criterion is a materially faster warm rerun in the same environment.

- Residual risks carried by those exclusions:
- Real WSL/Windows networking behavior is still represented through mocks and parser fixtures, so OS-specific shell quirks outside the modeled outputs could still escape.
- Client chunk-splitting assertions must stay filename-agnostic; if they overfit exact emitted chunk names, they will become brittle without improving correctness.
- Typecheck timing remains machine-sensitive; a meaningful relative comparison is appropriate, but it cannot prove an exact cross-machine speed target.

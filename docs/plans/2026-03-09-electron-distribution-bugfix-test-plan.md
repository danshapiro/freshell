# Electron Distribution Bugfix — Test Plan

## Strategy reconciliation

The agreed testing strategy is to use the existing full test suite (unit, integration, Electron, E2E browser tests) plus manual Electron app validation. The implementation plan proposes 5 discrete bug fixes, all touching the `electron/` module layer. The existing test infrastructure is well-suited:

- **Electron unit tests** (`vitest.electron.config.ts`, `test/unit/electron/`) already cover `startup.ts`, `main.ts`, `server-spawner.ts`, and `window-state.ts` with dependency-injected mocks. All 5 fixes are testable through these harnesses with no new infrastructure required.
- **Full suite regression** (`npm test`, `npm run test:electron`) validates nothing else broke.
- **E2E browser tests** (Playwright, `test/e2e-browser/`) verify the web client's auth flow (`auth.spec.ts`), which is the downstream consumer of the `?token=` URL parameter that Task 5 fixes. These tests already pass the token via URL and confirm the connection reaches `ready` state.
- **Manual Electron validation** is still needed for the final packaged `.exe`, since the test suite cannot run inside a packaged Electron app. This covers the integration between `entry.ts` (the only untested file, by design) and the DI modules.

No strategy adjustments are needed. The plan's interfaces match what the strategy assumed. No new external dependencies or paid services are introduced.

---

## Test plan

### 1. Wizard-to-main transition completes without app exit on Windows/Linux

- **Type:** scenario
- **Harness:** Electron unit tests (`vitest.electron.config.ts`)
- **Preconditions:** `setupCompleted: false` on first call, then `setupCompleted: true` on recursive `main()` call. Platform is `win32` (non-macOS). Both `entry.ts`'s consolidated handler and `main.ts` are involved.
- **Actions:**
  1. Call `runStartup` with `setupCompleted: false` — returns `{ type: 'wizard' }`.
  2. Simulate wizard close by calling `runStartup` again with `setupCompleted: true`.
  3. Call `initMainProcess` with the resulting window. Platform = `win32`.
  4. Emit `window-all-closed` on the mock app.
- **Expected outcome:** After Task 3, `initMainProcess` must NOT register a `window-all-closed` handler. The `window-all-closed` event should not trigger `app.quit()` when emitted after the wizard-to-main transition, because the handler is now in `entry.ts` with a `wizardPhase` guard. Verify `app.quit()` is NOT called during the wizard phase, and IS called after `wizardPhase = false`.
- **Source of truth:** Implementation plan Task 3 — "consolidate the handler in entry.ts with a wizardPhase guard, remove handler from main.ts."
- **Interactions:** `startup.ts` (wizard detection), `main.ts` (lifecycle management), `entry.ts` (handler consolidation).

### 2. Windows node binary path resolves to node.exe

- **Type:** scenario
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/startup.test.ts`)
- **Preconditions:** Production mode (`isDev: false`), `resourcesPath` set to a Windows-style path, `platform: 'win32'` in `StartupContext`, `setupCompleted: true`, server mode `app-bound`.
- **Actions:**
  1. Create context with `platform: 'win32'` and `resourcesPath: 'C:\\Program Files\\Freshell\\resources'`.
  2. Call `runStartup(ctx)`.
  3. Inspect the `nodeBinary` argument passed to `serverSpawner.start()`.
- **Expected outcome:** `startArgs.spawn.nodeBinary` ends with `node.exe` (regex: `/node\.exe$/`).
- **Source of truth:** Implementation plan Task 1 — "change nodeBinary construction to `ctx.platform === 'win32' ? 'node.exe' : 'node'`."
- **Interactions:** `startup.ts` (path construction), `server-spawner.ts` (consumes the path in `spawn()`).

### 3. Linux/macOS node binary path resolves to node (no .exe)

- **Type:** regression
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/startup.test.ts`)
- **Preconditions:** Production mode, `platform: 'linux'`, `resourcesPath: '/app/resources'`.
- **Actions:**
  1. Create context with `platform: 'linux'`.
  2. Call `runStartup(ctx)`.
  3. Inspect `nodeBinary` in the `serverSpawner.start()` call.
- **Expected outcome:** `startArgs.spawn.nodeBinary` ends with `/node` (not `/node.exe`). The existing test at line 162 (`toContain('/app/resources/bundled-node/bin/node')`) should continue to pass.
- **Source of truth:** Existing test behavior (regression protection). Plan Task 1 specifies the conditional logic preserves the non-Windows path.
- **Interactions:** `startup.ts` only.

### 4. Server CWD is set to configDir when spawning in production mode

- **Type:** integration
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/server-spawner.test.ts`)
- **Preconditions:** `createServerSpawner()` instance, production spawn mode options with `configDir: '/home/user/.freshell'`.
- **Actions:**
  1. Call `spawner.start()` with production spawn mode and `configDir: '/home/user/.freshell'`.
  2. Inspect the third argument (options) of the `spawn()` mock call.
- **Expected outcome:** `opts.cwd` equals `'/home/user/.freshell'`. This ensures that `bootstrap.ts`'s `resolveProjectRoot()` (which returns `process.cwd()`) resolves to `~/.freshell/`, and `dotenv/config` finds `.env` there.
- **Source of truth:** Implementation plan Task 2 — "pass configDir as cwd to spawn()." Upstream contract: `bootstrap.ts` line 313-314 (`resolveProjectRoot` returns `process.cwd()`).
- **Interactions:** `server-spawner.ts` (spawn call), `bootstrap.ts` (uses cwd for `.env` resolution).

### 5. Server CWD is set to configDir when spawning in dev mode

- **Type:** integration
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/server-spawner.test.ts`)
- **Preconditions:** `createServerSpawner()` instance, dev spawn mode options with `configDir: '/home/user/.freshell'`.
- **Actions:**
  1. Call `spawner.start()` with dev spawn mode and `configDir: '/home/user/.freshell'`.
  2. Inspect the third argument of the `spawn()` mock call.
- **Expected outcome:** `opts.cwd` equals `'/home/user/.freshell'`.
- **Source of truth:** Same as test 4 — the `cwd` fix applies to the single `spawn()` call that handles both modes.
- **Interactions:** `server-spawner.ts` only.

### 6. initMainProcess does NOT register window-all-closed handler

- **Type:** regression
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/main.test.ts`)
- **Preconditions:** `createMockApp()`, standard `MainProcessDeps`.
- **Actions:**
  1. Call `initMainProcess(deps)`.
  2. Inspect `app.on` calls for `'window-all-closed'`.
- **Expected outcome:** No `app.on` call with event `'window-all-closed'` was made by `initMainProcess`. After Task 3, the handler is moved to `entry.ts`.
- **Source of truth:** Implementation plan Task 3 — "remove lines 74-78 (the window-all-closed handler) from main.ts."
- **Interactions:** `main.ts` only. The existing three `window-all-closed` tests in `main.test.ts` (lines 100-121) must be removed or updated, since they assert behavior that is being moved to `entry.ts`.

### 7. Auth token appended to URL for app-bound mode

- **Type:** scenario
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/startup.test.ts`)
- **Preconditions:** Server mode `app-bound`, production, `readEnvToken` returns `'test-auth-token-abc'`.
- **Actions:**
  1. Create context with `readEnvToken: vi.fn().mockResolvedValue('test-auth-token-abc')`.
  2. Call `runStartup(ctx)`.
  3. Inspect `mockWindow.loadURL` call argument.
- **Expected outcome:** `mockWindow.loadURL` called with `'http://localhost:3001?token=test-auth-token-abc'`.
- **Source of truth:** Implementation plan Task 5 — "append ?token=<AUTH_TOKEN> to the URL passed to window.loadURL()." Client-side source of truth: `src/lib/auth.ts:39-48` (`initializeAuthToken` extracts `?token=` from URL).
- **Interactions:** `startup.ts` (URL construction), `src/lib/auth.ts` (downstream consumer in renderer).

### 8. Auth token appended to URL for daemon mode

- **Type:** scenario
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/startup.test.ts`)
- **Preconditions:** Server mode `daemon`, `readEnvToken` returns `'daemon-token-xyz'`, daemon status is installed and running.
- **Actions:**
  1. Create context with daemon mode config and `readEnvToken: vi.fn().mockResolvedValue('daemon-token-xyz')`.
  2. Call `runStartup(ctx)`.
  3. Inspect `mockWindow.loadURL` call argument.
- **Expected outcome:** `mockWindow.loadURL` called with `'http://localhost:3001?token=daemon-token-xyz'`.
- **Source of truth:** Same as test 7. The daemon mode path should use `readEnvToken` identically to app-bound.
- **Interactions:** `startup.ts`, `daemon-manager` (status check), `src/lib/auth.ts` (downstream).

### 9. Auth token appended to URL for remote mode using remoteToken

- **Type:** scenario
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/startup.test.ts`)
- **Preconditions:** Server mode `remote`, `remoteUrl: 'http://10.0.0.5:3001'`, `remoteToken: 'remote-secret-123'`, health check passes.
- **Actions:**
  1. Create context with remote mode config including `remoteToken`.
  2. Call `runStartup(ctx)`.
  3. Inspect `mockWindow.loadURL` call argument.
- **Expected outcome:** `mockWindow.loadURL` called with `'http://10.0.0.5:3001?token=remote-secret-123'`.
- **Source of truth:** Implementation plan Task 5 — "For remote mode: use desktopConfig.remoteToken from the wizard config."
- **Interactions:** `startup.ts` (URL construction), remote server (assumed reachable via mock).

### 10. URL loaded without token when readEnvToken returns undefined

- **Type:** boundary
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/startup.test.ts`)
- **Preconditions:** App-bound mode, `readEnvToken` returns `undefined`.
- **Actions:**
  1. Create context with `readEnvToken: vi.fn().mockResolvedValue(undefined)`.
  2. Call `runStartup(ctx)`.
  3. Inspect `mockWindow.loadURL` call argument.
- **Expected outcome:** `mockWindow.loadURL` called with `'http://localhost:3001'` (no `?token=` suffix).
- **Source of truth:** Implementation plan Task 5 — "const loadUrl = authToken ? `${serverUrl}?token=${authToken}` : serverUrl".
- **Interactions:** `startup.ts` only.

### 11. URL loaded without token when readEnvToken is not provided (backward compat)

- **Type:** regression
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/startup.test.ts`)
- **Preconditions:** App-bound mode, `readEnvToken` not in context (existing tests do not provide it).
- **Actions:**
  1. Create context via `createDefaultContext()` without `readEnvToken` override.
  2. Call `runStartup(ctx)`.
  3. Inspect `mockWindow.loadURL` call argument.
- **Expected outcome:** `mockWindow.loadURL` called with `'http://localhost:3001'`. The existing test at line 402 must continue to pass without modification.
- **Source of truth:** Implementation plan Task 5, Step 5 — "This test's createDefaultContext does not provide readEnvToken, so ctx.readEnvToken is undefined, which means authToken will be undefined and the URL will remain unchanged."
- **Interactions:** `startup.ts` only.

### 12. Window state saved on resize with debounce

- **Type:** integration
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/startup.test.ts`)
- **Preconditions:** `BrowserWindowLike` mock with `getBounds` and `isMaximized` methods, fake timers enabled.
- **Actions:**
  1. Create context with a mock window that has `getBounds` returning `{ x: 100, y: 200, width: 800, height: 600 }` and `isMaximized` returning `false`.
  2. Call `runStartup(ctx)`.
  3. Find the `'resize'` handler registered via `window.on`.
  4. Call the resize handler.
  5. Advance fake timers by 600ms (past the 500ms debounce).
- **Expected outcome:** `windowStatePersistence.save` called with `{ x: 100, y: 200, width: 800, height: 600, maximized: false }`.
- **Source of truth:** Implementation plan Task 4 — "add debounced resize/move event handlers on the BrowserWindow."
- **Interactions:** `startup.ts` (handler registration), `window-state.ts` (save interface).

### 13. Window state saved on move with debounce

- **Type:** integration
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/startup.test.ts`)
- **Preconditions:** Same as test 12.
- **Actions:**
  1. Same setup as test 12.
  2. Find the `'move'` handler registered via `window.on`.
  3. Call the move handler.
  4. Advance fake timers by 600ms.
- **Expected outcome:** `windowStatePersistence.save` called with the bounds returned by `getBounds`.
- **Source of truth:** Same as test 12. Plan specifies both `resize` and `move` handlers.
- **Interactions:** Same as test 12.

### 14. Window state save is debounced (rapid events coalesce)

- **Type:** boundary
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/startup.test.ts`)
- **Preconditions:** Same setup as test 12, fake timers.
- **Actions:**
  1. Find the `'resize'` handler.
  2. Call the resize handler 5 times in rapid succession (no timer advancement between calls).
  3. Advance fake timers by 600ms.
- **Expected outcome:** `windowStatePersistence.save` called exactly once (not 5 times).
- **Source of truth:** Plan Task 4 code sketch: `clearTimeout(saveTimeout)` before `setTimeout(...)` — classic debounce pattern.
- **Interactions:** `startup.ts` only.

### 15. Window state not saved before debounce period expires

- **Type:** boundary
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/startup.test.ts`)
- **Preconditions:** Same setup as test 12, fake timers.
- **Actions:**
  1. Find the `'resize'` handler.
  2. Call the resize handler once.
  3. Advance fake timers by 100ms (less than the 500ms debounce).
- **Expected outcome:** `windowStatePersistence.save` NOT called.
- **Source of truth:** Plan Task 4 — debounce is 500ms.
- **Interactions:** `startup.ts` only.

### 16. Existing remote mode test still passes after auth changes

- **Type:** regression
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/startup.test.ts`)
- **Preconditions:** Remote mode with `remoteUrl: 'http://10.0.0.5:3001'`, no `remoteToken` in config, `fetchHealthCheck` passes.
- **Actions:**
  1. Create context with remote mode config that has no `remoteToken`.
  2. Call `runStartup(ctx)`.
  3. Inspect `mockWindow.loadURL` call argument.
- **Expected outcome:** `mockWindow.loadURL` called with `'http://10.0.0.5:3001'` (no token suffix). The existing test (line 206-227) verifies `result.serverUrl` is the remote URL.
- **Source of truth:** Plan Task 5 — for remote mode, `authToken = desktopConfig.remoteToken`. If `remoteToken` is undefined, no token appended.
- **Interactions:** `startup.ts` only.

### 17. All existing electron tests pass (full regression)

- **Type:** regression
- **Harness:** Full electron test suite (`npx vitest run --config vitest.electron.config.ts`)
- **Preconditions:** All 5 tasks implemented.
- **Actions:** Run `npm run test:electron` (or equivalent vitest command).
- **Expected outcome:** All tests pass (192+ existing tests, plus new tests from this plan).
- **Source of truth:** Existing test suite is the regression baseline.
- **Interactions:** All electron modules.

### 18. All existing unit/integration tests pass (full regression)

- **Type:** regression
- **Harness:** Full test suite (`npm test`)
- **Preconditions:** All 5 tasks implemented.
- **Actions:** Run `npm test`.
- **Expected outcome:** All 2261+ tests pass with 0 failures.
- **Source of truth:** Existing test suite.
- **Interactions:** Full codebase.

### 19. readEnvToken correctly parses AUTH_TOKEN from .env file

- **Type:** unit
- **Harness:** Electron unit tests. This tests the `readEnvToken` function that will be defined in `entry.ts` and passed to `StartupContext`. Since `entry.ts` is not unit-testable (it uses real Electron APIs), this logic should be tested via the `startup.test.ts` mock infrastructure — specifically by verifying the contract that `readEnvToken` is called with the correct path argument.
- **Preconditions:** `readEnvToken` mock provided in context, `configDir: '/home/user/.freshell'`.
- **Actions:**
  1. Create context with `readEnvToken` mock.
  2. Call `runStartup(ctx)`.
  3. Inspect what path was passed to `readEnvToken`.
- **Expected outcome:** `readEnvToken` called with `'/home/user/.freshell/.env'` (i.e., `path.join(ctx.configDir, '.env')`).
- **Source of truth:** Plan Task 5, Step 3 — `authToken = await ctx.readEnvToken(path.join(ctx.configDir, '.env'))`.
- **Interactions:** `startup.ts` (calls readEnvToken), `entry.ts` (provides implementation).

### 20. readEnvToken not called for remote mode

- **Type:** boundary
- **Harness:** Electron unit tests (`vitest.electron.config.ts`, `test/unit/electron/startup.test.ts`)
- **Preconditions:** Remote mode with `remoteToken`, `readEnvToken` mock provided.
- **Actions:**
  1. Create context with remote mode config including `remoteToken: 'remote-token'`, and `readEnvToken: vi.fn()`.
  2. Call `runStartup(ctx)`.
- **Expected outcome:** `readEnvToken` NOT called. Remote mode uses `desktopConfig.remoteToken`, not the `.env` file.
- **Source of truth:** Plan Task 5, Step 3 — the `if (desktopConfig.serverMode === 'remote')` branch uses `remoteToken` directly.
- **Interactions:** `startup.ts` only.

### 21. platform field required on StartupContext (TypeScript compilation)

- **Type:** invariant
- **Harness:** TypeScript compiler (`tsc -p tsconfig.electron.json`)
- **Preconditions:** Task 1 implementation complete.
- **Actions:** Run the TypeScript compiler on the electron config.
- **Expected outcome:** No type errors. `createDefaultContext` in tests includes `platform`. `entry.ts` provides `platform: process.platform`.
- **Source of truth:** Plan Task 1 — "Add platform: NodeJS.Platform to the StartupContext interface."
- **Interactions:** All consumers of `StartupContext`.

---

## Coverage summary

### Areas covered

| Bug | Tests covering it |
|-----|-------------------|
| Windows node binary path (.exe) | Tests 2, 3, 21 |
| Server CWD / .env resolution | Tests 4, 5 |
| Duplicate window-all-closed handlers | Tests 1, 6 |
| Window state persistence (save) | Tests 12, 13, 14, 15 |
| Auth token via URL ?token= | Tests 7, 8, 9, 10, 11, 16, 19, 20 |
| Full regression (nothing else broke) | Tests 17, 18 |

### Areas explicitly excluded

- **Packaged Electron .exe validation:** Cannot be tested automatically. Requires manual validation: install the built `.exe`, verify wizard completes, server starts, terminal session works with authentication. This is acknowledged in the testing strategy.
- **Cross-platform daemon service installation/management:** Not touched by these 5 bug fixes. Existing daemon tests (launchd, systemd, windows-service) provide coverage.
- **Auto-updater flow:** Not touched by these fixes. Existing `updater.test.ts` covers it.
- **E2E browser tests for the auth flow:** Already exist (`test/e2e-browser/specs/auth.spec.ts`) and verify the downstream `?token=` URL parameter consumption. These tests are part of the full regression run (Test 18) but are not new tests in this plan because the auth client code (`src/lib/auth.ts`) is not being modified.

### Risks of exclusions

- The manual Electron validation gap means that the integration between `entry.ts` (untested by design) and the DI modules is only verified by building and running the app. If `entry.ts`'s `readEnvToken` implementation has a bug (e.g., incorrect `.env` parsing regex), it would not be caught by the unit test mock. However, the `readEnvToken` function is simple (15 lines, parse `AUTH_TOKEN=` from a file) and its contract (path in, token out) is verified via mocks.
- The `.env` file is created by `bootstrap.ts` on the server side, and `readEnvToken` in `entry.ts` is a separate parser. If the two disagree on format (e.g., quotes, whitespace), the token read would fail silently. This is mitigated by `readEnvToken` stripping quotes (per plan Task 5, Step 4) and `bootstrap.ts` not using quotes.

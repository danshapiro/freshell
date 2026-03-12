# Freshell Electron Distribution -- Test Plan

**Date:** 2026-03-08
**Implementation plan:** `docs/plans/2026-03-08-electron-distribution-impl.md`
**Design doc:** `docs/plans/2026-03-08-electron-distribution-design.md`

---

## Strategy Reconciliation

The agreed testing strategy was **medium fidelity**:
- Unit tests for all new modules using vitest with mocked OS/Electron APIs
- Integration tests for the server-info endpoint using supertest (same pattern as existing API tests)
- No E2E Playwright tests for v1 (deferred -- would require building the full Electron app)
- Separate `vitest.electron.config.ts` for electron tests
- Tests written TDD-style (red-green-refactor)
- Three vitest configs: client (jsdom), server (node), electron (node)

After reviewing the implementation plan, the strategy holds with one clarification:

**Wizard component tests require jsdom.** The implementation plan specifies that `test/unit/electron/setup-wizard/wizard.test.tsx` uses `// @vitest-environment jsdom` to override the electron config's default `node` environment. The `vitest.electron.config.ts` includes the `react()` plugin for JSX transform. This is consistent with the strategy -- no change in cost or scope.

---

## Harness Requirements

### H1: Electron API mock harness

**What it does:** Provides mock implementations of Electron's `app`, `BrowserWindow`, `globalShortcut`, `Tray`, `Menu`, `MenuItem`, `nativeImage`, `contextBridge`, `ipcRenderer`, and `ipcMain` modules. These are the Electron APIs consumed by the main process modules.

**What it exposes:**
- Mock constructors that record instantiation arguments and method calls
- Spy-able event emitters (e.g., `app.on('ready', ...)`, `BrowserWindow.on('close', ...)`)
- State inspection (e.g., `mockBrowserWindow.loadedURL`, `mockTray.contextMenuItems`)
- A `resetAllElectronMocks()` utility for `beforeEach`

**Estimated complexity:** Low-medium. Each mock is a shallow object with vi.fn() methods. No real Electron runtime needed. Pattern is well-established in the codebase (see `mockPtyProcess` in `terminal-lifecycle.test.ts`).

**Tests that depend on it:** Tests 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15.

### H2: OS command mock harness (child_process + fs)

**What it does:** Provides mock implementations of `child_process.execFile`, `child_process.spawn`, and filesystem operations for daemon management and server spawning tests. Uses vi.mock or dependency injection.

**What it exposes:**
- Configurable command responses (stdout, stderr, exit codes)
- File existence/content simulation
- Process event simulation (stdout data, exit, error)
- Call history inspection

**Estimated complexity:** Low. The existing codebase uses this pattern extensively (see `firewall.test.ts` dependency injection pattern). Daemon managers can use either vi.mock or injected deps.

**Tests that depend on it:** Tests 1, 2, 3, 4, 5, 6, 9.

### H3: Filesystem mock for config operations

**What it does:** Provides isolated temporary directories for desktop-config tests. Mocks `os.homedir()` to point at a temp directory, same pattern as `settings-api.test.ts`.

**What it exposes:**
- Per-test temp directory creation/cleanup
- Redirected homedir for config file isolation
- Pre-seeding config files with known content

**Estimated complexity:** Low. Direct copy of the pattern in `settings-api.test.ts`.

**Tests that depend on it:** Tests 1, 2, 16, 17.

---

## Test Plan

### Scenario Tests

#### Test 1: First-run user completes setup wizard and launches app in app-bound mode

- **Name:** First-time user completes setup and the app starts with app-bound server
- **Type:** scenario
- **Harness:** H1 (Electron mocks), H2 (child_process/spawn mock), H3 (filesystem mock)
- **Preconditions:** No `~/.freshell/desktop.json` exists. Server spawner mock is configured to simulate successful health check after spawn.
- **Actions:**
  1. Call `readDesktopConfig()` -- returns null (no config file)
  2. Call `getDefaultDesktopConfig()` -- returns defaults with `setupCompleted: false`
  3. Call `runStartup(ctx)` where `ctx.desktopConfig.setupCompleted === false`
  4. Verify startup returns wizard signal (not main window)
  5. Simulate wizard completion: call `writeDesktopConfig()` with `{ serverMode: 'app-bound', setupCompleted: true, globalHotkey: 'CommandOrControl+\`' }`
  6. Call `runStartup(ctx)` again with the written config
  7. Verify `serverSpawner.start()` was called
  8. Verify a BrowserWindow was created and loaded the server URL
  9. Verify `hotkeyManager.register()` was called with `'CommandOrControl+\`'`
  10. Verify tray was created
- **Expected outcome:**
  - Step 4: startup returns a signal indicating wizard should be shown (source: impl plan Section 3.7 -- "If `!setupCompleted`, return early with signal to show wizard")
  - Step 7: `serverSpawner.start()` called with app-bound options (source: impl plan Section 3.7 -- "`app-bound`: Call `serverSpawner.start(...)`")
  - Step 8: BrowserWindow created and URL loaded (source: impl plan Section 3.7 -- "Load window state, create BrowserWindow, load serverUrl")
  - Step 9: hotkey registered (source: impl plan Section 3.7 -- "Register global hotkey")
  - Step 10: tray created (source: impl plan Section 3.7 -- "Create system tray")
- **Interactions:** desktop-config (fs), server-spawner (child_process), window-state (desktop-config), hotkey (globalShortcut), tray (Tray API). These boundaries are where startup sequencing bugs would hide.

#### Test 2: User starts app in daemon mode with service already running

- **Name:** App connects to an already-running daemon and opens the main window
- **Type:** scenario
- **Harness:** H1 (Electron mocks), H2 (OS command mock)
- **Preconditions:** `desktop.json` exists with `{ serverMode: 'daemon', setupCompleted: true }`. DaemonManager mock returns `{ installed: true, running: true, pid: 12345 }`.
- **Actions:**
  1. Call `runStartup(ctx)` with daemon-mode config
  2. Verify `daemonManager.status()` was called
  3. Verify `daemonManager.start()` was NOT called (already running)
  4. Verify `serverSpawner.start()` was NOT called (daemon mode, not app-bound)
  5. Verify BrowserWindow was created and loaded `http://localhost:{port}`
- **Expected outcome:**
  - Step 2: status checked (source: impl plan Section 3.7 -- "Check `daemonManager.status()`")
  - Step 3: no redundant start (source: impl plan Section 3.7 -- "If not running, `daemonManager.start()`" -- implies skip if running)
  - Step 5: window loads server URL (source: impl plan Section 3.7 -- "Determine `serverUrl` based on mode")
- **Interactions:** daemon-manager (OS commands), startup orchestrator. The boundary between "check status" and "decide whether to start" is where state mismatch bugs concentrate.

#### Test 3: User starts app in daemon mode but service is not running

- **Name:** App starts a stopped daemon before opening the main window
- **Type:** scenario
- **Harness:** H1 (Electron mocks), H2 (OS command mock)
- **Preconditions:** `desktop.json` exists with `{ serverMode: 'daemon', setupCompleted: true }`. DaemonManager mock returns `{ installed: true, running: false }` initially, then `{ installed: true, running: true }` after `start()`.
- **Actions:**
  1. Call `runStartup(ctx)` with daemon-mode config
  2. Verify `daemonManager.status()` was called
  3. Verify `daemonManager.start()` was called (not running)
  4. Verify BrowserWindow was created
- **Expected outcome:**
  - Step 3: `start()` called because status showed not-running (source: impl plan Section 3.7 -- "If not running, `daemonManager.start()`")
  - Step 4: window created after daemon started (source: impl plan Section 3.7)
- **Interactions:** daemon-manager state transitions (not-running -> running).

#### Test 4: User starts app in daemon mode but service is not installed

- **Name:** App throws descriptive error when daemon service is not installed
- **Type:** scenario
- **Harness:** H1 (Electron mocks), H2 (OS command mock)
- **Preconditions:** `desktop.json` exists with `{ serverMode: 'daemon', setupCompleted: true }`. DaemonManager mock returns `{ installed: false, running: false }`.
- **Actions:**
  1. Call `runStartup(ctx)` with daemon-mode config
  2. Verify startup throws an error
- **Expected outcome:**
  - Step 2: throws with message to re-run setup (source: impl plan Section 3.7 -- "If not installed, throw with message to re-run setup")
- **Interactions:** daemon-manager to startup-orchestrator error path.

#### Test 5: User starts app in remote mode with valid remote server

- **Name:** App connects to remote server and opens main window
- **Type:** scenario
- **Harness:** H1 (Electron mocks), H2 (http mock for fetch)
- **Preconditions:** `desktop.json` exists with `{ serverMode: 'remote', remoteUrl: 'http://10.0.0.5:3001', setupCompleted: true }`. HTTP mock returns 200 for `http://10.0.0.5:3001/api/health`.
- **Actions:**
  1. Call `runStartup(ctx)` with remote-mode config
  2. Verify health check fetch was made to `http://10.0.0.5:3001/api/health`
  3. Verify BrowserWindow loaded `http://10.0.0.5:3001`
  4. Verify `serverSpawner.start()` was NOT called
  5. Verify `daemonManager.status()` was NOT called
- **Expected outcome:**
  - Step 2: connectivity validated (source: impl plan Section 3.7 -- "Validate connectivity via fetch to `remoteUrl + '/api/health'`")
  - Step 3: window loads remote URL (source: impl plan Section 3.7 -- "Determine `serverUrl` based on mode")
  - Steps 4-5: no local server interaction (source: design doc -- remote mode means "No local server needed")
- **Interactions:** HTTP/fetch boundary for health check. Network failures would manifest here.

#### Test 6: App-bound mode dev workflow spawns tsx instead of bundled node

- **Name:** Dev mode app-bound startup uses tsx to run server source directly
- **Type:** scenario
- **Harness:** H1 (Electron mocks), H2 (child_process mock)
- **Preconditions:** `desktop.json` with `{ serverMode: 'app-bound', setupCompleted: true }`. `ctx.isDev === true`.
- **Actions:**
  1. Call `runStartup(ctx)` with `isDev: true`
  2. Verify `serverSpawner.start()` was called with dev-mode spawn options (`{ mode: 'dev', tsxPath, serverSourceEntry: 'server/index.ts' }`)
  3. Verify BrowserWindow loaded the Vite dev server URL (`http://localhost:5173`), not the Express server
- **Expected outcome:**
  - Step 2: dev-mode spawn path used (source: impl plan Section 3.7 -- "In **dev mode** (`ctx.isDev`), pass `{ mode: 'dev', tsxPath: 'npx tsx', serverSourceEntry: 'server/index.ts' }`")
  - Step 3: window points at Vite dev server (source: impl plan Section 3.7 -- "also point the BrowserWindow at the Vite dev server (`http://localhost:5173`)")
- **Interactions:** server-spawner spawn-mode selection, URL determination. Dev/prod mode switching is a common source of bugs.

### Integration Tests

#### Test 7: /api/server-info returns correct response shape and requires auth

- **Name:** Server-info endpoint returns version, uptime, platform info and rejects unauthenticated requests
- **Type:** integration
- **Harness:** supertest against real Express app (same pattern as `settings-api.test.ts`, `lan-info-api.test.ts`)
- **Preconditions:** Express app mounted with auth middleware and `createServerInfoRouter({ appVersion: '0.6.0', startedAt: Date.now() })`.
- **Actions:**
  1. GET `/api/server-info` without auth token
  2. GET `/api/server-info` with invalid auth token
  3. GET `/api/server-info` with valid auth token
  4. Wait 50ms, GET `/api/server-info` again
- **Expected outcome:**
  - Step 1: 401 Unauthorized (source: design doc -- "New `/api/server-info` endpoint" is under `/api` which requires auth per existing pattern)
  - Step 2: 401 Unauthorized (source: same auth pattern as all `/api` routes)
  - Step 3: 200 with `{ version: '0.6.0', uptime: <number>, nodeVersion: <string>, platform: <string>, arch: <string> }` (source: impl plan Section 1.3 -- response shape)
  - Step 4: uptime in second response >= uptime in first response (source: impl plan Section 1.3 -- "Uptime increases between two calls")
- **Interactions:** auth middleware, Express router. This is the only server-side change in the entire implementation.

#### Test 8: Desktop config read/write/patch lifecycle with filesystem

- **Name:** Desktop config persists across read-write-patch cycles using atomic writes
- **Type:** integration
- **Harness:** H3 (filesystem mock with real temp directory)
- **Preconditions:** Temp directory exists. No `desktop.json` file present.
- **Actions:**
  1. Call `readDesktopConfig()` -- returns null
  2. Call `writeDesktopConfig(getDefaultDesktopConfig())`
  3. Call `readDesktopConfig()` -- returns the written config
  4. Call `patchDesktopConfig({ serverMode: 'daemon' })`
  5. Call `readDesktopConfig()` -- returns patched config
  6. Verify original `config.json` file was never created or modified
- **Expected outcome:**
  - Step 1: null (source: impl plan Section 1.1 -- "returns null if file doesn't exist")
  - Step 3: matches default config (source: impl plan Section 1.1 -- "readDesktopConfig" reads what was written)
  - Step 5: `serverMode` is `'daemon'`, other fields unchanged (source: impl plan Section 1.1 -- "read-modify-write with mutex")
  - Step 6: separate file confirmed (source: impl plan Section 1.1 -- "Does NOT touch `config.json`")
- **Interactions:** fs operations (atomic write with temp+rename), Zod validation, mutex serialization. The atomic write boundary is where data corruption bugs would appear.

#### Test 9: Daemon install-start-status-stop-uninstall lifecycle (per platform)

- **Name:** Daemon manager lifecycle operations issue correct OS commands in sequence
- **Type:** integration
- **Harness:** H2 (OS command mock)
- **Preconditions:** DaemonManager instantiated for the test platform (launchd, systemd, or windows-service). All OS commands mocked.
- **Actions (one test per platform -- launchd, systemd, windows-service):**
  1. Call `isInstalled()` -- returns false
  2. Call `install(paths, port)` -- writes config file, runs registration command
  3. Call `isInstalled()` -- returns true
  4. Call `start()` -- runs start command
  5. Call `status()` -- returns `{ installed: true, running: true }`
  6. Call `stop()` -- runs stop command
  7. Call `status()` -- returns `{ installed: true, running: false }`
  8. Call `uninstall()` -- runs unregistration command, removes config file
  9. Call `isInstalled()` -- returns false
- **Expected outcome (launchd example):**
  - Step 2: plist written to `~/Library/LaunchAgents/com.freshell.server.plist`, `launchctl load -w` called (source: impl plan Section 2.2)
  - Step 4: `launchctl start com.freshell.server` called (source: impl plan Section 2.2)
  - Step 5: status parsed from `launchctl list` output (source: impl plan Section 2.2)
  - Step 6: `launchctl stop com.freshell.server` called (source: impl plan Section 2.2)
  - Step 8: `launchctl unload` called, plist file removed (source: impl plan Section 2.2)
- **Interactions:** child_process.execFile, fs (plist/unit/task file write/delete). The interaction between file writes and command execution ordering is critical.

#### Test 10: Server spawner production mode spawns bundled node with correct NODE_PATH

- **Name:** Production-mode server spawner starts bundled node binary with correct environment
- **Type:** integration
- **Harness:** H2 (child_process mock)
- **Preconditions:** Mock `child_process.spawn` records arguments. Mock HTTP for health check polling.
- **Actions:**
  1. Call `serverSpawner.start({ mode: 'production', nodeBinary: '/app/resources/bundled-node/bin/node', serverEntry: '/app/resources/server/index.js', port: 3001, envFile: '/home/user/.freshell/.env', configDir: '/home/user/.freshell' })`
  2. Simulate health check response (200 on first poll)
  3. Verify spawn arguments
  4. Call `serverSpawner.isRunning()` -- returns true
  5. Call `serverSpawner.stop()`
  6. Verify SIGTERM sent
  7. Verify `isRunning()` returns false after process exit
- **Expected outcome:**
  - Step 3: `spawn` called with `nodeBinary` as command, `[serverEntry]` as args, env includes `NODE_ENV=production` and `NODE_PATH` containing both native-modules and server-node-modules directories (source: impl plan Section 5.3 -- "NODE_PATH prepends to Node's module resolution")
  - Step 4: running after health check passes (source: impl plan Section 3.1 -- "Resolves when /api/health responds")
  - Step 6: SIGTERM sent to process (source: impl plan Section 3.1 -- "sends SIGTERM, waits 5s, then SIGKILL")
- **Interactions:** child_process.spawn, HTTP polling, process signal handling. The NODE_PATH construction is the most critical detail.

### Invariant Tests

#### Test 11: DesktopConfig Zod schema rejects invalid values

- **Name:** Desktop config schema always rejects invalid server modes, non-URL remote URLs, and unknown fields
- **Type:** invariant
- **Harness:** None (pure Zod validation)
- **Preconditions:** `DesktopConfigSchema` imported.
- **Actions:**
  1. Parse `{ serverMode: 'invalid-mode' }` -- fails
  2. Parse `{ serverMode: 'daemon', remoteUrl: 'not-a-url' }` -- fails (invalid URL)
  3. Parse `{ serverMode: 'app-bound', globalHotkey: 'CommandOrControl+\`', setupCompleted: false, minimizeToTray: true, startOnLogin: false }` -- succeeds
  4. Parse `{ serverMode: 'daemon', unknownField: 'value' }` with strict mode -- behavior documented
- **Expected outcome:**
  - Step 1: Zod parse throws with invalid enum (source: impl plan Section 1.1 -- `z.enum(['daemon', 'app-bound', 'remote'])`)
  - Step 2: Zod parse throws with invalid URL (source: impl plan Section 1.1 -- `z.string().url().optional()`)
  - Step 3: parse succeeds with valid data (source: impl plan Section 1.1 -- schema definition)
- **Interactions:** None (pure data validation).

#### Test 12: Server-info uptime is always non-negative

- **Name:** Server-info endpoint uptime is always a non-negative integer
- **Type:** invariant
- **Harness:** supertest
- **Preconditions:** Server-info router instantiated with `startedAt <= Date.now()`.
- **Actions:**
  1. GET `/api/server-info` with auth
  2. Assert `uptime >= 0`
  3. Assert `typeof uptime === 'number'`
  4. Assert `Number.isInteger(uptime)` (Math.floor in implementation)
- **Expected outcome:**
  - All assertions pass (source: impl plan Section 1.3 -- `uptime: Math.floor((Date.now() - deps.startedAt) / 1000)`)
- **Interactions:** None.

#### Test 13: Preload script exposes exactly the expected API shape

- **Name:** Preload bridge exposes the documented API and nothing else
- **Type:** invariant
- **Harness:** H1 (contextBridge/ipcRenderer mock)
- **Preconditions:** Mock `contextBridge.exposeInMainWorld` to capture the exposed object.
- **Actions:**
  1. Import and execute the preload module
  2. Capture the object passed to `contextBridge.exposeInMainWorld('freshellDesktop', ...)`
  3. Assert it has exactly these keys: `platform`, `isElectron`, `getServerMode`, `getServerStatus`, `setGlobalHotkey`, `onUpdateAvailable`, `onUpdateDownloaded`, `installUpdate`
  4. Assert `isElectron === true`
  5. Assert each function key is a function
- **Expected outcome:**
  - Step 3: exact key set matches (source: impl plan Section 3.9 -- preload API definition)
  - Step 4: `isElectron` is `true` (source: impl plan Section 3.9)
- **Interactions:** contextBridge, ipcRenderer. The API shape is a contract between main and renderer processes.

### Boundary and Edge-Case Tests

#### Test 14: Server spawner times out if health check never responds

- **Name:** Server spawner rejects with timeout error when health endpoint never responds
- **Type:** boundary
- **Harness:** H2 (child_process mock, HTTP mock)
- **Preconditions:** Mock `child_process.spawn` returns a running process. Mock HTTP always returns connection refused or no response.
- **Actions:**
  1. Call `serverSpawner.start(...)` with a short timeout override (1 second for test speed)
  2. Wait for rejection
- **Expected outcome:**
  - Rejects with a timeout error (source: impl plan Section 3.1 -- "Polls `http://localhost:{port}/api/health` with exponential backoff ... max 30s"; rejection on timeout is the boundary case)
- **Interactions:** HTTP polling timeout boundary, child_process state.

#### Test 15: Server spawner double-start kills old process first

- **Name:** Starting the server spawner when already running kills the existing process before spawning a new one
- **Type:** boundary
- **Harness:** H2 (child_process mock)
- **Preconditions:** Server spawner already started (first `start()` completed successfully).
- **Actions:**
  1. Call `serverSpawner.start(...)` again
  2. Verify the first process received SIGTERM/SIGKILL
  3. Verify a new process was spawned
  4. Verify `isRunning()` returns true
  5. Verify `pid()` returns the new PID (different from old)
- **Expected outcome:**
  - Step 2: old process killed (source: impl plan Section 3.1 -- "Double-start is idempotent (kills old process first)")
  - Step 3: new process spawned (source: same)
- **Interactions:** Process lifecycle management (kill + spawn sequencing).

#### Test 16: Concurrent config patches are serialized by mutex

- **Name:** Multiple simultaneous desktop config patches produce consistent results without lost updates
- **Type:** boundary
- **Harness:** H3 (filesystem mock)
- **Preconditions:** `desktop.json` exists with default config.
- **Actions:**
  1. Fire 5 concurrent `patchDesktopConfig()` calls, each setting a different field
  2. Read the final config
  3. Verify all 5 patches are reflected
- **Expected outcome:**
  - All patches applied (source: impl plan Section 1.1 -- "read-modify-write with mutex" and "Concurrent patches are serialized by mutex (no lost updates)")
- **Interactions:** fs read/write interleaving, mutex lock/unlock ordering.

#### Test 17: Desktop config validates on read -- rejects corrupt files

- **Name:** Reading a corrupt or invalid desktop.json returns null or throws rather than returning garbage
- **Type:** boundary
- **Harness:** H3 (filesystem mock)
- **Preconditions:** `desktop.json` exists but contains invalid JSON or invalid schema data.
- **Actions (two sub-cases):**
  1. Write invalid JSON (`{{{`) to `desktop.json`, then call `readDesktopConfig()`
  2. Write valid JSON but invalid schema (`{ "serverMode": 42 }`) to `desktop.json`, then call `readDesktopConfig()`
- **Expected outcome:**
  - Step 1: returns null or throws (source: impl plan Section 1.1 -- "Validates against schema (rejects invalid serverMode, etc.)")
  - Step 2: returns null or throws (source: same)
- **Interactions:** fs read, JSON parse, Zod validation.

#### Test 18: Platform factory throws for unsupported platform

- **Name:** Daemon manager factory throws descriptive error on unsupported platform
- **Type:** boundary
- **Harness:** None (mock `process.platform`)
- **Preconditions:** `process.platform` mocked to `'freebsd'`.
- **Actions:**
  1. Call `createDaemonManager()`
  2. Expect rejection with error message containing "Unsupported platform"
- **Expected outcome:**
  - Throws (source: impl plan Section 2.5 -- `throw new Error('Unsupported platform: ${process.platform}')`)
- **Interactions:** None.

#### Test 19: Platform factory returns correct implementation for each platform

- **Name:** Daemon manager factory returns launchd on darwin, systemd on linux, windows-service on win32
- **Type:** boundary
- **Harness:** None (mock `process.platform`)
- **Preconditions:** None.
- **Actions:**
  1. Mock `process.platform` to `'darwin'`, call `createDaemonManager()`, verify instance type
  2. Mock `process.platform` to `'linux'`, call `createDaemonManager()`, verify instance type
  3. Mock `process.platform` to `'win32'`, call `createDaemonManager()`, verify instance type
- **Expected outcome:**
  - Each returns the correct implementation class (source: impl plan Section 2.5 -- switch statement mapping)
- **Interactions:** Dynamic `import()` resolution per platform.

#### Test 20: Hotkey register returns false when accelerator conflicts

- **Name:** Hotkey registration reports failure when the OS rejects the shortcut
- **Type:** boundary
- **Harness:** H1 (globalShortcut mock)
- **Preconditions:** Mock `globalShortcut.register()` to return false (simulating conflict with another app).
- **Actions:**
  1. Call `hotkeyManager.register('CommandOrControl+Space', callback)`
  2. Verify it returns false
  3. Verify `current()` returns null
- **Expected outcome:**
  - Step 2: false (source: impl plan Section 3.3 -- "`register()` returns false if accelerator is already in use")
  - Step 3: null since registration failed (source: impl plan Section 3.3)
- **Interactions:** globalShortcut API.

#### Test 21: Hotkey update unregisters old before registering new

- **Name:** Changing the global hotkey unregisters the old shortcut before registering the new one
- **Type:** boundary
- **Harness:** H1 (globalShortcut mock)
- **Preconditions:** Hotkey currently registered as `'CommandOrControl+\`'`.
- **Actions:**
  1. Call `hotkeyManager.update('CommandOrControl+Space', callback)`
  2. Verify `globalShortcut.unregister('CommandOrControl+\`')` was called
  3. Verify `globalShortcut.register('CommandOrControl+Space', callback)` was called
  4. Verify `current()` returns `'CommandOrControl+Space'`
- **Expected outcome:**
  - Steps 2-3: unregister then register in order (source: impl plan Section 3.3 -- "`update()` method unregisters the old shortcut and registers the new one")
- **Interactions:** globalShortcut unregister/register ordering.

#### Test 22: Window state returns defaults when no persisted state exists

- **Name:** Window state loader returns sensible defaults on first launch
- **Type:** boundary
- **Harness:** H3 (filesystem mock)
- **Preconditions:** `desktop.json` exists but has no `windowState` key.
- **Actions:**
  1. Call `windowStatePersistence.load()`
  2. Verify returns `{ width: 1200, height: 800, maximized: false }` with x/y undefined
- **Expected outcome:**
  - Default dimensions (source: impl plan Section 3.2 -- "Defaults: `{ width: 1200, height: 800, maximized: false }` (x/y undefined = center on screen)")
- **Interactions:** desktop-config read.

#### Test 23: Daemon install is idempotent

- **Name:** Installing a daemon service that is already installed overwrites the config without error
- **Type:** boundary
- **Harness:** H2 (OS command mock)
- **Preconditions:** Daemon manager (any platform). First `install()` already completed.
- **Actions:**
  1. Call `install(paths, port)` again
  2. Verify no error thrown
  3. Verify config file was re-written
  4. Verify registration command was called again
- **Expected outcome:**
  - Idempotent (source: impl plan Section 2.2 -- "`install()` is idempotent (re-writes plist if already exists)")
- **Interactions:** fs overwrite, OS command re-execution.

### Unit Tests

#### Test 24: Launchd plist template substitution

- **Name:** Launchd install writes a plist with all template placeholders correctly replaced
- **Type:** unit
- **Harness:** H2 (fs mock)
- **Preconditions:** DaemonPaths provided with known values.
- **Actions:**
  1. Call `launchdDaemonManager.install(paths, 3001)`
  2. Read the written plist content
  3. Verify `{{NODE_BINARY}}`, `{{SERVER_ENTRY}}`, `{{NODE_PATH}}`, `{{PORT}}`, `{{CONFIG_DIR}}`, `{{LOG_DIR}}` are all replaced with actual values
  4. Verify no `{{...}}` placeholders remain
- **Expected outcome:**
  - All placeholders replaced (source: impl plan Section 2.2 -- plist template with named placeholders)
  - `NODE_PATH` includes both native-modules and server-node-modules (source: impl plan Section 2.2 -- "must include both the native-modules and server-node-modules directories")
- **Interactions:** Template string processing, path construction.

#### Test 25: Systemd unit file template substitution

- **Name:** Systemd install writes a unit file with correct template substitution and calls daemon-reload
- **Type:** unit
- **Harness:** H2 (fs/execFile mock)
- **Preconditions:** DaemonPaths provided.
- **Actions:**
  1. Call `systemdDaemonManager.install(paths, 3001)`
  2. Verify unit file written to `~/.config/systemd/user/freshell.service`
  3. Verify `systemctl --user daemon-reload` called
  4. Verify `systemctl --user enable freshell` called
  5. Verify all template placeholders replaced
- **Expected outcome:**
  - Commands called in order (source: impl plan Section 2.3 -- "Writes unit file, runs `systemctl --user daemon-reload && systemctl --user enable freshell`")
- **Interactions:** fs write, child_process.execFile sequencing.

#### Test 26: Windows scheduled task creation

- **Name:** Windows daemon install creates a scheduled task via schtasks with correct arguments
- **Type:** unit
- **Harness:** H2 (execFile mock)
- **Preconditions:** DaemonPaths provided.
- **Actions:**
  1. Call `windowsServiceDaemonManager.install(paths, 3001)`
  2. Verify `schtasks /Create` was called with `/SC ONLOGON /RL HIGHEST`
  3. Verify task name is `"Freshell Server"`
- **Expected outcome:**
  - Correct schtasks arguments (source: impl plan Section 2.4 -- "Creates scheduled task via `schtasks /Create` with `/SC ONLOGON /RL HIGHEST`")
- **Interactions:** child_process.execFile with Windows command.

#### Test 27: Launchd status parsing

- **Name:** Launchd daemon manager correctly parses launchctl list output for different states
- **Type:** unit
- **Harness:** H2 (execFile mock returning different stdout strings)
- **Preconditions:** Launchd daemon manager instantiated.
- **Actions:**
  1. Mock `launchctl list` output for running process (PID present)
  2. Call `status()` -- returns `{ installed: true, running: true, pid: <parsed> }`
  3. Mock `launchctl list` output for stopped process (no PID, exit code shown)
  4. Call `status()` -- returns `{ installed: true, running: false }`
  5. Mock `launchctl list` to return error (service not found)
  6. Call `status()` -- returns `{ installed: false, running: false }`
- **Expected outcome:**
  - Correct parsing of each case (source: impl plan Section 2.2 -- "Parses `launchctl list com.freshell.server` output for PID and status")
- **Interactions:** stdout parsing.

#### Test 28: Systemd status parsing

- **Name:** Systemd daemon manager correctly parses systemctl show output for different states
- **Type:** unit
- **Harness:** H2 (execFile mock)
- **Preconditions:** Systemd daemon manager instantiated.
- **Actions:**
  1. Mock `systemctl --user show` output with `ActiveState=active`, `MainPID=12345`
  2. Call `status()` -- returns `{ installed: true, running: true, pid: 12345 }`
  3. Mock output with `ActiveState=inactive`, `MainPID=0`
  4. Call `status()` -- returns `{ installed: true, running: false }`
- **Expected outcome:**
  - Correct parsing (source: impl plan Section 2.3 -- "Parses `systemctl --user show freshell --property=ActiveState,MainPID,ExecMainStartTimestamp`")
- **Interactions:** stdout parsing.

#### Test 29: Windows service status parsing from CSV output

- **Name:** Windows daemon manager correctly parses schtasks CSV query output
- **Type:** unit
- **Harness:** H2 (execFile mock)
- **Preconditions:** Windows service daemon manager instantiated.
- **Actions:**
  1. Mock `schtasks /Query /TN "Freshell Server" /FO CSV` with "Running" status
  2. Call `status()` -- returns `{ installed: true, running: true }`
  3. Mock with "Ready" status (task exists but not running)
  4. Call `status()` -- returns `{ installed: true, running: false }`
  5. Mock with exit code (task not found)
  6. Call `status()` -- returns `{ installed: false, running: false }`
- **Expected outcome:**
  - Correct CSV parsing (source: impl plan Section 2.4 -- "Status parsing from CSV output")
- **Interactions:** CSV stdout parsing.

#### Test 30: Tray context menu has expected items

- **Name:** System tray creates context menu with all documented items in correct order
- **Type:** unit
- **Harness:** H1 (Tray/Menu mock)
- **Preconditions:** Mock Tray and Menu constructors.
- **Actions:**
  1. Call `createTray(options)` with mock callbacks
  2. Inspect the menu template passed to `Menu.buildFromTemplate`
  3. Verify items: Show/Hide, separator, Server Status (disabled), Mode (disabled), separator, Settings, Check for Updates, Quit
  4. Click "Show/Hide" menu item -- verify `onShow` callback called
  5. Click "Quit" menu item -- verify `onQuit` callback called
- **Expected outcome:**
  - Menu items match spec (source: impl plan Section 3.4 -- "Builds context menu with items: Show/Hide, separator, Server Status (disabled label), Mode (disabled label), separator, Settings, Check for Updates, Quit")
- **Interactions:** Menu/MenuItem construction.

#### Test 31: Native app menu includes expected menus and items

- **Name:** Application menu has Edit, View, Window, and Help menus with standard items
- **Type:** unit
- **Harness:** H1 (Menu mock)
- **Preconditions:** Mock `Menu.buildFromTemplate`.
- **Actions:**
  1. Call `buildAppMenu({ onPreferences, onCheckUpdates, appVersion: '0.6.0' })`
  2. Verify menu template includes Edit (with Undo/Redo/Cut/Copy/Paste/Select All)
  3. Verify View menu includes Reload, Force Reload, Toggle DevTools, zoom controls
  4. Verify Help menu includes Check for Updates
  5. Call Preferences callback from menu -- verify `onPreferences` fired
  6. Call Check for Updates callback -- verify `onCheckUpdates` fired
- **Expected outcome:**
  - Menu structure matches (source: impl plan Section 3.5 -- standard menu items listed)
- **Interactions:** Menu template construction.

#### Test 32: Auto-updater delegates to electron-updater

- **Name:** Update manager forwards check/download/install calls to electron-updater autoUpdater
- **Type:** unit
- **Harness:** vi.mock('electron-updater')
- **Preconditions:** Mock `autoUpdater` from `electron-updater`.
- **Actions:**
  1. Call `updateManager.checkForUpdates()`
  2. Verify `autoUpdater.checkForUpdates()` called
  3. Simulate `autoUpdater` emitting `'update-available'`
  4. Verify `updateManager` re-emits `'update-available'`
  5. Call `updateManager.installAndRestart()`
  6. Verify `autoUpdater.quitAndInstall()` called
- **Expected outcome:**
  - Delegation correct (source: impl plan Section 3.6 -- "Wraps `autoUpdater` from `electron-updater`")
- **Interactions:** electron-updater event forwarding.

#### Test 33: Main process single-instance lock

- **Name:** Second instance of the app focuses the existing window instead of opening a new one
- **Type:** unit
- **Harness:** H1 (app mock)
- **Preconditions:** Mock `app.requestSingleInstanceLock()` to return false (second instance).
- **Actions:**
  1. Execute main module startup
  2. Verify `app.quit()` is called when lock fails
- **Expected outcome:**
  - Second instance quits (source: impl plan Section 3.8 -- "Single-instance lock (`app.requestSingleInstanceLock()`) -> focus existing window if second instance launches")
- **Interactions:** app lifecycle.

#### Test 34: Close-to-tray hides window instead of quitting

- **Name:** When minimizeToTray is enabled, closing the window hides it rather than destroying it
- **Type:** unit
- **Harness:** H1 (BrowserWindow mock)
- **Preconditions:** `minimizeToTray: true` in desktop config. BrowserWindow created.
- **Actions:**
  1. Emit `'close'` event on the BrowserWindow
  2. Verify `event.preventDefault()` was called
  3. Verify `window.hide()` was called
  4. Verify the window was NOT destroyed
- **Expected outcome:**
  - Window hidden, not destroyed (source: impl plan Section 3.8 -- "Close-to-tray behavior: intercept `close` event, call `window.hide()` instead (when `minimizeToTray` is true)")
- **Interactions:** BrowserWindow event handling.

#### Test 35: Prepare-bundled-node validates headers directory

- **Name:** Bundled-node preparation script rejects missing node headers
- **Type:** unit
- **Harness:** vi.mock('fs'), vi.mock('child_process')
- **Preconditions:** Mock filesystem where headers directory exists but `include/node/node_api.h` is missing.
- **Actions:**
  1. Run the headers validation logic from `prepare-bundled-node.ts`
  2. Verify it throws or logs an error about missing headers
- **Expected outcome:**
  - Validation fails (source: impl plan Section 5.3 -- "Verifies the headers directory structure is validated (rejects missing `include/node/node_api.h`)")
- **Interactions:** fs.existsSync checks.

#### Test 36: Prepare-bundled-node calls node-gyp with correct flags

- **Name:** Node-pty recompilation uses correct target version and nodedir flags
- **Type:** unit
- **Harness:** vi.mock('child_process')
- **Preconditions:** Mock `execSync`. Mock `bundled-node-version.json` to return `{ "version": "22.12.0" }`.
- **Actions:**
  1. Run the recompilation logic from `prepare-bundled-node.ts`
  2. Capture the command passed to `execSync`
  3. Verify it includes `--target=22.12.0` and `--nodedir=` pointing to headers directory
- **Expected outcome:**
  - Correct flags (source: impl plan Section 5.3 -- "`npx node-gyp rebuild --target=${version} --nodedir=${headersDir}`")
- **Interactions:** child_process.execSync command construction.

---

## Coverage Summary

### Covered Action Space

| Area | Tests | Coverage |
|------|-------|----------|
| Desktop config CRUD | 1, 8, 11, 16, 17 | Full lifecycle: read, write, patch, validate, concurrent, corrupt |
| Server-info endpoint | 7, 12 | Response shape, auth, uptime invariant |
| Daemon management (launchd) | 2, 3, 4, 9, 23, 24, 27 | Full lifecycle + idempotent install + status parsing |
| Daemon management (systemd) | 9, 25, 28 | Full lifecycle + template + status parsing |
| Daemon management (windows) | 9, 26, 29 | Full lifecycle + schtasks + CSV parsing |
| Platform factory | 18, 19 | All 3 platforms + unsupported |
| Server spawner | 1, 6, 10, 14, 15 | Production/dev spawn, health timeout, double-start, NODE_PATH |
| Startup orchestrator | 1, 2, 3, 4, 5, 6 | All 3 modes + wizard redirect + dev mode |
| Global hotkey | 1, 20, 21 | Register, conflict, update |
| System tray | 1, 30 | Creation, menu items, callbacks |
| Native menus | 31 | Menu structure, callbacks |
| Auto-updater | 32 | Delegation, event forwarding |
| Window state | 22 | Defaults, persistence |
| Main process lifecycle | 33, 34 | Single instance, close-to-tray |
| Preload bridge | 13 | API shape invariant |
| Bundled-node preparation | 35, 36 | Headers validation, node-gyp flags |

### Explicitly Excluded (per agreed strategy)

| Excluded Area | Reason | Risk |
|------|--------|------|
| **E2E Playwright tests** | Deferred for v1 -- requires building the full Electron app, which depends on having electron/electron-builder installed and full packaging pipeline working. The agreed strategy explicitly deferred this. | **Medium.** Multi-process integration bugs (Electron main process + spawned server + BrowserWindow renderer) cannot be caught by unit/integration tests alone. The scenario tests with mocked dependencies mitigate this partially. |
| **Setup wizard React component rendering** | The wizard test (`wizard.test.tsx`) is described in the impl plan but is covered by the implementation subagent, not enumerated here as a separate test plan entry. The wizard's behavior is exercised through the scenario tests (Test 1) at the orchestrator level. | **Low.** UI rendering bugs in the wizard are cosmetic and will be caught during manual testing. |
| **Real OS daemon operations** | All daemon tests use mocked `child_process`/`fs`. No real `launchctl`/`systemctl`/`schtasks` commands are executed. | **Medium.** Platform-specific daemon edge cases (permissions, systemd user session availability, Windows UAC) require real-OS testing. CI matrix build partially mitigates this for compilation, but runtime behavior is not covered. |
| **electron-builder packaging** | Build configuration (`electron-builder.yml`) is validated only by CI builds, not by test assertions. | **Low.** Packaging issues are caught by the CI build matrix. |
| **Auto-update full flow** | Only the delegation layer is tested. Actual update download/install requires a published GitHub Release. | **Low for v1.** Code signing is deferred, so auto-update may not work reliably on macOS anyway. |
| **Icon/asset correctness** | Placeholder icons are out of scope. | **None.** Icons are cosmetic. |
| **GitHub Actions workflows** | YAML syntax validated by GitHub on push, not by vitest. | **Low.** CI workflow bugs are self-correcting (the build fails visibly). |

### Key Risks from Exclusions

1. **No E2E coverage of the full startup-to-terminal path.** The scenario tests mock every dependency boundary, which means a wiring bug (e.g., passing the wrong port to the server spawner, or loading the wrong URL in BrowserWindow) could escape detection. This is the highest-risk exclusion.

2. **No real-OS daemon testing.** Daemon management code interacts with OS service managers via child_process. Mocked tests verify command construction but not command behavior. A `launchctl load` that succeeds in the mock might fail in production due to plist formatting, permissions, or macOS version differences.

3. **NODE_PATH resolution at runtime.** The server-spawner test (Test 10) verifies that `NODE_PATH` is set correctly in the spawn environment, but does not verify that the spawned Node.js process actually resolves modules from those paths. This would require an integration test that spawns a real Node.js process with the constructed `NODE_PATH` -- feasible but deferred per strategy.

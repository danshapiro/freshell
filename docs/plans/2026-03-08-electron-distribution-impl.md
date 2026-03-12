# Freshell Electron Distribution - Implementation Plan

**Date:** 2026-03-08
**Design doc:** `docs/plans/2026-03-08-electron-distribution-design.md`
**Branch:** `electron-distribution`

---

## Overview

This plan implements an Electron desktop shell around the existing Freshell web app. The Electron layer is a **thin native wrapper** -- the server code, web UI, and WebSocket protocol are completely unchanged. The new code lives in `electron/` (main process) and `installers/` (OS service definitions). The server gains one new endpoint (`/api/server-info`). Desktop-specific configuration lives in a separate file (`~/.freshell/desktop.json`) to avoid cross-process config contention with the server's `config.json`.

All work follows Red-Green-Refactor TDD. Every module has unit tests with mocked Electron/OS APIs. Integration and E2E tests cover the `/api/server-info` endpoint and the setup wizard flow.

---

## Phase 1: Foundation -- Config, Types, and Server Endpoint

### 1.1 Desktop config schema and types

**File:** `electron/types.ts`

Define the `DesktopConfig` interface and Zod schema:

```typescript
import { z } from 'zod'

export const DesktopConfigSchema = z.object({
  serverMode: z.enum(['daemon', 'app-bound', 'remote']),
  remoteUrl: z.string().url().optional(),
  remoteToken: z.string().optional(),
  globalHotkey: z.string().default('CommandOrControl+`'),
  startOnLogin: z.boolean().default(false),
  minimizeToTray: z.boolean().default(true),
  setupCompleted: z.boolean().default(false),
  windowState: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    maximized: z.boolean(),
  }).optional(),
})

export type DesktopConfig = z.infer<typeof DesktopConfigSchema>
```

**File:** `electron/desktop-config.ts`

A standalone module (no Electron imports) that reads/writes `~/.freshell/desktop.json` -- a **separate file** from the server's `~/.freshell/config.json`. This module is used by both the Electron main process and by tests.

Methods:
- `readDesktopConfig(): Promise<DesktopConfig | null>` -- returns null if file doesn't exist
- `writeDesktopConfig(config: DesktopConfig): Promise<void>` -- atomic write (temp file + rename)
- `patchDesktopConfig(patch: Partial<DesktopConfig>): Promise<DesktopConfig>` -- read-modify-write with mutex
- `getDefaultDesktopConfig(): DesktopConfig` -- returns defaults (serverMode: 'app-bound', etc.)

**Key design decision -- separate config file:** The desktop config lives in `~/.freshell/desktop.json`, completely separate from the server's `~/.freshell/config.json`. This eliminates a data loss race condition that would occur with a shared file:

The server's `ConfigStore` caches `config.json` in memory on first read and never re-reads from disk. All subsequent server writes serialize the cached version. If both Electron and the server shared one file via read-modify-write, the server's stale cache would overwrite Electron's changes whenever the server next wrote. For example: Electron changes the hotkey -> server changes terminal font size -> server's cached version (with the old hotkey) overwrites the file, silently losing the hotkey change.

By using a separate file, each process owns its file exclusively. No cross-process locking or cache invalidation is needed. The server never reads or writes `desktop.json`; the Electron layer never reads or writes `config.json`.

**Tests:** `test/unit/electron/desktop-config.test.ts`
- Reads config from `desktop.json` when file exists
- Returns null when file doesn't exist
- Writes config atomically (temp file + rename)
- Patch merges correctly (read-modify-write)
- Validates against schema (rejects invalid serverMode, etc.)
- Does NOT touch `config.json` (verify it's unchanged after writes)
- Concurrent patches are serialized by mutex (no lost updates)

### 1.3 New `/api/server-info` endpoint

**File:** `server/server-info-router.ts` (new)

```typescript
import { Router } from 'express'

export interface ServerInfoRouterDeps {
  appVersion: string
  startedAt: number  // Date.now() captured at server start
}

export function createServerInfoRouter(deps: ServerInfoRouterDeps): Router {
  const router = Router()

  router.get('/', (_req, res) => {
    res.json({
      version: deps.appVersion,
      uptime: Math.floor((Date.now() - deps.startedAt) / 1000),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    })
  })

  return router
}
```

**File:** `server/index.ts` (edit)

Mount the router: `app.use('/api/server-info', createServerInfoRouter({ appVersion: APP_VERSION, startedAt: Date.now() }))`

**Tests:** `test/integration/server/server-info-api.test.ts`
- Returns 200 with version, uptime, nodeVersion, platform, arch
- Uptime increases between two calls
- Requires auth (like all /api routes)

### 1.4 Electron TypeScript configuration

**File:** `tsconfig.electron.json` (new)

This config handles only the Electron main process code (non-renderer). The setup wizard renderer is built by Vite (see Phase 4), not by `tsc`.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist/electron",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": [
    "electron/**/*"
  ],
  "exclude": [
    "electron/setup-wizard/**/*.tsx",
    "electron/setup-wizard/index.html"
  ]
}
```

Note: `.tsx` files in `electron/setup-wizard/` are excluded because they are React renderer code that `tsc` with `NodeNext` module resolution cannot handle (no JSX transform, no bundling). These files are built by the dedicated Vite wizard build (see Section 4.4).

### 1.5 Vitest configuration for Electron tests

**File:** `vitest.electron.config.ts` (new)

```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: [
      'test/unit/electron/**/*.test.ts',
      'test/unit/electron/**/*.test.tsx',
    ],
    exclude: ['docs/plans/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    alias: {
      '@electron': path.resolve(__dirname, './electron'),
    },
  },
})
```

Note: The `react()` plugin and `.test.tsx` pattern are included because the setup wizard tests (`wizard.test.tsx`) use JSX and need React transform support.

**File:** `vitest.config.ts` (edit -- critical)

Add `'test/unit/electron/**'` to the `exclude` array. Without this, the main vitest config (which uses `environment: 'jsdom'`) would also pick up the electron tests, causing either duplicate runs or failures from the wrong test environment:

```typescript
exclude: [
  '**/node_modules/**',
  '**/.worktrees/**',
  '**/.claude/worktrees/**',
  'docs/plans/**',
  // Server tests run under vitest.server.config.ts (node environment)
  'test/server/**',
  'test/unit/server/**',
  'test/integration/server/**',
  'test/integration/session-repair.test.ts',
  'test/integration/session-search-e2e.test.ts',
  // Electron tests run under vitest.electron.config.ts (node environment)
  'test/unit/electron/**',
],
```

**File:** `package.json` (edit)

Add script: `"test:electron": "vitest run --config vitest.electron.config.ts"`

Update `"test"` to also run electron tests: `"test": "vitest run && vitest run --config vitest.server.config.ts && vitest run --config vitest.electron.config.ts"`

---

## Phase 2: Daemon Management

### 2.1 DaemonManager interface

**File:** `electron/daemon/daemon-manager.ts`

Abstract interface for platform-agnostic daemon control:

```typescript
export interface DaemonStatus {
  installed: boolean
  running: boolean
  pid?: number
  uptime?: number  // seconds
  error?: string
}

export interface DaemonPaths {
  nodeBinary: string      // bundled Node.js binary: {resourcesPath}/bundled-node/bin/node
  serverEntry: string     // server entry point: {resourcesPath}/server/index.js
  serverNodeModules: string // server deps: {resourcesPath}/server-node-modules
  nativeModules: string   // recompiled native modules: {resourcesPath}/bundled-node/native-modules
  configDir: string       // ~/.freshell
  logDir: string          // ~/.freshell/logs
}

// All paths above are real filesystem paths from extraResources.
// They are NOT inside the ASAR archive. The bundled Node.js binary
// is a vanilla Node.js process and cannot read from ASAR.

export interface DaemonManager {
  readonly platform: 'darwin' | 'linux' | 'win32'

  /** Register the OS service/agent (idempotent) */
  install(paths: DaemonPaths, port: number): Promise<void>

  /** Remove the OS service/agent (idempotent) */
  uninstall(): Promise<void>

  /** Start the service */
  start(): Promise<void>

  /** Stop the service */
  stop(): Promise<void>

  /** Query current status */
  status(): Promise<DaemonStatus>

  /** Check if service definition exists */
  isInstalled(): Promise<boolean>
}
```

### 2.2 macOS (launchd) implementation

**File:** `electron/daemon/launchd.ts`

Manages `~/Library/LaunchAgents/com.freshell.server.plist`.

- `install()`: Writes a plist file from a template, then runs `launchctl load -w <path>`
- `uninstall()`: Runs `launchctl unload <path>`, then removes the plist file
- `start()`: `launchctl start com.freshell.server`
- `stop()`: `launchctl stop com.freshell.server`
- `status()`: Parses `launchctl list com.freshell.server` output for PID and status
- `isInstalled()`: Checks if plist file exists

**File:** `installers/launchd/com.freshell.server.plist.template`

Template plist with `{{NODE_BINARY}}`, `{{SERVER_ENTRY}}`, `{{NODE_PATH}}`, `{{PORT}}`, `{{CONFIG_DIR}}`, `{{LOG_DIR}}` placeholders. The `{{NODE_PATH}}` placeholder is critical -- it must include both the native-modules and server-node-modules directories from `extraResources` so the spawned Node.js process can find all server dependencies on the real filesystem (not inside the ASAR archive).

**Tests:** `test/unit/electron/daemon/launchd.test.ts`
- Mock `child_process.execFile` and `fs` operations
- `install()` writes correct plist content, calls `launchctl load`
- `uninstall()` calls `launchctl unload`, removes file
- `start()`/`stop()` call correct launchctl commands
- `status()` parses launchctl list output (running, not running, error cases)
- `isInstalled()` returns true/false based on file existence
- `install()` is idempotent (re-writes plist if already exists)

### 2.3 Linux (systemd) implementation

**File:** `electron/daemon/systemd.ts`

Manages `~/.config/systemd/user/freshell.service`.

- `install()`: Writes unit file, runs `systemctl --user daemon-reload && systemctl --user enable freshell`
- `uninstall()`: `systemctl --user disable freshell && systemctl --user stop freshell`, removes unit file, `daemon-reload`
- `start()`: `systemctl --user start freshell`
- `stop()`: `systemctl --user stop freshell`
- `status()`: Parses `systemctl --user show freshell --property=ActiveState,MainPID,ExecMainStartTimestamp`
- `isInstalled()`: Checks if unit file exists

**File:** `installers/systemd/freshell.service.template`

Template systemd unit with `{{NODE_BINARY}}`, `{{SERVER_ENTRY}}`, `{{NODE_PATH}}`, `{{PORT}}`, `{{CONFIG_DIR}}`, `{{LOG_DIR}}` placeholders. Uses `Environment=NODE_PATH={{NODE_PATH}}` directive to set the module resolution path.

**Tests:** `test/unit/electron/daemon/systemd.test.ts`
- Same pattern as launchd tests with systemd-specific command mocking
- Parses `systemctl show` output for different states
- `install()` calls `daemon-reload` and `enable`
- `uninstall()` calls `disable`, `stop`, then `daemon-reload`

### 2.4 Windows Service implementation

**File:** `electron/daemon/windows-service.ts`

Uses a lightweight approach: creates a Windows Scheduled Task with `schtasks` (runs at logon, restarts on failure) rather than a full Windows Service (which would require `node-windows` or a native service wrapper). This provides daemon-like behavior without native dependencies.

- `install()`: Creates scheduled task via `schtasks /Create` with `/SC ONLOGON /RL HIGHEST`
- `uninstall()`: `schtasks /Delete /TN "Freshell Server" /F`
- `start()`: `schtasks /Run /TN "Freshell Server"`
- `stop()`: Finds the process via `tasklist` by the bundled Node.js path and kills it
- `status()`: `schtasks /Query /TN "Freshell Server" /FO CSV` + check process running
- `isInstalled()`: `schtasks /Query /TN "Freshell Server"`

**File:** `installers/windows/freshell-task.xml.template`

All three platform templates include the `NODE_PATH` environment variable pointing to `{resourcesPath}/bundled-node/native-modules` and `{resourcesPath}/server-node-modules`.

Template XML for the scheduled task.

**Tests:** `test/unit/electron/daemon/windows-service.test.ts`
- Mock `child_process.execFile` for schtasks/tasklist commands
- Tests for all lifecycle operations
- Status parsing from CSV output

### 2.5 Platform factory

**File:** `electron/daemon/create-daemon-manager.ts`

The project uses `"type": "module"` (ESM). `require()` is not available in ES modules. The factory uses dynamic `import()` instead:

```typescript
import type { DaemonManager } from './daemon-manager.js'

export async function createDaemonManager(): Promise<DaemonManager> {
  switch (process.platform) {
    case 'darwin': {
      const { LaunchdDaemonManager } = await import('./launchd.js')
      return new LaunchdDaemonManager()
    }
    case 'linux': {
      const { SystemdDaemonManager } = await import('./systemd.js')
      return new SystemdDaemonManager()
    }
    case 'win32': {
      const { WindowsServiceDaemonManager } = await import('./windows-service.js')
      return new WindowsServiceDaemonManager()
    }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}
```

Note: The function is now `async` because dynamic `import()` returns a promise. All callers (startup.ts, main.ts) are already async, so this is a natural fit.

**Tests:** `test/unit/electron/daemon/create-daemon-manager.test.ts`
- Returns correct implementation for each platform (mock process.platform)
- Throws for unsupported platform
- Awaits the async factory correctly

---

## Phase 3: Electron Main Process

### 3.1 Server spawner (app-bound mode)

**File:** `electron/server-spawner.ts`

Manages spawning the Freshell server as a child process for app-bound mode. Supports two spawn modes:

```typescript
export type ServerSpawnMode =
  | { mode: 'production'; nodeBinary: string; serverEntry: string }
  | { mode: 'dev'; tsxPath: string; serverSourceEntry: string }

export interface ServerSpawnerOptions {
  spawn: ServerSpawnMode
  port: number
  envFile: string      // path to .env
  configDir: string    // ~/.freshell
}

export interface ServerSpawner {
  /** Spawn the server process. Resolves when /api/health responds. */
  start(options: ServerSpawnerOptions): Promise<void>

  /** Kill the server process gracefully (SIGTERM, then SIGKILL after timeout). */
  stop(): Promise<void>

  /** Whether the server is currently running. */
  isRunning(): boolean

  /** The child process PID, if running. */
  pid(): number | undefined
}
```

Implementation:
- In **production mode**: `start()` spawns `child_process.spawn(nodeBinary, [serverEntry])` with `NODE_ENV=production`
- In **dev mode**: `start()` spawns `child_process.spawn(tsxPath, [serverSourceEntry])` -- this runs the TypeScript server source directly via `tsx`, the same way `npm run dev:server` does. No build step required.
- Both modes: Polls `http://localhost:{port}/api/health` with exponential backoff (100ms, 200ms, 400ms, ..., max 30s)
- Pipes stdout/stderr to `~/.freshell/logs/server.log`
- `stop()` sends SIGTERM, waits 5s, then SIGKILL if still alive

**Tests:** `test/unit/electron/server-spawner.test.ts`
- Mock `child_process.spawn` and `http.get`
- Production mode: spawns `nodeBinary serverEntry` with NODE_ENV=production
- Dev mode: spawns `tsx server/index.ts` without NODE_ENV=production
- `start()` polls health endpoint and resolves on success
- `start()` rejects if health check times out
- `stop()` sends SIGTERM, then SIGKILL after timeout
- `isRunning()` reflects process state
- Double-start is idempotent (kills old process first)

### 3.2 Window state persistence

**File:** `electron/window-state.ts`

Tracks and restores BrowserWindow position/size:

```typescript
export interface WindowStatePersistence {
  /** Load persisted state, returning defaults if not found */
  load(): Promise<{ x?: number; y?: number; width: number; height: number; maximized: boolean }>

  /** Save current window state */
  save(state: { x: number; y: number; width: number; height: number; maximized: boolean }): Promise<void>
}
```

Implementation reads/writes via `desktop-config.ts` -> `patchDesktopConfig({ windowState: ... })`.

Defaults: `{ width: 1200, height: 800, maximized: false }` (x/y undefined = center on screen).

**Tests:** `test/unit/electron/window-state.test.ts`
- Returns defaults when no persisted state
- Loads and returns persisted state
- Saves state via patchDesktopConfig
- Handles corrupt/missing values gracefully

### 3.3 Global hotkey manager

**File:** `electron/hotkey.ts`

```typescript
export interface HotkeyManager {
  /** Register the global hotkey. Returns true if successful. */
  register(accelerator: string, callback: () => void): boolean

  /** Unregister the current hotkey. */
  unregister(): void

  /** Change the hotkey accelerator. */
  update(accelerator: string, callback: () => void): boolean

  /** Get the currently registered accelerator. */
  current(): string | null
}
```

Implementation wraps `electron.globalShortcut.register/unregister`. The `update()` method unregisters the old shortcut and registers the new one.

The callback implements quake-style toggle:
- If window is hidden or not focused -> show + focus
- If window is visible and focused -> hide

**Tests:** `test/unit/electron/hotkey.test.ts`
- Mock `electron.globalShortcut`
- `register()` calls globalShortcut.register with correct accelerator
- `register()` returns false if accelerator is already in use
- `unregister()` calls globalShortcut.unregister
- `update()` unregisters old, registers new
- `current()` returns the active accelerator or null

### 3.4 System tray

**File:** `electron/tray.ts`

```typescript
export interface TrayOptions {
  onShow: () => void
  onHide: () => void
  onSettings: () => void
  onCheckUpdates: () => void
  onQuit: () => void
  getServerStatus: () => Promise<{ running: boolean; mode: string; error?: string }>
}

export function createTray(options: TrayOptions): Electron.Tray
```

Implementation:
- Creates `Tray` with platform-appropriate icon (16x16 for macOS menu bar, 32x32 for Windows/Linux)
- Builds context menu with items: Show/Hide, separator, Server Status (disabled label), Mode (disabled label), separator, Settings, Check for Updates, Quit
- Refreshes menu on each open (to update server status)
- On macOS, sets `tray.setToolTip('Freshell')`

**Tests:** `test/unit/electron/tray.test.ts`
- Mock `electron.Tray`, `electron.Menu`, `electron.nativeImage`
- Creates tray with icon
- Context menu has expected items
- Click handlers call correct callbacks
- Server status is fetched and displayed

### 3.5 Native menus

**File:** `electron/menu.ts`

Builds the native application menu (macOS menu bar / Windows & Linux window menu):

```typescript
export function buildAppMenu(options: {
  onPreferences: () => void
  onCheckUpdates: () => void
  appVersion: string
}): Electron.Menu
```

Standard menus:
- **App menu** (macOS only): About, Preferences, Quit
- **Edit**: Undo, Redo, Cut, Copy, Paste, Select All
- **View**: Reload, Force Reload, Toggle DevTools, Actual Size, Zoom In, Zoom Out, Toggle Full Screen
- **Window**: Minimize, Zoom/Maximize, Close
- **Help**: Check for Updates, About Freshell

**Tests:** `test/unit/electron/menu.test.ts`
- Mock `electron.Menu`, `electron.MenuItem`
- Menu includes expected items
- Preferences callback fires
- Check Updates callback fires

### 3.6 Auto-updater

**File:** `electron/updater.ts`

Wraps `electron-updater` for GitHub Releases:

```typescript
export interface UpdateManager {
  /** Check for updates (non-blocking). Emits events. */
  checkForUpdates(): Promise<void>

  /** Download the pending update. */
  downloadUpdate(): Promise<void>

  /** Install update and restart app. */
  installAndRestart(): void

  /** Event emitter for update-available, update-downloaded, error */
  on(event: string, callback: (...args: any[]) => void): void
}
```

Implementation:
- Wraps `autoUpdater` from `electron-updater`
- Points at GitHub Releases (configured via `electron-builder.yml` `publish` config)
- Checks on app launch (after a 10-second delay to avoid slowing startup)
- Notifies user via dialog when update is available
- Does NOT auto-install -- always asks user first

**Tests:** `test/unit/electron/updater.test.ts`
- Mock `electron-updater` autoUpdater
- `checkForUpdates()` calls autoUpdater.checkForUpdates
- Emits 'update-available' when update found
- Emits 'update-downloaded' when download completes
- `installAndRestart()` calls autoUpdater.quitAndInstall
- Error handling: emits 'error' on network failure

### 3.7 Startup flow orchestrator

**File:** `electron/startup.ts`

Coordinates the full startup sequence:

```typescript
export interface StartupContext {
  desktopConfig: DesktopConfig
  daemonManager: DaemonManager
  serverSpawner: ServerSpawner
  hotkeyManager: HotkeyManager
  windowStatePersistence: WindowStatePersistence
  updateManager: UpdateManager
  isDev: boolean  // true when running via electron:dev
}

export async function runStartup(ctx: StartupContext): Promise<{
  serverUrl: string
  window: Electron.BrowserWindow
}>
```

Sequence:
1. Read desktop config from `~/.freshell/desktop.json`
2. If `!setupCompleted`, return early with signal to show wizard (not the main window)
3. Based on `serverMode`:
   - `daemon`: Check `daemonManager.status()`. If not running, `daemonManager.start()`. If not installed, throw with message to re-run setup.
   - `app-bound`: Call `serverSpawner.start(...)`. In **dev mode** (`ctx.isDev`), pass `{ mode: 'dev', tsxPath: 'npx tsx', serverSourceEntry: 'server/index.ts' }`. In production, pass `{ mode: 'production', nodeBinary, serverEntry }`. Both paths wait for health check.
   - `remote`: Validate connectivity via fetch to `remoteUrl + '/api/health'`
4. Determine `serverUrl` based on mode. In dev mode with app-bound, also point the BrowserWindow at the Vite dev server (`http://localhost:5173`) instead of the Express server directly (matching how `npm run dev` works).
5. Load window state, create BrowserWindow, load serverUrl
6. Register global hotkey
7. Create system tray
8. Schedule update check (10s delay)
9. Return { serverUrl, window }

**Tests:** `test/unit/electron/startup.test.ts`
- Test each server mode path with mocked dependencies
- Setup incomplete -> returns wizard signal
- Daemon mode: starts daemon if not running
- Daemon mode: throws if not installed
- App-bound mode (production): spawns server with bundled node + built entry
- App-bound mode (dev): spawns server with tsx + source entry
- Remote mode: validates connectivity
- Registers hotkey with configured accelerator
- Creates tray
- Window state is loaded and applied

### 3.8 Main entry point

**File:** `electron/main.ts`

The Electron main process entry point:

```typescript
import { app, BrowserWindow } from 'electron'
import { runStartup } from './startup.js'
// ... other imports
```

Responsibilities:
- `app.whenReady()` -> run startup flow
- Handle `window-all-closed` (quit on Windows/Linux, stay alive on macOS)
- Handle `before-quit` -> stop app-bound server if running
- Handle `activate` (macOS) -> show window
- Single-instance lock (`app.requestSingleInstanceLock()`) -> focus existing window if second instance launches
- Close-to-tray behavior: intercept `close` event, call `window.hide()` instead (when `minimizeToTray` is true)

**Tests:** `test/unit/electron/main.test.ts`
- Mock `electron.app`, `electron.BrowserWindow`
- Calls runStartup on ready
- Single instance lock prevents duplicate launches
- Close-to-tray hides window instead of quitting
- before-quit stops server spawner

### 3.9 Preload script

**File:** `electron/preload.ts`

Minimal context bridge exposing safe APIs to the renderer:

```typescript
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('freshellDesktop', {
  platform: process.platform,
  isElectron: true,
  getServerMode: () => ipcRenderer.invoke('get-server-mode'),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  setGlobalHotkey: (accelerator: string) => ipcRenderer.invoke('set-global-hotkey', accelerator),
  onUpdateAvailable: (callback: () => void) => ipcRenderer.on('update-available', callback),
  onUpdateDownloaded: (callback: () => void) => ipcRenderer.on('update-downloaded', callback),
  installUpdate: () => ipcRenderer.invoke('install-update'),
})
```

**Tests:** `test/unit/electron/preload.test.ts`
- Mock `electron.contextBridge`, `electron.ipcRenderer`
- Exposes expected API shape
- IPC channels match main process handlers

---

## Phase 4: Setup Wizard

### 4.1 Wizard window

**File:** `electron/setup-wizard/wizard-window.ts`

Creates a separate BrowserWindow for the setup wizard:

```typescript
export function createWizardWindow(): Electron.BrowserWindow
```

- Fixed size (640x500), not resizable, centered
- In production: loads `dist/wizard/index.html` (the Vite-built wizard bundle)
- In development: loads `http://localhost:5174` (the wizard Vite dev server)
- No menu bar
- Communicates results back via IPC
- Uses the same preload script as the main window (for IPC access)

### 4.2 Wizard HTML entry

**File:** `electron/setup-wizard/index.html`

Minimal HTML shell that serves as the Vite entry point for the wizard:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Freshell Setup</title>
</head>
<body>
  <div id="wizard-root"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
```

### 4.3 Wizard React app

**File:** `electron/setup-wizard/main.tsx`

Entry point that mounts the wizard:

```typescript
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Wizard } from './wizard.js'
import './wizard.css'

createRoot(document.getElementById('wizard-root')!).render(<Wizard />)
```

**File:** `src/theme-variables.css` (new -- extracted from `src/index.css`)

The CSS custom properties (`:root` light mode and `.dark` dark mode variable definitions) that back the Tailwind semantic colors (`--background`, `--foreground`, `--border`, `--primary`, etc.) are extracted into a standalone file. Both the main app's `src/index.css` and the wizard's `wizard.css` import it.

```css
/* src/theme-variables.css */
:root {
  --background: 0 0% 100%;
  --foreground: 240 10% 10%;
  --card: 0 0% 98%;
  /* ... all existing :root variables ... */
}
.dark {
  --background: 240 10% 4%;
  --foreground: 0 0% 98%;
  /* ... all existing .dark variables ... */
}
```

**File:** `src/index.css` (edit)

Replace the inline `:root { ... }` and `.dark { ... }` blocks with:
```css
@import './theme-variables.css';
```

The rest of `src/index.css` (element styles, utility classes) stays unchanged.

**File:** `electron/setup-wizard/wizard.css`

```css
@import '../../src/theme-variables.css';
@tailwind base;
@tailwind components;
@tailwind utilities;
```

By importing `theme-variables.css`, the wizard has access to the same CSS custom properties that the Tailwind semantic colors reference (e.g., `bg-background` resolves to `hsl(var(--background))` which is now defined). Without this import, all semantic color utilities would render as `hsl()` with undefined variables, producing invisible or transparent elements.

**File:** `electron/setup-wizard/wizard.tsx`

React multi-step form component. Uses the same stack as the main Freshell UI (React, Tailwind) but self-contained -- no Redux, no server connection.

**Step 1: Welcome**
- Freshell branding/logo
- Brief description: "Freshell is a terminal multiplexer you can access from anywhere"
- "Get Started" button

**Step 2: Server Mode**
- Three radio cards with icons and descriptions:
  - **Always-running daemon**: "Server runs as an OS service. Terminals survive app restarts and reboots. Best for power users."
  - **App-bound**: "Server starts when the app opens and stops when you quit. Simple and self-contained. Recommended for most users."
  - **Remote only**: "Connect to a Freshell server running on another machine. No local server needed."

**Step 3: Configuration** (varies by mode)
- Daemon/App-bound: Port number input (default 3001), with validation
- Remote: URL input + auth token input, with "Test Connection" button that hits `/api/health`

**Step 4: Global Hotkey**
- Current shortcut display (default `Ctrl+\``)
- "Record new shortcut" button that captures the next key combo
- Conflict detection: try registering via IPC, if fails show warning

**Step 5: Complete**
- Summary of choices
- "Launch Freshell" button
- Writes config via IPC (`window.freshellDesktop.completeSetup(config)`), sets `setupCompleted: true`

### 4.4 Wizard Vite build configuration

**File:** `vite.wizard.config.ts` (new, at repo root)

The wizard is a separate Vite application. It must be bundled by Vite (not `tsc`) because:
1. React JSX requires a transform (`tsc` with `NodeNext` module resolution does not bundle)
2. Tailwind CSS requires PostCSS processing
3. `tsc` produces individual `.js` files with bare imports that a BrowserWindow cannot resolve

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'electron/setup-wizard'),
  base: './',  // relative paths for file:// protocol in production
  build: {
    outDir: path.resolve(__dirname, 'dist/wizard'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5174,  // separate from main app's 5173
  },
  resolve: {
    alias: {
      '@electron': path.resolve(__dirname, './electron'),
    },
  },
  css: {
    postcss: {
      plugins: [
        (await import('tailwindcss')).default({
          config: path.resolve(__dirname, 'tailwind.config.wizard.js'),
        }),
        (await import('autoprefixer')).default,
      ],
    },
  },
})
```

**Critical: Wizard-specific Tailwind config.** The project's existing `tailwind.config.js` has `content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}']`, which does not include the wizard's files in `electron/setup-wizard/`. If the wizard reused that config, Tailwind's JIT compiler would scan zero wizard files and produce zero utility classes, resulting in a completely unstyled wizard.

**File:** `tailwind.config.wizard.js` (new, at repo root)

```javascript
import baseConfig from './tailwind.config.js'

/** @type {import('tailwindcss').Config} */
export default {
  ...baseConfig,
  content: ['./electron/setup-wizard/**/*.{ts,tsx,html}'],
}
```

This inherits the project's theme (colors, fonts, spacing, plugins) so the wizard looks consistent with the main app, but scans only the wizard files for class usage. The `postcss.config.js` at the project root is NOT used by the wizard build -- instead, the PostCSS plugins are configured inline in the wizard Vite config to point at the wizard-specific Tailwind config.

**File:** `package.json` (edit -- additional scripts)

```json
{
  "build:wizard": "vite build --config vite.wizard.config.ts",
  "dev:wizard": "vite --config vite.wizard.config.ts"
}
```

The `electron:build` script is updated to include the wizard build:
```json
{
  "electron:build": "npm run build && npm run build:electron && npm run build:wizard && electron-builder"
}
```

The `electron:dev` script starts the wizard dev server alongside:
```json
{
  "electron:dev": "npm run build:electron && concurrently -n wizard,electron \"vite --config vite.wizard.config.ts\" \"electron .\""
}
```

### 4.5 Wizard tests

**Tests:** `test/unit/electron/setup-wizard/wizard.test.tsx`

These tests run under `vitest.electron.config.ts` which includes the `react()` plugin for JSX transform. The test environment is `jsdom` (overridden per-file with `// @vitest-environment jsdom` directive) since the wizard component renders DOM elements.

- Renders each step
- Step navigation (next/back)
- Server mode selection updates state
- Port validation (number, range 1024-65535)
- Remote URL validation
- Hotkey recording (mocked IPC)
- Completion calls IPC with correct config shape
- Keyboard navigation works (Enter for next, Escape for back)

---

## Phase 5: Build & Packaging

### 5.1 electron-builder configuration

**File:** `electron-builder.yml` (new, at repo root)

```yaml
appId: com.freshell.desktop
productName: Freshell
copyright: Copyright (c) 2026 Freshell

directories:
  output: release
  buildResources: assets/electron

# --- ASAR vs extraResources split ---
#
# The ASAR archive (files) contains ONLY code that runs inside Electron's
# patched Node.js, which can transparently read from ASAR:
#   - dist/electron/** (main process code)
#   - dist/wizard/**  (wizard renderer bundle)
#
# Everything the standalone bundled Node.js binary needs is placed in
# extraResources, which lives on the REAL filesystem. A vanilla Node.js
# process cannot read from ASAR archives -- it would get ENOENT/MODULE_NOT_FOUND.
# This includes:
#   - dist/server/** (the Freshell server code)
#   - dist/client/** (static web assets served by Express)
#   - server-node-modules/** (pruned runtime dependencies for the server)
#   - bundled-node/bin/** (the standalone Node.js binary)
#   - bundled-node/native-modules/** (recompiled node-pty)

files:
  - dist/electron/**
  - dist/wizard/**
  - package.json

extraResources:
  # The standalone Node.js binary
  - from: bundled-node/${os}/${arch}
    to: bundled-node/bin
    filter:
      - "**/*"
  # Recompiled native modules (node-pty against bundled Node ABI)
  - from: bundled-node/native-modules
    to: bundled-node/native-modules
    filter:
      - "**/*"
  # The Freshell server (runs under bundled Node, NOT Electron)
  - from: dist/server
    to: server
    filter:
      - "**/*"
  # Static client assets (served by Express in production)
  - from: dist/client
    to: client
    filter:
      - "**/*"
  # Pruned server runtime dependencies (see Section 5.3, Step 4)
  - from: server-node-modules
    to: server-node-modules
    filter:
      - "**/*"

mac:
  category: public.app-category.developer-tools
  target:
    - dmg
  icon: assets/electron/icon.icns

win:
  target:
    - nsis
  icon: assets/electron/icon.ico

linux:
  target:
    - AppImage
    - deb
  category: Development
  icon: assets/electron/icons

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true

publish:
  provider: github

electronVersion: "33"  # or latest stable at implementation time
```

**ASAR/filesystem split rationale:** electron-builder packs all `files` entries into `app.asar` by default. Electron's patched `fs` module can read from ASAR transparently, but the standalone bundled Node.js binary (used by daemon and app-bound modes) is a vanilla Node.js process without ASAR support. If `dist/server/`, `dist/client/`, or `node_modules/` were inside the ASAR, the spawned server process would crash with `ENOENT` or `MODULE_NOT_FOUND` when trying to `import` its dependencies. Placing them in `extraResources` ensures they exist as real files on disk.

### 5.2 Package.json additions

**File:** `package.json` (edit)

Add to devDependencies:
- `electron` (latest stable, e.g. `^33.0.0`)
- `electron-builder` (latest stable)
- `electron-updater` (latest stable)

Note: `@electron/rebuild` is explicitly NOT used. See Section 5.3 and Key Design Decision 3 for the native module rebuild strategy.

Add scripts:
```json
{
  "electron:dev": "npm run build:electron && cross-env ELECTRON_DEV=1 concurrently -n client,wizard,electron \"vite\" \"vite --config vite.wizard.config.ts\" \"electron .\"",
  "electron:build": "npm run build && npm run build:electron && npm run build:wizard && npm run prepare:bundled-node && electron-builder",
  "prepare:bundled-node": "tsx scripts/prepare-bundled-node.ts",
  "build:electron": "tsc -p tsconfig.electron.json",
  "build:wizard": "vite build --config vite.wizard.config.ts",
  "dev:wizard": "vite --config vite.wizard.config.ts",
  "test:electron": "vitest run --config vitest.electron.config.ts"
}
```

**Dev mode workflow (`electron:dev`):**

The dev script sets `ELECTRON_DEV=1` and starts three processes concurrently:
1. **Vite client dev server** (port 5173) -- serves the main Freshell web UI with HMR
2. **Vite wizard dev server** (port 5174) -- serves the setup wizard with HMR
3. **Electron** -- the main process, which detects `ELECTRON_DEV=1` and:
   - Uses `tsx` to run the server source directly (`server/index.ts`) instead of requiring a bundled Node.js binary and built server artifacts
   - Points the main BrowserWindow at `http://localhost:5173` (the Vite dev server) for full HMR support
   - Points the wizard BrowserWindow at `http://localhost:5174`

This means `electron:dev` requires no prior build step (beyond the fast `tsc` for the electron main process itself). No bundled Node.js binary is needed. No `npm run build` is needed. The dev experience matches the existing `npm run dev` workflow but with Electron chrome around it.

The `electron/main.ts` entry point detects dev mode via `process.env.ELECTRON_DEV === '1'` and passes `isDev: true` to `runStartup()`. The server spawner then uses the dev-mode spawn path (Section 3.1).

Add main field:
```json
{
  "main": "dist/electron/electron/main.js"
}
```

### 5.3 Bundled Node.js and native module preparation

**File:** `scripts/prepare-bundled-node.ts` (new)

This script is the critical piece of the Electron packaging pipeline. It performs three sequential tasks: downloading the standalone Node.js binary, downloading its headers, and recompiling `node-pty` against those headers. It is run as a pre-step before `electron-builder` packages the app.

**Why this is needed:** The Freshell server runs in a separate process using a bundled standalone Node.js binary (not Electron's embedded Node.js). Native modules like `node-pty` contain compiled C++ code (`.node` files) that are ABI-locked to the specific Node.js version they were compiled against. If `node-pty` is compiled against the wrong Node version, it crashes at startup with `NODE_MODULE_VERSION` mismatch. `@electron/rebuild` compiles against Electron's Node ABI, which is wrong for this architecture. The script below compiles against the bundled standalone Node's ABI.

#### Step 1: Download standalone Node.js binary

Downloads the Node.js binary from `https://nodejs.org/dist/v{VERSION}/`:

- **macOS/Linux:** `node-v{VERSION}-{platform}-{arch}.tar.gz` -- extract the `bin/node` binary
- **Windows:** `node-v{VERSION}-win-{arch}.zip` -- extract `node.exe`

Places the binary at `bundled-node/{platform}/{arch}/node` (or `node.exe` on Windows).

The target Node.js version is pinned in `scripts/bundled-node-version.json`:
```json
{ "version": "22.12.0" }
```

This file is the single source of truth for the bundled Node version. It is checked in to version control so all platforms build against the same version.

#### Step 2: Download Node.js headers

`node-gyp` requires C/C++ header files (`node_api.h`, `v8.h`, etc.) to compile native modules. The standalone Node.js binary tarball does NOT include these headers. They must be downloaded separately.

Downloads `https://nodejs.org/dist/v{VERSION}/node-v{VERSION}-headers.tar.gz` and extracts to `bundled-node/headers/`. This produces the directory structure that `node-gyp` expects when `--nodedir` is specified:

```
bundled-node/headers/
  node-v{VERSION}/
    include/
      node/
        node.h
        node_api.h
        v8.h
        uv.h
        ...
    src/        # (empty or minimal; node-gyp needs the dir to exist)
```

#### Step 3: Recompile node-pty against bundled Node headers

Runs `node-gyp rebuild` with the bundled Node's headers as the compilation target:

```typescript
import { execSync } from 'child_process'
import { readFileSync, cpSync, mkdirSync } from 'fs'
import path from 'path'

const { version } = JSON.parse(readFileSync('scripts/bundled-node-version.json', 'utf-8'))
const headersDir = path.resolve(`bundled-node/headers/node-v${version}`)
const nodePtyDir = path.resolve('node_modules/node-pty')

// Compile node-pty against the bundled Node's ABI.
// --nodedir points to the extracted headers directory (must contain include/node/*.h)
// --target specifies the Node version for ABI compatibility
execSync(
  `npx node-gyp rebuild --target=${version} --nodedir=${headersDir}`,
  { cwd: nodePtyDir, stdio: 'inherit' }
)

// Copy the compiled native module to a staging directory for electron-builder
mkdirSync('bundled-node/native-modules/node-pty/build/Release', { recursive: true })
cpSync(
  path.join(nodePtyDir, 'build/Release/pty.node'),
  'bundled-node/native-modules/node-pty/build/Release/pty.node'
)
// Also copy node-pty's JS files (the package's index.js, lib/*.js) so the module is complete
cpSync(
  nodePtyDir,
  'bundled-node/native-modules/node-pty',
  { recursive: true, filter: (src) => !src.includes('build') || src.endsWith('Release/pty.node') || src.includes('Release') }
)
```

#### Step 4: Prune and stage server node_modules

The server's runtime dependencies (express, ws, node-pty, etc.) must be available on the real filesystem for the bundled Node.js to import them. They cannot live inside the ASAR archive (see Section 5.1 rationale).

The preparation script creates a pruned copy of `node_modules/` containing only the server's runtime dependencies (not devDependencies like `vitest`, `electron`, `typescript`, etc.):

```typescript
// Create a clean server-node-modules directory
mkdirSync('server-node-modules', { recursive: true })

// Use npm to produce a production-only install
// This is done by copying package.json and running npm ci --omit=dev in a temp dir,
// then copying the resulting node_modules to server-node-modules/
execSync('npm ci --omit=dev --prefix server-node-modules-staging', { stdio: 'inherit' })
cpSync('server-node-modules-staging/node_modules', 'server-node-modules', { recursive: true })

// Remove node-pty's native binary from the pruned node_modules
// (it was compiled against the dev machine's Node, not the bundled one)
// The correctly-compiled version is in bundled-node/native-modules/
rmSync('server-node-modules/node-pty/build', { recursive: true, force: true })
```

electron-builder packages this as `extraResources/server-node-modules/` (see Section 5.1).

#### Runtime resolution: how the server finds its dependencies and the recompiled node-pty

At runtime, the server process needs to find two sets of modules:
1. **Standard npm dependencies** (express, ws, zod, etc.) -- in `{resourcesPath}/server-node-modules/`
2. **Recompiled node-pty** (with correct ABI) -- in `{resourcesPath}/bundled-node/native-modules/`

The server spawner (Section 3.1) sets `NODE_PATH` to include both directories, with native-modules first (so the recompiled node-pty takes precedence over any copy in server-node-modules):

```typescript
// In server-spawner.ts, production mode spawn:
const resourcesPath = process.resourcesPath  // Electron's resources dir
const nativeModulesDir = path.join(resourcesPath, 'bundled-node', 'native-modules')
const serverNodeModulesDir = path.join(resourcesPath, 'server-node-modules')
const serverEntry = path.join(resourcesPath, 'server', 'index.js')
const nodeBinary = path.join(resourcesPath, 'bundled-node', 'bin', 'node')

child_process.spawn(nodeBinary, [serverEntry], {
  env: {
    ...processEnv,
    // native-modules first, so recompiled node-pty wins over server-node-modules copy
    NODE_PATH: [nativeModulesDir, serverNodeModulesDir].join(path.delimiter),
    PORT: String(port),
    NODE_ENV: 'production',
  },
})
```

`NODE_PATH` prepends to Node's module resolution. When the server does `import express from 'express'`, Node checks `NODE_PATH` directories before looking for a local `node_modules/`. Since all server dependencies are in one of the two `NODE_PATH` entries, all imports resolve correctly.

The same path construction is used by daemon mode -- the OS service definition (plist/unit file/task XML) includes the `NODE_PATH` environment variable pointing to the same `extraResources` locations.

#### Build script integration

The `electron:build` script includes the preparation step:

```json
{
  "prepare:bundled-node": "tsx scripts/prepare-bundled-node.ts",
  "electron:build": "npm run build && npm run build:electron && npm run build:wizard && npm run prepare:bundled-node && electron-builder"
}
```

#### Tests for the preparation script

**Tests:** `test/unit/electron/prepare-bundled-node.test.ts`
- Verifies the headers directory structure is validated (rejects missing `include/node/node_api.h`)
- Verifies `node-gyp rebuild` is called with correct `--target` and `--nodedir` flags
- Verifies the compiled `pty.node` is copied to `bundled-node/native-modules/`
- Verifies the complete node-pty package (JS + native binary) is staged correctly

**File:** `scripts/bundled-node-version.json` (new)

```json
{ "version": "22.12.0" }
```

**File:** `.gitignore` (edit)

Add `bundled-node/` to .gitignore (the downloaded binaries, headers, and recompiled native modules are all build artifacts).

### 5.4 Icons and assets

**Directory:** `assets/electron/`

- `icon.icns` (macOS)
- `icon.ico` (Windows)
- `icons/` (Linux, multiple sizes: 16x16, 32x32, 48x48, 128x128, 256x256, 512x512)
- `tray-icon.png` (16x16 for macOS menu bar)
- `tray-icon@2x.png` (32x32 for macOS Retina menu bar)
- `tray-icon-win.ico` (Windows tray, 16x16)

Note: Actual icon design is outside the scope of this implementation. Placeholder icons will be used (simple colored square with "F" letter) and can be replaced later.

---

## Phase 6: CI/CD and GitHub Actions

### 6.1 GitHub Actions workflow

**File:** `.github/workflows/electron-build.yml` (new)

Matrix build for macOS, Linux, Windows:

```yaml
name: Electron Build
on:
  push:
    tags: ['v*']
  pull_request:
    paths: ['electron/**', 'electron-builder.yml']

jobs:
  build:
    strategy:
      matrix:
        os: [macos-latest, ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm test
      - run: npm run electron:build
      - uses: actions/upload-artifact@v4
        with:
          name: electron-${{ matrix.os }}
          path: release/*
```

### 6.2 Release workflow

**File:** `.github/workflows/electron-release.yml` (new)

On tag push (`v*`), builds and uploads to GitHub Releases. Uses `npm run electron:build` which includes all build steps (client, server, electron main process, wizard, and electron-builder packaging):

```yaml
name: Electron Release
on:
  push:
    tags: ['v*']

jobs:
  release:
    strategy:
      matrix:
        os: [macos-latest, ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run electron:build
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Note: The release workflow calls `npm run electron:build` (which expands to `npm run build && npm run build:electron && npm run build:wizard && electron-builder`) rather than sequencing individual build steps. This ensures the release always includes every build artifact. If a new build step is added in the future (e.g. for a new renderer), only `electron:build` needs updating -- not every workflow that calls it.

---

## Phase 7: Integration Tests

### 7.1 Server-info integration test

**File:** `test/integration/server/server-info-api.test.ts`

Uses `supertest` against a real Express app (same pattern as existing API tests):

```typescript
import { describe, it, expect } from 'vitest'
import request from 'supertest'
// ... test app setup

describe('/api/server-info', () => {
  it('returns server info with version and uptime', async () => {
    const res = await request(app)
      .get('/api/server-info')
      .set('X-Auth-Token', token)
      .expect(200)

    expect(res.body).toHaveProperty('version')
    expect(res.body).toHaveProperty('uptime')
    expect(res.body).toHaveProperty('nodeVersion')
    expect(res.body).toHaveProperty('platform')
    expect(res.body).toHaveProperty('arch')
    expect(typeof res.body.uptime).toBe('number')
  })

  it('requires authentication', async () => {
    await request(app)
      .get('/api/server-info')
      .expect(401)
  })
})
```

### 7.2 Playwright E2E tests (stretch)

**Files:** `test/e2e/electron/`

Two E2E tests using `@playwright/test` with Electron support:

1. **Setup wizard completion**: Launches app with no config -> wizard opens -> complete all steps -> main window opens
2. **App launch with existing config**: Launches app with pre-existing config -> main window opens directly

These tests require `electron` to be installed and may be slow. They are marked as a stretch goal and can be deferred if the CI matrix proves too complex initially.

---

## File Change Summary

### New files

| File | Purpose |
|------|---------|
| `electron/types.ts` | DesktopConfig interface and Zod schema |
| `electron/desktop-config.ts` | Read/write desktop config from ~/.freshell/desktop.json |
| `electron/daemon/daemon-manager.ts` | Abstract DaemonManager interface |
| `electron/daemon/launchd.ts` | macOS launchd implementation |
| `electron/daemon/systemd.ts` | Linux systemd implementation |
| `electron/daemon/windows-service.ts` | Windows scheduled task implementation |
| `electron/daemon/create-daemon-manager.ts` | Platform factory (async, uses dynamic import()) |
| `electron/server-spawner.ts` | App-bound mode server lifecycle |
| `electron/window-state.ts` | Window position/size persistence |
| `electron/hotkey.ts` | Global hotkey registration |
| `electron/tray.ts` | System tray icon and context menu |
| `electron/menu.ts` | Native application menus |
| `electron/updater.ts` | Auto-update via electron-updater |
| `electron/startup.ts` | Startup flow orchestrator |
| `electron/main.ts` | Electron main process entry |
| `electron/preload.ts` | Context bridge for renderer |
| `electron/setup-wizard/wizard-window.ts` | Wizard BrowserWindow creation |
| `electron/setup-wizard/index.html` | Wizard Vite HTML entry |
| `electron/setup-wizard/main.tsx` | Wizard React mount point |
| `electron/setup-wizard/wizard.tsx` | Wizard React multi-step form |
| `electron/setup-wizard/wizard.css` | Wizard Tailwind CSS entry (imports shared theme-variables.css) |
| `src/theme-variables.css` | Shared CSS custom property definitions (extracted from src/index.css) |
| `vite.wizard.config.ts` | Vite config for wizard build (JSX + Tailwind + bundling) |
| `tailwind.config.wizard.js` | Wizard-specific Tailwind config (scans electron/setup-wizard/ for classes) |
| `server/server-info-router.ts` | /api/server-info endpoint |
| `installers/launchd/com.freshell.server.plist.template` | macOS plist template |
| `installers/systemd/freshell.service.template` | Linux unit file template |
| `installers/windows/freshell-task.xml.template` | Windows task template |
| `tsconfig.electron.json` | TypeScript config for electron main process (excludes .tsx) |
| `vitest.electron.config.ts` | Vitest config for electron tests |
| `electron-builder.yml` | electron-builder packaging config |
| `scripts/prepare-bundled-node.ts` | Download Node binary + headers, recompile node-pty, stage native modules |
| `scripts/bundled-node-version.json` | Pinned bundled Node.js version (single source of truth) |
| `.github/workflows/electron-build.yml` | CI build workflow |
| `.github/workflows/electron-release.yml` | Release workflow |
| `assets/electron/` | Icons and tray icons (placeholder) |

### New test files

| File | Type | What it tests |
|------|------|---------------|
| `test/unit/electron/desktop-config.test.ts` | Unit | Config read/write/patch/validation |
| `test/unit/electron/daemon/launchd.test.ts` | Unit | macOS daemon management |
| `test/unit/electron/daemon/systemd.test.ts` | Unit | Linux daemon management |
| `test/unit/electron/daemon/windows-service.test.ts` | Unit | Windows daemon management |
| `test/unit/electron/daemon/create-daemon-manager.test.ts` | Unit | Platform factory |
| `test/unit/electron/server-spawner.test.ts` | Unit | App-bound server lifecycle |
| `test/unit/electron/window-state.test.ts` | Unit | Window state persistence |
| `test/unit/electron/hotkey.test.ts` | Unit | Global hotkey registration |
| `test/unit/electron/tray.test.ts` | Unit | System tray behavior |
| `test/unit/electron/menu.test.ts` | Unit | Native menu structure |
| `test/unit/electron/updater.test.ts` | Unit | Auto-update flow |
| `test/unit/electron/startup.test.ts` | Unit | Startup orchestration |
| `test/unit/electron/main.test.ts` | Unit | Main process lifecycle |
| `test/unit/electron/preload.test.ts` | Unit | Preload API shape |
| `test/unit/electron/setup-wizard/wizard.test.tsx` | Unit | Setup wizard UI |
| `test/unit/electron/prepare-bundled-node.test.ts` | Unit | Node download/headers/recompile pipeline |
| `test/integration/server/server-info-api.test.ts` | Integration | /api/server-info endpoint |

### Modified files

| File | Change |
|------|--------|
| `server/index.ts` | Mount `/api/server-info` router, capture `startedAt` timestamp |
| `package.json` | Add electron/electron-builder/electron-updater deps, add scripts, add `main` field |
| `vitest.config.ts` | Add `test/unit/electron/**` to exclude array (prevent jsdom runner picking up electron tests) |
| `src/index.css` | Extract `:root`/`.dark` CSS variable blocks into `src/theme-variables.css`, replace with `@import` |
| `.gitignore` | Add `bundled-node/`, `server-node-modules/`, `release/`, `dist/wizard/` |

---

## Execution Order

The phases are designed to be implemented sequentially, each building on the previous:

1. **Phase 1** (Foundation): Config types, server endpoint, TS config -- no Electron dependency yet
2. **Phase 2** (Daemon): All three platform daemon managers -- testable with mocked OS calls
3. **Phase 3** (Main Process): All Electron modules -- testable with mocked Electron APIs
4. **Phase 4** (Setup Wizard): Wizard UI -- depends on Phase 3 for IPC
5. **Phase 5** (Build): Packaging config -- depends on everything being buildable
6. **Phase 6** (CI): GitHub Actions -- depends on build config
7. **Phase 7** (Integration tests): End-to-end validation

Within each phase, the order is file-by-file as listed.

---

## Key Design Decisions

1. **Separate config file (`desktop.json`)**: The desktop config lives in `~/.freshell/desktop.json`, completely separate from the server's `~/.freshell/config.json`. This prevents a data loss race condition: the server's `ConfigStore` caches `config.json` in memory on first read and never re-reads from disk, so if both processes shared one file, the server's stale cache would silently overwrite Electron's changes on its next write. With separate files, each process owns its file exclusively. No cross-process locking or cache invalidation is needed.

2. **Windows "daemon" via Scheduled Tasks**: Rather than pulling in `node-windows` (heavy native dependency), we use `schtasks` which is built into every Windows installation. This provides "run at logon" and "restart on failure" behavior without native compilation headaches.

3. **ASAR/filesystem split**: electron-builder packs `files` entries into `app.asar` by default. Only Electron's patched `fs` module can read from ASAR; the standalone bundled Node.js binary is a vanilla Node.js process and would crash with `ENOENT`/`MODULE_NOT_FOUND` if the server code, client assets, or npm dependencies were inside the ASAR. Therefore: only the Electron main process code (`dist/electron/`) and wizard bundle (`dist/wizard/`) go into the ASAR (`files`). Everything the server needs goes into `extraResources` (real filesystem): `dist/server/`, `dist/client/`, `server-node-modules/` (pruned production deps), `bundled-node/bin/` (Node binary), and `bundled-node/native-modules/` (recompiled node-pty). The server spawner constructs all paths relative to `process.resourcesPath`.

4. **Bundled Node.js with fully-specified native module pipeline**: The daemon and app-bound modes run the server via a standalone Node.js binary bundled in the app's resources. The pipeline is: (1) download Node.js binary from `nodejs.org/dist/`, (2) download the Node.js headers tarball separately (the binary tarball does not include headers), (3) run `node-gyp rebuild --target={version} --nodedir={headers-dir}` in node-pty's directory, (4) stage the recompiled package in `bundled-node/native-modules/`, (5) prune and stage server runtime `node_modules` into `server-node-modules/`, (6) at runtime, set `NODE_PATH` to both `native-modules` and `server-node-modules` so all server imports resolve correctly from the real filesystem. `@electron/rebuild` is NOT used -- it compiles against Electron's Node ABI, which would crash when loaded by the standalone bundled Node. The bundled Node version is pinned in `scripts/bundled-node-version.json` as the single source of truth. This means:
   - No system Node.js dependency for end users
   - node-pty is compiled against the exact Node ABI it will run under
   - The Electron Node.js is completely separate from the server Node.js
   - The compilation target is explicit and reproducible across platforms

5. **Setup wizard as a separate BrowserWindow with its own Vite build**: The wizard is not a route in the main app -- it works without any server running, which is essential for the first-run experience. It has a dedicated Vite config (`vite.wizard.config.ts`) that produces a self-contained bundle (`dist/wizard/`) with React JSX transform and Tailwind CSS processing. CSS theme variables (`:root`/`.dark` custom properties) are extracted into `src/theme-variables.css` and imported by both the main app's CSS and the wizard's CSS, ensuring semantic Tailwind colors (e.g., `bg-background`, `text-foreground`) render correctly in both contexts. The `tsconfig.electron.json` excludes `.tsx` files; they are handled exclusively by Vite.

6. **Dynamic `import()` in platform factory**: The project uses `"type": "module"` (ESM) throughout. The daemon manager factory uses `await import()` instead of `require()` (which is unavailable in ESM). The factory function is `async`, which fits naturally since all callers are already async.

7. **Three separate vitest configs**: Client tests (`vitest.config.ts`, jsdom), server tests (`vitest.server.config.ts`, node), and electron tests (`vitest.electron.config.ts`, node). Each config's `exclude` array prevents other configs from picking up its tests, avoiding duplicate runs or wrong-environment failures.

8. **Quake-style toggle**: The global hotkey toggles window visibility. Implementation is in the hotkey callback, not in a separate module, because the logic is simple (show+focus if hidden, hide if focused).

9. **electron-builder over electron-forge**: electron-builder is the more mature option with better cross-platform support, native module rebuilding, and auto-update integration. It also produces the exact output formats we want (DMG, NSIS, AppImage+deb).

10. **No changes to existing server code beyond the /api/server-info endpoint**: The Electron layer is a pure consumer of the existing HTTP/WS API. This maintains the architectural invariant that the server doesn't know Electron exists.

---

## Risk Assessment

1. **node-pty native compilation**: node-pty must be compiled against the bundled standalone Node.js ABI, not Electron's Node ABI. The `prepare-bundled-node.ts` script handles this with a three-step pipeline: download the Node.js headers tarball (separate from the binary), run `node-gyp rebuild --target={version} --nodedir={headers-dir}`, and stage the complete recompiled package. At runtime, `NODE_PATH` directs the server's `import 'node-pty'` to the staged copy. If any step fails or targets the wrong version, the server crashes with `NODE_MODULE_VERSION` mismatch. The version is pinned in `scripts/bundled-node-version.json` as a single source of truth. This is tested by the CI build matrix (which runs a real build on each platform) but is inherently fragile -- any upgrade to the bundled Node.js version requires updating the pinned version and re-running the pipeline.

2. **Cross-platform daemon reliability**: Each platform's daemon implementation is relatively simple (write a config file, run a CLI command) but edge cases exist (permissions, systemd user sessions not running without login, etc.). The unit tests mock OS calls; real OS testing is deferred to manual QA.

3. **Auto-update without code signing**: Without code signing, macOS will show "unidentified developer" warnings and Gatekeeper may block the app. Windows will show SmartScreen warnings. This is explicitly deferred to post-v1 per the design doc.

4. **Wizard build complexity**: The wizard requires a separate Vite build (`vite.wizard.config.ts`) in addition to the main client build and the `tsc` electron build. This adds a third build step but is unavoidable -- React JSX + Tailwind CSS cannot be processed by `tsc` alone, and the wizard must work without a running server (so it cannot be served by the existing Vite dev server).

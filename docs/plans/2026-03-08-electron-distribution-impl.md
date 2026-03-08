# Freshell Electron Distribution - Implementation Plan

**Date:** 2026-03-08
**Design doc:** `docs/plans/2026-03-08-electron-distribution-design.md`
**Branch:** `electron-distribution`

---

## Overview

This plan implements an Electron desktop shell around the existing Freshell web app. The Electron layer is a **thin native wrapper** -- the server code, web UI, and WebSocket protocol are completely unchanged. The new code lives in `electron/` (main process) and `installers/` (OS service definitions). The server gains one new endpoint (`/api/server-info`), and the config schema gains one new optional key (`desktop`).

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

A standalone module (no Electron imports) that reads/writes the `desktop` key from `~/.freshell/config.json` using the same atomic-write pattern as `server/config-store.ts`. This module is used by both the Electron main process and by tests.

Methods:
- `readDesktopConfig(): Promise<DesktopConfig | null>` -- returns null if key is absent
- `writeDesktopConfig(config: DesktopConfig): Promise<void>` -- merges into existing config.json
- `patchDesktopConfig(patch: Partial<DesktopConfig>): Promise<DesktopConfig>` -- read-modify-write with mutex
- `getDefaultDesktopConfig(): DesktopConfig` -- returns defaults (serverMode: 'app-bound', etc.)

**Key design decision:** This module does NOT import from `server/config-store.ts`. The Electron process and the server process are separate Node runtimes; they share the config file but not memory. The desktop-config module reads/writes `~/.freshell/config.json` directly with atomic writes, just like the server does. The server's existing `UserConfig` type gains an optional `desktop?: DesktopConfig` key but never reads or writes it -- only the Electron layer does.

**Tests:** `test/unit/electron/desktop-config.test.ts`
- Reads config when `desktop` key is present
- Returns null when `desktop` key is absent
- Writes config without clobbering existing keys (settings, sessionOverrides, etc.)
- Patch merges correctly
- Validates against schema (rejects invalid serverMode, etc.)
- Atomic write uses temp file + rename pattern

### 1.2 Extend UserConfig type (backward compatible)

**File:** `server/config-store.ts` (edit)

Add optional `desktop` field to `UserConfig`:

```typescript
import type { DesktopConfig } from '../electron/types.js'

export type UserConfig = {
  version: 1
  settings: AppSettings
  sessionOverrides: Record<string, SessionOverride>
  terminalOverrides: Record<string, TerminalOverride>
  projectColors: Record<string, string>
  recentDirectories?: string[]
  desktop?: DesktopConfig  // <-- new, optional
}
```

The `load()` method in `ConfigStore` already spreads the existing config and adds defaults only for keys it owns. The `desktop` key passes through untouched. The `saveInternal()` method serializes the full `UserConfig` which will include `desktop` if present.

**Tests:** `test/unit/server/config-store.test.ts` (extend)
- Existing tests continue to pass (desktop key is optional)
- Round-trip: write config with desktop key, read it back, verify it's preserved
- Config without desktop key works identically to today

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
  ]
}
```

### 1.5 Vitest configuration for Electron tests

**File:** `vitest.electron.config.ts` (new)

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/electron/**/*.test.ts'],
    exclude: ['docs/plans/**'],
    testTimeout: 30000,
    hookTimeout: 30000,
    alias: {
      '@electron': './electron',
    },
  },
})
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
  nodeBinary: string      // bundled Node.js binary path
  serverEntry: string     // bundled server/index.js path
  configDir: string       // ~/.freshell
  logDir: string          // ~/.freshell/logs
}

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

Template plist with `{{NODE_BINARY}}`, `{{SERVER_ENTRY}}`, `{{PORT}}`, `{{CONFIG_DIR}}`, `{{LOG_DIR}}` placeholders.

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

Template systemd unit with `{{NODE_BINARY}}`, `{{SERVER_ENTRY}}`, `{{PORT}}`, `{{CONFIG_DIR}}`, `{{LOG_DIR}}` placeholders.

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

Template XML for the scheduled task.

**Tests:** `test/unit/electron/daemon/windows-service.test.ts`
- Mock `child_process.execFile` for schtasks/tasklist commands
- Tests for all lifecycle operations
- Status parsing from CSV output

### 2.5 Platform factory

**File:** `electron/daemon/create-daemon-manager.ts`

```typescript
import type { DaemonManager } from './daemon-manager.js'

export function createDaemonManager(): DaemonManager {
  switch (process.platform) {
    case 'darwin':
      const { LaunchdDaemonManager } = require('./launchd.js')
      return new LaunchdDaemonManager()
    case 'linux':
      const { SystemdDaemonManager } = require('./systemd.js')
      return new SystemdDaemonManager()
    case 'win32':
      const { WindowsServiceDaemonManager } = require('./windows-service.js')
      return new WindowsServiceDaemonManager()
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}
```

**Tests:** `test/unit/electron/daemon/create-daemon-manager.test.ts`
- Returns correct implementation for each platform (mock process.platform)
- Throws for unsupported platform

---

## Phase 3: Electron Main Process

### 3.1 Server spawner (app-bound mode)

**File:** `electron/server-spawner.ts`

Manages spawning the bundled Freshell server as a child process for app-bound mode:

```typescript
export interface ServerSpawnerOptions {
  nodeBinary: string
  serverEntry: string
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
- `start()` spawns `child_process.spawn(nodeBinary, [serverEntry])` with env vars from the .env file plus `PORT`, `NODE_ENV=production`
- Polls `http://localhost:{port}/api/health` with exponential backoff (100ms, 200ms, 400ms, ..., max 30s)
- Pipes stdout/stderr to `~/.freshell/logs/server.log`
- `stop()` sends SIGTERM, waits 5s, then SIGKILL if still alive

**Tests:** `test/unit/electron/server-spawner.test.ts`
- Mock `child_process.spawn` and `http.get`
- `start()` spawns process with correct args and env
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
}

export async function runStartup(ctx: StartupContext): Promise<{
  serverUrl: string
  window: Electron.BrowserWindow
}>
```

Sequence:
1. Read desktop config from `~/.freshell/config.json`
2. If `!setupCompleted`, return early with signal to show wizard (not the main window)
3. Based on `serverMode`:
   - `daemon`: Check `daemonManager.status()`. If not running, `daemonManager.start()`. If not installed, throw with message to re-run setup.
   - `app-bound`: `serverSpawner.start(...)`. Wait for health check.
   - `remote`: Validate connectivity via fetch to `remoteUrl + '/api/health'`
4. Determine `serverUrl` based on mode
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
- App-bound mode: spawns server, waits for health
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
- Loads `electron/setup-wizard/index.html`
- No menu bar
- Communicates results back via IPC

### 4.2 Wizard HTML entry

**File:** `electron/setup-wizard/index.html`

Minimal HTML shell that loads the wizard React app. In development, loads from Vite; in production, loads the bundled wizard JS.

### 4.3 Wizard React app

**File:** `electron/setup-wizard/wizard.tsx`

React app with the same stack as the main Freshell UI (React, Tailwind) but self-contained. Multi-step form:

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
- Conflict detection: try registering, if fails show warning

**Step 5: Complete**
- Summary of choices
- "Launch Freshell" button
- Writes config via IPC, sets `setupCompleted: true`

**Tests:** `test/unit/electron/setup-wizard/wizard.test.tsx`
- Renders each step
- Step navigation (next/back)
- Server mode selection updates state
- Port validation (number, range 1024-65535)
- Remote URL validation
- Hotkey recording
- Completion writes config via IPC
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

files:
  - dist/electron/**
  - dist/server/**
  - dist/client/**
  - node_modules/**
  - package.json

extraResources:
  - from: bundled-node/${os}/${arch}
    to: bundled-node
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

### 5.2 Package.json additions

**File:** `package.json` (edit)

Add to devDependencies:
- `electron` (latest stable, e.g. `^33.0.0`)
- `electron-builder` (latest stable)
- `electron-updater` (latest stable)
- `@electron/rebuild` (for native modules like node-pty)

Add scripts:
```json
{
  "electron:dev": "npm run build:electron && electron .",
  "electron:build": "npm run build && npm run build:electron && electron-builder",
  "build:electron": "tsc -p tsconfig.electron.json",
  "test:electron": "vitest run --config vitest.electron.config.ts"
}
```

Add main field:
```json
{
  "main": "dist/electron/electron/main.js"
}
```

### 5.3 Bundled Node.js preparation

**File:** `scripts/prepare-bundled-node.ts` (new)

Script that downloads the standalone Node.js binary for the current (or specified) platform and places it in `bundled-node/{os}/{arch}/`. This is run as part of the electron build process, not committed to the repo.

The bundled Node.js is used by both daemon and app-bound modes to run the Freshell server independently of Electron's Node.js.

**File:** `.gitignore` (edit)

Add `bundled-node/` to .gitignore.

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

On tag push (`v*`), builds and uploads to GitHub Releases:

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
      - run: npm ci
      - run: npm run build
      - run: npm run build:electron
      - run: npx electron-builder --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

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
| `electron/desktop-config.ts` | Read/write desktop config from ~/.freshell/config.json |
| `electron/daemon/daemon-manager.ts` | Abstract DaemonManager interface |
| `electron/daemon/launchd.ts` | macOS launchd implementation |
| `electron/daemon/systemd.ts` | Linux systemd implementation |
| `electron/daemon/windows-service.ts` | Windows scheduled task implementation |
| `electron/daemon/create-daemon-manager.ts` | Platform factory |
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
| `electron/setup-wizard/index.html` | Wizard HTML entry |
| `electron/setup-wizard/wizard.tsx` | Wizard React multi-step form |
| `server/server-info-router.ts` | /api/server-info endpoint |
| `installers/launchd/com.freshell.server.plist.template` | macOS plist template |
| `installers/systemd/freshell.service.template` | Linux unit file template |
| `installers/windows/freshell-task.xml.template` | Windows task template |
| `tsconfig.electron.json` | TypeScript config for electron/ |
| `vitest.electron.config.ts` | Vitest config for electron tests |
| `electron-builder.yml` | electron-builder packaging config |
| `scripts/prepare-bundled-node.ts` | Bundled Node.js download script |
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
| `test/integration/server/server-info-api.test.ts` | Integration | /api/server-info endpoint |

### Modified files

| File | Change |
|------|--------|
| `server/config-store.ts` | Add optional `desktop?: DesktopConfig` to `UserConfig` type |
| `server/index.ts` | Mount `/api/server-info` router, capture `startedAt` timestamp |
| `package.json` | Add electron/electron-builder/electron-updater deps, add scripts, add `main` field |
| `.gitignore` | Add `bundled-node/`, `release/` |
| `test/unit/server/config-store.test.ts` | Add round-trip test for desktop key preservation |

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

1. **Separate config access**: The Electron layer reads/writes `~/.freshell/config.json` independently from the server. No shared in-memory state. Both use atomic writes. This is safe because they write different keys (`desktop` vs `settings`).

2. **Windows "daemon" via Scheduled Tasks**: Rather than pulling in `node-windows` (heavy native dependency), we use `schtasks` which is built into every Windows installation. This provides "run at logon" and "restart on failure" behavior without native compilation headaches.

3. **Bundled Node.js**: The daemon and app-bound modes run the server via a standalone Node.js binary bundled in the app's resources. This means:
   - No system Node.js dependency for end users
   - node-pty is compiled against this specific Node version, avoiding ABI mismatches
   - The Electron Node.js is completely separate from the server Node.js

4. **Setup wizard as a separate BrowserWindow**: Not a route in the main app. This means the wizard works without any server running, which is essential for the first-run experience.

5. **Quake-style toggle**: The global hotkey toggles window visibility. Implementation is in the hotkey callback, not in a separate module, because the logic is simple (show+focus if hidden, hide if focused).

6. **electron-builder over electron-forge**: electron-builder is the more mature option with better cross-platform support, native module rebuilding, and auto-update integration. It also produces the exact output formats we want (DMG, NSIS, AppImage+deb).

7. **No changes to existing server code beyond the /api/server-info endpoint**: The Electron layer is a pure consumer of the existing HTTP/WS API. This maintains the architectural invariant that the server doesn't know Electron exists.

---

## Risk Assessment

1. **node-pty native compilation**: node-pty needs to be compiled against the bundled Node.js version, not Electron's Node.js. This is handled by `@electron/rebuild` configuration and by running the server in a separate Node.js process.

2. **Cross-platform daemon reliability**: Each platform's daemon implementation is relatively simple (write a config file, run a CLI command) but edge cases exist (permissions, systemd user sessions not running without login, etc.). The unit tests mock OS calls; real OS testing is deferred to manual QA.

3. **Auto-update without code signing**: Without code signing, macOS will show "unidentified developer" warnings and Gatekeeper may block the app. Windows will show SmartScreen warnings. This is explicitly deferred to post-v1 per the design doc.

4. **Config file contention**: Both Electron and server write to `~/.freshell/config.json`. Since they write different keys and both use atomic writes (temp file + rename), the risk of corruption is minimal. The worst case is a lost write, which is the same risk that exists today with concurrent server restarts.

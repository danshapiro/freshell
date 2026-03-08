# Freshell Electron Distribution — Design

**Date:** 2026-03-08
**Status:** Approved

## Goals

- Native desktop app experience with deep OS integration (global hotkeys, system tray, native menus, notifications)
- Three server modes, switchable in settings, chosen at first-run setup:
  1. **Always-running daemon** — OS-level service that survives reboots and app quits
  2. **App-bound** — server starts/stops with the Electron app
  3. **Remote-only** — connect to a Freshell server on another machine
- Ship on macOS, Linux, and Windows for v1
- Existing browser access continues to work alongside the Electron app
- Mobile planned but not v1

## Non-Goals for v1

- Code signing / notarization (deferred post-v1)
- Package manager distribution (brew, winget, etc.)
- Mobile clients

## Architecture: Monorepo with Electron Layer

The Electron app is added as a new `electron/` directory in the existing repo. It is a native shell around the existing web UI. The server code is completely untouched — it doesn't know Electron exists.

```
freshell/
├── electron/                # NEW — Electron main process layer
│   ├── main.ts              # Main process entry point
│   ├── preload.ts           # Context bridge for OS integration
│   ├── daemon/              # Per-platform service management
│   │   ├── daemon-manager.ts    # Abstract interface
│   │   ├── launchd.ts           # macOS implementation
│   │   ├── systemd.ts           # Linux implementation
│   │   └── windows-service.ts   # Windows implementation
│   ├── setup-wizard/        # First-run native setup UI
│   │   ├── index.html
│   │   └── wizard.tsx        # React-based wizard steps
│   ├── tray.ts              # System tray icon + menu
│   ├── hotkey.ts            # Global hotkey registration
│   ├── updater.ts           # Auto-update via electron-updater
│   └── menu.ts              # Native application menus
├── installers/              # NEW — platform service definitions
│   ├── launchd/             # macOS plist template
│   ├── systemd/             # Linux unit file template
│   └── windows/             # Windows service config
├── server/                  # UNCHANGED
├── src/                     # UNCHANGED
└── package.json             # Extended with electron-builder config
```

## Server Modes

| Mode | Server Lifecycle | Electron Connects Via | Terminals Survive App Quit |
|------|-----------------|----------------------|---------------------------|
| **Daemon** | OS service (launchd/systemd/Windows Service) running bundled Node.js | `http://localhost:{port}` | Yes |
| **App-bound** | Electron spawns bundled Node.js as child process; kills on quit | `http://localhost:{port}` | No |
| **Remote** | No local server | User-configured `http(s)://{host}:{port}` | N/A (server is elsewhere) |

### Daemon Details

The daemon runs the existing Freshell server via a bundled standalone Node.js runtime (not Electron's Node). This avoids depending on the user having Node.js installed.

**Per-platform service management:**

- **macOS:** `~/Library/LaunchAgents/com.freshell.server.plist` — launchd user agent. Managed via `launchctl load/unload`.
- **Linux:** `~/.config/systemd/user/freshell.service` — systemd user unit. Managed via `systemctl --user enable/start/stop/disable`.
- **Windows:** Windows Service via `node-windows` or lightweight service wrapper. Runs under user account.

**All platforms share:**
- Daemon runs `{bundled-node} {bundled-server}/index.js`
- Config from `~/.freshell/config.json`
- Auth token from `~/.freshell/.env`
- Logs to `~/.freshell/logs/`

A `DaemonManager` class provides a platform-abstract interface:
- `install()` / `uninstall()` — register/remove the OS service
- `start()` / `stop()` — control the service
- `status()` — check if running, get PID, uptime
- `isInstalled()` — check if service is registered

## Electron Main Process

### Startup Flow

1. Read `~/.freshell/config.json` for `desktop` settings
2. If `!desktop.setupCompleted`, show setup wizard
3. Based on `desktop.serverMode`:
   - **Daemon:** Check service status via `DaemonManager.status()`. If not running, attempt start. If not installed, prompt to install.
   - **App-bound:** Spawn `{bundled-node} {bundled-server}/index.js` as child process. Wait for `/api/health` to respond.
   - **Remote:** Validate connectivity to `desktop.remoteUrl` via `/api/health`.
4. Create `BrowserWindow`, load server URL
5. Register global hotkey
6. Create system tray icon
7. Check for updates (non-blocking)

### Global Hotkey

- Default: `CommandOrControl+\`` (configurable in settings)
- Behavior: Toggle visibility (quake-style). If hidden → show + focus. If focused → hide.
- Registered via `electron.globalShortcut.register()`

### System Tray

- Icon with context menu:
  - Show/Hide window
  - Server status indicator (running/stopped/error)
  - Current server mode
  - Separator
  - Settings
  - Check for Updates
  - Quit

### Window Behavior

- Close button: Minimizes to tray (configurable; default true for daemon mode)
- Quit: Cmd+Q / Alt+F4 actually quits (stops app-bound server if applicable)
- Window state (position, size, maximized) persisted to config

## Setup Wizard

A separate `BrowserWindow` shown on first launch. Built with React/Tailwind (same stack as main app, for consistency). No server connection needed.

### Steps

1. **Welcome** — Freshell branding, brief description
2. **Server Mode** — Choose daemon / app-bound / remote with clear explanations of trade-offs
3. **Configuration** — Mode-specific:
   - Daemon: Install the service, choose port
   - App-bound: Choose port
   - Remote: Enter URL + auth token
4. **Global Hotkey** — Pick the summon shortcut (with conflict detection)
5. **Complete** — Launch Freshell

## Config Schema Extension

New `desktop` key in `~/.freshell/config.json`:

```typescript
interface DesktopConfig {
  serverMode: 'daemon' | 'app-bound' | 'remote';
  remoteUrl?: string;          // remote mode only
  remoteToken?: string;        // remote mode only
  globalHotkey: string;        // default: 'CommandOrControl+`'
  startOnLogin: boolean;       // auto-start Electron on OS login
  minimizeToTray: boolean;     // close button minimizes vs quits
  setupCompleted: boolean;     // first-run flag
  windowState?: {              // persisted window geometry
    x: number;
    y: number;
    width: number;
    height: number;
    maximized: boolean;
  };
}
```

Backward compatible — web-only installations simply won't have this key.

## Build & Packaging

**Tooling:** electron-builder

**Outputs:**
- macOS: `.dmg` (drag-to-Applications)
- Windows: NSIS installer (`.exe`)
- Linux: `.AppImage` (portable) + `.deb` (Debian/Ubuntu)

**Bundled Node.js:** Platform-specific Node.js binary included in the app's resources directory. Used exclusively by the daemon/app-bound server. Keeps `node-pty` compilation isolated from Electron's Node version.

**Auto-update:** electron-updater pointed at GitHub Releases. Checks on launch, notifies user.

## Changes to Existing Code

### Minimal

- `~/.freshell/config.json` schema: add optional `desktop` key (backward compatible)
- Server's `/api/health` endpoint: already exists, used by Electron to detect running server
- New `/api/server-info` endpoint: returns server version, uptime, mode — displayed in tray menu

### Nothing Changes

- Server code, WebSocket protocol, auth, terminal management
- Web browser access
- CLI (`freshell` command)
- Configuration persistence, session discovery

## Testing Strategy

- **Unit tests:** DaemonManager (mocked OS calls), server mode switching, config schema validation, hotkey registration
- **Integration tests:** Electron main process lifecycle via Playwright for Electron
- **E2E tests:** Setup wizard flow, hotkey toggle, tray interactions, mode switching
- **Platform CI:** GitHub Actions matrix for macOS, Linux, Windows builds

import path from 'path'
import type { DesktopConfig } from './types.js'
import type { DaemonManager } from './daemon/daemon-manager.js'
import type { ServerSpawner } from './server-spawner.js'
import type { HotkeyManager } from './hotkey.js'
import type { WindowStatePersistence } from './window-state.js'
import type { UpdateManager } from './updater.js'

export interface BrowserWindowLike {
  loadURL(url: string): Promise<void>
  show(): void
  hide(): void
  focus(): void
  maximize(): void
  isVisible(): boolean
  isFocused(): boolean
  on(event: string, callback: (...args: any[]) => void): void
}

export interface BrowserWindowConstructor {
  new (options: Record<string, any>): BrowserWindowLike
}

export interface StartupContext {
  desktopConfig: DesktopConfig
  daemonManager: DaemonManager
  serverSpawner: ServerSpawner
  hotkeyManager: HotkeyManager
  windowStatePersistence: WindowStatePersistence
  updateManager: UpdateManager
  isDev: boolean
  port: number
  /** Electron's process.resourcesPath -- where extraResources live in production */
  resourcesPath?: string
  configDir: string  // ~/.freshell
  createBrowserWindow: (options: Record<string, any>) => BrowserWindowLike
  createTray: () => void
  fetchHealthCheck?: (url: string) => Promise<boolean>
}

export type StartupResult =
  | { type: 'wizard' }
  | { type: 'main'; serverUrl: string; window: BrowserWindowLike }

export async function runStartup(ctx: StartupContext): Promise<StartupResult> {
  const { desktopConfig, isDev, port } = ctx

  // 1. If setup not completed, signal wizard
  if (!desktopConfig.setupCompleted) {
    return { type: 'wizard' }
  }

  // 2. Based on serverMode, ensure server is accessible
  let serverUrl: string

  switch (desktopConfig.serverMode) {
    case 'daemon': {
      const status = await ctx.daemonManager.status()
      if (!status.installed) {
        throw new Error('Daemon service is not installed. Please re-run setup to configure the daemon.')
      }
      if (!status.running) {
        await ctx.daemonManager.start()
      }
      serverUrl = `http://localhost:${port}`
      break
    }
    case 'app-bound': {
      if (isDev) {
        await ctx.serverSpawner.start({
          spawn: {
            mode: 'dev',
            tsxPath: 'npx',
            serverSourceEntry: 'server/index.ts',
          },
          port,
          envFile: path.join(ctx.configDir, '.env'),
          configDir: ctx.configDir,
        })
        // In dev mode, point at Vite dev server
        serverUrl = 'http://localhost:5173'
      } else {
        if (!ctx.resourcesPath) {
          throw new Error('resourcesPath is required for production app-bound mode')
        }
        const resourcesPath = ctx.resourcesPath
        await ctx.serverSpawner.start({
          spawn: {
            mode: 'production',
            nodeBinary: path.join(resourcesPath, 'bundled-node', 'bin', 'node'),
            serverEntry: path.join(resourcesPath, 'server', 'index.js'),
            nativeModulesDir: path.join(resourcesPath, 'bundled-node', 'native-modules'),
            serverNodeModulesDir: path.join(resourcesPath, 'server-node-modules'),
          },
          port,
          envFile: path.join(ctx.configDir, '.env'),
          configDir: ctx.configDir,
        })
        serverUrl = `http://localhost:${port}`
      }
      break
    }
    case 'remote': {
      const remoteUrl = desktopConfig.remoteUrl
      if (!remoteUrl) {
        throw new Error('Remote URL not configured. Please re-run setup.')
      }

      // Validate connectivity
      const fetchFn = ctx.fetchHealthCheck ?? (async (url: string) => {
        const response = await fetch(url)
        return response.ok
      })

      let ok: boolean
      try {
        ok = await fetchFn(`${remoteUrl}/api/health`)
      } catch {
        throw new Error(`Cannot connect to remote server at ${remoteUrl}`)
      }
      if (!ok) {
        throw new Error(`Cannot connect to remote server at ${remoteUrl}`)
      }

      serverUrl = remoteUrl
      break
    }
    default:
      throw new Error(`Unknown server mode: ${desktopConfig.serverMode}`)
  }

  // 3. Load window state and create window
  const windowState = await ctx.windowStatePersistence.load()
  const window = ctx.createBrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  await window.loadURL(serverUrl)
  window.show()

  if (windowState.maximized) {
    window.maximize()
  }

  // 4. Register global hotkey (quake-style toggle)
  ctx.hotkeyManager.register(desktopConfig.globalHotkey, () => {
    if (window.isVisible() && window.isFocused()) {
      window.hide()
    } else {
      window.show()
      window.focus()
    }
  })

  // 5. Create system tray
  ctx.createTray()

  // 6. Schedule update check (10s delay)
  setTimeout(() => {
    void ctx.updateManager.checkForUpdates()
  }, 10_000)

  return { type: 'main', serverUrl, window }
}

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
  getBounds?(): { x: number; y: number; width: number; height: number }
  isMaximized?(): boolean
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
  platform: NodeJS.Platform
  createBrowserWindow: (options: Record<string, any>) => BrowserWindowLike
  createTray: () => void
  fetchHealthCheck?: (url: string) => Promise<boolean>
  /** Read AUTH_TOKEN from the .env file in configDir. Returns undefined if not found. */
  readEnvToken?: (envPath: string) => Promise<string | undefined>
}

export type StartupResult =
  | { type: 'wizard' }
  | { type: 'main'; serverUrl: string; window: BrowserWindowLike; updateCheckTimer: ReturnType<typeof setTimeout> }

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
            nodeBinary: path.join(resourcesPath, 'bundled-node', 'bin', ctx.platform === 'win32' ? 'node.exe' : 'node'),
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

      // Validate connectivity (with timeout to prevent hangs)
      const fetchFn = ctx.fetchHealthCheck ?? (async (url: string) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 10_000)
        try {
          const response = await fetch(url, { signal: controller.signal })
          return response.ok
        } finally {
          clearTimeout(timer)
        }
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

  // Resolve auth token for automatic authentication
  let authToken: string | undefined

  if (desktopConfig.serverMode === 'remote') {
    // Remote mode: use the token from the wizard config
    authToken = desktopConfig.remoteToken
  } else if (ctx.readEnvToken) {
    // App-bound / daemon mode: read token from ~/.freshell/.env
    authToken = await ctx.readEnvToken(path.join(ctx.configDir, '.env'))
  }

  // Build the final URL with auth token
  const loadUrl = authToken ? `${serverUrl}?token=${authToken}` : serverUrl
  await window.loadURL(loadUrl)
  window.show()

  if (windowState.maximized) {
    window.maximize()
  }

  // 4. Save window state on move/resize (debounced to avoid excessive writes)
  let saveTimeout: ReturnType<typeof setTimeout> | undefined
  const saveState = () => {
    clearTimeout(saveTimeout)
    saveTimeout = setTimeout(() => {
      const bounds = window.getBounds?.()
      const maximized = window.isMaximized?.() ?? false
      if (bounds) {
        void ctx.windowStatePersistence.save({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          maximized,
        })
      }
    }, 500)
  }

  window.on('resize', saveState)
  window.on('move', saveState)

  // 5. Register global hotkey (quake-style toggle)
  ctx.hotkeyManager.register(desktopConfig.globalHotkey, () => {
    if (window.isVisible() && window.isFocused()) {
      window.hide()
    } else {
      window.show()
      window.focus()
    }
  })

  // 6. Create system tray (non-fatal — icon may be missing in unpackaged mode)
  try {
    ctx.createTray()
  } catch (err) {
    console.warn('Failed to create system tray:', err)
  }

  // 7. Schedule update check (10s delay)
  const updateCheckTimer = setTimeout(() => {
    void ctx.updateManager.checkForUpdates()
  }, 10_000)

  return { type: 'main', serverUrl, window, updateCheckTimer }
}

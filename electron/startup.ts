import path from 'path'
import { buildLocalProbeUrls, discoverLocalServers, normalizeServerUrl } from './launch-discovery.js'
import { chooseLaunchAction } from './launch-policy.js'
import { redactUrlForLog, type ElectronMainLogger } from './main-process-logger.js'
import { registerRendererRecovery, type RecoverableWebContents } from './renderer-recovery.js'
import { resolveCandidateToken } from './token-resolver.js'
import type { DesktopConfig, ForcedLaunch, LaunchServerCandidate } from './types.js'
import type { ServerSpawnResources, ServerSpawner } from './server-spawner.js'
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
  webContents?: RecoverableWebContents
}

export interface BrowserWindowConstructor {
  new (options: Record<string, any>): BrowserWindowLike
}

export interface StartupContext {
  desktopConfig: DesktopConfig
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
  fetchAuthenticated?: (url: string, token: string) => Promise<boolean>
  /** Read AUTH_TOKEN from the .env file in configDir. Returns undefined if not found. */
  readEnvToken?: (envPath: string) => Promise<string | undefined>
  discoverLaunchCandidates?: () => Promise<LaunchServerCandidate[]>
  mainProcessLogger?: ElectronMainLogger
  rendererRecoveryVerifier?: () => Promise<void>
  /**
   * An explicit chooser selection to honor for this launch. When set, startup
   * skips discovery and policy and performs exactly this action.
   */
  forcedLaunch?: ForcedLaunch
}

/**
 * Resolve the complete runtime contract passed to the Rust server. The Rust
 * process owns the HTTP server; the Electron process only supplies the paths
 * it needs for its optional Node-based sidecars and static client assets.
 */
export function resolveDesktopRuntimeResources(
  resourcesPath: string | undefined,
  platform: NodeJS.Platform,
  isDev: boolean,
  configDir: string,
): ServerSpawnResources {
  if (!path.isAbsolute(configDir)) {
    throw new Error('configDir must be an absolute path')
  }
  if (path.basename(path.normalize(configDir)) !== '.freshell') {
    throw new Error('configDir must end with .freshell')
  }

  const homeDir = path.dirname(configDir)
  const executable = platform === 'win32' ? 'freshell-server.exe' : 'freshell-server'
  const nodeExecutable = platform === 'win32' ? 'node.exe' : 'node'
  const repoRoot = path.resolve(process.cwd())

  if (isDev) {
    const sidecarNodeRuntime = process.env.FRESHELL_CLAUDE_NODE
      ?? process.env.npm_node_execpath
      ?? process.execPath
    return {
      serverBinary: path.join(repoRoot, 'target', 'debug', executable),
      clientDir: path.join(repoRoot, 'dist', 'client'),
      claudeNodeBinary: sidecarNodeRuntime,
      claudeSidecarEntry: process.env.FRESHELL_CLAUDE_SIDECAR
        ?? path.join(repoRoot, 'crates', 'freshell-claude-sidecar', 'index.mjs'),
      mcpNodeBinary: process.env.FRESHELL_MCP_NODE ?? sidecarNodeRuntime,
      mcpEntry: process.env.FRESHELL_MCP_ENTRY
        ?? path.join(repoRoot, 'dist', 'tools', 'freshell-mcp', 'server.js'),
      homeDir,
      configDir,
      logDir: path.join(configDir, 'logs'),
    }
  }

  if (!resourcesPath) {
    throw new Error('resourcesPath is required for production app-bound mode')
  }

  return {
    serverBinary: path.join(resourcesPath, 'bin', executable),
    clientDir: path.join(resourcesPath, 'client'),
    claudeNodeBinary: path.join(resourcesPath, 'node', 'bin', nodeExecutable),
    claudeSidecarEntry: path.join(resourcesPath, 'claude-sidecar', 'index.mjs'),
    mcpNodeBinary: path.join(resourcesPath, 'node', 'bin', nodeExecutable),
    mcpEntry: path.join(resourcesPath, 'mcp', 'server.js'),
    homeDir,
    configDir,
    logDir: path.join(configDir, 'logs'),
  }
}

export type StartupResult =
  | { type: 'wizard' }
  | { type: 'chooser'; candidates: LaunchServerCandidate[]; reason: string }
  | { type: 'main'; serverUrl: string; window: BrowserWindowLike; updateCheckTimer: ReturnType<typeof setTimeout> }

async function defaultDiscoverLaunchCandidates(ctx: StartupContext): Promise<LaunchServerCandidate[]> {
  const urls = buildLocalProbeUrls(ctx.desktopConfig)
  const candidates = await discoverLocalServers({ urls })
  return Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    token: await resolveCandidateToken({
      candidate,
      desktopConfig: ctx.desktopConfig,
      configDir: ctx.configDir,
    }),
  })))
}

async function checkRemoteReachable(ctx: StartupContext, remoteUrl: string): Promise<boolean> {
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

  try {
    return await fetchFn(`${normalizeServerUrl(remoteUrl)}/api/health`)
  } catch {
    return false
  }
}

async function checkRemoteAuthenticated(
  ctx: StartupContext,
  remoteUrl: string,
  token: string | undefined,
): Promise<boolean> {
  if (!token) return false

  const authCheck = ctx.fetchAuthenticated ?? (async (url: string, authToken: string) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(url, {
        headers: { 'x-auth-token': authToken },
        signal: controller.signal,
      })
      return response.ok
    } finally {
      clearTimeout(timer)
    }
  })

  try {
    return await authCheck(`${normalizeServerUrl(remoteUrl)}/api/settings`, token)
  } catch {
    return false
  }
}

function sanitizeStartupFallbackErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(
    /([?&]?(?:token|authorization|password|secret)=)[^\s&]+/gi,
    '[REDACTED]',
  )
}

async function loadMainWindow(
  ctx: StartupContext,
  serverUrl: string,
  authToken: string | undefined,
): Promise<Extract<StartupResult, { type: 'main' }>> {
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

  // Percent-encode the token: the renderer reads it back via URLSearchParams,
  // so a raw token containing +, &, #, or whitespace would otherwise be
  // corrupted and the app would load unauthenticated.
  const loadUrl = authToken ? `${serverUrl}?token=${encodeURIComponent(authToken)}` : serverUrl
  window.show()

  if (windowState.maximized) {
    window.maximize()
  }

  void window.loadURL(loadUrl).catch((err) => {
    if (ctx.mainProcessLogger) {
      ctx.mainProcessLogger.log({
        severity: 'error',
        event: 'main_window_initial_load_failed',
        serverUrl,
        loadUrl,
        error: err,
      })
      return
    }

    console.error(JSON.stringify({
      severity: 'error',
      component: 'electron-startup',
      event: 'main_window_initial_load_failed',
      serverUrl: redactUrlForLog(serverUrl),
      error: sanitizeStartupFallbackErrorMessage(err),
    }))
  })

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

  ctx.hotkeyManager.register(ctx.desktopConfig.globalHotkey, () => {
    if (window.isVisible() && window.isFocused()) {
      window.hide()
    } else {
      window.show()
      window.focus()
    }
  })

  try {
    ctx.createTray()
  } catch (err) {
    console.warn('Failed to create system tray:', err)
  }

  const updateCheckTimer = setTimeout(() => {
    void ctx.updateManager.checkForUpdates()
  }, 10_000)

  if (ctx.mainProcessLogger) {
    if (window.webContents) {
      registerRendererRecovery({
        window,
        loadUrl,
        serverUrl,
        logger: ctx.mainProcessLogger,
        verifyRecovered: ctx.rendererRecoveryVerifier,
        setTimeout,
        clearTimeout,
      })
    } else {
      ctx.mainProcessLogger.log({
        severity: 'warn',
        event: 'main_window_recovery_unavailable',
        serverUrl,
        loadUrl,
      })
    }
  }

  return { type: 'main', serverUrl, window, updateCheckTimer }
}

async function startAppBoundServer(ctx: StartupContext, port: number): Promise<string> {
  const resources = resolveDesktopRuntimeResources(
    ctx.resourcesPath,
    ctx.platform,
    ctx.isDev,
    ctx.configDir,
  )
  const authToken = ctx.readEnvToken
    ? await ctx.readEnvToken(path.join(resources.configDir, '.env'))
    : undefined
  await ctx.serverSpawner.start({
    resources,
    port,
    authToken,
  })
  return `http://localhost:${port}`
}

/**
 * Perform exactly the action the user selected in the chooser, bypassing
 * discovery and policy. This is what makes a chooser selection authoritative
 * for the launch regardless of `alwaysAskOnLaunch` or detected servers.
 */
async function executeForcedLaunch(ctx: StartupContext, forced: ForcedLaunch): Promise<StartupResult> {
  if (forced.kind === 'connect') {
    return loadMainWindow(ctx, normalizeServerUrl(forced.url), forced.token)
  }

  // start-local: spawn a fresh bundled server on the chosen port. Its auth
  // token comes from the local .env, never from a saved remote token.
  const serverUrl = await startAppBoundServer(ctx, forced.port)
  const authToken = ctx.readEnvToken
    ? await ctx.readEnvToken(path.join(ctx.configDir, '.env'))
    : undefined
  return loadMainWindow(ctx, serverUrl, authToken)
}

export async function runStartup(ctx: StartupContext): Promise<StartupResult> {
  const { desktopConfig, port } = ctx

  if (!desktopConfig.setupCompleted) {
    return { type: 'wizard' }
  }

  if (ctx.forcedLaunch) {
    return executeForcedLaunch(ctx, ctx.forcedLaunch)
  }

  const discoverCandidates = ctx.discoverLaunchCandidates ?? (() => defaultDiscoverLaunchCandidates(ctx))
  const candidates = await discoverCandidates()
  const savedRemoteReachable = desktopConfig.serverMode === 'remote' && !!desktopConfig.remoteUrl
    ? await checkRemoteReachable(ctx, desktopConfig.remoteUrl)
    : false
  const savedRemoteAuthenticated = desktopConfig.serverMode === 'remote' && !!desktopConfig.remoteUrl && savedRemoteReachable
    ? await checkRemoteAuthenticated(ctx, desktopConfig.remoteUrl, desktopConfig.remoteToken)
    : undefined
  const launchAction = chooseLaunchAction({
    desktopConfig,
    candidates,
    savedRemoteReachable,
    savedRemoteAuthenticated,
  })

  if (launchAction.type === 'show-setup') {
    return { type: 'wizard' }
  }

  if (launchAction.type === 'show-chooser') {
    return {
      type: 'chooser',
      candidates: launchAction.candidates,
      reason: launchAction.reason,
    }
  }

  if (launchAction.type === 'auto-connect') {
    return loadMainWindow(ctx, launchAction.candidate.url, launchAction.candidate.token)
  }

  let serverUrl: string

  switch (desktopConfig.serverMode) {
    case 'app-bound': {
      serverUrl = await startAppBoundServer(ctx, port)
      break
    }
    case 'remote': {
      const remoteUrl = desktopConfig.remoteUrl
      if (!remoteUrl) {
        return { type: 'chooser', candidates, reason: 'manual-choice' }
      }
      serverUrl = remoteUrl
      break
    }
    default:
      throw new Error(`Unknown server mode: ${desktopConfig.serverMode}`)
  }

  let authToken: string | undefined

  if (desktopConfig.serverMode === 'remote') {
    authToken = desktopConfig.remoteToken
  } else if (ctx.readEnvToken) {
    authToken = await ctx.readEnvToken(path.join(ctx.configDir, '.env'))
  }

  return loadMainWindow(ctx, serverUrl, authToken)
}

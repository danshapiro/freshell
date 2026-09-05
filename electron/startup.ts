import path from 'path'
import fsp from 'fs/promises'
import { DEFAULT_PROFILE_ID } from './profile.js'
import { buildLocalProbeUrls, discoverLocalServers, normalizeServerUrl } from './launch-discovery.js'
import { chooseLaunchAction } from './launch-policy.js'
import { redactUrlForLog, type ElectronMainLogger } from './main-process-logger.js'
import { registerRendererRecovery, type RecoverableWebContents } from './renderer-recovery.js'
import { resolveCandidateToken } from './token-resolver.js'
import type { DesktopConfig, ForcedLaunch, LaunchServerCandidate } from './types.js'
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
  webContents?: RecoverableWebContents
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
  /** Active profile id; named profiles own their app-bound server (see
   *  launch-policy.ts). Defaults to DEFAULT_PROFILE_ID. */
  profileId?: string
  /**
   * Canonical server-ownership gate for this boot: true for every named
   * profile AND for the default profile once any named profile exists in the
   * registry (multi-profile installs treat Default as one more tenant). Owned
   * boots skip discovery-based auto-connect (never adopt a neighbor server)
   * and auto-bump a busy port on app-bound starts. entry.ts computes this at
   * module top. When absent, the fallback is "named profile only", for older
   * call sites.
   */
  ownsServer?: boolean
  /** Port availability probe (entry.ts wires the production check). When
   *  provided AND this boot owns its server AND app-bound, a busy
   *  desktopConfig.port is first probed for SAME-PROFILE identity (see
   *  fetchServerInstanceId) and reused when the resident server belongs to
   *  this config dir; otherwise auto-bumped to the next free port (and
   *  persisted). */
  isPortAvailable?: (port: number) => Promise<boolean>
  /** Fetch the unauthenticated /api/health payload's instanceId (entry wires
   *  http). Used to distinguish "my own config dir's server" from a neighbor. */
  fetchServerInstanceId?: (url: string) => Promise<string | undefined>
  /** Persist a changed default port for named profiles (config-dir scoped). */
  patchDesktopConfig?: (patch: { port?: number }) => Promise<unknown>
}

export type StartupResult =
  | { type: 'wizard' }
  | { type: 'chooser'; candidates: LaunchServerCandidate[]; reason: string }
  | { type: 'main'; serverUrl: string; window: BrowserWindowLike; attached?: boolean; updateCheckTimer: ReturnType<typeof setTimeout> }

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

  const hotkeyRegistered = ctx.hotkeyManager.register(ctx.desktopConfig.globalHotkey, () => {
    if (window.isVisible() && window.isFocused()) {
      window.hide()
    } else {
      window.show()
      window.focus()
    }
  })
  if (!hotkeyRegistered) {
    ctx.mainProcessLogger?.log({
      severity: 'warn',
      event: 'global_hotkey_registration_failed',
      accelerator: ctx.desktopConfig.globalHotkey,
    })
  }

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
  if (ctx.isDev) {
    await ctx.serverSpawner.start({
      spawn: {
        mode: 'dev',
        tsxPath: 'npx',
        serverSourceEntry: 'server/index.ts',
      },
      port,
      envFile: path.join(ctx.configDir, '.env'),
      configDir: ctx.configDir,
      // Same pinning contract as the production branch below — dev spawns of
      // named profiles must not fall back to the default config dir.
      pinProfileConfigDir: ctx.profileId !== undefined && ctx.profileId !== DEFAULT_PROFILE_ID,
    })
    return 'http://localhost:5173'
  }

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
    pinProfileConfigDir: ctx.profileId !== undefined && ctx.profileId !== DEFAULT_PROFILE_ID,
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

/**
 * Read the server instance-id file for this config dir. The (Node) server
 * anchors `<configDir>/instance-id`; a missing/corrupt file just means the
 * resident server cannot be proven ours.
 */
async function readInstanceIdFile(configDir: string): Promise<string | undefined> {
  try {
    const raw = await fsp.readFile(path.join(configDir, 'instance-id'), 'utf-8')
    return raw.trim() || undefined
  } catch {
    return undefined
  }
}

export async function runStartup(ctx: StartupContext): Promise<StartupResult> {
  const { desktopConfig, port } = ctx

  if (!desktopConfig.setupCompleted) {
    return { type: 'wizard' }
  }

  if (ctx.forcedLaunch) {
    return executeForcedLaunch(ctx, ctx.forcedLaunch)
  }

  // One canonical ownership decision for the whole boot: three consumers below
  // read it (discovery skip, launch policy, port auto-bump).
  const ownsServerNow =
    ctx.ownsServer ?? (ctx.profileId !== undefined && ctx.profileId !== DEFAULT_PROFILE_ID)

  const discoverCandidates = ctx.discoverLaunchCandidates ?? (() => defaultDiscoverLaunchCandidates(ctx))
  // A named profile's app-bound/daemon boot owns its server; discovery is
  // skipped entirely so a neighbor profile's server is never surfaced.
  // Owning boots skip the discovery probe UNLESS the user opted into
  // always-ask: an always-ask boot shows the chooser with the real candidate
  // list (never auto-connects — chooseLaunchAction checks ownsServer first).
  const skipDiscovery =
    ownsServerNow &&
    !desktopConfig.alwaysAskOnLaunch &&
    (desktopConfig.serverMode === 'app-bound' || desktopConfig.serverMode === 'daemon')
  const candidates = skipDiscovery ? [] : await discoverCandidates()
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
    ownsServer: ownsServerNow,
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

  // True when startup adopted an already-running resident server that proved
  // it owns this profile's config dir (tray status reads it as "running").
  let attachedToOwnResidentServer = false
  switch (desktopConfig.serverMode) {
    case 'daemon': {
      if (ctx.profileId !== undefined && ctx.profileId !== DEFAULT_PROFILE_ID) {
        // Daemon mode is machine-global per README: profiles share one daemon,
        // and its port is the install-time default-profile port, NOT the named
        // profile's (possibly auto-bumped) one. Rather than deriving a fragile
        // port, refuse daemon mode on named profiles and let the user pick.
        ctx.mainProcessLogger?.log({
          severity: 'warn',
          event: 'named_profile_daemon_unsupported',
          profileId: ctx.profileId,
        })
        return { type: 'chooser', candidates, reason: 'manual-choice' }
      }
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
      let launchPort = port
      let attachedOwnServer = false
      if (ownsServerNow && ctx.isPortAvailable && !(await ctx.isPortAvailable(port))) {
        // The profile's configured port is already held. Before bumping, check
        // whether the resident server BELONGS to this profile (it anchors its
        // identity at <configDir>/instance-id): a restarted/crashed-orphaned
        // app-bound server of THIS profile, or the self-hosted server over the
        // same state dir, must get attached — bumping would double-spawn over
        // the same state.
        const candidateUrl = `http://localhost:${port}`
        const localInstanceId = await readInstanceIdFile(ctx.configDir)
        const residentId = ctx.fetchServerInstanceId
          ? await ctx.fetchServerInstanceId(candidateUrl)
          : undefined
        const residentIsOurs =
          residentId !== undefined && localInstanceId !== undefined && residentId === localInstanceId

        if (residentIsOurs) {
          ctx.mainProcessLogger?.log({
            severity: 'info',
            event: 'profile_attached_own_server',
            profileId: ctx.profileId,
            port,
          })
          attachedOwnServer = true
          attachedToOwnResidentServer = true
        } else {
          // The resident server is NOT ours: bump to the next free port rather
          // than spawning a doomed server whose health check would succeed
          // against the OTHER instance (/api/health is unauthenticated).
          let chosen = -1
          for (let candidate = port + 1; candidate <= Math.min(port + 200, 65535); candidate++) {
            if (await ctx.isPortAvailable(candidate)) {
              chosen = candidate
              break
            }
          }
          if (chosen !== -1) {
            launchPort = chosen
            ctx.mainProcessLogger?.log({
              severity: 'info',
              event: 'profile_port_reassigned',
              profileId: ctx.profileId,
              from: port,
              to: chosen,
            })
            try {
              await ctx.patchDesktopConfig?.({ port: chosen })
            } catch (err) {
              ctx.mainProcessLogger?.log({
                severity: 'warn',
                event: 'profile_port_persist_failed',
                error: err instanceof Error ? err.message : String(err),
              })
            }
          } else {
            // Never land on the knowably-busy port: the unauthenticated
            // /api/health on the NEIGHBOR's server would satisfy the health
            // probe and the window would load the wrong identity. Leave the
            // decision to the user instead of spawning into a black hole.
            ctx.mainProcessLogger?.log({
              severity: 'warn',
              event: 'profile_port_scan_exhausted',
              profileId: ctx.profileId,
              port,
            })
            return { type: 'chooser', candidates, reason: 'manual-choice' }
          }
        }
      }
      if (launchPort !== port) {
        // Keep the in-memory desktopConfig in step so other consumers
        // (e.g. the chooser's getCurrentPort) see the effective port.
        desktopConfig.port = launchPort
      }
      if (attachedOwnServer) {
        // Reuse — never spawn a second server over this profile's state dir.
        serverUrl = `http://localhost:${launchPort}`
      } else {
        serverUrl = await startAppBoundServer(ctx, launchPort)
      }
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
    // App-bound and daemon mode anchor the token at THIS boot's config dir —
    // daemon mode is machine-global and only reachable from the default
    // profile (the named-daemon path returns before this point).
    authToken = await ctx.readEnvToken(path.join(ctx.configDir, '.env'))
  }

  const mainResult = await loadMainWindow(ctx, serverUrl, authToken)
  if (attachedToOwnResidentServer) mainResult.attached = true
  return mainResult
}

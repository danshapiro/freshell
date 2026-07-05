import { createFreshAgentExtrasRouter } from './fresh-agent-extras-router.js'
import { detectLanIpsAsync } from './bootstrap.js' // Must be first - ensures .env exists before dotenv loads
import 'dotenv/config'
import express from 'express'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import cookieParser from 'cookie-parser'
import rateLimit from 'express-rate-limit'
import chokidar from 'chokidar'
import { logger, resolveRuntimeLogLevel, setLogLevel } from './logger.js'
import { requestLogger } from './request-logger.js'
import { validateStartupSecurity, httpAuthMiddleware } from './auth.js'
import { configStore } from './config-store.js'
import { AI_CONFIG } from './ai-prompts.js'
import { getFreshellConfigDir } from './freshell-home.js'
import { TerminalRegistry, type TerminalRecord, registerCodingCliCommands, type CodingCliCommandSpec } from './terminal-registry.js'
import { WsHandler } from './ws-handler.js'
import { SessionsSyncService } from './sessions-sync/service.js'
import { CodingCliSessionIndexer } from './coding-cli/session-indexer.js'
import { CodingCliSessionManager } from './coding-cli/session-manager.js'
import { wireCodexActivityTracker } from './coding-cli/codex-activity-wiring.js'
import { wireClaudeActivityTracker } from './coding-cli/claude-activity-wiring.js'
import { wireAmplifierActivityTracker } from './coding-cli/amplifier-activity-wiring.js'
import { createOpencodeActivityIntegration } from './coding-cli/opencode-activity-integration.js'
import { claudeProvider } from './coding-cli/providers/claude.js'
import { codexProvider } from './coding-cli/providers/codex.js'
import { opencodeProvider } from './coding-cli/providers/opencode.js'
import { amplifierProvider } from './coding-cli/providers/amplifier.js'
import { overrideKeysToClear } from './coding-cli/provider-title-cleanup.js'
import type { CodingCliProvider } from './coding-cli/provider.js'
import { makeSessionKey, type CodingCliProviderName, type CodingCliSession } from './coding-cli/types.js'
import { computeSessionTitleSync } from './auto-title.js'
import { generateAiSessionTitle } from './ai-title.js'
import { TerminalMetadataService } from './terminal-metadata-service.js'
import { migrateLegacyDefaultEnabledProviders, migrateSettingsSortMode } from './settings-migrate.js'
import { createFilesRouter } from './files-router.js'
import { createPlatformRouter, detectFeatureFlags } from './platform-router.js'
import { createProxyRouter, attachProxyUpgradeHandler } from './proxy-router.js'
import { createLocalFileRouter } from './local-file-router.js'
import { createTerminalsRouter } from './terminals-router.js'
import { createProjectColorsRouter } from './project-colors-router.js'
import { createSessionsRouter } from './sessions-router.js'
import { createNetworkRouter } from './network-router.js'
import { getSessionRepairService } from './session-scanner/service.js'
import { SdkBridge } from './sdk-bridge.js'
import { createClientLogsRouter } from './client-logs.js'
import { createStartupState } from './startup-state.js'
import { getPerfConfig, initPerfLogging, setPerfLoggingEnabled, withPerfSpan } from './perf-logger.js'
import { detectPlatform, detectAvailableClis, detectHostName, type CliDetectionSpec } from './platform.js'
import { resolveVisitPort } from './startup-url.js'
import { NetworkManager } from './network-manager.js'
import { getNetworkHost } from './get-network-host.js'
import { PortForwardManager } from './port-forward.js'
import { parseTrustProxyEnv } from './request-ip.js'
import { createTabsRegistryStore } from './tabs-registry/store.js'
import { createTabsSyncRouter } from './tabs-registry/client-retire-router.js'
import { checkForUpdate, createCachedUpdateChecker } from './updater/version-checker.js'
import { SessionAssociationCoordinator } from './session-association-coordinator.js'
import { broadcastTerminalSessionAssociation } from './session-association-broadcast.js'
import { collectAppliedSessionAssociations } from './session-association-updates.js'
import { loadOrCreateServerInstanceId } from './instance-id.js'
import { createFreshAgentModelCapabilitiesRouter } from './fresh-agent/model-capabilities-router.js'
import { FreshAgentModelCapabilityRegistry } from './fresh-agent/model-capability-registry.js'
import { createSettingsRouter } from './settings-router.js'
import { createPerfRouter } from './perf-router.js'
import { createAiRouter } from './ai-router.js'
import { createDebugRouter } from './debug-router.js'
import { LayoutStore } from './agent-api/layout-store.js'
import { createAgentApiRouter } from './agent-api/router.js'
import { ExtensionManager } from './extension-manager.js'
import { createExtensionRouter } from './extension-routes.js'
import { createServerInfoRouter } from './server-info-router.js'
import { SessionMetadataStore } from './session-metadata-store.js'
import { createShellBootstrapRouter } from './shell-bootstrap-router.js'
import { createHealthRouter } from './health-router.js'
import { loadSessionHistory } from './session-history-loader.js'
import { SessionContentCache } from './session-content-cache.js'
import { createClaudeFreshAgentHistorySource } from './fresh-agent/history/claude/history-source.js'
import { createTerminalViewService } from './terminal-view/service.js'
import { resolveStartupBanner } from './startup-banner.js'
import { createFreshAgentProviderRegistry } from './fresh-agent/provider-registry.js'
import { FreshAgentRuntimeManager } from './fresh-agent/runtime-manager.js'
import { registerFreshAgentThreadRoutes } from './fresh-agent/register-routes.js'
import { createFreshAgentSnapshotRateLimitMiddleware } from './fresh-agent/observability.js'
import { createClaudeFreshAgentAdapter } from './fresh-agent/adapters/claude/adapter.js'
import { createCodexFreshAgentAdapter } from './fresh-agent/adapters/codex/adapter.js'
import { createOpencodeFreshAgentAdapter } from './fresh-agent/adapters/opencode/adapter.js'
import { OpencodeServeManager } from './fresh-agent/adapters/opencode/serve-manager.js'
import {
  CodexAppServerRuntime,
  runCodexStartupReaper,
} from './coding-cli/codex-app-server/runtime.js'
import { CodexLaunchPlanner } from './coding-cli/codex-app-server/launch-planner.js'
import { registerStaticClientRoutes } from './static-client-routes.js'
import { joinCodexShutdownOwners } from './shutdown-join.js'

function compileArgTemplate(
  template: string[] | undefined,
  placeholder: string,
): ((value: string) => string[]) | undefined {
  if (!template) return undefined
  return (value: string) => template.map((arg) => arg.replaceAll(placeholder, value))
}

// Build the CLI spawn table from CLI-category extension manifests.
// Pure over the manager's current registry; used at startup and by the dev
// hot-reload watcher to hot-swap the spawn table without a restart.
function buildCliCommandsMap(extensionManager: ExtensionManager): Map<string, CodingCliCommandSpec> {
  const cliCommandsMap = new Map<string, CodingCliCommandSpec>()
  for (const ext of extensionManager.getAll()) {
    if (ext.manifest.category !== 'cli' || !ext.manifest.cli) continue
    const cli = ext.manifest.cli
    const spec: CodingCliCommandSpec = {
      label: ext.manifest.label,
      envVar: cli.envVar || '',
      defaultCommand: cli.command,
      args: cli.args,
      env: cli.env,
      modelArgs: compileArgTemplate(cli.modelArgs, '{{model}}'),
      sandboxArgs: compileArgTemplate(cli.sandboxArgs, '{{sandbox}}'),
      permissionModeArgs: compileArgTemplate(cli.permissionModeArgs, '{{permissionMode}}'),
      createSessionArgs: compileArgTemplate(cli.createSessionArgs, '{{sessionId}}'),
      permissionModeEnvVar: cli.permissionModeEnvVar,
      permissionModeEnvValues: cli.permissionModeValues,
    }
    if (cli.resumeArgs) {
      const template = cli.resumeArgs
      spec.resumeArgs = (sessionId: string) =>
        template.map(arg => arg.replace('{{sessionId}}', sessionId))
    }
    cliCommandsMap.set(ext.manifest.name, spec)
  }
  return cliCommandsMap
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Find package.json by walking up from current directory
function findPackageJson(): string {
  let dir = __dirname
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, 'package.json')
    if (fs.existsSync(candidate)) {
      return candidate
    }
    dir = path.dirname(dir)
  }
  throw new Error('Could not find package.json')
}

const packageJson = JSON.parse(fs.readFileSync(findPackageJson(), 'utf-8'))
const APP_VERSION: string = packageJson.version
const SERVER_STARTED_AT = Date.now()
const log = logger.child({ component: 'server' })
const perfConfig = getPerfConfig()

// Max age difference (ms) between a session's lastActivityAt and a terminal's createdAt
// for association to be considered valid. Prevents binding to stale sessions
// from previous server runs.
const ASSOCIATION_MAX_AGE_MS = 30_000

async function main() {
  validateStartupSecurity()

  initPerfLogging()

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', parseTrustProxyEnv(process.env.FRESHELL_TRUST_PROXY))

  app.use(express.json({ limit: '1mb' }))
  app.use(requestLogger)

  // --- Local file serving for browser pane (cookie auth for iframes) ---
  app.use('/local-file', createLocalFileRouter())

  const startupState = createStartupState()
  const serverInstanceId = await loadOrCreateServerInstanceId()

  // Health check endpoint (no auth required - used by precheck script)
  app.use('/api/health', createHealthRouter({
    appVersion: APP_VERSION,
    instanceId: serverInstanceId,
    isReady: () => startupState.isReady(),
    startedAt: new Date(SERVER_STARTED_AT),
  }))

  // Fresh-agent snapshot rate-limit observability (registered before the
  // global rate limiter so 429s on snapshot routes are captured with
  // semantic metadata: sessionType, provider, threadIdHash).
  app.use('/api/fresh-agent/threads', createFreshAgentSnapshotRateLimitMiddleware())

  // Basic rate limiting for /api
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  )

  app.use(cookieParser())
  app.use('/api', httpAuthMiddleware)
  // Shell bootstrap route: returns shell-critical first-paint data only
  app.use('/api', createShellBootstrapRouter({
    getSettings: async () => configStore.getSettings(),
    getLegacyLocalSettingsSeed: async () => configStore.getLegacyLocalSettingsSeed(),
    getPlatform: async () => {
      const [platform, availableClis, hostName] = await Promise.all([
        detectPlatform(),
        detectAvailableClis(cliDetectionSpecs),
        detectHostName(),
      ])
      return {
        platform,
        availableClis,
        hostName,
        featureFlags: detectFeatureFlags(),
      }
    },
    getShellTaskStatus: async () => startupState.snapshot().tasks,
    getPerfLogging: () => perfConfig.enabled,
    getConfigFallback: async () => {
      const readError = configStore.getLastReadError()
      if (!readError) return undefined
      return { reason: readError, backupExists: await configStore.backupExists() }
    },
  }))
  app.use('/api', createClientLogsRouter())

  const codingCliProviders: CodingCliProvider[] = [claudeProvider, codexProvider, opencodeProvider, amplifierProvider]
  const freshellConfigDir = getFreshellConfigDir()
  const sessionMetadataStore = new SessionMetadataStore(freshellConfigDir)
  const codingCliIndexer = new CodingCliSessionIndexer(codingCliProviders, {}, sessionMetadataStore)
  const codingCliSessionManager = new CodingCliSessionManager(codingCliProviders)
  const tabsRegistryStore = await createTabsRegistryStore()
  app.use('/api/tabs-sync', createTabsSyncRouter({ tabsRegistryStore }))

  const settings = migrateSettingsSortMode(await configStore.getSettings())
  AI_CONFIG.applySettingsKey(settings.ai?.geminiApiKey)
  const registry = new TerminalRegistry(settings)
  const terminalMetadata = new TerminalMetadataService()
  const layoutStore = new LayoutStore()
  const codexActivity = wireCodexActivityTracker({ registry, codingCliIndexer })
  const claudeActivity = wireClaudeActivityTracker({ registry })
  const amplifierActivity = wireAmplifierActivityTracker({ registry })
  const opencodeActivity = createOpencodeActivityIntegration({ registry, opencodeProvider })

  const sessionRepairService = getSessionRepairService({ skipDiscovery: true })
  await runCodexStartupReaper({ serverInstanceId })
  const freshAgentModelCapabilityRegistry = new FreshAgentModelCapabilityRegistry()

  let sdkBridge: SdkBridge

  const extensionManager = new ExtensionManager()
  const userExtDir = path.join(freshellConfigDir, 'extensions')
  const localExtDir = path.join(process.cwd(), '.freshell', 'extensions')
  const builtinExtDir = path.join(process.cwd(), 'extensions')
  extensionManager.scan([userExtDir, localExtDir, builtinExtDir])

  // Build CLI commands from extension manifests
  registerCodingCliCommands(buildCliCommandsMap(extensionManager))

  // Build CLI detection specs from extension manifests
  const cliDetectionSpecs: CliDetectionSpec[] = extensionManager.getAll()
    .filter(e => e.manifest.category === 'cli' && e.manifest.cli)
    .map(e => ({
      name: e.manifest.name,
      envVar: e.manifest.cli!.envVar || '',
      defaultCmd: e.manifest.cli!.command,
    }))

  // Collect all CLI extension names for settings validation
  const allCliNames = extensionManager.getAll()
    .filter(e => e.manifest.category === 'cli')
    .map(e => e.manifest.name)

  // Auto-enable newly-discovered CLI extensions
  {
    const currentSettings = await configStore.getSettings()
    const migratedSettings = migrateLegacyDefaultEnabledProviders(currentSettings, allCliNames)
    const migratedLegacyDefaults = migratedSettings !== currentSettings
    const hasKnownProviders = migratedSettings.codingCli?.knownProviders !== undefined
    const knownProviders: string[] = migratedSettings.codingCli?.knownProviders ?? []
    const enabledProviders: string[] = migratedSettings.codingCli?.enabledProviders ?? []

    if (!hasKnownProviders) {
      // MIGRATION: First run after refactor. Seed knownProviders with ALL registered CLI names
      // so nothing is treated as "new". Preserves the user's existing enabledProviders as-is.
      const codingCliPatch: Record<string, string[]> = { knownProviders: allCliNames }
      if (migratedLegacyDefaults) {
        codingCliPatch.enabledProviders = enabledProviders
      }
      await configStore.patchSettings({ codingCli: codingCliPatch })
    } else {
      // NORMAL: Auto-enable truly new extensions (added after migration).
      const newProviders = allCliNames.filter(name => !knownProviders.includes(name))
      if (newProviders.length > 0 || migratedLegacyDefaults) {
        await configStore.patchSettings({
          codingCli: {
            knownProviders: newProviders.length > 0 ? [...knownProviders, ...newProviders] : knownProviders,
            enabledProviders: [...enabledProviders, ...newProviders.filter((name) => !enabledProviders.includes(name))],
          },
        })
      }
    }
  }

  // Shared parsed content cache for .jsonl session files.
  const sessionContentCache = new SessionContentCache()

  const loadSessionHistoryWithCache = (sessionId: string) =>
    loadSessionHistory(sessionId, undefined, {
      resolveFilePath: (id) => codingCliIndexer.getFilePathForSession(id),
      contentCache: sessionContentCache,
    })
  const agentHistorySource = createClaudeFreshAgentHistorySource({
    loadSessionHistory: loadSessionHistoryWithCache,
    getLiveSessionBySdkSessionId: (sdkSessionId) => sdkBridge.getLiveSession(sdkSessionId),
    getLiveSessionByCliSessionId: (timelineSessionId) => sdkBridge.findLiveSessionByCliSessionId(timelineSessionId),
  })
  sdkBridge = new SdkBridge(agentHistorySource)

  const server = http.createServer(app)
  const claudeFreshAgentAdapter = createClaudeFreshAgentAdapter({
    sdkBridge,
    agentHistorySource,
  })
  const codexDisplayIdSecret = await configStore.getCodexDisplayIdSecret()
  const codexFreshAgentAdapter = createCodexFreshAgentAdapter({
    displayIdSecret: codexDisplayIdSecret,
    runtimeFactory: () => new CodexAppServerRuntime({ serverInstanceId }),
  })
  const opencodeServeManager = new OpencodeServeManager()
  const opencodeFreshAgentAdapter = createOpencodeFreshAgentAdapter({ serveManager: opencodeServeManager })
  const codexFreshAgentRuntime = {
    shutdown: async () => {
      await codexFreshAgentAdapter.shutdown?.()
      await opencodeFreshAgentAdapter.shutdown?.()
    },
  }
  const freshAgentRuntimeManager = new FreshAgentRuntimeManager({
    registry: createFreshAgentProviderRegistry([
      {
        sessionType: 'freshclaude',
        runtimeProvider: 'claude',
        adapter: claudeFreshAgentAdapter,
      },
      {
        sessionType: 'kilroy',
        runtimeProvider: 'claude',
        adapter: claudeFreshAgentAdapter,
      },
      {
        sessionType: 'freshcodex',
        runtimeProvider: 'codex',
        adapter: codexFreshAgentAdapter,
      },
      {
        sessionType: 'freshopencode',
        runtimeProvider: 'opencode',
        adapter: opencodeFreshAgentAdapter,
      },
    ]),
  })
  const codexLaunchPlanner = new CodexLaunchPlanner(() => new CodexAppServerRuntime({ serverInstanceId }))
  const wsHandler = new WsHandler(
    server,
    registry,
    {
      codingCliManager: codingCliSessionManager,
      codexLaunchPlanner,
      sdkBridge,
      freshAgentRuntimeManager,
      sessionRepairService,
      handshakeSnapshotProvider: async () => {
        const currentSettings = migrateSettingsSortMode(await configStore.getSettings())
        const readError = configStore.getLastReadError()
        const configFallback = readError
          ? { reason: readError, backupExists: await configStore.backupExists() }
          : undefined
        return {
          settings: currentSettings,
          projects: codingCliIndexer.getProjects(),
          perfLogging: perfConfig.enabled,
          configFallback,
        }
      },
      terminalMetaListProvider: () => terminalMetadata.list(),
      tabsRegistryStore,
      serverInstanceId,
      layoutStore,
      extensionManager,
      codexActivityListProvider: () => codexActivity.tracker.list(),
      codexLatestTurnCompletionsProvider: () => codexActivity.tracker.listLatestCompletions(),
      claudeActivityListProvider: () => claudeActivity.tracker.list(),
      claudeLatestTurnCompletionsProvider: () => claudeActivity.tracker.listLatestCompletions(),
      amplifierActivityListProvider: () => amplifierActivity.tracker.list(),
      amplifierLatestTurnCompletionsProvider: () => amplifierActivity.tracker.listLatestCompletions(),
      agentHistorySource,
      opencodeActivityListProvider: () => opencodeActivity.tracker.list(),
      opencodeLatestTurnCompletionsProvider: () => opencodeActivity.tracker.listLatestCompletions(),
    },
  )
  attachProxyUpgradeHandler(server)
  const port = Number(process.env.PORT || 3001)
  const isCompiledBuild = __dirname.endsWith(path.join('dist', 'server'))
  const isDev = !isCompiledBuild && process.env.NODE_ENV !== 'production'
  const vitePort = isDev ? Number(process.env.VITE_PORT || 5173) : undefined
  const networkManager = new NetworkManager(server, configStore, port, isDev, vitePort)
  networkManager.setWsHandler(wsHandler)
  let terminalCreateAdmissionOpen = true
  const assertTerminalCreateAccepted = () => {
    if (!terminalCreateAdmissionOpen) {
      throw new Error('Server is shutting down; terminal creation is not accepted.')
    }
  }
  app.use('/api', createAgentApiRouter({
    layoutStore,
    registry,
    wsHandler,
    configStore,
    terminalMetadata,
    codingCliIndexer,
    codexActivityTracker: codexActivity.tracker,
    codexLaunchPlanner,
    assertTerminalCreateAccepted,
    freshAgentRuntimeManager,
  }))
  registerFreshAgentThreadRoutes(app, {
    runtimeManager: freshAgentRuntimeManager,
  })

  // --- Extension lifecycle broadcasts ---
  extensionManager.on('server.starting', ({ name }: { name: string }) => {
    wsHandler.broadcast({ type: 'extension.server.starting', name })
  })
  extensionManager.on('server.ready', ({ name, port: extPort }: { name: string; port: number }) => {
    wsHandler.broadcast({ type: 'extension.server.ready', name, port: extPort })
  })
  extensionManager.on('server.stopped', ({ name }: { name: string }) => {
    wsHandler.broadcast({ type: 'extension.server.stopped', name })
  })
  extensionManager.on('server.error', ({ name, error }: { name: string; error: string }) => {
    wsHandler.broadcast({ type: 'extension.server.error', name, error })
  })

  // DEV ONLY: hot-reload extension manifests. Watches the three extension dirs
  // for freshell.json changes and live re-scans — refreshing the CLI spawn
  // table, the WS mode validator, and the client registry — WITHOUT dropping
  // panes or requiring a page reload. Gated by isDev so prod never builds it.
  let extWatcher: chokidar.FSWatcher | undefined
  if (isDev) {
    const reloadExtensions = () => {
      try {
        // scan() clears the registry first, so this is a full re-scan.
        extensionManager.scan([userExtDir, localExtDir, builtinExtDir])
        const cliCommandsMap = buildCliCommandsMap(extensionManager)
        registerCodingCliCommands(cliCommandsMap)
        wsHandler.refreshExtensionModes()
        wsHandler.broadcast({
          type: 'extensions.registry',
          extensions: extensionManager.toClientRegistry(),
        })
        console.log(`[dev] reloaded extensions (${cliCommandsMap.size} cli)`)
      } catch (err) {
        // A malformed manifest must not crash the dev server.
        logger.warn({ err }, '[dev] extension reload failed')
      }
    }

    let reloadTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleReload = () => {
      if (reloadTimer) clearTimeout(reloadTimer)
      reloadTimer = setTimeout(reloadExtensions, 300)
    }

    // Watch the extension DIRS (not a file glob) so both manifest edits and
    // whole-dir add/remove (e.g. `rm -rf extensions/foo`) reliably re-scan.
    const extDirs = [userExtDir, localExtDir, builtinExtDir]
    const onFileEvent = (changed: string) => {
      if (changed.endsWith('freshell.json')) scheduleReload()
    }
    extWatcher = chokidar.watch(extDirs, {
      ignoreInitial: true,
      depth: 3,
      ignored: /(^|[/\\])node_modules([/\\]|$)/,
    })
    extWatcher.on('add', onFileEvent)
    extWatcher.on('change', onFileEvent)
    extWatcher.on('unlink', onFileEvent)
    extWatcher.on('unlinkDir', scheduleReload)
    extWatcher.on('error', (err) => logger.warn({ err }, '[dev] extension watcher error'))
    // console.log (not pino) so the notice is visible in the dev terminal.
    console.log(`[dev] hot-reloading extension manifests under: ${extDirs.join(', ')}`)
  }

  const sessionsSync = new SessionsSyncService(wsHandler)
  const associationCoordinator = new SessionAssociationCoordinator(registry, ASSOCIATION_MAX_AGE_MS)

  codexActivity.tracker.on('changed', (payload) => {
    wsHandler.broadcastCodexActivityUpdated(payload)
  })
  codexActivity.tracker.on('turn.complete', (payload) => {
    wsHandler.broadcastTerminalTurnComplete({
      provider: 'codex',
      terminalId: payload.terminalId,
      at: payload.at,
      completionSeq: payload.completionSeq,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    })
  })
  claudeActivity.tracker.on('changed', (payload) => {
    wsHandler.broadcastClaudeActivityUpdated(payload)
  })
  opencodeActivity.tracker.on('changed', (payload) => {
    wsHandler.broadcastOpencodeActivityUpdated(payload)
  })
  opencodeActivity.tracker.on('turn.complete', (payload) => {
    wsHandler.broadcastTerminalTurnComplete({
      provider: 'opencode',
      ...payload,
    })
  })
  claudeActivity.tracker.on('turn.complete', (payload) => {
    wsHandler.broadcastTerminalTurnComplete({
      provider: 'claude',
      terminalId: payload.terminalId,
      at: payload.at,
      completionSeq: payload.completionSeq,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    })
  })
  amplifierActivity.tracker.on('changed', (payload) => {
    wsHandler.broadcastAmplifierActivityUpdated(payload)
  })
  amplifierActivity.tracker.on('turn.complete', (payload) => {
    wsHandler.broadcastTerminalTurnComplete({
      provider: 'amplifier',
      terminalId: payload.terminalId,
      at: payload.at,
      completionSeq: payload.completionSeq,
      ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    })
  })
  opencodeActivity.controller.on('associated', ({ terminalId, sessionId }) => {
    try {
      broadcastTerminalSessionAssociation({
        wsHandler,
        terminalMetadata,
        broadcastTerminalMetaUpserts,
        provider: 'opencode',
        terminalId,
        sessionId,
        source: 'opencode_controller',
      })
    } catch (err) {
      log.warn({ err, terminalId, sessionId }, 'Failed to broadcast OpenCode session association')
    }
  })

  const broadcastTerminalMetaUpserts = (upsert: ReturnType<TerminalMetadataService['list']>) => {
    if (upsert.length === 0) return
    wsHandler.broadcastTerminalMetaUpdated({ upsert, remove: [] })
  }

  const broadcastTerminalMetaRemoval = (terminalId: string) => {
    wsHandler.broadcastTerminalMetaUpdated({ upsert: [], remove: [terminalId] })
  }

  const findCodingCliSession = (provider: CodingCliProviderName, sessionId: string): CodingCliSession | undefined => {
    for (const project of codingCliIndexer.getProjects()) {
      const found = project.sessions.find((session) => (
        session.provider === provider && session.sessionId === sessionId
      ))
      if (found) return found
    }
    return undefined
  }

  await Promise.all(
    registry.list().map(async (terminal) => {
      await terminalMetadata.seedFromTerminal(terminal)
    }),
  )

  registry.on('terminal.created', (record: TerminalRecord) => {
    void terminalMetadata.seedFromTerminal(record)
      .then((upsert) => {
        if (upsert) broadcastTerminalMetaUpserts([upsert])
      })
      .catch((err) => {
        log.warn({ err, terminalId: record?.terminalId }, 'Failed to seed terminal metadata')
      })
  })

  registry.on('terminal.exit', (payload) => {
    const terminalId = (payload as { terminalId?: string })?.terminalId
    if (!terminalId) return
    // Retire instead of remove: keeps the provider/sessionId association so
    // rename cascades still work after the terminal process exits.
    if (terminalMetadata.retire(terminalId)) {
      broadcastTerminalMetaRemoval(terminalId)
    }
  })

  registry.on('terminal.session.bound', (payload) => {
    const event = payload as {
      terminalId?: string
      provider?: CodingCliProviderName
      sessionId?: string
    }
    if (event.provider !== 'codex') return
    if (!event.terminalId || !event.sessionId) return
    try {
      broadcastTerminalSessionAssociation({
        wsHandler,
        terminalMetadata,
        broadcastTerminalMetaUpserts,
        provider: 'codex',
        terminalId: event.terminalId,
        sessionId: event.sessionId,
        source: 'codex_durability',
      })
    } catch (err) {
      log.warn({ err, terminalId: event.terminalId, sessionId: event.sessionId }, 'Failed to broadcast Codex session association')
    }
  })

  const applyDebugLogging = (enabled: boolean, source: string) => {
    const nextEnabled = !!enabled
    setLogLevel(resolveRuntimeLogLevel(nextEnabled))
    setPerfLoggingEnabled(nextEnabled, source)
    wsHandler.broadcast({ type: 'perf.logging', enabled: nextEnabled })
  }

  applyDebugLogging(!!settings.logging?.debug, 'settings')

  app.use('/api/perf', createPerfRouter({
    configStore,
    registry,
    wsHandler,
    applyDebugLogging,
  }))

  // (bootstrap router mounted above, after httpAuthMiddleware)

  // --- API: settings ---
  app.use('/api/settings', createSettingsRouter({
    configStore,
    registry,
    wsHandler,
    codingCliIndexer,
    perfConfig,
    applyDebugLogging,
    validCliProviders: allCliNames,
  }))
  app.use('/api/fresh-agent/model-capabilities', createFreshAgentModelCapabilitiesRouter({
    registry: freshAgentModelCapabilityRegistry,
  }))

  // --- Network management endpoints ---
  app.use('/api', createNetworkRouter({
    networkManager,
    configStore,
    wsHandler,
    detectLanIps: detectLanIpsAsync,
  }))

  app.use('/api', createPlatformRouter({
    detectPlatform,
    detectAvailableClis: () => detectAvailableClis(cliDetectionSpecs),
    detectHostName,
    checkForUpdate: createCachedUpdateChecker(checkForUpdate),
    appVersion: APP_VERSION,
  }))


  // --- API: sessions ---
  app.use('/api', createSessionsRouter({
    configStore,
    codingCliIndexer,
    codingCliProviders,
    perfConfig,
    terminalMetadata,
    registry,
    wsHandler,
    sessionMetadataStore,
    serverInstanceId,
    validCliProviders: allCliNames,
  }))

  app.use('/api', createProjectColorsRouter({ configStore, codingCliIndexer }))

  // --- API: terminals ---
  app.use('/api/terminals', createTerminalsRouter({
    configStore,
    registry,
    wsHandler,
    terminalMetadata,
    codingCliIndexer,
    terminalViewService: createTerminalViewService({ configStore, registry }),
  }))

  // --- API: fresh-agent extras (attachments, exec, diffs) ---
  app.use('/api/fresh-agent', createFreshAgentExtrasRouter({ freshAgentRuntimeManager }))

  // --- API: AI ---
  app.use('/api/ai', createAiRouter({ registry, perfConfig }))

  // --- API: files (for editor pane) ---
  app.use('/api/files', createFilesRouter({ configStore, codingCliIndexer, registry }))

  // --- API: debug ---
  app.use('/api/debug', createDebugRouter({
    appVersion: APP_VERSION,
    configStore,
    wsHandler,
    codingCliIndexer,
    tabsRegistryStore,
    registry,
  }))

  // --- API: server-info ---
  app.use('/api/server-info', createServerInfoRouter({
    appVersion: APP_VERSION,
    startedAt: SERVER_STARTED_AT,
  }))

  // --- API: extensions ---
  app.use('/api/extensions', createExtensionRouter(extensionManager))

  // --- API: port forwarding (for browser pane remote access) ---
  const portForwardManager = new PortForwardManager()
  app.use('/api/proxy', createProxyRouter({ portForwardManager }))

  // Keep unmatched API requests from falling through to the production SPA fallback.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  // --- Static client in production ---
  const distRoot = path.resolve(__dirname, '..')
  const clientDir = path.join(distRoot, 'client')

  if (!isDev) {
    registerStaticClientRoutes(app, clientDir)
  }

  // Coding CLI watcher hooks
  // Sessions with an in-flight Gemini auto-title request (one-shot per session).
  const pendingAiTitles = new Set<string>()
  codingCliIndexer.onUpdate((projects) => {
    sessionsSync.publish(projects)
    const associationMetaUpserts: ReturnType<TerminalMetadataService['list']> = []
    const pendingMetadataSync = new Map<string, CodingCliSession>()
    for (const { session, terminalId } of collectAppliedSessionAssociations(associationCoordinator, projects)) {
      log.info({
        event: 'session_bind_applied',
        terminalId,
        sessionId: session.sessionId,
        provider: session.provider,
      }, 'session_bind_applied')
      try {
        broadcastTerminalSessionAssociation({
          wsHandler,
          terminalMetadata,
          broadcastTerminalMetaUpserts: (upserts) => associationMetaUpserts.push(...upserts),
          provider: session.provider,
          terminalId,
          sessionId: session.sessionId,
          source: 'indexer_update',
        })
      } catch (err) {
        log.warn({ err, terminalId }, 'Failed to broadcast session association')
      }
    }

    for (const project of projects) {
      for (const session of project.sessions) {
        const matchingTerminals = registry.findTerminalsBySession(session.provider, session.sessionId, session.cwd)
        for (const term of matchingTerminals) {
          pendingMetadataSync.set(term.terminalId, session)
          // Terminal title alignment is handled by the coding-agent auto-name
          // pass below (it pushes the canonical session name to live terminals).
        }
      }
    }

    if (associationMetaUpserts.length > 0) {
      broadcastTerminalMetaUpserts(associationMetaUpserts)
    }

    if (pendingMetadataSync.size > 0) {
      void (async () => {
        const syncUpserts: ReturnType<TerminalMetadataService['list']> = []
        for (const [terminalId, session] of pendingMetadataSync.entries()) {
          const upsert = await terminalMetadata.applySessionMetadata(terminalId, session)
          if (upsert) syncUpserts.push(upsert)
        }
        if (syncUpserts.length > 0) {
          broadcastTerminalMetaUpserts(syncUpserts)
        }
      })().catch((err) => {
        log.warn({ err }, 'Failed to sync terminal metadata from coding-cli index updates')
      })
    }

    // Auto-name active coding-agent sessions and keep their live terminals
    // aligned with the canonical (server-override) name. Seeds the working-
    // directory placeholder, finalizes from the first message when AI is off,
    // triggers Gemini when a key is set, and pushes the canonical name to any
    // out-of-sync terminal (regardless of whether its current title is a
    // default label). Bounded to sessions with a live terminal so we never
    // persist overrides for historical sessions; the ladder makes repeat
    // passes idempotent and a finalized name is never auto-changed.
    void (async () => {
      const settings = await configStore.getSettings()
      const aiWillAutoName = AI_CONFIG.enabled() && (settings.sidebar?.autoGenerateTitles ?? true)
      let changed = false
      for (const project of projects) {
        for (const session of project.sessions) {
          try {
          const matching = registry.findTerminalsBySession(session.provider, session.sessionId, session.cwd)
          if (matching.length === 0) continue
          const key = makeSessionKey(session.provider, session.sessionId)
          const existing = await configStore.getSessionOverride(key)
          const sync = computeSessionTitleSync({
            sessionTitle: session.title,
            override: existing,
            cwd: session.cwd,
            firstUserMessage: session.firstUserMessage,
            aiWillAutoName,
            parsedTitleSource: session.titleSource,
            terminals: matching.map((t) => ({ terminalId: t.terminalId, title: t.title })),
          })

          if (sync.overridePatch?.titleOverride) {
            await configStore.patchSessionOverride(key, sync.overridePatch)
            session.title = sync.overridePatch.titleOverride
            changed = true
          }

          if (sync.canonicalTitle) {
            for (const terminalId of sync.terminalIdsToUpdate) {
              registry.updateTitle(terminalId, sync.canonicalTitle)
              wsHandler.broadcast({ type: 'terminal.title.updated', terminalId, title: sync.canonicalTitle })
              changed = true
            }
          }

          // Gemini auto-naming for terminal-backed coding agents (SDK panes
          // finalize via the client). One-shot per session; the in-flight set
          // guards against concurrent passes re-issuing the API call.
          if (sync.shouldGenerateAi && session.firstUserMessage && !pendingAiTitles.has(key)) {
            pendingAiTitles.add(key)
            const aiInput = {
              key,
              firstMessage: session.firstUserMessage,
              provider: session.provider,
              sessionId: session.sessionId,
              cwd: session.cwd,
              customPrompt: settings.ai?.titlePrompt,
            }
            void (async () => {
              try {
                const aiTitle = await generateAiSessionTitle(aiInput.firstMessage, aiInput.customPrompt)
                if (!aiTitle) return
                await configStore.patchSessionOverride(aiInput.key, { titleOverride: aiTitle, titleSource: 'ai' })
                for (const term of registry.findTerminalsBySession(aiInput.provider, aiInput.sessionId, aiInput.cwd)) {
                  registry.updateTitle(term.terminalId, aiTitle)
                  wsHandler.broadcast({ type: 'terminal.title.updated', terminalId: term.terminalId, title: aiTitle })
                }
                await codingCliIndexer.refresh()
              } catch (err) {
                log.warn({ err }, 'Gemini auto-title failed')
              } finally {
                pendingAiTitles.delete(aiInput.key)
              }
            })()
          }
          } catch (err) {
            log.warn({ err, sessionId: session.sessionId }, 'Failed to auto-name a coding-agent session')
          }
        }
      }
      if (changed) sessionsSync.publish(projects)
    })().catch((err) => {
      log.warn({ err }, 'Failed to auto-name coding-agent sessions from index updates')
    })
  })

  // Fast-path session association for newly discovered Claude sessions.
  // Most providers now associate from onUpdate, but onNewSession still reduces the
  // delay before a freshly discovered Claude session binds to a matching terminal.
  //
  // Broadcast message type: { type: 'terminal.session.associated', terminalId: string, sessionId: string }
  codingCliIndexer.onNewSession((session) => {
    if (session.provider !== 'claude') return
    if (!session.cwd) return
    const shouldAssociate = associationCoordinator.noteSession({
      provider: 'claude',
      sessionId: session.sessionId,
      projectPath: session.projectPath,
      lastActivityAt: session.lastActivityAt,
      cwd: session.cwd,
    })
    if (!shouldAssociate) return
    const result = associationCoordinator.associateSingleSession({
      provider: 'claude',
      sessionId: session.sessionId,
      projectPath: session.projectPath,
      lastActivityAt: session.lastActivityAt,
      cwd: session.cwd,
    })
    if (!result.associated || !result.terminalId) return
    const terminalId = result.terminalId
    log.info({
      event: 'session_bind_applied',
      provider: 'claude',
      terminalId,
      sessionId: session.sessionId,
    }, 'session_bind_applied')
    try {
      broadcastTerminalSessionAssociation({
        wsHandler,
        terminalMetadata,
        broadcastTerminalMetaUpserts,
        provider: 'claude',
        terminalId,
        sessionId: session.sessionId,
        source: 'claude_new_session',
      })
    } catch (err) {
      log.warn({ err, terminalId, sessionId: session.sessionId }, 'Failed to broadcast session association')
    }

    void (async () => {
      const latestClaudeSession = findCodingCliSession('claude', session.sessionId)
      if (!latestClaudeSession) return
      const upsert = await terminalMetadata.applySessionMetadata(terminalId, latestClaudeSession)
      if (upsert) {
        broadcastTerminalMetaUpserts([upsert])
      }
    })().catch((err) => {
      log.warn({ err, terminalId, sessionId: session.sessionId }, 'Failed to apply Claude terminal metadata after association')
    })
  })

  const startBackgroundTasks = () => {
    void withPerfSpan(
      'session_repair_start',
      () => sessionRepairService.start(),
      {},
      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
    )
      .then(() => {
        startupState.markReady('sessionRepairService')
        logger.info({ task: 'sessionRepairService' }, 'Startup task ready')
      })
      .catch((err) => {
        logger.error({ err }, 'Session repair service failed to start')
      })

    void withPerfSpan(
      'coding_cli_indexer_start',
      () => codingCliIndexer.start(),
      {},
      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
    )
      .then(async () => {
        sessionRepairService.setFilePathResolver((id) => codingCliIndexer.getFilePathForSession(id, 'claude'))
        startupState.markReady('codingCliIndexer')
        logger.info({ task: 'codingCliIndexer' }, 'Startup task ready')

        // One-time cleanup: drop auto-written (non-user) title overrides that
        // shadow an authoritative provider-generated title (e.g. Amplifier's own
        // AI name). Keyed on provider capability so it never depends on live
        // enrichment; runs once after the first full index, not on every refresh.
        if (!(await configStore.isMigrationDone('ai-title-shadow-cleanup'))) {
          const authoritative = new Set<string>(
            codingCliProviders.filter((p) => p.providesAuthoritativeTitle?.()).map((p) => p.name),
          )
          const snap = await configStore.snapshot()
          const keys = overrideKeysToClear(snap.sessionOverrides ?? {}, authoritative)
          for (const key of keys) {
            await configStore.patchSessionOverride(key, { titleOverride: undefined, titleSource: undefined })
          }
          await configStore.markMigrationDone('ai-title-shadow-cleanup')
          if (keys.length) await codingCliIndexer.refresh()
        }
      })
      .catch((err) => {
        logger.error({ err }, 'Coding CLI indexer failed to start')
      })
  }

  // Determine bind host from config (shared logic with config/vite/vite.config.ts)
  const currentSettings = await configStore.getSettings()
  const bindHost = getNetworkHost()

  // Initialize NetworkManager (ALLOWED_ORIGINS) before accepting connections
  if (currentSettings.network.configured || bindHost === '0.0.0.0') {
    await networkManager.initializeFromStartup(
      bindHost as '127.0.0.1' | '0.0.0.0',
      currentSettings.network,
    )
  }

  server.listen(port, bindHost, () => {
    log.info({ event: 'server_listening', port, host: bindHost, appVersion: APP_VERSION }, 'Server listening')
    startBackgroundTasks()

    void (async () => {
      const token = process.env.AUTH_TOKEN
      const visitPort = resolveVisitPort(port, isDev, process.env)
      const hideToken = process.env.HIDE_STARTUP_TOKEN?.toLowerCase() === 'true'
      const localUrl = hideToken
        ? `http://localhost:${visitPort}/`
        : `http://localhost:${visitPort}/?token=${token}`

      let advertisedUrl = localUrl
      let startupStatus: Awaited<ReturnType<typeof networkManager.getStatus>> | null = null

      try {
        startupStatus = await networkManager.getStatus()
        if (hideToken) {
          const parsed = new URL(startupStatus.accessUrl)
          parsed.searchParams.delete('token')
          advertisedUrl = parsed.toString()
        } else {
          advertisedUrl = startupStatus.accessUrl
        }
      } catch (err) {
        log.warn({ err }, 'Failed to resolve startup network status for banner output')
      }

      console.log('')
      console.log(`\x1b[32m\u{1F41A}\u{1F525} freshell is ready!\x1b[0m`)
      const banner = resolveStartupBanner({
        localUrl,
        advertisedUrl,
        fallbackRemoteAccessEnabled: bindHost !== '127.0.0.1',
        status: startupStatus,
      })
      if (banner.kind === 'local') {
        console.log(`   Local only: \x1b[36m${banner.url}\x1b[0m`)
        if (hideToken) {
          console.log('   Auth token is configured in .env (not printed to logs).')
        }
        for (const line of banner.noteLines) {
          console.log(`   ${line}`)
        }
      } else {
        console.log(`   Visit from anywhere on your network: \x1b[36m${banner.url}\x1b[0m`)
        if (hideToken) {
          console.log('   Auth token is configured in .env (not printed to logs).')
        }
        for (const line of banner.noteLines) {
          console.log(`   ${line}`)
        }
      }
      if (isDev) {
        console.log(`   \x1b[33m(dev mode: Vite client on port ${visitPort}, Express server on port ${port})\x1b[0m`)
      }
      console.log('')
    })()
  })

  // Graceful shutdown handler
  let isShuttingDown = false
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    log.info({ signal }, 'Shutting down...')

    // 1. Establish terminal creation admission barriers before waiting on terminal teardown.
    terminalCreateAdmissionOpen = false
    wsHandler.close()

    // 2. Stop accepting new connections by closing the HTTP server
    const httpServerClosed = new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) {
          log.warn({ err }, 'Error closing HTTP server')
        }
        resolve()
      })
    })

    // 3. Stop any coalesced sessions publish timers
    sessionsSync.shutdown()

    // 4. Gracefully shut down terminals and planner-owned Codex app-server sidecars.
    try {
      await httpServerClosed
      await joinCodexShutdownOwners({
        registry,
        codexLaunchPlanner,
        codexFreshAgentRuntime,
        terminalShutdownTimeoutMs: 5000,
      })
    } finally {
      // 5. Kill all coding CLI sessions
      codingCliSessionManager.shutdown()
    }

    // 6. Close SDK bridge sessions
    sdkBridge.close()

    // 6b. Stop extension servers
    await extensionManager.stopAll()

    // 7. Stop NetworkManager
    await networkManager.stop()

    // 8. Close port forwards
    await portForwardManager.closeAll()

    // 9. Stop session indexer
    await codingCliIndexer.stop()

    // 9a. Stop the DEV extension-manifest watcher (undefined in production)
    await extWatcher?.close()

    // 9b. Stop Codex activity tracker listeners and sweep timer
    codexActivity.dispose()
    claudeActivity.dispose()
    amplifierActivity.dispose()
    opencodeActivity.dispose()

    // 10. Stop session repair service
    await sessionRepairService.stop()

    // 11. Exit cleanly
    log.info('Shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  log.error({ err }, 'Fatal startup error')
  process.exit(1)
})

import { detectLanIps } from './bootstrap.js' // Must be first - ensures .env exists before dotenv loads
import 'dotenv/config'
import { setupWslPortForwarding } from './wsl-port-forward.js'
import express from 'express'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import rateLimit from 'express-rate-limit'
import { logger, setLogLevel } from './logger.js'
import { requestLogger } from './request-logger.js'
import { validateStartupSecurity, httpAuthMiddleware } from './auth.js'
import { configStore } from './config-store.js'
import { TerminalRegistry, type TerminalRecord } from './terminal-registry.js'
import { WsHandler } from './ws-handler.js'
import { SessionsSyncService } from './sessions-sync/service.js'
import { CodingCliSessionIndexer } from './coding-cli/session-indexer.js'
import { CodingCliSessionManager } from './coding-cli/session-manager.js'
import { claudeProvider } from './coding-cli/providers/claude.js'
import { codexProvider } from './coding-cli/providers/codex.js'
import { type CodingCliProviderName, type CodingCliSession } from './coding-cli/types.js'
import { TerminalMetadataService } from './terminal-metadata-service.js'
import { migrateSettingsSortMode } from './settings-migrate.js'
import { createFilesRouter } from './files-router.js'
import { createPlatformRouter } from './platform-router.js'
import { createProxyRouter } from './proxy-router.js'
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
import { detectPlatform, detectAvailableClis, detectHostName } from './platform.js'
import { resolveVisitPort } from './startup-url.js'
import { NetworkManager } from './network-manager.js'
import { getNetworkHost } from './get-network-host.js'
import { PortForwardManager } from './port-forward.js'
import { parseTrustProxyEnv } from './request-ip.js'
import { createTabsRegistryStore } from './tabs-registry/store.js'
import { checkForUpdate } from './updater/version-checker.js'
import { SessionAssociationCoordinator } from './session-association-coordinator.js'
import { loadOrCreateServerInstanceId } from './instance-id.js'
import { createSettingsRouter } from './settings-router.js'
import { createPerfRouter } from './perf-router.js'
import { createAiRouter } from './ai-router.js'
import { createDebugRouter } from './debug-router.js'
import { LayoutStore } from './agent-api/layout-store.js'
import { createAgentApiRouter } from './agent-api/router.js'

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
const log = logger.child({ component: 'server' })
const perfConfig = getPerfConfig()

// Max age difference (ms) between a session's updatedAt and a terminal's createdAt
// for association to be considered valid. Prevents binding to stale sessions
// from previous server runs.
const ASSOCIATION_MAX_AGE_MS = 30_000

async function main() {
  validateStartupSecurity()

  // WSL2 port forwarding is deferred until bindHost is known (after config load).
  // See the conditional call before server.listen() below.

  initPerfLogging()

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', parseTrustProxyEnv(process.env.FRESHELL_TRUST_PROXY))

  app.use(express.json({ limit: '1mb' }))
  app.use(requestLogger)

  // --- Local file serving for browser pane (cookie auth for iframes) ---
  app.use('/local-file', createLocalFileRouter())

  const startupState = createStartupState()

  // Health check endpoint (no auth required - used by precheck script)
  app.get('/api/health', (_req, res) => {
    res.json({
      app: 'freshell',
      ok: true,
      version: APP_VERSION,
      ready: startupState.isReady(),
    })
  })

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

  app.use('/api', httpAuthMiddleware)
  app.use('/api', createClientLogsRouter())

  const codingCliProviders = [claudeProvider, codexProvider]
  const codingCliIndexer = new CodingCliSessionIndexer(codingCliProviders)
  const codingCliSessionManager = new CodingCliSessionManager(codingCliProviders)
  const tabsRegistryStore = createTabsRegistryStore()

  const settings = migrateSettingsSortMode(await configStore.getSettings())
  const registry = new TerminalRegistry(settings)
  const terminalMetadata = new TerminalMetadataService()
  const layoutStore = new LayoutStore()
  const terminalMetadata = new TerminalMetadataService()

  const sessionRepairService = getSessionRepairService()
  const serverInstanceId = await loadOrCreateServerInstanceId()

  const sdkBridge = new SdkBridge()

  const server = http.createServer(app)
  const wsHandler = new WsHandler(
    server,
    registry,
    codingCliSessionManager,
    sdkBridge,
    sessionRepairService,
    async () => {
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
    () => terminalMetadata.list(),
    tabsRegistryStore,
    serverInstanceId,
    layoutStore,
  )
  const port = Number(process.env.PORT || 3001)
  const isDev = process.env.NODE_ENV !== 'production'
  const vitePort = isDev ? Number(process.env.VITE_PORT || 5173) : undefined
  const networkManager = new NetworkManager(server, configStore, port, isDev, vitePort)
  networkManager.setWsHandler(wsHandler)
  app.use('/api', createAgentApiRouter({ layoutStore, registry, wsHandler }))

  const sessionsSync = new SessionsSyncService(wsHandler)
  const associationCoordinator = new SessionAssociationCoordinator(registry, ASSOCIATION_MAX_AGE_MS)

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

  registry.on('terminal.idle.warning', (payload: { terminalId: string; killMinutes: number; warnMinutes: number; lastActivityAt: number }) => {
    wsHandler.broadcast({ type: 'terminal.idle.warning', ...payload })
  })

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
    if (terminalMetadata.remove(terminalId)) {
      broadcastTerminalMetaRemoval(terminalId)
    }
  })

  const applyDebugLogging = (enabled: boolean, source: string) => {
    const nextEnabled = !!enabled
    setLogLevel(nextEnabled ? 'debug' : 'info')
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

  // --- API: settings ---
  app.use('/api/settings', createSettingsRouter({
    configStore,
    registry,
    wsHandler,
    codingCliIndexer,
    perfConfig,
    applyDebugLogging,
  }))

  // --- Network management endpoints ---
  app.use('/api', createNetworkRouter({
    networkManager,
    configStore,
    wsHandler,
    detectLanIps,
  }))

  app.use('/api', createPlatformRouter({
    detectPlatform,
    detectAvailableClis,
    detectHostName,
    checkForUpdate,
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
  }))

  app.use('/api', createProjectColorsRouter({ configStore, codingCliIndexer }))

  // --- API: terminals ---
  app.use('/api/terminals', createTerminalsRouter({ configStore, registry, wsHandler, terminalMetadata, codingCliIndexer }))

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

  // --- API: port forwarding (for browser pane remote access) ---
  const portForwardManager = new PortForwardManager()
  app.use('/api/proxy', createProxyRouter({ portForwardManager }))

  // --- Static client in production ---
  const distRoot = path.resolve(__dirname, '..')
  const clientDir = path.join(distRoot, 'client')
  const indexHtml = path.join(clientDir, 'index.html')

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(clientDir, { index: false }))
    app.get('*', (_req, res) => res.sendFile(indexHtml))
  }

  // Coding CLI watcher hooks
  codingCliIndexer.onUpdate((projects) => {
    sessionsSync.publish(projects)
    const associationMetaUpserts: ReturnType<TerminalMetadataService['list']> = []
    const pendingMetadataSync = new Map<string, CodingCliSession>()
    const nonClaudeProjects = projects.map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) => session.provider !== 'claude'),
    }))
    for (const session of associationCoordinator.collectNewOrAdvanced(nonClaudeProjects)) {
      const result = associationCoordinator.associateSingleSession(session)
      if (!result.associated || !result.terminalId) continue
      log.info({
        event: 'session_bind_applied',
        terminalId: result.terminalId,
        sessionId: session.sessionId,
        provider: session.provider,
      }, 'session_bind_applied')
      try {
        wsHandler.broadcast({
          type: 'terminal.session.associated' as const,
          terminalId: result.terminalId,
          sessionId: session.sessionId,
        })
        const metaUpsert = terminalMetadata.associateSession(
          result.terminalId,
          session.provider,
          session.sessionId,
        )
        if (metaUpsert) associationMetaUpserts.push(metaUpsert)
      } catch (err) {
        log.warn({ err, terminalId: result.terminalId }, 'Failed to broadcast session association')
      }
    }

    for (const project of projects) {
      for (const session of project.sessions) {
        const matchingTerminals = registry.findTerminalsBySession(session.provider, session.sessionId, session.cwd)
        for (const term of matchingTerminals) {
          pendingMetadataSync.set(term.terminalId, session)

          // Auto-update terminal titles based on session data
          if (session.title) {
            const defaultTitle =
              session.provider === 'claude'
                ? 'Claude'
                : session.provider === 'codex'
                  ? 'Codex'
                  : 'CLI'
            if (term.title === defaultTitle) {
              registry.updateTitle(term.terminalId, session.title)
              wsHandler.broadcast({
                type: 'terminal.title.updated',
                terminalId: term.terminalId,
                title: session.title,
              })
            }
          }
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
  })

  // One-time session association for newly discovered Claude sessions.
  // When the indexer first discovers a session file, associate it with the oldest
  // unassociated claude-mode terminal matching the session's cwd. This allows the
  // terminal to resume the session after server restart.
  //
  // Broadcast message type: { type: 'terminal.session.associated', terminalId: string, sessionId: string }
  codingCliIndexer.onNewSession((session) => {
    if (session.provider !== 'claude') return
    if (!session.cwd) return
    const shouldAssociate = associationCoordinator.noteSession({
      provider: 'claude',
      sessionId: session.sessionId,
      projectPath: session.projectPath,
      updatedAt: session.updatedAt,
      cwd: session.cwd,
    })
    if (!shouldAssociate) return
    const result = associationCoordinator.associateSingleSession({
      provider: 'claude',
      sessionId: session.sessionId,
      projectPath: session.projectPath,
      updatedAt: session.updatedAt,
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
      wsHandler.broadcast({
        type: 'terminal.session.associated' as const,
        terminalId,
        sessionId: session.sessionId,
      })
      const metaUpsert = terminalMetadata.associateSession(terminalId, 'claude', session.sessionId)
      if (metaUpsert) {
        broadcastTerminalMetaUpserts([metaUpsert])
      }
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
      .then(() => {
        sessionRepairService.setFilePathResolver((id) => codingCliIndexer.getFilePathForSession(id, 'claude'))
        startupState.markReady('codingCliIndexer')
        logger.info({ task: 'codingCliIndexer' }, 'Startup task ready')
      })
      .catch((err) => {
        logger.error({ err }, 'Coding CLI indexer failed to start')
      })
  }

  // Determine bind host from config (shared logic with vite.config.ts)
  const currentSettings = await configStore.getSettings()
  const bindHost = getNetworkHost()

  // WSL2 port forwarding — only when bound to 0.0.0.0 (remote access active)
  if (bindHost === '0.0.0.0') {
    const wslPortForwardResult = setupWslPortForwarding(vitePort)
    if (wslPortForwardResult === 'success') {
      console.log('[server] WSL2 port forwarding configured')
    } else if (wslPortForwardResult === 'failed') {
      console.warn('[server] WSL2 port forwarding failed - LAN access may not work')
    }
  }

  // Initialize NetworkManager (ALLOWED_ORIGINS) before accepting connections
  if (currentSettings.network.configured || bindHost === '0.0.0.0') {
    await networkManager.initializeFromStartup(
      bindHost as '127.0.0.1' | '0.0.0.0',
      currentSettings.network,
    )
  }

  server.listen(port, bindHost, () => {
    log.info({ event: 'server_listening', port, host: bindHost, appVersion: APP_VERSION }, 'Server listening')

    // Print friendly startup message
    const token = process.env.AUTH_TOKEN
    const lanIps = detectLanIps()
    const lanIp = lanIps[0] || 'localhost'
    const visitPort = resolveVisitPort(port, process.env)
    const hideToken = process.env.HIDE_STARTUP_TOKEN?.toLowerCase() === 'true'
    const url = hideToken
      ? `http://${lanIp}:${visitPort}/`
      : `http://${lanIp}:${visitPort}/?token=${token}`

    console.log('')
    console.log(`\x1b[32m\u{1F41A}\u{1F525} freshell is ready!\x1b[0m`)
    if (bindHost === '127.0.0.1') {
      const localUrl = hideToken
        ? `http://localhost:${visitPort}/`
        : `http://localhost:${visitPort}/?token=${token}`
      console.log(`   Local only: \x1b[36m${localUrl}\x1b[0m`)
      if (hideToken) {
        console.log('   Auth token is configured in .env (not printed to logs).')
      }
      console.log(`   Run the setup wizard to enable remote access.`)
    } else {
      console.log(`   Visit from anywhere on your network: \x1b[36m${url}\x1b[0m`)
      if (hideToken) {
        console.log('   Auth token is configured in .env (not printed to logs).')
      }
    }
    console.log('')

    startBackgroundTasks()
  })

  // Graceful shutdown handler
  let isShuttingDown = false
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    log.info({ signal }, 'Shutting down...')

    // 1. Stop accepting new connections by closing the HTTP server
    server.close((err) => {
      if (err) {
        log.warn({ err }, 'Error closing HTTP server')
      }
    })

    // 2. Stop any coalesced sessions publish timers
    sessionsSync.shutdown()

    // 3. Gracefully shut down terminals (gives Claude time to flush JSONL writes)
    await registry.shutdownGracefully(5000)

    // 4. Kill all coding CLI sessions
    codingCliSessionManager.shutdown()

    // 5. Close SDK bridge sessions
    sdkBridge.close()

    // 6. Stop NetworkManager
    await networkManager.stop()

    // 7. Close WebSocket connections gracefully
    wsHandler.close()

    // 7. Close port forwards
    portForwardManager.closeAll()

    // 8. Stop session indexer
    codingCliIndexer.stop()

    // 9. Stop session repair service
    await sessionRepairService.stop()

    // 10. Exit cleanly
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

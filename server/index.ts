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
import { TerminalRegistry, modeSupportsResume } from './terminal-registry.js'
import { WsHandler } from './ws-handler.js'
import { SessionsSyncService } from './sessions-sync/service.js'
import { claudeIndexer } from './claude-indexer.js'
import { CodingCliSessionIndexer } from './coding-cli/session-indexer.js'
import { CodingCliSessionManager } from './coding-cli/session-manager.js'
import { claudeProvider } from './coding-cli/providers/claude.js'
import { codexProvider } from './coding-cli/providers/codex.js'
import { type CodingCliProviderName, type CodingCliSession } from './coding-cli/types.js'
import { TerminalMetadataService } from './terminal-metadata-service.js'
import { migrateSettingsSortMode } from './settings-migrate.js'
import { filesRouter } from './files-router.js'
import { getSessionRepairService } from './session-scanner/service.js'
import { SdkBridge } from './sdk-bridge.js'
import { createClientLogsRouter } from './client-logs.js'
import { createSettingsRouter } from './routes/settings.js'
import { createSessionsRouter } from './routes/sessions.js'
import { createTerminalsRouter } from './routes/terminals.js'
import { createStartupState } from './startup-state.js'
import { getPerfConfig, initPerfLogging, setPerfLoggingEnabled, withPerfSpan } from './perf-logger.js'
import { resolveVisitPort } from './startup-url.js'
import { PortForwardManager } from './port-forward.js'
import { parseTrustProxyEnv } from './request-ip.js'

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

  // WSL2 port forwarding - must run AFTER security validation passes
  // and AFTER dotenv loads so PORT/NODE_ENV from .env are available
  const wslPortForwardResult = setupWslPortForwarding()
  if (wslPortForwardResult === 'success') {
    console.log('[server] WSL2 port forwarding configured')
  } else if (wslPortForwardResult === 'failed') {
    console.warn('[server] WSL2 port forwarding failed - LAN access may not work')
  }

  initPerfLogging()

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', parseTrustProxyEnv(process.env.FRESHELL_TRUST_PROXY))

  app.use(express.json({ limit: '1mb' }))
  app.use(requestLogger)

  // --- Local file serving for browser pane (no auth required, same-origin only) ---
  app.get('/local-file', (req, res) => {
    const filePath = req.query.path as string
    if (!filePath) {
      return res.status(400).json({ error: 'path query parameter required' })
    }

    // Normalize and resolve the path
    const resolved = path.resolve(filePath)

    // Check if file exists
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'File not found' })
    }

    // Check if it's a file (not a directory)
    const stat = fs.statSync(resolved)
	    if (stat.isDirectory()) {
	      return res.status(400).json({ error: 'Cannot serve directories' })
	    }

	    // Send the file with appropriate content type
	    res.sendFile(resolved)
	  })

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

  app.get('/api/debug', async (_req, res) => {
    const cfg = await configStore.snapshot()
    res.json({
      version: 1,
      appVersion: APP_VERSION,
      wsConnections: wsHandler.connectionCount(),
      settings: cfg.settings,
      sessionsProjects: codingCliIndexer.getProjects(),
      terminals: registry.list(),
      time: new Date().toISOString(),
    })
  })

  const settings = migrateSettingsSortMode(await configStore.getSettings())
  const registry = new TerminalRegistry(settings)
  const terminalMetadata = new TerminalMetadataService()

  const sessionRepairService = getSessionRepairService()

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
      return {
        settings: currentSettings,
        projects: codingCliIndexer.getProjects(),
        perfLogging: perfConfig.enabled,
      }
    },
    () => terminalMetadata.list(),
  )
  const sessionsSync = new SessionsSyncService(wsHandler)

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
      await terminalMetadata.seedFromTerminal(terminal as any)
    }),
  )

  registry.on('terminal.idle.warning', (payload) => {
    wsHandler.broadcast({ type: 'terminal.idle.warning', ...(payload as any) })
  })

  registry.on('terminal.created', (record) => {
    void terminalMetadata.seedFromTerminal(record as any)
      .then((upsert) => {
        if (upsert) broadcastTerminalMetaUpserts([upsert])
      })
      .catch((err) => {
        log.warn({ err, terminalId: (record as any)?.terminalId }, 'Failed to seed terminal metadata')
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

  app.use('/api', createSettingsRouter({
    registry,
    wsHandler,
    codingCliIndexer,
    claudeIndexer,
    applyDebugLogging,
  }))

  app.use('/api', createSessionsRouter({
    codingCliIndexer,
    codingCliProviders,
    claudeIndexer,
  }))

  const portForwardManager = new PortForwardManager()

  app.use('/api', createTerminalsRouter({
    registry,
    wsHandler,
    portForwardManager,
  }))

  // --- API: files (for editor pane) ---
  app.use('/api/files', filesRouter)

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

    for (const project of projects) {
      for (const session of project.sessions) {
        // Session association for non-Claude providers (e.g. Codex).
        // Runs on every update — idempotent because findUnassociatedTerminals
        // excludes already-associated terminals.
        // Time guard: only associate if the session is recent relative to the terminal,
        // preventing stale sessions from previous server runs from being matched.
        if (session.provider !== 'claude' && modeSupportsResume(session.provider) && session.cwd) {
          const unassociated = registry.findUnassociatedTerminals(session.provider, session.cwd)
          if (unassociated.length > 0) {
            const term = unassociated[0]
            if (session.updatedAt >= term.createdAt - ASSOCIATION_MAX_AGE_MS) {
              log.info({ terminalId: term.terminalId, sessionId: session.sessionId, provider: session.provider }, 'Associating terminal with coding CLI session')
              const associated = registry.setResumeSessionId(term.terminalId, session.sessionId)
              if (associated) {
                try {
                  wsHandler.broadcast({
                    type: 'terminal.session.associated' as const,
                    terminalId: term.terminalId,
                    sessionId: session.sessionId,
                  })
                  const metaUpsert = terminalMetadata.associateSession(
                    term.terminalId,
                    session.provider,
                    session.sessionId,
                  )
                  if (metaUpsert) associationMetaUpserts.push(metaUpsert)
                } catch (err) {
                  log.warn({ err, terminalId: term.terminalId }, 'Failed to broadcast session association')
                }
              }
            }
          }
        }

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

  // Claude watcher hooks (for search + session association)

  // One-time session association for new Claude sessions
  // When Claude creates a session file, associate it with the oldest unassociated
  // claude-mode terminal matching the session's cwd. This allows the terminal to
  // resume the session after server restart.
  //
  // Broadcast message type: { type: 'terminal.session.associated', terminalId: string, sessionId: string }
  claudeIndexer.onNewSession((session) => {
    if (!session.cwd) return

    const unassociated = registry.findUnassociatedClaudeTerminals(session.cwd)
    if (unassociated.length === 0) return

    // Only associate the oldest terminal (first in sorted list)
    // This prevents incorrect associations when multiple terminals share the same cwd
    const term = unassociated[0]
    log.info({ terminalId: term.terminalId, sessionId: session.sessionId }, 'Associating terminal with new Claude session')
    const associated = registry.setResumeSessionId(term.terminalId, session.sessionId)
    if (!associated) {
      log.warn({ terminalId: term.terminalId, sessionId: session.sessionId }, 'Skipping invalid Claude session association')
      return
    }
    try {
      wsHandler.broadcast({
        type: 'terminal.session.associated' as const,
        terminalId: term.terminalId,
        sessionId: session.sessionId,
      })
      const metaUpsert = terminalMetadata.associateSession(term.terminalId, 'claude', session.sessionId)
      if (metaUpsert) {
        broadcastTerminalMetaUpserts([metaUpsert])
      }
    } catch (err) {
      log.warn({ err, terminalId: term.terminalId }, 'Failed to broadcast session association')
    }

    void (async () => {
      const latestClaudeSession = findCodingCliSession('claude', session.sessionId)
      if (!latestClaudeSession) return
      const upsert = await terminalMetadata.applySessionMetadata(term.terminalId, latestClaudeSession)
      if (upsert) {
        broadcastTerminalMetaUpserts([upsert])
      }
    })().catch((err) => {
      log.warn({ err, terminalId: term.terminalId, sessionId: session.sessionId }, 'Failed to apply Claude terminal metadata after association')
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
        startupState.markReady('codingCliIndexer')
        logger.info({ task: 'codingCliIndexer' }, 'Startup task ready')
      })
      .catch((err) => {
        logger.error({ err }, 'Coding CLI indexer failed to start')
      })

    void withPerfSpan(
      'claude_indexer_start',
      () => claudeIndexer.start(),
      {},
      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
    )
      .then(() => {
        sessionRepairService.setFilePathResolver((id) => claudeIndexer.getFilePathForSession(id))
        startupState.markReady('claudeIndexer')
        logger.info({ task: 'claudeIndexer' }, 'Startup task ready')
      })
      .catch((err) => {
        logger.error({ err }, 'Claude indexer failed to start')
      })
  }

  const port = Number(process.env.PORT || 3001)
  server.listen(port, '0.0.0.0', () => {
    log.info({ event: 'server_listening', port, appVersion: APP_VERSION }, 'Server listening')

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
    console.log(`   Visit from anywhere on your network: \x1b[36m${url}\x1b[0m`)
    if (hideToken) {
      console.log('   Auth token is configured in .env (not printed to logs).')
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

    // 6. Close WebSocket connections gracefully
    wsHandler.close()

    // 7. Close port forwards
    portForwardManager.closeAll()

    // 8. Stop session indexers
    codingCliIndexer.stop()
    claudeIndexer.stop()

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

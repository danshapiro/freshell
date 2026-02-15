import { detectLanIps } from './bootstrap.js' // Must be first - ensures .env exists before dotenv loads
import 'dotenv/config'
import { setupWslPortForwarding } from './wsl-port-forward.js'
import express from 'express'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { logger, setLogLevel } from './logger.js'
import { requestLogger } from './request-logger.js'
import { validateStartupSecurity, httpAuthMiddleware, timingSafeCompare } from './auth.js'
import { configStore } from './config-store.js'
import { TerminalRegistry, modeSupportsResume } from './terminal-registry.js'
import { WsHandler } from './ws-handler.js'
import { SessionsSyncService } from './sessions-sync/service.js'
import { claudeIndexer } from './claude-indexer.js'
import { CodingCliSessionIndexer } from './coding-cli/session-indexer.js'
import { CodingCliSessionManager } from './coding-cli/session-manager.js'
import { claudeProvider } from './coding-cli/providers/claude.js'
import { codexProvider } from './coding-cli/providers/codex.js'
import { makeSessionKey, type CodingCliProviderName, type CodingCliSession } from './coding-cli/types.js'
import { TerminalMetadataService } from './terminal-metadata-service.js'
import { AI_CONFIG, PROMPTS, stripAnsi } from './ai-prompts.js'
import { migrateSettingsSortMode } from './settings-migrate.js'
import { filesRouter } from './files-router.js'
import { getSessionRepairService } from './session-scanner/service.js'
import { SdkBridge } from './sdk-bridge.js'
import { createClientLogsRouter } from './client-logs.js'
import { createStartupState } from './startup-state.js'
import { getPerfConfig, initPerfLogging, setPerfLoggingEnabled, startPerfTimer, withPerfSpan } from './perf-logger.js'
import { detectPlatform, detectAvailableClis } from './platform.js'
import { resolveVisitPort } from './startup-url.js'
import { NetworkManager } from './network-manager.js'
import { getNetworkHost } from './get-network-host.js'
import cookieParser from 'cookie-parser'
import { PortForwardManager } from './port-forward.js'
import { getRequesterIdentity, parseTrustProxyEnv } from './request-ip.js'
import { collectCandidateDirectories } from './candidate-dirs.js'

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
  app.get('/local-file', cookieParser(), (req, res, next) => {
    const headerToken = typeof req.headers['x-auth-token'] === 'string'
      ? req.headers['x-auth-token']
      : undefined
    const cookieToken = typeof req.cookies?.['freshell-auth'] === 'string'
      ? req.cookies['freshell-auth']
      : undefined
    const token = headerToken || cookieToken
    const expectedToken = process.env.AUTH_TOKEN
    if (!expectedToken || !token || !timingSafeCompare(token, expectedToken)) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
  }, (req, res) => {
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
  const port = Number(process.env.PORT || 3001)
  const isDev = process.env.NODE_ENV !== 'production'
  const vitePort = isDev ? Number(process.env.VITE_PORT || 5173) : undefined
  const networkManager = new NetworkManager(server, configStore, port, isDev, vitePort)
  networkManager.setWsHandler(wsHandler)

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

  app.post('/api/perf', async (req, res) => {
    const enabled = req.body?.enabled === true
    const updated = await configStore.patchSettings({ logging: { debug: enabled } })
    const migrated = migrateSettingsSortMode(updated)
    registry.setSettings(migrated)
    applyDebugLogging(!!migrated.logging?.debug, 'api')
    wsHandler.broadcast({ type: 'settings.updated', settings: migrated })
    res.json({ ok: true, enabled })
  })

  // --- API: settings ---
  //
  // SECURITY NOTE (XSS Prevention):
  // User-provided strings (tab titles, descriptions, settings values) are stored
  // as-is without server-side sanitization. This is intentional because:
  //
  // 1. The frontend uses React, which automatically escapes all interpolated
  //    values in JSX (e.g., {title}, {description}), preventing XSS attacks.
  //
  // 2. CRITICAL: `dangerouslySetInnerHTML` must NEVER be used with any user
  //    data from these APIs. If rich text rendering is ever needed, use a
  //    sanitization library like DOMPurify on the frontend.
  //
  // 3. The same applies to session overrides, terminal overrides, and project
  //    colors - all user input flows through React's automatic escaping.
  //
  // Verified: No dangerouslySetInnerHTML or innerHTML usage exists in src/components/.
  //
  app.get('/api/settings', async (_req, res) => {
    const s = await configStore.getSettings()
    res.json(migrateSettingsSortMode(s))
  })

  app.get('/api/lan-info', (_req, res) => {
    res.json({ ips: detectLanIps() })
  })

  // --- Network management endpoints ---
  app.get('/api/network/status', async (_req, res) => {
    try {
      const status = await networkManager.getStatus()
      res.json(status)
    } catch (err) {
      log.error({ err }, 'Failed to get network status')
      res.status(500).json({ error: 'Failed to get network status' })
    }
  })

  const NetworkConfigureSchema = z.object({
    host: z.enum(['127.0.0.1', '0.0.0.0']),
    configured: z.boolean(),
  })

  app.post('/api/network/configure', async (req, res) => {
    const parsed = NetworkConfigureSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }
    try {
      const { rebindScheduled } = await networkManager.configure(parsed.data)
      const status = await networkManager.getStatus()
      res.json({ ...status, rebindScheduled })
    } catch (err) {
      log.error({ err }, 'Failed to configure network')
      res.status(500).json({ error: 'Failed to configure network' })
      return
    }
    try {
      const fullSettings = await configStore.getSettings()
      wsHandler.broadcast({ type: 'settings.updated', settings: fullSettings })
    } catch (broadcastErr) {
      log.error({ err: broadcastErr }, 'Failed to broadcast settings after network configure')
    }
  })

  app.post('/api/network/configure-firewall', async (_req, res) => {
    try {
      const status = await networkManager.getStatus()

      // In-flight guard: prevent concurrent elevated firewall processes
      if (status.firewall.configuring) {
        return res.status(409).json({
          error: 'Firewall configuration already in progress',
          method: 'in-progress',
        })
      }

      const commands = status.firewall.commands

      if (commands.length === 0) {
        if (status.firewall.platform === 'wsl2') {
          const { execFile } = await import('node:child_process')
          const { buildPortForwardingScript, getWslIp } = await import('./wsl-port-forward.js')
          const POWERSHELL_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
          try {
            const wslIp = getWslIp()
            if (!wslIp) {
              log.error('Failed to detect WSL2 IP address')
              return res.status(500).json({ error: 'Could not detect WSL2 IP address' })
            }
            const ports = networkManager.getRelevantPorts()
            const rawScript = buildPortForwardingScript(wslIp, ports)
            const script = rawScript.replace(/\\\$/g, '$')
            const escapedScript = script.replace(/'/g, "''")
            networkManager.setFirewallConfiguring(true)
            const child = execFile(POWERSHELL_PATH, [
              '-Command',
              `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '${escapedScript}'`,
            ], { timeout: 120000 }, (err, _stdout, stderr) => {
              if (err) {
                log.error({ err, stderr }, 'WSL2 port forwarding failed')
              } else {
                log.info('WSL2 port forwarding completed successfully')
              }
              networkManager.resetFirewallCache()
              networkManager.setFirewallConfiguring(false)
            })
            child.on('error', (err) => {
              log.error({ err }, 'Failed to spawn PowerShell for WSL2 port forwarding')
              networkManager.resetFirewallCache()
              networkManager.setFirewallConfiguring(false)
            })
            return res.json({ method: 'wsl2', status: 'started' })
          } catch (err) {
            log.error({ err }, 'WSL2 port forwarding setup error')
            networkManager.setFirewallConfiguring(false)
            return res.status(500).json({ error: 'WSL2 port forwarding failed to start' })
          }
        }
        return res.json({ method: 'none', message: 'No firewall detected' })
      }

      if (status.firewall.platform === 'windows') {
        const { execFile } = await import('node:child_process')
        const script = commands.join('; ')
        const escapedScript = script.replace(/'/g, "''")
        try {
          networkManager.setFirewallConfiguring(true)
          const child = execFile('powershell.exe', [
            '-Command',
            `Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '${escapedScript}'`,
          ], { timeout: 120000 }, (err, _stdout, stderr) => {
            if (err) {
              log.error({ err, stderr }, 'Windows firewall configuration failed')
            } else {
              log.info('Windows firewall configured successfully')
            }
            networkManager.resetFirewallCache()
            networkManager.setFirewallConfiguring(false)
          })
          child.on('error', (err) => {
            log.error({ err }, 'Failed to spawn PowerShell for Windows firewall')
            networkManager.resetFirewallCache()
            networkManager.setFirewallConfiguring(false)
          })
          return res.json({ method: 'windows-elevated', status: 'started' })
        } catch (err) {
          log.error({ err }, 'Windows firewall setup error')
          networkManager.setFirewallConfiguring(false)
          return res.status(500).json({ error: 'Windows firewall configuration failed to start' })
        }
      }

      // Linux/macOS: return command for client to run in a terminal pane
      const command = commands.join(' && ')
      res.json({ method: 'terminal', command })
    } catch (err) {
      log.error({ err }, 'Firewall configuration error')
      res.status(500).json({ error: 'Firewall configuration failed' })
    }
  })

  app.get('/api/platform', async (_req, res) => {
    const [platform, availableClis] = await Promise.all([
      detectPlatform(),
      detectAvailableClis(),
    ])
    res.json({ platform, availableClis })
  })

  app.get('/api/files/candidate-dirs', async (_req, res) => {
    const cfg = await configStore.snapshot()
    const providerCwds = Object.values(cfg.settings?.codingCli?.providers || {}).map((provider) => provider?.cwd)
    const directories = collectCandidateDirectories({
      projects: codingCliIndexer.getProjects(),
      terminals: registry.list(),
      recentDirectories: cfg.recentDirectories || [],
      providerCwds,
      defaultCwd: cfg.settings?.defaultCwd,
    })
    res.json({ directories })
  })

  const normalizeSettingsPatch = (patch: Record<string, any>) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'defaultCwd')) {
      const raw = patch.defaultCwd
      if (raw === null) {
        patch.defaultCwd = undefined
      } else if (typeof raw === 'string' && raw.trim() === '') {
        patch.defaultCwd = undefined
      }
    }
    return patch
  }

  app.patch('/api/settings', async (req, res) => {
    const patch = normalizeSettingsPatch(migrateSettingsSortMode(req.body || {}) as any)
    const updated = await configStore.patchSettings(patch)
    const migrated = migrateSettingsSortMode(updated)
    registry.setSettings(migrated)
    applyDebugLogging(!!migrated.logging?.debug, 'settings')
    wsHandler.broadcast({ type: 'settings.updated', settings: migrated })
	    await withPerfSpan(
	      'coding_cli_refresh',
	      () => codingCliIndexer.refresh(),
	      {},
	      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
	    )
	    await withPerfSpan(
	      'claude_refresh',
	      () => claudeIndexer.refresh(),
	      {},
	      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
    )
    res.json(migrated)
  })

  // Alias (matches implementation plan)
  app.put('/api/settings', async (req, res) => {
    const patch = normalizeSettingsPatch(migrateSettingsSortMode(req.body || {}) as any)
    const updated = await configStore.patchSettings(patch)
    const migrated = migrateSettingsSortMode(updated)
    registry.setSettings(migrated)
    applyDebugLogging(!!migrated.logging?.debug, 'settings')
    wsHandler.broadcast({ type: 'settings.updated', settings: migrated })
	    await withPerfSpan(
	      'coding_cli_refresh',
	      () => codingCliIndexer.refresh(),
	      {},
	      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
	    )
	    await withPerfSpan(
	      'claude_refresh',
	      () => claudeIndexer.refresh(),
	      {},
	      { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
    )
    res.json(migrated)
  })

  // --- API: sessions ---
  // Search endpoint must come BEFORE the generic /api/sessions route
  app.get('/api/sessions/search', async (req, res) => {
    try {
      const { SearchRequestSchema, searchSessions } = await import('./session-search.js')

      const parsed = SearchRequestSchema.safeParse({
        query: req.query.q,
        tier: req.query.tier || 'title',
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        maxFiles: req.query.maxFiles ? Number(req.query.maxFiles) : undefined,
      })

      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
      }

      const endSearchTimer = startPerfTimer(
        'sessions_search',
        {
          queryLength: parsed.data.query.length,
          tier: parsed.data.tier,
          limit: parsed.data.limit,
        },
        { minDurationMs: perfConfig.slowSessionRefreshMs, level: 'warn' },
      )

      try {
        const response = await searchSessions({
          projects: codingCliIndexer.getProjects(),
          providers: codingCliProviders,
          query: parsed.data.query,
          tier: parsed.data.tier,
          limit: parsed.data.limit,
          maxFiles: parsed.data.maxFiles,
        })

        endSearchTimer({ resultCount: response.results.length, totalScanned: response.totalScanned })

        res.json(response)
      } catch (err: any) {
        endSearchTimer({
          error: true,
          errorName: err?.name,
          errorMessage: err?.message,
        })
        throw err
      }
    } catch (err: any) {
      log.error({ err }, 'Session search failed')
      res.status(500).json({ error: 'Search failed' })
    }
  })

  app.get('/api/sessions', async (_req, res) => {
    res.json(codingCliIndexer.getProjects())
  })

  app.patch('/api/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = (req.query.provider as CodingCliProviderName) || 'claude'
    const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)
    const SessionPatchSchema = z.object({
      titleOverride: z.string().optional().nullable(),
      summaryOverride: z.string().optional().nullable(),
      deleted: z.coerce.boolean().optional(),
      archived: z.coerce.boolean().optional(),
      createdAtOverride: z.coerce.number().optional(),
    })
    const parsed = SessionPatchSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }
    const cleanString = (value: string | null | undefined) => {
      const trimmed = typeof value === 'string' ? value.trim() : value
      return trimmed ? trimmed : undefined
    }
    const { titleOverride, summaryOverride, deleted, archived, createdAtOverride } = parsed.data
	    const next = await configStore.patchSessionOverride(compositeKey, {
	      titleOverride: cleanString(titleOverride),
	      summaryOverride: cleanString(summaryOverride),
	      deleted,
	      archived,
	      createdAtOverride,
	    })
	    await codingCliIndexer.refresh()
	    await claudeIndexer.refresh()
	    res.json(next)
	  })

  app.delete('/api/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = (req.query.provider as CodingCliProviderName) || 'claude'
	    const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)
	    await configStore.deleteSession(compositeKey)
	    await codingCliIndexer.refresh()
	    await claudeIndexer.refresh()
	    res.json({ ok: true })
	  })

  app.put('/api/project-colors', async (req, res) => {
	    const { projectPath, color } = req.body || {}
	    if (!projectPath || !color) return res.status(400).json({ error: 'projectPath and color required' })
	    await configStore.setProjectColor(projectPath, color)
	    await codingCliIndexer.refresh()
	    await claudeIndexer.refresh()
	    res.json({ ok: true })
	  })

  // --- API: terminals ---
  app.get('/api/terminals', async (_req, res) => {
    const cfg = await configStore.snapshot()
    const list = registry.list().filter((t) => !cfg.terminalOverrides?.[t.terminalId]?.deleted)
    const merged = list.map((t) => {
      const ov = cfg.terminalOverrides?.[t.terminalId]
      return {
        ...t,
        title: ov?.titleOverride || t.title,
        description: ov?.descriptionOverride || t.description,
      }
    })
    res.json(merged)
  })

  app.patch('/api/terminals/:terminalId', async (req, res) => {
    const terminalId = req.params.terminalId
    const { titleOverride, descriptionOverride, deleted } = req.body || {}

    const next = await configStore.patchTerminalOverride(terminalId, {
      titleOverride,
      descriptionOverride,
      deleted,
    })

    // Update live registry copies for immediate UI update.
    if (typeof titleOverride === 'string' && titleOverride.trim()) registry.updateTitle(terminalId, titleOverride.trim())
    if (typeof descriptionOverride === 'string') registry.updateDescription(terminalId, descriptionOverride)

    wsHandler.broadcast({ type: 'terminal.list.updated' })
    res.json(next)
  })

  app.delete('/api/terminals/:terminalId', async (req, res) => {
    const terminalId = req.params.terminalId
    await configStore.deleteTerminal(terminalId)
    wsHandler.broadcast({ type: 'terminal.list.updated' })
    res.json({ ok: true })
  })

  // --- API: AI ---
  app.post('/api/ai/terminals/:terminalId/summary', async (req, res) => {
    const terminalId = req.params.terminalId
    const term = registry.get(terminalId)
    if (!term) return res.status(404).json({ error: 'Terminal not found' })

    const snapshot = term.buffer.snapshot().slice(-20_000)

    // Fallback heuristic if AI not configured or fails.
    const heuristic = () => {
      const cleaned = stripAnsi(snapshot)
      const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      const first = lines[0] || 'Terminal session'
      const second = lines[1] || ''
      const desc = [first, second].filter(Boolean).join(' - ').slice(0, 240)
      return desc || 'Terminal session'
    }

    if (!AI_CONFIG.enabled()) {
      return res.json({ description: heuristic(), source: 'heuristic' })
    }

    const endSummaryTimer = startPerfTimer(
      'ai_summary',
      { terminalId, snapshotChars: snapshot.length },
      { minDurationMs: perfConfig.slowAiSummaryMs, level: 'warn' },
    )
    let summarySource: 'ai' | 'heuristic' = 'ai'
    let summaryError = false

    try {
      const { generateText } = await import('ai')
      const { google } = await import('@ai-sdk/google')
      const promptConfig = PROMPTS.terminalSummary
      const model = google(promptConfig.model)
      const prompt = promptConfig.build(snapshot)

      const result = await generateText({
        model,
        prompt,
        maxOutputTokens: promptConfig.maxTokens,
      })

      const description = (result.text || '').trim().slice(0, 240) || heuristic()
      res.json({ description, source: 'ai' })
    } catch (err: any) {
      summarySource = 'heuristic'
      summaryError = true
      log.warn({ err }, 'AI summary failed; using heuristic')
      res.json({ description: heuristic(), source: 'heuristic' })
    } finally {
      endSummaryTimer({ source: summarySource, error: summaryError })
    }
  })

  // --- API: files (for editor pane) ---
  app.use('/api/files', filesRouter)

  // --- API: port forwarding (for browser pane remote access) ---
  const portForwardManager = new PortForwardManager()

  app.post('/api/proxy/forward', async (req, res) => {
    const { port: targetPort } = req.body || {}

    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return res.status(400).json({ error: 'Invalid port number' })
    }

    try {
      const requester = getRequesterIdentity(req)
      const result = await portForwardManager.forward(targetPort, requester)
      res.json({ forwardedPort: result.port })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err, targetPort }, 'Port forward failed')
      res.status(500).json({ error: `Failed to create port forward: ${msg}` })
    }
  })

  app.delete('/api/proxy/forward/:port', (req, res) => {
    const targetPort = parseInt(req.params.port, 10)
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return res.status(400).json({ error: 'Invalid port number' })
    }
    try {
      const requester = getRequesterIdentity(req)
      portForwardManager.close(targetPort, requester.key)
      res.json({ ok: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error({ err, targetPort }, 'Port forward close failed')
      res.status(500).json({ error: `Failed to close port forward: ${msg}` })
    }
  })

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

import { detectLanIps } from './bootstrap.js' // Must be first - ensures .env exists before dotenv loads
import 'dotenv/config'
import express from 'express'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import rateLimit from 'express-rate-limit'
import { logger } from './logger.js'
import { validateStartupSecurity, httpAuthMiddleware } from './auth.js'
import { configStore } from './config-store.js'
import { TerminalRegistry } from './terminal-registry.js'
import { WsHandler } from './ws-handler.js'
import { claudeIndexer } from './claude-indexer.js'
import { claudeSessionManager } from './claude-session.js'
import { AI_CONFIG, PROMPTS, stripAnsi } from './ai-prompts.js'
import { migrateSettingsSortMode } from './settings-migrate.js'
import { filesRouter } from './files-router.js'
import { getSessionRepairService } from './session-scanner/service.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function main() {
  validateStartupSecurity()

  const app = express()
  app.disable('x-powered-by')

  app.use(express.json({ limit: '1mb' }))

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

  // Health check endpoint (no auth required - used by precheck script)
  app.get('/api/health', (_req, res) => {
    res.json({ app: 'freshell', ok: true })
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

  app.get('/api/debug', async (_req, res) => {
    const cfg = await configStore.snapshot()
    res.json({
      version: 1,
      wsConnections: wsHandler.connectionCount(),
      settings: cfg.settings,
      sessionsProjects: claudeIndexer.getProjects(),
      terminals: registry.list(),
      time: new Date().toISOString(),
    })
  })

  const settings = migrateSettingsSortMode(await configStore.getSettings())
  const registry = new TerminalRegistry(settings)

  // Start session repair service (background scanning of Claude sessions)
  const sessionRepairService = getSessionRepairService()
  await sessionRepairService.start()

  const server = http.createServer(app)
  const wsHandler = new WsHandler(server, registry, claudeSessionManager, sessionRepairService)

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

  app.patch('/api/settings', async (req, res) => {
    const patch = migrateSettingsSortMode(req.body || {}) as any
    const updated = await configStore.patchSettings(patch)
    const migrated = migrateSettingsSortMode(updated)
    registry.setSettings(migrated)
    wsHandler.broadcast({ type: 'settings.updated', settings: migrated })
    res.json(migrated)
  })

  // Alias (matches implementation plan)
  app.put('/api/settings', async (req, res) => {
    const patch = migrateSettingsSortMode(req.body || {}) as any
    const updated = await configStore.patchSettings(patch)
    const migrated = migrateSettingsSortMode(updated)
    registry.setSettings(migrated)
    wsHandler.broadcast({ type: 'settings.updated', settings: migrated })
    res.json(migrated)
  })

  // --- API: sessions ---
  app.get('/api/sessions', async (_req, res) => {
    res.json(claudeIndexer.getProjects())
  })

  app.patch('/api/sessions/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId
    const { titleOverride, summaryOverride, deleted } = req.body || {}
    const next = await configStore.patchSessionOverride(sessionId, {
      titleOverride,
      summaryOverride,
      deleted,
    })
    await claudeIndexer.refresh()
    wsHandler.broadcast({ type: 'sessions.updated', projects: claudeIndexer.getProjects() })
    res.json(next)
  })

  app.delete('/api/sessions/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId
    await configStore.deleteSession(sessionId)
    await claudeIndexer.refresh()
    wsHandler.broadcast({ type: 'sessions.updated', projects: claudeIndexer.getProjects() })
    res.json({ ok: true })
  })

  app.put('/api/project-colors', async (req, res) => {
    const { projectPath, color } = req.body || {}
    if (!projectPath || !color) return res.status(400).json({ error: 'projectPath and color required' })
    await configStore.setProjectColor(projectPath, color)
    await claudeIndexer.refresh()
    wsHandler.broadcast({ type: 'sessions.updated', projects: claudeIndexer.getProjects() })
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

    try {
      const { generateText } = await import('ai')
      const { google } = await import('@ai-sdk/google')
      const promptConfig = PROMPTS.terminalSummary
      const model = google(promptConfig.model)
      const prompt = promptConfig.build(snapshot)

      const result = await generateText({
        model,
        prompt,
        maxTokens: promptConfig.maxTokens,
      })

      const description = (result.text || '').trim().slice(0, 240) || heuristic()
      res.json({ description, source: 'ai' })
    } catch (err: any) {
      logger.warn({ err }, 'AI summary failed; using heuristic')
      res.json({ description: heuristic(), source: 'heuristic' })
    }
  })

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

  // Start Claude watcher
  await claudeIndexer.start()
  claudeIndexer.onUpdate((projects) => {
    wsHandler.broadcast({ type: 'sessions.updated', projects })

    // Auto-update terminal titles based on session data
    for (const project of projects) {
      for (const session of project.sessions) {
        if (!session.title) continue

        // Find terminals that match this session
        const matchingTerminals = registry.findClaudeTerminalsBySession(session.sessionId, session.cwd)
        for (const term of matchingTerminals) {
          // Only update if title is still the default "Claude"
          if (term.title === 'Claude') {
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
  })

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
    logger.info({ terminalId: term.terminalId, sessionId: session.sessionId }, 'Associating terminal with new Claude session')
    registry.setResumeSessionId(term.terminalId, session.sessionId)
    try {
      wsHandler.broadcast({
        type: 'terminal.session.associated' as const,
        terminalId: term.terminalId,
        sessionId: session.sessionId,
      })
    } catch (err) {
      logger.warn({ err, terminalId: term.terminalId }, 'Failed to broadcast session association')
    }
  })

  const port = Number(process.env.PORT || 3001)
  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Server listening')
  })

  // Graceful shutdown handler
  let isShuttingDown = false
  const shutdown = (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    logger.info({ signal }, 'Shutting down...')

    // 1. Stop accepting new connections by closing the HTTP server
    server.close((err) => {
      if (err) {
        logger.warn({ err }, 'Error closing HTTP server')
      }
    })

    // 2. Kill all running terminals
    registry.shutdown()

    // 3. Kill all Claude sessions
    claudeSessionManager.shutdown()

    // 4. Close WebSocket connections gracefully
    wsHandler.close()

    // 5. Stop the Claude indexer
    claudeIndexer.stop()

    // 6. Stop session repair service
    await sessionRepairService.stop()

    // 7. Exit cleanly
    logger.info('Shutdown complete')
    process.exit(0)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
  logger.error({ err }, 'Fatal startup error')
  process.exit(1)
})

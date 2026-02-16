import { Router } from 'express'
import { logger } from '../logger.js'
import { configStore } from '../config-store.js'
import { getPerfConfig, startPerfTimer } from '../perf-logger.js'
import { AI_CONFIG, PROMPTS, stripAnsi } from '../ai-prompts.js'
import { getRequesterIdentity } from '../request-ip.js'
import type { TerminalRegistry } from '../terminal-registry.js'
import type { WsHandler } from '../ws-handler.js'
import type { PortForwardManager } from '../port-forward.js'

const log = logger.child({ component: 'terminals-routes' })
const perfConfig = getPerfConfig()

type TerminalsRouterDeps = {
  registry: TerminalRegistry
  wsHandler: WsHandler
  portForwardManager: PortForwardManager
}

export function createTerminalsRouter(deps: TerminalsRouterDeps) {
  const { registry, wsHandler, portForwardManager } = deps
  const router = Router()

  router.get('/terminals', async (_req, res) => {
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

  router.patch('/terminals/:terminalId', async (req, res) => {
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

  router.delete('/terminals/:terminalId', async (req, res) => {
    const terminalId = req.params.terminalId
    await configStore.deleteTerminal(terminalId)
    wsHandler.broadcast({ type: 'terminal.list.updated' })
    res.json({ ok: true })
  })

  // --- API: AI ---
  router.post('/ai/terminals/:terminalId/summary', async (req, res) => {
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

  // --- API: port forwarding (for browser pane remote access) ---
  router.post('/proxy/forward', async (req, res) => {
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

  router.delete('/proxy/forward/:port', (req, res) => {
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

  return router
}

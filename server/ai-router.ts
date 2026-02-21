import { Router } from 'express'
import { AI_CONFIG, PROMPTS, stripAnsi } from './ai-prompts.js'
import { startPerfTimer } from './perf-logger.js'
import { logger } from './logger.js'

const log = logger.child({ component: 'ai-router' })

export interface AiRouterDeps {
  registry: {
    get: (id: string) => { buffer: { snapshot: () => string } } | undefined
  }
  perfConfig: { slowAiSummaryMs: number }
}

export function createAiRouter(deps: AiRouterDeps): Router {
  const { registry, perfConfig } = deps
  const router = Router()

  router.post('/terminals/:terminalId/summary', async (req, res) => {
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
        maxOutputTokens: promptConfig.maxOutputTokens,
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

  return router
}

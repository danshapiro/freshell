import { Router } from 'express'
import { AI_CONFIG, PROMPTS, stripAnsi } from './ai-prompts.js'
import { extractUserMessages } from './ai-user-message-extractor.js'
import { startPerfTimer } from './perf-logger.js'
import { logger } from './logger.js'

const log = logger.child({ component: 'ai-router' })

export interface AiRouterDeps {
  registry: {
    get: (id: string) => {
      buffer: { snapshot: () => string }
      mode?: string
      resumeSessionId?: string
      cwd?: string
    } | undefined
  }
  perfConfig: { slowAiSummaryMs: number }
  readSessionContent?: (sessionId: string, provider: string, cwd?: string) => Promise<string | null>
}

export function createAiRouter(deps: AiRouterDeps): Router {
  const { registry, perfConfig } = deps
  const router = Router()

  router.post('/terminals/:terminalId/summary', async (req, res) => {
    const terminalId = req.params.terminalId
    const term = registry.get(terminalId)
    if (!term) return res.status(404).json({ error: 'Terminal not found' })

    const snapshot = term.buffer.snapshot().slice(-20_000)

    // Determine input strategy: user-messages for coding CLIs, scrollback for shells
    let summaryInput: string
    let promptConfig: typeof PROMPTS.terminalSummary | typeof PROMPTS.codingCliSummary

    const isCodingCli = term.mode && term.mode !== 'shell'
    let userMessages: string | null = null

    if (isCodingCli && term.resumeSessionId && deps.readSessionContent) {
      try {
        const sessionContent = term.cwd === undefined
          ? await deps.readSessionContent(term.resumeSessionId, term.mode!)
          : await deps.readSessionContent(term.resumeSessionId, term.mode!, term.cwd)
        if (sessionContent) {
          const extracted = extractUserMessages(sessionContent, term.mode!)
          if (extracted) {
            userMessages = extracted
          }
        }
      } catch (err) {
        log.warn({ err, terminalId }, 'Failed to read session content for coding CLI summary')
      }
    }

    if (userMessages) {
      summaryInput = userMessages
      promptConfig = PROMPTS.codingCliSummary
    } else {
      summaryInput = snapshot
      promptConfig = PROMPTS.terminalSummary
    }

    // Fallback heuristic if AI not configured or fails.
    const heuristic = () => {
      const text = userMessages || snapshot
      const cleaned = stripAnsi(text)
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
      { terminalId, snapshotChars: summaryInput.length },
      { minDurationMs: perfConfig.slowAiSummaryMs, level: 'warn' },
    )
    let summarySource: 'ai' | 'heuristic' = 'ai'
    let summaryError = false

    try {
      const { generateText } = await import('ai')
      const { google } = await import('@ai-sdk/google')
      const model = google(promptConfig.model)
      const prompt = promptConfig.build(summaryInput)

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

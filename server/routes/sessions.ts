import { Router } from 'express'
import { z } from 'zod'
import { logger } from '../logger.js'
import { configStore } from '../config-store.js'
import { getPerfConfig, startPerfTimer } from '../perf-logger.js'
import { makeSessionKey, type CodingCliProviderName } from '../coding-cli/types.js'
import type { CodingCliSessionIndexer } from '../coding-cli/session-indexer.js'
import type { claudeIndexer as ClaudeIndexerType } from '../claude-indexer.js'
import type { CodingCliProvider } from '../coding-cli/provider.js'

const log = logger.child({ component: 'sessions-routes' })
const perfConfig = getPerfConfig()

type SessionsRouterDeps = {
  codingCliIndexer: CodingCliSessionIndexer
  codingCliProviders: CodingCliProvider[]
  claudeIndexer: typeof ClaudeIndexerType
}

export function createSessionsRouter(deps: SessionsRouterDeps) {
  const { codingCliIndexer, codingCliProviders, claudeIndexer } = deps
  const router = Router()

  // Search endpoint must come BEFORE the generic /sessions route
  router.get('/sessions/search', async (req, res) => {
    try {
      const { SearchRequestSchema, searchSessions } = await import('../session-search.js')

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

  router.get('/sessions', async (_req, res) => {
    res.json(codingCliIndexer.getProjects())
  })

  router.patch('/sessions/:sessionId', async (req, res) => {
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

  router.delete('/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = (req.query.provider as CodingCliProviderName) || 'claude'
    const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)
    await configStore.deleteSession(compositeKey)
    await codingCliIndexer.refresh()
    await claudeIndexer.refresh()
    res.json({ ok: true })
  })

  router.put('/project-colors', async (req, res) => {
    const { projectPath, color } = req.body || {}
    if (!projectPath || !color) return res.status(400).json({ error: 'projectPath and color required' })
    await configStore.setProjectColor(projectPath, color)
    await codingCliIndexer.refresh()
    await claudeIndexer.refresh()
    res.json({ ok: true })
  })

  return router
}

import { Router } from 'express'
import { z } from 'zod'
import { cleanString } from './utils.js'
import { makeSessionKey, type CodingCliProviderName } from './coding-cli/types.js'
import { startPerfTimer } from './perf-logger.js'
import { logger } from './logger.js'
import { cascadeSessionRenameToTerminal } from './rename-cascade.js'
import type { TerminalMeta } from './terminal-metadata-service.js'

const log = logger.child({ component: 'sessions-router' })

export const SessionPatchSchema = z.object({
  titleOverride: z.string().optional().nullable(),
  summaryOverride: z.string().optional().nullable(),
  deleted: z.coerce.boolean().optional(),
  archived: z.coerce.boolean().optional(),
  createdAtOverride: z.coerce.number().optional(),
})

export interface SessionsRouterDeps {
  configStore: {
    patchSessionOverride: (key: string, data: any) => Promise<any>
    deleteSession: (key: string) => Promise<void>
  }
  codingCliIndexer: {
    getProjects: () => any[]
    refresh: () => Promise<void>
  }
  codingCliProviders: any[]
  perfConfig: { slowSessionRefreshMs: number }
  terminalMetadata?: { list: () => TerminalMeta[] }
  registry?: { updateTitle: (id: string, title: string) => void }
  wsHandler?: { broadcast: (msg: any) => void }
}

export function createSessionsRouter(deps: SessionsRouterDeps): Router {
  const { configStore, codingCliIndexer, codingCliProviders, perfConfig } = deps
  const router = Router()

  // Search endpoint must come BEFORE the generic /sessions route
  router.get('/sessions/search', async (req, res) => {
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

  router.get('/sessions', async (_req, res) => {
    res.json(codingCliIndexer.getProjects())
  })

  router.patch('/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = (req.query.provider as CodingCliProviderName) || 'claude'
    const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)
    const parsed = SessionPatchSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }
    const { titleOverride, summaryOverride, deleted, archived, createdAtOverride } = parsed.data
    const next = await configStore.patchSessionOverride(compositeKey, {
      titleOverride: cleanString(titleOverride),
      summaryOverride: cleanString(summaryOverride),
      deleted,
      archived,
      createdAtOverride,
    })

    // Cascade: if this session is running in a terminal, also rename the terminal
    const cleanTitle = cleanString(titleOverride)
    let cascadedTerminalId: string | undefined
    if (cleanTitle && deps.terminalMetadata) {
      try {
        const parts = compositeKey.split(':')
        const sessionProvider = (parts.length >= 2 ? parts[0] : provider) as CodingCliProviderName
        const sessionId = parts.length >= 2 ? parts.slice(1).join(':') : rawId
        cascadedTerminalId = await cascadeSessionRenameToTerminal(
          deps.terminalMetadata.list(),
          sessionProvider,
          sessionId,
          cleanTitle,
        )
        if (cascadedTerminalId) {
          deps.registry?.updateTitle(cascadedTerminalId, cleanTitle)
          deps.wsHandler?.broadcast({ type: 'terminal.list.updated' })
        }
      } catch (err) {
        log.warn({ err, compositeKey }, 'Cascade rename to terminal failed (non-fatal)')
      }
    }

    await codingCliIndexer.refresh()
    res.json({ ...next, cascadedTerminalId })
  })

  router.delete('/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = (req.query.provider as CodingCliProviderName) || 'claude'
    const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)
    await configStore.deleteSession(compositeKey)
    await codingCliIndexer.refresh()
    res.json({ ok: true })
  })

  return router
}

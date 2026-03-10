import { Router } from 'express'
import { z } from 'zod'
import { cleanString } from './utils.js'
import { makeSessionKey, type CodingCliProviderName } from './coding-cli/types.js'
import { CodingCliProviderSchema } from '../shared/ws-protocol.js'
import { startPerfTimer } from './perf-logger.js'
import { logger } from './logger.js'
import { cascadeSessionRenameToTerminal } from './rename-cascade.js'
import { paginateProjects } from './session-pagination.js'
import { buildSidebarOpenSessionKeys } from './sidebar-session-selection.js'
import type { TerminalMeta } from './terminal-metadata-service.js'
import type { SessionMetadataStore } from './session-metadata-store.js'
import { DEFAULT_CLI_PROVIDER_NAMES } from './platform.js'

const log = logger.child({ component: 'sessions-router' })

export const SessionPatchSchema = z.object({
  titleOverride: z.string().optional().nullable(),
  summaryOverride: z.string().optional().nullable(),
  deleted: z.coerce.boolean().optional(),
  archived: z.coerce.boolean().optional(),
  createdAtOverride: z.coerce.number().optional(),
})

const SessionLocatorSchema = z.object({
  provider: CodingCliProviderSchema,
  sessionId: z.string().min(1),
  serverInstanceId: z.string().min(1).optional(),
})

const SessionsQuerySchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
  before: z.number().nonnegative().optional(),
  beforeId: z.string().min(1).optional(),
  openSessions: z.array(SessionLocatorSchema).optional(),
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
  sessionMetadataStore?: SessionMetadataStore
  serverInstanceId?: string
  validCliProviders?: string[]
}

export function createSessionsRouter(deps: SessionsRouterDeps): Router {
  const { configStore, codingCliIndexer, codingCliProviders, perfConfig } = deps
  const router = Router()
  const validCliProviders = new Set(deps.validCliProviders ?? DEFAULT_CLI_PROVIDER_NAMES)
  const sessionMetadataProviderSchema = z.string().min(1).superRefine((value, ctx) => {
    if (validCliProviders.has(value)) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unknown CLI provider: '${value}'`,
    })
  })

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

  router.get('/sessions', async (req, res) => {
    const projects = codingCliIndexer.getProjects()
    // Reject arrays (e.g. ?limit=1&limit=2) — only single string values accepted
    if (typeof req.query.limit !== 'string' && req.query.limit !== undefined) {
      return res.status(400).json({ error: 'Invalid limit parameter' })
    }
    if (typeof req.query.before !== 'string' && req.query.before !== undefined) {
      return res.status(400).json({ error: 'Invalid before parameter' })
    }
    if (typeof req.query.beforeId !== 'string' && req.query.beforeId !== undefined) {
      return res.status(400).json({ error: 'Invalid beforeId parameter' })
    }
    const limitStr = req.query.limit as string | undefined
    const beforeStr = req.query.before as string | undefined
    const beforeIdRaw = req.query.beforeId as string | undefined
    const beforeId = beforeIdRaw != null && beforeIdRaw !== '' ? beforeIdRaw : undefined

    // Parse numeric params (undefined if key absent)
    const limitRaw = limitStr != null && limitStr !== '' ? Number(limitStr) : undefined
    const beforeRaw = beforeStr != null && beforeStr !== '' ? Number(beforeStr) : undefined

    // Reject empty string params that were present in the query
    if (limitStr !== undefined && limitRaw === undefined) {
      return res.status(400).json({ error: 'Invalid limit parameter' })
    }
    if (beforeStr !== undefined && beforeRaw === undefined) {
      return res.status(400).json({ error: 'Invalid before parameter' })
    }
    if (beforeIdRaw !== undefined && beforeId === undefined) {
      return res.status(400).json({ error: 'Invalid beforeId parameter' })
    }

    // Validate numeric params
    if (limitRaw !== undefined && (!Number.isFinite(limitRaw) || limitRaw < 1 || !Number.isInteger(limitRaw))) {
      return res.status(400).json({ error: 'Invalid limit parameter' })
    }
    if (beforeRaw !== undefined && (!Number.isFinite(beforeRaw) || beforeRaw < 0)) {
      return res.status(400).json({ error: 'Invalid before parameter' })
    }

    // If limit or before is provided, return a PaginatedResult
    // (beforeId alone is a no-op — it's only a tie-breaker for before)
    if (limitRaw !== undefined || beforeRaw !== undefined) {
      const result = paginateProjects(projects, {
        limit: limitRaw,
        before: beforeRaw,
        beforeId,
      })
      res.json(result)
    } else {
      // Backward compat: return raw array
      res.json(projects)
    }
  })

  router.post('/sessions/query', async (req, res) => {
    const parsed = SessionsQuerySchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }

    const projects = codingCliIndexer.getProjects()
    const forcedKeys = buildSidebarOpenSessionKeys(
      parsed.data.openSessions ?? [],
      deps.serverInstanceId ?? '',
    )

    const result = paginateProjects(projects, {
      limit: parsed.data.limit,
      before: parsed.data.before,
      beforeId: parsed.data.beforeId,
      forceIncludeSessionKeys: forcedKeys,
    })

    res.json(result)
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

  const SessionMetadataPostSchema = z.object({
    provider: sessionMetadataProviderSchema,
    sessionId: z.string().min(1),
    sessionType: z.string().min(1),
  })

  router.post('/session-metadata', async (req, res) => {
    if (!deps.sessionMetadataStore) {
      return res.status(500).json({ error: 'Session metadata store not configured' })
    }
    const parsed = SessionMetadataPostSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Missing required fields: provider, sessionId, sessionType', details: parsed.error.issues })
    }
    const { provider, sessionId, sessionType } = parsed.data
    await deps.sessionMetadataStore.set(provider, sessionId, { sessionType })
    await codingCliIndexer.refresh()
    res.json({ ok: true })
  })

  return router
}

import { Router } from 'express'
import { z } from 'zod'
import { cleanString } from './utils.js'
import { logger } from './logger.js'
import { cascadeTerminalRenameToSession } from './rename-cascade.js'
import type { TerminalMeta } from './terminal-metadata-service.js'
import {
  TerminalDirectoryQuerySchema,
  TerminalScrollbackQuerySchema,
  TerminalSearchQuerySchema,
} from '../shared/read-models.js'
import { createTerminalViewService } from './terminal-view/service.js'
import type { TerminalViewService } from './terminal-view/types.js'
import { createRequestAbortSignal } from './read-models/request-abort.js'
import {
  defaultReadModelScheduler,
  isReadModelAbortError,
  type ReadModelWorkScheduler,
} from './read-models/work-scheduler.js'

const log = logger.child({ component: 'terminals-router' })
export const MAX_TERMINAL_TITLE_OVERRIDE_LENGTH = 500

export const TerminalPatchSchema = z.object({
  titleOverride: z.string().max(MAX_TERMINAL_TITLE_OVERRIDE_LENGTH).optional().nullable(),
  descriptionOverride: z.string().max(2000).optional().nullable(),
  deleted: z.boolean().optional(),
})

export interface TerminalsRouterDeps {
  configStore: {
    snapshot: () => Promise<any>
    patchTerminalOverride: (id: string, data: any) => Promise<any>
    deleteTerminal: (id: string) => Promise<void>
  }
  registry: {
    list: () => any[]
    updateTitle: (id: string, title: string) => void
    updateDescription: (id: string, desc: string) => void
  }
  wsHandler: {
    broadcast: (msg: any) => void
    broadcastTerminalsChanged?: () => void
  }
  terminalMetadata?: { list: () => TerminalMeta[] }
  codingCliIndexer?: { refresh: () => Promise<void> }
  terminalViewService?: TerminalViewService
  readModelScheduler?: ReadModelWorkScheduler
}

export function createTerminalsRouter(deps: TerminalsRouterDeps): Router {
  const { configStore, registry, wsHandler } = deps
  const router = Router()
  const readModelScheduler = deps.readModelScheduler ?? defaultReadModelScheduler
  const terminalViewService = deps.terminalViewService ?? createTerminalViewService({ configStore, registry })

  router.get('/', async (req, res) => {
    const hasReadModelQuery = (
      req.query.priority !== undefined ||
      req.query.cursor !== undefined ||
      req.query.revision !== undefined ||
      req.query.limit !== undefined
    )

    if (!hasReadModelQuery) {
      const terminals = await terminalViewService.listTerminalDirectory()
      return res.json(terminals)
    }

    const parsed = TerminalDirectoryQuerySchema.safeParse({
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      priority: typeof req.query.priority === 'string' ? req.query.priority : undefined,
      revision: typeof req.query.revision === 'string' ? Number(req.query.revision) : undefined,
      limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
    })

    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }

    const signal = createRequestAbortSignal(req, res)

    try {
      const page = await readModelScheduler.schedule({
        lane: parsed.data.priority,
        signal,
        run: (scheduledSignal) => terminalViewService.getTerminalDirectoryPage({
          ...parsed.data,
          signal: scheduledSignal,
        }),
      })
      return res.json(page)
    } catch (error) {
      if (signal.aborted || isReadModelAbortError(error)) {
        return
      }
      const message = error instanceof Error ? error.message : 'Terminal directory query failed'
      const status = /cursor/i.test(message) ? 400 : 500
      return res.status(status).json({ error: message })
    }
  })

  router.get('/:terminalId/viewport', async (req, res) => {
    const terminalId = req.params.terminalId
    if (!terminalId) {
      return res.status(400).json({ error: 'Invalid request' })
    }

    const signal = createRequestAbortSignal(req, res)
    let snapshot
    try {
      snapshot = await readModelScheduler.schedule({
        lane: 'critical',
        signal,
        run: (scheduledSignal) => terminalViewService.getViewportSnapshot({
          terminalId,
          signal: scheduledSignal,
        }),
      })
    } catch (error) {
      if (signal.aborted || isReadModelAbortError(error)) {
        return
      }
      const message = error instanceof Error ? error.message : 'Terminal viewport request failed'
      return res.status(500).json({ error: message })
    }
    if (!snapshot) {
      return res.status(404).json({ error: 'Terminal not found' })
    }

    res.json(snapshot)
  })

  router.get('/:terminalId/scrollback', async (req, res) => {
    const parsed = z.object({
      terminalId: z.string().min(1),
      cursor: z.string().optional(),
      limit: z.coerce.number().optional(),
    }).safeParse({
      terminalId: req.params.terminalId,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
    })

    const query = TerminalScrollbackQuerySchema.safeParse({
      cursor: parsed.success ? parsed.data.cursor : undefined,
      limit: parsed.success ? parsed.data.limit : undefined,
    })

    if (!parsed.success || !query.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: [...(!parsed.success ? parsed.error.issues : []), ...(!query.success ? query.error.issues : [])],
      })
    }

    const signal = createRequestAbortSignal(req, res)
    let page
    try {
      page = await readModelScheduler.schedule({
        lane: 'background',
        signal,
        run: (scheduledSignal) => terminalViewService.getScrollbackPage({
          terminalId: parsed.data.terminalId,
          cursor: query.data.cursor,
          limit: query.data.limit,
          signal: scheduledSignal,
        }),
      })
    } catch (error) {
      if (signal.aborted || isReadModelAbortError(error)) {
        return
      }
      const message = error instanceof Error ? error.message : 'Terminal scrollback request failed'
      return res.status(500).json({ error: message })
    }
    if (!page) {
      return res.status(404).json({ error: 'Terminal not found' })
    }

    res.json(page)
  })

  router.get('/:terminalId/search', async (req, res) => {
    const parsed = z.object({
      terminalId: z.string().min(1),
      query: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.coerce.number().optional(),
    }).safeParse({
      terminalId: req.params.terminalId,
      query: typeof req.query.query === 'string' ? req.query.query : undefined,
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      limit: typeof req.query.limit === 'string' ? req.query.limit : undefined,
    })

    const query = TerminalSearchQuerySchema.safeParse({
      query: parsed.success ? parsed.data.query : undefined,
      cursor: parsed.success ? parsed.data.cursor : undefined,
      limit: parsed.success ? parsed.data.limit : undefined,
    })

    if (!parsed.success || !query.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: [...(!parsed.success ? parsed.error.issues : []), ...(!query.success ? query.error.issues : [])],
      })
    }

    const signal = createRequestAbortSignal(req, res)
    let page
    try {
      page = await readModelScheduler.schedule({
        lane: 'visible',
        signal,
        run: (scheduledSignal) => terminalViewService.searchTerminal({
          terminalId: parsed.data.terminalId,
          query: query.data.query,
          cursor: query.data.cursor,
          limit: query.data.limit,
          signal: scheduledSignal,
        }),
      })
    } catch (error) {
      if (signal.aborted || isReadModelAbortError(error)) {
        return
      }
      const message = error instanceof Error ? error.message : 'Terminal search request failed'
      return res.status(500).json({ error: message })
    }
    if (!page) {
      return res.status(404).json({ error: 'Terminal not found' })
    }

    res.json(page)
  })

  router.patch('/:terminalId', async (req, res) => {
    const terminalId = req.params.terminalId
    const parsed = TerminalPatchSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }
    const { titleOverride: rawTitle, descriptionOverride: rawDesc, deleted } = parsed.data
    const titleOverride = rawTitle !== undefined ? cleanString(rawTitle) : undefined
    const descriptionOverride = rawDesc !== undefined ? cleanString(rawDesc) : undefined

    const next = await configStore.patchTerminalOverride(terminalId, {
      titleOverride,
      descriptionOverride,
      deleted,
    })

    if (typeof titleOverride === 'string' && titleOverride.trim()) registry.updateTitle(terminalId, titleOverride.trim())
    if (typeof descriptionOverride === 'string') registry.updateDescription(terminalId, descriptionOverride)

    // Cascade: if this terminal has a coding CLI session, also rename the session
    if (typeof titleOverride === 'string' && titleOverride.trim() && deps.terminalMetadata) {
      try {
        const meta = deps.terminalMetadata.list().find((m) => m.terminalId === terminalId)
        await cascadeTerminalRenameToSession(meta, titleOverride.trim())
        if (meta?.provider && meta?.sessionId) {
          await deps.codingCliIndexer?.refresh()
        }
      } catch (err) {
        log.warn({ err, terminalId }, 'Cascade rename to session failed (non-fatal)')
      }
    }

    wsHandler.broadcastTerminalsChanged?.()
    res.json(next)
  })

  router.delete('/:terminalId', async (req, res) => {
    const terminalId = req.params.terminalId
    await configStore.deleteTerminal(terminalId)
    wsHandler.broadcastTerminalsChanged?.()
    res.json({ ok: true })
  })

  return router
}

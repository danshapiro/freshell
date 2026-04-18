import { Router } from 'express'
import { z } from 'zod'

import {
  AgentTimelinePageQuerySchema,
  AgentTimelineTurnBodyQuerySchema,
  ReadModelPrioritySchema,
} from '../../shared/read-models.js'
import {
  FreshAgentRuntimeManager,
  FreshAgentRuntimeUnavailableError,
  FreshAgentStaleThreadRevisionError,
  FreshAgentUnsupportedCapabilityError,
  FreshAgentLostSessionError,
} from './runtime-manager.js'
import { createRequestAbortSignal } from '../read-models/request-abort.js'
import { setResponsePerfContext } from '../request-logger.js'
import {
  defaultReadModelScheduler,
  isReadModelAbortError,
  type ReadModelWorkScheduler,
} from '../read-models/work-scheduler.js'

const ThreadParamsSchema = z.object({
  provider: z.enum(['claude', 'codex', 'opencode']),
  threadId: z.string().min(1),
})

const TurnParamsSchema = ThreadParamsSchema.extend({
  turnId: z.string().min(1),
})

export function createFreshAgentRouter(deps: {
  runtimeManager: FreshAgentRuntimeManager
  readModelScheduler?: ReadModelWorkScheduler
}) {
  const router = Router()
  const readModelScheduler = deps.readModelScheduler ?? defaultReadModelScheduler

  function sendFreshAgentError(res: any, error: unknown) {
    if (error instanceof FreshAgentStaleThreadRevisionError) {
      return res.status(409).json({
        error: 'Stale thread revision',
        code: error.code,
        currentRevision: error.currentRevision,
      })
    }
    if (error instanceof FreshAgentRuntimeUnavailableError) {
      return res.status(503).json({ error: error.message, code: error.code })
    }
    if (error instanceof FreshAgentUnsupportedCapabilityError) {
      return res.status(409).json({ error: error.message, code: error.code })
    }
    if (error instanceof FreshAgentLostSessionError) {
      return res.status(404).json({ error: error.message, code: error.code })
    }
    const message = error instanceof Error ? error.message : 'Fresh-agent request failed'
    return res.status(500).json({ error: message })
  }

  router.get('/fresh-agent/threads/:provider/:threadId', async (req, res) => {
    const params = ThreadParamsSchema.safeParse(req.params)
    const query = z.object({
      priority: ReadModelPrioritySchema.optional(),
      revision: z.coerce.number().int().nonnegative().optional(),
    }).safeParse({
      priority: typeof req.query.priority === 'string' ? req.query.priority : undefined,
      revision: typeof req.query.revision === 'string' ? req.query.revision : undefined,
    })

    if (!params.success || !query.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: [...(!params.success ? params.error.issues : []), ...(!query.success ? query.error.issues : [])],
      })
    }

    const signal = createRequestAbortSignal(req, res)
    try {
      const snapshot = await readModelScheduler.schedule({
        lane: query.data.priority ?? 'visible',
        signal,
        run: async () => deps.runtimeManager.getSnapshot({
          provider: params.data.provider,
          threadId: params.data.threadId,
          revision: query.data.revision,
        }),
      })
      setResponsePerfContext(res, {
        readModelLane: query.data.priority ?? 'visible',
        responsePayloadBytes: Buffer.byteLength(JSON.stringify(snapshot), 'utf8'),
      })
      res.json(snapshot)
    } catch (error) {
      if (signal.aborted || isReadModelAbortError(error)) return
      return sendFreshAgentError(res, error)
    }
  })

  router.get('/fresh-agent/threads/:provider/:threadId/turns', async (req, res) => {
    const params = ThreadParamsSchema.safeParse(req.params)
    const query = AgentTimelinePageQuerySchema.safeParse({
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      priority: typeof req.query.priority === 'string' ? req.query.priority : undefined,
      revision: typeof req.query.revision === 'string' ? req.query.revision : undefined,
      limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
      includeBodies: typeof req.query.includeBodies === 'string' ? req.query.includeBodies : undefined,
    })

    if (!params.success || !query.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: [...(!params.success ? params.error.issues : []), ...(!query.success ? query.error.issues : [])],
      })
    }

    const signal = createRequestAbortSignal(req, res)
    try {
      const page = await readModelScheduler.schedule({
        lane: query.data.priority ?? 'visible',
        signal,
        run: async () => deps.runtimeManager.getTurnPage({
          provider: params.data.provider,
          threadId: params.data.threadId,
          cursor: query.data.cursor,
          priority: query.data.priority,
          revision: query.data.revision,
          limit: query.data.limit,
          includeBodies: query.data.includeBodies,
        }),
      })
      setResponsePerfContext(res, {
        readModelLane: query.data.priority ?? 'visible',
        responsePayloadBytes: Buffer.byteLength(JSON.stringify(page), 'utf8'),
      })
      res.json(page)
    } catch (error) {
      if (signal.aborted || isReadModelAbortError(error)) return
      return sendFreshAgentError(res, error)
    }
  })

  router.get('/fresh-agent/threads/:provider/:threadId/turns/:turnId', async (req, res) => {
    const params = TurnParamsSchema.safeParse(req.params)
    const query = AgentTimelineTurnBodyQuerySchema.safeParse({
      revision: typeof req.query.revision === 'string' ? req.query.revision : undefined,
    })
    if (!params.success || !query.success) {
      return res.status(400).json({
        error: 'Invalid request',
        details: [...(!params.success ? params.error.issues : []), ...(!query.success ? query.error.issues : [])],
      })
    }

    try {
      const turn = await deps.runtimeManager.getTurnBody({
        provider: params.data.provider,
        threadId: params.data.threadId,
        turnId: params.data.turnId,
        revision: query.data.revision,
      })
      if (!turn) {
        return res.status(404).json({ error: 'Turn not found' })
      }
      res.json(turn)
    } catch (error) {
      return sendFreshAgentError(res, error)
    }
  })

  return router
}

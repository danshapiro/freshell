import { Router } from 'express'
import { z } from 'zod'
import { AgentTimelinePageQuerySchema } from '../../shared/read-models.js'
import type { AgentTimelineService } from './service.js'
import { createRequestAbortSignal } from '../read-models/request-abort.js'
import { setResponsePerfContext } from '../request-logger.js'
import {
  defaultReadModelScheduler,
  isReadModelAbortError,
  type ReadModelWorkScheduler,
} from '../read-models/work-scheduler.js'

export type AgentTimelineRouterDeps = {
  service: AgentTimelineService
  readModelScheduler?: ReadModelWorkScheduler
}

const TurnParamsSchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
})

export function createAgentTimelineRouter(deps: AgentTimelineRouterDeps): Router {
  const router = Router()
  const readModelScheduler = deps.readModelScheduler ?? defaultReadModelScheduler

  router.get('/agent-sessions/:sessionId/timeline', async (req, res) => {
    const params = z.object({ sessionId: z.string().min(1) }).safeParse(req.params)
    const query = AgentTimelinePageQuerySchema.safeParse({
      cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      priority: typeof req.query.priority === 'string' ? req.query.priority : undefined,
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
        run: (scheduledSignal) => deps.service.getTimelinePage({
          sessionId: params.data.sessionId,
          ...query.data,
          signal: scheduledSignal,
        }),
      })
      setResponsePerfContext(res, {
        readModelLane: query.data.priority ?? 'visible',
        responsePayloadBytes: Buffer.byteLength(JSON.stringify(page), 'utf8'),
      })
      res.json(page)
    } catch (error) {
      if (signal.aborted || isReadModelAbortError(error)) {
        return
      }
      const message = error instanceof Error ? error.message : 'Agent timeline request failed'
      const status = /cursor/i.test(message) ? 400 : 500
      res.status(status).json({ error: message })
    }
  })

  router.get('/agent-sessions/:sessionId/turns/:turnId', async (req, res) => {
    const params = TurnParamsSchema.safeParse(req.params)
    if (!params.success) {
      return res.status(400).json({ error: 'Invalid request', details: params.error.issues })
    }

    const turn = await deps.service.getTurnBody(params.data)
    if (!turn) {
      return res.status(404).json({ error: 'Turn not found' })
    }

    res.json(turn)
  })

  return router
}

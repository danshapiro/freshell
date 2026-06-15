import { Router } from 'express'
import { z } from 'zod'

import {
  FreshAgentThreadTurnBodyQuerySchema,
  FreshAgentThreadTurnsQuerySchema,
  ReadModelPrioritySchema,
} from '../../shared/read-models.js'
import {
  FreshAgentRuntimeManager,
  FreshAgentRuntimeUnavailableError,
  FreshAgentStaleThreadRevisionError,
  FreshAgentUnsupportedCapabilityError,
  FreshAgentLostSessionError,
  FreshAgentSessionLocatorMismatchError,
  FreshAgentContractValidationError,
} from './runtime-manager.js'
import {
  ClaudeFreshAgentHistoryInvalidCursorError,
  ClaudeFreshAgentHistoryResolutionError,
  ClaudeFreshAgentStaleHistoryRevisionError,
} from './history/claude/history-service.js'
import { createRequestAbortSignal } from '../read-models/request-abort.js'
import { setResponsePerfContext } from '../request-logger.js'
import { recordSessionLifecycleEvent } from '../session-observability.js'
import {
  defaultReadModelScheduler,
  isReadModelAbortError,
  type ReadModelWorkScheduler,
} from '../read-models/work-scheduler.js'

const ThreadParamsSchema = z.object({
  sessionType: z.enum(['freshclaude', 'freshcodex', 'kilroy', 'freshopencode']),
  provider: z.enum(['claude', 'codex', 'opencode']),
  threadId: z.string().min(1),
})

const TurnParamsSchema = ThreadParamsSchema.extend({
  turnId: z.string().min(1),
})

function restoreResolutionReason(
  code: ClaudeFreshAgentHistoryResolutionError['code'],
): 'restore_not_found' | 'restore_unavailable' | 'restore_internal' | undefined {
  switch (code) {
    case 'RESTORE_NOT_FOUND':
      return 'restore_not_found'
    case 'RESTORE_UNAVAILABLE':
      return 'restore_unavailable'
    case 'RESTORE_INTERNAL':
      return 'restore_internal'
    default:
      return undefined
  }
}

function recordRestoreResolutionLifecycle(sessionId: string, code: ClaudeFreshAgentHistoryResolutionError['code']): void {
  const reason = restoreResolutionReason(code)
  if (!reason) return
  recordSessionLifecycleEvent({
    kind: 'client_restore_unavailable',
    sessionId,
    connectionId: 'http',
    reason,
    hasSessionRef: true,
  })
}

export function createFreshAgentRouter(deps: {
  runtimeManager: FreshAgentRuntimeManager
  readModelScheduler?: ReadModelWorkScheduler
}) {
  const router = Router()
  const readModelScheduler = deps.readModelScheduler ?? defaultReadModelScheduler

  function restoreResolutionStatus(code: ClaudeFreshAgentHistoryResolutionError['code']): number {
    switch (code) {
      case 'RESTORE_NOT_FOUND':
        return 404
      case 'RESTORE_UNAVAILABLE':
        return 503
      case 'RESTORE_DIVERGED':
        return 409
      case 'RESTORE_INTERNAL':
      default:
        return 500
    }
  }

  function sendFreshAgentError(res: any, error: unknown, options?: { sessionId?: string }) {
    if (error instanceof ClaudeFreshAgentStaleHistoryRevisionError) {
      return res.status(409).json({
        error: 'Stale restore revision',
        code: error.code,
        currentRevision: error.actualRevision,
      })
    }
    if (error instanceof ClaudeFreshAgentHistoryInvalidCursorError) {
      return res.status(400).json({ error: error.message })
    }
    if (error instanceof ClaudeFreshAgentHistoryResolutionError) {
      if (options?.sessionId) {
        recordRestoreResolutionLifecycle(options.sessionId, error.code)
      }
      return res.status(restoreResolutionStatus(error.code)).json({
        error: error.message,
        code: error.code,
      })
    }
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
    if (error instanceof FreshAgentSessionLocatorMismatchError) {
      return res.status(409).json({ error: error.message, code: error.code })
    }
    if (error instanceof FreshAgentContractValidationError) {
      return res.status(502).json({
        error: error.message,
        code: error.code,
        surface: error.surface,
        details: error.details,
      })
    }
    const message = error instanceof Error ? error.message : 'Fresh-agent request failed'
    return res.status(500).json({ error: message })
  }

  router.get('/fresh-agent/threads/:sessionType/:provider/:threadId', async (req, res) => {
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
          sessionType: params.data.sessionType,
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
      return sendFreshAgentError(res, error, { sessionId: params.data.threadId })
    }
  })

  router.get('/fresh-agent/threads/:sessionType/:provider/:threadId/turns', async (req, res) => {
    const params = ThreadParamsSchema.safeParse(req.params)
    const query = FreshAgentThreadTurnsQuerySchema.safeParse({
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
          sessionType: params.data.sessionType,
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
      return sendFreshAgentError(res, error, { sessionId: params.data.threadId })
    }
  })

  router.get('/fresh-agent/threads/:sessionType/:provider/:threadId/turns/:turnId', async (req, res) => {
    const params = TurnParamsSchema.safeParse(req.params)
    const query = FreshAgentThreadTurnBodyQuerySchema.safeParse({
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
        sessionType: params.data.sessionType,
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
      return sendFreshAgentError(res, error, { sessionId: params.data.threadId })
    }
  })

  return router
}

import { Router, type Request } from 'express'

import {
  FreshAgentModelCapabilitiesResponseSchema,
  FreshAgentModelCapabilitiesSessionTypeSchema,
} from '../../shared/fresh-agent-model-capabilities.js'
import type { FreshAgentSessionType } from '../../shared/fresh-agent.js'
import type { CapabilityRequestContext } from './model-capability-registry.js'

type FreshAgentModelCapabilityRegistryLike = {
  getCapabilities: (sessionType: FreshAgentSessionType, context?: CapabilityRequestContext) => Promise<unknown>
  refreshCapabilities: (sessionType: FreshAgentSessionType, context?: CapabilityRequestContext) => Promise<unknown>
}

function statusForModelCapabilitiesResult(result: { ok: boolean }): number {
  return result.ok ? 200 : 503
}

function resolveContext(
  req: Request,
  sessionType: FreshAgentSessionType,
): CapabilityRequestContext | undefined {
  if (sessionType !== 'freshopencode') return undefined
  if (typeof req.query.cwd !== 'string') return undefined
  return { cwd: req.query.cwd }
}

export function createFreshAgentModelCapabilitiesRouter(
  deps: { registry: FreshAgentModelCapabilityRegistryLike },
): Router {
  const router = Router()

  router.get('/:sessionType', async (req, res) => {
    const parsedSessionType = FreshAgentModelCapabilitiesSessionTypeSchema.safeParse(req.params.sessionType)
    if (!parsedSessionType.success) {
      return res.status(400).json({ error: 'Invalid sessionType' })
    }

    const context = resolveContext(req, parsedSessionType.data)
    const result = FreshAgentModelCapabilitiesResponseSchema.parse(
      context
        ? await deps.registry.getCapabilities(parsedSessionType.data, context)
        : await deps.registry.getCapabilities(parsedSessionType.data),
    )

    return res.status(statusForModelCapabilitiesResult(result)).json(result)
  })

  router.post('/:sessionType/refresh', async (req, res) => {
    const parsedSessionType = FreshAgentModelCapabilitiesSessionTypeSchema.safeParse(req.params.sessionType)
    if (!parsedSessionType.success) {
      return res.status(400).json({ error: 'Invalid sessionType' })
    }

    const context = resolveContext(req, parsedSessionType.data)
    const result = FreshAgentModelCapabilitiesResponseSchema.parse(
      context
        ? await deps.registry.refreshCapabilities(parsedSessionType.data, context)
        : await deps.registry.refreshCapabilities(parsedSessionType.data),
    )

    return res.status(statusForModelCapabilitiesResult(result)).json(result)
  })

  return router
}

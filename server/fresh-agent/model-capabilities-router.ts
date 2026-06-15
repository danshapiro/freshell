import { Router } from 'express'

import {
  FreshAgentModelCapabilitiesResponseSchema,
  FreshAgentModelCapabilitiesSessionTypeSchema,
} from '../../shared/fresh-agent-model-capabilities.js'
import type { FreshAgentSessionType } from '../../shared/fresh-agent.js'

type FreshAgentModelCapabilityRegistryLike = {
  getCapabilities: (sessionType: FreshAgentSessionType) => Promise<unknown>
  refreshCapabilities: (sessionType: FreshAgentSessionType) => Promise<unknown>
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

    const result = FreshAgentModelCapabilitiesResponseSchema.parse(
      await deps.registry.getCapabilities(parsedSessionType.data),
    )

    return res.status(200).json(result)
  })

  router.post('/:sessionType/refresh', async (req, res) => {
    const parsedSessionType = FreshAgentModelCapabilitiesSessionTypeSchema.safeParse(req.params.sessionType)
    if (!parsedSessionType.success) {
      return res.status(400).json({ error: 'Invalid sessionType' })
    }

    const result = FreshAgentModelCapabilitiesResponseSchema.parse(
      await deps.registry.refreshCapabilities(parsedSessionType.data),
    )

    return res.status(200).json(result)
  })

  return router
}

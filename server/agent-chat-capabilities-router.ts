import { Router } from 'express'
import { z } from 'zod'

import { AgentChatCapabilitiesResponseSchema } from '../shared/agent-chat-capabilities.js'

const ProviderSchema = z.string().trim().min(1)

type AgentChatCapabilityRegistryLike = {
  getCapabilities: (provider: string) => Promise<unknown>
  refreshCapabilities: (provider: string) => Promise<unknown>
}

export function createAgentChatCapabilitiesRouter(
  deps: { registry: AgentChatCapabilityRegistryLike },
): Router {
  const router = Router()

  router.get('/:provider', async (req, res) => {
    const parsedProvider = ProviderSchema.safeParse(req.params.provider)
    if (!parsedProvider.success) {
      return res.status(400).json({ error: 'Invalid provider' })
    }

    const result = AgentChatCapabilitiesResponseSchema.parse(
      await deps.registry.getCapabilities(parsedProvider.data),
    )

    return res.status(result.ok ? 200 : 503).json(result)
  })

  router.post('/:provider/refresh', async (req, res) => {
    const parsedProvider = ProviderSchema.safeParse(req.params.provider)
    if (!parsedProvider.success) {
      return res.status(400).json({ error: 'Invalid provider' })
    }

    const result = AgentChatCapabilitiesResponseSchema.parse(
      await deps.registry.refreshCapabilities(parsedProvider.data),
    )

    return res.status(result.ok ? 200 : 503).json(result)
  })

  return router
}

// @vitest-environment node
import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createFreshAgentModelCapabilitiesRouter } from '../../../server/fresh-agent/model-capabilities-router.js'
import { FreshAgentModelCapabilityRegistry } from '../../../server/fresh-agent/model-capability-registry.js'

describe('fresh-agent model capabilities router', () => {
  it('serves model capabilities from /api/fresh-agent/model-capabilities/:sessionType', async () => {
    const app = express()
    const registry = new FreshAgentModelCapabilityRegistry()
    app.use('/api/fresh-agent/model-capabilities', createFreshAgentModelCapabilitiesRouter({ registry }))

    const res = await request(app).get('/api/fresh-agent/model-capabilities/freshclaude').expect(200)

    expect(res.body.sessionType).toBe('freshclaude')
    expect(res.body.runtimeProvider).toBe('claude')
    expect(res.body.status).toMatch(/fresh|cached|unavailable/)
  })

  it('does not reuse Claude model data for non-Claude fresh-agent session types', async () => {
    const app = express()
    const registry = new FreshAgentModelCapabilityRegistry()
    app.use('/api/fresh-agent/model-capabilities', createFreshAgentModelCapabilitiesRouter({ registry }))

    const res = await request(app).get('/api/fresh-agent/model-capabilities/freshopencode').expect(200)

    expect(res.body.sessionType).toBe('freshopencode')
    expect(res.body.runtimeProvider).toBe('opencode')
    expect(res.body).not.toMatchObject({
      runtimeProvider: 'opencode',
      models: expect.arrayContaining([
        expect.objectContaining({ provider: 'claude' }),
      ]),
    })
    expect(
      res.body.status === 'unavailable'
      || res.body.models.every((model: { provider?: string }) => model.provider === 'opencode'),
    ).toBe(true)
  })
})

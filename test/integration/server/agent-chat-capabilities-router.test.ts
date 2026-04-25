// @vitest-environment node
import express, { type Express } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentChatCapabilitiesRouter } from '../../../server/agent-chat-capabilities-router.js'

describe('agent chat capabilities router', () => {
  let app: Express
  let registry: {
    getCapabilities: ReturnType<typeof vi.fn>
    refreshCapabilities: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    registry = {
      getCapabilities: vi.fn(),
      refreshCapabilities: vi.fn(),
    }

    app = express()
    app.use(express.json())
    app.use('/api/agent-chat/capabilities', createAgentChatCapabilitiesRouter({ registry }))
  })

  it('returns normalized runtime capabilities on success', async () => {
    registry.getCapabilities.mockResolvedValue({
      ok: true,
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: 1_234,
        models: [
          {
            id: 'opus',
            displayName: 'Opus',
            description: 'Primary track',
            supportsEffort: true,
            supportedEffortLevels: ['medium', 'high'],
            supportsAdaptiveThinking: true,
          },
        ],
      },
    })

    const res = await request(app).get('/api/agent-chat/capabilities/freshclaude')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: 1_234,
        models: [
          {
            id: 'opus',
            displayName: 'Opus',
            description: 'Primary track',
            supportsEffort: true,
            supportedEffortLevels: ['medium', 'high'],
            supportsAdaptiveThinking: true,
          },
        ],
      },
    })
    expect(registry.getCapabilities).toHaveBeenCalledWith('freshclaude')
  })

  it('returns refreshed capability data through the same contract', async () => {
    registry.refreshCapabilities.mockResolvedValue({
      ok: true,
      capabilities: {
        provider: 'kilroy',
        fetchedAt: 9_999,
        models: [
          {
            id: 'haiku',
            displayName: 'Haiku',
            description: 'Fast path',
            supportsEffort: false,
            supportedEffortLevels: [],
            supportsAdaptiveThinking: false,
          },
        ],
      },
    })

    const res = await request(app).post('/api/agent-chat/capabilities/kilroy/refresh')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      capabilities: {
        provider: 'kilroy',
        fetchedAt: 9_999,
        models: [
          {
            id: 'haiku',
            displayName: 'Haiku',
            description: 'Fast path',
            supportsEffort: false,
            supportedEffortLevels: [],
            supportsAdaptiveThinking: false,
          },
        ],
      },
    })
    expect(registry.refreshCapabilities).toHaveBeenCalledWith('kilroy')
  })

  it('returns a typed error payload when the probe fails', async () => {
    registry.getCapabilities.mockResolvedValue({
      ok: false,
      error: {
        code: 'CAPABILITY_PROBE_FAILED',
        message: 'probe failed',
        retryable: true,
      },
    })

    const res = await request(app).get('/api/agent-chat/capabilities/freshclaude')

    expect(res.status).toBe(503)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'CAPABILITY_PROBE_FAILED',
        message: 'probe failed',
        retryable: true,
      },
    })
  })

  it('returns typed payload-invalid errors without collapsing them', async () => {
    registry.getCapabilities.mockResolvedValue({
      ok: false,
      error: {
        code: 'CAPABILITY_PAYLOAD_INVALID',
        message: 'Capability payload has invalid supported effort levels for opus',
        retryable: false,
      },
    })

    const res = await request(app).get('/api/agent-chat/capabilities/freshclaude')

    expect(res.status).toBe(503)
    expect(res.body).toEqual({
      ok: false,
      error: {
        code: 'CAPABILITY_PAYLOAD_INVALID',
        message: 'Capability payload has invalid supported effort levels for opus',
        retryable: false,
      },
    })
  })
})

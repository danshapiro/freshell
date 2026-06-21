// @vitest-environment node
import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'

import { createFreshAgentModelCapabilitiesRouter } from '../../../server/fresh-agent/model-capabilities-router.js'
import type { FreshAgentModelCapabilitiesResponse } from '../../../shared/fresh-agent-model-capabilities.js'
import type { FreshAgentSessionType } from '../../../shared/fresh-agent.js'

function createAppWithRegistry(registry: {
  getCapabilities: (sessionType: FreshAgentSessionType, context?: { cwd?: string }) => Promise<FreshAgentModelCapabilitiesResponse>
  refreshCapabilities: (sessionType: FreshAgentSessionType, context?: { cwd?: string }) => Promise<FreshAgentModelCapabilitiesResponse>
}) {
  const app = express()
  app.use('/api/fresh-agent/model-capabilities', createFreshAgentModelCapabilitiesRouter({ registry }))
  return app
}

function successResponse(
  sessionType: FreshAgentSessionType,
  runtimeProvider: FreshAgentModelCapabilitiesResponse['runtimeProvider'],
): FreshAgentModelCapabilitiesResponse {
  return {
    ok: true,
    sessionType,
    runtimeProvider,
    status: 'fresh',
    fetchedAt: 1_234,
    models: [
      {
        id: `${runtimeProvider}-opus`,
        displayName: `${runtimeProvider} Opus`,
        provider: runtimeProvider,
        description: `${runtimeProvider} catalog`,
        supportsEffort: true,
        supportedEffortLevels: ['high'],
        supportsAdaptiveThinking: true,
      },
    ],
  }
}

const typedFailureResponse: FreshAgentModelCapabilitiesResponse = {
  ok: false,
  sessionType: 'freshclaude',
  runtimeProvider: 'claude',
  status: 'unavailable',
  models: [],
  error: {
    code: 'CAPABILITY_PROBE_FAILED',
    message: 'Probe failed upstream',
    retryable: true,
  },
}

describe('fresh-agent model capabilities router', () => {
  it('serves successful GET capabilities with sessionType and runtimeProvider', async () => {
    const registry = {
      getCapabilities: vi.fn(async (sessionType: FreshAgentSessionType) => successResponse(sessionType, 'claude')),
      refreshCapabilities: vi.fn(),
    }
    const app = createAppWithRegistry(registry)

    const res = await request(app).get('/api/fresh-agent/model-capabilities/freshclaude').expect(200)

    expect(registry.getCapabilities).toHaveBeenCalledWith('freshclaude')
    expect(registry.refreshCapabilities).not.toHaveBeenCalled()
    expect(res.body).toEqual(successResponse('freshclaude', 'claude'))
  })

  it('serves refresh POST capabilities from the refresh registry path', async () => {
    const registry = {
      getCapabilities: vi.fn(),
      refreshCapabilities: vi.fn(async (sessionType: FreshAgentSessionType) => ({
        ...successResponse(sessionType, 'claude'),
        status: 'cached' as const,
        fetchedAt: 2_345,
      })),
    }
    const app = createAppWithRegistry(registry)

    const res = await request(app).post('/api/fresh-agent/model-capabilities/freshclaude/refresh').expect(200)

    expect(registry.getCapabilities).not.toHaveBeenCalled()
    expect(registry.refreshCapabilities).toHaveBeenCalledWith('freshclaude')
    expect(res.body).toMatchObject({
      ok: true,
      sessionType: 'freshclaude',
      runtimeProvider: 'claude',
      status: 'cached',
      fetchedAt: 2_345,
    })
  })

  it('returns 503 with the typed body for capability failures', async () => {
    const registry = {
      getCapabilities: vi.fn(async () => typedFailureResponse),
      refreshCapabilities: vi.fn(async () => typedFailureResponse),
    }
    const app = createAppWithRegistry(registry)

    const getRes = await request(app).get('/api/fresh-agent/model-capabilities/freshclaude').expect(503)
    const refreshRes = await request(app).post('/api/fresh-agent/model-capabilities/freshclaude/refresh').expect(503)

    expect(getRes.body).toEqual(typedFailureResponse)
    expect(refreshRes.body).toEqual(typedFailureResponse)
  })

  it('returns 400 for invalid session types before consulting the registry', async () => {
    const registry = {
      getCapabilities: vi.fn(),
      refreshCapabilities: vi.fn(),
    }
    const app = createAppWithRegistry(registry)

    const getRes = await request(app).get('/api/fresh-agent/model-capabilities/not-a-session').expect(400)
    const refreshRes = await request(app).post('/api/fresh-agent/model-capabilities/not-a-session/refresh').expect(400)

    expect(registry.getCapabilities).not.toHaveBeenCalled()
    expect(registry.refreshCapabilities).not.toHaveBeenCalled()
    expect(getRes.body).toEqual({ error: 'Invalid sessionType' })
    expect(refreshRes.body).toEqual({ error: 'Invalid sessionType' })
  })

  it('does not reuse Claude model data for non-Claude fresh-agent session types', async () => {
    const registry = {
      getCapabilities: vi.fn(async (sessionType: FreshAgentSessionType) => {
        if (sessionType === 'freshopencode') {
          return successResponse(sessionType, 'opencode')
        }
        return successResponse(sessionType, 'claude')
      }),
      refreshCapabilities: vi.fn(),
    }
    const app = createAppWithRegistry(registry)

    const claude = await request(app).get('/api/fresh-agent/model-capabilities/freshclaude').expect(200)
    const opencode = await request(app).get('/api/fresh-agent/model-capabilities/freshopencode').expect(200)

    expect(claude.body.runtimeProvider).toBe('claude')
    expect(claude.body.models).toEqual([
      expect.objectContaining({ provider: 'claude' }),
    ])
    expect(opencode.body.runtimeProvider).toBe('opencode')
    expect(opencode.body.models).toEqual([
      expect.objectContaining({ provider: 'opencode' }),
    ])
    expect(opencode.body.models).not.toEqual([
      expect.objectContaining({ provider: 'claude' }),
    ])
  })

  it('forwards cwd for Freshopencode capabilities', async () => {
    const response = successResponse('freshopencode', 'opencode')
    const registry = {
      getCapabilities: vi.fn(async () => response),
      refreshCapabilities: vi.fn(async () => response),
    }
    const app = createAppWithRegistry(registry)

    await request(app)
      .get('/api/fresh-agent/model-capabilities/freshopencode')
      .query({ cwd: '/repo/project-a' })
      .expect(200)

    expect(registry.getCapabilities).toHaveBeenCalledWith('freshopencode', { cwd: '/repo/project-a' })
  })
})

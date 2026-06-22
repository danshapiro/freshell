// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import express from 'express'
import request from 'supertest'

const mockState = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  }
  return { logger }
})

vi.mock('../../../../server/logger.js', () => ({
  logger: mockState.logger,
}))

import {
  hashForLogs,
  recordFreshAgentObservabilityEvent,
  createFreshAgentSnapshotRateLimitMiddleware,
  __setFreshAgentObservabilitySinkForTest,
} from '../../../../server/fresh-agent/observability.js'

describe('hashForLogs', () => {
  it('produces a stable 12-char hex hash for the same input', () => {
    const a = hashForLogs('ses_abc123')
    const b = hashForLogs('ses_abc123')
    expect(a).toBe(b)
    expect(a).toHaveLength(12)
    expect(a).toMatch(/^[0-9a-f]{12}$/)
  })

  it('produces different hashes for different inputs', () => {
    expect(hashForLogs('ses_one')).not.toBe(hashForLogs('ses_two'))
  })
})

describe('recordFreshAgentObservabilityEvent', () => {
  let infoSpy: ReturnType<typeof vi.fn>
  let warnSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    infoSpy = vi.fn()
    warnSpy = vi.fn()
    __setFreshAgentObservabilitySinkForTest({ info: infoSpy, warn: warnSpy })
  })

  it('logs fresh_agent_opencode_status_observed at info level with hashed session id', () => {
    recordFreshAgentObservabilityEvent({
      kind: 'fresh_agent_opencode_status_observed',
      provider: 'opencode',
      sessionIdHash: hashForLogs('ses_real_1'),
      status: 'running',
      source: 'adapter',
    })

    expect(infoSpy).toHaveBeenCalledTimes(1)
    const [payload, msg] = infoSpy.mock.calls[0]
    expect(payload.event).toBe('fresh_agent_opencode_status_observed')
    expect(payload.provider).toBe('opencode')
    expect(payload.status).toBe('running')
    expect(payload.source).toBe('adapter')
    expect(payload.sessionIdHash).toBe(hashForLogs('ses_real_1'))
    expect(msg).toBe('fresh_agent_opencode_status_observed')
    // No raw session id in the payload
    expect(JSON.stringify(payload)).not.toContain('ses_real_1')
  })

  it('includes opencodeEventKind and cwdHash when provided', () => {
    recordFreshAgentObservabilityEvent({
      kind: 'fresh_agent_opencode_status_observed',
      provider: 'opencode',
      sessionIdHash: hashForLogs('ses_real_1'),
      status: 'idle',
      source: 'sse',
      opencodeEventKind: 'session.idle',
      cwdHash: hashForLogs('/repo/work'),
    })

    const [payload] = infoSpy.mock.calls[0]
    expect(payload.opencodeEventKind).toBe('session.idle')
    expect(payload.cwdHash).toBe(hashForLogs('/repo/work'))
  })

  it('omits opencodeEventKind and cwdHash when not provided', () => {
    recordFreshAgentObservabilityEvent({
      kind: 'fresh_agent_opencode_status_observed',
      provider: 'opencode',
      sessionIdHash: hashForLogs('ses_real_1'),
      status: 'running',
      source: 'adapter',
    })

    const [payload] = infoSpy.mock.calls[0]
    expect(payload).not.toHaveProperty('opencodeEventKind')
    expect(payload).not.toHaveProperty('cwdHash')
  })

  it('logs fresh_agent_snapshot_served at info level with turn count and hashed ids', () => {
    recordFreshAgentObservabilityEvent({
      kind: 'fresh_agent_snapshot_served',
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadIdHash: hashForLogs('ses_real_1'),
      httpStatus: 200,
      durationMs: 42.5,
      payloadBytes: 1024,
      turnCount: 3,
      lastTurnIdHash: hashForLogs('msg_3'),
      revision: 7,
    })

    expect(infoSpy).toHaveBeenCalledTimes(1)
    const [payload] = infoSpy.mock.calls[0]
    expect(payload.event).toBe('fresh_agent_snapshot_served')
    expect(payload.sessionType).toBe('freshopencode')
    expect(payload.provider).toBe('opencode')
    expect(payload.httpStatus).toBe(200)
    expect(payload.durationMs).toBe(42.5)
    expect(payload.payloadBytes).toBe(1024)
    expect(payload.turnCount).toBe(3)
    expect(payload.lastTurnIdHash).toBe(hashForLogs('msg_3'))
    expect(payload.revision).toBe(7)
    expect(JSON.stringify(payload)).not.toContain('ses_real_1')
    expect(JSON.stringify(payload)).not.toContain('msg_3')
  })

  it('omits optional snapshot_served fields when not provided', () => {
    recordFreshAgentObservabilityEvent({
      kind: 'fresh_agent_snapshot_served',
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadIdHash: hashForLogs('ses_real_1'),
      httpStatus: 200,
      durationMs: 10,
      turnCount: 0,
    })

    const [payload] = infoSpy.mock.calls[0]
    expect(payload).not.toHaveProperty('payloadBytes')
    expect(payload).not.toHaveProperty('lastTurnIdHash')
    expect(payload).not.toHaveProperty('revision')
    expect(payload).not.toHaveProperty('cwdHash')
  })

  it('logs fresh_agent_snapshot_rate_limited at warn level', () => {
    recordFreshAgentObservabilityEvent({
      kind: 'fresh_agent_snapshot_rate_limited',
      sessionType: 'freshopencode',
      provider: 'opencode',
      threadIdHash: hashForLogs('ses_real_1'),
      httpStatus: 429,
      route: '/api/fresh-agent/threads/freshopencode/opencode/ses_real_1',
    })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(infoSpy).not.toHaveBeenCalled()
    const [payload, msg] = warnSpy.mock.calls[0]
    expect(payload.event).toBe('fresh_agent_snapshot_rate_limited')
    expect(payload.httpStatus).toBe(429)
    expect(payload.sessionType).toBe('freshopencode')
    expect(payload.provider).toBe('opencode')
    expect(payload.route).toBeDefined()
    expect(msg).toBe('fresh_agent_snapshot_rate_limited')
  })
})

describe('createFreshAgentSnapshotRateLimitMiddleware', () => {
  let infoSpy: ReturnType<typeof vi.fn>
  let warnSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    infoSpy = vi.fn()
    warnSpy = vi.fn()
    __setFreshAgentObservabilitySinkForTest({ info: infoSpy, warn: warnSpy })
  })

  function makeApp(middleware: ReturnType<typeof createFreshAgentSnapshotRateLimitMiddleware>) {
    const app = express()
    app.use(middleware)
    // Simulate a 429 response (as express-rate-limit would do)
    app.use((req, res, next) => {
      if (req.query['rate-limited'] === '1') {
        return res.status(429).json({ error: 'Too many requests' })
      }
      next()
    })
    app.get('/freshopencode/:provider/:threadId', (req, res) => {
      res.json({ ok: true })
    })
    return app
  }

  it('logs fresh_agent_snapshot_rate_limited when a snapshot request gets 429', async () => {
    const app = makeApp(createFreshAgentSnapshotRateLimitMiddleware())
    await request(app).get('/freshopencode/opencode/ses_real_1?rate-limited=1').expect(429)

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [payload] = warnSpy.mock.calls[0]
    expect(payload.event).toBe('fresh_agent_snapshot_rate_limited')
    expect(payload.sessionType).toBe('freshopencode')
    expect(payload.provider).toBe('opencode')
    expect(payload.httpStatus).toBe(429)
    expect(payload.threadIdHash).toBe(hashForLogs('ses_real_1'))
    expect(JSON.stringify(payload)).not.toContain('ses_real_1')
  })

  it('does not log rate-limited event for successful snapshot requests', async () => {
    const app = makeApp(createFreshAgentSnapshotRateLimitMiddleware())
    await request(app).get('/freshopencode/opencode/ses_real_1').expect(200)

    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not log for paths that do not match the snapshot pattern', async () => {
    const app = makeApp(createFreshAgentSnapshotRateLimitMiddleware())
    // 4 segments (turns route) should not match the 3-segment snapshot pattern.
    // The mock rate-limiter still sends 429, but the observability middleware
    // should not log because the path doesn't match the snapshot pattern.
    await request(app).get('/freshopencode/opencode/ses_real_1/turns?rate-limited=1').expect(429)

    expect(warnSpy).not.toHaveBeenCalled()
  })
})

describe('createFreshAgentSnapshotRateLimitMiddleware: integration with express-rate-limit', () => {
  let infoSpy: ReturnType<typeof vi.fn>
  let warnSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    infoSpy = vi.fn()
    warnSpy = vi.fn()
    __setFreshAgentObservabilitySinkForTest({ info: infoSpy, warn: warnSpy })
  })

  it('logs fresh_agent_snapshot_rate_limited when express-rate-limit sends a 429 on a snapshot route', async () => {
    // Dynamically import express-rate-limit (not mocked) to simulate the real index.ts wiring:
    //   app.use('/api/fresh-agent/threads', createFreshAgentSnapshotRateLimitMiddleware())
    //   app.use('/api', rateLimit({ max: 1, windowMs: 60_000 }))
    const { default: rateLimit } = await import('express-rate-limit')
    const middleware = createFreshAgentSnapshotRateLimitMiddleware()

    const app = express()
    // Observability middleware BEFORE the rate limiter (as in index.ts)
    app.use('/api/fresh-agent/threads', middleware)
    // Global rate limiter with a very low limit
    app.use('/api', rateLimit({ windowMs: 60_000, max: 1, standardHeaders: true, legacyHeaders: false }))
    // A dummy route handler that never runs if rate-limited
    app.get('/api/fresh-agent/threads/:sessionType/:provider/:threadId', (req, res) => {
      res.json({ ok: true })
    })

    // First request succeeds (under the limit)
    await request(app).get('/api/fresh-agent/threads/freshopencode/opencode/ses_real_1').expect(200)
    expect(warnSpy).not.toHaveBeenCalled()

    // Second request is rate-limited → observability middleware should log
    await request(app).get('/api/fresh-agent/threads/freshopencode/opencode/ses_real_1').expect(429)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [payload] = warnSpy.mock.calls[0]
    expect(payload.event).toBe('fresh_agent_snapshot_rate_limited')
    expect(payload.sessionType).toBe('freshopencode')
    expect(payload.provider).toBe('opencode')
    expect(payload.httpStatus).toBe(429)
    expect(payload.threadIdHash).toBe(hashForLogs('ses_real_1'))
    expect(JSON.stringify(payload)).not.toContain('ses_real_1')
  })
})

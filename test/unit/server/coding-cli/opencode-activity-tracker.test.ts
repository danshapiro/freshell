import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OPENCODE_HEALTH_POLL_MS,
  OPENCODE_RECONNECT_BASE_MS,
  OpencodeActivityTracker,
} from '../../../../server/coding-cli/opencode-activity-tracker'

const TEST_ENDPOINT = { hostname: '127.0.0.1' as const, port: 43123 }

function createJsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function createSseResponse(events: unknown[]) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  }), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function createRawSseResponse(blocks: string[]) {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(block))
      }
      controller.close()
    },
  }), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

describe('OpencodeActivityTracker', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for health to become ready, snapshots busy state, and emits an upsert', async () => {
    vi.useFakeTimers()
    let healthCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        healthCalls += 1
        return healthCalls === 1
          ? new Response('not ready', { status: 503 })
          : createJsonResponse({ ok: true })
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          'session-oc': { type: 'busy' },
        })
      }
      if (url.endsWith('/event')) {
        return createSseResponse([{ type: 'server.connected', properties: {} }])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
    const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
    tracker.on('changed', (payload) => changes.push(payload))

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(changes).toEqual([])

    await vi.advanceTimersByTimeAsync(OPENCODE_HEALTH_POLL_MS)

    expect(changes).toContainEqual({
      upsert: [{
        terminalId: 'term-oc',
        sessionId: 'session-oc',
        phase: 'busy',
        updatedAt: expect.any(Number),
      }],
      remove: [],
    })

    tracker.dispose()
  })

  it('keeps health polling on connection errors until the endpoint comes up', async () => {
    vi.useFakeTimers()
    let healthCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        healthCalls += 1
        if (healthCalls === 1) {
          throw new Error('connect ECONNREFUSED')
        }
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          'session-oc': { type: 'busy' },
        })
      }
      if (url.endsWith('/event')) {
        return createSseResponse([{ type: 'server.connected', properties: {} }])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })

    await vi.advanceTimersByTimeAsync(0)
    expect(tracker.list()).toEqual([])

    await vi.advanceTimersByTimeAsync(OPENCODE_HEALTH_POLL_MS)
    expect(healthCalls).toBe(2)
    expect(tracker.list()).toEqual([expect.objectContaining({
      terminalId: 'term-oc',
      sessionId: 'session-oc',
      phase: 'busy',
    })])

    tracker.dispose()
  })

  it('removes busy state when session.status reports idle for the tracked session', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          'session-oc': { type: 'busy' },
        })
      }
      if (url.endsWith('/event')) {
        return createSseResponse([
          { type: 'server.connected', properties: {} },
          {
            type: 'session.status',
            properties: {
              sessionID: 'session-oc',
              status: { type: 'idle' },
            },
          },
        ])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
    const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
    tracker.on('changed', (payload) => changes.push(payload))

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(changes).toContainEqual({
      upsert: [{
        terminalId: 'term-oc',
        sessionId: 'session-oc',
        phase: 'busy',
        updatedAt: expect.any(Number),
      }],
      remove: [],
    })
    expect(changes).toContainEqual({
      upsert: [],
      remove: ['term-oc'],
    })
    expect(tracker.list()).toEqual([])

    tracker.dispose()
  })

  it('ignores session.idle for a different session than the tracked busy session', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          'session-oc': { type: 'busy' },
        })
      }
      if (url.endsWith('/event')) {
        return createSseResponse([
          { type: 'server.connected', properties: {} },
          {
            type: 'session.idle',
            properties: {
              sessionID: 'different-session',
            },
          },
        ])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
    const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
    tracker.on('changed', (payload) => changes.push(payload))

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(changes).toHaveLength(1)
    expect(tracker.list()).toEqual([expect.objectContaining({
      terminalId: 'term-oc',
      sessionId: 'session-oc',
      phase: 'busy',
    })])

    tracker.dispose()
  })

  it('reconnects after the SSE stream closes and resnapshots before removing stale busy state', async () => {
    vi.useFakeTimers()
    let snapshotCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/session/status')) {
        snapshotCalls += 1
        return createJsonResponse(snapshotCalls === 1
          ? { 'session-oc': { type: 'retry', attempt: 1 } }
          : {})
      }
      if (url.endsWith('/event')) {
        return createSseResponse([{ type: 'server.connected', properties: {} }])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
    const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
    tracker.on('changed', (payload) => changes.push(payload))

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(tracker.list()).toEqual([expect.objectContaining({
      terminalId: 'term-oc',
      sessionId: 'session-oc',
      phase: 'busy',
    })])

    await vi.advanceTimersByTimeAsync(OPENCODE_RECONNECT_BASE_MS)

    expect(changes).toContainEqual({
      upsert: [],
      remove: ['term-oc'],
    })
    expect(tracker.list()).toEqual([])

    tracker.dispose()
  })

  it('ignores malformed SSE JSON and keeps processing subsequent events from the same stream', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({ 'session-oc': { type: 'busy' } })
      }
      if (url.endsWith('/event')) {
        return createRawSseResponse([
          'data: {not valid json}\n\n',
          `data: ${JSON.stringify({ type: 'session.idle', properties: { sessionID: 'session-oc' } })}\n\n`,
        ])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const log = { warn: vi.fn() }
    const tracker = new OpencodeActivityTracker({
      fetchImpl: fetchImpl as typeof fetch,
      log,
      random: () => 0,
    })
    const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
    tracker.on('changed', (payload) => changes.push(payload))

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(changes).toContainEqual({
      upsert: [{
        terminalId: 'term-oc',
        sessionId: 'session-oc',
        phase: 'busy',
        updatedAt: expect.any(Number),
      }],
      remove: [],
    })
    expect(changes).toContainEqual({
      upsert: [],
      remove: ['term-oc'],
    })
    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(tracker.list()).toEqual([])

    tracker.dispose()
  })

  it('ignores unknown SSE event types and keeps processing known events from the same stream', async () => {
    vi.useFakeTimers()
    let snapshotCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/session/status')) {
        snapshotCalls += 1
        return createJsonResponse({
          'session-oc': { type: 'busy' },
        })
      }
      if (url.endsWith('/event')) {
        return createRawSseResponse([
          `data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`,
          `data: ${JSON.stringify({ type: 'session.progress', properties: { percent: 50 } })}\n\n`,
          `data: ${JSON.stringify({ type: 'session.idle', properties: { sessionID: 'session-oc' } })}\n\n`,
        ])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
    const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
    tracker.on('changed', (payload) => changes.push(payload))

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(changes).toContainEqual({
      upsert: [{
        terminalId: 'term-oc',
        sessionId: 'session-oc',
        phase: 'busy',
        updatedAt: expect.any(Number),
      }],
      remove: [],
    })
    expect(changes).toContainEqual({
      upsert: [],
      remove: ['term-oc'],
    })
    expect(snapshotCalls).toBe(1)
    expect(tracker.list()).toEqual([])

    tracker.dispose()
  })

  it('stops retrying and removes state when the terminal is untracked', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          'session-oc': { type: 'busy' },
        })
      }
      if (url.endsWith('/event')) {
        return createSseResponse([{ type: 'server.connected', properties: {} }])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(tracker.list()).toEqual([expect.objectContaining({
      terminalId: 'term-oc',
      sessionId: 'session-oc',
      phase: 'busy',
    })])

    const fetchCallsBeforeStop = fetchImpl.mock.calls.length
    tracker.untrackTerminal({ terminalId: 'term-oc' })

    expect(tracker.list()).toEqual([])

    await vi.advanceTimersByTimeAsync(OPENCODE_RECONNECT_BASE_MS * 4)

    expect(fetchImpl).toHaveBeenCalledTimes(fetchCallsBeforeStop)
    tracker.dispose()
  })
})

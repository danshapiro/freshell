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
    vi.unstubAllEnvs()
  })

  it('requires an explicit root resolver outside tests', () => {
    vi.stubEnv('NODE_ENV', 'production')

    expect(() => new OpencodeActivityTracker()).toThrow(/OpenCode root session resolver is required/)
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

  it('opens SSE before snapshot and emits completion only after association is confirmed', async () => {
    vi.useFakeTimers()
    const requestOrder: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        requestOrder.push('/global/health')
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/event')) {
        requestOrder.push('/event')
        return createSseResponse([
          { type: 'server.connected', properties: {} },
          {
            type: 'session.status',
            properties: {
              sessionID: 'session-oc',
              status: { type: 'busy' },
            },
          },
          {
            type: 'session.idle',
            properties: {
              sessionID: 'session-oc',
            },
          },
        ])
      }
      if (url.endsWith('/session/status')) {
        requestOrder.push('/session/status')
        return createJsonResponse({})
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
    const completions: unknown[] = []
    tracker.on('association.requested', (payload) => {
      expect(completions).toEqual([])
      tracker.confirmSessionAssociation(payload)
    })
    tracker.on('turn.complete', (payload) => completions.push(payload))

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(requestOrder.slice(0, 3)).toEqual(['/global/health', '/event', '/session/status'])
    expect(completions).toEqual([{
      terminalId: 'term-oc',
      sessionId: 'session-oc',
      at: expect.any(Number),
    }])

    tracker.dispose()
  })

  it('emits completion when the initial snapshot observes busy before a same-stream idle event', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/event')) {
        return createSseResponse([
          { type: 'server.connected', properties: {} },
          {
            type: 'session.idle',
            properties: {
              sessionID: 'session-oc',
            },
          },
        ])
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          'session-oc': { type: 'busy' },
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
    const completions: unknown[] = []
    tracker.on('association.requested', (payload) => {
      expect(completions).toEqual([])
      tracker.confirmSessionAssociation(payload)
    })
    tracker.on('turn.complete', (payload) => completions.push(payload))

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(completions).toEqual([{
      terminalId: 'term-oc',
      sessionId: 'session-oc',
      at: expect.any(Number),
    }])
    expect(tracker.list()).toEqual([])

    tracker.dispose()
  })

  it('clears ambiguous busy state when every ambiguous session idles on the same SSE stream', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/event')) {
        return createSseResponse([
          { type: 'server.connected', properties: {} },
          {
            type: 'session.status',
            properties: {
              sessionID: 'session-a',
              status: { type: 'busy' },
            },
          },
          {
            type: 'session.status',
            properties: {
              sessionID: 'session-b',
              status: { type: 'busy' },
            },
          },
          {
            type: 'session.idle',
            properties: {
              sessionID: 'session-a',
            },
          },
          {
            type: 'session.idle',
            properties: {
              sessionID: 'session-b',
            },
          },
        ])
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({})
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
    const completions: unknown[] = []
    tracker.on('changed', (payload) => changes.push(payload))
    tracker.on('association.requested', (payload) => tracker.confirmSessionAssociation(payload))
    tracker.on('turn.complete', (payload) => completions.push(payload))

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(log.warn).toHaveBeenCalledWith(
      {
        terminalId: 'term-oc',
        sessionIds: ['session-a', 'session-b'],
      },
      'OpenCode endpoint reported ambiguous session ownership; suppressing durable adoption.',
    )
    expect(changes).toContainEqual({
      upsert: [],
      remove: ['term-oc'],
    })
    expect(completions).toEqual([])
    expect(tracker.list()).toEqual([])

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
              status: { type: 'busy' },
            },
          },
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

    const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0, homeDir: '/tmp/nonexistent' })
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
          `data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`,
          'data: {not valid json}\n\n',
          `data: ${JSON.stringify({
            type: 'session.status',
            properties: {
              sessionID: 'session-oc',
              status: { type: 'busy' },
            },
          })}\n\n`,
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
          `data: ${JSON.stringify({
            type: 'session.status',
            properties: {
              sessionID: 'session-oc',
              status: { type: 'busy' },
            },
          })}\n\n`,
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

  it('maps child activity to its OpenCode root before classification', async () => {
    vi.useFakeTimers()
    const resolveOpencodeSessionRoots = vi.fn(async (sessionIds: readonly string[]) => ({
      rootsBySessionId: new Map([
        ['child_session', 'root_session'],
      ]),
      unresolvedSessionIds: new Set<string>(),
    }))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return createJsonResponse({ ok: true })
      if (url.endsWith('/event')) return createSseResponse([{ type: 'server.connected', properties: {} }])
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          child_session: { type: 'busy' },
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    const tracker = new OpencodeActivityTracker({
      fetchImpl: fetchImpl as typeof fetch,
      resolveOpencodeSessionRoots,
    })

    const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
    tracker.on('changed', (payload) => changes.push(payload))

    tracker.trackTerminal({ terminalId: 'term-opencode-1', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(changes).toContainEqual({
      upsert: [{
        terminalId: 'term-opencode-1',
        sessionId: 'root_session',
        phase: 'busy',
        updatedAt: expect.any(Number),
      }],
      remove: [],
    })
    expect(resolveOpencodeSessionRoots).toHaveBeenCalledTimes(1)
    expect(resolveOpencodeSessionRoots).toHaveBeenCalledWith(['child_session'])

    tracker.dispose()
  })

  it('does not let later child SSE status overwrite a snapshot-resolved root binding', async () => {
    vi.useFakeTimers()
    const resolveOpencodeSessionRoots = vi.fn(async (sessionIds: readonly string[]) => ({
      rootsBySessionId: new Map(sessionIds.map((sessionId) => [sessionId, 'root_session'])),
      unresolvedSessionIds: new Set<string>(),
    }))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return createJsonResponse({ ok: true })
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          child_session: { type: 'busy' },
        })
      }
      if (url.endsWith('/event')) {
        return createSseResponse([
          { type: 'server.connected', properties: {} },
          {
            type: 'session.status',
            properties: {
              sessionID: 'child_session',
              status: { type: 'busy' },
            },
          },
        ])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })
    const tracker = new OpencodeActivityTracker({
      fetchImpl: fetchImpl as typeof fetch,
      resolveOpencodeSessionRoots,
    })

    tracker.trackTerminal({ terminalId: 'term-opencode-1', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(resolveOpencodeSessionRoots).toHaveBeenCalledTimes(1)
    expect(tracker.list()).toEqual([
      expect.objectContaining({
        terminalId: 'term-opencode-1',
        sessionId: 'root_session',
        phase: 'busy',
      }),
    ])

    tracker.dispose()
  })

  it('does not choose an arbitrary durable session when multiple root sessions are active', async () => {
    vi.useFakeTimers()
    const resolveOpencodeSessionRoots = vi.fn(async () => ({
      rootsBySessionId: new Map([
        ['child-a', 'root_a'],
        ['child-b', 'root_b'],
      ]),
      unresolvedSessionIds: new Set<string>(),
    }))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return createJsonResponse({ ok: true })
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          'child-a': { type: 'busy' },
          'child-b': { type: 'busy' },
        })
      }
      if (url.endsWith('/event')) return createSseResponse([{ type: 'server.connected', properties: {} }])
      throw new Error(`Unexpected URL: ${url}`)
    })
    const log = { warn: vi.fn() }
    const tracker = new OpencodeActivityTracker({
      fetchImpl: fetchImpl as typeof fetch,
      resolveOpencodeSessionRoots,
      log,
    })

    tracker.trackTerminal({ terminalId: 'term-opencode-1', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(tracker.list()).toEqual([
      expect.objectContaining({
        terminalId: 'term-opencode-1',
        phase: 'busy',
      }),
    ])
    expect(tracker.list()[0]).not.toHaveProperty('sessionId')
    expect(log.warn).toHaveBeenCalledWith({
      terminalId: 'term-opencode-1',
      rootSessionIds: ['root_a', 'root_b'],
      unresolvedSessionIds: [],
    }, 'OpenCode reported multiple active root sessions; leaving terminal activity unbound.')

    tracker.dispose()
  })

  it('does not resolve OpenCode roots while waiting for health', async () => {
    vi.useFakeTimers()
    const resolveOpencodeSessionRoots = vi.fn(async () => ({
      rootsBySessionId: new Map<string, string>(),
      unresolvedSessionIds: new Set<string>(),
    }))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return new Response('not ready', { status: 503 })
      throw new Error(`Unexpected URL: ${url}`)
    })
    const tracker = new OpencodeActivityTracker({
      fetchImpl: fetchImpl as typeof fetch,
      resolveOpencodeSessionRoots,
    })

    tracker.trackTerminal({ terminalId: 'term-opencode-1', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(OPENCODE_HEALTH_POLL_MS * 3)

    expect(resolveOpencodeSessionRoots).not.toHaveBeenCalled()
    tracker.dispose()
  })

  it('uses session.created topology to suppress child SSE without SQLite lookup', async () => {
    vi.useFakeTimers()
    const resolveOpencodeSessionRoots = vi.fn(async () => ({
      rootsBySessionId: new Map<string, string>(),
      unresolvedSessionIds: new Set<string>(),
    }))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return createJsonResponse({ ok: true })
      if (url.endsWith('/session/status')) return createJsonResponse({})
      if (url.endsWith('/event')) {
        return createSseResponse([
          { type: 'server.connected', properties: {} },
          {
            type: 'session.created',
            properties: {
              sessionID: 'child-1', info: { id: 'child-1', parentID: 'parent-1' },
            },
          },
          {
            type: 'session.status',
            properties: {
              sessionID: 'child-1',
              status: { type: 'busy' },
            },
          },
          {
            type: 'session.status',
            properties: {
              sessionID: 'parent-1',
              status: { type: 'busy' },
            },
          },
          {
            type: 'session.idle',
            properties: {
              sessionID: 'parent-1',
            },
          },
        ])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const tracker = new OpencodeActivityTracker({
      fetchImpl: fetchImpl as typeof fetch,
      random: () => 0,
      resolveOpencodeSessionRoots,
    })
    const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
    tracker.on('changed', (payload) => changes.push(payload))

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    const upserts = changes.filter(c => c.upsert.length > 0)
    expect(upserts).toContainEqual({
      upsert: [{
        terminalId: 'term-oc',
        sessionId: 'parent-1',
        phase: 'busy',
        updatedAt: expect.any(Number),
      }],
      remove: [],
    })

    expect(changes).toContainEqual({
      upsert: [],
      remove: ['term-oc'],
    })
    expect(resolveOpencodeSessionRoots).not.toHaveBeenCalled()

    tracker.dispose()
  })

  it('filters child sessions from snapshot after session.created registers them', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          'parent-1': { type: 'busy' },
          'child-1': { type: 'busy' },
        })
      }
      if (url.endsWith('/event')) {
        return createSseResponse([
          { type: 'server.connected', properties: {} },
          {
            type: 'session.created',
            properties: {
              sessionID: 'child-1', info: { id: 'child-1', parentID: 'parent-1' },
            },
          },
        ])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const tracker = new OpencodeActivityTracker({
      fetchImpl: fetchImpl as typeof fetch,
      random: () => 0,
    })
    const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
    tracker.on('changed', (payload) => changes.push(payload))

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(changes).toContainEqual({
      upsert: [{
        terminalId: 'term-oc',
        sessionId: 'parent-1',
        phase: 'busy',
        updatedAt: expect.any(Number),
      }],
      remove: [],
    })

    tracker.dispose()
  })

  it('cleans up childSessionIds on untrackTerminal', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({})
      }
      if (url.endsWith('/event')) {
        return createSseResponse([
          { type: 'server.connected', properties: {} },
          {
            type: 'session.created',
            properties: {
              sessionID: 'child-1', info: { id: 'child-1', parentID: 'parent-1' },
            },
          },
          {
            type: 'session.status',
            properties: {
              sessionID: 'child-1',
              status: { type: 'busy' },
            },
          },
        ])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    tracker.untrackTerminal({ terminalId: 'term-oc' })

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
    tracker.on('changed', (payload) => changes.push(payload))

    await vi.advanceTimersByTimeAsync(OPENCODE_RECONNECT_BASE_MS)

    tracker.dispose()
  })

  it('resets childSessionIds on trackTerminal early return when re-tracking same endpoint', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({})
      }
      if (url.endsWith('/event')) {
        return createSseResponse([
          { type: 'server.connected', properties: {} },
          {
            type: 'session.created',
            properties: {
              sessionID: 'child-1', info: { id: 'child-1', parentID: 'parent-1' },
            },
          },
          {
            type: 'session.status',
            properties: {
              sessionID: 'child-1',
              status: { type: 'busy' },
            },
          },
          {
            type: 'session.status',
            properties: {
              sessionID: 'parent-1',
              status: { type: 'busy' },
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

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT, sessionId: 'parent-1' })
    await vi.advanceTimersByTimeAsync(0)

    tracker.dispose()
  })

  it('maps snapshot child activity to its OpenCode root before ownership reduction', async () => {
    vi.useFakeTimers()
    const resolveOpencodeSessionRoots = vi.fn(async () => ({
      rootsBySessionId: new Map([
        ['child-session', 'root-session'],
      ]),
      unresolvedSessionIds: new Set<string>(),
    }))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return createJsonResponse({ ok: true })
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          'child-session': { type: 'busy' },
        })
      }
      if (url.endsWith('/event')) return createSseResponse([{ type: 'server.connected', properties: {} }])
      throw new Error(`Unexpected URL: ${url}`)
    })
    const tracker = new OpencodeActivityTracker({
      fetchImpl: fetchImpl as typeof fetch,
      random: () => 0,
      resolveOpencodeSessionRoots,
    })

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(resolveOpencodeSessionRoots).toHaveBeenCalledWith(['child-session'])
    expect(tracker.list()).toEqual([
      expect.objectContaining({
        terminalId: 'term-oc',
        sessionId: 'root-session',
        phase: 'busy',
      }),
    ])

    tracker.dispose()
  })

  it('does not adopt an unresolved singleton OpenCode snapshot as a durable session', async () => {
    vi.useFakeTimers()
    const resolveOpencodeSessionRoots = vi.fn(async () => ({
      rootsBySessionId: new Map<string, string>(),
      unresolvedSessionIds: new Set(['child-session']),
    }))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return createJsonResponse({ ok: true })
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          'child-session': { type: 'busy' },
        })
      }
      if (url.endsWith('/event')) return createSseResponse([{ type: 'server.connected', properties: {} }])
      throw new Error(`Unexpected URL: ${url}`)
    })
    const tracker = new OpencodeActivityTracker({
      fetchImpl: fetchImpl as typeof fetch,
      random: () => 0,
      resolveOpencodeSessionRoots,
    })

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    expect(tracker.list()).toEqual([
      expect.objectContaining({
        terminalId: 'term-oc',
        phase: 'busy',
      }),
    ])
    expect(tracker.list()[0]).not.toHaveProperty('sessionId')

    tracker.dispose()
  })
})

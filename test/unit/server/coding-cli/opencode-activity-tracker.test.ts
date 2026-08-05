import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OPENCODE_BUSY_DEADMAN_MS,
  OPENCODE_EVENT_READ_STALL_MS,
  OPENCODE_HEALTH_POLL_MS,
  OPENCODE_RECONNECT_BASE_MS,
  OpencodeActivityTracker,
} from '../../../../server/coding-cli/opencode-activity-tracker'
import type { OpencodeRootResolution } from '../../../../server/coding-cli/providers/opencode.js'

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

function createControlledSseResponse() {
  const encoder = new TextEncoder()
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
    },
  }), {
    headers: { 'content-type': 'text/event-stream' },
  })

  return {
    response,
    enqueue(event: unknown) {
      if (!streamController) throw new Error('SSE stream not started')
      streamController.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    },
    close() {
      streamController?.close()
    },
  }
}

function createControlledFetchFixture(snapshot: Record<string, unknown>) {
  const sse = createControlledSseResponse()
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/global/health')) return createJsonResponse({ healthy: true })
    if (url.endsWith('/session/status')) return createJsonResponse(snapshot)
    if (url.endsWith('/event')) return sse.response
    throw new Error(`unexpected url ${url}`)
  })
  return { sse, fetchImpl }
}

function collectOpencode(tracker: OpencodeActivityTracker) {
  const collected = {
    changes: [] as Array<{
      upsert: unknown[]
      remove: string[]
      spontaneousExitRemovals?: string[]
      approvalPendingRemovals?: string[]
    }>,
    boundaries: [] as Array<{ terminalId: string; at: number }>,
    completions: [] as unknown[],
    // combined arrival-order log across streams (demote-before-boundary checks)
    order: [] as string[],
  }
  tracker.on('changed', (c) => {
    collected.changes.push(c)
    collected.order.push(c.remove.length > 0 ? 'changed:remove' : 'changed:upsert')
  })
  tracker.on('attention.boundary', (e) => {
    collected.boundaries.push(e)
    collected.order.push('boundary')
  })
  tracker.on('turn.complete', (e) => {
    collected.completions.push(e)
    collected.order.push('completion')
  })
  return collected
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
      upsert: [expect.objectContaining({
        terminalId: 'term-oc',
        sessionId: 'session-oc',
        phase: 'busy',
        updatedAt: expect.any(Number),
      })],
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
      completionSeq: 1,
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
      completionSeq: 1,
    }])
    expect(tracker.list()).toEqual([])
    expect(tracker.listLatestCompletions()).toEqual([{
      terminalId: 'term-oc',
      at: expect.any(Number),
      completionSeq: 1,
    }])

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

  it('expires stale busy records and refreshes lastObservedAt on later SSE observations', async () => {
    vi.useFakeTimers()
    let clock = 0
    let controlled: ReturnType<typeof createControlledSseResponse> | undefined
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
        controlled = createControlledSseResponse()
        return controlled.response
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const tracker = new OpencodeActivityTracker({
      fetchImpl: fetchImpl as typeof fetch,
      now: () => clock,
      random: () => 0,
    })
    const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
    tracker.on('changed', (payload) => changes.push(payload))

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)

    controlled?.enqueue({ type: 'server.connected', properties: {} })
    await vi.advanceTimersByTimeAsync(0)

    expect(tracker.list()).toEqual([expect.objectContaining({
      terminalId: 'term-oc',
      sessionId: 'session-oc',
      phase: 'busy',
      updatedAt: 0,
      lastObservedAt: 0,
    })])

    clock = OPENCODE_BUSY_DEADMAN_MS - 1
    controlled?.enqueue({
      type: 'session.status',
      properties: {
        sessionID: 'session-oc',
        status: { type: 'busy' },
      },
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(tracker.list()).toEqual([expect.objectContaining({
      terminalId: 'term-oc',
      lastObservedAt: OPENCODE_BUSY_DEADMAN_MS - 1,
    })])

    clock = OPENCODE_BUSY_DEADMAN_MS + 1
    tracker.expire(clock)
    expect(tracker.list()).toHaveLength(1)

    clock = (OPENCODE_BUSY_DEADMAN_MS * 2) + 1
    tracker.expire(clock)
    expect(changes).toContainEqual({
      upsert: [],
      remove: ['term-oc'],
    })
    expect(tracker.list()).toEqual([])

    tracker.dispose()
  })

  it('reconnects when the event stream stops yielding bytes', async () => {
    vi.useFakeTimers()
    let eventCalls = 0
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return createJsonResponse({ ok: true })
      }
      if (url.endsWith('/session/status')) {
        return createJsonResponse({})
      }
      if (url.endsWith('/event')) {
        eventCalls += 1
        return eventCalls === 1
          ? createControlledSseResponse().response
          : createSseResponse([{ type: 'server.connected', properties: {} }])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const log = { warn: vi.fn() }
    const tracker = new OpencodeActivityTracker({
      fetchImpl: fetchImpl as typeof fetch,
      log,
      random: () => 0,
    })

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: TEST_ENDPOINT })
    await vi.advanceTimersByTimeAsync(0)
    expect(eventCalls).toBe(1)

    await vi.advanceTimersByTimeAsync(OPENCODE_EVENT_READ_STALL_MS + OPENCODE_RECONNECT_BASE_MS)

    expect(eventCalls).toBe(2)
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: 'term-oc' }),
      'OpenCode activity tracker cycle failed; retrying.',
    )

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
      upsert: [expect.objectContaining({
        terminalId: 'term-oc',
        sessionId: 'session-oc',
        phase: 'busy',
        updatedAt: expect.any(Number),
      })],
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
      upsert: [expect.objectContaining({
        terminalId: 'term-oc',
        sessionId: 'session-oc',
        phase: 'busy',
        updatedAt: expect.any(Number),
      })],
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
      upsert: [expect.objectContaining({
        terminalId: 'term-oc',
        sessionId: 'session-oc',
        phase: 'busy',
        updatedAt: expect.any(Number),
      })],
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
      upsert: [expect.objectContaining({
        terminalId: 'term-opencode-1',
        sessionId: 'root_session',
        phase: 'busy',
        updatedAt: expect.any(Number),
      })],
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
      upsert: [expect.objectContaining({
        terminalId: 'term-oc',
        sessionId: 'parent-1',
        phase: 'busy',
        updatedAt: expect.any(Number),
      })],
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
      upsert: [expect.objectContaining({
        terminalId: 'term-oc',
        sessionId: 'parent-1',
        phase: 'busy',
        updatedAt: expect.any(Number),
      })],
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

  describe('abort/error episodes (policy: PR #597 extended to opencode)', () => {
    it('Esc/abort stays silent: MessageAbortedError then double idle emits no completion', async () => {
      vi.useFakeTimers()
      const sse = createControlledSseResponse()
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/global/health')) return createJsonResponse({ healthy: true })
        if (url.endsWith('/session/status')) return createJsonResponse({ 'ses-root': { type: 'busy' } })
        if (url.endsWith('/event')) return sse.response
        throw new Error(`unexpected url ${url}`)
      })
      const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
      const completions: unknown[] = []
      const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
      tracker.on('turn.complete', (e) => completions.push(e))
      tracker.on('changed', (c) => changes.push(c))
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT, sessionId: 'ses-root' })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0) // snapshot marks ses-root knownBusy
      // live abort trace (events-B.log): error -> status idle -> session.idle -> status idle -> session.idle
      sse.enqueue({ type: 'session.error', properties: { sessionID: 'ses-root', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } })
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-root', status: { type: 'idle' } } })
      sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-root' } })
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-root', status: { type: 'idle' } } })
      sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-root' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(completions).toEqual([])
      expect(changes.filter((c) => c.remove.length > 0)).toHaveLength(1) // one demotion, no double-remove
      tracker.dispose()
    })

    it('failed turn rings: UnknownError then idle emits exactly one completion; trailing error is a no-op', async () => {
      vi.useFakeTimers()
      const sse = createControlledSseResponse()
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/global/health')) return createJsonResponse({ healthy: true })
        if (url.endsWith('/session/status')) return createJsonResponse({ 'ses-root': { type: 'busy' } })
        if (url.endsWith('/event')) return sse.response
        throw new Error(`unexpected url ${url}`)
      })
      const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
      const completions: unknown[] = []
      tracker.on('turn.complete', (e) => completions.push(e))
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT, sessionId: 'ses-root' })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0) // snapshot marks ses-root knownBusy
      // events-B.log scenario C: busy -> error(UnknownError) -> status idle -> session.idle -> error AFTER idle
      sse.enqueue({ type: 'session.error', properties: { sessionID: 'ses-root', error: { name: 'UnknownError', data: { message: 'boom' } } } })
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-root', status: { type: 'idle' } } })
      sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-root' } })
      sse.enqueue({ type: 'session.error', properties: { sessionID: 'ses-root', error: { name: 'UnknownError', data: { message: 'boom', stack: 'Error: boom\n    at run' } } } })
      await vi.advanceTimersByTimeAsync(0)
      expect(completions).toHaveLength(1)
      expect(completions).toEqual([expect.objectContaining({ sessionId: 'ses-root' })])
      tracker.dispose()
    })

    it('child session.idle mid-parent-turn does not complete the root (live trace events-D.log)', async () => {
      vi.useFakeTimers()
      const sse = createControlledSseResponse()
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/global/health')) return createJsonResponse({ healthy: true })
        if (url.endsWith('/session/status')) return createJsonResponse({ 'ses-parent': { type: 'busy' } })
        if (url.endsWith('/event')) return sse.response
        throw new Error(`unexpected url ${url}`)
      })
      const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
      const completions: unknown[] = []
      tracker.on('turn.complete', (e) => completions.push(e))
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT, sessionId: 'ses-parent' })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0) // snapshot marks ses-parent knownBusy
      sse.enqueue({ type: 'session.created', properties: { sessionID: 'ses-child', info: { id: 'ses-child', parentID: 'ses-parent' } } })
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-child', status: { type: 'busy' } } })
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-child', status: { type: 'idle' } } })
      // child idle lands 921ms before the parent's (events-D.log) — must be suppressed
      sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-child' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(completions).toEqual([])
      expect(tracker.list()).toEqual([expect.objectContaining({
        terminalId: 'term-1',
        sessionId: 'ses-parent',
        phase: 'busy',
      })])
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-parent', status: { type: 'idle' } } })
      await vi.advanceTimersByTimeAsync(0)
      expect(completions).toHaveLength(1)
      expect(completions).toEqual([expect.objectContaining({ sessionId: 'ses-parent' })])
      tracker.dispose()
    })

    it('full events-D.log episode: child busy/idle mid-parent-turn yields exactly one parent completion and no early removal', async () => {
      // The codex sub-agent false-green analog, pinned end-to-end against the
      // full live trace (events-D.log, server-derived timings in comments).
      vi.useFakeTimers()
      const { sse, fetchImpl } = createControlledFetchFixture({ 'ses-parent': { type: 'busy' } })
      const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
      const collected = collectOpencode(tracker)
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT, sessionId: 'ses-parent' })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0) // snapshot marks ses-parent knownBusy, record present
      // 21:30:34.304 session.created child (info.parentID = 'ses-parent')
      sse.enqueue({ type: 'session.created', properties: { sessionID: 'ses-child', info: { id: 'ses-child', parentID: 'ses-parent' } } })
      // 21:30:34.344 session.status child busy
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-child', status: { type: 'busy' } } })
      // 21:30:36.089 session.status child idle
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-child', status: { type: 'idle' } } })
      // 21:30:36.089 session.idle child <- must NOT remove the record or complete
      sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-child' } })
      await vi.advanceTimersByTimeAsync(0)
      // no remove before the parent idle, no completion, record still busy
      expect(collected.completions).toEqual([])
      expect(collected.changes.filter((c) => c.remove.length > 0)).toEqual([])
      expect(tracker.list()).toEqual([expect.objectContaining({
        terminalId: 'term-1',
        sessionId: 'ses-parent',
        phase: 'busy',
      })])
      // 21:30:37.010 session.status parent idle <- the real edge
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-parent', status: { type: 'idle' } } })
      // 21:30:37.010 session.idle parent <- deduped
      sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-parent' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(collected.completions).toEqual([expect.objectContaining({ sessionId: 'ses-parent' })])
      expect(collected.changes.filter((c) => c.remove.length > 0)).toHaveLength(1)
      tracker.dispose()
    })

    it('child session.error does not abort the root turn', async () => {
      vi.useFakeTimers()
      const sse = createControlledSseResponse()
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/global/health')) return createJsonResponse({ healthy: true })
        if (url.endsWith('/session/status')) return createJsonResponse({ 'ses-parent': { type: 'busy' } })
        if (url.endsWith('/event')) return sse.response
        throw new Error(`unexpected url ${url}`)
      })
      const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
      const completions: unknown[] = []
      tracker.on('turn.complete', (e) => completions.push(e))
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT, sessionId: 'ses-parent' })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0) // snapshot marks ses-parent knownBusy
      sse.enqueue({ type: 'session.created', properties: { sessionID: 'ses-child', info: { id: 'ses-child', parentID: 'ses-parent' } } })
      // a sub-agent abort must not silence the parent's turn
      sse.enqueue({ type: 'session.error', properties: { sessionID: 'ses-child', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } })
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-parent', status: { type: 'idle' } } })
      await vi.advanceTimersByTimeAsync(0)
      expect(completions).toHaveLength(1)
      expect(completions).toEqual([expect.objectContaining({ sessionId: 'ses-parent' })])
      tracker.dispose()
    })

    it('W2 abort marker: message.updated carrying error MessageAbortedError then double idle is silent', async () => {
      vi.useFakeTimers()
      const sse = createControlledSseResponse()
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/global/health')) return createJsonResponse({ healthy: true })
        if (url.endsWith('/session/status')) return createJsonResponse({ 'ses-root': { type: 'busy' } })
        if (url.endsWith('/event')) return sse.response
        throw new Error(`unexpected url ${url}`)
      })
      const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
      const completions: unknown[] = []
      const changes: Array<{ upsert: unknown[]; remove: string[] }> = []
      tracker.on('turn.complete', (e) => completions.push(e))
      tracker.on('changed', (c) => changes.push(c))
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT, sessionId: 'ses-root' })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0) // snapshot marks ses-root knownBusy
      // abort window W2 — derives from opencode 1.18.11: an abort landing between
      // assistant-message creation and LLM stream start emits NO session.error,
      // only the abort-marked message.updated, always BEFORE idle
      sse.enqueue({ type: 'message.updated', properties: { sessionID: 'ses-root', info: { id: 'msg-1', role: 'assistant', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } } })
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-root', status: { type: 'idle' } } })
      sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-root' } })
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-root', status: { type: 'idle' } } })
      sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-root' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(completions).toEqual([])
      expect(changes.filter((c) => c.remove.length > 0)).toHaveLength(1) // one demotion, no double-remove
      tracker.dispose()
    })
  })

  describe('permission pause semantics (codex approval-pause mirror)', () => {
    async function setupKnownBusyPause() {
      vi.useFakeTimers()
      const { sse, fetchImpl } = createControlledFetchFixture({ 'ses-root': { type: 'busy' } })
      const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
      const collected = collectOpencode(tracker)
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT, sessionId: 'ses-root' })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0) // snapshot marks ses-root knownBusy, record present
      return { sse, tracker, collected }
    }

    it('permission.asked on the owned busy session demotes then arms the boundary once', async () => {
      const { sse, tracker, collected } = await setupKnownBusyPause()
      sse.enqueue({
        type: 'permission.asked',
        properties: { id: 'per-1', sessionID: 'ses-root', permission: 'bash', patterns: ['sleep 60'], metadata: {}, always: [] },
      })
      await vi.advanceTimersByTimeAsync(0)

      expect(collected.changes.filter((c) => c.remove.length > 0)).toEqual([
        { upsert: [], remove: ['term-1'] },
      ])
      expect(collected.boundaries).toEqual([{ terminalId: 'term-1', at: expect.any(Number) }])
      // demote FIRST, boundary SECOND (codex ordering): the gate must see
      // not-busy before it arms
      expect(collected.order.indexOf('changed:remove')).toBeGreaterThanOrEqual(0)
      expect(collected.order.indexOf('changed:remove')).toBeLessThan(collected.order.indexOf('boundary'))
      tracker.dispose()
    })

    it('duplicate permission.asked ids never re-arm', async () => {
      const { sse, tracker, collected } = await setupKnownBusyPause()
      sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-root' } })
      sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-root' } })
      await vi.advanceTimersByTimeAsync(0)

      expect(collected.boundaries).toHaveLength(1)
      tracker.dispose()
    })

    it('permission.replied resumes busy immediately (cancels within grace)', async () => {
      const { sse, tracker, collected } = await setupKnownBusyPause()
      sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-root' } })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'permission.replied', properties: { sessionID: 'ses-root', requestID: 'per-1', reply: 'once' } })
      await vi.advanceTimersByTimeAsync(0)

      expect(collected.changes.at(-1)).toEqual({
        upsert: [expect.objectContaining({ terminalId: 'term-1', sessionId: 'ses-root', phase: 'busy' })],
        remove: [],
      })
      tracker.dispose()
    })

    it('abort mid-pause force-emits the removal and mints nothing', async () => {
      const { sse, tracker, collected } = await setupKnownBusyPause()
      sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-root' } })
      await vi.advanceTimersByTimeAsync(0)
      // live abort trace (events-B.log): error -> status idle -> session.idle -> status idle -> session.idle
      sse.enqueue({ type: 'session.error', properties: { sessionID: 'ses-root', error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } } })
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-root', status: { type: 'idle' } } })
      sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-root' } })
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-root', status: { type: 'idle' } } })
      sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-root' } })
      await vi.advanceTimersByTimeAsync(0)

      expect(collected.completions).toEqual([])
      expect(collected.boundaries).toHaveLength(1) // no re-arm
      // the force-emit that cancels the armed grace window at the emitter:
      // a SECOND remove for term-1 even though the record was already gone
      expect(collected.changes.filter((c) => c.remove.length > 0)).toEqual([
        { upsert: [], remove: ['term-1'] },
        { upsert: [], remove: ['term-1'] },
      ])
      tracker.dispose()
    })

    it('failure mid-pause retires the pause without a second bell', async () => {
      const { sse, tracker, collected } = await setupKnownBusyPause()
      sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-root' } })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'session.error', properties: { sessionID: 'ses-root', error: { name: 'UnknownError', data: { message: 'boom' } } } })
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-root', status: { type: 'idle' } } })
      sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-root' } })
      await vi.advanceTimersByTimeAsync(0)

      expect(collected.completions).toEqual([]) // turnComplete swallowed: the pause bell was THE bell
      expect(collected.boundaries).toHaveLength(1)
      // NO second remove: the armed grace window is left to fire once
      expect(collected.changes.filter((c) => c.remove.length > 0)).toHaveLength(1)
      tracker.dispose()
    })

    it('child permission.asked root-resolves to the owned root and arms the pause', async () => {
      // SEMANTIC CHANGE vs raw-equality scoping: children CAN ask -- their asks
      // carry the CHILD sessionID and the parent turn blocks on them (opencode
      // v1.18.11 source, validation pass 2026-08-03).
      const { sse, tracker, collected } = await setupKnownBusyPause()
      sse.enqueue({ type: 'session.created', properties: { sessionID: 'ses-child', info: { id: 'ses-child', parentID: 'ses-root' } } })
      sse.enqueue({ type: 'permission.asked', properties: { id: 'per-c1', sessionID: 'ses-child' } })
      await vi.advanceTimersByTimeAsync(0)

      expect(collected.changes.filter((c) => c.remove.length > 0)).toEqual([
        { upsert: [], remove: ['term-1'] },
      ])
      expect(collected.boundaries).toEqual([{ terminalId: 'term-1', at: expect.any(Number) }])
      expect(collected.order.indexOf('changed:remove')).toBeGreaterThanOrEqual(0)
      expect(collected.order.indexOf('changed:remove')).toBeLessThan(collected.order.indexOf('boundary'))
      tracker.dispose()
    })

    it('permission.asked for a foreign/unresolvable session is ignored', async () => {
      const { sse, tracker, collected } = await setupKnownBusyPause()
      sse.enqueue({ type: 'permission.asked', properties: { id: 'per-x', sessionID: 'ses-other' } })
      await vi.advanceTimersByTimeAsync(0)

      expect(collected.boundaries).toEqual([])
      expect(collected.changes.filter((c) => c.remove.length > 0)).toEqual([]) // no demotion
      tracker.dispose()
    })

    it('candidate-armed pause: a first-turn ask on a fresh pane rings', async () => {
      vi.useFakeTimers()
      const { sse, fetchImpl } = createControlledFetchFixture({})
      const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
      const collected = collectOpencode(tracker)
      // fresh-pane fixture WITHOUT a resume session id
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0)
      // busy for ses-new -> candidate ownership (whole first turn by construction, D3)
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-new', status: { type: 'busy' } } })
      await vi.advanceTimersByTimeAsync(0)

      sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-new' } })
      await vi.advanceTimersByTimeAsync(0)

      expect(collected.changes.filter((c) => c.remove.length > 0)).toEqual([
        { upsert: [], remove: ['term-1'] },
      ])
      expect(collected.boundaries).toEqual([{ terminalId: 'term-1', at: expect.any(Number) }])
      expect(collected.order.indexOf('changed:remove')).toBeGreaterThanOrEqual(0)
      expect(collected.order.indexOf('changed:remove')).toBeLessThan(collected.order.indexOf('boundary'))

      sse.enqueue({ type: 'permission.replied', properties: { sessionID: 'ses-new', requestID: 'per-1', reply: 'once' } })
      await vi.advanceTimersByTimeAsync(0)

      expect(collected.changes.at(-1)).toEqual({
        upsert: [expect.objectContaining({ terminalId: 'term-1', sessionId: 'ses-new', phase: 'busy' })],
        remove: [],
      })
      tracker.dispose()
    })

    it('deferred completion after a candidate pause is swallowed at association confirm', async () => {
      vi.useFakeTimers()
      const { sse, fetchImpl } = createControlledFetchFixture({})
      const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
      const collected = collectOpencode(tracker)
      tracker.on('association.requested', (payload) => tracker.confirmSessionAssociation(payload))
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-new', status: { type: 'busy' } } })
      await vi.advanceTimersByTimeAsync(0)
      // candidate pause (no reply)
      sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-new' } })
      await vi.advanceTimersByTimeAsync(0)
      // idle edge (turn end mid-pause) -> tracker requests association,
      // handler above confirms it via confirmSessionAssociation
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-new', status: { type: 'idle' } } })
      await vi.advanceTimersByTimeAsync(0)

      // the deferred turnComplete minted at confirm is swallowed -- the pause
      // bell, rung or still in grace, was THE bell for this episode
      expect(collected.completions).toEqual([])
      expect(collected.boundaries).toHaveLength(1)
      // no force-emitted second remove: the grace window is left to fire once
      expect(collected.changes.filter((c) => c.remove.length > 0)).toHaveLength(1)
      tracker.dispose()
    })
  })

  describe('version drift gate (log-once)', () => {
    it('warns once for untested opencode versions and bells stay on', async () => {
      vi.useFakeTimers()
      let eventCalls = 0
      let healthCalls = 0
      const sse = createControlledSseResponse()
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/global/health')) {
          healthCalls += 1
          return createJsonResponse({ healthy: true, version: '9.9.9' })
        }
        if (url.endsWith('/session/status')) return createJsonResponse({})
        if (url.endsWith('/event')) {
          eventCalls += 1
          if (eventCalls === 1) {
            // first stream ends immediately so the reconnect cycle re-polls health
            return createSseResponse([{ type: 'server.connected', properties: {} }])
          }
          return sse.response
        }
        throw new Error(`unexpected url ${url}`)
      })
      const warnSpy = vi.fn()
      const log = { warn: warnSpy }
      const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, log, random: () => 0 })
      const completions: unknown[] = []
      tracker.on('turn.complete', (e) => completions.push(e))
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT, sessionId: 'ses-root' })
      await vi.advanceTimersByTimeAsync(0) // first cycle: health poll + stream that ends
      await vi.advanceTimersByTimeAsync(OPENCODE_RECONNECT_BASE_MS) // reconnect: second health poll
      expect(healthCalls).toBeGreaterThanOrEqual(2)
      const versionWarnings = warnSpy.mock.calls.filter((call) =>
        call.some((arg) => typeof arg === 'string' && arg.includes('9.9.9')))
      expect(versionWarnings).toHaveLength(1)
      expect(versionWarnings[0]?.some((arg) => typeof arg === 'string' && arg.includes('1.18.'))).toBe(true)

      // bells stay on — the gate only logs
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-root', status: { type: 'busy' } } })
      sse.enqueue({ type: 'session.idle', properties: { sessionID: 'ses-root' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(completions).toHaveLength(1)
      tracker.dispose()
    })
  })

  describe('death-bell markers on spontaneous exit', () => {
    async function setupKnownBusy() {
      vi.useFakeTimers()
      const { sse, fetchImpl } = createControlledFetchFixture({ 'ses-root': { type: 'busy' } })
      const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
      const collected = collectOpencode(tracker)
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT, sessionId: 'ses-root' })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0) // snapshot marks ses-root knownBusy, record present
      return { sse, tracker, collected }
    }

    it('spontaneous exit while knownBusy marks the removal', async () => {
      const { tracker, collected } = await setupKnownBusy()

      tracker.untrackTerminal({ terminalId: 'term-1', spontaneous: true })

      expect(collected.changes.at(-1)).toEqual({
        upsert: [],
        remove: ['term-1'],
        spontaneousExitRemovals: ['term-1'],
      })
    })

    it('spontaneous exit during a permission pause marks approvalPendingRemovals and emits despite the absent record', async () => {
      const { sse, tracker, collected } = await setupKnownBusy()
      sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-root' } })
      await vi.advanceTimersByTimeAsync(0) // pause entry already removed the record

      tracker.untrackTerminal({ terminalId: 'term-1', spontaneous: true })

      expect(collected.changes.at(-1)).toEqual({
        upsert: [],
        remove: ['term-1'],
        spontaneousExitRemovals: ['term-1'],
        approvalPendingRemovals: ['term-1'],
      })
    })

    it('spontaneous exit while candidate or ambiguous carries NO marker', async () => {
      vi.useFakeTimers()
      // candidate: busy for an unknown session on a pane with no resume id --
      // candidate for the ENTIRE first turn by construction (D4: candidate
      // noise is why opencode death bells were excluded before).
      {
        const { sse, fetchImpl } = createControlledFetchFixture({})
        const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
        const collected = collectOpencode(tracker)
        tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT })
        await vi.advanceTimersByTimeAsync(0)
        sse.enqueue({ type: 'server.connected', properties: {} })
        await vi.advanceTimersByTimeAsync(0)
        sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-new', status: { type: 'busy' } } })
        await vi.advanceTimersByTimeAsync(0)

        tracker.untrackTerminal({ terminalId: 'term-1', spontaneous: true })

        // plain removal of the candidate busy record -- no marker fields
        expect(collected.changes.at(-1)).toEqual({ upsert: [], remove: ['term-1'] })
        expect(collected.changes.some((c) => c.spontaneousExitRemovals !== undefined)).toBe(false)
      }
      // candidate WITH an armed permission pause: still no marker -- D4 keeps
      // candidate excluded even mid-pause (residual D8(i)).
      {
        const { sse, fetchImpl } = createControlledFetchFixture({})
        const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
        const collected = collectOpencode(tracker)
        tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT })
        await vi.advanceTimersByTimeAsync(0)
        sse.enqueue({ type: 'server.connected', properties: {} })
        await vi.advanceTimersByTimeAsync(0)
        sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-new', status: { type: 'busy' } } })
        sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-new' } })
        await vi.advanceTimersByTimeAsync(0)

        tracker.untrackTerminal({ terminalId: 'term-1', spontaneous: true })

        expect(collected.changes.some((c) => c.spontaneousExitRemovals !== undefined)).toBe(false)
        expect(collected.changes.some((c) => c.approvalPendingRemovals !== undefined)).toBe(false)
      }
      // ambiguous: two busy sessions with no resume id
      {
        const { sse, fetchImpl } = createControlledFetchFixture({})
        const log = { warn: vi.fn() }
        const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, log, random: () => 0 })
        const collected = collectOpencode(tracker)
        tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT })
        await vi.advanceTimersByTimeAsync(0)
        sse.enqueue({ type: 'server.connected', properties: {} })
        await vi.advanceTimersByTimeAsync(0)
        sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-a', status: { type: 'busy' } } })
        sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-b', status: { type: 'busy' } } })
        await vi.advanceTimersByTimeAsync(0)

        tracker.untrackTerminal({ terminalId: 'term-1', spontaneous: true })

        expect(collected.changes.at(-1)).toEqual({ upsert: [], remove: ['term-1'] })
        expect(collected.changes.some((c) => c.spontaneousExitRemovals !== undefined)).toBe(false)
      }
    })

    it('freshell-initiated untrack (no flag) behaves exactly as before', async () => {
      const { tracker, collected } = await setupKnownBusy()

      tracker.untrackTerminal({ terminalId: 'term-1' })

      expect(collected.changes.at(-1)).toEqual({ upsert: [], remove: ['term-1'] })
      expect(collected.changes.some((c) => c.spontaneousExitRemovals !== undefined)).toBe(false)
      expect(collected.changes.some((c) => c.approvalPendingRemovals !== undefined)).toBe(false)
    })

    it('spontaneous exit of a terminal that was never tracked emits NOTHING', async () => {
      // The wiring feeds EVERY registry terminal.exit (bash/claude/codex panes
      // included) through untrackTerminal; untracked terminals must stay as
      // silent as today (removeRecord's existence guard).
      const tracker = new OpencodeActivityTracker({ random: () => 0 })
      const collected = collectOpencode(tracker)

      tracker.untrackTerminal({ terminalId: 'term-9', spontaneous: true })

      expect(collected.changes).toEqual([])
      tracker.dispose()
    })

    it('awaitingAssociation with pending permission + spontaneous exit does NOT ring death-bell (death_predicates mirror)', async () => {
      // Rust blocks_death_bell excludes awaitingAssociation because the
      // candidate pause's continuation claim must survive into awaitingAssociation
      // to avoid leaking into the death-bell window. Node must mirror this:
      // fresh unbound pane -> candidate-armed pause -> turn ends mid-pause
      // (claim deliberately survives) -> ownership moves to awaitingAssociation
      // -> spontaneous exit: MUST NOT ring (D4/D8(i) adjudicate silence).
      vi.useFakeTimers()
      const { sse, fetchImpl } = createControlledFetchFixture({})
      const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
      const collected = collectOpencode(tracker)

      // Fresh unbound pane (no resumeId) -> first turn candidate by construction
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0) // snapshot empty -> quiet (no session)
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-a', status: { type: 'busy' } } })
      await vi.advanceTimersByTimeAsync(0) // first-turn candidate busy

      // Candidate-armed pause (pending permission)
      sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-a' } })
      await vi.advanceTimersByTimeAsync(0) // pause enters, claim alive

      // Turn ends mid-pause (turn completion lands while pause is active)
      // The claim deliberately survives into awaitingAssociation
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-a', status: { type: 'idle' } } })
      await vi.advanceTimersByTimeAsync(0) // awaiting association state, claim still alive

      // Spontaneous exit while in awaitingAssociation with pending permissions
      tracker.untrackTerminal({ terminalId: 'term-1', spontaneous: true })

      // MUST NOT have spontaneousExitRemovals marker (death-bell must not ring)
      expect(collected.changes.at(-1)).toEqual({
        upsert: [],
        remove: ['term-1'],
        // NO spontaneousExitRemovals marker because awaitingAssociation is excluded
      })
      expect(collected.changes.at(-1)?.spontaneousExitRemovals).toBeUndefined()
      tracker.dispose()
    })

    it('after rejectSessionAssociation, pending-permission claim is cleared and subsequent spontaneous exit is silent', async () => {
      // Rust reject arm clears pending_permissions to prevent stale pause claim
      // from leaking into the death-bell window. Node must mirror this (Finding 2).
      // Scenario: candidate pause rejected -> permission claim must be gone
      // -> spontaneous exit has no approvalPendingRemovals marker.
      vi.useFakeTimers()
      const { sse, fetchImpl } = createControlledFetchFixture({ 'ses-root': { type: 'busy' } })
      const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
      const collected = collectOpencode(tracker)

      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT, sessionId: 'ses-root' })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0) // snapshot marks ses-root knownBusy

      // Arm a permission pause on the known-busy session
      sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-root' } })
      await vi.advanceTimersByTimeAsync(0) // pause enters, claim alive

      // Transition through awaitingAssociation when turn ends
      sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-root', status: { type: 'idle' } } })
      await vi.advanceTimersByTimeAsync(0) // awaiting association, claim still alive

      // Reject the association (simulates rejection from SDK or UI)
      tracker.rejectSessionAssociation({ terminalId: 'term-1', sessionId: 'ses-root' })
      await vi.advanceTimersByTimeAsync(0) // transitions to quiet, claim MUST be cleared

      // Verify that the claim was cleared by checking a subsequent spontaneous exit
      tracker.untrackTerminal({ terminalId: 'term-1', spontaneous: true })

      // NO approvalPendingRemovals marker because the claim was cleared by reject
      expect(collected.changes.at(-1)).toEqual({
        upsert: [],
        remove: ['term-1'],
        spontaneousExitRemovals: ['term-1'],
        // NO approvalPendingRemovals because the claim was cleared
      })
      expect(collected.changes.at(-1)?.approvalPendingRemovals).toBeUndefined()
      tracker.dispose()
    })

    it('rejectSessionAssociation with mismatched sessionId is no-op (pending-permission claim preserved)', async () => {
      // Finding 2: rejectSessionAssociation clears the pending-permission claim
      // ONLY when the rejection matches the pre-reducer ownership state
      // (awaitingAssociation + matching sessionId). Both mismatch arms of that
      // gate are pinned here against the unconditional clear it replaced.
      //
      // Arm 1 -- ownership-KIND mismatch: a live knownBusy pause (ask armed,
      // turn NOT ended -- a knownBusy idle edge would retire the claim as the
      // episode's bell via applyActions' mid-pause turn-end branch, so the
      // claim only survives while the turn is still open). The mismatched
      // reject must leave the claim alive, so a subsequent spontaneous exit
      // still carries the approval-pending death-bell marker.
      {
        const { sse, tracker, collected } = await setupKnownBusy()
        sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-root' } })
        await vi.advanceTimersByTimeAsync(0) // pause armed: claim alive, ownership still knownBusy(ses-root)

        tracker.rejectSessionAssociation({ terminalId: 'term-1', sessionId: 'ses-other' })

        tracker.untrackTerminal({ terminalId: 'term-1', spontaneous: true })

        expect(collected.changes.at(-1)).toEqual({
          upsert: [],
          remove: ['term-1'],
          spontaneousExitRemovals: ['term-1'],
          approvalPendingRemovals: ['term-1'],
        })
      }
      // Arm 2 -- SESSION-ID mismatch with matching kind: a candidate pause
      // whose claim deliberately survives the idle edge into
      // awaitingAssociation(ses-a). Rejecting a DIFFERENT sessionId must not
      // clear the claim. Survival is observable because the deferred
      // completion minted at the matching confirm is swallowed while the
      // claim is alive (the pause bell was THE bell); had the mismatched
      // reject cleared the claim, confirm would emit turn.complete.
      {
        const { sse, fetchImpl } = createControlledFetchFixture({})
        const tracker = new OpencodeActivityTracker({ fetchImpl: fetchImpl as typeof fetch, random: () => 0 })
        const collected = collectOpencode(tracker)
        tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT })
        await vi.advanceTimersByTimeAsync(0)
        sse.enqueue({ type: 'server.connected', properties: {} })
        await vi.advanceTimersByTimeAsync(0)
        sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-a', status: { type: 'busy' } } })
        await vi.advanceTimersByTimeAsync(0) // first-turn candidate busy
        sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-a' } })
        await vi.advanceTimersByTimeAsync(0) // candidate-armed pause, claim alive
        sse.enqueue({ type: 'session.status', properties: { sessionID: 'ses-a', status: { type: 'idle' } } })
        await vi.advanceTimersByTimeAsync(0) // awaitingAssociation(ses-a), claim survives (D8(i))

        tracker.rejectSessionAssociation({ terminalId: 'term-1', sessionId: 'ses-other' })
        tracker.confirmSessionAssociation({ terminalId: 'term-1', sessionId: 'ses-a' })

        // Claim survived the mismatched reject: the deferred completion is swallowed.
        expect(collected.completions).toEqual([])
        expect(collected.boundaries).toHaveLength(1) // the pause bell stays the episode's only bell
        tracker.dispose()
      }
    })
  })

  describe('TOCTOU fix verification', () => {
    it('permission.asked reads ownership AFTER root resolution: mid-await invalidation stays silent', async () => {
      // Commit 48e4966cd moved the permission.asked handler's ownership read
      // to AFTER the async root-resolution await. Pin the ordering: ownership
      // invalidated while the resolver is in flight must gate the pause (no
      // boundary, no claim). With the pre-fix ordering (read before await)
      // the handler arms from the STALE knownBusy snapshot and rings.
      vi.useFakeTimers()
      const { sse, fetchImpl } = createControlledFetchFixture({ 'ses-root': { type: 'busy' } })
      const resolverCalls: string[][] = []
      let releaseChildResolution: ((resolution: OpencodeRootResolution) => void) | undefined
      const resolveOpencodeSessionRoots = async (
        sessionIds: readonly string[],
      ): Promise<OpencodeRootResolution> => {
        resolverCalls.push([...sessionIds])
        if (sessionIds.includes('ses-child')) {
          // Hold the child lookup open: this suspension is the TOCTOU window.
          return await new Promise<OpencodeRootResolution>((resolve) => {
            releaseChildResolution = resolve
          })
        }
        // Snapshot lookups (ses-root) resolve immediately as identity roots.
        return {
          rootsBySessionId: new Map(sessionIds.map((sessionId) => [sessionId, sessionId])),
          unresolvedSessionIds: new Set<string>(),
        }
      }
      const tracker = new OpencodeActivityTracker({
        fetchImpl: fetchImpl as typeof fetch,
        random: () => 0,
        resolveOpencodeSessionRoots,
      })
      const collected = collectOpencode(tracker)
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT, sessionId: 'ses-root' })
      await vi.advanceTimersByTimeAsync(0)
      sse.enqueue({ type: 'server.connected', properties: {} })
      await vi.advanceTimersByTimeAsync(0) // snapshot marks ses-root knownBusy, record present

      // A child ask that needs root resolution: the handler suspends on the
      // held resolver promise ('ses-child' is not in the child->root map).
      sse.enqueue({ type: 'permission.asked', properties: { id: 'per-1', sessionID: 'ses-child' } })
      await vi.advanceTimersByTimeAsync(0)
      expect(resolverCalls).toContainEqual(['ses-child']) // suspended inside the TOCTOU window
      expect(collected.boundaries).toEqual([]) // nothing armed while suspended

      // Invalidate ownership mid-await: re-tracking the same endpoint resets
      // ownership to quiet synchronously. (reject/confirmSessionAssociation
      // only act on awaitingAssociation, so they CANNOT invalidate knownBusy;
      // re-track is the public synchronous transition out of it.)
      tracker.trackTerminal({ terminalId: 'term-1', endpoint: TEST_ENDPOINT, sessionId: 'ses-root' })

      // Release the held resolution, mapping the child onto the now-stale root.
      if (!releaseChildResolution) throw new Error('resolver was never suspended on ses-child')
      releaseChildResolution({
        rootsBySessionId: new Map([['ses-child', 'ses-root']]),
        unresolvedSessionIds: new Set<string>(),
      })
      await vi.advanceTimersByTimeAsync(0)

      // Post-await ownership is quiet: the gate must stay silent -- no
      // boundary and no pause demotion (the busy record is left in place).
      expect(collected.boundaries).toEqual([])
      expect(collected.changes.filter((c) => c.remove.length > 0)).toEqual([])

      // And no pause claim was armed: the spontaneous exit carries the plain
      // death-bell marker with NO approval-pending marker.
      tracker.untrackTerminal({ terminalId: 'term-1', spontaneous: true })
      expect(collected.changes.at(-1)).toEqual({
        upsert: [],
        remove: ['term-1'],
        spontaneousExitRemovals: ['term-1'],
      })
    })
  })
})

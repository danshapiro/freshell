// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpencodeActivityIntegration } from '../../../../server/coding-cli/opencode-activity-integration.js'
import { wireOpencodeActivityTracker } from '../../../../server/coding-cli/opencode-activity-wiring.js'
import { OPENCODE_ACTIVITY_SWEEP_MS } from '../../../../server/coding-cli/opencode-activity-tracker.js'

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

function makeRegistry(record: any, options: { includeInList?: boolean } = {}) {
  const registry = new EventEmitter() as any
  registry.list = vi.fn(() => (options.includeInList ? [{ terminalId: record.terminalId }] : []))
  registry.get = vi.fn((terminalId: string) => (
    terminalId === record.terminalId ? record : undefined
  ))
  registry.bindSession = vi.fn(() => ({ ok: true }))
  registry.rebindSession = vi.fn(() => ({ ok: true }))
  return registry
}

describe('wireOpencodeActivityTracker', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('notifies lifecycle callbacks for association', () => {
    const terminal = {
      terminalId: 'term-opencode-1',
      mode: 'opencode',
      status: 'running',
      resumeSessionId: undefined,
      opencodeServer: { hostname: '127.0.0.1', port: 32123 },
    }
    const registry = makeRegistry(terminal)
    const now = vi.fn(() => 12_345)
    const onAssociated = vi.fn()
    const wired = wireOpencodeActivityTracker({
      registry,
      now,
      onAssociated,
    })

    try {
      wired.tracker.emit('association.requested', {
        terminalId: 'term-opencode-1',
        sessionId: 'ses_open_1',
      })

      expect(onAssociated).toHaveBeenCalledWith({
        terminalId: 'term-opencode-1',
        sessionId: 'ses_open_1',
      })
    } finally {
      wired.dispose()
    }
  })

  it('schedules a stale-activity sweep and clears it on dispose', () => {
    const terminal = {
      terminalId: 'term-opencode-1',
      mode: 'opencode',
      status: 'running',
      resumeSessionId: undefined,
      opencodeServer: { hostname: '127.0.0.1', port: 32123 },
    }
    const registry = makeRegistry(terminal)
    const intervalHandles: Array<{ run: () => void; delayMs: number }> = []
    const setIntervalFn = vi.fn((run: () => void, delayMs?: number) => {
      const handle = { run, delayMs: delayMs ?? 0 }
      intervalHandles.push(handle)
      return handle as unknown as ReturnType<typeof setInterval>
    })
    const clearIntervalFn = vi.fn()
    const now = vi.fn(() => 456)
    const wired = wireOpencodeActivityTracker({
      registry,
      now,
      setIntervalFn,
      clearIntervalFn,
    })
    const expireSpy = vi.spyOn(wired.tracker, 'expire')

    try {
      expect(setIntervalFn).toHaveBeenCalledTimes(1)
      expect(intervalHandles[0]?.delayMs).toBe(OPENCODE_ACTIVITY_SWEEP_MS)

      intervalHandles[0]?.run()
      expect(expireSpy).toHaveBeenCalledWith(456)
    } finally {
      wired.dispose()
    }

    expect(clearIntervalFn).toHaveBeenCalledWith(intervalHandles[0])
  })

  it('uses the production provider resolver before binding OpenCode activity to a durable session', async () => {
    vi.useFakeTimers()
    const terminal = {
      terminalId: 'term-opencode-1',
      mode: 'opencode',
      status: 'running',
      resumeSessionId: undefined,
      opencodeServer: { hostname: '127.0.0.1', port: 32123 },
    }
    const registry = makeRegistry(terminal, { includeInList: true })
    const resolveOpencodeSessionRoots = vi.fn(async (sessionIds: readonly string[]) => ({
      rootsBySessionId: new Map(sessionIds.map((sessionId) => [sessionId, 'ses-root-1'])),
      unresolvedSessionIds: new Set<string>(),
    }))
    const opencodeProvider = { resolveOpencodeSessionRoots }
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return createJsonResponse({ ok: true })
      if (url.endsWith('/session/status')) {
        return createJsonResponse({
          'ses-child-1': { type: 'busy' },
        })
      }
      if (url.endsWith('/event')) {
        return createSseResponse([
          { type: 'server.connected', properties: {} },
          {
            type: 'session.idle',
            properties: {
              sessionID: 'ses-child-1',
            },
          },
        ])
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    const wired = createOpencodeActivityIntegration({
      registry,
      opencodeProvider,
      fetchImpl: fetchImpl as typeof fetch,
      random: () => 0,
    })

    try {
      await vi.advanceTimersByTimeAsync(0)

      expect(resolveOpencodeSessionRoots).toHaveBeenCalledWith(['ses-child-1'])
      expect(registry.bindSession).toHaveBeenCalledWith(
        'term-opencode-1',
        'opencode',
        'ses-root-1',
        'association',
      )
      expect(registry.bindSession).not.toHaveBeenCalledWith(
        'term-opencode-1',
        'opencode',
        'ses-child-1',
        expect.anything(),
      )
    } finally {
      wired.dispose()
    }
  })
})

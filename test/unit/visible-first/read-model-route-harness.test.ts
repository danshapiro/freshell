import { afterEach, describe, expect, it } from 'vitest'
import { createReadModelRouteHarness } from '@test/helpers/visible-first/read-model-route-harness'

describe('createReadModelRouteHarness', () => {
  let harness: Awaited<ReturnType<typeof createReadModelRouteHarness>> | null = null

  afterEach(async () => {
    await harness?.dispose()
    harness = null
  })

  it('mounts authenticated read-model routes and records scheduler, revision, byte, and abort telemetry', async () => {
    harness = await createReadModelRouteHarness({
      bootstrap: async () => ({
        body: {
          settings: { theme: 'light' },
          shell: { authenticated: true, ready: true },
        },
        revision: 1,
      }),
      sessionDirectory: async ({ searchParams }) => ({
        body: {
          revision: 7,
          items: [{ sessionId: 'session-1', title: 'Alpha' }],
          nextCursor: null,
          query: searchParams.get('query') ?? '',
        },
        revision: 7,
      }),
      freshAgentTurns: async () => ({
        body: {
          revision: 11,
          items: [{ turnId: 'turn-1', summary: 'Recent turn' }],
        },
        revision: 11,
      }),
      terminalViewport: async ({ signal }) => {
        await new Promise<never>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        })
      },
    })

    const unauthenticated = await harness.fetchJson('/api/bootstrap', { authenticated: false })
    expect(unauthenticated.status).toBe(401)

    const bootstrap = await harness.fetchJson('/api/bootstrap')
    expect(bootstrap.status).toBe(200)
    expect(bootstrap.body).toMatchObject({
      shell: { authenticated: true, ready: true },
    })

    const directory = await harness.fetchJson('/api/session-directory?priority=visible&query=alpha&limit=1')
    expect(directory.status).toBe(200)
    expect(directory.body).toMatchObject({
      revision: 7,
      query: 'alpha',
    })

    const timeline = await harness.fetchJson('/api/fresh-agent/threads/freshclaude/claude/session-1/turns?priority=background&revision=11')
    expect(timeline.status).toBe(200)
    expect(timeline.body).toMatchObject({
      revision: 11,
    })

    const abortController = new AbortController()
    const viewportRequest = harness.fetch('/api/terminals/term-1/viewport?priority=critical', {
      signal: abortController.signal,
    })
    const viewportRejection = expect(viewportRequest).rejects.toThrow()

    await harness.waitForCall('terminal.viewport')
    abortController.abort()
    await harness.waitForAbort('terminal.viewport')

    await viewportRejection

    expect(harness.getSchedulerEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ route: 'bootstrap', lane: 'critical', phase: 'start' }),
        expect.objectContaining({ route: 'bootstrap', lane: 'critical', phase: 'complete' }),
        expect.objectContaining({ route: 'session-directory', lane: 'visible', phase: 'complete' }),
        expect.objectContaining({ route: 'fresh-agent.turns', lane: 'background', phase: 'complete' }),
        expect.objectContaining({ route: 'terminal.viewport', lane: 'critical', phase: 'abort' }),
      ]),
    )
    expect(harness.getRevisionLog()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ route: 'bootstrap', revision: 1 }),
        expect.objectContaining({ route: 'session-directory', revision: 7 }),
        expect.objectContaining({ route: 'fresh-agent.turns', revision: 11 }),
      ]),
    )
    expect(harness.getResponseBytes('/api/bootstrap')).toBeGreaterThan(0)
    expect(harness.getAbortLog()).toEqual(
      expect.arrayContaining([expect.objectContaining({ route: 'terminal.viewport' })]),
    )
  })
})

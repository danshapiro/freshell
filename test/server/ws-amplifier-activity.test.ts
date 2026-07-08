import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'http'
import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

vi.mock('../../server/config-store', () => ({
  configStore: {
    snapshot: vi.fn().mockResolvedValue({
      version: 1,
      settings: {},
      sessionOverrides: {},
      terminalOverrides: {},
      projectColors: {},
    }),
  },
}))

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind test server'))
        return
      }
      resolve(address.port)
    })
  })
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error('Timed out waiting for websocket message'))
    }, timeoutMs)

    const onMessage = (raw: WebSocket.Data) => {
      const msg = JSON.parse(raw.toString())
      if (!predicate(msg)) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      resolve(msg)
    }

    ws.on('message', onMessage)
  })
}

function expectNoMatchingMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 250): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage)
      resolve()
    }, timeoutMs)

    const onMessage = (raw: WebSocket.Data) => {
      const msg = JSON.parse(raw.toString())
      if (!predicate(msg)) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      reject(new Error(`Unexpected websocket message: ${JSON.stringify(msg)}`))
    }

    ws.on('message', onMessage)
  })
}

class FakeRegistry {
  list() {
    return []
  }
  get() { return null }
  create() { throw new Error('not used') }
  attach() { return null }
  finishAttachSnapshot() {}
  detach() { return false }
  input() { return false }
  resize() { return false }
  kill() { return false }
  findRunningClaudeTerminalBySession() { return undefined }
}

describe('ws amplifier activity protocol', () => {
  let server: http.Server
  let port: number
  let wsHandler: any
  const sampleActivity = [{
    terminalId: 'term-1',
    sessionId: 'session-1',
    phase: 'busy',
    updatedAt: 1234,
  }]
  const latestTurnCompletions = [{
    terminalId: 'term-1',
    at: 4321,
    completionSeq: 2,
  }]

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'amplifier-activity-token'

    const { WsHandler } = await import('../../server/ws-handler')
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    wsHandler = new WsHandler(
      server,
      new FakeRegistry() as any,
      {
        amplifierActivityListProvider: () => sampleActivity as any,
        amplifierLatestTurnCompletionsProvider: () => latestTurnCompletions,
      },
    )
    port = await listen(server)
  })

  afterAll(async () => {
    wsHandler?.close?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('returns amplifier.activity.list.response for amplifier.activity.list requests', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'amplifier-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready')

    ws.send(JSON.stringify({ type: 'amplifier.activity.list', requestId: 'req-amplifier-1' }))
    const response = await waitForMessage(
      ws,
      (msg) => msg.type === 'amplifier.activity.list.response' && msg.requestId === 'req-amplifier-1',
    )

    expect(response.terminals).toEqual(sampleActivity)
    expect(response.latestTurnCompletions).toEqual(latestTurnCompletions)
    ws.close()
  })

  it('broadcasts amplifier.activity.updated payloads', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'amplifier-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready')

    wsHandler.broadcastAmplifierActivityUpdated({
      upsert: sampleActivity as any,
      remove: [],
    })

    const updated = await waitForMessage(ws, (msg) => msg.type === 'amplifier.activity.updated')
    expect(updated).toEqual({
      type: 'amplifier.activity.updated',
      upsert: sampleActivity,
      remove: [],
    })
    ws.close()
  })

  it('does not broadcast amplifier.activity.updated payloads to unauthenticated sockets', async () => {
    const authenticated = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    await Promise.all([
      new Promise<void>((resolve) => authenticated.on('open', () => resolve())),
      new Promise<void>((resolve) => unauthenticated.on('open', () => resolve())),
    ])

    authenticated.send(JSON.stringify({ type: 'hello', token: 'amplifier-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(authenticated, (msg) => msg.type === 'ready')

    wsHandler.broadcastAmplifierActivityUpdated({
      upsert: sampleActivity as any,
      remove: [],
    })

    const updated = await waitForMessage(authenticated, (msg) => msg.type === 'amplifier.activity.updated')
    expect(updated).toEqual({
      type: 'amplifier.activity.updated',
      upsert: sampleActivity,
      remove: [],
    })

    await expect(expectNoMatchingMessage(unauthenticated, (msg) => msg.type === 'amplifier.activity.updated')).resolves.toBeUndefined()

    authenticated.close()
    unauthenticated.close()
  })

  it('broadcasts terminal.turn.complete(provider=amplifier) only to authenticated sockets', async () => {
    const authenticated = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}/ws`)

    await Promise.all([
      new Promise<void>((resolve) => authenticated.on('open', () => resolve())),
      new Promise<void>((resolve) => unauthenticated.on('open', () => resolve())),
    ])

    authenticated.send(JSON.stringify({ type: 'hello', token: 'amplifier-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(authenticated, (msg) => msg.type === 'ready')

    wsHandler.broadcastTerminalTurnComplete({
      provider: 'amplifier',
      terminalId: 'term-amplifier',
      at: 1234,
      completionSeq: 1,
    })

    const completed = await waitForMessage(authenticated, (msg) => msg.type === 'terminal.turn.complete')
    expect(completed).toEqual({
      type: 'terminal.turn.complete',
      provider: 'amplifier',
      terminalId: 'term-amplifier',
      at: 1234,
      completionSeq: 1,
    })

    await expect(expectNoMatchingMessage(unauthenticated, (msg) => msg.type === 'terminal.turn.complete')).resolves.toBeUndefined()

    authenticated.close()
    unauthenticated.close()
  })
})

// ---------------------------------------------------------------------------
// Events-driven integration over the wire (plan 2026-07-08 §9 Phase 2): real
// tracker + wiring + integration composed exactly like server/index.ts, with
// injected fs/watch fakes standing in for events.jsonl and chokidar.
// ---------------------------------------------------------------------------

const AMP_SCHEMA = '"schema": {"name": "amplifier.log", "ver": "1.0.0"}'

function eventsLine(event: string): string {
  return `{"ts": "${new Date().toISOString()}", "lvl": "INFO", ${AMP_SCHEMA}, `
    + `"event": "${event}", "session_id": "session-ev", "data": {"parent_id": null}}\n`
}

function createFakeEventsFs() {
  const files = new Map<string, Buffer>()
  const statFailures = new Set<string>()
  return {
    fsImpl: {
      async stat(path: string) {
        if (statFailures.has(path)) throw new Error('EIO: injected stat failure')
        const content = files.get(path)
        if (!content) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return { size: content.length }
      },
      async open(path: string) {
        return {
          async read(buffer: Buffer, offset: number, length: number, position: number) {
            const content = files.get(path) ?? Buffer.alloc(0)
            const slice = content.subarray(position, position + length)
            slice.copy(buffer, offset)
            return { bytesRead: slice.length }
          },
          async close() {},
        }
      },
    },
    write(path: string, text: string) {
      files.set(path, Buffer.from(text, 'utf8'))
    },
    append(path: string, text: string) {
      files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), Buffer.from(text, 'utf8')]))
    },
    failStat(path: string) {
      statFailures.add(path)
    },
  }
}

type FakeEventsWatcher = {
  watchedPath: string
  closed: boolean
  on(event: string, handler: (...args: any[]) => void): FakeEventsWatcher
  close(): Promise<void>
  fire(event: string, path: string): void
}

function createFakeWatchFactory() {
  const watchers: FakeEventsWatcher[] = []
  const factory = (watchedPath: string) => {
    const handlers = new Map<string, Array<(...args: any[]) => void>>()
    const watcher: FakeEventsWatcher = {
      watchedPath,
      closed: false,
      on(event, handler) {
        const list = handlers.get(event) ?? []
        list.push(handler)
        handlers.set(event, list)
        return watcher
      },
      async close() {
        watcher.closed = true
      },
      fire(event, path) {
        for (const handler of handlers.get(event) ?? []) handler(path)
      },
    }
    watchers.push(watcher)
    return watcher
  }
  return { factory, watchers }
}

async function flushAsync(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out in waitUntil')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

class EventedFakeRegistry extends EventEmitter {
  list() {
    return []
  }
  get() { return null }
  create() { throw new Error('not used') }
  attach() { return null }
  finishAttachSnapshot() {}
  detach() { return false }
  input() { return false }
  resize() { return false }
  kill() { return false }
  findRunningClaudeTerminalBySession() { return undefined }
}

describe('ws amplifier events-driven activity', () => {
  let server: http.Server
  let port: number
  let wsHandler: any
  let registry: EventedFakeRegistry
  let amplifierActivity: any
  let integration: any
  const fsStore = createFakeEventsFs()
  const watch = createFakeWatchFactory()
  const warn = vi.fn()
  const eventsPathBySession: Record<string, string> = {
    's-ev1': '/fake/amp/sessions/s-ev1/events.jsonl',
    's-ev2': '/fake/amp/sessions/s-ev2/events.jsonl',
  }

  async function connect(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve) => ws.on('open', () => resolve()))
    ws.send(JSON.stringify({ type: 'hello', token: 'amplifier-activity-token', protocolVersion: WS_PROTOCOL_VERSION }))
    await waitForMessage(ws, (msg) => msg.type === 'ready')
    return ws
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'amplifier-activity-token'

    const { WsHandler } = await import('../../server/ws-handler')
    const { wireAmplifierActivityTracker } = await import('../../server/coding-cli/amplifier-activity-wiring')
    const { createAmplifierActivityIntegration } = await import('../../server/coding-cli/amplifier-activity-integration')

    registry = new EventedFakeRegistry()
    amplifierActivity = wireAmplifierActivityTracker({ registry: registry as any })
    integration = createAmplifierActivityIntegration({
      registry: registry as any,
      tracker: amplifierActivity.tracker,
      resolveEventsPath: (sessionId: string) => eventsPathBySession[sessionId],
      log: { warn },
      watchImpl: watch.factory as any,
      fsImpl: fsStore.fsImpl as any,
    })

    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    wsHandler = new WsHandler(
      server,
      registry as any,
      {
        amplifierActivityListProvider: () => amplifierActivity.tracker.list(),
        amplifierLatestTurnCompletionsProvider: () => amplifierActivity.tracker.listLatestCompletions(),
      },
    )
    // Mirror server/index.ts composition: tracker events → WS broadcasts.
    amplifierActivity.tracker.on('changed', (payload: any) => {
      wsHandler.broadcastAmplifierActivityUpdated(payload)
    })
    amplifierActivity.tracker.on('turn.complete', (payload: any) => {
      wsHandler.broadcastTerminalTurnComplete({
        provider: 'amplifier',
        terminalId: payload.terminalId,
        at: payload.at,
        completionSeq: payload.completionSeq,
        ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
      })
    })
    port = await listen(server)
  })

  afterAll(async () => {
    await integration?.dispose?.()
    amplifierActivity?.dispose?.()
    wsHandler?.close?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('drives busy on prompt:submit and exactly one terminal.turn.complete on prompt:complete; naming records never re-busy', async () => {
    const ws = await connect()

    // Resume bind → EOF attach on the pre-existing events file (no replay).
    fsStore.write(eventsPathBySession['s-ev1'], eventsLine('session:start') + eventsLine('session:config'))
    registry.emit('terminal.session.bound', {
      terminalId: 'term-ev1',
      provider: 'amplifier',
      sessionId: 's-ev1',
      reason: 'resume',
    })
    await waitUntil(() => watch.watchers.some((w) => w.watchedPath === '/fake/amp/sessions/s-ev1'))
    await flushAsync()

    fsStore.append(eventsPathBySession['s-ev1'], eventsLine('prompt:submit'))
    watch.watchers.find((w) => w.watchedPath === '/fake/amp/sessions/s-ev1')!.fire('change', eventsPathBySession['s-ev1'])
    const busy = await waitForMessage(ws, (msg) =>
      msg.type === 'amplifier.activity.updated'
      && msg.upsert?.some((record: any) => record.terminalId === 'term-ev1' && record.phase === 'busy'))
    expect(busy.upsert[0]).toMatchObject({ terminalId: 'term-ev1', sessionId: 's-ev1', phase: 'busy' })

    fsStore.append(eventsPathBySession['s-ev1'], eventsLine('prompt:complete'))
    watch.watchers.find((w) => w.watchedPath === '/fake/amp/sessions/s-ev1')!.fire('change', eventsPathBySession['s-ev1'])
    const completed = await waitForMessage(ws, (msg) =>
      msg.type === 'terminal.turn.complete' && msg.terminalId === 'term-ev1')
    expect(completed).toMatchObject({
      provider: 'amplifier',
      terminalId: 'term-ev1',
      sessionId: 's-ev1',
      completionSeq: 1,
    })

    // Post-complete background naming events (E2): no re-busy, no second completion.
    fsStore.append(eventsPathBySession['s-ev1'], eventsLine('llm:request') + eventsLine('provider:retry'))
    watch.watchers.find((w) => w.watchedPath === '/fake/amp/sessions/s-ev1')!.fire('change', eventsPathBySession['s-ev1'])
    await expect(expectNoMatchingMessage(ws, (msg) =>
      (msg.type === 'amplifier.activity.updated'
        && msg.upsert?.some((record: any) => record.terminalId === 'term-ev1' && record.phase === 'busy'))
      || (msg.type === 'terminal.turn.complete' && msg.terminalId === 'term-ev1'))).resolves.toBeUndefined()

    ws.close()
  })

  it('tailer failure mid-turn reverts the phase to idle with NO turn.complete (single degrade warn)', async () => {
    const ws = await connect()

    fsStore.write(eventsPathBySession['s-ev2'], eventsLine('session:start'))
    registry.emit('terminal.session.bound', {
      terminalId: 'term-ev2',
      provider: 'amplifier',
      sessionId: 's-ev2',
      reason: 'resume',
    })
    await waitUntil(() => watch.watchers.some((w) => w.watchedPath === '/fake/amp/sessions/s-ev2'))
    await flushAsync()

    fsStore.append(eventsPathBySession['s-ev2'], eventsLine('prompt:submit'))
    const watcher = watch.watchers.find((w) => w.watchedPath === '/fake/amp/sessions/s-ev2')!
    watcher.fire('change', eventsPathBySession['s-ev2'])
    await waitForMessage(ws, (msg) =>
      msg.type === 'amplifier.activity.updated'
      && msg.upsert?.some((record: any) => record.terminalId === 'term-ev2' && record.phase === 'busy'))

    // Tailer error mid-turn → single degrade warn + silent idle reversion over
    // the wire. Attach the idle listener BEFORE firing so the broadcast cannot
    // race past it.
    const idlePromise = waitForMessage(ws, (msg) =>
      msg.type === 'amplifier.activity.updated'
      && msg.upsert?.some((record: any) => record.terminalId === 'term-ev2' && record.phase === 'idle'))
    fsStore.failStat(eventsPathBySession['s-ev2'])
    watcher.fire('change', eventsPathBySession['s-ev2'])
    await waitUntil(() => warn.mock.calls.some((call) =>
      (call[0] as any)?.event === 'amplifier_events_lane_degraded' && (call[0] as any)?.terminalId === 'term-ev2'))
    const idle = await idlePromise
    expect(idle.upsert.find((record: any) => record.terminalId === 'term-ev2')).toMatchObject({ phase: 'idle' })
    const degradeWarns = warn.mock.calls.filter((call) =>
      (call[0] as any)?.event === 'amplifier_events_lane_degraded' && (call[0] as any)?.terminalId === 'term-ev2')
    expect(degradeWarns).toHaveLength(1)

    // NO timing fallback: PTY output after the degrade must not resurrect the
    // turn or fabricate a completion (the removed heuristic fired ~2s after
    // output-silence, so the window is held open past that).
    registry.emit('terminal.output.raw', { terminalId: 'term-ev2', data: 'tool output', at: Date.now() })
    await expect(expectNoMatchingMessage(ws, (msg) =>
      (msg.type === 'terminal.turn.complete' && msg.terminalId === 'term-ev2')
      || (msg.type === 'amplifier.activity.updated'
        && msg.upsert?.some((record: any) => record.terminalId === 'term-ev2' && record.phase === 'busy')),
    2600)).resolves.toBeUndefined()
    expect(amplifierActivity.tracker.getActivity('term-ev2')?.phase).toBe('idle')

    ws.close()
  })
})

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import http from 'http'
import WebSocket from 'ws'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol'

const TEST_TIMEOUT_MS = 30_000
const HOOK_TIMEOUT_MS = 30_000

vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: HOOK_TIMEOUT_MS })

class FakeBuffer {
  private chunks: string[] = []

  append(chunk: string): void {
    if (!chunk) return
    this.chunks.push(chunk)
  }

  snapshot(): string {
    return this.chunks.join('')
  }
}

class FakeRegistry extends EventEmitter {
  private records = new Map<string, any>()
  private counter = 0

  create(opts: any) {
    const terminalId = `term-stream-${++this.counter}`
    const record = {
      terminalId,
      createdAt: Date.now(),
      buffer: new FakeBuffer(),
      title: opts.mode === 'codex' ? 'Codex' : 'Shell',
      mode: opts.mode || 'shell',
      shell: opts.shell || 'system',
      status: 'running',
      resumeSessionId: opts.resumeSessionId,
      clients: new Set<WebSocket>(),
      suppressedOutputClients: new Set<WebSocket>(),
    }
    this.records.set(terminalId, record)
    return record
  }

  get(terminalId: string) {
    return this.records.get(terminalId) || null
  }

  attach(terminalId: string, ws: WebSocket, opts?: { suppressOutput?: boolean }) {
    const record = this.records.get(terminalId)
    if (!record) return null
    record.clients.add(ws)
    if (opts?.suppressOutput) record.suppressedOutputClients.add(ws)
    return record
  }

  detach(terminalId: string, ws: WebSocket) {
    const record = this.records.get(terminalId)
    if (!record) return false
    record.clients.delete(ws)
    record.suppressedOutputClients.delete(ws)
    return true
  }

  input(terminalId: string, _data: string) {
    return !!this.records.get(terminalId)
  }

  resize(terminalId: string, _cols: number, _rows: number) {
    return !!this.records.get(terminalId)
  }

  kill(terminalId: string) {
    const record = this.records.get(terminalId)
    if (!record) return false
    record.status = 'exited'
    return true
  }

  list() {
    return Array.from(this.records.values()).map((record) => ({
      terminalId: record.terminalId,
      title: record.title,
      mode: record.mode,
      createdAt: record.createdAt,
      status: record.status,
      hasClients: record.clients.size > 0,
      attachedClientCount: record.clients.size,
    }))
  }

  findRunningTerminalBySession(mode: string, sessionId: string) {
    for (const record of this.records.values()) {
      if (record.mode !== mode) continue
      if (record.status !== 'running') continue
      if (record.resumeSessionId === sessionId) return record
    }
    return undefined
  }

  findRunningClaudeTerminalBySession(sessionId: string) {
    return this.findRunningTerminalBySession('claude', sessionId)
  }

  getCanonicalRunningTerminalBySession(mode: string, sessionId: string) {
    return this.findRunningTerminalBySession(mode, sessionId)
  }

  repairLegacySessionOwners(_mode: string, _sessionId: string) {
    return {
      repaired: false,
      canonicalTerminalId: undefined,
      clearedTerminalIds: [] as string[],
    }
  }

  simulateOutput(terminalId: string, data: string) {
    const record = this.records.get(terminalId)
    if (!record || record.status !== 'running') return
    record.buffer.append(data)
    this.emit('terminal.output.raw', { terminalId, data, at: Date.now() })
  }
}

function listen(server: http.Server, timeoutMs = HOOK_TIMEOUT_MS): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.off('error', onError)
      reject(new Error('Timed out waiting for server to listen'))
    }, timeoutMs)

    const onError = (error: Error) => {
      clearTimeout(timeout)
      reject(error)
    }

    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      clearTimeout(timeout)
      server.off('error', onError)
      const address = server.address()
      if (typeof address === 'object' && address) {
        resolve({ port: address.port })
      }
    })
  })
}

function waitForMessage(ws: WebSocket, predicate: (msg: any) => boolean, timeoutMs = 3_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const seenTypes: string[] = []
    const timeout = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error(`Timeout waiting for message (seen: ${seenTypes.join(', ') || 'none'})`))
    }, timeoutMs)

    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      seenTypes.push(String(msg.type ?? 'unknown'))
      if (!predicate(msg)) return
      clearTimeout(timeout)
      ws.off('message', handler)
      resolve(msg)
    }

    ws.on('message', handler)
  })
}

function waitForMessages(
  ws: WebSocket,
  predicates: Array<(msg: any) => boolean>,
  timeoutMs = 3_000,
): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const matches: any[] = Array(predicates.length).fill(undefined)
    const timeout = setTimeout(() => {
      ws.off('message', handler)
      reject(new Error('Timeout waiting for messages'))
    }, timeoutMs)

    const handler = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      for (let i = 0; i < predicates.length; i += 1) {
        if (!matches[i] && predicates[i]?.(msg)) {
          matches[i] = msg
        }
      }
      if (matches.every((entry) => entry !== undefined)) {
        clearTimeout(timeout)
        ws.off('message', handler)
        resolve(matches)
      }
    }

    ws.on('message', handler)
  })
}

async function createAuthenticatedConnection(port: number): Promise<{ ws: WebSocket; close: () => Promise<void> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise<void>((resolve) => ws.on('open', () => resolve()))

  ws.send(JSON.stringify({
    type: 'hello',
    token: 'testtoken-testtoken',
    protocolVersion: WS_PROTOCOL_VERSION,
  }))
  await waitForMessage(ws, (msg) => msg.type === 'ready')

  return {
    ws,
    close: () => new Promise<void>((resolve) => {
      ws.once('close', () => resolve())
      ws.close()
    }),
  }
}

async function createTerminal(ws: WebSocket, requestId: string): Promise<{ terminalId: string }> {
  const pending = waitForMessages(ws, [
    (msg) => msg.type === 'terminal.created' && msg.requestId === requestId,
    (msg) => msg.type === 'terminal.attach.ready',
  ])

  ws.send(JSON.stringify({
    type: 'terminal.create',
    requestId,
    mode: 'shell',
    shell: 'system',
  }))

  const [created, ready] = await pending
  const terminalId = created.terminalId as string
  expect(ready.terminalId).toBe(terminalId)

  return { terminalId }
}

describe('terminal stream v2 replay', () => {
  let server: http.Server | undefined
  let WsHandler: any
  let handler: any
  let registry: FakeRegistry
  let port: number

  beforeAll(async () => {
    process.env.NODE_ENV = 'test'
    process.env.AUTH_TOKEN = 'testtoken-testtoken'
    process.env.HELLO_TIMEOUT_MS = '500'

    ;({ WsHandler } = await import('../../server/ws-handler'))
    server = http.createServer((_req, res) => {
      res.statusCode = 404
      res.end()
    })
    registry = new FakeRegistry()
    handler = new WsHandler(server, registry as any)
    const info = await listen(server)
    port = info.port
  }, HOOK_TIMEOUT_MS)

  beforeEach(() => {
    process.env.TERMINAL_CLIENT_QUEUE_MAX_BYTES = '256'
  })

  afterAll(async () => {
    if (handler) handler.close()
    if (!server) return
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }, HOOK_TIMEOUT_MS)

  it('reconnect replay with sinceSeq sends only the missing delta range', async () => {
    const { ws: ws1, close: close1 } = await createAuthenticatedConnection(port)
    const { terminalId } = await createTerminal(ws1, 'stream-delta-create')

    for (const chunk of ['one', 'two', 'three', 'four']) {
      registry.simulateOutput(terminalId, chunk)
    }
    await waitForMessage(
      ws1,
      (msg) => msg.type === 'terminal.output' && msg.terminalId === terminalId && msg.seqEnd >= 4,
    )

    await close1()

    const { ws: ws2, close: close2 } = await createAuthenticatedConnection(port)
    const replayed: any[] = []
    const onMessage = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'terminal.output' && msg.terminalId === terminalId) {
        replayed.push(msg)
      }
    }
    ws2.on('message', onMessage)

    const readyPromise = waitForMessage(
      ws2,
      (msg) => msg.type === 'terminal.attach.ready' && msg.terminalId === terminalId,
    )
    const replayPromise = waitForMessage(
      ws2,
      (msg) => msg.type === 'terminal.output' && msg.terminalId === terminalId && msg.seqEnd >= 4,
    )
    const attachRequestId = 'attach-delta-1'

    ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId, sinceSeq: 2, attachRequestId }))

    const ready = await readyPromise
    await replayPromise

    ws2.off('message', onMessage)

    expect(ready.replayFromSeq).toBe(3)
    expect(ready.replayToSeq).toBe(4)
    expect(ready.attachRequestId).toBe(attachRequestId)
    expect(replayed.length).toBe(2)
    expect(replayed[0]?.seqStart).toBe(3)
    expect(replayed[1]?.seqEnd).toBe(4)
    expect(replayed.every((frame) => frame.seqStart > 2)).toBe(true)
    expect(replayed.every((frame) => frame.attachRequestId === attachRequestId)).toBe(true)

    await close2()
  })

  it('echoes attachRequestId on attach.ready and replay_window_exceeded gaps', async () => {
    const originalReplayRingMaxBytes = process.env.TERMINAL_REPLAY_RING_MAX_BYTES
    process.env.TERMINAL_REPLAY_RING_MAX_BYTES = '8'

    try {
      const { ws: ws1, close: close1 } = await createAuthenticatedConnection(port)
      const { terminalId } = await createTerminal(ws1, 'stream-attach-id-create')

      for (const chunk of ['aaaa', 'bbbb', 'cccc']) {
        registry.simulateOutput(terminalId, chunk)
      }
      await waitForMessage(
        ws1,
        (msg) => msg.type === 'terminal.output' && msg.terminalId === terminalId && msg.seqEnd >= 3,
      )
      await close1()

      const { ws: ws2, close: close2 } = await createAuthenticatedConnection(port)
      const readyPromise = waitForMessage(
        ws2,
        (msg) => msg.type === 'terminal.attach.ready' && msg.terminalId === terminalId,
      )
      const gapPromise = waitForMessage(
        ws2,
        (msg) =>
          msg.type === 'terminal.output.gap'
          && msg.terminalId === terminalId
          && msg.reason === 'replay_window_exceeded',
      )

      ws2.send(JSON.stringify({
        type: 'terminal.attach',
        terminalId,
        sinceSeq: 0,
        attachRequestId: 'attach-replay-1',
      }))

      const ready = await readyPromise
      const gap = await gapPromise
      expect(ready.attachRequestId).toBe('attach-replay-1')
      expect(gap.attachRequestId).toBe('attach-replay-1')

      await close2()
    } finally {
      if (originalReplayRingMaxBytes === undefined) delete process.env.TERMINAL_REPLAY_RING_MAX_BYTES
      else process.env.TERMINAL_REPLAY_RING_MAX_BYTES = originalReplayRingMaxBytes
    }
  })

  it('attach replay from sinceSeq emits ready first and replays an exact range above sequence 1', async () => {
    const { ws: ws1, close: close1 } = await createAuthenticatedConnection(port)
    const { terminalId } = await createTerminal(ws1, 'stream-range-create')

    for (let i = 1; i <= 12; i += 1) {
      registry.simulateOutput(terminalId, `f${i}|`)
    }
    await waitForMessage(
      ws1,
      (msg) => msg.type === 'terminal.output' && msg.terminalId === terminalId && msg.seqEnd >= 12,
    )
    await close1()

    const { ws: ws2, close: close2 } = await createAuthenticatedConnection(port)
    const received: Array<{ type: string; seqStart?: number; seqEnd?: number }> = []
    const listener = (data: WebSocket.Data) => {
      const msg = JSON.parse(data.toString())
      if (msg.terminalId !== terminalId) return
      if (msg.type === 'terminal.attach.ready' || msg.type === 'terminal.output') {
        received.push({ type: msg.type, seqStart: msg.seqStart, seqEnd: msg.seqEnd })
      }
    }
    ws2.on('message', listener)

    const readyPromise = waitForMessage(
      ws2,
      (msg) => msg.type === 'terminal.attach.ready' && msg.terminalId === terminalId,
    )
    const replayTailPromise = waitForMessage(
      ws2,
      (msg) => msg.type === 'terminal.output' && msg.terminalId === terminalId && msg.seqEnd === 12,
    )

    ws2.send(JSON.stringify({ type: 'terminal.attach', terminalId, sinceSeq: 5 }))

    const ready = await readyPromise
    await replayTailPromise
    ws2.off('message', listener)

    expect(ready.replayFromSeq).toBe(6)
    expect(ready.replayToSeq).toBe(12)
    expect(received[0]?.type).toBe('terminal.attach.ready')

    const replayed = received.filter((msg) => msg.type === 'terminal.output')
    expect(replayed).toHaveLength(7)
    expect(replayed[0]?.seqStart).toBe(6)
    expect(replayed[replayed.length - 1]?.seqEnd).toBe(12)
    for (let i = 0; i < replayed.length; i += 1) {
      expect(replayed[i]?.seqStart).toBe(6 + i)
      expect(replayed[i]?.seqEnd).toBe(6 + i)
    }

    await close2()
  })

  it('emits terminal.output.gap under queue overflow and keeps streaming without routine 4008 close', async () => {
    const { ws, close } = await createAuthenticatedConnection(port)
    const { terminalId } = await createTerminal(ws, 'stream-gap-create')
    const attachRequestId = 'attach-overflow-1'

    ws.send(JSON.stringify({
      type: 'terminal.attach',
      terminalId,
      sinceSeq: 0,
      attachRequestId,
    }))
    await waitForMessage(
      ws,
      (msg) =>
        msg.type === 'terminal.attach.ready'
        && msg.terminalId === terminalId
        && msg.attachRequestId === attachRequestId,
    )

    let closeCode: number | undefined
    ws.on('close', (code) => {
      closeCode = code
    })

    let sawGap = false
    let sawTail = false
    let gapAttachRequestId: string | undefined
    const completion = new Promise<void>((resolve) => {
      const listener = (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'terminal.output.gap' && msg.terminalId === terminalId) {
          sawGap = true
          gapAttachRequestId = msg.attachRequestId
        }
        if (msg.type === 'terminal.output' && msg.terminalId === terminalId && String(msg.data).includes('TAIL-MARKER')) {
          sawTail = true
        }
        if (sawGap && sawTail) {
          ws.off('message', listener)
          resolve()
        }
      }
      ws.on('message', listener)
    })

    for (let i = 0; i < 240; i += 1) {
      registry.simulateOutput(terminalId, `frame-${i}|`)
    }
    registry.simulateOutput(terminalId, 'TAIL-MARKER')

    await Promise.race([
      completion,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for gap and tail output')), 3_000)),
    ])

    expect(sawGap).toBe(true)
    expect(sawTail).toBe(true)
    expect(gapAttachRequestId).toBe(attachRequestId)
    expect(closeCode).not.toBe(4008)

    await close()
  })
})

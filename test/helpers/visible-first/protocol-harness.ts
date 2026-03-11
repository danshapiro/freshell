import http from 'node:http'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler'
import { WS_PROTOCOL_VERSION } from '../../../shared/ws-protocol'
import { inspectVisibleFirstTranscript } from './acceptance-contract'

type ProtocolHarnessOptions = {
  authToken?: string
  handshakeSnapshot?: {
    settings: unknown
    projects: unknown[]
    perfLogging?: boolean
    configFallback?: unknown
  }
}

type ProtocolMessage = Record<string, unknown>

function listen(server: http.Server, timeoutMs = 5_000): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.off('error', onError)
      reject(new Error('Timed out waiting for websocket harness server to listen'))
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

function waitForOpen(ws: WebSocket, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for websocket client to open'))
    }, timeoutMs)

    ws.once('open', () => {
      clearTimeout(timeout)
      resolve()
    })
    ws.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

function waitForMessage(
  ws: WebSocket,
  predicate: (message: ProtocolMessage) => boolean,
  timeoutMs = 5_000,
): Promise<ProtocolMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage)
      ws.off('close', onClose)
      reject(new Error('Timed out waiting for websocket message'))
    }, timeoutMs)

    const onClose = (code: number, reason: Buffer) => {
      clearTimeout(timeout)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      reject(new Error(`WebSocket closed before expected message (${code}: ${reason.toString()})`))
    }

    const onMessage = (data: WebSocket.Data) => {
      const message = JSON.parse(data.toString()) as ProtocolMessage
      if (!predicate(message)) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      resolve(message)
    }

    ws.on('message', onMessage)
    ws.on('close', onClose)
  })
}

function waitForClose(ws: WebSocket, timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for websocket close'))
    }, timeoutMs)

    ws.once('close', (code, reason) => {
      clearTimeout(timeout)
      resolve({ code, reason: reason.toString() })
    })
  })
}

function closeWebSocket(ws: WebSocket, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }

    const timeout = setTimeout(() => {
      ws.terminate()
      resolve()
    }, timeoutMs)

    ws.once('close', () => {
      clearTimeout(timeout)
      resolve()
    })
    ws.close()
  })
}

class FakeBuffer {
  private value = ''

  append(text: string): void {
    this.value += text
  }

  snapshot(): string {
    return this.value
  }
}

class FakeRegistry {
  private records = new Map<string, any>()

  create(options: Record<string, unknown>) {
    const terminalId = `term_${Math.random().toString(16).slice(2)}`
    const record = {
      terminalId,
      createdAt: Date.now(),
      buffer: new FakeBuffer(),
      title: options.mode === 'claude' ? 'Claude' : 'Shell',
      mode: options.mode ?? 'shell',
      shell: options.shell ?? 'system',
      status: 'running',
      resumeSessionId: options.resumeSessionId,
      clients: new Set<WebSocket>(),
    }
    this.records.set(terminalId, record)
    return record
  }

  get(terminalId: string) {
    return this.records.get(terminalId) ?? null
  }

  attach(terminalId: string, ws: WebSocket) {
    const record = this.records.get(terminalId)
    if (!record) return null
    record.clients.add(ws)
    return record
  }

  finishAttachSnapshot(): void {}

  detach(terminalId: string, ws: WebSocket): boolean {
    const record = this.records.get(terminalId)
    if (!record) return false
    record.clients.delete(ws)
    return true
  }

  input(terminalId: string): boolean {
    return this.records.has(terminalId)
  }

  resize(terminalId: string): boolean {
    return this.records.has(terminalId)
  }

  kill(terminalId: string): boolean {
    return this.records.delete(terminalId)
  }

  list(): unknown[] {
    return Array.from(this.records.values()).map((record) => ({
      terminalId: record.terminalId,
      title: record.title,
      mode: record.mode,
      createdAt: record.createdAt,
      lastActivityAt: record.createdAt,
      status: record.status,
      hasClients: record.clients.size > 0,
    }))
  }

  findRunningClaudeTerminalBySession(sessionId: string) {
    for (const record of this.records.values()) {
      if (record.mode !== 'claude') continue
      if (record.status !== 'running') continue
      if (record.resumeSessionId === sessionId) return record
    }
    return undefined
  }
}

export async function createProtocolHarness(options: ProtocolHarnessOptions = {}) {
  const originalAuthToken = process.env.AUTH_TOKEN
  const authToken = options.authToken ?? originalAuthToken ?? 'testtoken-testtoken'
  process.env.AUTH_TOKEN = authToken

  const server = http.createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })
  const registry = new FakeRegistry()
  const handshakeSnapshotProvider = options.handshakeSnapshot
    ? async () => options.handshakeSnapshot!
    : undefined
  const handler = new WsHandler(
    server,
    registry as any,
    undefined,
    undefined,
    undefined,
    handshakeSnapshotProvider,
  )
  const { port } = await listen(server)
  const openClients = new Set<WebSocket>()

  return {
    port,

    async connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      const rawTranscript: string[] = []
      const transcript: ProtocolMessage[] = []
      const rawOutboundTranscript: string[] = []
      const outboundTranscript: ProtocolMessage[] = []
      openClients.add(ws)

      ws.on('message', (data) => {
        const raw = data.toString()
        rawTranscript.push(raw)
        transcript.push(JSON.parse(raw) as ProtocolMessage)
      })

      await waitForOpen(ws)

      return {
        send(message: unknown) {
          rawOutboundTranscript.push(JSON.stringify(message))
          outboundTranscript.push(message as ProtocolMessage)
          ws.send(JSON.stringify(message))
        },

        async sendHello(overrides: Partial<ProtocolMessage> = {}) {
          const message = {
            type: 'hello',
            token: authToken,
            protocolVersion: WS_PROTOCOL_VERSION,
            ...overrides,
          }
          rawOutboundTranscript.push(JSON.stringify(message))
          outboundTranscript.push(message as ProtocolMessage)
          ws.send(JSON.stringify(message))
        },

        waitForMessage: (predicate: (message: ProtocolMessage) => boolean, timeoutMs?: number) =>
          waitForMessage(ws, predicate, timeoutMs),

        waitForClose: (timeoutMs?: number) => waitForClose(ws, timeoutMs),

        getTranscript(): ProtocolMessage[] {
          return transcript.slice()
        },

        getRawTranscript(): string[] {
          return rawTranscript.slice()
        },

        getCapturedTranscript() {
          return {
            inboundMessages: transcript.slice(),
            outboundMessages: outboundTranscript.slice(),
          }
        },

        assertNoLegacyMessages(): void {
          const offenders = inspectVisibleFirstTranscript({
            inboundMessages: transcript,
            outboundMessages: outboundTranscript,
          }).forbiddenTypes

          if (offenders.length > 0) {
            throw new Error(`Forbidden websocket message types observed: ${offenders.join(', ')}`)
          }
        },

        close: () => closeWebSocket(ws),
      }
    },

    broadcast(message: unknown): void {
      handler.broadcast(message as any)
    },

    async dispose() {
      await Promise.all(Array.from(openClients).map((client) => closeWebSocket(client)))
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })

      if (originalAuthToken === undefined) {
        delete process.env.AUTH_TOKEN
      } else {
        process.env.AUTH_TOKEN = originalAuthToken
      }
    },
  }
}

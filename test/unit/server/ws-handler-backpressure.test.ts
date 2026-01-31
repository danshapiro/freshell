import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import http from 'http'
import WebSocket from 'ws'
import { WsHandler } from '../../../server/ws-handler'
import { TerminalRegistry } from '../../../server/terminal-registry'

describe('WsHandler backpressure', () => {
  let server: http.Server
  let handler: WsHandler
  let registry: TerminalRegistry

  beforeEach(async () => {
    server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    registry = new TerminalRegistry()
    handler = new WsHandler(server, registry)
  })

  afterEach(async () => {
    handler.close()
    registry.shutdown()
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('closes the socket when bufferedAmount exceeds the limit', () => {
    const ws = {
      bufferedAmount: 10_000_000,
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close: vi.fn(),
    } as any

    ;(handler as any).send(ws, { type: 'test' })

    expect(ws.close).toHaveBeenCalled()
    expect(ws.send).not.toHaveBeenCalled()
  })
})

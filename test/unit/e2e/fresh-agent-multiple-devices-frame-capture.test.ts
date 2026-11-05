import { describe, expect, it, vi } from 'vitest'
import * as helper from '../../e2e-browser/helpers/fresh-agent-multiple-devices.js'

type MessageHandler = (message: string | Buffer) => void
type Intercept = (
  client: unknown,
  message: unknown,
  recordReceived: (message: unknown) => void,
) => boolean
type CreatedReplyGateBundle = {
  gate: {
    holdNext: () => void
    waitForHeld: () => Promise<Record<string, unknown>>
    release: () => void
  }
  intercept: Intercept
}

function fakeRoute() {
  let onMessage: MessageHandler | undefined
  const route = {
    send: vi.fn(),
    close: vi.fn(async () => {}),
    onClose: vi.fn(),
    onMessage: vi.fn((handler: MessageHandler) => { onMessage = handler }),
    receive: (message: string | Buffer) => onMessage?.(message),
  }
  return route
}

describe('fresh-agent WebSocket route frame capture', () => {
  it('records forwarded traffic once and records a held reply before delivery', async () => {
    const helpers = helper as unknown as Record<string, unknown>
    const wireFreshAgentWebSocketRoute = helpers.wireFreshAgentWebSocketRoute
    const createCreatedReplyGate = helpers.createCreatedReplyGate as (() => CreatedReplyGateBundle) | undefined
    expect(wireFreshAgentWebSocketRoute).toBeTypeOf('function')
    expect(createCreatedReplyGate).toBeTypeOf('function')

    const client = fakeRoute()
    const server = fakeRoute()
    const frames: Array<Record<string, unknown>> = []
    const forkMessage = JSON.stringify({ type: 'freshAgent.fork', requestId: 'fork-one' })
    const heldReply = JSON.stringify({ type: 'freshAgent.created', requestId: 'create-one' })
    const ordinaryReply = JSON.stringify({ type: 'freshAgent.forked', requestId: 'fork-one' })
    const { gate, intercept } = createCreatedReplyGate!()
    gate.holdNext()

    ;(wireFreshAgentWebSocketRoute as (
      client: unknown,
      server: unknown,
      frames: Array<Record<string, unknown>>,
      intercept: Intercept,
    ) => void)(client, server, frames, intercept)

    server.send.mockImplementation(() => {
      expect(frames).toContainEqual({ direction: 'sent', type: 'freshAgent.fork', requestId: 'fork-one' })
    })
    client.send.mockImplementation((message: string | Buffer) => {
      expect(frames).toContainEqual(message === heldReply
        ? {
            direction: 'received',
            capturedAtMs: expect.any(Number),
            type: 'freshAgent.created',
            requestId: 'create-one',
          }
        : { direction: 'received', type: 'freshAgent.forked', requestId: 'fork-one' })
      return message
    })

    client.receive(forkMessage)
    server.receive(heldReply)
    expect(await gate.waitForHeld()).toMatchObject({ type: 'freshAgent.created', requestId: 'create-one' })

    expect(frames).toEqual([
      { direction: 'sent', type: 'freshAgent.fork', requestId: 'fork-one' },
    ])
    expect(client.send).not.toHaveBeenCalled()

    gate.release()
    server.receive(ordinaryReply)

    expect(frames).toEqual([
      { direction: 'sent', type: 'freshAgent.fork', requestId: 'fork-one' },
      {
        direction: 'received',
        capturedAtMs: expect.any(Number),
        type: 'freshAgent.created',
        requestId: 'create-one',
      },
      { direction: 'received', type: 'freshAgent.forked', requestId: 'fork-one' },
    ])
    expect(server.send).toHaveBeenCalledExactlyOnceWith(forkMessage)
    expect(client.send).toHaveBeenNthCalledWith(1, heldReply)
    expect(client.send).toHaveBeenNthCalledWith(2, ordinaryReply)
    expect(client.send).toHaveBeenCalledTimes(2)
  })
})

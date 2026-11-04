import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureFreshAgentAttachDecision,
  detachFreshAgentView,
  freshAgentAttachResultMatchesDecision,
} from '@/lib/fresh-agent-view-attachment'

type MessageHandler = (message: unknown) => void

function createWs() {
  const sent: unknown[] = []
  const messages = new Set<MessageHandler>()
  const disconnects = new Set<() => void>()
  return {
    sent,
    send: vi.fn((message: unknown) => sent.push(message)),
    onMessage: vi.fn((handler: MessageHandler) => {
      messages.add(handler)
      return () => messages.delete(handler)
    }),
    onDisconnect: vi.fn((handler: () => void) => {
      disconnects.add(handler)
      return () => disconnects.delete(handler)
    }),
    emit(message: unknown) {
      for (const handler of [...messages]) handler(message)
    },
    disconnect() {
      for (const handler of [...disconnects]) handler()
    },
    listenerCounts() {
      return { messages: messages.size, disconnects: disconnects.size }
    },
  }
}

const attachment = (viewId: string) => ({
  provider: 'codex' as const,
  sessionType: 'freshcodex' as const,
  sessionId: 'shared-session',
  sessionRef: { provider: 'codex', sessionId: 'shared-session' },
  viewId,
})

function sentDetach(ws: ReturnType<typeof createWs>, viewId: string) {
  return ws.sent.find((message) => (message as { viewId?: string }).viewId === viewId) as {
    type: string
    requestId: string
    viewId: string
  }
}

function detachedAck(request: { requestId: string; viewId: string }, extra: Record<string, unknown> = {}) {
  return {
    type: 'freshAgent.detached',
    requestId: request.requestId,
    viewId: request.viewId,
    sessionRef: { provider: 'codex', sessionId: 'shared-session' },
    success: true,
    ...extra,
  }
}

describe('detachFreshAgentView', () => {
  afterEach(() => vi.useRealTimers())

  it('settles only the matching view and request for two views of one locator', async () => {
    vi.useFakeTimers()
    const timerBaseline = vi.getTimerCount()
    const ws = createWs()
    let firstSettled = false
    let secondSettled = false
    const first = detachFreshAgentView(ws, attachment('view-a')).then(() => { firstSettled = true })
    const second = detachFreshAgentView(ws, attachment('view-b')).then(() => { secondSettled = true })
    const requestA = sentDetach(ws, 'view-a')
    const requestB = sentDetach(ws, 'view-b')

    expect(requestA.type).toBe('freshAgent.detach')
    expect(requestA.requestId).not.toBe(requestB.requestId)
    ws.emit(detachedAck({ requestId: 'old-request', viewId: 'view-a' }))
    ws.emit(detachedAck({ requestId: requestA.requestId, viewId: 'view-b' }))
    await Promise.resolve()
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)

    ws.emit(detachedAck(requestA))
    await first
    expect(firstSettled).toBe(true)
    expect(secondSettled).toBe(false)
    expect(vi.getTimerCount()).toBe(timerBaseline + 1)
    ws.emit(detachedAck(requestA))
    await Promise.resolve()
    expect(secondSettled).toBe(false)

    ws.emit(detachedAck(requestB))
    await second
    expect(secondSettled).toBe(true)
    expect(ws.listenerCounts()).toEqual({ messages: 0, disconnects: 0 })
    expect(vi.getTimerCount()).toBe(timerBaseline)
    expect(ws.sent.every((message) => (message as { type?: string }).type === 'freshAgent.detach')).toBe(true)
  })

  it('rejects a typed detach failure and removes both listeners', async () => {
    vi.useFakeTimers()
    const timerBaseline = vi.getTimerCount()
    const ws = createWs()
    const pending = detachFreshAgentView(ws, attachment('view-failure'))
    const request = sentDetach(ws, 'view-failure')

    ws.emit(detachedAck(request, { success: false, code: 'VIEW_DETACH_REFUSED', message: 'retry' }))
    await expect(pending).rejects.toMatchObject({ code: 'VIEW_DETACH_REFUSED' })
    expect(ws.listenerCounts()).toEqual({ messages: 0, disconnects: 0 })
    expect(vi.getTimerCount()).toBe(timerBaseline)
    expect(ws.sent.some((message) => (message as { type?: string }).type === 'freshAgent.kill')).toBe(false)
  })

  it('rejects on disconnect and removes both listeners', async () => {
    vi.useFakeTimers()
    const timerBaseline = vi.getTimerCount()
    const ws = createWs()
    const pending = detachFreshAgentView(ws, attachment('view-disconnect'))
    ws.disconnect()

    await expect(pending).rejects.toMatchObject({ code: 'WS_DISCONNECTED' })
    expect(ws.listenerCounts()).toEqual({ messages: 0, disconnects: 0 })
    expect(vi.getTimerCount()).toBe(timerBaseline)
    expect(ws.sent.some((message) => (message as { type?: string }).type === 'freshAgent.kill')).toBe(false)
  })

  it('rejects a synchronous send failure and removes both listeners', async () => {
    vi.useFakeTimers()
    const timerBaseline = vi.getTimerCount()
    const ws = createWs()
    ws.send.mockImplementationOnce(() => { throw new Error('socket send failed') })
    const pending = detachFreshAgentView(ws, attachment('view-send-failure'))

    await expect(pending).rejects.toMatchObject({ code: 'VIEW_DETACH_SEND_FAILED' })
    expect(ws.listenerCounts()).toEqual({ messages: 0, disconnects: 0 })
    expect(vi.getTimerCount()).toBe(timerBaseline)
    expect(ws.sent).toEqual([])
  })

  it('rejects after the fixed timeout and releases its listeners', async () => {
    vi.useFakeTimers()
    const timerBaseline = vi.getTimerCount()
    const ws = createWs()
    const pending = detachFreshAgentView(ws, attachment('view-timeout'))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'VIEW_DETACH_TIMEOUT' })

    await vi.advanceTimersByTimeAsync(5_000)
    await rejected
    expect(ws.listenerCounts()).toEqual({ messages: 0, disconnects: 0 })
    expect(vi.getTimerCount()).toBe(timerBaseline)
    expect(ws.sent.some((message) => (message as { type?: string }).type === 'freshAgent.kill')).toBe(false)
  })
})

describe('fresh-agent attach decision correlation', () => {
  it('reuses the request id for a retry of the same target and owner fence', () => {
    const first = captureFreshAgentAttachDecision(
      'session:decision-1',
      { sessionId: 'session-1', viewId: 'view-a' },
      { epoch: 4, generation: 2 },
      null,
    )
    const retry = captureFreshAgentAttachDecision(
      'session:decision-1',
      { sessionId: 'session-1', viewId: 'view-a' },
      { epoch: 4, generation: 2 },
      first,
    )

    expect(retry).toBe(first)
    expect(retry.requestId).toBe(first.requestId)
  })

  it('mints a new request id when the target decision or observed owner changes', () => {
    const first = captureFreshAgentAttachDecision(
      'session:decision-1',
      { sessionId: 'session-1', viewId: 'view-a' },
      { epoch: 4, generation: 2 },
      null,
    )
    const nextDecision = captureFreshAgentAttachDecision(
      'session:decision-2',
      { sessionId: 'session-1', viewId: 'view-a' },
      { epoch: 4, generation: 2 },
      first,
    )
    const newOwner = captureFreshAgentAttachDecision(
      'session:decision-2',
      { sessionId: 'session-1', viewId: 'view-a' },
      { epoch: 4, generation: 3 },
      nextDecision,
    )

    expect(nextDecision.requestId).not.toBe(first.requestId)
    expect(newOwner.requestId).not.toBe(nextDecision.requestId)
  })

  it('settles only the matching request and view, ignoring a result from an older decision', () => {
    const decision = { requestId: 'attach-current', viewId: 'view-a' }
    expect(freshAgentAttachResultMatchesDecision({ ...decision }, decision)).toBe(true)
    expect(freshAgentAttachResultMatchesDecision({ requestId: 'attach-old', viewId: 'view-a' }, decision)).toBe(false)
    expect(freshAgentAttachResultMatchesDecision({ requestId: 'attach-current', viewId: 'view-b' }, decision)).toBe(false)
  })
})

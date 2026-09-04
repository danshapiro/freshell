import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { consumeTerminalReleaseMark } from '@/lib/terminal-release-marks'

const { mockSend, handlers } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  handlers: new Set<(msg: unknown) => void>(),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    onMessage: (handler: (msg: unknown) => void) => {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
  }),
}))

import {
  EXIT_FALLBACK_GRACE_MS,
  KILL_ACK_TIMEOUT_MS,
  sendFreshAgentKillAndAwait,
  sendTerminalKillAndAwait,
} from '@/lib/kill-ack'

function emit(msg: unknown) {
  for (const handler of [...handlers]) handler(msg)
}

describe('kill-ack', () => {
  beforeEach(() => {
    mockSend.mockClear()
    handlers.clear()
    vi.useRealTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('sendTerminalKillAndAwait', () => {
    it('sends the correlated kill (requestId + createRequestId) and resolves ok on the matching terminal.killed', async () => {
      const pending = sendTerminalKillAndAwait('term-1', { createRequestId: 'cr-1' })
      expect(mockSend).toHaveBeenCalledTimes(1)
      const sent = mockSend.mock.calls[0][0]
      expect(sent).toMatchObject({ type: 'terminal.kill', terminalId: 'term-1', createRequestId: 'cr-1' })
      expect(typeof sent.requestId).toBe('string')
      expect(sent.requestId.length).toBeGreaterThan(0)
      emit({ type: 'terminal.killed', requestId: sent.requestId, terminalId: 'term-1', success: true })
      await expect(pending).resolves.toEqual({ ok: true })
      expect(consumeTerminalReleaseMark('term-1')).toBe(true, 'a confirmed close marks the terminal released')
    })

    it('resolves ok via the terminal.exit fallback (a legacy server sends no terminal.killed)', async () => {
      vi.useFakeTimers()
      const pending = sendTerminalKillAndAwait('term-2')
      emit({ type: 'terminal.exit', terminalId: 'term-2', exitCode: 0 })
      // The exit fallback settles after the correlation grace (F7): no
      // correlated frame ever arrives on a legacy server, the grace expires.
      await vi.advanceTimersByTimeAsync(EXIT_FALLBACK_GRACE_MS)
      await expect(pending).resolves.toEqual({ ok: true })
      expect(consumeTerminalReleaseMark('term-2')).toBe(true)
    })

    it('never settles success on terminal.exit when the CORRELATED failure frame is a send behind it (persisted-despite-error order)', async () => {
      // Focused-episode-6 round 4 (Finding F7): on a persisted-despite-error
      // close the server broadcasts terminal.exit WHILE killing, and only
      // afterward sends terminal.killed{success:false}. The legacy exit
      // fallback must never win that race: the correlated result decides.
      const pending = sendTerminalKillAndAwait('term-2b')
      const sent = mockSend.mock.calls[mockSend.mock.calls.length - 1][0]
      emit({ type: 'terminal.exit', terminalId: 'term-2b', exitCode: 0 })
      emit({
        type: 'terminal.killed',
        requestId: sent.requestId,
        terminalId: 'term-2b',
        success: false,
        error: 'the terminal close is recorded durably, but the ledger reported an error',
      })
      await expect(pending).resolves.toEqual({
        ok: false,
        error: 'the terminal close is recorded durably, but the ledger reported an error',
      })
      expect(consumeTerminalReleaseMark('term-2b')).toBe(false, 'a visibly-failed close is NOT released')
    })

    it('the correlated SUCCESS arriving inside the exit grace settles immediately (no gratuitous delay)', async () => {
      vi.useFakeTimers()
      const pending = sendTerminalKillAndAwait('term-2c')
      const sent = mockSend.mock.calls[mockSend.mock.calls.length - 1][0]
      emit({ type: 'terminal.exit', terminalId: 'term-2c', exitCode: 0 })
      const probe = vi.fn()
      void pending.then(probe)
      await Promise.resolve()
      expect(probe).not.toHaveBeenCalled()
      emit({ type: 'terminal.killed', requestId: sent.requestId, terminalId: 'term-2c', success: true })
      await expect(pending).resolves.toEqual({ ok: true })
      expect(consumeTerminalReleaseMark('term-2c')).toBe(true)
    })

    it('resolves ok via the INVALID_TERMINAL_ID error (the terminal was already gone)', async () => {
      const pending = sendTerminalKillAndAwait('term-3')
      emit({ type: 'error', code: 'INVALID_TERMINAL_ID', terminalId: 'term-3', message: 'Unknown terminalId' })
      await expect(pending).resolves.toEqual({ ok: true })
      expect(consumeTerminalReleaseMark('term-3')).toBe(true)
    })

    it('terminal.killed{success:false} resolves as a failure with the server error and never marks the terminal released', async () => {
      const pending = sendTerminalKillAndAwait('term-4')
      const sent = mockSend.mock.calls[0][0]
      emit({
        type: 'terminal.killed',
        requestId: sent.requestId,
        terminalId: 'term-4',
        success: false,
        error: 'the terminal close could not be recorded durably; the terminal was left running',
      })
      await expect(pending).resolves.toEqual({
        ok: false,
        error: 'the terminal close could not be recorded durably; the terminal was left running',
      })
      expect(consumeTerminalReleaseMark('term-4')).toBe(false, 'a failed close is NOT released')
    })

    it('times out as a UI failure (the server close stays authoritative) and never marks released', async () => {
      vi.useFakeTimers()
      const pending = sendTerminalKillAndAwait('term-5')
      await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 10)
      await expect(pending).resolves.toEqual({ ok: false, timedOut: true })
      expect(consumeTerminalReleaseMark('term-5')).toBe(false)
      // A late frame for the same requestId cannot re-resolve the settled wait.
      const sent = mockSend.mock.calls[0][0]
      emit({ type: 'terminal.killed', requestId: sent.requestId, terminalId: 'term-5', success: true })
      expect(handlers.size).toBe(0, 'the settled wait unsubscribed')
    })

    it('ignores frames for other terminals and other requestIds', async () => {
      const pending = sendTerminalKillAndAwait('term-6')
      const sent = mockSend.mock.calls[0][0]
      emit({ type: 'terminal.killed', requestId: 'someone-else', terminalId: 'term-6', success: true })
      emit({ type: 'terminal.killed', requestId: sent.requestId, terminalId: 'term-other', success: true })
      emit({ type: 'terminal.exit', terminalId: 'term-other', exitCode: 0 })
      emit({ type: 'error', code: 'INVALID_TERMINAL_ID', terminalId: 'term-other' })
      emit({ type: 'terminal.killed', requestId: sent.requestId, terminalId: 'term-6', success: true })
      await expect(pending).resolves.toEqual({ ok: true })
    })
  })

  describe('sendFreshAgentKillAndAwait', () => {
    it('sends freshAgent.kill and resolves ok on the matching top-level freshAgent.killed', async () => {
      const pending = sendFreshAgentKillAndAwait({
        sessionId: 'ses-1',
        sessionType: 'freshopencode',
        provider: 'opencode',
        cwd: '/w',
      })
      expect(mockSend).toHaveBeenCalledWith({
        type: 'freshAgent.kill',
        sessionId: 'ses-1',
        sessionType: 'freshopencode',
        provider: 'opencode',
        cwd: '/w',
      })
      emit({ type: 'freshAgent.killed', sessionId: 'ses-1', sessionType: 'freshopencode', provider: 'opencode', success: true })
      await expect(pending).resolves.toEqual({ ok: true })
    })

    it('matches the event-wrapped killed shape too', async () => {
      const pending = sendFreshAgentKillAndAwait({
        sessionId: 'ses-2',
        sessionType: 'freshclaude',
        provider: 'claude',
      })
      emit({
        type: 'freshAgent.event',
        sessionId: 'ses-2',
        sessionType: 'freshclaude',
        provider: 'claude',
        event: { type: 'freshAgent.killed', success: true },
      })
      await expect(pending).resolves.toEqual({ ok: true })
    })

    it('success:false resolves as a failure', async () => {
      const pending = sendFreshAgentKillAndAwait({
        sessionId: 'ses-3',
        sessionType: 'freshclaude',
        provider: 'claude',
      })
      emit({ type: 'freshAgent.killed', sessionId: 'ses-3', sessionType: 'freshclaude', provider: 'claude', success: false })
      await expect(pending).resolves.toEqual({ ok: false })
    })

    it('does not resolve on other sessions or providers', async () => {
      const pending = sendFreshAgentKillAndAwait({
        sessionId: 'ses-4',
        sessionType: 'freshclaude',
        provider: 'claude',
      })
      const probe = vi.fn()
      void pending.then(probe)
      emit({ type: 'freshAgent.killed', sessionId: 'ses-other', sessionType: 'freshclaude', provider: 'claude', success: true })
      emit({ type: 'freshAgent.killed', sessionId: 'ses-4', sessionType: 'freshclaude', provider: 'opencode', success: true })
      emit({
        type: 'freshAgent.event',
        sessionId: 'ses-4',
        sessionType: 'freshclaude',
        provider: 'claude',
        event: { type: 'freshAgent.turn.complete', at: 1 },
      })
      await Promise.resolve()
      expect(probe).not.toHaveBeenCalled()
      emit({ type: 'freshAgent.killed', sessionId: 'ses-4', sessionType: 'freshclaude', provider: 'claude', success: true })
      await expect(pending).resolves.toEqual({ ok: true })
    })

    it('times out as a UI failure', async () => {
      vi.useFakeTimers()
      const pending = sendFreshAgentKillAndAwait({
        sessionId: 'ses-5',
        sessionType: 'freshclaude',
        provider: 'claude',
      })
      await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 10)
      await expect(pending).resolves.toEqual({ ok: false, timedOut: true })
    })
  })
})

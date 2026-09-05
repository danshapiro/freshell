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
  hasOpenReassertFailure,
  reassertAllOpenPanes,
  sendFreshAgentKillAndAwait,
  sendPaneClosedAndAwait,
  sendPaneOpened,
  sendPanesClosedAndAwait,
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

  describe('sendPaneClosedAndAwait (delta-r7-r3 / focused-episode-7 round 2 Finding F2)', () => {
    it('sends pane.closed and resolves ok on the matching correlated pane.closed.result', async () => {
      const pending = sendPaneClosedAndAwait({ createRequestId: 'cr-1', terminalId: 'term-1' })
      expect(mockSend).toHaveBeenCalledTimes(1)
      expect(mockSend).toHaveBeenCalledWith({
        type: 'pane.closed',
        createRequestId: 'cr-1',
        terminalId: 'term-1',
      })
      emit({ type: 'pane.closed.result', createRequestId: 'cr-1', terminalId: 'term-1', success: true })
      await expect(pending).resolves.toEqual({ ok: true })
    })

    it('omits the terminalId key for the in-flight-create close shape', async () => {
      const pending = sendPaneClosedAndAwait({ createRequestId: 'cr-flight' })
      const sent = mockSend.mock.calls[0][0]
      expect(sent).toEqual({ type: 'pane.closed', createRequestId: 'cr-flight' })
      emit({ type: 'pane.closed.result', createRequestId: 'cr-flight', success: true })
      await expect(pending).resolves.toEqual({ ok: true })
    })

    it('an answer delivered INSIDE the send call resolves — the wait subscribes BEFORE the send (the auto-answer/test-double order is load-bearing)', async () => {
      const send = vi.fn((msg: unknown) => {
        const m = msg as { createRequestId?: string }
        emit({ type: 'pane.closed.result', createRequestId: m.createRequestId, success: true })
      })
      await expect(sendPaneClosedAndAwait({ createRequestId: 'cr-sync' }, { send })).resolves.toEqual({ ok: true })
      expect(send).toHaveBeenCalledTimes(1)
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('success:false resolves as a failure carrying the server error', async () => {
      const pending = sendPaneClosedAndAwait({ createRequestId: 'cr-fail' })
      emit({
        type: 'pane.closed.result',
        createRequestId: 'cr-fail',
        success: false,
        error: 'the pane-close record could not be written durably',
      })
      await expect(pending).resolves.toEqual({
        ok: false,
        error: 'the pane-close record could not be written durably',
      })
    })

    it('never resolves on answers for OTHER panes (the createRequestId correlation is exact)', async () => {
      const pending = sendPaneClosedAndAwait({ createRequestId: 'cr-mine' })
      const probe = vi.fn()
      void pending.then(probe)
      emit({ type: 'pane.closed.result', createRequestId: 'cr-other', success: true })
      emit({ type: 'terminal.killed', requestId: 'x', terminalId: 'term-1', success: true })
      await Promise.resolve()
      expect(probe).not.toHaveBeenCalled()
      emit({ type: 'pane.closed.result', createRequestId: 'cr-mine', success: true })
      await expect(pending).resolves.toEqual({ ok: true })
    })

    it('times out as a UI failure (unconfirmed close — the pane stays)', async () => {
      vi.useFakeTimers()
      const pending = sendPaneClosedAndAwait({ createRequestId: 'cr-timeout' })
      await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 10)
      await expect(pending).resolves.toEqual({ ok: false, timedOut: true })
    })

    it('a late answer after the timeout can never resurrect the settled wait', async () => {
      vi.useFakeTimers()
      const pending = sendPaneClosedAndAwait({ createRequestId: 'cr-late' })
      await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 10)
      await expect(pending).resolves.toEqual({ ok: false, timedOut: true })
      emit({ type: 'pane.closed.result', createRequestId: 'cr-late', success: true })
      await Promise.resolve()
      // still settled as the timeout — a second resolution would be a bug
      await expect(pending).resolves.toEqual({ ok: false, timedOut: true })
    })
  })

  describe('sendPanesClosedAndAwait (focused-episode-7 round 3 Finding F1 — the whole-tab close is ONE envelope)', () => {
    const tabIdentities = [
      { paneId: 'pane-1', createRequestId: 'cr-a', terminalId: 'term-a' },
      { paneId: 'pane-2', createRequestId: 'cr-b' }, // mid-create: CRID only
    ]

    it('sends ONE panes.closed carrying the whole set and resolves ok on the correlated panes.closed.result', async () => {
      const pending = sendPanesClosedAndAwait('tab-9', tabIdentities)
      expect(mockSend).toHaveBeenCalledTimes(1)
      const sent = mockSend.mock.calls[0][0] as Record<string, unknown>
      expect(sent.type).toBe('panes.closed')
      expect(sent.tabId).toBe('tab-9')
      expect(typeof sent.requestId).toBe('string')
      expect((sent.requestId as string).length).toBeGreaterThan(0)
      expect(sent.panes).toEqual([
        { createRequestId: 'cr-a', terminalId: 'term-a' },
        { createRequestId: 'cr-b' },
      ])
      emit({ type: 'panes.closed.result', requestId: sent.requestId, success: true })
      await expect(pending).resolves.toEqual({ ok: true })
    })

    it('never resolves on a result for another close op (the requestId correlation is exact)', async () => {
      const pending = sendPanesClosedAndAwait('tab-9', tabIdentities)
      const sent = mockSend.mock.calls[0][0] as { requestId: string }
      const probe = vi.fn()
      void pending.then(probe)
      emit({ type: 'panes.closed.result', requestId: 'someone-else', success: true })
      emit({ type: 'pane.closed.result', createRequestId: 'cr-a', success: true })
      await Promise.resolve()
      expect(probe).not.toHaveBeenCalled()
      emit({ type: 'panes.closed.result', requestId: sent.requestId, success: true })
      await expect(pending).resolves.toEqual({ ok: true })
    })

    it('success:false resolves as ONE failure for the whole set (a partial outcome is impossible)', async () => {
      const pending = sendPanesClosedAndAwait('tab-9', tabIdentities)
      const sent = mockSend.mock.calls[0][0] as { requestId: string }
      emit({
        type: 'panes.closed.result',
        requestId: sent.requestId,
        success: false,
        error: 'the pane-close record could not be written durably',
      })
      await expect(pending).resolves.toEqual({
        ok: false,
        error: 'the pane-close record could not be written durably',
      })
    })

    it('an answer delivered INSIDE the send call resolves — the wait subscribes BEFORE the send', async () => {
      const send = vi.fn((msg: unknown) => {
        const m = msg as { requestId?: string }
        emit({ type: 'panes.closed.result', requestId: m.requestId, success: true })
      })
      await expect(sendPanesClosedAndAwait('tab-9', tabIdentities, { send })).resolves.toEqual({ ok: true })
      expect(send).toHaveBeenCalledTimes(1)
      expect(mockSend).not.toHaveBeenCalled()
    })

    it('times out as a UI failure (unconfirmed close — the whole tab stays)', async () => {
      vi.useFakeTimers()
      const pending = sendPanesClosedAndAwait('tab-9', tabIdentities)
      await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 10)
      await expect(pending).resolves.toEqual({ ok: false, timedOut: true })
    })
  })

  describe('sendPaneOpened (focused-episode-7 round 3 Finding F2 — the durable open re-assertion)', () => {
    it('sends pane.opened{createRequestId, tabId} for the still-present pane', () => {
      sendPaneOpened({ createRequestId: 'cr-open', tabId: 'tab-9' })
      expect(mockSend).toHaveBeenCalledWith({
        type: 'pane.opened',
        createRequestId: 'cr-open',
        tabId: 'tab-9',
      })
    })

    it('honors an injected send (the test-double shape, same as the await helpers)', () => {
      const send = vi.fn()
      sendPaneOpened({ createRequestId: 'cr-open', tabId: 'tab-9' }, { send })
      expect(send).toHaveBeenCalledWith({
        type: 'pane.opened',
        createRequestId: 'cr-open',
        tabId: 'tab-9',
      })
      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  describe('pane.opened.result (focused-episode-7 round 5 Finding F3 — the re-assertion is answered; a failed consume is retried)', () => {
    const leaf = (paneId: string, content: Record<string, unknown>) => ({
      type: 'leaf' as const,
      id: paneId,
      content,
    })
    const layoutWith = (crid: string) => ({
      'tab-1': leaf('p1', { kind: 'terminal', createRequestId: crid, terminalId: `term-${crid}`, mode: 'shell', status: 'running' }),
    } as never)

    it('a success result for the pane leaves no failure mark behind', () => {
      sendPaneOpened({ createRequestId: 'cr-open', tabId: 'tab-1' })
      emit({ type: 'pane.opened.result', createRequestId: 'cr-open', success: true })
      expect(hasOpenReassertFailure('cr-open')).toBe(false)
    })

    it('a FAILED consume is marked (never silent); the next-tick retry that succeeds clears the mark', () => {
      sendPaneOpened({ createRequestId: 'cr-open', tabId: 'tab-1' })
      emit({
        type: 'pane.opened.result',
        createRequestId: 'cr-open',
        success: false,
        error: 'the open re-assertion could not be written durably',
      })
      expect(hasOpenReassertFailure('cr-open')).toBe(true)

      // The retry (the next ready sweep re-asserts the still-displayed pane):
      // its own result resolves the failure — open state durable, never a
      // silent inconsistency.
      reassertAllOpenPanes(layoutWith('cr-open'))
      emit({ type: 'pane.opened.result', createRequestId: 'cr-open', success: true })
      expect(hasOpenReassertFailure('cr-open')).toBe(false)
    })

    it('the correlation is exact — a result for ANOTHER pane never marks or unmarks this one', () => {
      sendPaneOpened({ createRequestId: 'cr-mine', tabId: 'tab-1' })
      emit({ type: 'pane.opened.result', createRequestId: 'cr-other', success: false })
      emit({ type: 'pane.opened.result', createRequestId: 'cr-other', success: true })
      expect(hasOpenReassertFailure('cr-mine')).toBe(false)
      emit({ type: 'pane.opened.result', createRequestId: 'cr-mine', success: false })
      expect(hasOpenReassertFailure('cr-mine')).toBe(true)
      expect(hasOpenReassertFailure('cr-other')).toBe(false)
    })

    it('a failure-marked pane that is no longer DISPLAYED is pruned at the sweep — never re-asserted open behind its close', () => {
      sendPaneOpened({ createRequestId: 'cr-gone', tabId: 'tab-1' })
      emit({ type: 'pane.opened.result', createRequestId: 'cr-gone', success: false })
      expect(hasOpenReassertFailure('cr-gone')).toBe(true)
      // The pane left the layout (its close won): the sweep must never
      // re-assert an undisplayed pane — that direction erases genuine close
      // evidence. The mark prunes instead.
      const send = vi.fn()
      reassertAllOpenPanes({}, { send })
      expect(send).not.toHaveBeenCalled()
      expect(hasOpenReassertFailure('cr-gone')).toBe(false)
    })

    it('no answer inside the bounded window is NOT a failure (older-busy server): the listener unsubscribes, nothing marks, nothing leaks', async () => {
      vi.useFakeTimers()
      const baseline = handlers.size
      sendPaneOpened({ createRequestId: 'cr-silent', tabId: 'tab-1' })
      expect(handlers.size).toBe(baseline + 1)
      await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 10)
      expect(handlers.size).toBe(baseline)
      expect(hasOpenReassertFailure('cr-silent')).toBe(false)
    })

    it('a late answer after the window can never mark a failure (the settled listen is unsubscribed)', async () => {
      vi.useFakeTimers()
      sendPaneOpened({ createRequestId: 'cr-late', tabId: 'tab-1' })
      await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 10)
      vi.useRealTimers()
      emit({ type: 'pane.opened.result', createRequestId: 'cr-late', success: false })
      expect(hasOpenReassertFailure('cr-late')).toBe(false)
    })
  })

  describe('reassertAllOpenPanes (F2/r4 — the per-ready sweep re-asserts EVERY displayed pane)', () => {
    const leaf = (paneId: string, content: Record<string, unknown>) => ({
      type: 'leaf' as const,
      id: paneId,
      content,
    })

    it('asserts every DISPLAYED terminal AND fresh-agent pane (per tab, keyed by createRequestId) and skips the rest', () => {
      const send = vi.fn()
      reassertAllOpenPanes(
        {
          'tab-1': {
            type: 'split',
            id: 's1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              leaf('p1', { kind: 'terminal', createRequestId: 'cr-a', terminalId: 'term-a', mode: 'shell', status: 'running' }),
              {
                type: 'split',
                id: 's2',
                direction: 'vertical',
                sizes: [50, 50],
                children: [
                  leaf('p2', { kind: 'terminal', createRequestId: 'cr-b', mode: 'claude', status: 'creating' }), // in-flight create: CRID-only
                  leaf('p5', { kind: 'fresh-agent', createRequestId: 'cr-fa', sessionType: 'freshclaude', provider: 'claude', sessionId: 'sess-fa', status: 'idle' }),
                ],
              },
            ],
          },
          'tab-2': leaf('p3', { kind: 'terminal', createRequestId: 'cr-c', terminalId: 'term-c', mode: 'shell', status: 'running' }),
          'tab-3': leaf('p4', { kind: 'browser', url: 'https://example.com' }), // non-session: never
          'tab-4': undefined, // dead entry: never
        } as never,
        { send },
      )
      expect(send.mock.calls.map(([m]) => m)).toEqual([
        { type: 'pane.opened', createRequestId: 'cr-a', tabId: 'tab-1' },
        { type: 'pane.opened', createRequestId: 'cr-b', tabId: 'tab-1' },
        { type: 'pane.opened', createRequestId: 'cr-fa', tabId: 'tab-1' },
        { type: 'pane.opened', createRequestId: 'cr-c', tabId: 'tab-2' },
      ])
    })

    it('sends nothing when no session pane is displayed (cheap every-ready call)', () => {
      const send = vi.fn()
      reassertAllOpenPanes({}, { send })
      expect(send).not.toHaveBeenCalled()
    })
  })

  describe('focused-episode-7 round 5 (Finding F1) — the sweep never open-asserts a pane whose close is pending', () => {
    const leaf = (paneId: string, content: Record<string, unknown>) => ({
      type: 'leaf' as const,
      id: paneId,
      content,
    })
    const twoPaneLayouts = () => ({
      'tab-1': {
        type: 'split' as const,
        id: 's1',
        direction: 'horizontal' as const,
        sizes: [50, 50] as [number, number],
        children: [
          leaf('p1', { kind: 'terminal', createRequestId: 'cr-open', terminalId: 'term-open', mode: 'shell', status: 'running' }),
          leaf('p2', { kind: 'terminal', createRequestId: 'cr-closing', terminalId: 'term-closing', mode: 'shell', status: 'running' }),
        ],
      },
    } as never)

    it('the exact interleave: close queued while disconnected → reconnect flushes the close → the ready sweep MUST NOT open-assert that pane (only the ack resolves the skip)', async () => {
      // The close is in flight (sent — or queued while the socket was down —
      // and UNANSWERED). The pane is still displayed: the gate drops it only
      // after the correlated result.
      const pending = sendPaneClosedAndAwait({ createRequestId: 'cr-closing', terminalId: 'term-closing' })
      // The ready-time sweep runs while the acknowledgement is outstanding —
      // the finding's verbatim shape. The pending pane must be SKIPPED: an
      // open-assert landing behind the flushed close would consume the
      // committed close record before its ack arrives, and the post-ack
      // removal would leave a ghost row with no close evidence.
      const send = vi.fn()
      reassertAllOpenPanes(twoPaneLayouts(), { send })
      expect(send.mock.calls.map(([m]) => m)).toEqual([
        { type: 'pane.opened', createRequestId: 'cr-open', tabId: 'tab-1' },
      ])

      // The success ack resolves the wait; the gate then owns the removal.
      emit({ type: 'pane.closed.result', createRequestId: 'cr-closing', success: true })
      await expect(pending).resolves.toEqual({ ok: true })

      // Post-settle the identity is released: a sweep over a layout that
      // (hypothetically) still displayed it re-asserts it again — the skip
      // is strictly the pending window, never a latch.
      const sendAfter = vi.fn()
      reassertAllOpenPanes(twoPaneLayouts(), { send: sendAfter })
      expect(sendAfter.mock.calls.map(([m]) => m)).toEqual([
        { type: 'pane.opened', createRequestId: 'cr-open', tabId: 'tab-1' },
        { type: 'pane.opened', createRequestId: 'cr-closing', tabId: 'tab-1' },
      ])
    })

    it('the BATCH close marks every carried identity pending: the sweep skips the whole set until the ONE result resolves', async () => {
      const identities = [
        { paneId: 'p1', createRequestId: 'cr-open', terminalId: 'term-open' },
        { paneId: 'p2', createRequestId: 'cr-closing', terminalId: 'term-closing' },
      ]
      const pending = sendPanesClosedAndAwait('tab-1', identities)
      const send = vi.fn()
      reassertAllOpenPanes(twoPaneLayouts(), { send })
      expect(send, 'no open-assert lands for any batch-carried pane while its ack is outstanding')
        .not.toHaveBeenCalled()

      const sent = mockSend.mock.calls[0][0] as { requestId: string }
      emit({ type: 'panes.closed.result', requestId: sent.requestId, success: true })
      await expect(pending).resolves.toEqual({ ok: true })

      const sendAfter = vi.fn()
      reassertAllOpenPanes(twoPaneLayouts(), { send: sendAfter })
      expect(sendAfter.mock.calls.map(([m]) => m)).toHaveLength(2)
    })

    it('a FAILED close resolves the pending window too — the close path owns the immediate re-assertion (batch-4), later sweeps resume naming it', async () => {
      const pending = sendPaneClosedAndAwait({ createRequestId: 'cr-closing' })
      const send = vi.fn()
      reassertAllOpenPanes(twoPaneLayouts(), { send })
      expect(send.mock.calls.map(([m]) => m)).toEqual([
        { type: 'pane.opened', createRequestId: 'cr-open', tabId: 'tab-1' },
      ])
      emit({ type: 'pane.closed.result', createRequestId: 'cr-closing', success: false, error: 'boom' })
      await expect(pending).resolves.toEqual({ ok: false, error: 'boom' })
      const sendAfter = vi.fn()
      reassertAllOpenPanes(twoPaneLayouts(), { send: sendAfter })
      expect(sendAfter.mock.calls.map(([m]) => m)).toEqual([
        { type: 'pane.opened', createRequestId: 'cr-open', tabId: 'tab-1' },
        { type: 'pane.opened', createRequestId: 'cr-closing', tabId: 'tab-1' },
      ])
    })

    it('a TIMED-OUT close resolves the pending window', async () => {
      vi.useFakeTimers()
      const pending = sendPaneClosedAndAwait({ createRequestId: 'cr-closing' })
      const send = vi.fn()
      reassertAllOpenPanes(twoPaneLayouts(), { send })
      expect(send).toHaveBeenCalledTimes(1) // only the un-pending sibling
      await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 10)
      await expect(pending).resolves.toEqual({ ok: false, timedOut: true })
      const sendAfter = vi.fn()
      reassertAllOpenPanes(twoPaneLayouts(), { send: sendAfter })
      expect(sendAfter).toHaveBeenCalledTimes(2)
    })
  })
})

/**
 * Phase 4 behavior-preservation snapshots (plan
 * docs/plans/2026-07-08-amplifier-session-durability-plan.md §9 Phase 4).
 *
 * Scripted turn sequences on each of the four trackers must produce
 * byte-identical `listLatestCompletions()` JSON and identical emitted
 * `completionSeq` sequences before AND after the TurnCompletionLedger
 * extraction. These assertions were captured against the pre-extraction
 * trackers (verified green before the ledger adoption commit) and must never
 * change without an explicit protocol decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeActivityTracker, type ClaudeTurnCompleteEvent } from '../../../../server/coding-cli/claude-activity-tracker'
import { CodexActivityTracker, type CodexTurnCompleteEvent } from '../../../../server/coding-cli/codex-activity-tracker'
import { OpencodeActivityTracker } from '../../../../server/coding-cli/opencode-activity-tracker'
import {
  AmplifierActivityTracker,
  type AmplifierTurnCompleteEvent,
} from '../../../../server/coding-cli/amplifier-activity-tracker'

describe('ClaudeActivityTracker turn-completion snapshot', () => {
  it('scripted turns: exact completionSeq sequence and byte-identical listLatestCompletions()', () => {
    const tracker = new ClaudeActivityTracker()
    const completions: ClaudeTurnCompleteEvent[] = []
    tracker.on('turn.complete', (e: ClaudeTurnCompleteEvent) => completions.push(e))

    // t1: two BEL-terminated turns.
    tracker.trackTerminal({ terminalId: 't1', sessionId: 's-1', at: 1000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 2000 })
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 3000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 4000 })
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 5000 })
    // t2: one turn.
    tracker.trackTerminal({ terminalId: 't2', at: 1000 })
    tracker.noteInput({ terminalId: 't2', data: '\r', at: 6000 })
    tracker.noteOutput({ terminalId: 't2', data: '\x07', at: 7000 })
    // t1 exits and is re-tracked: the sequence stays monotonic (no reset to 1).
    tracker.noteExit({ terminalId: 't1' })
    tracker.trackTerminal({ terminalId: 't1', at: 8000 })
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 9000 })
    tracker.noteOutput({ terminalId: 't1', data: '\x07', at: 10_000 })

    expect(completions).toEqual([
      { terminalId: 't1', sessionId: 's-1', at: 3000, completionSeq: 1 },
      { terminalId: 't1', sessionId: 's-1', at: 5000, completionSeq: 2 },
      { terminalId: 't2', at: 7000, completionSeq: 1 },
      { terminalId: 't1', at: 10_000, completionSeq: 3 },
    ])
    expect(completions.map((c) => c.completionSeq)).toEqual([1, 2, 1, 3])
    expect(JSON.stringify(tracker.listLatestCompletions())).toBe(
      '[{"terminalId":"t1","at":10000,"completionSeq":3},'
      + '{"terminalId":"t2","at":7000,"completionSeq":1}]',
    )
  })
})

describe('CodexActivityTracker turn-completion snapshot', () => {
  it('scripted turns: exact completionSeq sequence and byte-identical listLatestCompletions()', () => {
    const tracker = new CodexActivityTracker()
    const completions: CodexTurnCompleteEvent[] = []
    tracker.on('turn.complete', (e: CodexTurnCompleteEvent) => completions.push(e))

    // term-1: two app-server-delimited turns.
    tracker.bindTerminal({ terminalId: 'term-1', sessionId: 'session-1', reason: 'association', at: 1000 })
    tracker.onTurnStarted({ terminalId: 'term-1', at: 1100 })
    tracker.onTurnCompleted({ terminalId: 'term-1', at: 1200 })
    tracker.onTurnStarted({ terminalId: 'term-1', at: 2100 })
    tracker.onTurnCompleted({ terminalId: 'term-1', at: 2200 })
    // term-2: one turn.
    tracker.bindTerminal({ terminalId: 'term-2', sessionId: 'session-2', reason: 'association', at: 1000 })
    tracker.onTurnStarted({ terminalId: 'term-2', at: 3100 })
    tracker.onTurnCompleted({ terminalId: 'term-2', at: 3200 })

    expect(completions).toEqual([
      { terminalId: 'term-1', sessionId: 'session-1', at: 1200, completionSeq: 1 },
      { terminalId: 'term-1', sessionId: 'session-1', at: 2200, completionSeq: 2 },
      { terminalId: 'term-2', sessionId: 'session-2', at: 3200, completionSeq: 1 },
    ])
    expect(completions.map((c) => c.completionSeq)).toEqual([1, 2, 1])
    expect(JSON.stringify(tracker.listLatestCompletions())).toBe(
      '[{"terminalId":"term-1","at":2200,"completionSeq":2},'
      + '{"terminalId":"term-2","at":3200,"completionSeq":1}]',
    )
  })
})

describe('OpencodeActivityTracker turn-completion snapshot', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('scripted turns: exact completionSeq sequence and byte-identical listLatestCompletions()', async () => {
    vi.useFakeTimers()
    const encoder = new TextEncoder()
    // Two busy→idle turns for the same owned session on one SSE stream.
    const sseEvents = [
      { type: 'server.connected', properties: {} },
      { type: 'session.status', properties: { sessionID: 'session-oc', status: { type: 'busy' } } },
      { type: 'session.idle', properties: { sessionID: 'session-oc' } },
      { type: 'session.status', properties: { sessionID: 'session-oc', status: { type: 'busy' } } },
      { type: 'session.idle', properties: { sessionID: 'session-oc' } },
    ]
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/global/health')) {
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
      }
      if (url.endsWith('/event')) {
        return new Response(new ReadableStream({
          start(controller) {
            for (const event of sseEvents) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
            }
            controller.close()
          },
        }), { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.endsWith('/session/status')) {
        return new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`Unexpected URL: ${url}`)
    })

    // Fixed clock so every observation timestamp is deterministic (byte-exact).
    const tracker = new OpencodeActivityTracker({
      fetchImpl: fetchImpl as typeof fetch,
      random: () => 0,
      now: () => 4000,
    })
    const completions: Array<{ terminalId: string; sessionId: string; at: number; completionSeq: number }> = []
    tracker.on('association.requested', (payload) => tracker.confirmSessionAssociation(payload))
    tracker.on('turn.complete', (payload) => completions.push(payload))

    tracker.trackTerminal({ terminalId: 'term-oc', endpoint: { hostname: '127.0.0.1', port: 43123 } })
    await vi.advanceTimersByTimeAsync(0)

    expect(completions).toEqual([
      { terminalId: 'term-oc', sessionId: 'session-oc', at: 4000, completionSeq: 1 },
      { terminalId: 'term-oc', sessionId: 'session-oc', at: 4000, completionSeq: 2 },
    ])
    expect(completions.map((c) => c.completionSeq)).toEqual([1, 2])
    expect(JSON.stringify(tracker.listLatestCompletions())).toBe(
      '[{"terminalId":"term-oc","at":4000,"completionSeq":2}]',
    )

    tracker.dispose()
  })
})

describe('AmplifierActivityTracker turn-completion snapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('scripted events-driven turns: exact completionSeq sequence and byte-identical listLatestCompletions()', () => {
    const tracker = new AmplifierActivityTracker()
    const completions: AmplifierTurnCompleteEvent[] = []
    tracker.on('turn.complete', (e: AmplifierTurnCompleteEvent) => completions.push(e))

    // Events-driven turn (prompt:complete is the single boundary).
    tracker.trackTerminal({ terminalId: 't1', at: 1000 })
    tracker.bindSession({ terminalId: 't1', sessionId: 's-1', at: 1000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: new Date(2000).toISOString() })
    tracker.applyLifecycle('t1', { kind: 'turn.completed', at: new Date(5000).toISOString() })

    // Exit + re-track: the ledger is NOT reset — the next completion continues the
    // sequence (monotonic per terminalId across terminal lifetimes).
    tracker.noteExit({ terminalId: 't1' })
    tracker.trackTerminal({ terminalId: 't1', at: 6000 })

    // Second turn: PTY submit is provisional; the lifecycle records own the boundary.
    tracker.noteInput({ terminalId: 't1', data: '\r', at: 7000 })
    tracker.applyLifecycle('t1', { kind: 'turn.began', at: new Date(7100).toISOString() })
    tracker.applyLifecycle('t1', { kind: 'turn.completed', at: new Date(9000).toISOString() })

    expect(completions).toEqual([
      { terminalId: 't1', sessionId: 's-1', at: 5000, completionSeq: 1 },
      { terminalId: 't1', at: 9000, completionSeq: 2 },
    ])
    expect(completions.map((c) => c.completionSeq)).toEqual([1, 2])
    expect(JSON.stringify(tracker.listLatestCompletions())).toBe(
      '[{"terminalId":"t1","at":9000,"completionSeq":2}]',
    )
  })
})

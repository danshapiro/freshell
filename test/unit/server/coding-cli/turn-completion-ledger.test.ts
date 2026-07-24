import { describe, expect, it } from 'vitest'
import { TurnCompletionLedger } from '../../../../server/coding-cli/turn-completion-ledger'

describe('TurnCompletionLedger', () => {
  it('starts completionSeq at 1 and increments monotonically per terminalId', () => {
    const ledger = new TurnCompletionLedger()
    expect(ledger.recordTurnCompletion({ terminalId: 't1', at: 1000 }).completionSeq).toBe(1)
    expect(ledger.recordTurnCompletion({ terminalId: 't1', at: 2000 }).completionSeq).toBe(2)
    expect(ledger.recordTurnCompletion({ terminalId: 't1', at: 3000 }).completionSeq).toBe(3)
  })

  it('keeps independent sequences per terminalId', () => {
    const ledger = new TurnCompletionLedger()
    expect(ledger.recordTurnCompletion({ terminalId: 't1', at: 1000 }).completionSeq).toBe(1)
    expect(ledger.recordTurnCompletion({ terminalId: 't2', at: 1100 }).completionSeq).toBe(1)
    expect(ledger.recordTurnCompletion({ terminalId: 't1', at: 1200 }).completionSeq).toBe(2)
    expect(ledger.recordTurnCompletion({ terminalId: 't2', at: 1300 }).completionSeq).toBe(2)
  })

  it('returns the input spread with completionSeq appended (extra fields pass through)', () => {
    const ledger = new TurnCompletionLedger()
    const event = ledger.recordTurnCompletion({ terminalId: 't1', sessionId: 's-1', at: 1000 })
    expect(event).toEqual({ terminalId: 't1', sessionId: 's-1', at: 1000, completionSeq: 1 })
    // Exact key order of the four trackers' original `{ ...input, completionSeq }`.
    expect(JSON.stringify(event)).toBe('{"terminalId":"t1","sessionId":"s-1","at":1000,"completionSeq":1}')
  })

  it('listLatestCompletions keeps only the latest snapshot per terminal, without extra fields', () => {
    const ledger = new TurnCompletionLedger()
    ledger.recordTurnCompletion({ terminalId: 't1', sessionId: 's-1', at: 1000 })
    ledger.recordTurnCompletion({ terminalId: 't1', sessionId: 's-1', at: 2000 })
    expect(ledger.listLatestCompletions()).toEqual([{ terminalId: 't1', at: 2000, completionSeq: 2 }])
    // Snapshot shape is exactly { terminalId, at, completionSeq } (no sessionId).
    expect(JSON.stringify(ledger.listLatestCompletions())).toBe(
      '[{"terminalId":"t1","at":2000,"completionSeq":2}]',
    )
  })

  it('listLatestCompletions preserves first-completion insertion order across terminals', () => {
    const ledger = new TurnCompletionLedger()
    ledger.recordTurnCompletion({ terminalId: 't1', at: 1000 })
    ledger.recordTurnCompletion({ terminalId: 't2', at: 1100 })
    // Updating t1 must not move it behind t2 (Map.set on an existing key keeps position).
    ledger.recordTurnCompletion({ terminalId: 't1', at: 1200 })
    expect(ledger.listLatestCompletions()).toEqual([
      { terminalId: 't1', at: 1200, completionSeq: 2 },
      { terminalId: 't2', at: 1100, completionSeq: 1 },
    ])
  })

  it('never forgets a terminal: seq stays monotonic and snapshots survive (matches tracker removal semantics)', () => {
    // None of the four trackers clear ledger state on terminal removal (noteExit /
    // untrackTerminal): completionSeq must stay monotonic if the same terminalId
    // completes again, and the latest snapshot outlives the activity record so
    // late-attaching clients still receive it.
    const ledger = new TurnCompletionLedger()
    ledger.recordTurnCompletion({ terminalId: 't1', at: 1000 })
    // (a tracker would remove + re-track t1 here)
    expect(ledger.recordTurnCompletion({ terminalId: 't1', at: 5000 }).completionSeq).toBe(2)
    expect(ledger.listLatestCompletions()).toEqual([{ terminalId: 't1', at: 5000, completionSeq: 2 }])
  })
})

import { describe, expect, it } from 'vitest'
import { createTurnCompleteGate } from '../../../crates/freshell-claude-sidecar/turn-complete-gate.mjs'

// Result shapes are the pinned CLI's (claude-cli-contract.test.ts): a Stop
// that landed ends the turn with error_during_execution and
// terminal_reason aborted_streaming / aborted_tools (T11); a Stop that missed
// the turn (sent while the CLI was still starting) lets it run to
// success/completed (T13).
const result = (subtype: string, terminalReason?: string, isError = subtype !== 'success') => ({
  type: 'result',
  subtype,
  is_error: isError,
  ...(terminalReason ? { terminal_reason: terminalReason } : {}),
})
const completed = result('success', 'completed')
const stoppedStreaming = result('error_during_execution', 'aborted_streaming')
const stoppedTools = result('error_during_execution', 'aborted_tools')

/** A gate whose user Stop was accepted (the settle came back ok). */
function stoppedGate() {
  const gate = createTurnCompleteGate()
  gate.noteInterruptRequest()
  gate.noteInterruptSettled(true)
  return gate
}

describe('freshell-claude-sidecar turn-complete gate', () => {
  it('rings for every result with no Stop pending', () => {
    for (const ending of [
      completed,
      result('success', 'api_error', true),
      result('error_during_execution', 'model_error'),
      result('error_max_turns', 'max_turns'),
      result('error_max_budget_usd'),
      result('error_max_structured_output_retries'),
      // An aborted turn the user did not stop still rings.
      stoppedStreaming,
    ]) {
      const gate = createTurnCompleteGate()
      expect(gate.resultEmitsAttention(ending), `${ending.subtype}/${ending.terminal_reason}`).toBe(true)
    }
  })

  it('silences the stopped turn\'s own aborted result, and only that one', () => {
    for (const stopped of [stoppedStreaming, stoppedTools]) {
      const gate = stoppedGate()
      expect(gate.resultEmitsAttention(stopped)).toBe(false)
      expect(gate.resultEmitsAttention(completed)).toBe(true)
    }
  })

  it('a Stop that missed its turn never silences it: the turn completes and rings (G06)', () => {
    const gate = stoppedGate()
    expect(gate.resultEmitsAttention(completed)).toBe(true)
  })

  it('a Stop that missed its turn leaves no mark behind for a later result', () => {
    const gate = stoppedGate()
    expect(gate.resultEmitsAttention(completed)).toBe(true)
    // A later aborted result (no new Stop) is not the user's Stop: it rings.
    expect(gate.resultEmitsAttention(stoppedStreaming)).toBe(true)
  })

  it('a failed turn under a missed Stop rings', () => {
    const gate = stoppedGate()
    expect(gate.resultEmitsAttention(result('error_max_turns', 'max_turns'))).toBe(true)
  })

  it('treats error_during_execution as the stopped turn on a CLI that reports no terminal_reason', () => {
    const gate = stoppedGate()
    expect(gate.resultEmitsAttention(result('error_during_execution'))).toBe(false)
    // Without a Stop pending, the same result rings.
    expect(createTurnCompleteGate().resultEmitsAttention(result('error_during_execution'))).toBe(true)
  })

  it('a rejected interrupt (ok:false) never silences a later result', () => {
    const gate = createTurnCompleteGate()
    gate.noteInterruptRequest()
    gate.noteInterruptSettled(false)
    expect(gate.resultEmitsAttention(stoppedStreaming)).toBe(true)
  })

  it('a mark survives a queued send and silences only the stopped turn\'s result (no reset-at-send)', () => {
    // The SDK serializes turns within one query, so the stopped turn's result
    // is the FIRST result after the settle even if the next prompt was queued
    // before it arrived.
    const gate = stoppedGate()
    // (queued send happens here — the gate deliberately does NOT reset)
    expect(gate.resultEmitsAttention(stoppedStreaming)).toBe(false)
    expect(gate.resultEmitsAttention(completed)).toBe(true)
  })

  it('an interrupt with nothing pending never arms (the arm site skips the arm when no turn awaits a terminal frame)', () => {
    // The gate stays pure; the ARM-SITE policy it serves (index.mjs
    // handleInterrupt) is `if (st.pendingResults > 0)
    // st.turnCompleteGate.noteInterruptRequest()`. With NOTHING pending the
    // SDK RESOLVES the interrupt (settle ok:true, no result ever follows —
    // sdk.d.ts:2384-2394), so no mark may survive to eat the NEXT unrelated
    // turn's result.
    const gate = createTurnCompleteGate()
    const pendingResults = 0
    if (pendingResults > 0) gate.noteInterruptRequest()
    gate.noteInterruptSettled(true)
    expect(gate.resultEmitsAttention(stoppedStreaming)).toBe(true)
  })
})

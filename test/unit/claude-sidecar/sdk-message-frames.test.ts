// @vitest-environment node

// The pure SDK message -> sidecar frame mapping
// (crates/freshell-claude-sidecar/sdk-message-frames.mjs). The result shapes
// are the pinned CLI's (claude-cli-contract.test.ts): T11 for a Stop (an
// error_during_execution whose only error is an `[ede_diagnostic]` line), T18
// for an API error (success with is_error).

import { describe, expect, it } from 'vitest'
import { resultErrors, resultErrorText, resultFrames } from '../../../crates/freshell-claude-sidecar/sdk-message-frames.mjs'

const STOP_DIAGNOSTIC = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'
const TOOL_STOP_DIAGNOSTIC = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use'

/** A result as the pinned CLI reports a Stop that landed during streamed text (T11). */
const stoppedResult = (terminalReason = 'aborted_streaming', diagnostic = STOP_DIAGNOSTIC) => ({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  terminal_reason: terminalReason,
  errors: [diagnostic],
  duration_ms: 12,
  total_cost_usd: 0,
  usage: { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard' },
})

describe('resultErrorText', () => {
  it('has no text for a successful result, including an API error (the transcript shows that one, T18)', () => {
    expect(resultErrorText({ subtype: 'success', is_error: false, terminal_reason: 'completed' })).toBeUndefined()
    expect(resultErrorText({ subtype: 'success', is_error: true, terminal_reason: 'api_error' })).toBeUndefined()
  })

  it('reports the errors the CLI gave', () => {
    expect(resultErrorText({ subtype: 'error_during_execution', errors: ['Request timed out'] })).toBe('Request timed out')
    expect(resultErrorText({ subtype: 'error_during_execution', errors: ['First', '  ', 'Second'] })).toBe('First\nSecond')
  })

  it('never shows the CLI\'s internal [ede_diagnostic] lines', () => {
    expect(resultErrorText({ subtype: 'error_during_execution', errors: [STOP_DIAGNOSTIC, 'Request timed out'] })).toBe('Request timed out')
    expect(resultErrorText({ subtype: 'error_during_execution', errors: ['  [ede_diagnostic] stop_reason=null', 'Overloaded'] })).toBe('Overloaded')
    expect(resultErrorText({ subtype: 'error_during_execution', errors: [STOP_DIAGNOSTIC] })).not.toContain('ede_diagnostic')
  })

  it('explains an aborted turn nobody stopped in plain words when the CLI gave only diagnostics', () => {
    expect(resultErrorText(stoppedResult('aborted_streaming'))).toBe('Claude stopped the turn before it finished.')
    expect(resultErrorText(stoppedResult('aborted_tools', TOOL_STOP_DIAGNOSTIC))).toBe('Claude stopped the turn before it finished.')
  })

  it('falls back to the copy for the result kind when no error text is left', () => {
    expect(resultErrorText({ subtype: 'error_during_execution', errors: [STOP_DIAGNOSTIC] })).toBe('Claude could not complete this turn. Try sending your message again.')
    expect(resultErrorText({ subtype: 'error_during_execution' })).toBe('Claude could not complete this turn. Try sending your message again.')
    expect(resultErrorText({ subtype: 'error_max_turns', errors: [] })).toBe('Claude reached its turn limit. Send a message to continue.')
    expect(resultErrorText({ subtype: 'error_max_budget_usd' })).toBe('Claude reached the configured spending limit.')
    expect(resultErrorText({ subtype: 'error_max_structured_output_retries' })).toBe('Claude could not produce the requested response format.')
  })
})

describe('resultErrors', () => {
  it('is the CLI\'s own error text with its internal diagnostics removed, and nothing more', () => {
    expect(resultErrors({ subtype: 'error_during_execution', errors: [STOP_DIAGNOSTIC, ' Request timed out ', 'Overloaded'] })).toBe('Request timed out\nOverloaded')
    // No plain-words fallback here: a result whose errors are all diagnostics has none.
    expect(resultErrors(stoppedResult())).toBeUndefined()
    expect(resultErrors({ subtype: 'error_max_turns', errors: [] })).toBeUndefined()
    expect(resultErrors({ subtype: 'success', is_error: false })).toBeUndefined()
    expect(resultErrors({ subtype: 'error_during_execution', errors: [42, null, 'Real'] })).toBe('Real')
  })
})

describe('resultFrames', () => {
  it('forwards a successful result with no failure frame', () => {
    const frames = resultFrames('s1', { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', num_turns: 1, duration_ms: 40, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 1, service_tier: 'standard' } }, { userStopped: false })
    expect(frames).toEqual([
      { type: 'sdk.result', sessionId: 's1', result: 'success', subtype: 'success', isError: false, terminalReason: 'completed', numTurns: 1, durationMs: 40, costUsd: 0.01, usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 1 } },
    ])
  })

  // The verdict facts the server's turn ledger reads (design §5.3): how the
  // turn ended and the CLI's own error text, with no diagnostics.
  it('carries how the turn ended: an API error (T18), a Stop (T11), a failure with its text', () => {
    expect(resultFrames('s1', { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', num_turns: 1 }, { userStopped: false })[0])
      .toMatchObject({ subtype: 'success', isError: true, terminalReason: 'api_error', numTurns: 1 })
    const stopped = resultFrames('s1', { ...stoppedResult(), num_turns: 2 }, { userStopped: true })[0]
    expect(stopped).toMatchObject({ subtype: 'error_during_execution', isError: true, terminalReason: 'aborted_streaming', numTurns: 2 })
    expect(stopped).not.toHaveProperty('errorText')
    expect(resultFrames('s1', { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 3, errors: [STOP_DIAGNOSTIC, 'Request timed out'] }, { userStopped: false })[0])
      .toMatchObject({ subtype: 'error_during_execution', isError: true, numTurns: 3, errorText: 'Request timed out' })
  })

  it('leaves out what an older CLI does not report', () => {
    const [frame] = resultFrames('s1', { type: 'result', subtype: 'error_during_execution', errors: ['boom'] }, { userStopped: false })
    expect(frame).not.toHaveProperty('terminalReason')
    expect(frame).not.toHaveProperty('numTurns')
    expect(frame).toMatchObject({ isError: true, errorText: 'boom' })
  })

  it('follows a failed result with the turn failure, sanitized', () => {
    const frames = resultFrames('s1', { type: 'result', subtype: 'error_during_execution', errors: [STOP_DIAGNOSTIC, 'Request timed out'], duration_ms: 3 }, { userStopped: false })
    expect(frames.map((frame) => frame.type)).toEqual(['sdk.result', 'sdk.error'])
    expect(frames[0]).toMatchObject({ sessionId: 's1', result: 'error_during_execution', durationMs: 3, usage: undefined })
    expect(frames[1]).toEqual({ type: 'sdk.error', sessionId: 's1', message: 'Request timed out', turnFailure: true })
  })

  it('reports the user\'s own Stop as a plain result: no failure banner (G03)', () => {
    for (const result of [stoppedResult('aborted_streaming'), stoppedResult('aborted_tools', TOOL_STOP_DIAGNOSTIC)]) {
      const frames = resultFrames('s1', result, { userStopped: true })
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ type: 'sdk.result', sessionId: 's1', result: 'error_during_execution' })
    }
  })

  it('still reports an aborted turn the user did not stop', () => {
    expect(resultFrames('s1', stoppedResult(), { userStopped: false })[1])
      .toEqual({ type: 'sdk.error', sessionId: 's1', message: 'Claude stopped the turn before it finished.', turnFailure: true })
  })
})

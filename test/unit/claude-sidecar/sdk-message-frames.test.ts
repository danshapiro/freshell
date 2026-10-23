// @vitest-environment node

// The pure SDK message -> sidecar frame mapping
// (crates/freshell-claude-sidecar/sdk-message-frames.mjs). The result shapes
// are the pinned CLI's (claude-cli-contract.test.ts): T11 for a Stop (an
// error_during_execution whose only error is an `[ede_diagnostic]` line), T18
// for an API error (success with is_error).
//
// From C18 a result maps to its facts alone: whether the turn rings and the
// failure banner it shows (the copy for each result kind, the plain words for
// an aborted turn nobody stopped) are the server's verdict
// (crates/freshell-freshagent/src/claude_turns_stop_tests.rs).

import { describe, expect, it } from 'vitest'
import { resultErrors, resultFrames } from '../../../crates/freshell-claude-sidecar/sdk-message-frames.mjs'

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
    const frames = resultFrames('s1', { type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', num_turns: 1, duration_ms: 40, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 1, service_tier: 'standard' } })
    expect(frames).toEqual([
      { type: 'sdk.result', sessionId: 's1', result: 'success', subtype: 'success', isError: false, terminalReason: 'completed', numTurns: 1, durationMs: 40, costUsd: 0.01, usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 1 } },
    ])
  })

  // The verdict facts the server's turn ledger reads (design §5.3): how the
  // turn ended and the CLI's own error text, with no diagnostics.
  it('carries how the turn ended: an API error (T18), a Stop (T11), a failure with its text', () => {
    expect(resultFrames('s1', { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', num_turns: 1 })[0])
      .toMatchObject({ subtype: 'success', isError: true, terminalReason: 'api_error', numTurns: 1 })
    const stopped = resultFrames('s1', { ...stoppedResult(), num_turns: 2 })[0]
    expect(stopped).toMatchObject({ subtype: 'error_during_execution', isError: true, terminalReason: 'aborted_streaming', numTurns: 2 })
    expect(stopped).not.toHaveProperty('errorText')
    expect(resultFrames('s1', { type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 3, errors: [STOP_DIAGNOSTIC, 'Request timed out'] })[0])
      .toMatchObject({ subtype: 'error_during_execution', isError: true, numTurns: 3, errorText: 'Request timed out' })
  })

  it('leaves out what an older CLI does not report', () => {
    const [frame] = resultFrames('s1', { type: 'result', subtype: 'error_during_execution', errors: ['boom'] })
    expect(frame).not.toHaveProperty('terminalReason')
    expect(frame).not.toHaveProperty('numTurns')
    expect(frame).toMatchObject({ isError: true, errorText: 'boom' })
  })

  it('maps a failed result to one frame with its sanitized error text: the banner is the server\'s', () => {
    const frames = resultFrames('s1', { type: 'result', subtype: 'error_during_execution', errors: [STOP_DIAGNOSTIC, 'Request timed out'], duration_ms: 3 })
    expect(frames).toEqual([
      { type: 'sdk.result', sessionId: 's1', result: 'error_during_execution', subtype: 'error_during_execution', isError: true, errorText: 'Request timed out', durationMs: 3, costUsd: undefined, usage: undefined },
    ])
  })

  it('maps an aborted result (a Stop, T11) to one frame whose diagnostics never reach the server', () => {
    for (const result of [stoppedResult('aborted_streaming'), stoppedResult('aborted_tools', TOOL_STOP_DIAGNOSTIC)]) {
      const frames = resultFrames('s1', result)
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ type: 'sdk.result', sessionId: 's1', result: 'error_during_execution', terminalReason: result.terminal_reason })
      expect(JSON.stringify(frames)).not.toContain('ede_diagnostic')
    }
  })
})

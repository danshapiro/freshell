import { describe, expect, it } from 'vitest'

import {
  beginTerminalOutputWriteScope,
  getTerminalOutputWriteScope,
  shouldAllowTerminalOutputSideEffect,
} from '@/lib/terminal-output-write-scope'

describe('terminal output write scope', () => {
  it('keeps replay context visible until the submitted write completes', () => {
    const scope = beginTerminalOutputWriteScope({
      terminalInstanceId: 'surface-1',
      source: 'replay',
      attachRequestId: 'attach-1',
      generation: 'attach-1',
      suppressExternalSideEffects: true,
    })

    expect(getTerminalOutputWriteScope('surface-1')?.source).toBe('replay')
    expect(shouldAllowTerminalOutputSideEffect({
      terminalInstanceId: 'surface-1',
      effect: 'request_mode_reply',
      mode: 'shell',
    })).toBe(false)

    scope.complete()
    expect(getTerminalOutputWriteScope('surface-1')).toBeNull()
  })

  it('only completes the submitted scope that is still current for the terminal instance', () => {
    const replayScope = beginTerminalOutputWriteScope({
      terminalInstanceId: 'surface-1',
      source: 'replay',
      attachRequestId: 'attach-1',
      generation: 'attach-1',
      suppressExternalSideEffects: true,
    })
    const liveScope = beginTerminalOutputWriteScope({
      terminalInstanceId: 'surface-1',
      source: 'live',
      attachRequestId: 'attach-2',
      generation: 'attach-2',
      suppressExternalSideEffects: false,
    })

    replayScope.complete()
    expect(getTerminalOutputWriteScope('surface-1')?.source).toBe('live')

    liveScope.complete()
    expect(getTerminalOutputWriteScope('surface-1')).toBeNull()
  })

  it('suppresses external side effects during replay writes', () => {
    expect(shouldAllowTerminalOutputSideEffect({
      terminalInstanceId: 'surface-1',
      source: 'replay',
      effect: 'request_mode_reply',
      mode: 'shell',
    })).toBe(false)
    expect(shouldAllowTerminalOutputSideEffect({
      source: 'replay',
      effect: 'osc52_clipboard_write',
      mode: 'shell',
    })).toBe(false)
    expect(shouldAllowTerminalOutputSideEffect({
      source: 'replay',
      effect: 'title_update',
      mode: 'shell',
    })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { createTerminalStreamIdentityTracker } from '../../../../server/terminal-stream/stream-identity'

describe('terminal stream identity', () => {
  it('keeps stream id stable across attach and detach for the same output stream', () => {
    const tracker = createTerminalStreamIdentityTracker()
    const initial = tracker.ensureStream('term-1')

    expect(tracker.ensureStream('term-1')).toBe(initial)
    tracker.recordAttach('term-1')
    tracker.recordDetach('term-1')

    expect(tracker.ensureStream('term-1')).toBe(initial)
  })

  it('changes stream id on pty replacement and incompatible restart recovery', () => {
    const tracker = createTerminalStreamIdentityTracker()
    const initial = tracker.ensureStream('term-1')

    const afterCodexRecovery = tracker.replaceStream('term-1', 'codex_pty_recovery')
    const afterRestartRecovery = tracker.replaceStream('term-1', 'server_restart_incompatible_retention')

    expect(afterCodexRecovery).not.toBe(initial)
    expect(afterRestartRecovery).not.toBe(afterCodexRecovery)
  })

  it('uses fixed-length opaque stream ids across replacements', () => {
    const tracker = createTerminalStreamIdentityTracker()
    const ids = [
      tracker.ensureStream('term-variable-length-name'),
      tracker.replaceStream('term-variable-length-name', 'codex_pty_recovery'),
      tracker.replaceStream('term-variable-length-name', 'server_restart_incompatible_retention'),
    ]

    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(ids.map((id) => id.length)).size).toBe(1)
  })
})

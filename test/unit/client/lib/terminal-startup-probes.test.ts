import { describe, expect, it } from 'vitest'

import {
  createTerminalStartupProbeState,
  extractTerminalStartupProbes,
} from '@/lib/terminal-startup-probes'
import {
  CODEX_STARTUP_EXPECTED_CLEANED_FRAMES,
  CODEX_STARTUP_EXPECTED_REPLIES,
  CODEX_STARTUP_QUERY_FRAMES,
  CODEX_STARTUP_TITLE_FRAME,
} from '@test/helpers/codex-startup-probes'
import {
  OPEN_CODE_STARTUP_EXPECTED_CLEANED,
  OPEN_CODE_STARTUP_EXPECTED_REPLIES,
  OPEN_CODE_STARTUP_POST_REPLY_FRAMES,
  OPEN_CODE_STARTUP_PROBE_FRAME,
  OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES,
} from '@test/helpers/opencode-startup-probes'

const COLORS = {
  foreground: '#aabbcc',
  background: '#112233',
  cursor: '#ddeeff',
}

describe('terminal-startup-probes', () => {
  it('extracts the captured startup probe and passes the captured post-reply frames through unchanged', () => {
    const state = createTerminalStartupProbeState()
    const probe = extractTerminalStartupProbes(OPEN_CODE_STARTUP_PROBE_FRAME, state, COLORS)

    expect(probe.cleaned).toBe('')
    expect(probe.replies).toEqual(OPEN_CODE_STARTUP_EXPECTED_REPLIES)

    const cleaned = OPEN_CODE_STARTUP_POST_REPLY_FRAMES.map((frame) => {
      const result = extractTerminalStartupProbes(frame, state, COLORS)
      expect(result.replies).toEqual([])
      return result.cleaned
    }).join('')

    expect(cleaned).toBe(OPEN_CODE_STARTUP_EXPECTED_CLEANED)
  })

  it('buffers the shared split startup-probe fixture across frames', () => {
    const state = createTerminalStartupProbeState()
    const [firstFrame, secondFrame] = OPEN_CODE_STARTUP_PROBE_SPLIT_FRAMES
    const [firstPostReplyFrame = ''] = OPEN_CODE_STARTUP_POST_REPLY_FRAMES

    const first = extractTerminalStartupProbes(
      firstFrame,
      state,
      COLORS,
    )
    expect(first.cleaned).toBe('')
    expect(first.replies).toEqual([])

    const second = extractTerminalStartupProbes(
      `${secondFrame}${firstPostReplyFrame}`,
      state,
      COLORS,
    )
    expect(second.cleaned).toBe(OPEN_CODE_STARTUP_EXPECTED_CLEANED)
    expect(second.replies).toEqual(OPEN_CODE_STARTUP_EXPECTED_REPLIES)
  })

  it('passes unrelated OSC/APC traffic through unchanged', () => {
    const state = createTerminalStartupProbeState()
    const input = 'prefix\u001b]0;Window title\u0007middle\u001b_Gi=31337;AAAA\u001b\\suffix'

    const result = extractTerminalStartupProbes(input, state, COLORS)

    expect(result.cleaned).toBe(input)
    expect(result.replies).toEqual([])
  })

  it('passes malformed recognized startup-probe traffic through unchanged', () => {
    const state = createTerminalStartupProbeState()
    const input = 'prefix\u001b]11;?\u001b\\suffix'

    const result = extractTerminalStartupProbes(input, state, COLORS)

    expect(result.cleaned).toBe(input)
    expect(result.replies).toEqual([])
  })

  it('passes a standalone cursor-position query through unchanged until the Codex startup prefix is matched', () => {
    const state = createTerminalStartupProbeState()
    const input = '\u001b[6n'

    const result = extractTerminalStartupProbes(input, state, COLORS)

    expect(result.cleaned).toBe(input)
    expect(result.replies).toEqual([])
  })

  it('passes OSC 11 queries through unchanged when they are embedded in ordinary output', () => {
    const state = createTerminalStartupProbeState()
    const input = `before${OPEN_CODE_STARTUP_PROBE_FRAME}after`

    const result = extractTerminalStartupProbes(input, state, COLORS)

    expect(result.cleaned).toBe(input)
    expect(result.replies).toEqual([])
  })

  it('preserves incomplete unknown escape traffic until the frame completes', () => {
    const state = createTerminalStartupProbeState()

    const first = extractTerminalStartupProbes('before\u001b]0;Window title', state, COLORS)
    expect(first.cleaned).toBe('before')
    expect(first.replies).toEqual([])

    const second = extractTerminalStartupProbes('\u0007after', state, COLORS)
    expect(second.cleaned).toBe('\u001b]0;Window title\u0007after')
    expect(second.replies).toEqual([])
  })

  it('extracts the captured Codex startup queries and preserves the non-query control prefix', () => {
    const state = createTerminalStartupProbeState()

    const cleaned = CODEX_STARTUP_QUERY_FRAMES.map((frame, index) => {
      const result = extractTerminalStartupProbes(frame, state, COLORS)
      expect(result.replies).toEqual([CODEX_STARTUP_EXPECTED_REPLIES[index]])
      return result.cleaned
    }).join('')

    expect(cleaned).toBe(CODEX_STARTUP_EXPECTED_CLEANED_FRAMES.join(''))
  })

  it('keeps later title updates intact while the Codex startup prefix is still armed', () => {
    const state = createTerminalStartupProbeState()

    const first = extractTerminalStartupProbes(CODEX_STARTUP_QUERY_FRAMES[0], state, COLORS)
    expect(first.cleaned).toBe(CODEX_STARTUP_EXPECTED_CLEANED_FRAMES[0])
    expect(first.replies).toEqual([CODEX_STARTUP_EXPECTED_REPLIES[0]])

    const title = extractTerminalStartupProbes(CODEX_STARTUP_TITLE_FRAME, state, COLORS)
    expect(title.cleaned).toBe(CODEX_STARTUP_TITLE_FRAME)
    expect(title.replies).toEqual([])

    const second = extractTerminalStartupProbes(CODEX_STARTUP_QUERY_FRAMES[1], state, COLORS)
    expect(second.cleaned).toBe(CODEX_STARTUP_EXPECTED_CLEANED_FRAMES[1])
    expect(second.replies).toEqual([CODEX_STARTUP_EXPECTED_REPLIES[1]])
  })
})

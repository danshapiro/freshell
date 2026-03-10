import { describe, expect, it } from 'vitest'
import { createTerminalMirrorFixture } from '@test/helpers/visible-first/terminal-mirror-fixture'

describe('createTerminalMirrorFixture', () => {
  it('applies deterministic output, serializes the viewport, answers scrollback and search queries, and simulates replay overflow', () => {
    const mirror = createTerminalMirrorFixture({
      rows: 3,
      cols: 20,
      replayMaxBytes: 12,
    })

    mirror.applyOutput('\u001b[31mred\u001b[0m\nplain')

    const viewport = mirror.serializeViewport()
    expect(viewport.lines).toEqual(['red', 'plain'])
    expect(viewport.tailSeq).toBe(1)

    const scrollback = mirror.getScrollbackPage({ limit: 2 })
    expect(scrollback.items.map((item) => item.text)).toEqual(['red', 'plain'])

    const search = mirror.search('red')
    expect(search.matches).toEqual([
      expect.objectContaining({ line: 0, text: 'red' }),
    ])

    mirror.applyOutput('\n1234567890')
    mirror.applyOutput('\nabcdefghij')

    const replay = mirror.replaySince(0)
    expect(replay.missedFromSeq).toBeGreaterThan(0)
    expect(replay.frames.length).toBeGreaterThan(0)
  })
})

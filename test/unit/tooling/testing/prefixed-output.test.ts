import { describe, expect, it } from 'vitest'

import { createLinePrefixer } from '../../../../scripts/testing/prefixed-output.js'

describe('createLinePrefixer()', () => {
  it('prefixes whole lines, joins lines and characters split across chunks, and flushes a trailing partial line', () => {
    const writes: string[] = []
    const prefixer = createLinePrefixer('[cloud client] ', (text) => writes.push(text))

    prefixer.push('one\ntw')
    prefixer.push('o\r\nthr')
    prefixer.push(Buffer.from([0xe2, 0x9c]))
    prefixer.push(Buffer.from([0x93, 0x0a]))
    prefixer.push('tail')
    expect(writes.join('')).toBe('[cloud client] one\n[cloud client] two\n[cloud client] thr✓\n')

    prefixer.flush()
    expect(writes.join('')).toBe('[cloud client] one\n[cloud client] two\n[cloud client] thr✓\n[cloud client] tail\n')
  })

  it('writes each chunk\'s complete lines in a single write so they cannot interleave with other output', () => {
    const writes: string[] = []
    const prefixer = createLinePrefixer('[p] ', (text) => writes.push(text))

    prefixer.push('a\nb\nc\n')
    prefixer.flush()

    expect(writes).toEqual(['[p] a\n[p] b\n[p] c\n'])
  })
})

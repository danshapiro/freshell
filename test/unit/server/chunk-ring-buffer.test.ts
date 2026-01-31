import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ChunkRingBuffer } from '../../../server/terminal-registry'

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}))

describe('ChunkRingBuffer', () => {
  describe('append', () => {
    it('adds chunks to buffer', () => {
      const buffer = new ChunkRingBuffer(100)
      buffer.append('hello')
      buffer.append(' world')
      expect(buffer.snapshot()).toBe('hello world')
    })

    it('accumulates multiple chunks', () => {
      const buffer = new ChunkRingBuffer(1000)
      buffer.append('first')
      buffer.append('second')
      buffer.append('third')
      expect(buffer.snapshot()).toBe('firstsecondthird')
    })

    it('enforces maxChars limit by truncating old data', () => {
      const buffer = new ChunkRingBuffer(10)
      buffer.append('12345') // size: 5
      buffer.append('67890') // size: 10
      expect(buffer.snapshot()).toBe('1234567890')

      // Adding more should drop oldest chunks
      buffer.append('abc') // would be 13 chars, exceeds 10
      // Should drop '12345' to get back under limit
      expect(buffer.snapshot()).toBe('67890abc') // 8 chars
    })

    it('removes multiple old chunks when needed to stay under limit', () => {
      const buffer = new ChunkRingBuffer(15)
      buffer.append('aaaaa') // 5 chars
      buffer.append('bbbbb') // 10 chars
      buffer.append('ccccc') // 15 chars
      expect(buffer.snapshot()).toBe('aaaaabbbbbccccc')

      // Adding 10 more chars should drop first two chunks
      buffer.append('dddddddddd') // would be 25, need to drop to <= 15
      // Drops 'aaaaa' (still 20), drops 'bbbbb' (now 15)
      expect(buffer.snapshot()).toBe('cccccdddddddddd')
    })

    it('handles empty string appends', () => {
      const buffer = new ChunkRingBuffer(100)
      buffer.append('hello')
      buffer.append('')
      buffer.append(' world')
      expect(buffer.snapshot()).toBe('hello world')
    })

    it('handles null-ish values gracefully via empty check', () => {
      const buffer = new ChunkRingBuffer(100)
      buffer.append('hello')
      // @ts-expect-error - testing runtime behavior with undefined
      buffer.append(undefined)
      // @ts-expect-error - testing runtime behavior with null
      buffer.append(null)
      buffer.append(' world')
      expect(buffer.snapshot()).toBe('hello world')
    })

    it('handles single oversized chunk by truncating to maxChars', () => {
      const buffer = new ChunkRingBuffer(10)
      buffer.append('this is a very long string that exceeds the limit')
      // Should keep only the last 10 characters: ' the limit' (note leading space)
      expect(buffer.snapshot()).toBe(' the limit')
      expect(buffer.snapshot().length).toBe(10)
    })

    it('truncates oversized chunk when added after existing chunks', () => {
      const buffer = new ChunkRingBuffer(10)
      buffer.append('aaa') // 3 chars
      // Adding 20 chars makes total 23, drops 'aaa' (still 20 > 10), single chunk truncated
      buffer.append('12345678901234567890')
      expect(buffer.snapshot()).toBe('1234567890')
      expect(buffer.snapshot().length).toBe(10)
    })

    it('keeps last maxChars characters when truncating oversized chunk', () => {
      const buffer = new ChunkRingBuffer(5)
      buffer.append('abcdefghij') // 10 chars
      // Should keep 'fghij' (last 5 chars)
      expect(buffer.snapshot()).toBe('fghij')
    })
  })

  describe('snapshot', () => {
    it('returns empty string for new buffer', () => {
      const buffer = new ChunkRingBuffer(100)
      expect(buffer.snapshot()).toBe('')
    })

    it('returns concatenated chunks', () => {
      const buffer = new ChunkRingBuffer(100)
      buffer.append('chunk1')
      buffer.append('chunk2')
      buffer.append('chunk3')
      expect(buffer.snapshot()).toBe('chunk1chunk2chunk3')
    })

    it('does not modify buffer state', () => {
      const buffer = new ChunkRingBuffer(100)
      buffer.append('hello')

      // Call snapshot multiple times
      const first = buffer.snapshot()
      const second = buffer.snapshot()

      expect(first).toBe('hello')
      expect(second).toBe('hello')

      // Buffer should still work normally
      buffer.append(' world')
      expect(buffer.snapshot()).toBe('hello world')
    })
  })

  describe('clear', () => {
    it('empties the buffer', () => {
      const buffer = new ChunkRingBuffer(100)
      buffer.append('hello')
      buffer.append(' world')
      expect(buffer.snapshot()).toBe('hello world')

      buffer.clear()
      expect(buffer.snapshot()).toBe('')
    })

    it('allows appending after clear', () => {
      const buffer = new ChunkRingBuffer(100)
      buffer.append('old data')
      buffer.clear()
      buffer.append('new data')
      expect(buffer.snapshot()).toBe('new data')
    })

    it('resets size tracking after clear', () => {
      const buffer = new ChunkRingBuffer(10)
      buffer.append('12345678') // 8 chars
      buffer.clear()

      // Should be able to add full capacity again
      buffer.append('abcdefghij') // 10 chars
      expect(buffer.snapshot()).toBe('abcdefghij')
    })

    it('can be called on empty buffer', () => {
      const buffer = new ChunkRingBuffer(100)
      buffer.clear() // Should not throw
      expect(buffer.snapshot()).toBe('')
    })

    it('can be called multiple times', () => {
      const buffer = new ChunkRingBuffer(100)
      buffer.append('data')
      buffer.clear()
      buffer.clear()
      buffer.clear()
      expect(buffer.snapshot()).toBe('')
    })
  })

  describe('edge cases', () => {
    it('handles maxChars of 1', () => {
      const buffer = new ChunkRingBuffer(1)
      buffer.append('abc')
      expect(buffer.snapshot()).toBe('c')

      buffer.append('x')
      expect(buffer.snapshot()).toBe('x')
    })

    it('handles exact size match', () => {
      const buffer = new ChunkRingBuffer(10)
      buffer.append('1234567890')
      expect(buffer.snapshot()).toBe('1234567890')
      expect(buffer.snapshot().length).toBe(10)
    })

    it('handles just under size limit', () => {
      const buffer = new ChunkRingBuffer(10)
      buffer.append('123456789') // 9 chars
      expect(buffer.snapshot()).toBe('123456789')

      buffer.append('0') // exactly 10 chars
      expect(buffer.snapshot()).toBe('1234567890')
    })

    it('handles special characters', () => {
      const buffer = new ChunkRingBuffer(100)
      buffer.append('\n\t\r')
      buffer.append('\x1b[32m') // ANSI escape
      buffer.append('unicode: \u00e9\u00e8')
      expect(buffer.snapshot()).toBe('\n\t\r\x1b[32municode: \u00e9\u00e8')
    })

    it('handles very large maxChars', () => {
      const buffer = new ChunkRingBuffer(1000000)
      buffer.append('small chunk')
      expect(buffer.snapshot()).toBe('small chunk')
    })

    it('preserves order of chunks', () => {
      const buffer = new ChunkRingBuffer(100)
      for (let i = 0; i < 10; i++) {
        buffer.append(`[${i}]`)
      }
      expect(buffer.snapshot()).toBe('[0][1][2][3][4][5][6][7][8][9]')
    })
  })
})

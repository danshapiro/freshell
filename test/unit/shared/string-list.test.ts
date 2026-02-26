import { describe, it, expect } from 'vitest'
import { normalizeTrimmedStringList, parseNormalizedLineList } from '../../../shared/string-list'

describe('string-list helpers', () => {
  it('normalizes array input by trimming, deduplicating, and dropping blanks', () => {
    expect(normalizeTrimmedStringList(['  a  ', '', 'b', 'a', '  ', 'b', 123, null])).toEqual(['a', 'b'])
  })

  it('returns empty list for non-array input', () => {
    expect(normalizeTrimmedStringList('not-an-array')).toEqual([])
  })

  it('parses newline-delimited values', () => {
    expect(parseNormalizedLineList('  a  \n\nb\r\na\n')).toEqual(['a', 'b'])
  })
})

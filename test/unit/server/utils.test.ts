import { describe, it, expect } from 'vitest'
import { cleanString } from '../../../server/utils.js'

describe('cleanString', () => {
  it('returns trimmed string for non-empty input', () => {
    expect(cleanString('  hello  ')).toBe('hello')
  })

  it('returns undefined for empty string', () => {
    expect(cleanString('')).toBeUndefined()
  })

  it('returns undefined for whitespace-only string', () => {
    expect(cleanString('   ')).toBeUndefined()
  })

  it('returns undefined for null', () => {
    expect(cleanString(null)).toBeUndefined()
  })

  it('returns undefined for undefined', () => {
    expect(cleanString(undefined)).toBeUndefined()
  })

  it('returns trimmed string for non-empty with whitespace', () => {
    expect(cleanString('  test value  ')).toBe('test value')
  })
})

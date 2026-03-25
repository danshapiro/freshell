import { describe, it, expect } from 'vitest'
import { FIRST_USER_MESSAGE_MAX_CHARS, normalizeFirstUserMessage } from '../../../../server/coding-cli/types'

describe('normalizeFirstUserMessage', () => {
  it('returns undefined for blank content', () => {
    expect(normalizeFirstUserMessage('   \n\t  ')).toBeUndefined()
  })

  it('trims leading and trailing whitespace', () => {
    expect(normalizeFirstUserMessage('  hello world  ')).toBe('hello world')
  })

  it('truncates to the configured max characters', () => {
    const input = `  ${'x'.repeat(FIRST_USER_MESSAGE_MAX_CHARS + 25)}  `
    const normalized = normalizeFirstUserMessage(input)

    expect(normalized).toBeDefined()
    expect(normalized?.length).toBe(FIRST_USER_MESSAGE_MAX_CHARS)
  })
})

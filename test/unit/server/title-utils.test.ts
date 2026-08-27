import { describe, expect, it } from 'vitest'

import { extractTitleFromJsonlObject } from '../../../server/title-utils.js'

describe('title-utils', () => {
  describe('extractTitleFromJsonlObject', () => {
    it('extracts title from explicit title field', () => {
      const result = extractTitleFromJsonlObject({ title: 'My Title' })
      expect(result).toBe('My Title')
    })

    it('extracts title from sessionTitle field', () => {
      const result = extractTitleFromJsonlObject({ sessionTitle: 'Session Title' })
      expect(result).toBe('Session Title')
    })

    it('extracts title from user message content', () => {
      const result = extractTitleFromJsonlObject({ role: 'user', content: 'User prompt here' })
      expect(result).toBe('User prompt here')
    })

    it('extracts title from nested message.role user', () => {
      const result = extractTitleFromJsonlObject({
        message: { role: 'user', content: 'Nested user content' },
      })
      expect(result).toBe('Nested user content')
    })

    it('returns undefined for assistant messages', () => {
      const result = extractTitleFromJsonlObject({ role: 'assistant', content: 'Response' })
      expect(result).toBeUndefined()
    })

    it('returns undefined for empty object', () => {
      const result = extractTitleFromJsonlObject({})
      expect(result).toBeUndefined()
    })

    it('returns undefined for null', () => {
      const result = extractTitleFromJsonlObject(null)
      expect(result).toBeUndefined()
    })

    it('returns undefined for undefined', () => {
      const result = extractTitleFromJsonlObject(undefined)
      expect(result).toBeUndefined()
    })

    it('prefers explicit title over user content', () => {
      const result = extractTitleFromJsonlObject({
        title: 'Explicit Title',
        role: 'user',
        content: 'User content',
      })
      expect(result).toBe('Explicit Title')
    })

    it('truncates long titles', () => {
      const result = extractTitleFromJsonlObject({ title: 'A'.repeat(100) }, 50)
      expect(result?.length).toBe(50)
    })

    it('ignores empty title strings', () => {
      const result = extractTitleFromJsonlObject({
        title: '   ',
        role: 'user',
        content: 'Fallback content',
      })
      expect(result).toBe('Fallback content')
    })
  })
})

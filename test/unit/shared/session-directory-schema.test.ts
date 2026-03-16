import { describe, it, expect } from 'vitest'
import { SessionDirectoryQuerySchema, SessionDirectoryItemSchema } from '../../../shared/read-models'

describe('SessionDirectoryQuerySchema tier field', () => {
  it('accepts title tier', () => {
    const result = SessionDirectoryQuerySchema.parse({ priority: 'visible', tier: 'title' })
    expect(result.tier).toBe('title')
  })

  it('accepts userMessages tier', () => {
    const result = SessionDirectoryQuerySchema.parse({ priority: 'visible', tier: 'userMessages' })
    expect(result.tier).toBe('userMessages')
  })

  it('accepts fullText tier', () => {
    const result = SessionDirectoryQuerySchema.parse({ priority: 'visible', tier: 'fullText' })
    expect(result.tier).toBe('fullText')
  })

  it('defaults to title when tier is omitted', () => {
    const result = SessionDirectoryQuerySchema.parse({ priority: 'visible' })
    expect(result.tier).toBe('title')
  })

  it('rejects unknown tier values', () => {
    expect(() => SessionDirectoryQuerySchema.parse({ priority: 'visible', tier: 'bogus' })).toThrow()
  })
})

describe('SessionDirectoryItemSchema matchedIn field', () => {
  const baseItem = {
    sessionId: 'test-session',
    provider: 'claude',
    projectPath: '/test',
    lastActivityAt: 1000,
    isRunning: false,
  }

  it('accepts userMessage matchedIn', () => {
    const result = SessionDirectoryItemSchema.parse({ ...baseItem, matchedIn: 'userMessage' })
    expect(result.matchedIn).toBe('userMessage')
  })

  it('accepts assistantMessage matchedIn', () => {
    const result = SessionDirectoryItemSchema.parse({ ...baseItem, matchedIn: 'assistantMessage' })
    expect(result.matchedIn).toBe('assistantMessage')
  })

  it('continues to accept existing matchedIn values', () => {
    for (const value of ['title', 'summary', 'firstUserMessage']) {
      const result = SessionDirectoryItemSchema.parse({ ...baseItem, matchedIn: value })
      expect(result.matchedIn).toBe(value)
    }
  })
})

import { describe, it, expect } from 'vitest'
import { SessionDirectoryQuerySchema, SessionDirectoryItemSchema, SessionDirectoryPageSchema } from '../../../shared/read-models'

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

describe('SessionDirectoryItemSchema lastActivityAt integer enforcement', () => {
  const baseItem = {
    sessionId: 'test-session',
    provider: 'kimi',
    projectPath: '/test',
    lastActivityAt: 1000,
    isRunning: false,
  }

  it('accepts integer lastActivityAt', () => {
    expect(() => SessionDirectoryItemSchema.parse(baseItem)).not.toThrow()
  })

  it('rejects float lastActivityAt', () => {
    expect(() =>
      SessionDirectoryItemSchema.parse({ ...baseItem, lastActivityAt: 1774212239458.0225 }),
    ).toThrow()
  })
})

describe('SessionDirectoryPageSchema partial fields', () => {
  const basePage = {
    items: [],
    nextCursor: null,
    revision: 0,
  }

  it('accepts partial: true with partialReason: budget', () => {
    const result = SessionDirectoryPageSchema.parse({ ...basePage, partial: true, partialReason: 'budget' })
    expect(result.partial).toBe(true)
    expect(result.partialReason).toBe('budget')
  })

  it('accepts partial: true with partialReason: io_error', () => {
    const result = SessionDirectoryPageSchema.parse({ ...basePage, partial: true, partialReason: 'io_error' })
    expect(result.partial).toBe(true)
    expect(result.partialReason).toBe('io_error')
  })

  it('omits partial fields when not present', () => {
    const result = SessionDirectoryPageSchema.parse(basePage)
    expect(result.partial).toBeUndefined()
    expect(result.partialReason).toBeUndefined()
  })

  it('rejects unknown partialReason values', () => {
    expect(() => SessionDirectoryPageSchema.parse({ ...basePage, partial: true, partialReason: 'timeout' })).toThrow()
  })
})

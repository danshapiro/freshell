import { describe, it, expect } from 'vitest'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'

describe('isValidClaudeSessionId', () => {
  it('accepts UUIDs and rejects non-UUIDs', () => {
    expect(isValidClaudeSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isValidClaudeSessionId('not-a-uuid')).toBe(false)
    expect(isValidClaudeSessionId('')).toBe(false)
  })
})

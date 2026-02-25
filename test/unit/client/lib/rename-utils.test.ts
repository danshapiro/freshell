import { describe, it, expect } from 'vitest'
import { shouldSyncRenameToServer } from '@/lib/rename-utils'
import type { TabMode } from '@/store/types'

describe('shouldSyncRenameToServer', () => {
  it('returns true for coding CLI modes with a terminalId', () => {
    const codingModes: TabMode[] = ['claude', 'codex', 'opencode', 'gemini', 'kimi']
    for (const mode of codingModes) {
      expect(shouldSyncRenameToServer(mode, 'term-123')).toBe(true)
    }
  })

  it('returns false for shell mode', () => {
    expect(shouldSyncRenameToServer('shell', 'term-123')).toBe(false)
  })

  it('returns false when no terminalId', () => {
    expect(shouldSyncRenameToServer('claude', undefined)).toBe(false)
  })

  it('returns false when no mode', () => {
    expect(shouldSyncRenameToServer(undefined, 'term-123')).toBe(false)
  })
})

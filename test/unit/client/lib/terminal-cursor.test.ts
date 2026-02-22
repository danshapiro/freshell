import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetTerminalCursorCacheForTests,
  clearTerminalCursor,
  getCursorMapSize,
  loadTerminalCursor,
  saveTerminalCursor,
} from '@/lib/terminal-cursor'
import { TERMINAL_CURSOR_STORAGE_KEY } from '@/store/storage-keys'

describe('terminal-cursor', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetTerminalCursorCacheForTests()
  })

  it('loads and saves terminal cursor sequence values', () => {
    expect(loadTerminalCursor('term-1')).toBe(0)

    saveTerminalCursor('term-1', 4)
    expect(loadTerminalCursor('term-1')).toBe(4)

    saveTerminalCursor('term-1', 2)
    expect(loadTerminalCursor('term-1')).toBe(4)

    saveTerminalCursor('term-1', 8)
    expect(loadTerminalCursor('term-1')).toBe(8)
  })

  it('clears an entry when terminal exits', () => {
    saveTerminalCursor('term-2', 11)
    expect(loadTerminalCursor('term-2')).toBe(11)

    clearTerminalCursor('term-2')
    expect(loadTerminalCursor('term-2')).toBe(0)
  })

  it('drops expired entries when loading from storage', () => {
    const now = Date.now()
    const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
      stale: { seq: 5, updatedAt: now - fifteenDaysMs },
      fresh: { seq: 9, updatedAt: now },
    }))
    __resetTerminalCursorCacheForTests()

    expect(loadTerminalCursor('stale')).toBe(0)
    expect(loadTerminalCursor('fresh')).toBe(9)
    expect(getCursorMapSize()).toBe(1)
  })

  it('enforces max entry count by keeping most recently updated entries', () => {
    const now = Date.now()
    const payload: Record<string, { seq: number; updatedAt: number }> = {}
    for (let i = 0; i < 520; i += 1) {
      payload[`term-${i}`] = { seq: i + 1, updatedAt: now - i }
    }
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify(payload))
    __resetTerminalCursorCacheForTests()

    expect(getCursorMapSize()).toBeLessThanOrEqual(500)
    expect(loadTerminalCursor('term-0')).toBe(1)
    expect(loadTerminalCursor('term-519')).toBe(0)
  })

  it('remains resilient when stored payload is malformed', () => {
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, '{not valid json')
    __resetTerminalCursorCacheForTests()

    expect(loadTerminalCursor('term-bad')).toBe(0)
    expect(getCursorMapSize()).toBe(0)
  })
})

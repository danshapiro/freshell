import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetTerminalCursorCacheForTests,
  clearTerminalCursor,
  getCursorMapSize,
  loadTerminalCursor,
  loadTerminalSurfaceCheckpoint,
  saveTerminalCursor,
  saveTerminalSurfaceCheckpoint,
} from '@/lib/terminal-cursor'
import type { TerminalSurfaceCheckpoint } from '@/lib/terminal-surface-checkpoint'
import { TERMINAL_CURSOR_STORAGE_KEY } from '@/store/storage-keys'

function createCheckpoint(
  overrides: Partial<TerminalSurfaceCheckpoint> = {},
): TerminalSurfaceCheckpoint {
  return {
    terminalId: 'term-1',
    streamId: 'stream-1',
    serverInstanceId: 'server-a',
    surfaceEpoch: 1,
    attachRequestId: 'attach-1',
    parserAppliedSeq: 1,
    cols: 80,
    rows: 24,
    geometryEpoch: 1,
    geometryAuthority: 'single_client',
    scrollback: 5000,
    xtermVersion: '6.0.0',
    bufferType: 'normal',
    parserIdle: true,
    ...overrides,
  }
}

function loadCheckpointSeq(terminalId: string): number {
  return loadTerminalSurfaceCheckpoint(terminalId, {
    streamId: 'stream-1',
    serverInstanceId: 'server-a',
  })?.parserAppliedSeq ?? 0
}

describe('terminal-cursor', () => {
  beforeEach(() => {
    vi.useRealTimers()
    localStorage.clear()
    __resetTerminalCursorCacheForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads and saves terminal surface checkpoint sequence values', () => {
    expect(loadCheckpointSeq('term-1')).toBe(0)

    saveTerminalSurfaceCheckpoint(createCheckpoint({ parserAppliedSeq: 4 }))
    expect(loadCheckpointSeq('term-1')).toBe(4)

    saveTerminalSurfaceCheckpoint(createCheckpoint({ parserAppliedSeq: 2 }))
    expect(loadCheckpointSeq('term-1')).toBe(4)

    saveTerminalSurfaceCheckpoint(createCheckpoint({ parserAppliedSeq: 8 }))
    expect(loadCheckpointSeq('term-1')).toBe(8)
  })

  it('uses the incompatible v2 storage namespace for checkpoint records', () => {
    expect(TERMINAL_CURSOR_STORAGE_KEY).toBe('freshell.terminal-cursors.v2')
  })

  it('clears an entry when terminal exits', () => {
    saveTerminalSurfaceCheckpoint(createCheckpoint({
      terminalId: 'term-2',
      parserAppliedSeq: 11,
    }))
    expect(loadCheckpointSeq('term-2')).toBe(11)

    clearTerminalCursor('term-2')
    expect(loadCheckpointSeq('term-2')).toBe(0)
  })

  it('drops expired entries when loading from storage', () => {
    const now = Date.now()
    const fifteenDaysMs = 15 * 24 * 60 * 60 * 1000
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
      stale: {
        checkpoint: createCheckpoint({ terminalId: 'stale', parserAppliedSeq: 5 }),
        updatedAt: now - fifteenDaysMs,
      },
      fresh: {
        checkpoint: createCheckpoint({ terminalId: 'fresh', parserAppliedSeq: 9 }),
        updatedAt: now,
      },
    }))
    __resetTerminalCursorCacheForTests()

    expect(loadCheckpointSeq('stale')).toBe(0)
    expect(loadCheckpointSeq('fresh')).toBe(9)
    expect(getCursorMapSize()).toBe(1)
  })

  it('enforces max entry count by keeping most recently updated entries', () => {
    const now = Date.now()
    const payload: Record<string, { checkpoint: TerminalSurfaceCheckpoint; updatedAt: number }> = {}
    for (let i = 0; i < 520; i += 1) {
      payload[`term-${i}`] = {
        checkpoint: createCheckpoint({
          terminalId: `term-${i}`,
          parserAppliedSeq: i + 1,
        }),
        updatedAt: now - i,
      }
    }
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify(payload))
    __resetTerminalCursorCacheForTests()

    expect(getCursorMapSize()).toBeLessThanOrEqual(500)
    expect(loadCheckpointSeq('term-0')).toBe(1)
    expect(loadCheckpointSeq('term-519')).toBe(0)
  })

  it('remains resilient when stored payload is malformed', () => {
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, '{not valid json')
    __resetTerminalCursorCacheForTests()

    expect(loadTerminalCursor('term-bad')).toBe(0)
    expect(getCursorMapSize()).toBe(0)
  })

  it('treats legacy persisted cursor records as incompatible by default', () => {
    localStorage.setItem(TERMINAL_CURSOR_STORAGE_KEY, JSON.stringify({
      'term-legacy': { seq: 12, updatedAt: Date.now() },
    }))
    __resetTerminalCursorCacheForTests()

    expect(loadTerminalCursor('term-legacy')).toBe(0)
    expect(loadTerminalSurfaceCheckpoint('term-legacy', {
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
    })).toBeNull()
  })

  it('does not let legacy cursor writes mutate a trusted checkpoint', () => {
    saveTerminalSurfaceCheckpoint(createCheckpoint({
      terminalId: 'term-legacy-write',
      parserAppliedSeq: 25,
    }))

    saveTerminalCursor('term-legacy-write', 100)

    expect(loadTerminalCursor('term-legacy-write')).toBe(0)
    expect(loadTerminalSurfaceCheckpoint('term-legacy-write', {
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
    })?.parserAppliedSeq).toBe(25)
  })

  it('does not create a trusted cursor from legacy cursor writes', () => {
    saveTerminalCursor('term-only-legacy', 100)

    expect(loadTerminalCursor('term-only-legacy')).toBe(0)
    expect(loadTerminalSurfaceCheckpoint('term-only-legacy', {
      streamId: null,
      serverInstanceId: 'legacy-cursor',
    })).toBeNull()
  })

  it('does not load a persisted checkpoint for a different server instance', () => {
    saveTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 1,
      attachRequestId: 'attach-1',
      parserAppliedSeq: 25,
      cols: 80,
      rows: 24,
      geometryEpoch: 1,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(loadTerminalSurfaceCheckpoint('term-1', {
      streamId: 'stream-1',
      serverInstanceId: 'server-b',
    })).toBeNull()
  })

  it('does not load a persisted checkpoint when either side lacks a boot id', () => {
    saveTerminalSurfaceCheckpoint(createCheckpoint({
      terminalId: 'term-boot',
      serverBootId: 'boot-a',
      parserAppliedSeq: 25,
    }))

    expect(loadTerminalSurfaceCheckpoint('term-boot', {
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
    })).toBeNull()
    expect(loadTerminalSurfaceCheckpoint('term-boot', {
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      serverBootId: 'boot-b',
    })).toBeNull()
    expect(loadTerminalSurfaceCheckpoint('term-boot', {
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      serverBootId: 'boot-a',
    })?.parserAppliedSeq).toBe(25)
  })

  it('debounces localStorage persistence for rapid checkpoint updates', () => {
    vi.useFakeTimers()
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    saveTerminalSurfaceCheckpoint(createCheckpoint({ terminalId: 'term-rapid', parserAppliedSeq: 1 }))
    saveTerminalSurfaceCheckpoint(createCheckpoint({ terminalId: 'term-rapid', parserAppliedSeq: 2 }))
    saveTerminalSurfaceCheckpoint(createCheckpoint({ terminalId: 'term-rapid', parserAppliedSeq: 3 }))

    expect(loadCheckpointSeq('term-rapid')).toBe(3)
    expect(setItemSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(250)
    expect(setItemSpy).toHaveBeenCalledTimes(1)

    setItemSpy.mockRestore()
  })

  it('flushes immediately when clearing a cursor with pending debounced writes', () => {
    vi.useFakeTimers()
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    saveTerminalSurfaceCheckpoint(createCheckpoint({ terminalId: 'term-clear', parserAppliedSeq: 7 }))
    expect(setItemSpy).not.toHaveBeenCalled()

    clearTerminalCursor('term-clear')
    expect(setItemSpy).toHaveBeenCalledTimes(1)
    expect(loadCheckpointSeq('term-clear')).toBe(0)

    vi.advanceTimersByTime(250)
    expect(setItemSpy).toHaveBeenCalledTimes(1)

    setItemSpy.mockRestore()
  })
})

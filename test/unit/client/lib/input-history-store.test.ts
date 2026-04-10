import { describe, it, expect, beforeEach } from 'vitest'
import { loadHistory, pushEntry, clearHistory } from '@/lib/input-history-store'

describe('input-history-store', () => {
  beforeEach(() => {
    clearHistory('test-pane')
    clearHistory('other-pane')
  })

  it('returns empty array for unknown paneId', () => {
    expect(loadHistory('nonexistent')).toEqual([])
  })

  it('pushEntry adds an entry and returns updated history', () => {
    const result = pushEntry('test-pane', 'hello')
    expect(result).toEqual(['hello'])
    expect(loadHistory('test-pane')).toEqual(['hello'])
  })

  it('pushEntry deduplicates consecutive identical entries', () => {
    pushEntry('test-pane', 'hello')
    const result = pushEntry('test-pane', 'hello')
    expect(result).toEqual(['hello'])
  })

  it('pushEntry keeps non-consecutive duplicates', () => {
    pushEntry('test-pane', 'hello')
    pushEntry('test-pane', 'world')
    pushEntry('test-pane', 'hello')
    expect(loadHistory('test-pane')).toEqual(['hello', 'world', 'hello'])
  })

  it('evicts oldest entries beyond 500', () => {
    for (let i = 0; i < 502; i++) {
      pushEntry('test-pane', `entry-${i}`)
    }
    const history = loadHistory('test-pane')
    expect(history).toHaveLength(500)
    expect(history[0]).toBe('entry-2')
    expect(history[499]).toBe('entry-501')
  })

  it('isolates history per paneId', () => {
    pushEntry('test-pane', 'a')
    pushEntry('other-pane', 'b')
    expect(loadHistory('test-pane')).toEqual(['a'])
    expect(loadHistory('other-pane')).toEqual(['b'])
  })

  it('clearHistory removes stored history', () => {
    pushEntry('test-pane', 'hello')
    clearHistory('test-pane')
    expect(loadHistory('test-pane')).toEqual([])
  })

  it('handles corrupted localStorage data gracefully', () => {
    localStorage.setItem('freshell.input-history.v1:corrupted', 'not json{')
    expect(loadHistory('corrupted')).toEqual([])
  })

  it('preserves entry order across save and load', () => {
    pushEntry('test-pane', 'first')
    pushEntry('test-pane', 'second')
    pushEntry('test-pane', 'third')
    expect(loadHistory('test-pane')).toEqual(['first', 'second', 'third'])
  })
})

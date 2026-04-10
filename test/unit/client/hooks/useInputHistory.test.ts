import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useInputHistory } from '@/hooks/useInputHistory'
import { clearHistory, loadHistory, pushEntry } from '@/lib/input-history-store'

describe('useInputHistory', () => {
  beforeEach(() => {
    clearHistory('hook-pane')
    clearHistory('other-hook-pane')
  })

  it('navigateUp returns null when no history exists', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    expect(result.current.navigateUp('')).toBeNull()
  })

  it('navigateUp returns newest entry first', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => {
      result.current.push('first')
      result.current.push('second')
    })
    expect(result.current.navigateUp('')).toBe('second')
  })

  it('navigateUp returns null at oldest entry', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => { result.current.push('only') })
    result.current.navigateUp('')
    expect(result.current.navigateUp('only')).toBeNull()
  })

  it('navigateDown returns null at newest position', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => { result.current.push('entry') })
    expect(result.current.navigateDown('')).toBeNull()
  })

  it('navigateDown restores saved draft', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => { result.current.push('entry') })
    result.current.navigateUp('my draft')
    expect(result.current.navigateDown('entry')).toBe('my draft')
  })

  it('full navigation cycle: up twice, down twice', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => {
      result.current.push('first')
      result.current.push('second')
      result.current.push('third')
    })
    expect(result.current.navigateUp('')).toBe('third')
    expect(result.current.navigateUp('third')).toBe('second')
    expect(result.current.navigateDown('second')).toBe('third')
    expect(result.current.navigateDown('third')).toBe('')
  })

  it('push adds entry and resets cursor', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => {
      result.current.push('first')
      result.current.push('second')
    })
    result.current.navigateUp('')
    result.current.navigateUp('second')
    act(() => { result.current.push('third') })
    expect(result.current.navigateUp('')).toBe('third')
    expect(result.current.navigateUp('third')).toBe('second')
  })

  it('reset clears cursor and draft without pushing', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => { result.current.push('entry') })
    result.current.navigateUp('my draft')
    act(() => { result.current.reset() })
    expect(result.current.navigateDown('')).toBeNull()
    expect(result.current.navigateUp('')).toBe('entry')
  })

  it('saves draft on first navigateUp only', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => {
      result.current.push('first')
      result.current.push('second')
    })
    result.current.navigateUp('original draft')
    result.current.navigateUp('second')
    expect(result.current.navigateDown('first')).toBe('second')
    expect(result.current.navigateDown('second')).toBe('original draft')
  })

  it('resets when paneId changes', () => {
    const { result, rerender } = renderHook(
      ({ paneId }) => useInputHistory(paneId),
      { initialProps: { paneId: 'hook-pane' } }
    )
    act(() => { result.current.push('entry-a') })
    result.current.navigateUp('')
    rerender({ paneId: 'other-hook-pane' })
    expect(result.current.navigateUp('')).toBeNull()
  })

  it('loads history from store on mount', () => {
    pushEntry('hook-pane', 'pre-existing')
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    expect(result.current.navigateUp('')).toBe('pre-existing')
  })

  it('no-ops when paneId is undefined', () => {
    const { result } = renderHook(() => useInputHistory(undefined))
    expect(result.current.navigateUp('')).toBeNull()
    expect(result.current.navigateDown('')).toBeNull()
    act(() => { result.current.push('should not persist') })
    expect(loadHistory('undefined')).toEqual([])
  })
})

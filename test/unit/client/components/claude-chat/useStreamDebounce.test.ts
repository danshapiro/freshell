import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useStreamDebounce } from '../../../../../src/components/claude-chat/useStreamDebounce'

describe('useStreamDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns raw text immediately for short strings', () => {
    const { result } = renderHook(
      ({ text, active }) => useStreamDebounce(text, active),
      { initialProps: { text: 'Hello', active: true } },
    )
    expect(result.current).toBe('Hello')
  })

  it('debounces rapid updates', () => {
    const { result, rerender } = renderHook(
      ({ text, active }) => useStreamDebounce(text, active),
      { initialProps: { text: '', active: true } },
    )

    // Rapid updates
    rerender({ text: 'a', active: true })
    rerender({ text: 'ab', active: true })
    rerender({ text: 'abc', active: true })

    // After timer fires, should catch up
    act(() => { vi.advanceTimersByTime(50) })
    expect(result.current).toBe('abc')
  })

  it('flushes immediately when buffer exceeds threshold', () => {
    const longText = 'x'.repeat(250)
    const { result, rerender } = renderHook(
      ({ text, active }) => useStreamDebounce(text, active),
      { initialProps: { text: '', active: true } },
    )
    rerender({ text: longText, active: true })
    // Should flush immediately due to size threshold
    expect(result.current).toBe(longText)
  })

  it('returns final text when streaming stops', () => {
    const { result, rerender } = renderHook(
      ({ text, active }) => useStreamDebounce(text, active),
      { initialProps: { text: 'partial', active: true } },
    )
    rerender({ text: 'complete', active: false })
    expect(result.current).toBe('complete')
  })

  it('flushes periodically even under continuous small updates', () => {
    const { result, rerender } = renderHook(
      ({ text, active }) => useStreamDebounce(text, active),
      { initialProps: { text: '', active: true } },
    )

    // Rapid small updates every 10ms — should still flush at 50ms
    rerender({ text: 'a', active: true })
    act(() => { vi.advanceTimersByTime(10) })
    rerender({ text: 'ab', active: true })
    act(() => { vi.advanceTimersByTime(10) })
    rerender({ text: 'abc', active: true })
    act(() => { vi.advanceTimersByTime(10) })
    rerender({ text: 'abcd', active: true })
    act(() => { vi.advanceTimersByTime(10) })
    rerender({ text: 'abcde', active: true })
    act(() => { vi.advanceTimersByTime(10) })
    // 50ms total — timer should have fired with latest text via ref
    expect(result.current).toBe('abcde')

    // Keep updating — another 50ms should trigger another flush
    rerender({ text: 'abcdef', active: true })
    act(() => { vi.advanceTimersByTime(25) })
    rerender({ text: 'abcdefg', active: true })
    act(() => { vi.advanceTimersByTime(25) })
    expect(result.current).toBe('abcdefg')
  })

  it('clears stale text when a new stream starts', () => {
    const { result, rerender } = renderHook(
      ({ text, active }) => useStreamDebounce(text, active),
      { initialProps: { text: '', active: true } },
    )
    // Simulate first stream producing text
    rerender({ text: 'old stream content', active: true })
    act(() => { vi.advanceTimersByTime(50) })
    expect(result.current).toBe('old stream content')

    // Stream ends
    rerender({ text: '', active: false })
    expect(result.current).toBe('')

    // New stream starts — should not flash old content
    rerender({ text: '', active: true })
    expect(result.current).toBe('')
  })
})

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import ThinkingIndicator from '../../../../../src/components/claude-chat/ThinkingIndicator'

describe('ThinkingIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('does not render immediately (debounced to prevent flash)', () => {
    render(<ThinkingIndicator />)
    expect(screen.queryByText('Thinking...')).not.toBeInTheDocument()
  })

  it('renders thinking text after 200ms delay', () => {
    render(<ThinkingIndicator />)
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.getByText('Thinking...')).toBeInTheDocument()
  })

  it('has assistant message styling (blue border) when visible', () => {
    const { container } = render(<ThinkingIndicator />)
    act(() => { vi.advanceTimersByTime(200) })
    const wrapper = container.firstElementChild!
    expect(wrapper.className).toContain('border-l')
  })

  it('has status role for accessibility when visible', () => {
    render(<ThinkingIndicator />)
    act(() => { vi.advanceTimersByTime(200) })
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('does not flash if unmounted before delay completes', () => {
    const { unmount } = render(<ThinkingIndicator />)
    act(() => { vi.advanceTimersByTime(100) })
    unmount()
    // No assertion needed — test verifies no errors on unmount during pending timer
  })
})

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import SlotReel from '@/components/agent-chat/SlotReel'

describe('SlotReel', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('renders tool name badge and preview text', () => {
    render(<SlotReel toolName="Bash" previewText="$ ls -la" />)
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('$ ls -la')).toBeInTheDocument()
  })

  it('renders settled state with tool count', () => {
    render(<SlotReel toolName={null} previewText={null} settledText="5 tools used" />)
    expect(screen.getByText('5 tools used')).toBeInTheDocument()
  })

  it('has accessible region role', () => {
    render(<SlotReel toolName="Read" previewText="/path/file.ts" />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('shows tool name in a badge element', () => {
    render(<SlotReel toolName="Grep" previewText="pattern" />)
    const badge = screen.getByText('Grep')
    expect(badge.tagName).toBe('SPAN')
  })

  it('renders empty when no props are set', () => {
    const { container } = render(<SlotReel toolName={null} previewText={null} />)
    const status = container.querySelector('[role="status"]')
    expect(status).toBeInTheDocument()
  })

  it('applies reel animation CSS class on tool name change', () => {
    const { rerender, container } = render(
      <SlotReel toolName="Bash" previewText="$ echo hi" />
    )
    const nameSlot = container.querySelector('[data-slot="name"]')
    expect(nameSlot).toBeInTheDocument()

    rerender(<SlotReel toolName="Read" previewText="/file.ts" />)
    expect(screen.getByText('Read')).toBeInTheDocument()
  })

  it('applies reel animation CSS class on preview text change', () => {
    const { rerender } = render(
      <SlotReel toolName="Bash" previewText="$ echo 1" />
    )
    rerender(<SlotReel toolName="Bash" previewText="$ echo 2" />)
    expect(screen.getByText('$ echo 2')).toBeInTheDocument()
  })

  it('animates with keyed spans so interrupted rolls restart from frame zero', () => {
    const { rerender, container } = render(
      <SlotReel toolName="Bash" previewText="one" />
    )
    rerender(<SlotReel toolName="Read" previewText="two" />)
    // Mid-animation both outgoing and incoming spans are present, keyed per change.
    expect(container.querySelector('.animate-reel-out')).toBeInTheDocument()
    expect(container.querySelector('.animate-reel-in')).toBeInTheDocument()
  })

  it('settles on the latest value when changes arrive faster than the animation', () => {
    vi.useFakeTimers()
    const { rerender } = render(<SlotReel toolName="Bash" previewText="one" />)

    rerender(<SlotReel toolName="Read" previewText="two" />)
    act(() => {
      vi.advanceTimersByTime(50)
    })
    // Interrupt the in-flight roll with a third value.
    rerender(<SlotReel toolName="Grep" previewText="three" />)
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(screen.getByText('Grep')).toBeInTheDocument()
    expect(screen.getByText('three')).toBeInTheDocument()
    expect(screen.queryByText('Bash')).not.toBeInTheDocument()
    expect(screen.queryByText('one')).not.toBeInTheDocument()
  })
})

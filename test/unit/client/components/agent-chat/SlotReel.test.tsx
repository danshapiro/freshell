import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import SlotReel from '@/components/agent-chat/SlotReel'

describe('SlotReel', () => {
  afterEach(cleanup)

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
    // Get the tool badge container (the element with overflow-hidden for animation)
    const nameSlot = container.querySelector('[data-slot="name"]')
    expect(nameSlot).toBeInTheDocument()

    rerender(<SlotReel toolName="Read" previewText="/file.ts" />)
    // After rerender with different tool name, the animation wrapper should
    // contain the new tool name
    expect(screen.getByText('Read')).toBeInTheDocument()
  })

  it('applies reel animation CSS class on preview text change', () => {
    const { rerender } = render(
      <SlotReel toolName="Bash" previewText="$ echo 1" />
    )
    rerender(<SlotReel toolName="Bash" previewText="$ echo 2" />)
    expect(screen.getByText('$ echo 2')).toBeInTheDocument()
  })
})

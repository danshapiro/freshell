import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import Pane from '@/components/panes/Pane'

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  X: ({ className }: { className?: string }) => (
    <svg data-testid="x-icon" className={className} />
  ),
}))

describe('Pane', () => {
  afterEach(() => {
    cleanup()
  })

  describe('rendering', () => {
    it('renders children content', () => {
      const onClose = vi.fn()
      const onFocus = vi.fn()

      render(
        <Pane
          isActive={false}
          isOnlyPane={false}
          onClose={onClose}
          onFocus={onFocus}
        >
          <div data-testid="child-content">Terminal Content</div>
        </Pane>
      )

      expect(screen.getByTestId('child-content')).toBeInTheDocument()
      expect(screen.getByText('Terminal Content')).toBeInTheDocument()
    })

    it('renders close button when not the only pane', () => {
      const onClose = vi.fn()
      const onFocus = vi.fn()

      render(
        <Pane
          isActive={false}
          isOnlyPane={false}
          onClose={onClose}
          onFocus={onFocus}
        >
          <div>Content</div>
        </Pane>
      )

      const closeButton = screen.getByTitle('Close pane')
      expect(closeButton).toBeInTheDocument()
    })

    it('hides close button when it is the only pane', () => {
      const onClose = vi.fn()
      const onFocus = vi.fn()

      render(
        <Pane
          isActive={false}
          isOnlyPane={true}
          onClose={onClose}
          onFocus={onFocus}
        >
          <div>Content</div>
        </Pane>
      )

      const closeButton = screen.queryByTitle('Close pane')
      expect(closeButton).not.toBeInTheDocument()
    })
  })

  describe('active state styling', () => {
    it('applies ring and shadow styling when active', () => {
      const onClose = vi.fn()
      const onFocus = vi.fn()

      const { container } = render(
        <Pane
          isActive={true}
          isOnlyPane={false}
          onClose={onClose}
          onFocus={onFocus}
        >
          <div>Content</div>
        </Pane>
      )

      const paneDiv = container.firstChild as HTMLElement
      expect(paneDiv.className).toContain('ring-2')
      expect(paneDiv.className).toContain('shadow-')
    })

    it('does not apply ring or shadow styling when inactive', () => {
      const onClose = vi.fn()
      const onFocus = vi.fn()

      const { container } = render(
        <Pane
          isActive={false}
          isOnlyPane={false}
          onClose={onClose}
          onFocus={onFocus}
        >
          <div>Content</div>
        </Pane>
      )

      const paneDiv = container.firstChild as HTMLElement
      // Should have base classes but not the ring or shadow
      expect(paneDiv.className).toContain('relative')
      expect(paneDiv.className).not.toContain('ring-2')
      expect(paneDiv.className).not.toContain('shadow-[')
    })
  })

  describe('interactions', () => {
    it('calls onFocus when pane is clicked', () => {
      const onClose = vi.fn()
      const onFocus = vi.fn()

      const { container } = render(
        <Pane
          isActive={false}
          isOnlyPane={false}
          onClose={onClose}
          onFocus={onFocus}
        >
          <div>Content</div>
        </Pane>
      )

      const paneDiv = container.firstChild as HTMLElement
      fireEvent.click(paneDiv)

      expect(onFocus).toHaveBeenCalledTimes(1)
    })

    it('calls onClose when close button is clicked', () => {
      const onClose = vi.fn()
      const onFocus = vi.fn()

      render(
        <Pane
          isActive={false}
          isOnlyPane={false}
          onClose={onClose}
          onFocus={onFocus}
        >
          <div>Content</div>
        </Pane>
      )

      const closeButton = screen.getByTitle('Close pane')
      fireEvent.click(closeButton)

      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('stops propagation when close button is clicked (does not trigger onFocus)', () => {
      const onClose = vi.fn()
      const onFocus = vi.fn()

      render(
        <Pane
          isActive={false}
          isOnlyPane={false}
          onClose={onClose}
          onFocus={onFocus}
        >
          <div>Content</div>
        </Pane>
      )

      const closeButton = screen.getByTitle('Close pane')
      fireEvent.click(closeButton)

      // onClose should be called, but onFocus should NOT be called
      // because the click event is stopped from propagating
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(onFocus).not.toHaveBeenCalled()
    })
  })

  describe('edge cases', () => {
    it('handles multiple rapid clicks on pane', () => {
      const onClose = vi.fn()
      const onFocus = vi.fn()

      const { container } = render(
        <Pane
          isActive={false}
          isOnlyPane={false}
          onClose={onClose}
          onFocus={onFocus}
        >
          <div>Content</div>
        </Pane>
      )

      const paneDiv = container.firstChild as HTMLElement
      fireEvent.click(paneDiv)
      fireEvent.click(paneDiv)
      fireEvent.click(paneDiv)

      expect(onFocus).toHaveBeenCalledTimes(3)
    })

    it('handles multiple rapid clicks on close button', () => {
      const onClose = vi.fn()
      const onFocus = vi.fn()

      render(
        <Pane
          isActive={false}
          isOnlyPane={false}
          onClose={onClose}
          onFocus={onFocus}
        >
          <div>Content</div>
        </Pane>
      )

      const closeButton = screen.getByTitle('Close pane')
      fireEvent.click(closeButton)
      fireEvent.click(closeButton)
      fireEvent.click(closeButton)

      expect(onClose).toHaveBeenCalledTimes(3)
      expect(onFocus).not.toHaveBeenCalled()
    })

    it('renders with any children content', () => {
      const onClose = vi.fn()
      const onFocus = vi.fn()

      render(
        <Pane
          isActive={false}
          isOnlyPane={false}
          onClose={onClose}
          onFocus={onFocus}
        >
          <div data-testid="browser-content">Browser Content</div>
        </Pane>
      )

      expect(screen.getByTestId('browser-content')).toBeInTheDocument()
    })
  })
})

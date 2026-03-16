import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import Pane from '@/components/panes/Pane'
import { ContextIds } from '@/components/context-menu/context-menu-constants'

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  X: ({ className }: { className?: string }) => (
    <svg data-testid="x-icon" className={className} />
  ),
  Circle: ({ className }: { className?: string }) => (
    <svg data-testid="circle-icon" className={className} />
  ),
  Search: ({ className }: { className?: string }) => (
    <svg data-testid="search-icon" className={className} />
  ),
  Maximize2: ({ className }: { className?: string }) => (
    <svg data-testid="maximize-icon" className={className} />
  ),
  Minimize2: ({ className }: { className?: string }) => (
    <svg data-testid="minimize-icon" className={className} />
  ),
  RefreshCw: ({ className }: { className?: string }) => (
    <svg data-testid="refresh-icon" className={className} />
  ),
}))

vi.mock('@/components/icons/PaneIcon', () => ({
  default: ({ content, className }: { content: any; className?: string }) => (
    <svg data-testid="pane-icon" data-content-kind={content.kind} className={className} />
  ),
}))

function makeTerminalContent(mode = 'shell') {
  return { kind: 'terminal' as const, mode, shell: 'system' as const, createRequestId: 'r1', status: 'running' as const }
}

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

    it('renders fallback close button when no title is provided (including single-pane tabs)', () => {
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

      const closeButton = screen.getByTitle('Close pane')
      expect(closeButton).toBeInTheDocument()
    })
  })

  describe('active state styling', () => {
    it('does not apply opacity when active', () => {
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
      expect(paneDiv.className).not.toContain('opacity-')
    })

    it('applies reduced opacity when inactive', () => {
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
      expect(paneDiv.className).toContain('relative')
      expect(paneDiv.className).toContain('opacity-[0.85]')
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
      fireEvent.mouseDown(paneDiv)

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

  describe('accessibility', () => {
    it('renders with role="group" (not role="button")', () => {
      const { container } = render(
        <Pane
          tabId="t1"
          paneId="p1"
          isActive={true}
          isOnlyPane={false}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        >
          <div>Content</div>
        </Pane>
      )

      const paneDiv = container.firstChild as HTMLElement
      expect(paneDiv.getAttribute('role')).toBe('group')
    })

    it('keeps tabIndex={0} for keyboard accessibility', () => {
      const { container } = render(
        <Pane
          tabId="t1"
          paneId="p1"
          isActive={true}
          isOnlyPane={false}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        >
          <div>Content</div>
        </Pane>
      )

      const paneDiv = container.firstChild as HTMLElement
      expect(paneDiv.getAttribute('tabindex')).toBe('0')
    })

    it('marks the pane shell as the pane context target', () => {
      const { container } = render(
        <Pane
          tabId="t1"
          paneId="p1"
          isActive={true}
          isOnlyPane={false}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        >
          <div>Content</div>
        </Pane>
      )

      const paneDiv = container.firstChild as HTMLElement
      expect(paneDiv.dataset.context).toBe(ContextIds.Pane)
      expect(paneDiv.dataset.tabId).toBe('t1')
      expect(paneDiv.dataset.paneId).toBe('p1')
    })

    it('uses descriptive aria-label with "Pane:" prefix', () => {
      const { container } = render(
        <Pane
          tabId="t1"
          paneId="p1"
          isActive={true}
          isOnlyPane={false}
          title="My Terminal"
          status="running"
          content={makeTerminalContent()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        >
          <div>Content</div>
        </Pane>
      )

      const paneDiv = container.firstChild as HTMLElement
      expect(paneDiv.getAttribute('aria-label')).toBe('Pane: My Terminal')
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
      fireEvent.mouseDown(paneDiv)
      fireEvent.mouseDown(paneDiv)
      fireEvent.mouseDown(paneDiv)

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

  describe('header rendering', () => {
    it('renders PaneHeader when not the only pane and title is provided', () => {
      render(
        <Pane
          isActive={true}
          isOnlyPane={false}
          title="My Terminal"
          status="running"
          content={makeTerminalContent()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        >
          <div>Content</div>
        </Pane>
      )

      expect(screen.getByText('My Terminal')).toBeInTheDocument()
    })

    it('renders PaneHeader when only pane and title is provided', () => {
      render(
        <Pane
          isActive={true}
          isOnlyPane={true}
          title="My Terminal"
          status="running"
          content={makeTerminalContent()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        >
          <div>Content</div>
        </Pane>
      )

      expect(screen.getByText('My Terminal')).toBeInTheDocument()
    })

    it('passes metadata labels through to PaneHeader', () => {
      render(
        <Pane
          isActive={true}
          isOnlyPane={true}
          title="My Terminal"
          metaLabel="freshell (main*)  25%"
          status="running"
          content={makeTerminalContent('codex')}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        >
          <div>Content</div>
        </Pane>
      )

      expect(
        screen.getByText((_, element) => element?.getAttribute('title') === 'freshell (main*)  25%'),
      ).toBeInTheDocument()
    })

    it('renders fallback close button when no title provided but multiple panes', () => {
      render(
        <Pane
          isActive={true}
          isOnlyPane={false}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        >
          <div>Content</div>
        </Pane>
      )

      expect(screen.getByTitle('Close pane')).toBeInTheDocument()
    })

    it('header close button triggers onClose', () => {
      const onClose = vi.fn()
      render(
        <Pane
          isActive={true}
          isOnlyPane={false}
          title="My Terminal"
          status="running"
          content={makeTerminalContent()}
          onClose={onClose}
          onFocus={vi.fn()}
        >
          <div>Content</div>
        </Pane>
      )

      fireEvent.click(screen.getByTitle('Close pane'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  describe('refresh button forwarding', () => {
    it('forwards onRefresh to PaneHeader', () => {
      const onRefresh = vi.fn()
      render(
        <Pane
          tabId="t1"
          paneId="p1"
          isActive={true}
          isOnlyPane={false}
          title="Test"
          status="running"
          content={makeTerminalContent()}
          onRefresh={onRefresh}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        >
          <div>Content</div>
        </Pane>
      )

      const btn = screen.getByTitle('Refresh pane')
      expect(btn).toBeInTheDocument()
      fireEvent.click(btn)
      expect(onRefresh).toHaveBeenCalledTimes(1)
    })

    it('does not render refresh button when onRefresh is omitted', () => {
      render(
        <Pane
          tabId="t1"
          paneId="p1"
          isActive={true}
          isOnlyPane={false}
          title="Test"
          status="running"
          content={makeTerminalContent()}
          onClose={vi.fn()}
          onFocus={vi.fn()}
        >
          <div>Content</div>
        </Pane>
      )

      expect(screen.queryByTitle('Refresh pane')).toBeNull()
    })
  })
})

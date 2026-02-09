import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import PaneHeader from '@/components/panes/PaneHeader'

vi.mock('lucide-react', () => ({
  X: ({ className }: { className?: string }) => (
    <svg data-testid="x-icon" className={className} />
  ),
  Circle: ({ className }: { className?: string }) => (
    <svg data-testid="circle-icon" className={className} />
  ),
}))

describe('PaneHeader', () => {
  afterEach(() => {
    cleanup()
  })

  describe('rendering', () => {
    it('renders the title', () => {
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
        />
      )

      expect(screen.getByText('My Terminal')).toBeInTheDocument()
    })

    it('renders status indicator', () => {
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
        />
      )

      expect(screen.getByTestId('circle-icon')).toBeInTheDocument()
    })

    it('renders close button', () => {
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
        />
      )

      expect(screen.getByTitle('Close pane')).toBeInTheDocument()
    })
  })

  describe('interactions', () => {
    it('calls onClose when close button is clicked', () => {
      const onClose = vi.fn()
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={onClose}
        />
      )

      fireEvent.click(screen.getByTitle('Close pane'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('stops propagation on close button click', () => {
      const onClose = vi.fn()
      const parentClick = vi.fn()

      render(
        <div onClick={parentClick}>
          <PaneHeader
            title="My Terminal"
            status="running"
            isActive={true}
            onClose={onClose}
          />
        </div>
      )

      fireEvent.click(screen.getByTitle('Close pane'))
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(parentClick).not.toHaveBeenCalled()
    })
  })

  describe('inline rename', () => {
    it('shows input when isRenaming is true', () => {
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          isRenaming={true}
          renameValue="My Terminal"
          onRenameChange={vi.fn()}
          onRenameBlur={vi.fn()}
          onRenameKeyDown={vi.fn()}
        />
      )

      const input = screen.getByRole('textbox')
      expect(input).toBeInTheDocument()
      expect(input).toHaveValue('My Terminal')
      // Title span should not be present
      expect(screen.queryByText('My Terminal')).toBeNull()
    })

    it('shows title span when isRenaming is false', () => {
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          isRenaming={false}
        />
      )

      expect(screen.getByText('My Terminal')).toBeInTheDocument()
      expect(screen.queryByRole('textbox')).toBeNull()
    })

    it('calls onRenameChange when input value changes', () => {
      const onRenameChange = vi.fn()
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          isRenaming={true}
          renameValue="My Terminal"
          onRenameChange={onRenameChange}
          onRenameBlur={vi.fn()}
          onRenameKeyDown={vi.fn()}
        />
      )

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New Name' } })
      expect(onRenameChange).toHaveBeenCalledWith('New Name')
    })

    it('calls onRenameBlur when input loses focus', () => {
      const onRenameBlur = vi.fn()
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          isRenaming={true}
          renameValue="My Terminal"
          onRenameChange={vi.fn()}
          onRenameBlur={onRenameBlur}
          onRenameKeyDown={vi.fn()}
        />
      )

      fireEvent.blur(screen.getByRole('textbox'))
      expect(onRenameBlur).toHaveBeenCalledTimes(1)
    })

    it('calls onRenameKeyDown on key events', () => {
      const onRenameKeyDown = vi.fn()
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          isRenaming={true}
          renameValue="My Terminal"
          onRenameChange={vi.fn()}
          onRenameBlur={vi.fn()}
          onRenameKeyDown={onRenameKeyDown}
        />
      )

      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
      expect(onRenameKeyDown).toHaveBeenCalledTimes(1)
    })

    it('stops click propagation on input', () => {
      const parentClick = vi.fn()
      render(
        <div onClick={parentClick}>
          <PaneHeader
            title="My Terminal"
            status="running"
            isActive={true}
            onClose={vi.fn()}
            isRenaming={true}
            renameValue="My Terminal"
            onRenameChange={vi.fn()}
            onRenameBlur={vi.fn()}
            onRenameKeyDown={vi.fn()}
          />
        </div>
      )

      fireEvent.click(screen.getByRole('textbox'))
      expect(parentClick).not.toHaveBeenCalled()
    })

    it('calls onDoubleClick when title span is double-clicked', () => {
      const onDoubleClick = vi.fn()
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          onDoubleClick={onDoubleClick}
        />
      )

      fireEvent.doubleClick(screen.getByText('My Terminal'))
      expect(onDoubleClick).toHaveBeenCalledTimes(1)
    })
  })

  describe('styling', () => {
    it('applies active styling when active', () => {
      const { container } = render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
        />
      )

      const header = container.firstChild as HTMLElement
      expect(header.className).toContain('bg-muted')
      expect(header.className).not.toContain('bg-muted/50')
    })

    it('applies inactive styling when not active', () => {
      const { container } = render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={false}
          onClose={vi.fn()}
        />
      )

      const header = container.firstChild as HTMLElement
      expect(header.className).toContain('bg-muted/50')
    })
  })
})

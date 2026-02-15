import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import PaneHeader from '@/components/panes/PaneHeader'
import { formatPaneRuntimeLabel, formatPaneRuntimeTooltip } from '@/lib/format-terminal-title-meta'

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
}))

vi.mock('@/components/icons/PaneIcon', () => ({
  default: ({ content, className }: { content: any; className?: string }) => (
    <svg data-testid="pane-icon" data-content-kind={content.kind} data-content-mode={content.mode} className={className} />
  ),
}))

function makeTerminalContent(mode = 'shell') {
  return { kind: 'terminal' as const, mode, shell: 'system' as const, createRequestId: 'r1', status: 'running' as const }
}

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
          content={makeTerminalContent()}
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
          content={makeTerminalContent()}
        />
      )

      expect(screen.getByTestId('pane-icon')).toBeInTheDocument()
    })

    it('renders close button', () => {
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          content={makeTerminalContent()}
        />
      )

      expect(screen.getByTitle('Close pane')).toBeInTheDocument()
    })

    it('renders right-aligned metadata text before action icons', () => {
      render(
        <PaneHeader
          title="My Terminal"
          metaLabel="freshell (main*)  25%"
          metaTooltip={'Directory: /home/user/code/freshell\nbranch: main*\nTokens: 54,414/167,000(33% full)'}
          status="running"
          isActive={true}
          onClose={vi.fn()}
          onToggleZoom={vi.fn()}
          content={makeTerminalContent('codex')}
        />
      )

      expect(
        screen.getByText((_, element) =>
          element?.getAttribute('title') === 'Directory: /home/user/code/freshell\nbranch: main*\nTokens: 54,414/167,000(33% full)',
        ),
      ).toBeInTheDocument()
      expect(screen.getByTitle('Maximize pane')).toBeInTheDocument()
      expect(screen.getByTitle('Close pane')).toBeInTheDocument()
    })
  })

  describe('formatPaneRuntimeLabel()', () => {
    it('formats codex and claude metadata with identical spacing/output for equivalent inputs', () => {
      const codex = formatPaneRuntimeLabel({
        terminalId: 'term-1',
        provider: 'codex',
        checkoutRoot: '/home/user/freshell',
        branch: 'main',
        isDirty: true,
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 0,
          totalTokens: 15,
          compactPercent: 25,
        },
        updatedAt: 1,
      })

      const claude = formatPaneRuntimeLabel({
        terminalId: 'term-2',
        provider: 'claude',
        checkoutRoot: '/home/user/freshell',
        branch: 'main',
        isDirty: true,
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 0,
          totalTokens: 15,
          compactPercent: 25,
        },
        updatedAt: 1,
      })

      expect(codex).toBe('freshell (main*)  25%')
      expect(claude).toBe(codex)
    })

    it('omits percentage when compact-threshold usage is unavailable', () => {
      const label = formatPaneRuntimeLabel({
        terminalId: 'term-3',
        provider: 'codex',
        checkoutRoot: '/home/user/freshell',
        branch: 'main',
        isDirty: false,
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedTokens: 0,
          totalTokens: 15,
        },
        updatedAt: 1,
      })

      expect(label).toBe('freshell (main)')
    })
  })

  describe('formatPaneRuntimeTooltip()', () => {
    it('formats detailed hover text with directory, branch, and tokens', () => {
      const tooltip = formatPaneRuntimeTooltip({
        terminalId: 'term-4',
        provider: 'claude',
        cwd: '/home/user/code/freshell/.worktrees/fix-token-percent-calc',
        checkoutRoot: '/home/user/code/freshell/.worktrees/fix-token-percent-calc',
        branch: 'fix/token-percent-calc',
        isDirty: true,
        tokenUsage: {
          inputTokens: 1,
          outputTokens: 8,
          cachedTokens: 54405,
          totalTokens: 54414,
          contextTokens: 54414,
          compactThresholdTokens: 167000,
          compactPercent: 33,
        },
        updatedAt: 1,
      })

      expect(tooltip).toBe(
        'Directory: /home/user/code/freshell/.worktrees/fix-token-percent-calc\n' +
        'branch: fix/token-percent-calc*\n' +
        'Tokens: 54,414/167,000(33% full)',
      )
    })
  })

  describe('PaneIcon rendering', () => {
    it('renders PaneIcon with content instead of a plain circle', () => {
      const content = makeTerminalContent('claude')
      render(
        <PaneHeader title="My Terminal" status="running" isActive={true} onClose={vi.fn()} content={content} />
      )
      const paneIcon = screen.getByTestId('pane-icon')
      expect(paneIcon).toBeInTheDocument()
      expect(paneIcon.getAttribute('data-content-mode')).toBe('claude')
    })

    it('applies success color to icon when status is running', () => {
      render(
        <PaneHeader title="Test" status="running" isActive={true} onClose={vi.fn()} content={makeTerminalContent()} />
      )
      const paneIcon = screen.getByTestId('pane-icon')
      expect(paneIcon.getAttribute('class')).toContain('text-success')
    })

    it('applies destructive color to icon when status is error', () => {
      render(
        <PaneHeader title="Test" status="error" isActive={true} onClose={vi.fn()} content={makeTerminalContent()} />
      )
      const paneIcon = screen.getByTestId('pane-icon')
      expect(paneIcon.getAttribute('class')).toContain('text-destructive')
    })

    it('applies muted color to icon when status is exited', () => {
      render(
        <PaneHeader title="Test" status="exited" isActive={true} onClose={vi.fn()} content={makeTerminalContent()} />
      )
      const paneIcon = screen.getByTestId('pane-icon')
      expect(paneIcon.getAttribute('class')).toContain('text-muted-foreground/40')
    })

    it('applies pulse animation to icon when status is creating', () => {
      render(
        <PaneHeader title="Test" status="creating" isActive={true} onClose={vi.fn()} content={makeTerminalContent()} />
      )
      const paneIcon = screen.getByTestId('pane-icon')
      expect(paneIcon.getAttribute('class')).toContain('animate-pulse')
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
          content={makeTerminalContent()}
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
            content={makeTerminalContent()}
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
          content={makeTerminalContent()}
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
          content={makeTerminalContent()}
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
          content={makeTerminalContent()}
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
          content={makeTerminalContent()}
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
          content={makeTerminalContent()}
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
            content={makeTerminalContent()}
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
          content={makeTerminalContent()}
          onDoubleClick={onDoubleClick}
        />
      )

      fireEvent.doubleClick(screen.getByText('My Terminal'))
      expect(onDoubleClick).toHaveBeenCalledTimes(1)
    })
  })

  describe('zoom button', () => {
    it('renders maximize button when not zoomed', () => {
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          content={makeTerminalContent()}
          onToggleZoom={vi.fn()}
          isZoomed={false}
        />
      )

      const btn = screen.getByTitle('Maximize pane')
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveAttribute('aria-label', 'Maximize pane')
      expect(screen.getByTestId('maximize-icon')).toBeInTheDocument()
    })

    it('renders restore button when zoomed', () => {
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          content={makeTerminalContent()}
          onToggleZoom={vi.fn()}
          isZoomed={true}
        />
      )

      const btn = screen.getByTitle('Restore pane')
      expect(btn).toBeInTheDocument()
      expect(btn).toHaveAttribute('aria-label', 'Restore pane')
      expect(screen.getByTestId('minimize-icon')).toBeInTheDocument()
    })

    it('calls onToggleZoom when clicked', () => {
      const onToggleZoom = vi.fn()
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          content={makeTerminalContent()}
          onToggleZoom={onToggleZoom}
          isZoomed={false}
        />
      )

      fireEvent.click(screen.getByTitle('Maximize pane'))
      expect(onToggleZoom).toHaveBeenCalledTimes(1)
    })

    it('allows mouseDown to propagate so parent can activate pane', () => {
      const parentMouseDown = vi.fn()
      render(
        <div onMouseDown={parentMouseDown}>
          <PaneHeader
            title="My Terminal"
            status="running"
            isActive={true}
            onClose={vi.fn()}
            content={makeTerminalContent()}
            onToggleZoom={vi.fn()}
            isZoomed={false}
          />
        </div>
      )

      fireEvent.mouseDown(screen.getByTitle('Maximize pane'))
      expect(parentMouseDown).toHaveBeenCalledTimes(1)
    })

    it('does not render zoom button when onToggleZoom is not provided', () => {
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          content={makeTerminalContent()}
        />
      )

      expect(screen.queryByTitle('Maximize pane')).not.toBeInTheDocument()
      expect(screen.queryByTitle('Restore pane')).not.toBeInTheDocument()
    })
  })

  describe('search button', () => {
    it('renders search button for terminal panes when onSearch is provided', () => {
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          content={makeTerminalContent()}
          onSearch={vi.fn()}
        />
      )

      expect(screen.getByTitle('Search in terminal')).toBeInTheDocument()
      expect(screen.getByTestId('search-icon')).toBeInTheDocument()
    })

    it('does not render search button when onSearch is not provided', () => {
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          content={makeTerminalContent()}
        />
      )

      expect(screen.queryByTitle('Search in terminal')).not.toBeInTheDocument()
    })

    it('does not render search button for non-terminal panes', () => {
      render(
        <PaneHeader
          title="My Browser"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          content={{ kind: 'browser', url: 'https://example.com', devToolsOpen: false }}
          onSearch={vi.fn()}
        />
      )

      expect(screen.queryByTitle('Search in terminal')).not.toBeInTheDocument()
    })

    it('calls onSearch when search button is clicked', () => {
      const onSearch = vi.fn()
      render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          content={makeTerminalContent()}
          onSearch={onSearch}
        />
      )

      fireEvent.click(screen.getByTitle('Search in terminal'))
      expect(onSearch).toHaveBeenCalledTimes(1)
    })

    it('stops click propagation on search button', () => {
      const onSearch = vi.fn()
      const parentClick = vi.fn()

      render(
        <div onClick={parentClick}>
          <PaneHeader
            title="My Terminal"
            status="running"
            isActive={true}
            onClose={vi.fn()}
            content={makeTerminalContent()}
            onSearch={onSearch}
          />
        </div>
      )

      fireEvent.click(screen.getByTitle('Search in terminal'))
      expect(onSearch).toHaveBeenCalledTimes(1)
      expect(parentClick).not.toHaveBeenCalled()
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
          content={makeTerminalContent()}
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
          content={makeTerminalContent()}
        />
      )

      const header = container.firstChild as HTMLElement
      expect(header.className).toContain('bg-muted/50')
    })

    it('applies emerald attention styling when needsAttention is true', () => {
      const { container } = render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={false}
          needsAttention={true}
          onClose={vi.fn()}
          content={makeTerminalContent()}
        />
      )

      const header = container.firstChild as HTMLElement
      expect(header.className).toContain('bg-emerald-50')
      expect(header.className).toContain('border-l-emerald-500')
      // Attention takes precedence: no active/inactive bg classes
      expect(header.className).not.toContain('bg-muted/50')
      expect(header.className).not.toContain('text-muted-foreground')
    })

    it('does not apply emerald styling when needsAttention is false', () => {
      const { container } = render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          needsAttention={false}
          onClose={vi.fn()}
          content={makeTerminalContent()}
        />
      )

      const header = container.firstChild as HTMLElement
      expect(header.className).not.toContain('bg-emerald-50')
      expect(header.className).not.toContain('border-l-emerald-500')
      expect(header.className).toContain('bg-muted')
    })

    it('does not apply emerald styling when needsAttention is undefined', () => {
      const { container } = render(
        <PaneHeader
          title="My Terminal"
          status="running"
          isActive={true}
          onClose={vi.fn()}
          content={makeTerminalContent()}
        />
      )

      const header = container.firstChild as HTMLElement
      expect(header.className).not.toContain('bg-emerald-50')
      expect(header.className).not.toContain('border-l-emerald-500')
    })
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import TabItem from '@/components/TabItem'
import type { Tab } from '@/store/types'
import type { PaneContent } from '@/store/paneTypes'

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  X: ({ className }: { className?: string }) => (
    <svg data-testid="x-icon" className={className} />
  ),
  Circle: ({ className }: { className?: string }) => (
    <svg data-testid="circle-icon" className={className} />
  ),
}))

vi.mock('@/components/icons/PaneIcon', () => ({
  default: ({ content, className }: { content: any; className?: string }) => (
    <svg data-testid="pane-icon" data-terminal-id={content?.terminalId} className={className} />
  ),
}))

function createTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'tab-1',
    createRequestId: 'req-1',
    title: 'Test Tab',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    createdAt: Date.now(),
    ...overrides,
  }
}

function getTabElement() {
  return screen.getByText('Test Tab').closest('div[class*="group"]')
}

describe('TabItem', () => {
  afterEach(() => {
    cleanup()
  })

  const defaultProps = {
    tab: createTab(),
    isActive: false,
    needsAttention: false,
    isDragging: false,
    isRenaming: false,
    renameValue: '',
    onRenameChange: vi.fn(),
    onRenameBlur: vi.fn(),
    onRenameKeyDown: vi.fn(),
    onClose: vi.fn(),
    onClick: vi.fn(),
    onDoubleClick: vi.fn(),
  }

  it('renders tab title', () => {
    render(<TabItem {...defaultProps} />)
    expect(screen.getByText('Test Tab')).toBeInTheDocument()
  })

  it('applies active styles when isActive is true', () => {
    render(<TabItem {...defaultProps} isActive={true} />)
    const el = getTabElement()
    expect(el?.className).toContain('bg-background')
    expect(el?.className).toContain('border-b-background')
    expect(el?.className).not.toContain('-mb-px')
  })

  it('applies dragging opacity when isDragging is true', () => {
    render(<TabItem {...defaultProps} isDragging={true} />)
    const el = getTabElement()
    expect(el?.className).toContain('opacity-50')
  })

  it('applies emerald attention styles for highlight style (default)', () => {
    render(<TabItem {...defaultProps} needsAttention={true} />)
    const el = getTabElement()
    expect(el?.className).toContain('bg-emerald-100')
    expect(el?.className).toContain('text-emerald-900')
    expect(el?.className).not.toContain('animate-pulse')
  })

  it('applies emerald attention styles with animation for pulse style', () => {
    render(<TabItem {...defaultProps} needsAttention={true} tabAttentionStyle="pulse" />)
    const el = getTabElement()
    expect(el?.className).toContain('bg-emerald-100')
    expect(el?.className).toContain('animate-pulse')
  })

  it('applies foreground-based attention styles for darken style', () => {
    render(<TabItem {...defaultProps} needsAttention={true} tabAttentionStyle="darken" />)
    const el = getTabElement()
    expect(el?.className).toContain('bg-foreground/15')
    expect(el?.className).not.toContain('bg-emerald-100')
  })

  it('applies no attention styles when style is none', () => {
    render(<TabItem {...defaultProps} needsAttention={true} tabAttentionStyle="none" />)
    const el = getTabElement()
    expect(el?.className).not.toContain('bg-emerald-100')
    expect(el?.className).not.toContain('bg-foreground/15')
    expect(el?.className).toContain('bg-muted')
  })

  it('uses a static blue status dot for creating tabs when pane icons are unavailable', () => {
    render(<TabItem {...defaultProps} tab={createTab({ status: 'creating' })} paneContents={[]} iconsOnTabs={false} />)
    const dot = screen.getByTestId('circle-icon')
    expect(dot.getAttribute('class')).toContain('text-blue-500')
    expect(dot.getAttribute('class')).toContain('fill-blue-500')
    expect(dot.getAttribute('class')).not.toContain('animate-pulse')
  })

  it('applies attention classes on active tab with highlight', () => {
    render(<TabItem {...defaultProps} isActive={true} needsAttention={true} tabAttentionStyle="highlight" />)
    const el = getTabElement()
    expect(el?.className).toContain('border-t-[3px]')
    expect(el?.className).toContain('border-t-success')
    expect(el?.className).toContain('bg-success/15')
  })

  it('applies attention classes on active tab with darken', () => {
    render(<TabItem {...defaultProps} isActive={true} needsAttention={true} tabAttentionStyle="darken" />)
    const el = getTabElement()
    expect(el?.className).toContain('border-t-[3px]')
    expect(el?.className).toContain('border-t-muted-foreground')
    expect(el?.className).toContain('bg-foreground/[0.08]')
  })

  it('does not apply attention classes on active tab with none', () => {
    render(<TabItem {...defaultProps} isActive={true} needsAttention={true} tabAttentionStyle="none" />)
    const el = getTabElement()
    expect(el?.className).not.toContain('border-t-[3px]')
    expect(el?.className).not.toContain('border-t-success')
    expect(el?.className).not.toContain('border-t-muted-foreground')
  })

  it('applies animate-pulse on active tab with pulse style and attention', () => {
    render(<TabItem {...defaultProps} isActive={true} needsAttention={true} tabAttentionStyle="pulse" />)
    const el = getTabElement()
    expect(el?.className).toContain('animate-pulse')
  })

  it('shows input when isRenaming is true', () => {
    render(
      <TabItem
        {...defaultProps}
        isRenaming={true}
        renameValue="Editing"
      />
    )
    expect(screen.getByDisplayValue('Editing')).toBeInTheDocument()
  })

  it('pulses only the exact busy terminal icon in split tabs', () => {
    const paneContents: PaneContent[] = [
      {
        kind: 'terminal',
        mode: 'codex',
        shell: 'system',
        status: 'running',
        createRequestId: 'req-1',
        terminalId: 'term-1',
      },
      {
        kind: 'terminal',
        mode: 'shell',
        shell: 'system',
        status: 'running',
        createRequestId: 'req-2',
        terminalId: 'term-2',
      },
    ]

    render(
      <TabItem
        {...defaultProps}
        paneContents={paneContents}
        activityPulse={true}
        activityTerminalIds={['term-1']}
      />
    )

    const icons = screen.getAllByTestId('pane-icon')
    const busyIcon = icons.find((icon) => icon.getAttribute('data-terminal-id') === 'term-1')
    const idleIcon = icons.find((icon) => icon.getAttribute('data-terminal-id') === 'term-2')

    expect(busyIcon?.getAttribute('class')).toContain('animate-pulse')
    expect(idleIcon?.getAttribute('class') ?? '').not.toContain('animate-pulse')
  })

  it('pulses a single unnamed terminal icon during the exact tab-terminal fallback', () => {
    const paneContents: PaneContent[] = [
      {
        kind: 'terminal',
        mode: 'codex',
        shell: 'system',
        status: 'running',
        createRequestId: 'req-1',
        terminalId: undefined,
      },
    ]

    render(
      <TabItem
        {...defaultProps}
        paneContents={paneContents}
        activityPulse={true}
        activityTerminalIds={['term-tab']}
      />
    )

    expect(screen.getByTestId('pane-icon').getAttribute('class')).toContain('animate-pulse')
  })

  it('pulses the overflow indicator when the exact busy terminal is hidden beyond the visible icon cap', () => {
    const paneContents: PaneContent[] = Array.from({ length: 7 }, (_, index) => ({
      kind: 'terminal',
      mode: 'shell',
      shell: 'system',
      status: 'running',
      createRequestId: `req-${index + 1}`,
      terminalId: `term-${index + 1}`,
    }))

    render(
      <TabItem
        {...defaultProps}
        paneContents={paneContents}
        activityPulse={true}
        activityTerminalIds={['term-7']}
      />
    )

    expect(screen.getByText('+1').getAttribute('class')).toContain('animate-pulse')
  })

  it('calls onClick when clicked', () => {
    const onClick = vi.fn()
    render(<TabItem {...defaultProps} onClick={onClick} />)

    const el = getTabElement()
    fireEvent.click(el!)
    expect(onClick).toHaveBeenCalled()
  })

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn()
    render(<TabItem {...defaultProps} onClose={onClose} />)

    const closeButton = screen.getByTitle('Close (Shift+Click to kill)')
    fireEvent.click(closeButton)
    expect(onClose).toHaveBeenCalled()
  })

  it('calls onDoubleClick when double-clicked', () => {
    const onDoubleClick = vi.fn()
    render(<TabItem {...defaultProps} onDoubleClick={onDoubleClick} />)

    const el = getTabElement()
    fireEvent.doubleClick(el!)
    expect(onDoubleClick).toHaveBeenCalled()
  })

  it('uses the same title width class for active and inactive tabs', () => {
    const { rerender } = render(<TabItem {...defaultProps} isActive={false} />)
    let title = screen.getByText('Test Tab')
    expect(title.className).toContain('max-w-[5rem]')

    rerender(<TabItem {...defaultProps} isActive={true} />)
    title = screen.getByText('Test Tab')
    expect(title.className).toContain('max-w-[5rem]')
  })

  it('does not vertically offset inactive tabs', () => {
    render(<TabItem {...defaultProps} isActive={false} />)
    const el = getTabElement()
    expect(el?.className).not.toContain('mt-1')
  })

  describe('tooltip', () => {
    it('shows full title in tooltip on hover', async () => {
      render(<TabItem {...defaultProps} tab={createTab({ title: 'My Long Tab Name' })} />)

      const tabEl = screen.getByRole('button', { name: 'My Long Tab Name' })
      fireEvent.mouseEnter(tabEl)

      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip).toHaveTextContent('My Long Tab Name')
    })

    it('hides tooltip on mouse leave', async () => {
      render(<TabItem {...defaultProps} tab={createTab({ title: 'My Long Tab Name' })} />)

      const tabEl = screen.getByRole('button', { name: 'My Long Tab Name' })
      fireEvent.mouseEnter(tabEl)

      // Wait for tooltip to appear
      await screen.findByRole('tooltip')

      fireEvent.mouseLeave(tabEl)

      // Tooltip should be removed
      await waitFor(() => {
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      })
    })

    it('does not show tooltip during rename mode', async () => {
      render(
        <TabItem
          {...defaultProps}
          tab={createTab({ title: 'Renaming Tab' })}
          isRenaming={true}
          renameValue="Renaming Tab"
        />
      )

      const tabEl = screen.getByRole('button', { name: 'Renaming Tab' })
      fireEvent.mouseEnter(tabEl)

      // Give React a chance to flush — tooltip should never appear
      await waitFor(() => {
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      })
    })

    it('does not show tooltip during drag', async () => {
      render(
        <TabItem
          {...defaultProps}
          tab={createTab({ title: 'Dragging Tab' })}
          isDragging={true}
        />
      )

      const tabEl = screen.getByRole('button', { name: 'Dragging Tab' })
      fireEvent.mouseEnter(tabEl)

      // Give React a chance to flush — tooltip should never appear
      await waitFor(() => {
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
      })
    })
  })

  describe('XSS sanitization', () => {
    const XSS_PAYLOADS = [
      '<script>alert("xss")</script>',
      '<img src=x onerror=alert(1)>',
      '"><svg onload=alert(1)>',
    ]

    it.each(XSS_PAYLOADS)('escapes XSS payload in tab title: %s', (payload) => {
      const { container } = render(
        <TabItem {...defaultProps} tab={createTab({ title: payload })} />
      )
      // Payload should appear as visible escaped text, not parsed HTML
      expect(screen.getByText(payload)).toBeInTheDocument()
      // No script or img elements should be injected
      expect(container.querySelector('script')).toBeNull()
      expect(container.querySelector('img[onerror]')).toBeNull()
      expect(container.querySelector('svg[onload]')).toBeNull()
    })
  })
})

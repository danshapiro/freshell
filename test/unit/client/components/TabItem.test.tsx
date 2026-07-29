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

vi.mock('@/components/icons/RepoIcon', () => ({
  default: ({ info, className }: { info: any; className?: string }) => (
    <svg data-testid="repo-icon" data-repo-key={info?.repoKey} data-repo-name={info?.repoName} className={className} />
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

function createPaneEntries(contents: PaneContent[]) {
  return contents.map((content, index) => ({
    paneId: `pane-${index + 1}`,
    content,
  }))
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
    expect(screen.queryByTestId('tab-attention-bar')).toBeNull()
  })

  it('applies no attention styles when style is none', () => {
    // Under the new scheme `none` keeps the GREEN base and only suppresses
    // the unacked emphasis (bar/pulse/darken).
    render(<TabItem {...defaultProps} needsAttention={true} tabAttentionStyle="none" />)
    const el = getTabElement()
    expect(screen.queryByTestId('tab-attention-bar')).toBeNull()
    expect(el?.className).not.toContain('animate-pulse')
    expect(el?.className).not.toContain('bg-foreground/15')
    expect(el?.className).toContain('bg-emerald-100')
  })

  describe('canonical visual states', () => {
    it('working: busy inactive tab renders GREY (not blue, not emerald)', () => {
      render(<TabItem {...defaultProps} busy={true} />)
      const el = getTabElement()
      expect(el?.className).toContain('bg-zinc-300')
      expect(el?.className).not.toContain('bg-emerald-100')
      expect(el?.className).not.toContain('blue-500')
      // Structural busy marker — the out-of-task suites in Step 4b re-target
      // their busy/idle assertions and Playwright locators to this attribute.
      expect(el?.getAttribute('data-visual-state')).toBe('working')
    })

    it('ready: isReady inactive tab renders GREEN without the bar', () => {
      render(<TabItem {...defaultProps} isReady={true} />)
      const el = getTabElement()
      expect(el?.className).toContain('bg-emerald-100')
      expect(el?.getAttribute('data-visual-state')).toBe('ready')
      expect(screen.queryByTestId('tab-attention-bar')).toBeNull()
    })

    it('idle: a plain inactive tab exposes the neutral structural state', () => {
      render(<TabItem {...defaultProps} />)
      expect(getTabElement()?.getAttribute('data-visual-state')).toBe('neutral')
    })

    it('ready-unacked: attention on an inactive tab renders GREEN with the GREEN BAR', () => {
      render(<TabItem {...defaultProps} needsAttention={true} />)
      const el = getTabElement()
      expect(el?.className).toContain('bg-emerald-100')
      const bar = screen.getByTestId('tab-attention-bar')
      expect(bar.className).toContain('bg-emerald-500')
    })

    it('the ACTIVE tab never shows the bar even with attention', () => {
      render(<TabItem {...defaultProps} isActive={true} needsAttention={true} />)
      expect(screen.queryByTestId('tab-attention-bar')).toBeNull()
      const el = getTabElement()
      expect(el?.className).toContain('border-t-success')
    })

    it('working takes precedence over ready/attention', () => {
      render(<TabItem {...defaultProps} busy={true} isReady={true} needsAttention={true} />)
      const el = getTabElement()
      expect(el?.className).toContain('bg-zinc-300')
      expect(el?.className).not.toContain('bg-emerald-100')
      expect(screen.queryByTestId('tab-attention-bar')).toBeNull()
    })

    it('a tab whose panes all exited is neutral even when flagged ready', () => {
      render(
        <TabItem
          {...defaultProps}
          tab={createTab({ status: 'exited' })}
          isReady={true}
        />
      )
      const el = getTabElement()
      expect(el?.className).toContain('bg-muted')
      expect(el?.className).not.toContain('bg-emerald-100')
    })

    it('tabAttentionStyle none suppresses the bar but keeps the green base', () => {
      render(<TabItem {...defaultProps} needsAttention={true} tabAttentionStyle="none" />)
      expect(screen.queryByTestId('tab-attention-bar')).toBeNull()
      expect(getTabElement()?.className).toContain('bg-emerald-100')
    })

    it('tabAttentionStyle pulse animates the unacked tab', () => {
      render(<TabItem {...defaultProps} needsAttention={true} tabAttentionStyle="pulse" />)
      expect(getTabElement()?.className).toContain('animate-pulse')
      expect(screen.getByTestId('tab-attention-bar')).toBeTruthy()
    })
  })

  it('shows a grey single dot when a pane is busy even if the aggregate tab.status is not running', () => {
    // Multi-pane tab where last-writer-wins tab.status is 'exited' but a pane is
    // still busy. The single dot must reflect busy (grey), not the clobbered status.
    render(<TabItem {...defaultProps} tab={createTab({ status: 'exited' })} paneEntries={[]} iconsOnTabs={false} busy={true} />)
    const dot = screen.getByTestId('circle-icon')
    expect(dot.getAttribute('class')).toContain('fill-zinc-500')
    expect(dot.getAttribute('class')).not.toContain('fill-blue-500')
  })

  it('uses a muted status dot for creating tabs when pane icons are unavailable', () => {
    render(<TabItem {...defaultProps} tab={createTab({ status: 'creating' })} paneEntries={[]} iconsOnTabs={false} />)
    const dot = screen.getByTestId('circle-icon')
    expect(dot.getAttribute('class')).toContain('text-muted-foreground')
    expect(dot.getAttribute('class')).toContain('fill-muted-foreground')
    expect(dot.getAttribute('class')).not.toContain('text-blue-500')
  })

  it('applies attention classes on active tab with highlight', () => {
    render(<TabItem {...defaultProps} isActive={true} needsAttention={true} tabAttentionStyle="highlight" />)
    const el = getTabElement()
    expect(el?.className).toContain('border-t-[3px]')
    expect(el?.className).toContain('border-t-success')
    expect(el?.className).toContain('bg-success/15')
  })

  it('renders plain green on active tab with darken (no darken emphasis on the active tab)', () => {
    // RECORDED DECISION: 'ready-unacked' is unreachable on the ACTIVE tab, so
    // darken emphasis never applies there — the base green state is unconditional.
    render(<TabItem {...defaultProps} isActive={true} needsAttention={true} tabAttentionStyle="darken" />)
    const el = getTabElement()
    expect(el?.className).toContain('border-t-[3px]')
    expect(el?.className).toContain('border-t-success')
    expect(el?.className).toContain('bg-success/15')
    expect(el?.className).not.toContain('bg-foreground/[0.08]')
  })

  it('keeps the green base on active tab with none (base states are unconditional)', () => {
    render(<TabItem {...defaultProps} isActive={true} needsAttention={true} tabAttentionStyle="none" />)
    const el = getTabElement()
    expect(el?.className).toContain('border-t-[3px]')
    expect(el?.className).toContain('border-t-success')
    expect(screen.queryByTestId('tab-attention-bar')).toBeNull()
  })

  it('does not animate the active tab with pulse style and attention', () => {
    // Pulse emphasis is unacked-only; the active tab is never 'ready-unacked'.
    render(<TabItem {...defaultProps} isActive={true} needsAttention={true} tabAttentionStyle="pulse" />)
    const el = getTabElement()
    expect(el?.className).not.toContain('animate-pulse')
    expect(el?.className).toContain('border-t-success')
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

  it('renders all pane icons in dark grey regardless of busy state', () => {
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
        paneEntries={createPaneEntries(paneContents)}
        busy={true}
        busyPaneIds={['pane-1']}
      />
    )

    const icons = screen.getAllByTestId('pane-icon')
    for (const icon of icons) {
      expect(icon.getAttribute('class')).toContain('text-zinc-600')
      expect(icon.getAttribute('class')).not.toContain('text-blue-500')
      expect(icon.getAttribute('class')).not.toContain('text-success')
    }
  })

  it('shows grey icon for a single unnamed terminal during the exact tab-terminal fallback', () => {
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
        paneEntries={createPaneEntries(paneContents)}
        busy={true}
        busyPaneIds={['pane-1']}
      />
    )

    const icon = screen.getByTestId('pane-icon')
    expect(icon.getAttribute('class')).toContain('text-zinc-600')
    expect(icon.getAttribute('class')).not.toContain('text-blue-500')
  })

  it('shows grey emphasized overflow indicator when the busy terminal is hidden beyond the icon cap', () => {
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
        paneEntries={createPaneEntries(paneContents)}
        busy={true}
        busyPaneIds={['pane-7']}
      />
    )

    expect(screen.getByText('+4').getAttribute('class')).toContain('text-zinc-600')
    expect(screen.getByText('+4').getAttribute('class')).not.toContain('text-blue-500')
  })

  it('caps pane icons at 3 and shows a muted +N badge for the rest', () => {
    const paneContents: PaneContent[] = Array.from({ length: 5 }, (_, index) => ({
      kind: 'terminal',
      mode: 'shell',
      shell: 'system',
      status: 'running',
      createRequestId: `req-${index + 1}`,
      terminalId: `term-${index + 1}`,
    }))

    render(<TabItem {...defaultProps} paneEntries={createPaneEntries(paneContents)} />)

    expect(screen.getAllByTestId('pane-icon')).toHaveLength(3)
    const badge = screen.getByText('+2')
    expect(badge.getAttribute('class')).toContain('text-muted-foreground')
    expect(badge.getAttribute('class')).not.toContain('text-blue-500')
  })

  it('shows 3 icons plus +1 at 4 panes (cap boundary)', () => {
    const paneContents: PaneContent[] = Array.from({ length: 4 }, (_, index) => ({
      kind: 'terminal',
      mode: 'shell',
      shell: 'system',
      status: 'running',
      createRequestId: `req-${index + 1}`,
      terminalId: `term-${index + 1}`,
    }))

    render(<TabItem {...defaultProps} paneEntries={createPaneEntries(paneContents)} />)

    expect(screen.getAllByTestId('pane-icon')).toHaveLength(3)
    expect(screen.getByText('+1')).toBeInTheDocument()
  })

  it('shows no overflow badge at exactly 3 panes', () => {
    const paneContents: PaneContent[] = Array.from({ length: 3 }, (_, index) => ({
      kind: 'terminal',
      mode: 'shell',
      shell: 'system',
      status: 'running',
      createRequestId: `req-${index + 1}`,
      terminalId: `term-${index + 1}`,
    }))

    render(<TabItem {...defaultProps} paneEntries={createPaneEntries(paneContents)} />)

    expect(screen.getAllByTestId('pane-icon')).toHaveLength(3)
    expect(screen.queryByText(/^\+\d+$/)).toBeNull()
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
    expect(title.className).toContain('flex-1')
    expect(title.className).toContain('min-w-0')

    rerender(<TabItem {...defaultProps} isActive={true} />)
    title = screen.getByText('Test Tab')
    expect(title.className).toContain('flex-1')
    expect(title.className).toContain('min-w-0')
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

  describe('repo icons', () => {
    const codingContent = (initialCwd: string): PaneContent =>
      ({ kind: 'terminal', mode: 'claude', createRequestId: 'r', status: 'running', initialCwd } as PaneContent)

    const repoIcons = {
      '/repo/a': { repoKey: '/repo/a', repoName: 'a', iconUrl: '/api/repo-icon?cwd=%2Frepo%2Fa' },
      '/repo/b': { repoKey: '/repo/b', repoName: 'b' },
    }

    const manyRepoIcons = {
      ...repoIcons,
      '/repo/c': { repoKey: '/repo/c', repoName: 'c' },
      '/repo/d': { repoKey: '/repo/d', repoName: 'd' },
    }

    const entries = (cwds: Array<string | undefined>) =>
      cwds.map((repoCwd, i) => ({
        paneId: `pane-${i}`,
        content: codingContent(repoCwd ?? '/none'),
        repoCwd,
      }))

    it('renders one repo icon per distinct repo, left of that repo group', () => {
      render(
        <TabItem
          {...defaultProps}
          paneEntries={entries(['/repo/a', '/repo/a', '/repo/b'])}
          repoIcons={repoIcons}
        />,
      )
      const repoIconsRendered = screen.getAllByTestId('repo-icon')
      expect(repoIconsRendered).toHaveLength(2)
      expect(repoIconsRendered[0].getAttribute('data-repo-key')).toBe('/repo/a')
      expect(repoIconsRendered[1].getAttribute('data-repo-key')).toBe('/repo/b')
      expect(screen.getAllByTestId('pane-icon')).toHaveLength(3)
      // The first repo icon precedes the first pane icon in DOM order.
      const first = repoIconsRendered[0]
      const firstPane = screen.getAllByTestId('pane-icon')[0]
      expect(first.compareDocumentPosition(firstPane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('sizes repo icons h-3 w-3 like agent icons', () => {
      render(<TabItem {...defaultProps} paneEntries={entries(['/repo/a'])} repoIcons={repoIcons} />)
      const icon = screen.getByTestId('repo-icon')
      expect(icon.getAttribute('class') || '').toContain('h-3 w-3')
    })

    it('renders no repo icons when repoIconsOnTabs is false', () => {
      render(
        <TabItem
          {...defaultProps}
          paneEntries={entries(['/repo/a'])}
          repoIcons={repoIcons}
          repoIconsOnTabs={false}
        />,
      )
      expect(screen.queryByTestId('repo-icon')).toBeNull()
      expect(screen.getAllByTestId('pane-icon')).toHaveLength(1)
    })

    it('renders no repo icon for entries without repoCwd or without loaded info', () => {
      render(
        <TabItem
          {...defaultProps}
          paneEntries={entries([undefined, '/repo/unknown'])}
          repoIcons={repoIcons}
        />,
      )
      expect(screen.queryByTestId('repo-icon')).toBeNull()
      expect(screen.getAllByTestId('pane-icon')).toHaveLength(2)
    })

    it('shows at most 3 repo icons when a tab spans more than 3 distinct repos', () => {
      render(
        <TabItem
          {...defaultProps}
          paneEntries={entries(['/repo/a', '/repo/b', '/repo/c', '/repo/d'])}
          repoIcons={manyRepoIcons}
        />,
      )
      const repoIconsRendered = screen.getAllByTestId('repo-icon')
      expect(repoIconsRendered).toHaveLength(3)
      // Deterministic: the first 3 distinct repos in pane order.
      expect(repoIconsRendered.map((el) => el.getAttribute('data-repo-key'))).toEqual([
        '/repo/a',
        '/repo/b',
        '/repo/c',
      ])
      expect(screen.getAllByTestId('pane-icon')).toHaveLength(3)
      // Repo truncation is silent: the only badge is the pane-overflow +1.
      expect(screen.getAllByText(/^\+\d+$/)).toHaveLength(1)
      expect(screen.getByText('+1')).toBeInTheDocument()
    })

    it('does not render repo icons for repos whose panes are all hidden beyond the pane cap', () => {
      render(
        <TabItem
          {...defaultProps}
          paneEntries={entries(['/repo/a', '/repo/a', '/repo/a', '/repo/b'])}
          repoIcons={manyRepoIcons}
        />,
      )
      const repoIconsRendered = screen.getAllByTestId('repo-icon')
      expect(repoIconsRendered).toHaveLength(1)
      expect(repoIconsRendered[0].getAttribute('data-repo-key')).toBe('/repo/a')
      expect(screen.getAllByTestId('pane-icon')).toHaveLength(3)
      expect(screen.getByText('+1')).toBeInTheDocument()
    })

    it('shows all 3 repo icons with no badge when exactly 3 panes span 3 repos', () => {
      render(
        <TabItem
          {...defaultProps}
          paneEntries={entries(['/repo/a', '/repo/b', '/repo/c'])}
          repoIcons={manyRepoIcons}
        />,
      )
      expect(screen.getAllByTestId('repo-icon')).toHaveLength(3)
      expect(screen.getAllByTestId('pane-icon')).toHaveLength(3)
      expect(screen.queryByText(/^\+\d+$/)).toBeNull()
    })
  })

  describe('fixed tab width', () => {
    it('every tab is fixed at 240px (w-60) and never flex-shrinks', () => {
      render(<TabItem {...defaultProps} />)
      const el = getTabElement()
      expect(el?.className).toContain('w-60')
      expect(el?.className).toContain('shrink-0')
    })

    it('the label fills the fixed width and truncates with ellipsis', () => {
      render(<TabItem {...defaultProps} tab={createTab({ title: 'Test Tab' })} />)
      const label = screen.getByText('Test Tab')
      expect(label.className).toContain('truncate')
      expect(label.className).toContain('flex-1')
      expect(label.className).toContain('min-w-0')
      expect(label.className).not.toContain('max-w-[5rem]')
    })

    it('the rename input fills the same space (no width jump on rename)', () => {
      render(<TabItem {...defaultProps} isRenaming={true} renameValue="abc" />)
      const input = screen.getByDisplayValue('abc')
      expect(input.className).toContain('flex-1')
      expect(input.className).toContain('min-w-0')
      expect(input.className).not.toContain('w-32')
    })
  })
})

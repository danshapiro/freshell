import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import TabItem from '@/components/TabItem'
import type { Tab } from '@/store/types'

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  X: ({ className }: { className?: string }) => (
    <svg data-testid="x-icon" className={className} />
  ),
  Circle: ({ className }: { className?: string }) => (
    <svg data-testid="circle-icon" className={className} />
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

describe('TabItem', () => {
  afterEach(() => {
    cleanup()
  })

  const defaultProps = {
    tab: createTab(),
    isActive: false,
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
    const tabElement = screen.getByText('Test Tab').closest('div[class*="group"]')
    expect(tabElement?.className).toContain('bg-background')
  })

  it('applies dragging opacity when isDragging is true', () => {
    render(<TabItem {...defaultProps} isDragging={true} />)
    const tabElement = screen.getByText('Test Tab').closest('div[class*="group"]')
    expect(tabElement?.className).toContain('opacity-50')
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

  it('calls onClick when clicked', () => {
    const onClick = vi.fn()
    render(<TabItem {...defaultProps} onClick={onClick} />)

    const tabElement = screen.getByText('Test Tab').closest('div[class*="group"]')
    fireEvent.click(tabElement!)
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

    const tabElement = screen.getByText('Test Tab').closest('div[class*="group"]')
    fireEvent.doubleClick(tabElement!)
    expect(onDoubleClick).toHaveBeenCalled()
  })
})

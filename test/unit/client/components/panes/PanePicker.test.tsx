import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import PanePicker from '@/components/panes/PanePicker'

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Terminal: ({ className }: { className?: string }) => (
    <svg data-testid="terminal-icon" className={className} />
  ),
  Globe: ({ className }: { className?: string }) => (
    <svg data-testid="globe-icon" className={className} />
  ),
  FileText: ({ className }: { className?: string }) => (
    <svg data-testid="file-text-icon" className={className} />
  ),
}))

// Mock redux hooks
vi.mock('@/store/hooks', () => ({
  useAppSelector: vi.fn(),
}))

import { useAppSelector } from '@/store/hooks'
const mockUseAppSelector = vi.mocked(useAppSelector)

describe('PanePicker', () => {
  let onSelect: ReturnType<typeof vi.fn>
  let onCancel: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onSelect = vi.fn()
    onCancel = vi.fn()
    mockUseAppSelector.mockReturnValue(null) // Default: unknown platform
  })

  afterEach(() => {
    cleanup()
  })

  // Helper to get the container div that handles transition
  // Uses 'Browser' text which is always present regardless of platform
  const getContainer = () => {
    return screen.getByText('Browser').closest('button')!.parentElement!.parentElement!
  }

  // Helper to complete the fade animation
  const completeFadeAnimation = () => {
    fireEvent.transitionEnd(getContainer())
  }

  describe('rendering', () => {
    it('renders all three options', () => {
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)
      expect(screen.getByText('Shell')).toBeInTheDocument()
      expect(screen.getByText('Browser')).toBeInTheDocument()
      expect(screen.getByText('Editor')).toBeInTheDocument()
    })

    it('renders icons for each option', () => {
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)
      expect(screen.getByTestId('terminal-icon')).toBeInTheDocument()
      expect(screen.getByTestId('globe-icon')).toBeInTheDocument()
      expect(screen.getByTestId('file-text-icon')).toBeInTheDocument()
    })
  })

  describe('mouse interaction', () => {
    it('calls onSelect with shell when Shell is clicked after fade', () => {
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)
      fireEvent.click(screen.getByText('Shell'))
      // onSelect is called after fade animation completes
      expect(onSelect).not.toHaveBeenCalled()
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('shell')
    })

    it('starts fade animation on click', () => {
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)
      const container = getContainer()
      expect(container).not.toHaveClass('opacity-0')
      fireEvent.click(screen.getByText('Shell'))
      expect(container).toHaveClass('opacity-0')
    })

    it('ignores additional clicks during fade', () => {
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)
      fireEvent.click(screen.getByText('Shell'))
      fireEvent.click(screen.getByText('Browser'))
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith('shell')
    })
  })

  describe('keyboard shortcuts', () => {
    it('calls onSelect with shell on S key after fade', () => {
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)
      fireEvent.keyDown(document, { key: 's' })
      expect(onSelect).not.toHaveBeenCalled()
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('shell')
    })

    it('shortcuts are case-insensitive', () => {
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)
      fireEvent.keyDown(document, { key: 'S' })
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('shell')
    })
  })

  describe('arrow key navigation', () => {
    it('moves focus right with ArrowRight', () => {
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)
      const shellButton = screen.getByText('Shell').closest('button')!
      shellButton.focus()
      fireEvent.keyDown(shellButton, { key: 'ArrowRight' })
      const browserButton = screen.getByText('Browser').closest('button')!
      expect(browserButton).toHaveFocus()
    })

    it('selects focused option on Enter after fade', () => {
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)
      const browserButton = screen.getByText('Browser').closest('button')!
      browserButton.focus()
      fireEvent.keyDown(browserButton, { key: 'Enter' })
      expect(onSelect).not.toHaveBeenCalled()
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('browser')
    })
  })

  describe('escape behavior', () => {
    it('calls onCancel on Escape when not only pane', () => {
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onCancel).toHaveBeenCalled()
    })

    it('does not call onCancel on Escape when only pane', () => {
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={true} />)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onCancel).not.toHaveBeenCalled()
    })
  })

  describe('shortcut hints', () => {
    it('shows shortcut hint on hover', () => {
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)
      const shellButton = screen.getByText('Shell').closest('button')!
      fireEvent.mouseEnter(shellButton)
      const hint = screen.getByText('S', { selector: '.shortcut-hint' })
      expect(hint).toHaveClass('opacity-40')
    })

    it('hides shortcut hint on mouse leave', () => {
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)
      const shellButton = screen.getByText('Shell').closest('button')!
      fireEvent.mouseEnter(shellButton)
      fireEvent.mouseLeave(shellButton)
      const hint = screen.getByText('S', { selector: '.shortcut-hint' })
      expect(hint).toHaveClass('opacity-0')
    })
  })

  describe('platform-specific shell options', () => {
    it('shows single Shell option on non-Windows platforms', () => {
      mockUseAppSelector.mockReturnValue('darwin')
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)

      expect(screen.getByText('Shell')).toBeInTheDocument()
      expect(screen.queryByText('CMD')).not.toBeInTheDocument()
      expect(screen.queryByText('PowerShell')).not.toBeInTheDocument()
      expect(screen.queryByText('WSL')).not.toBeInTheDocument()
    })

    it('shows CMD, PowerShell, WSL options on Windows', () => {
      mockUseAppSelector.mockReturnValue('win32')
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)

      expect(screen.getByText('CMD')).toBeInTheDocument()
      expect(screen.getByText('PowerShell')).toBeInTheDocument()
      expect(screen.getByText('WSL')).toBeInTheDocument()
      expect(screen.queryByText('Shell')).not.toBeInTheDocument()
    })

    it('calls onSelect with cmd when CMD clicked on Windows', () => {
      mockUseAppSelector.mockReturnValue('win32')
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)

      fireEvent.click(screen.getByText('CMD'))
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('cmd')
    })

    it('calls onSelect with powershell when PowerShell clicked', () => {
      mockUseAppSelector.mockReturnValue('win32')
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)

      fireEvent.click(screen.getByText('PowerShell'))
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('powershell')
    })

    it('calls onSelect with wsl when WSL clicked', () => {
      mockUseAppSelector.mockReturnValue('win32')
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)

      fireEvent.click(screen.getByText('WSL'))
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('wsl')
    })

    it('uses C shortcut for CMD on Windows', () => {
      mockUseAppSelector.mockReturnValue('win32')
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)

      fireEvent.keyDown(document, { key: 'c' })
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('cmd')
    })

    it('uses P shortcut for PowerShell on Windows', () => {
      mockUseAppSelector.mockReturnValue('win32')
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)

      fireEvent.keyDown(document, { key: 'p' })
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('powershell')
    })

    it('uses W shortcut for WSL on Windows', () => {
      mockUseAppSelector.mockReturnValue('win32')
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)

      fireEvent.keyDown(document, { key: 'w' })
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('wsl')
    })

    it('falls back to Shell option when platform is null', () => {
      mockUseAppSelector.mockReturnValue(null)
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)

      expect(screen.getByText('Shell')).toBeInTheDocument()
    })

    it('shows CMD, PowerShell, WSL options on WSL platform', () => {
      mockUseAppSelector.mockReturnValue('wsl')
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)

      expect(screen.getByText('CMD')).toBeInTheDocument()
      expect(screen.getByText('PowerShell')).toBeInTheDocument()
      expect(screen.getByText('WSL')).toBeInTheDocument()
      expect(screen.queryByText('Shell')).not.toBeInTheDocument()
    })

    it('calls onSelect with cmd when CMD clicked on WSL', () => {
      mockUseAppSelector.mockReturnValue('wsl')
      render(<PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={false} />)

      fireEvent.click(screen.getByText('CMD'))
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('cmd')
    })
  })
})

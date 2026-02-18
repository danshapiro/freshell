import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import PanePicker from '@/components/panes/PanePicker'
import settingsReducer from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { DefaultNewPane, SidebarSortMode, TerminalTheme } from '@/store/types'

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

function createStore(overrides?: {
  platform?: string | null
  availableClis?: Record<string, boolean>
  enabledProviders?: string[]
}) {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      connection: {
        status: 'ready' as const,
        platform: overrides?.platform ?? null,
        availableClis: overrides?.availableClis ?? {},
      },
      settings: {
        settings: {
          theme: 'system' as const,
          uiScale: 1,
          terminal: {
            fontSize: 14,
            fontFamily: 'monospace',
            lineHeight: 1.2,
            cursorBlink: true,
            scrollback: 5000,
            theme: 'auto' as TerminalTheme,
          },
          safety: { autoKillIdleMinutes: 180, warnBeforeKillMinutes: 5 },
          sidebar: {
            sortMode: 'activity' as SidebarSortMode,
            showProjectBadges: true,
            width: 288,
            collapsed: false,
          },
          panes: { defaultNewPane: 'ask' as DefaultNewPane },
          codingCli: {
            enabledProviders: (overrides?.enabledProviders ?? []) as any[],
            providers: {},
          },
          logging: { debug: false },
        },
        loaded: true,
        lastSavedAt: null,
      },
    },
  })
}

function renderPicker(
  overrides?: Parameters<typeof createStore>[0],
  props?: { onSelect?: ReturnType<typeof vi.fn>; onCancel?: ReturnType<typeof vi.fn>; isOnlyPane?: boolean }
) {
  const store = createStore(overrides)
  const onSelect = props?.onSelect ?? vi.fn()
  const onCancel = props?.onCancel ?? vi.fn()
  const isOnlyPane = props?.isOnlyPane ?? false
  render(
    <Provider store={store}>
      <PanePicker onSelect={onSelect} onCancel={onCancel} isOnlyPane={isOnlyPane} />
    </Provider>
  )
  return { onSelect, onCancel, store }
}

// Helper to get the picker container
const getContainer = () => {
  const container = document.querySelector('[data-context="pane-picker"]')
  if (!container) throw new Error('Picker container not found')
  return container
}

// Helper to complete the fade animation
const completeFadeAnimation = () => {
  fireEvent.transitionEnd(getContainer())
}

describe('PanePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  describe('rendering', () => {
    it('renders Editor, Browser, Shell options by default', () => {
      renderPicker()
      expect(screen.getByText('Editor')).toBeInTheDocument()
      expect(screen.getByText('Browser')).toBeInTheDocument()
      expect(screen.getByText('Shell')).toBeInTheDocument()
    })

    it('renders icons for each option', () => {
      renderPicker()
      expect(screen.getByTestId('file-text-icon')).toBeInTheDocument()
      expect(screen.getByTestId('globe-icon')).toBeInTheDocument()
      expect(screen.getByTestId('terminal-icon')).toBeInTheDocument()
    })

    it('shows Claude and Codex buttons when available and enabled', () => {
      renderPicker({
        availableClis: { claude: true, codex: true },
        enabledProviders: ['claude', 'codex'],
      })
      expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Codex' })).toBeInTheDocument()
    })

    it('hides Claude when not available on system', () => {
      renderPicker({
        availableClis: { claude: false, codex: true },
        enabledProviders: ['claude', 'codex'],
      })
      expect(screen.queryByRole('button', { name: 'Claude' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Codex' })).toBeInTheDocument()
    })

    it('hides Codex when disabled in settings', () => {
      renderPicker({
        availableClis: { claude: true, codex: true },
        enabledProviders: ['claude'],
      })
      expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Codex' })).not.toBeInTheDocument()
    })

    it('renders provider icons as inline SVGs (not img tags)', () => {
      renderPicker({
        availableClis: { claude: true, codex: true },
        enabledProviders: ['claude', 'codex'],
      })
      const claudeButton = screen.getByRole('button', { name: 'Claude' })
      const codexButton = screen.getByRole('button', { name: 'Codex' })

      // Should render inline SVGs that inherit color, not <img> tags
      expect(claudeButton.querySelector('svg')).toBeInTheDocument()
      expect(claudeButton.querySelector('img')).not.toBeInTheDocument()
      expect(codexButton.querySelector('svg')).toBeInTheDocument()
      expect(codexButton.querySelector('img')).not.toBeInTheDocument()
    })

    it('renders options in correct order: CLIs, freshclaude, Editor, Browser, Shell', () => {
      renderPicker({
        availableClis: { claude: true, codex: true },
        enabledProviders: ['claude', 'codex'],
      })
      const buttons = screen.getAllByRole('button')
      const labels = buttons.map(b => b.getAttribute('aria-label'))
      expect(labels[0]).toBe('Claude')
      expect(labels[1]).toBe('Codex')
      expect(labels[2]).toBe('freshclaude')
      expect(labels[3]).toBe('Editor')
      expect(labels[4]).toBe('Browser')
      expect(labels[5]).toBe('Shell')
    })

    it('shows only non-CLI options when no CLIs are available', () => {
      renderPicker({ availableClis: {} })
      expect(screen.queryByRole('button', { name: 'Claude' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Codex' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Editor' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Browser' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Shell' })).toBeInTheDocument()
    })
  })

  describe('mouse interaction', () => {
    it('calls onSelect with shell when Shell is clicked after fade', () => {
      const { onSelect } = renderPicker()
      fireEvent.click(screen.getByText('Shell'))
      expect(onSelect).not.toHaveBeenCalled()
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('shell')
    })

    it('starts fade animation on click', () => {
      renderPicker()
      const container = getContainer()
      expect(container).not.toHaveClass('opacity-0')
      fireEvent.click(screen.getByText('Shell'))
      expect(container).toHaveClass('opacity-0')
    })

    it('ignores additional clicks during fade', () => {
      const { onSelect } = renderPicker()
      fireEvent.click(screen.getByText('Shell'))
      fireEvent.click(screen.getByText('Browser'))
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect).toHaveBeenCalledWith('shell')
    })

    it('calls onSelect with claude when Claude button is clicked', () => {
      const { onSelect } = renderPicker({
        availableClis: { claude: true },
        enabledProviders: ['claude'],
      })
      fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('claude')
    })
  })

  describe('keyboard shortcuts (scoped to picker container)', () => {
    it('fires shortcut S for Shell when container has focus', () => {
      const { onSelect } = renderPicker()
      const container = getContainer()
      fireEvent.keyDown(container, { key: 's' })
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('shell')
    })

    it('shortcuts are case-insensitive', () => {
      const { onSelect } = renderPicker()
      const container = getContainer()
      fireEvent.keyDown(container, { key: 'S' })
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('shell')
    })

    it('fires shortcut L for Claude', () => {
      const { onSelect } = renderPicker({
        availableClis: { claude: true },
        enabledProviders: ['claude'],
      })
      fireEvent.keyDown(getContainer(), { key: 'l' })
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('claude')
    })

    it('fires shortcut X for Codex', () => {
      const { onSelect } = renderPicker({
        availableClis: { codex: true },
        enabledProviders: ['codex'],
      })
      fireEvent.keyDown(getContainer(), { key: 'x' })
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('codex')
    })

    it('does not fire shortcuts when an element outside the picker has focus', () => {
      const onSelect = vi.fn()
      const store = createStore()
      render(
        <Provider store={store}>
          <div>
            <PanePicker onSelect={onSelect} onCancel={vi.fn()} isOnlyPane={false} />
            <input data-testid="other-input" />
          </div>
        </Provider>
      )
      const otherInput = screen.getByTestId('other-input')
      otherInput.focus()
      fireEvent.keyDown(otherInput, { key: 's' })
      expect(onSelect).not.toHaveBeenCalled()
    })
  })

  describe('arrow key navigation', () => {
    it('moves focus right with ArrowRight', () => {
      renderPicker()
      const editorButton = screen.getByText('Editor').closest('button')!
      editorButton.focus()
      fireEvent.keyDown(editorButton, { key: 'ArrowRight' })
      const browserButton = screen.getByText('Browser').closest('button')!
      expect(browserButton).toHaveFocus()
    })

    it('selects focused option on Enter after fade', () => {
      const { onSelect } = renderPicker()
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
      const { onCancel } = renderPicker()
      fireEvent.keyDown(getContainer(), { key: 'Escape' })
      expect(onCancel).toHaveBeenCalled()
    })

    it('does not call onCancel on Escape when only pane', () => {
      const onCancel = vi.fn()
      renderPicker(undefined, { onCancel, isOnlyPane: true })
      fireEvent.keyDown(getContainer(), { key: 'Escape' })
      expect(onCancel).not.toHaveBeenCalled()
    })
  })

  describe('shortcut hints', () => {
    it('shows shortcut hint on hover', () => {
      renderPicker()
      const shellButton = screen.getByText('Shell').closest('button')!
      fireEvent.mouseEnter(shellButton)
      const hint = screen.getByText('S', { selector: '.shortcut-hint' })
      expect(hint).toHaveClass('opacity-40')
    })

    it('hides shortcut hint on mouse leave', () => {
      renderPicker()
      const shellButton = screen.getByText('Shell').closest('button')!
      fireEvent.mouseEnter(shellButton)
      fireEvent.mouseLeave(shellButton)
      const hint = screen.getByText('S', { selector: '.shortcut-hint' })
      expect(hint).toHaveClass('opacity-0')
    })
  })

  describe('platform-specific shell options', () => {
    it('shows single Shell option on non-Windows platforms', () => {
      renderPicker({ platform: 'darwin' })
      expect(screen.getByText('Shell')).toBeInTheDocument()
      expect(screen.queryByText('CMD')).not.toBeInTheDocument()
      expect(screen.queryByText('PowerShell')).not.toBeInTheDocument()
      expect(screen.queryByText('WSL')).not.toBeInTheDocument()
    })

    it('shows CMD, PowerShell, WSL options on Windows', () => {
      renderPicker({ platform: 'win32' })
      expect(screen.getByText('CMD')).toBeInTheDocument()
      expect(screen.getByText('PowerShell')).toBeInTheDocument()
      expect(screen.getByText('WSL')).toBeInTheDocument()
      expect(screen.queryByText('Shell')).not.toBeInTheDocument()
    })

    it('calls onSelect with cmd when CMD clicked on Windows', () => {
      const { onSelect } = renderPicker({ platform: 'win32' })
      fireEvent.click(screen.getByText('CMD'))
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('cmd')
    })

    it('calls onSelect with powershell when PowerShell clicked', () => {
      const { onSelect } = renderPicker({ platform: 'win32' })
      fireEvent.click(screen.getByText('PowerShell'))
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('powershell')
    })

    it('calls onSelect with wsl when WSL clicked', () => {
      const { onSelect } = renderPicker({ platform: 'win32' })
      fireEvent.click(screen.getByText('WSL'))
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('wsl')
    })

    it('uses C shortcut for CMD on Windows', () => {
      const { onSelect } = renderPicker({ platform: 'win32' })
      fireEvent.keyDown(getContainer(), { key: 'c' })
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('cmd')
    })

    it('uses P shortcut for PowerShell on Windows', () => {
      const { onSelect } = renderPicker({ platform: 'win32' })
      fireEvent.keyDown(getContainer(), { key: 'p' })
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('powershell')
    })

    it('uses W shortcut for WSL on Windows', () => {
      const { onSelect } = renderPicker({ platform: 'win32' })
      fireEvent.keyDown(getContainer(), { key: 'w' })
      completeFadeAnimation()
      expect(onSelect).toHaveBeenCalledWith('wsl')
    })

    it('falls back to Shell option when platform is null', () => {
      renderPicker({ platform: null })
      expect(screen.getByText('Shell')).toBeInTheDocument()
    })

    it('shows CMD, PowerShell, WSL options on WSL platform', () => {
      renderPicker({ platform: 'wsl' })
      expect(screen.getByText('CMD')).toBeInTheDocument()
      expect(screen.getByText('PowerShell')).toBeInTheDocument()
      expect(screen.getByText('WSL')).toBeInTheDocument()
      expect(screen.queryByText('Shell')).not.toBeInTheDocument()
    })
  })

  describe('auto-focus on mount', () => {
    it('focuses the picker container on mount', () => {
      renderPicker()
      const container = getContainer()
      expect(container).toHaveFocus()
    })
  })

  describe('responsive sizing', () => {
    it('applies @container class to outer wrapper', () => {
      renderPicker()
      const container = getContainer()
      expect(container).toHaveClass('@container')
    })

    it('applies responsive padding classes to outer wrapper', () => {
      renderPicker()
      const container = getContainer()
      expect(container).toHaveClass('p-2')
    })

    it('applies responsive gap classes to button container', () => {
      renderPicker()
      const buttonContainer = screen.getByTestId('pane-picker-options')
      expect(buttonContainer).toHaveClass('gap-2')
    })

    it('applies responsive padding classes to buttons', () => {
      renderPicker()
      const shellButton = screen.getByText('Shell').closest('button')!
      expect(shellButton).toHaveClass('p-2')
    })
  })

  describe('balanced icon layout', () => {
    it('prefers a balanced 3+2 arrangement when five options are visible', () => {
      renderPicker({
        availableClis: { claude: true },
        enabledProviders: ['claude'],
      })

      const rows = screen.getAllByTestId('pane-picker-option-row')
      expect(rows).toHaveLength(2)
      expect(within(rows[0]).getAllByRole('button')).toHaveLength(3)
      expect(within(rows[1]).getAllByRole('button')).toHaveLength(2)
    })
  })
})

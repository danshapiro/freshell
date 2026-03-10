import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { LOCAL_TERMINAL_FONT_KEY } from '@/lib/terminal-fonts'
import { defaultSettings } from '@/store/settingsSlice'
import {
  createSettingsViewStore,
  installSettingsViewHooks,
  mockAvailableFonts,
  renderSettingsView,
} from './settings-view-test-utils'

vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

import { api } from '@/lib/api'

installSettingsViewHooks({ fakeTimers: true, mockFonts: true })

function getFontFamilySelect() {
  return screen.getAllByRole('combobox').find((select) => {
    return select.querySelector('option[value="JetBrains Mono"]') !== null
  })!
}

function getFontSizeSlider() {
  return screen.getAllByRole('slider').find((slider) => {
    const min = slider.getAttribute('min')
    const max = slider.getAttribute('max')
    return min === '12' && max === '32'
  })!
}

describe('SettingsView core sections', () => {
  describe('renders settings form', () => {
    it('renders the Settings header', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const headings = screen.getAllByRole('heading', { name: 'Settings' })
      expect(headings[0]).toBeInTheDocument()
    })

    it('renders all settings sections', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      expect(screen.getByText('Terminal preview')).toBeInTheDocument()

      expect(screen.getByText('Appearance')).toBeInTheDocument()
      expect(screen.getByText('Theme and visual preferences')).toBeInTheDocument()

      expect(screen.getByText('Terminal')).toBeInTheDocument()
      expect(screen.getByText('Font and rendering options')).toBeInTheDocument()

      expect(screen.getByText('Sidebar')).toBeInTheDocument()
      expect(screen.getByText('Session list and navigation')).toBeInTheDocument()

      expect(screen.getByText('Safety')).toBeInTheDocument()
      expect(screen.getByText('Auto-kill and idle terminal management')).toBeInTheDocument()

      expect(screen.getByText('Debugging')).toBeInTheDocument()
      expect(screen.getByText('Debug-level logs and perf instrumentation')).toBeInTheDocument()

      expect(screen.getByText('Notifications')).toBeInTheDocument()
      expect(screen.getByText('Sound and alert preferences')).toBeInTheDocument()

      expect(screen.getByText('Coding CLIs')).toBeInTheDocument()
      expect(screen.getByText('Providers and defaults for coding sessions')).toBeInTheDocument()

      expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument()
      expect(screen.getByText('Navigation and terminal')).toBeInTheDocument()
    })

    it('renders a terminal preview above Appearance', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const preview = screen.getByTestId('terminal-preview')
      const appearanceHeading = screen.getByText('Appearance')

      expect(preview).toBeInTheDocument()
      expect(preview.compareDocumentPosition(appearanceHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

      const previewLines = within(preview).getAllByTestId('terminal-preview-line')
      expect(previewLines).toHaveLength(8)
    })

    it('orders Sidebar section above Terminal', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const terminalHeading = screen.getByText('Terminal')
      const sidebarHeading = screen.getByText('Sidebar')

      expect(terminalHeading.compareDocumentPosition(sidebarHeading) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    })

    it('orders Devices section after Network Access', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const devicesHeading = screen.getByText('Devices')
      const networkHeading = screen.getByText('Network Access')

      expect(devicesHeading.compareDocumentPosition(networkHeading) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    })

    it('renders all setting labels', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      expect(screen.getByText('Theme')).toBeInTheDocument()
      expect(screen.getByText('UI scale')).toBeInTheDocument()
      expect(screen.getByText('Color scheme')).toBeInTheDocument()

      expect(screen.getByText('Sort mode')).toBeInTheDocument()
      expect(screen.getByText('Show project badges')).toBeInTheDocument()
      expect(screen.getByText('Show subagent sessions')).toBeInTheDocument()
      expect(screen.getByText('Hide sessions by first chat')).toBeInTheDocument()
      expect(screen.getByText('First chat must start with match')).toBeInTheDocument()

      expect(screen.getByText('Font size')).toBeInTheDocument()
      expect(screen.getByText('Line height')).toBeInTheDocument()
      expect(screen.getByText('Scrollback lines')).toBeInTheDocument()
      expect(screen.getByText('Cursor blink')).toBeInTheDocument()
      expect(screen.getByText('Font family')).toBeInTheDocument()

      expect(screen.getByText('Auto-kill idle (minutes)')).toBeInTheDocument()
      expect(screen.getByText('Default working directory')).toBeInTheDocument()

      expect(screen.getByText('Sound on completion')).toBeInTheDocument()

      expect(screen.getByText('Enable Claude CLI')).toBeInTheDocument()
      expect(screen.getByText('Enable Codex CLI')).toBeInTheDocument()
      expect(screen.getByText('Claude CLI permission mode')).toBeInTheDocument()
      expect(screen.getByText('Codex CLI model')).toBeInTheDocument()
      expect(screen.getByText('Codex CLI sandbox')).toBeInTheDocument()
    })
  })

  describe('shows current settings values', () => {
    it('displays current theme selection', () => {
      const store = createSettingsViewStore({ settings: { theme: 'dark' } })
      renderSettingsView(store)

      const darkButtons = screen.getAllByRole('button', { name: 'Dark' })
      expect(darkButtons.length).toBeGreaterThan(0)
      expect(darkButtons[0]).toBeInTheDocument()
    })

    it('displays current font size value', () => {
      const store = createSettingsViewStore({ settings: { terminal: { fontSize: 16 } } })
      renderSettingsView(store)

      expect(screen.getByText('16px (100%)')).toBeInTheDocument()
    })

    it('displays current UI scale value', () => {
      const store = createSettingsViewStore({ settings: { uiScale: 1.5 } })
      renderSettingsView(store)

      expect(screen.getByText('150%')).toBeInTheDocument()
    })

    it('displays current line height value', () => {
      const store = createSettingsViewStore({ settings: { terminal: { lineHeight: 1.4 } } })
      renderSettingsView(store)

      expect(screen.getByText('1.40')).toBeInTheDocument()
    })

    it('displays current scrollback value', () => {
      const store = createSettingsViewStore({ settings: { terminal: { scrollback: 10000 } } })
      renderSettingsView(store)

      expect(screen.getByText('10,000')).toBeInTheDocument()
    })

    it('displays current font family value in dropdown', () => {
      const store = createSettingsViewStore({ settings: { terminal: { fontFamily: 'JetBrains Mono' } } })
      renderSettingsView(store)

      expect(getFontFamilySelect()).toHaveValue('JetBrains Mono')
    })

    it('includes Cascadia and Meslo font options', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const optionValues = Array.from(getFontFamilySelect().querySelectorAll('option')).map((opt) =>
        opt.getAttribute('value'),
      )

      expect(optionValues).toContain('Cascadia Code')
      expect(optionValues).toContain('Cascadia Mono')
      expect(optionValues).toContain('Meslo LG S')
    })

    it('hides fonts that are not installed locally', async () => {
      mockAvailableFonts((font) => {
        if (font.includes('Cascadia Code')) return false
        if (font.includes('Cascadia Mono')) return false
        if (font.includes('Meslo LG S')) return false
        return true
      })

      const store = createSettingsViewStore()
      renderSettingsView(store)

      await act(async () => {
        await document.fonts.ready
      })

      const optionValues = Array.from(getFontFamilySelect().querySelectorAll('option')).map((opt) =>
        opt.getAttribute('value'),
      )
      expect(optionValues).not.toContain('Cascadia Code')
      expect(optionValues).not.toContain('Cascadia Mono')
      expect(optionValues).not.toContain('Meslo LG S')
    })

    it('falls back to monospace when selected font is unavailable', async () => {
      mockAvailableFonts((font) => !font.includes('Cascadia Code'))

      const store = createSettingsViewStore({ settings: { terminal: { fontFamily: 'Cascadia Code' } } })
      renderSettingsView(store)

      await act(async () => {
        await document.fonts.ready
      })

      expect(store.getState().settings.settings.terminal.fontFamily).toBe('monospace')
      expect(localStorage.getItem(LOCAL_TERMINAL_FONT_KEY)).toBe('monospace')
    })

    it('displays sidebar sort mode value', () => {
      const store = createSettingsViewStore({ settings: { sidebar: { sortMode: 'recency' } } })
      renderSettingsView(store)

      expect(screen.getByDisplayValue('Recency')).toBeInTheDocument()
    })

    it('displays safety settings values', () => {
      const store = createSettingsViewStore({ settings: { safety: { autoKillIdleMinutes: 120 } } })
      renderSettingsView(store)

      expect(screen.getByText('120')).toBeInTheDocument()
    })

    it('shows lastSavedAt timestamp when available', () => {
      const savedTime = new Date('2024-01-15T10:30:00').getTime()
      const store = createSettingsViewStore({ settingsState: { lastSavedAt: savedTime } })
      renderSettingsView(store)

      expect(screen.getByText(/Saved/)).toBeInTheDocument()
    })

    it('shows default text when no lastSavedAt', () => {
      const store = createSettingsViewStore({ settingsState: { lastSavedAt: undefined } })
      renderSettingsView(store)

      expect(screen.getByText('Configure your preferences')).toBeInTheDocument()
    })
  })

  describe('theme selector changes theme', () => {
    it('changes theme to light when Light is clicked', () => {
      const store = createSettingsViewStore({ settings: { theme: 'system' } })
      renderSettingsView(store)

      fireEvent.click(screen.getAllByRole('button', { name: 'Light' })[0])
      expect(store.getState().settings.settings.theme).toBe('light')
    })

    it('changes theme to dark when Dark is clicked', () => {
      const store = createSettingsViewStore({ settings: { theme: 'system' } })
      renderSettingsView(store)

      fireEvent.click(screen.getAllByRole('button', { name: 'Dark' })[0])
      expect(store.getState().settings.settings.theme).toBe('dark')
    })

    it('changes theme to system when System is clicked', () => {
      const store = createSettingsViewStore({ settings: { theme: 'dark' } })
      renderSettingsView(store)

      fireEvent.click(screen.getByRole('button', { name: 'System' }))
      expect(store.getState().settings.settings.theme).toBe('system')
    })

    it('schedules API save after theme change', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      fireEvent.click(screen.getAllByRole('button', { name: 'Dark' })[0])

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', { theme: 'dark' })
    })
  })

  describe('font size slider updates value', () => {
    it('updates font size when slider changes', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const fontSizeSlider = getFontSizeSlider()
      fireEvent.change(fontSizeSlider, { target: { value: '18' } })
      fireEvent.pointerUp(fontSizeSlider)

      expect(store.getState().settings.settings.terminal.fontSize).toBe(18)
    })

    it('displays updated font size value', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      fireEvent.change(getFontSizeSlider(), { target: { value: '20' } })
      expect(screen.getByText('20px (125%)')).toBeInTheDocument()
    })

    it('schedules API save after font size change', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const fontSizeSlider = getFontSizeSlider()
      fireEvent.change(fontSizeSlider, { target: { value: '18' } })
      fireEvent.pointerUp(fontSizeSlider)

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        terminal: { fontSize: 18 },
      })
    })
  })

  describe('auto-save behavior', () => {
    it('auto-saves settings after debounce delay', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      fireEvent.click(screen.getAllByRole('button', { name: 'Dark' })[0])
      expect(api.patch).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', { theme: 'dark' })
    })

    it('debounces multiple rapid changes', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      fireEvent.click(screen.getAllByRole('button', { name: 'Dark' })[0])
      await act(async () => {
        vi.advanceTimersByTime(200)
      })

      fireEvent.click(screen.getAllByRole('button', { name: 'Light' })[0])
      await act(async () => {
        vi.advanceTimersByTime(200)
      })

      fireEvent.click(screen.getByRole('button', { name: 'System' }))

      expect(api.patch).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledTimes(1)
      expect(api.patch).toHaveBeenCalledWith('/api/settings', { theme: 'system' })
    })

    it('updates markSaved after successful API call', async () => {
      const store = createSettingsViewStore({ settingsState: { lastSavedAt: undefined } })
      renderSettingsView(store)

      fireEvent.click(screen.getAllByRole('button', { name: 'Dark' })[0])

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      await act(async () => {
        await vi.runAllTimersAsync()
      })

      expect(store.getState().settings.lastSavedAt).toBeDefined()
    })
  })

  describe('unmount and isolation', () => {
    it('updates store immediately on change', () => {
      const store = createSettingsViewStore({ settings: { theme: 'system' } })
      renderSettingsView(store)

      fireEvent.click(screen.getAllByRole('button', { name: 'Dark' })[0])
      expect(store.getState().settings.settings.theme).toBe('dark')
    })

    it('does not save if component unmounts before debounce', async () => {
      const store = createSettingsViewStore()
      const { unmount } = renderSettingsView(store)

      fireEvent.click(screen.getAllByRole('button', { name: 'Dark' })[0])
      unmount()

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).not.toHaveBeenCalled()
    })

    it('each test gets fresh component state', () => {
      const store1 = createSettingsViewStore({ settings: { theme: 'dark' } })
      const { unmount } = renderSettingsView(store1)
      expect(store1.getState().settings.settings.theme).toBe('dark')
      unmount()

      const store2 = createSettingsViewStore({ settings: { theme: 'light' } })
      renderSettingsView(store2)
      expect(store2.getState().settings.settings.theme).toBe('light')
    })

    it('API mocks are reset between tests', () => {
      expect(api.patch).not.toHaveBeenCalled()
      expect(defaultSettings.theme).toBe('system')
    })
  })
})

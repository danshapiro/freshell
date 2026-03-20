import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { defaultSettings } from '@/store/settingsSlice'
import {
  createSettingsViewStore,
  installSettingsViewHooks,
  mockAvailableFonts,
  renderSettingsView,
  switchSettingsTab,
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

    it('renders tab buttons for all sections', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      expect(screen.getByRole('tab', { name: 'Appearance' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Workspace' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Safety' })).toBeInTheDocument()
      expect(screen.getByRole('tab', { name: 'Advanced' })).toBeInTheDocument()
    })

    it('shows Appearance tab content by default', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      expect(screen.getByTestId('terminal-preview')).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument()
      expect(screen.getByText('Theme and visual preferences')).toBeInTheDocument()

      const previewLines = within(screen.getByTestId('terminal-preview')).getAllByTestId('terminal-preview-line')
      expect(previewLines).toHaveLength(8)
    })

    it('switches to Workspace tab on click', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }))

      expect(screen.getByRole('heading', { name: 'Sidebar' })).toBeInTheDocument()
      expect(screen.getByText('Session list and navigation')).toBeInTheDocument()
      expect(screen.getByText('Notifications')).toBeInTheDocument()
      expect(screen.queryByTestId('terminal-preview')).not.toBeInTheDocument()
    })

    it('switches to Safety tab on click', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      fireEvent.click(screen.getByRole('tab', { name: 'Safety' }))

      expect(screen.getByRole('heading', { name: 'Safety' })).toBeInTheDocument()
      expect(screen.getByText('Network Access')).toBeInTheDocument()
      expect(screen.getByText('Devices')).toBeInTheDocument()
    })

    it('switches to Advanced tab on click', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }))

      expect(screen.getByRole('heading', { name: 'Advanced' })).toBeInTheDocument()
      expect(screen.getByText('Terminal internals and debugging')).toBeInTheDocument()
    })

    it('renders Appearance tab setting labels', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      expect(screen.getByText('Theme')).toBeInTheDocument()
      expect(screen.getByText('UI scale')).toBeInTheDocument()
      expect(screen.getByText('Color scheme')).toBeInTheDocument()
      expect(screen.getByText('Font size')).toBeInTheDocument()
      expect(screen.getByText('Line height')).toBeInTheDocument()
      expect(screen.getByText('Cursor blink')).toBeInTheDocument()
      expect(screen.getByText('Font family')).toBeInTheDocument()
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
      switchSettingsTab('Advanced')

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
      expect(localStorage.length).toBe(0)
    })

    it('displays sidebar sort mode value', () => {
      const store = createSettingsViewStore({ settings: { sidebar: { sortMode: 'recency' } } })
      renderSettingsView(store)
      switchSettingsTab('Workspace')

      expect(screen.getByDisplayValue('Recency')).toBeInTheDocument()
    })

    it('displays safety settings values', () => {
      const store = createSettingsViewStore({ settings: { safety: { autoKillIdleMinutes: 120 } } })
      renderSettingsView(store)
      switchSettingsTab('Safety')

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

    it('keeps theme changes local without calling /api/settings', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      fireEvent.click(screen.getAllByRole('button', { name: 'Dark' })[0])

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).not.toHaveBeenCalled()
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

    it('keeps font size changes local without calling /api/settings', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const fontSizeSlider = getFontSizeSlider()
      fireEvent.change(fontSizeSlider, { target: { value: '18' } })
      fireEvent.pointerUp(fontSizeSlider)

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).not.toHaveBeenCalled()
    })
  })

  describe('local-only change behavior', () => {
    it('does not schedule /api/settings after debounce for theme changes', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      fireEvent.click(screen.getAllByRole('button', { name: 'Dark' })[0])
      expect(api.patch).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).not.toHaveBeenCalled()
    })

    it('keeps only the latest local theme change without calling /api/settings', async () => {
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

      expect(store.getState().settings.settings.theme).toBe('system')
      expect(api.patch).not.toHaveBeenCalled()
    })

    it('does not update lastSavedAt for local-only changes', async () => {
      const store = createSettingsViewStore({ settingsState: { lastSavedAt: undefined } })
      renderSettingsView(store)

      fireEvent.click(screen.getAllByRole('button', { name: 'Dark' })[0])

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      await act(async () => {
        await vi.runAllTimersAsync()
      })

      expect(store.getState().settings.lastSavedAt).toBeUndefined()
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

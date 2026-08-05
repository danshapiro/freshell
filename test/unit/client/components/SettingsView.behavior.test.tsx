import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { DEVICE_DISMISSED_STORAGE_KEY } from '@/store/storage-keys'
import {
  createSettingsViewStore,
  createTabRegistryState,
  installSettingsViewHooks,
  makeRegistryRecord,
  renderSettingsView,
  switchSettingsTab,
} from './settings-view-test-utils'

vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({ valid: true }),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

import { api } from '@/lib/api'

installSettingsViewHooks({ fakeTimers: true, mockFonts: true })

function getSelect(predicate: (select: HTMLSelectElement) => boolean) {
  return screen.getAllByRole('combobox').find((select) => predicate(select as HTMLSelectElement)) as HTMLSelectElement
}

function getSlider(predicate: (slider: HTMLElement) => boolean) {
  return screen.getAllByRole('slider').find((slider) => predicate(slider))!
}

function getSettingsSection(title: string) {
  const heading = screen.getByRole('heading', { name: title })
  const section = heading.parentElement?.parentElement
  if (!section) {
    throw new Error(`Could not find settings section for "${title}"`)
  }
  return section
}

describe('SettingsView behavior sections', () => {
  describe('additional settings interactions', () => {
    it('updates terminal theme locally without calling /api/settings', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const terminalThemeSelect = getSelect((select) => select.querySelector('option[value="auto"]') !== null)
      fireEvent.change(terminalThemeSelect, { target: { value: 'one-dark' } })

      expect(store.getState().settings.settings.terminal.theme).toBe('one-dark')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).not.toHaveBeenCalled()
    })

    it('updates UI scale slider', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const uiScaleSlider = screen.getByRole('slider', { name: 'UI scale' })

      fireEvent.change(uiScaleSlider, { target: { value: '33' } })
      fireEvent.pointerUp(uiScaleSlider)

      expect(store.getState().settings.settings.uiScale).toBe(4)
      const spinbutton = screen.getByRole('spinbutton', { name: 'UI scale' }) as HTMLInputElement
      expect(spinbutton.value).toBe('400')
    })

    it('commits keyboard-only slider changes across the 200% boundary', () => {
      const store = createSettingsViewStore({ settings: { uiScale: 2.0 } })
      renderSettingsView(store)

      const uiScaleSlider = screen.getByRole('slider', { name: 'UI scale' })

      // No pointer events: keyboard changes must commit immediately.
      fireEvent.change(uiScaleSlider, { target: { value: '26' } })

      expect(store.getState().settings.settings.uiScale).toBe(2.25)
    })

    it('clamps numeric UI scale input to the supported range without calling /api/settings', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const uiScaleInput = screen.getByRole('spinbutton', { name: 'UI scale' })

      fireEvent.change(uiScaleInput, { target: { value: '999' } })
      fireEvent.blur(uiScaleInput)
      expect(store.getState().settings.settings.uiScale).toBe(4)

      fireEvent.change(uiScaleInput, { target: { value: '50' } })
      fireEvent.keyDown(uiScaleInput, { key: 'Enter' })
      expect(store.getState().settings.settings.uiScale).toBe(0.75)

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).not.toHaveBeenCalled()
    })

    it('commits typed off-list UI scale percentages without snapping', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const uiScaleInput = screen.getByRole('spinbutton', { name: 'UI scale' })

      fireEvent.change(uiScaleInput, { target: { value: '137' } })
      fireEvent.blur(uiScaleInput)

      expect(store.getState().settings.settings.uiScale).toBeCloseTo(1.37)
    })

    it('ignores invalid numeric UI scale input', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)
      const initialUiScale = store.getState().settings.settings.uiScale

      const uiScaleInput = screen.getByRole('spinbutton', { name: 'UI scale' })

      fireEvent.change(uiScaleInput, { target: { value: 'abc' } })
      fireEvent.blur(uiScaleInput)

      expect(store.getState().settings.settings.uiScale).toBe(initialUiScale)
    })

    it('commits an exact 400% entry from the direct UI scale percentage input', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const uiScaleInput = screen.getByRole('spinbutton', { name: 'UI scale' }) as HTMLInputElement
      const uiScaleSlider = screen.getByRole('slider', { name: 'UI scale' }) as HTMLInputElement

      // The direct percentage input advertises the 75%-400% bounds to the browser.
      expect(uiScaleInput.getAttribute('min')).toBe('75')
      expect(uiScaleInput.getAttribute('max')).toBe('400')

      fireEvent.change(uiScaleInput, { target: { value: '400' } })
      fireEvent.keyDown(uiScaleInput, { key: 'Enter' })

      expect(store.getState().settings.settings.uiScale).toBe(4)
      expect(uiScaleInput.value).toBe('400')
      expect(uiScaleSlider.value).toBe('33')
      expect(uiScaleSlider.getAttribute('aria-valuetext')).toBe('400%')
    })

    it('keeps the UI scale controls focusable and keyboard-operable at 400%', () => {
      const store = createSettingsViewStore({ settings: { uiScale: 4 } })
      renderSettingsView(store)

      const uiScaleSlider = screen.getByRole('slider', { name: 'UI scale' }) as HTMLInputElement
      const uiScaleInput = screen.getByRole('spinbutton', { name: 'UI scale' }) as HTMLInputElement

      // Both controls stay enabled and reachable via keyboard focus at 400%.
      expect(uiScaleSlider).not.toBeDisabled()
      expect(uiScaleInput).not.toBeDisabled()
      uiScaleSlider.focus()
      expect(document.activeElement).toBe(uiScaleSlider)
      uiScaleInput.focus()
      expect(document.activeElement).toBe(uiScaleInput)

      // The slider sits on the 400% stop and announces it.
      expect(uiScaleSlider.value).toBe('33')
      expect(uiScaleSlider.getAttribute('aria-valuetext')).toBe('400%')

      // Keyboard-style changes (no active pointer) commit immediately in both
      // directions from the 400% ceiling.
      fireEvent.change(uiScaleSlider, { target: { value: '32' } })
      expect(store.getState().settings.settings.uiScale).toBe(3.75)
      expect(uiScaleSlider.getAttribute('aria-valuetext')).toBe('375%')
      expect(uiScaleInput.value).toBe('375')

      fireEvent.change(uiScaleSlider, { target: { value: '33' } })
      expect(store.getState().settings.settings.uiScale).toBe(4)
      expect(uiScaleSlider.getAttribute('aria-valuetext')).toBe('400%')
    })

    it('updates font size slider to the max stop', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const fontSizeSlider = screen.getByRole('slider', { name: 'Font size' })

      // Index 32 is the last stop -> 64px.
      fireEvent.change(fontSizeSlider, { target: { value: '32' } })
      fireEvent.pointerUp(fontSizeSlider)

      expect(store.getState().settings.settings.terminal.fontSize).toBe(64)
      const spinbutton = screen.getByRole('spinbutton', { name: 'Font size' }) as HTMLInputElement
      expect(spinbutton.value).toBe('64')
    })

    it('commits keyboard-only font size changes across the 32px boundary', () => {
      const store = createSettingsViewStore({ settings: { terminal: { fontSize: 32 } } })
      renderSettingsView(store)

      const fontSizeSlider = screen.getByRole('slider', { name: 'Font size' })

      // No pointer events: keyboard changes must commit immediately. Index 21 -> 34px.
      fireEvent.change(fontSizeSlider, { target: { value: '21' } })

      expect(store.getState().settings.settings.terminal.fontSize).toBe(34)
    })

    it('clamps numeric font size input to the supported range without calling /api/settings', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const fontSizeInput = screen.getByRole('spinbutton', { name: 'Font size' })

      fireEvent.change(fontSizeInput, { target: { value: '999' } })
      fireEvent.blur(fontSizeInput)
      expect(store.getState().settings.settings.terminal.fontSize).toBe(64)

      fireEvent.change(fontSizeInput, { target: { value: '8' } })
      fireEvent.keyDown(fontSizeInput, { key: 'Enter' })
      expect(store.getState().settings.settings.terminal.fontSize).toBe(12)

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).not.toHaveBeenCalled()
    })

    it('commits typed off-list font sizes without snapping', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const fontSizeInput = screen.getByRole('spinbutton', { name: 'Font size' })

      fireEvent.change(fontSizeInput, { target: { value: '33' } })
      fireEvent.blur(fontSizeInput)

      expect(store.getState().settings.settings.terminal.fontSize).toBe(33)
      // Slider renders the nearest stop; the 32-vs-34 tie resolves to the lower index (20).
      const fontSizeSlider = screen.getByRole('slider', { name: 'Font size' }) as HTMLInputElement
      expect(fontSizeSlider.value).toBe('20')
      expect(fontSizeSlider.getAttribute('aria-valuetext')).toBe('33px (206%)')
    })

    it('ignores invalid numeric font size input', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)
      const initialFontSize = store.getState().settings.settings.terminal.fontSize

      const fontSizeInput = screen.getByRole('spinbutton', { name: 'Font size' })

      fireEvent.change(fontSizeInput, { target: { value: 'abc' } })
      fireEvent.blur(fontSizeInput)

      expect(store.getState().settings.settings.terminal.fontSize).toBe(initialFontSize)
    })

    it('commits an exact 64px entry from the direct font size input', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const fontSizeInput = screen.getByRole('spinbutton', { name: 'Font size' }) as HTMLInputElement
      const fontSizeSlider = screen.getByRole('slider', { name: 'Font size' }) as HTMLInputElement

      // The direct px input advertises the 12px-64px bounds to the browser.
      expect(fontSizeInput.getAttribute('min')).toBe('12')
      expect(fontSizeInput.getAttribute('max')).toBe('64')

      fireEvent.change(fontSizeInput, { target: { value: '64' } })
      fireEvent.keyDown(fontSizeInput, { key: 'Enter' })

      expect(store.getState().settings.settings.terminal.fontSize).toBe(64)
      expect(fontSizeInput.value).toBe('64')
      // Index 32 is the last stop (64px) on the slider's stops list.
      expect(fontSizeSlider.value).toBe('32')
      expect(fontSizeSlider.getAttribute('aria-valuetext')).toBe('64px (400%)')
      // The terminal preview re-renders at the newly entered size.
      expect(screen.getByLabelText('Terminal preview').style.fontSize).toBe('64px')
    })

    it('rounds fractional direct font size input to the nearest pixel, never past 64', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const fontSizeInput = screen.getByRole('spinbutton', { name: 'Font size' })

      fireEvent.change(fontSizeInput, { target: { value: '30.5' } })
      fireEvent.blur(fontSizeInput)
      expect(store.getState().settings.settings.terminal.fontSize).toBe(31)

      // Rounding can land above the ceiling; the 64px clamp still wins.
      fireEvent.change(fontSizeInput, { target: { value: '64.5' } })
      fireEvent.keyDown(fontSizeInput, { key: 'Enter' })
      expect(store.getState().settings.settings.terminal.fontSize).toBe(64)
    })

    it('discards the typed font size draft on Escape', () => {
      const store = createSettingsViewStore({ settings: { terminal: { fontSize: 18 } } })
      renderSettingsView(store)

      const fontSizeInput = screen.getByRole('spinbutton', { name: 'Font size' }) as HTMLInputElement
      expect(fontSizeInput.value).toBe('18')

      fireEvent.change(fontSizeInput, { target: { value: '40' } })
      expect(fontSizeInput.value).toBe('40')

      fireEvent.keyDown(fontSizeInput, { key: 'Escape' })
      fireEvent.blur(fontSizeInput)

      expect(store.getState().settings.settings.terminal.fontSize).toBe(18)
      expect(fontSizeInput.value).toBe('18')
    })

    it('updates sidebar sort mode locally without calling /api/settings', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)
      switchSettingsTab('Workspace')

      const sortModeSelect = getSelect((select) => {
        return select.querySelector('option[value="activity"]') !== null
          && select.querySelector('option[value="recency"]') !== null
          && select.querySelector('option[value="project"]') !== null
      })

      expect(sortModeSelect.querySelector('option[value="hybrid"]')).toBeNull()
      expect(sortModeSelect.querySelector('option[value="activity"]')?.textContent).toBe('Activity (tabs first)')

      fireEvent.change(sortModeSelect, { target: { value: 'activity' } })

      expect(store.getState().settings.settings.sidebar.sortMode).toBe('activity')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).not.toHaveBeenCalled()
    })

    it('updates sidebar sort mode to recency-pinned locally without calling /api/settings', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)
      switchSettingsTab('Workspace')

      const sortModeSelect = getSelect((select) => {
        return select.querySelector('option[value="recency-pinned"]') !== null
      })

      expect(sortModeSelect.querySelector('option[value="recency-pinned"]')?.textContent).toBe('Recency (tabs first)')
      fireEvent.change(sortModeSelect, { target: { value: 'recency-pinned' } })

      expect(store.getState().settings.settings.sidebar.sortMode).toBe('recency-pinned')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).not.toHaveBeenCalled()
    })

    it('toggles show project badges', () => {
      const store = createSettingsViewStore({ settings: { sidebar: { showProjectBadges: true } } })
      renderSettingsView(store)
      switchSettingsTab('Workspace')

      const showBadgesRow = screen.getByText('Show project badges').closest('div')
      const showBadgesToggle = within(showBadgesRow!).getByRole('switch')
      fireEvent.click(showBadgesToggle)

      expect(store.getState().settings.settings.sidebar.showProjectBadges).toBe(false)
    })

    it('debounces sidebar first-chat exclusion substring saves and sends the latest value', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)
      switchSettingsTab('Workspace')

      const textarea = screen.getByLabelText('Sidebar first chat exclusion substrings')
      fireEvent.change(textarea, { target: { value: '__AUTO__' } })
      fireEvent.change(textarea, { target: { value: '__AUTO__\ncanary' } })

      expect(store.getState().settings.settings.sidebar.excludeFirstChatSubstrings).toEqual(['__AUTO__', 'canary'])

      expect(api.patch).not.toHaveBeenCalled()

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledTimes(1)
      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        sidebar: { excludeFirstChatSubstrings: ['__AUTO__', 'canary'] },
      })
    })

    it('toggles first-chat must-start matching', async () => {
      const store = createSettingsViewStore({
        settings: {
          sidebar: {
            excludeFirstChatMustStart: false,
          },
        },
      })
      renderSettingsView(store)
      switchSettingsTab('Workspace')

      const row = screen.getByText('First chat must start with match').closest('div')
      const toggle = within(row!).getByRole('switch')
      fireEvent.click(toggle)

      expect(store.getState().settings.settings.sidebar.excludeFirstChatMustStart).toBe(true)

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        sidebar: { excludeFirstChatMustStart: true },
      })
    })

    it('toggles notification sound locally without calling /api/settings', async () => {
      const store = createSettingsViewStore({
        settings: {
          notifications: { soundEnabled: true },
        },
      })
      renderSettingsView(store)
      switchSettingsTab('Panes')

      const soundRow = screen.getByText('Sound on completion').closest('div')
      const soundToggle = within(soundRow!).getByRole('switch')
      fireEvent.click(soundToggle)

      expect(store.getState().settings.settings.notifications.soundEnabled).toBe(false)

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).not.toHaveBeenCalled()
    })

    it('toggles cursor blink locally without calling /api/settings', async () => {
      const store = createSettingsViewStore({
        settings: {
          terminal: { cursorBlink: true },
        },
      })
      renderSettingsView(store)

      const cursorBlinkRow = screen.getByText('Cursor blink').closest('div')
      const cursorBlinkToggle = within(cursorBlinkRow!).getByRole('switch')
      fireEvent.click(cursorBlinkToggle)

      expect(store.getState().settings.settings.terminal.cursorBlink).toBe(false)

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).not.toHaveBeenCalled()
    })

    it('toggles debug logging', async () => {
      const store = createSettingsViewStore({
        settings: {
          logging: { debug: false },
        },
      })
      renderSettingsView(store)
      switchSettingsTab('Advanced')

      const debugRow = screen.getByText('Debug logging').closest('div')
      const debugToggle = within(debugRow!).getByRole('switch')
      fireEvent.click(debugToggle)

      expect(store.getState().settings.settings.logging.debug).toBe(true)

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        logging: { debug: true },
      })
    })

    it('updates line height slider', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const lineHeightSlider = getSlider((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        const step = slider.getAttribute('step')
        return min === '1' && max === '1.8' && step === '0.05'
      })

      fireEvent.change(lineHeightSlider, { target: { value: '1.5' } })
      fireEvent.pointerUp(lineHeightSlider)

      expect(store.getState().settings.settings.terminal.lineHeight).toBe(1.5)
    })

    it('updates scrollback slider', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)
      switchSettingsTab('Advanced')

      const scrollbackSlider = getSlider((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        return min === '1000' && max === '20000'
      })

      fireEvent.change(scrollbackSlider, { target: { value: '15000' } })
      fireEvent.pointerUp(scrollbackSlider)

      expect(store.getState().settings.settings.terminal.scrollback).toBe(15000)
    })

    it('updates font family from dropdown', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const fontFamilySelect = getSelect((select) => {
        return select.querySelector('option[value="JetBrains Mono"]') !== null
      })

      fireEvent.change(fontFamilySelect, { target: { value: 'Cascadia Code' } })

      expect(store.getState().settings.settings.terminal.fontFamily).toBe('Cascadia Code')
      expect(localStorage.length).toBe(0)

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).not.toHaveBeenCalled()
    })

    it('displays current font family in dropdown', () => {
      const store = createSettingsViewStore({
        settings: {
          terminal: { fontFamily: 'Fira Code' },
        },
      })
      renderSettingsView(store)

      const fontFamilySelect = getSelect((select) => {
        return select.querySelector('option[value="JetBrains Mono"]') !== null
      })

      expect(fontFamilySelect).toHaveValue('Fira Code')
    })

    it('updates auto-kill idle minutes slider', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)
      switchSettingsTab('Advanced')

      const autoKillSlider = getSlider((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        return min === '5' && max === '720'
      })

      fireEvent.change(autoKillSlider, { target: { value: '300' } })
      fireEvent.pointerUp(autoKillSlider)

      expect(store.getState().settings.settings.safety.autoKillIdleMinutes).toBe(300)
    })

    it('validates default working directory before saving', async () => {
      vi.mocked(api.post).mockResolvedValue({ valid: true })
      const store = createSettingsViewStore()
      renderSettingsView(store)
      switchSettingsTab('Advanced')

      const cwdInput = screen.getByPlaceholderText('e.g. C:\\Users\\you\\projects')
      fireEvent.change(cwdInput, { target: { value: '/home/user/projects' } })

      expect(store.getState().settings.settings.defaultCwd).toBeUndefined()

      await act(async () => {
        vi.advanceTimersByTime(500)
        await Promise.resolve()
        vi.advanceTimersByTime(500)
      })

      expect(api.post).toHaveBeenCalledWith('/api/files/validate-dir', {
        path: '/home/user/projects',
      })
      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        defaultCwd: '/home/user/projects',
      })
      expect(store.getState().settings.settings.defaultCwd).toBe('/home/user/projects')
    })

    it('shows an error and clears default when directory is not found', async () => {
      vi.mocked(api.post).mockResolvedValue({ valid: false })
      const store = createSettingsViewStore({
        settings: { defaultCwd: '/some/path' },
      })
      renderSettingsView(store)
      switchSettingsTab('Advanced')

      const cwdInput = screen.getByDisplayValue('/some/path')
      fireEvent.change(cwdInput, { target: { value: '/missing/path' } })

      expect(store.getState().settings.settings.defaultCwd).toBe('/some/path')

      await act(async () => {
        vi.advanceTimersByTime(500)
        await Promise.resolve()
        vi.advanceTimersByTime(500)
      })

      expect(api.post).toHaveBeenCalledWith('/api/files/validate-dir', {
        path: '/missing/path',
      })
      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        defaultCwd: '',
      })
      expect(store.getState().settings.settings.defaultCwd).toBeUndefined()
      expect(screen.getByText('directory not found')).toBeInTheDocument()
    })

    it('clears default working directory when input is emptied', async () => {
      const store = createSettingsViewStore({
        settings: { defaultCwd: '/some/path' },
      })
      renderSettingsView(store)
      switchSettingsTab('Advanced')

      const cwdInput = screen.getByDisplayValue('/some/path')
      fireEvent.change(cwdInput, { target: { value: '' } })

      expect(store.getState().settings.settings.defaultCwd).toBe('/some/path')

      await act(async () => {
        vi.advanceTimersByTime(500)
        await Promise.resolve()
        vi.advanceTimersByTime(500)
      })

      expect(api.post).not.toHaveBeenCalled()
      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        defaultCwd: '',
      })
      expect(store.getState().settings.settings.defaultCwd).toBeUndefined()
    })
  })

  describe('keyboard shortcuts section', () => {
    it('displays keyboard shortcuts from the shared registry', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)
      switchSettingsTab('Workspace')

      const keyboardShortcuts = within(getSettingsSection('Keyboard shortcuts'))

      expect(keyboardShortcuts.getByText('New tab')).toBeInTheDocument()
      expect(keyboardShortcuts.getByText('Close tab')).toBeInTheDocument()
      expect(keyboardShortcuts.getByText('Previous tab')).toBeInTheDocument()
      expect(keyboardShortcuts.getByText('Next tab')).toBeInTheDocument()
      expect(keyboardShortcuts.getByText('Newline')).toBeInTheDocument()
    })

    it('displays keyboard shortcut keys', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)
      switchSettingsTab('Workspace')

      const keyboardShortcuts = within(getSettingsSection('Keyboard shortcuts'))

      expect(keyboardShortcuts.getAllByText('Alt').length).toBeGreaterThan(0)
      expect(keyboardShortcuts.getAllByText('Ctrl').length).toBeGreaterThan(0)
      expect(keyboardShortcuts.getAllByText('Shift').length).toBeGreaterThan(0)
      expect(keyboardShortcuts.getAllByText('[').length).toBeGreaterThan(0)
      expect(keyboardShortcuts.getAllByText(']').length).toBeGreaterThan(0)
    })
  })

  describe('Devices section', () => {
    it('deletes a remote device row and persists dismissed device ids', async () => {
      const store = createSettingsViewStore({
        extraPreloadedState: {
          tabRegistry: createTabRegistryState({
            remoteOpen: [
              makeRegistryRecord({ deviceId: 'remote-a', deviceLabel: 'studio-mac', tabKey: 'remote-a:tab-1' }),
            ],
            devices: [
              { deviceId: 'remote-a', deviceLabel: 'studio-mac', lastSeenAt: 10 },
              { deviceId: 'remote-b', deviceLabel: 'studio-mac', lastSeenAt: 5 },
            ],
            closed: [
              makeRegistryRecord({
                deviceId: 'remote-b',
                deviceLabel: 'studio-mac',
                tabKey: 'remote-b:tab-2',
                tabId: 'tab-2',
                status: 'closed',
                closedAt: 5,
                updatedAt: 5,
              }),
            ],
          }),
        },
      })
      renderSettingsView(store)
      switchSettingsTab('Advanced')

      expect(screen.getAllByLabelText('Device name for studio-mac')).toHaveLength(2)

      fireEvent.click(screen.getAllByRole('button', { name: 'Delete device studio-mac' })[0])

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getAllByLabelText('Device name for studio-mac')).toHaveLength(1)
      expect(JSON.parse(localStorage.getItem(DEVICE_DISMISSED_STORAGE_KEY) || '[]')).toEqual(['remote-a'])
    })
  })
})

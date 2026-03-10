import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { DEVICE_DISMISSED_STORAGE_KEY } from '@/store/storage-keys'
import { LOCAL_TERMINAL_FONT_KEY } from '@/lib/terminal-fonts'
import {
  createSettingsViewStore,
  createTabRegistryState,
  installSettingsViewHooks,
  makeRegistryRecord,
  renderSettingsView,
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

describe('SettingsView behavior sections', () => {
  describe('additional settings interactions', () => {
    it('updates terminal theme', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const terminalThemeSelect = getSelect((select) => select.querySelector('option[value="auto"]') !== null)
      fireEvent.change(terminalThemeSelect, { target: { value: 'one-dark' } })

      expect(store.getState().settings.settings.terminal.theme).toBe('one-dark')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        terminal: { theme: 'one-dark' },
      })
    })

    it('updates UI scale slider', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const uiScaleSlider = getSlider((slider) => {
        const min = slider.getAttribute('min')
        const step = slider.getAttribute('step')
        return min === '0.75' && step === '0.05'
      })

      fireEvent.change(uiScaleSlider, { target: { value: '1.5' } })
      fireEvent.pointerUp(uiScaleSlider)

      expect(store.getState().settings.settings.uiScale).toBe(1.5)
      expect(screen.getByText('150%')).toBeInTheDocument()
    })

    it('updates sidebar sort mode', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

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

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        sidebar: { sortMode: 'activity' },
      })
    })

    it('updates sidebar sort mode to recency-pinned', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const sortModeSelect = getSelect((select) => {
        return select.querySelector('option[value="recency-pinned"]') !== null
      })

      expect(sortModeSelect.querySelector('option[value="recency-pinned"]')?.textContent).toBe('Recency (pinned)')
      fireEvent.change(sortModeSelect, { target: { value: 'recency-pinned' } })

      expect(store.getState().settings.settings.sidebar.sortMode).toBe('recency-pinned')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        sidebar: { sortMode: 'recency-pinned' },
      })
    })

    it('toggles show project badges', () => {
      const store = createSettingsViewStore({ settings: { sidebar: { showProjectBadges: true } } })
      renderSettingsView(store)

      const showBadgesRow = screen.getByText('Show project badges').closest('div')
      const showBadgesToggle = within(showBadgesRow!).getByRole('switch')
      fireEvent.click(showBadgesToggle)

      expect(store.getState().settings.settings.sidebar.showProjectBadges).toBe(false)
    })

    it('updates sidebar first-chat exclusion substrings', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const textarea = screen.getByLabelText('Sidebar first chat exclusion substrings')
      fireEvent.change(textarea, { target: { value: '__AUTO__\ncanary' } })

      expect(store.getState().settings.settings.sidebar.excludeFirstChatSubstrings).toEqual(['__AUTO__', 'canary'])

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

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

    it('toggles notification sound', async () => {
      const store = createSettingsViewStore({
        settings: {
          notifications: { soundEnabled: true },
        },
      })
      renderSettingsView(store)

      const soundRow = screen.getByText('Sound on completion').closest('div')
      const soundToggle = within(soundRow!).getByRole('switch')
      fireEvent.click(soundToggle)

      expect(store.getState().settings.settings.notifications.soundEnabled).toBe(false)

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        notifications: { soundEnabled: false },
      })
    })

    it('toggles cursor blink', async () => {
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

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        terminal: { cursorBlink: false },
      })
    })

    it('toggles debug logging', async () => {
      const store = createSettingsViewStore({
        settings: {
          logging: { debug: false },
        },
      })
      renderSettingsView(store)

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

    it('toggles codex provider enabled state', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const row = screen.getByText('Enable Codex CLI').closest('div')!
      const toggle = row.querySelector('button')!
      fireEvent.click(toggle)

      expect(store.getState().settings.settings.codingCli.enabledProviders).not.toContain('codex')
    })

    it('updates codex model input', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const input = screen.getByPlaceholderText('e.g. gpt-5-codex')
      fireEvent.change(input, { target: { value: 'gpt-5-codex' } })

      expect(store.getState().settings.settings.codingCli.providers.codex?.model).toBe('gpt-5-codex')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        codingCli: { providers: { codex: { model: 'gpt-5-codex' } } },
      })
    })

    it('updates codex sandbox select', async () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const sandboxSelect = getSelect((select) => {
        return select.querySelector('option[value="workspace-write"]') !== null
      })

      fireEvent.change(sandboxSelect, { target: { value: 'workspace-write' } })

      expect(store.getState().settings.settings.codingCli.providers.codex?.sandbox).toBe('workspace-write')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        codingCli: { providers: { codex: { sandbox: 'workspace-write' } } },
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
      expect(localStorage.getItem(LOCAL_TERMINAL_FONT_KEY)).toBe('Cascadia Code')

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

      const autoKillSlider = getSlider((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        return min === '10' && max === '720'
      })

      fireEvent.change(autoKillSlider, { target: { value: '300' } })
      fireEvent.pointerUp(autoKillSlider)

      expect(store.getState().settings.settings.safety.autoKillIdleMinutes).toBe(300)
    })

    it('validates default working directory before saving', async () => {
      vi.mocked(api.post).mockResolvedValue({ valid: true })
      const store = createSettingsViewStore()
      renderSettingsView(store)

      const cwdInput = screen.getByPlaceholderText('e.g. C:\\Users\\you\\projects')
      fireEvent.change(cwdInput, { target: { value: '/home/user/projects' } })

      expect(store.getState().settings.settings.defaultCwd).toBeUndefined()

      await act(async () => {
        vi.advanceTimersByTime(500)
        await Promise.resolve()
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

      const cwdInput = screen.getByDisplayValue('/some/path')
      fireEvent.change(cwdInput, { target: { value: '/missing/path' } })

      expect(store.getState().settings.settings.defaultCwd).toBe('/some/path')

      await act(async () => {
        vi.advanceTimersByTime(500)
        await Promise.resolve()
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

      const cwdInput = screen.getByDisplayValue('/some/path')
      fireEvent.change(cwdInput, { target: { value: '' } })

      expect(store.getState().settings.settings.defaultCwd).toBe('/some/path')

      await act(async () => {
        vi.advanceTimersByTime(500)
        await Promise.resolve()
      })

      expect(api.post).not.toHaveBeenCalled()
      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        defaultCwd: '',
      })
      expect(store.getState().settings.settings.defaultCwd).toBeUndefined()
    })
  })

  describe('keyboard shortcuts section', () => {
    it('displays keyboard shortcuts', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      expect(screen.getByText('Previous tab')).toBeInTheDocument()
      expect(screen.getByText('Next tab')).toBeInTheDocument()
      expect(screen.getByText('Newline (same as Ctrl+J)')).toBeInTheDocument()
      expect(screen.getByText('Newline')).toBeInTheDocument()
    })

    it('displays keyboard shortcut keys', () => {
      const store = createSettingsViewStore()
      renderSettingsView(store)

      expect(screen.getAllByText('Ctrl').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Shift').length).toBeGreaterThan(0)
      expect(screen.getByText('[')).toBeInTheDocument()
      expect(screen.getByText(']')).toBeInTheDocument()
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

      expect(screen.getAllByLabelText('Device name for studio-mac')).toHaveLength(1)

      fireEvent.click(screen.getByRole('button', { name: 'Delete device studio-mac' }))

      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.queryByLabelText('Device name for studio-mac')).not.toBeInTheDocument()
      expect(JSON.parse(localStorage.getItem(DEVICE_DISMISSED_STORAGE_KEY) || '[]').sort()).toEqual(['remote-a', 'remote-b'])
    })
  })
})

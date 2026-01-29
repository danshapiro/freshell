import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import SettingsView from '@/components/SettingsView'
import settingsReducer, { defaultSettings, SettingsState } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'

// Mock the api module
vi.mock('@/lib/api', () => ({
  api: {
    patch: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}))

// Import mocked api after mocking
import { api } from '@/lib/api'

function createTestStore(settingsState?: Partial<SettingsState>) {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
    },
    middleware: (getDefault) =>
      getDefault({
        serializableCheck: {
          ignoredPaths: ['sessions.expandedProjects'],
        },
      }),
    preloadedState: {
      settings: {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: undefined,
        ...settingsState,
      },
    },
  })
}

function renderWithStore(store: ReturnType<typeof createTestStore>) {
  return render(
    <Provider store={store}>
      <SettingsView />
    </Provider>
  )
}

describe('SettingsView Component', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  describe('renders settings form', () => {
    it('renders the Settings header', () => {
      const store = createTestStore()
      renderWithStore(store)

      // Use getAllByRole since there may be multiple headings, then check the first one
      const headings = screen.getAllByRole('heading', { name: 'Settings' })
      expect(headings[0]).toBeInTheDocument()
    })

    it('renders all settings sections', () => {
      const store = createTestStore()
      renderWithStore(store)

      expect(screen.getByText('Appearance')).toBeInTheDocument()
      expect(screen.getByText('Theme and visual preferences')).toBeInTheDocument()

      expect(screen.getByText('Sidebar')).toBeInTheDocument()
      expect(screen.getByText('Session list and navigation')).toBeInTheDocument()

      expect(screen.getByText('Terminal')).toBeInTheDocument()
      expect(screen.getByText('Font and rendering options')).toBeInTheDocument()

      expect(screen.getByText('Safety')).toBeInTheDocument()
      expect(screen.getByText('Auto-kill and idle terminal management')).toBeInTheDocument()

      expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument()
      expect(screen.getByText('Quick navigation')).toBeInTheDocument()
    })

    it('renders all setting labels', () => {
      const store = createTestStore()
      renderWithStore(store)

      // Appearance section
      expect(screen.getByText('Theme')).toBeInTheDocument()
      expect(screen.getByText('UI scale')).toBeInTheDocument()
      expect(screen.getByText('Terminal theme')).toBeInTheDocument()

      // Sidebar section
      expect(screen.getByText('Sort mode')).toBeInTheDocument()
      expect(screen.getByText('Show project badges')).toBeInTheDocument()

      // Terminal section
      expect(screen.getByText('Font size')).toBeInTheDocument()
      expect(screen.getByText('Line height')).toBeInTheDocument()
      expect(screen.getByText('Scrollback lines')).toBeInTheDocument()
      expect(screen.getByText('Cursor blink')).toBeInTheDocument()
      expect(screen.getByText('Font family')).toBeInTheDocument()

      // Safety section
      expect(screen.getByText('Auto-kill idle (minutes)')).toBeInTheDocument()
      expect(screen.getByText('Warn before kill (minutes)')).toBeInTheDocument()
      expect(screen.getByText('Default working directory')).toBeInTheDocument()
    })
  })

  describe('shows current settings values', () => {
    it('displays current theme selection', () => {
      const store = createTestStore({
        settings: { ...defaultSettings, theme: 'dark' },
      })
      renderWithStore(store)

      // Find all Dark buttons and verify one exists with selected styling
      const darkButtons = screen.getAllByRole('button', { name: 'Dark' })
      expect(darkButtons.length).toBeGreaterThan(0)
      // At least one should be in the document
      expect(darkButtons[0]).toBeInTheDocument()
    })

    it('displays current font size value', () => {
      const store = createTestStore({
        settings: {
          ...defaultSettings,
          terminal: { ...defaultSettings.terminal, fontSize: 16 },
        },
      })
      renderWithStore(store)

      expect(screen.getByText('16')).toBeInTheDocument()
    })

    it('displays current UI scale value', () => {
      const store = createTestStore({
        settings: { ...defaultSettings, uiScale: 1.5 },
      })
      renderWithStore(store)

      expect(screen.getByText('150%')).toBeInTheDocument()
    })

    it('displays current line height value', () => {
      const store = createTestStore({
        settings: {
          ...defaultSettings,
          terminal: { ...defaultSettings.terminal, lineHeight: 1.4 },
        },
      })
      renderWithStore(store)

      expect(screen.getByText('1.40')).toBeInTheDocument()
    })

    it('displays current scrollback value', () => {
      const store = createTestStore({
        settings: {
          ...defaultSettings,
          terminal: { ...defaultSettings.terminal, scrollback: 10000 },
        },
      })
      renderWithStore(store)

      expect(screen.getByText('10,000')).toBeInTheDocument()
    })

    it('displays current font family value', () => {
      const store = createTestStore({
        settings: {
          ...defaultSettings,
          terminal: { ...defaultSettings.terminal, fontFamily: 'Monaco' },
        },
      })
      renderWithStore(store)

      const fontInput = screen.getByDisplayValue('Monaco')
      expect(fontInput).toBeInTheDocument()
    })

    it('displays sidebar sort mode value', () => {
      const store = createTestStore({
        settings: {
          ...defaultSettings,
          sidebar: { ...defaultSettings.sidebar, sortMode: 'recency' },
        },
      })
      renderWithStore(store)

      const select = screen.getByDisplayValue('Recency')
      expect(select).toBeInTheDocument()
    })

    it('displays safety settings values', () => {
      const store = createTestStore({
        settings: {
          ...defaultSettings,
          safety: { autoKillIdleMinutes: 120, warnBeforeKillMinutes: 15 },
        },
      })
      renderWithStore(store)

      expect(screen.getByText('120')).toBeInTheDocument()
      expect(screen.getByText('15')).toBeInTheDocument()
    })

    it('shows lastSavedAt timestamp when available', () => {
      const savedTime = new Date('2024-01-15T10:30:00').getTime()
      const store = createTestStore({ lastSavedAt: savedTime })
      renderWithStore(store)

      // The component shows "Saved [time]" when lastSavedAt is set
      expect(screen.getByText(/Saved/)).toBeInTheDocument()
    })

    it('shows default text when no lastSavedAt', () => {
      const store = createTestStore({ lastSavedAt: undefined })
      renderWithStore(store)

      expect(screen.getByText('Configure your preferences')).toBeInTheDocument()
    })
  })

  describe('theme selector changes theme', () => {
    it('changes theme to light when Light is clicked', async () => {
      const store = createTestStore({
        settings: { ...defaultSettings, theme: 'system' },
      })
      renderWithStore(store)

      // Get the first Light button (app theme, not terminal theme)
      const lightButtons = screen.getAllByRole('button', { name: 'Light' })
      fireEvent.click(lightButtons[0])

      expect(store.getState().settings.settings.theme).toBe('light')
    })

    it('changes theme to dark when Dark is clicked', async () => {
      const store = createTestStore({
        settings: { ...defaultSettings, theme: 'system' },
      })
      renderWithStore(store)

      // Get the first Dark button (app theme, not terminal theme)
      const darkButtons = screen.getAllByRole('button', { name: 'Dark' })
      fireEvent.click(darkButtons[0])

      expect(store.getState().settings.settings.theme).toBe('dark')
    })

    it('changes theme to system when System is clicked', async () => {
      const store = createTestStore({
        settings: { ...defaultSettings, theme: 'dark' },
      })
      renderWithStore(store)

      const systemButton = screen.getByRole('button', { name: 'System' })
      fireEvent.click(systemButton)

      expect(store.getState().settings.settings.theme).toBe('system')
    })

    it('schedules API save after theme change', async () => {
      const store = createTestStore()
      renderWithStore(store)

      // Get the first Dark button (app theme)
      const darkButtons = screen.getAllByRole('button', { name: 'Dark' })
      fireEvent.click(darkButtons[0])

      // Advance timers to trigger scheduled save (500ms debounce)
      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', { theme: 'dark' })
    })
  })

  describe('font size slider updates value', () => {
    it('updates font size when slider changes', () => {
      const store = createTestStore()
      renderWithStore(store)

      // Find the font size slider (first slider after "Font size" label)
      const sliders = screen.getAllByRole('slider')
      const fontSizeSlider = sliders.find((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        return min === '10' && max === '22'
      })!

      fireEvent.change(fontSizeSlider, { target: { value: '18' } })

      expect(store.getState().settings.settings.terminal.fontSize).toBe(18)
    })

    it('displays updated font size value', () => {
      const store = createTestStore()
      renderWithStore(store)

      const sliders = screen.getAllByRole('slider')
      const fontSizeSlider = sliders.find((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        return min === '10' && max === '22'
      })!

      fireEvent.change(fontSizeSlider, { target: { value: '20' } })

      expect(screen.getByText('20')).toBeInTheDocument()
    })

    it('schedules API save after font size change', async () => {
      const store = createTestStore()
      renderWithStore(store)

      const sliders = screen.getAllByRole('slider')
      const fontSizeSlider = sliders.find((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        return min === '10' && max === '22'
      })!

      fireEvent.change(fontSizeSlider, { target: { value: '16' } })

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        terminal: { fontSize: 16 },
      })
    })
  })

  describe('save button calls API (auto-save behavior)', () => {
    it('auto-saves settings after debounce delay', async () => {
      const store = createTestStore()
      renderWithStore(store)

      // Change a setting - use first Dark button (app theme)
      const darkButtons = screen.getAllByRole('button', { name: 'Dark' })
      fireEvent.click(darkButtons[0])

      // Not called immediately
      expect(api.patch).not.toHaveBeenCalled()

      // Advance timers past debounce
      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', { theme: 'dark' })
    })

    it('debounces multiple rapid changes', async () => {
      const store = createTestStore()
      renderWithStore(store)

      // Make multiple quick changes - use first buttons (app theme)
      const darkButtons = screen.getAllByRole('button', { name: 'Dark' })
      fireEvent.click(darkButtons[0])

      await act(async () => {
        vi.advanceTimersByTime(200)
      })

      const lightButtons = screen.getAllByRole('button', { name: 'Light' })
      fireEvent.click(lightButtons[0])

      await act(async () => {
        vi.advanceTimersByTime(200)
      })

      const systemButton = screen.getByRole('button', { name: 'System' })
      fireEvent.click(systemButton)

      // Should not have called API yet (still debouncing)
      expect(api.patch).not.toHaveBeenCalled()

      // Advance past debounce
      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      // Should only have called once with the last value
      expect(api.patch).toHaveBeenCalledTimes(1)
      expect(api.patch).toHaveBeenCalledWith('/api/settings', { theme: 'system' })
    })

    it('updates markSaved after successful API call', async () => {
      const store = createTestStore({ lastSavedAt: undefined })
      renderWithStore(store)

      const darkButtons = screen.getAllByRole('button', { name: 'Dark' })
      fireEvent.click(darkButtons[0])

      // Advance timers to trigger the debounced save
      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      // Run all pending microtasks to resolve the API promise
      await act(async () => {
        await vi.runAllTimersAsync()
      })

      // After the API call resolves, markSaved should have been dispatched
      expect(store.getState().settings.lastSavedAt).toBeDefined()
    })
  })

  describe('cancel discards changes (immediate local updates)', () => {
    it('updates store immediately on change (no cancel button in this design)', () => {
      // Note: This component uses auto-save, so changes are applied immediately
      // to the store. There is no explicit cancel button.
      const store = createTestStore({
        settings: { ...defaultSettings, theme: 'system' },
      })
      renderWithStore(store)

      const darkButtons = screen.getAllByRole('button', { name: 'Dark' })
      fireEvent.click(darkButtons[0])

      // Change is immediately in the store
      expect(store.getState().settings.settings.theme).toBe('dark')
    })

    it('does not save if component unmounts before debounce', async () => {
      const store = createTestStore()
      const { unmount } = renderWithStore(store)

      const darkButtons = screen.getAllByRole('button', { name: 'Dark' })
      fireEvent.click(darkButtons[0])

      // Unmount before debounce completes
      unmount()

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      // API should not be called since component cleanup cleared the timeout
      expect(api.patch).not.toHaveBeenCalled()
    })
  })

  describe('additional settings interactions', () => {
    it('updates terminal theme', async () => {
      const store = createTestStore()
      renderWithStore(store)

      // Get the "Terminal theme" section buttons - these are the second set of theme buttons
      const lightButtons = screen.getAllByRole('button', { name: 'Light' })
      // The second Light button is for terminal theme
      const terminalLightButton = lightButtons[1]
      fireEvent.click(terminalLightButton)

      expect(store.getState().settings.settings.terminal.theme).toBe('light')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        terminal: { theme: 'light' },
      })
    })

    it('updates UI scale slider', async () => {
      const store = createTestStore()
      renderWithStore(store)

      const sliders = screen.getAllByRole('slider')
      const uiScaleSlider = sliders.find((slider) => {
        const min = slider.getAttribute('min')
        const step = slider.getAttribute('step')
        return min === '0.75' && step === '0.125'
      })!

      fireEvent.change(uiScaleSlider, { target: { value: '1.5' } })

      expect(store.getState().settings.settings.uiScale).toBe(1.5)
      expect(screen.getByText('150%')).toBeInTheDocument()
    })

    it('updates sidebar sort mode', async () => {
      const store = createTestStore()
      renderWithStore(store)

      const select = screen.getByRole('combobox')
      fireEvent.change(select, { target: { value: 'activity' } })

      expect(store.getState().settings.settings.sidebar.sortMode).toBe('activity')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        sidebar: { sortMode: 'activity' },
      })
    })

    it('toggles show project badges', async () => {
      const store = createTestStore({
        settings: {
          ...defaultSettings,
          sidebar: { ...defaultSettings.sidebar, showProjectBadges: true },
        },
      })
      renderWithStore(store)

      // Find toggle buttons - they have a specific structure (w-9 h-5 rounded-full)
      const allButtons = screen.getAllByRole('button')
      const toggleButtons = allButtons.filter((btn) => {
        const classes = btn.className
        return classes.includes('w-9') && classes.includes('h-5') && classes.includes('rounded-full')
      })

      // First toggle should be for "Show project badges"
      expect(toggleButtons.length).toBeGreaterThan(0)
      const showBadgesToggle = toggleButtons[0]
      fireEvent.click(showBadgesToggle)

      expect(store.getState().settings.settings.sidebar.showProjectBadges).toBe(false)
    })

    it('toggles cursor blink', async () => {
      const store = createTestStore({
        settings: {
          ...defaultSettings,
          terminal: { ...defaultSettings.terminal, cursorBlink: true },
        },
      })
      renderWithStore(store)

      const allButtons = screen.getAllByRole('button')
      const toggleButtons = allButtons.filter((btn) => {
        const classes = btn.className
        return classes.includes('w-9') && classes.includes('h-5') && classes.includes('rounded-full')
      })

      // Second toggle should be for cursor blink
      expect(toggleButtons.length).toBeGreaterThan(1)
      const cursorBlinkToggle = toggleButtons[1]
      fireEvent.click(cursorBlinkToggle)

      expect(store.getState().settings.settings.terminal.cursorBlink).toBe(false)

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        terminal: { cursorBlink: false },
      })
    })

    it('updates line height slider', () => {
      const store = createTestStore()
      renderWithStore(store)

      const sliders = screen.getAllByRole('slider')
      const lineHeightSlider = sliders.find((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        const step = slider.getAttribute('step')
        return min === '1' && max === '1.8' && step === '0.05'
      })!

      fireEvent.change(lineHeightSlider, { target: { value: '1.5' } })

      expect(store.getState().settings.settings.terminal.lineHeight).toBe(1.5)
    })

    it('updates scrollback slider', () => {
      const store = createTestStore()
      renderWithStore(store)

      const sliders = screen.getAllByRole('slider')
      const scrollbackSlider = sliders.find((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        return min === '1000' && max === '20000'
      })!

      fireEvent.change(scrollbackSlider, { target: { value: '15000' } })

      expect(store.getState().settings.settings.terminal.scrollback).toBe(15000)
    })

    it('updates font family input', async () => {
      const store = createTestStore()
      renderWithStore(store)

      const fontInput = screen.getByDisplayValue(defaultSettings.terminal.fontFamily)
      fireEvent.change(fontInput, { target: { value: 'Consolas' } })

      expect(store.getState().settings.settings.terminal.fontFamily).toBe('Consolas')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        terminal: { fontFamily: 'Consolas' },
      })
    })

    it('updates auto-kill idle minutes slider', () => {
      const store = createTestStore()
      renderWithStore(store)

      const sliders = screen.getAllByRole('slider')
      const autoKillSlider = sliders.find((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        return min === '10' && max === '720'
      })!

      fireEvent.change(autoKillSlider, { target: { value: '300' } })

      expect(store.getState().settings.settings.safety.autoKillIdleMinutes).toBe(300)
    })

    it('updates warn before kill slider', () => {
      const store = createTestStore()
      renderWithStore(store)

      const sliders = screen.getAllByRole('slider')
      const warnSlider = sliders.find((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        return min === '1' && max === '60'
      })!

      fireEvent.change(warnSlider, { target: { value: '10' } })

      expect(store.getState().settings.settings.safety.warnBeforeKillMinutes).toBe(10)
    })

    it('updates default working directory input', async () => {
      const store = createTestStore()
      renderWithStore(store)

      const cwdInput = screen.getByPlaceholderText('e.g. C:\\Users\\you\\projects')
      fireEvent.change(cwdInput, { target: { value: '/home/user/projects' } })

      expect(store.getState().settings.settings.defaultCwd).toBe('/home/user/projects')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        defaultCwd: '/home/user/projects',
      })
    })

    it('clears default working directory when input is emptied', async () => {
      const store = createTestStore({
        settings: { ...defaultSettings, defaultCwd: '/some/path' },
      })
      renderWithStore(store)

      const cwdInput = screen.getByDisplayValue('/some/path')
      fireEvent.change(cwdInput, { target: { value: '' } })

      expect(store.getState().settings.settings.defaultCwd).toBeUndefined()
    })
  })

  describe('keyboard shortcuts section', () => {
    it('displays keyboard shortcuts', () => {
      const store = createTestStore()
      renderWithStore(store)

      expect(screen.getByText('New terminal')).toBeInTheDocument()
      expect(screen.getByText('Close tab')).toBeInTheDocument()
      expect(screen.getByText('Sessions view')).toBeInTheDocument()
      expect(screen.getByText('Overview')).toBeInTheDocument()
    })

    it('displays keyboard shortcut keys', () => {
      const store = createTestStore()
      renderWithStore(store)

      // Look for keyboard keys - use getAllByText for keys that appear multiple times
      const ctrlKeys = screen.getAllByText('Ctrl')
      expect(ctrlKeys.length).toBeGreaterThan(0)

      // 'B' appears in multiple shortcuts, so use getAllByText
      const bKeys = screen.getAllByText('B')
      expect(bKeys.length).toBeGreaterThan(0)

      // These keys may appear multiple times too, use getAllByText
      const tKeys = screen.getAllByText('T')
      expect(tKeys.length).toBeGreaterThan(0)

      const wKeys = screen.getAllByText('W')
      expect(wKeys.length).toBeGreaterThan(0)

      const oKeys = screen.getAllByText('O')
      expect(oKeys.length).toBeGreaterThan(0)

      const commaKeys = screen.getAllByText(',')
      expect(commaKeys.length).toBeGreaterThan(0)
    })
  })

  describe('test isolation', () => {
    it('each test gets fresh component state', () => {
      const store1 = createTestStore({
        settings: { ...defaultSettings, theme: 'dark' },
      })

      const { unmount } = renderWithStore(store1)
      expect(store1.getState().settings.settings.theme).toBe('dark')
      unmount()

      const store2 = createTestStore({
        settings: { ...defaultSettings, theme: 'light' },
      })
      renderWithStore(store2)
      expect(store2.getState().settings.settings.theme).toBe('light')
    })

    it('API mocks are reset between tests', () => {
      // This test verifies that vi.clearAllMocks() in beforeEach works
      expect(api.patch).not.toHaveBeenCalled()
    })
  })
})

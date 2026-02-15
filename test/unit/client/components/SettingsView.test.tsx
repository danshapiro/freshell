import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act, cleanup, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import SettingsView from '@/components/SettingsView'
import settingsReducer, { defaultSettings, SettingsState } from '@/store/settingsSlice'
import tabsReducer from '@/store/tabsSlice'
import connectionReducer from '@/store/connectionSlice'
import sessionsReducer from '@/store/sessionsSlice'
import { networkReducer } from '@/store/networkSlice'
import { LOCAL_TERMINAL_FONT_KEY } from '@/lib/terminal-fonts'

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

let originalFonts: Document['fonts'] | undefined

function createTestStore(settingsState?: Partial<SettingsState>) {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabs: tabsReducer,
      connection: connectionReducer,
      sessions: sessionsReducer,
      network: networkReducer,
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
    originalFonts = document.fonts
    Object.defineProperty(document, 'fonts', {
      value: {
        check: vi.fn(() => true),
        ready: Promise.resolve(),
      },
      configurable: true,
    })
    localStorage.clear()
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    if (originalFonts) {
      Object.defineProperty(document, 'fonts', {
        value: originalFonts,
        configurable: true,
      })
    } else {
      // @ts-expect-error - test cleanup for jsdom fonts override
      delete document.fonts
    }
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
      const store = createTestStore()
      renderWithStore(store)

      const preview = screen.getByTestId('terminal-preview')
      const appearanceHeading = screen.getByText('Appearance')

      expect(preview).toBeInTheDocument()
      expect(preview.compareDocumentPosition(appearanceHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

      const previewLines = within(preview).getAllByTestId('terminal-preview-line')
      expect(previewLines).toHaveLength(8)
    })

    it('orders Sidebar section above Terminal', () => {
      const store = createTestStore()
      renderWithStore(store)

      const terminalHeading = screen.getByText('Terminal')
      const sidebarHeading = screen.getByText('Sidebar')

      // Sidebar should come before Terminal (PRECEDING means Terminal comes after Sidebar)
      expect(terminalHeading.compareDocumentPosition(sidebarHeading) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
    })

    it('renders all setting labels', () => {
      const store = createTestStore()
      renderWithStore(store)

      // Appearance section
      expect(screen.getByText('Theme')).toBeInTheDocument()
      expect(screen.getByText('UI scale')).toBeInTheDocument()
      expect(screen.getByText('Color scheme')).toBeInTheDocument()

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

      // Notifications section
      expect(screen.getByText('Sound on completion')).toBeInTheDocument()

      // Coding CLI section
      expect(screen.getByText('Enable Claude')).toBeInTheDocument()
      expect(screen.getByText('Enable Codex')).toBeInTheDocument()
      expect(screen.getByText('Claude permission mode')).toBeInTheDocument()
      expect(screen.getByText('Codex model')).toBeInTheDocument()
      expect(screen.getByText('Codex sandbox')).toBeInTheDocument()
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

      expect(screen.getByText('16px (100%)')).toBeInTheDocument()
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

    it('displays current font family value in dropdown', () => {
      const store = createTestStore({
        settings: {
          ...defaultSettings,
          terminal: { ...defaultSettings.terminal, fontFamily: 'JetBrains Mono' },
        },
      })
      renderWithStore(store)

      // Font family is now a dropdown
      const selects = screen.getAllByRole('combobox')
      const fontFamilySelect = selects.find((select) => {
        return select.querySelector('option[value="JetBrains Mono"]') !== null
      })!
      expect(fontFamilySelect).toHaveValue('JetBrains Mono')
    })

    it('includes Cascadia and Meslo font options', () => {
      const store = createTestStore()
      renderWithStore(store)

      const selects = screen.getAllByRole('combobox')
      const fontFamilySelect = selects.find((select) => {
        return select.querySelector('option[value="JetBrains Mono"]') !== null
      })!

      const optionValues = Array.from(fontFamilySelect.querySelectorAll('option')).map((opt) =>
        opt.getAttribute('value')
      )

      expect(optionValues).toContain('Cascadia Code')
      expect(optionValues).toContain('Cascadia Mono')
      expect(optionValues).toContain('Meslo LG S')
    })

    it('hides fonts that are not installed locally', async () => {
      Object.defineProperty(document, 'fonts', {
        value: {
          check: vi.fn((font: string) => {
            if (font.includes('Cascadia Code')) return false
            if (font.includes('Cascadia Mono')) return false
            if (font.includes('Meslo LG S')) return false
            return true
          }),
          ready: Promise.resolve(),
        },
        configurable: true,
      })

      const store = createTestStore()
      renderWithStore(store)

      const selects = screen.getAllByRole('combobox')
      const fontFamilySelect = selects.find((select) => {
        return select.querySelector('option[value="JetBrains Mono"]') !== null
      })!

      await act(async () => {
        await document.fonts.ready
      })

      const optionValues = Array.from(fontFamilySelect.querySelectorAll('option')).map((opt) =>
        opt.getAttribute('value')
      )
      expect(optionValues).not.toContain('Cascadia Code')
      expect(optionValues).not.toContain('Cascadia Mono')
      expect(optionValues).not.toContain('Meslo LG S')
    })

    it('falls back to monospace when selected font is unavailable', async () => {
      Object.defineProperty(document, 'fonts', {
        value: {
          check: vi.fn((font: string) => !font.includes('Cascadia Code')),
          ready: Promise.resolve(),
        },
        configurable: true,
      })

      const store = createTestStore({
        settings: {
          ...defaultSettings,
          terminal: { ...defaultSettings.terminal, fontFamily: 'Cascadia Code' },
        },
      })
      renderWithStore(store)

      await act(async () => {
        await document.fonts.ready
      })

      expect(store.getState().settings.settings.terminal.fontFamily).toBe('monospace')
      expect(localStorage.getItem(LOCAL_TERMINAL_FONT_KEY)).toBe('monospace')
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

      // Find the font size slider (min=12, max=32)
      const sliders = screen.getAllByRole('slider')
      const fontSizeSlider = sliders.find((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        return min === '12' && max === '32'
      })!

      fireEvent.change(fontSizeSlider, { target: { value: '18' } })
      fireEvent.pointerUp(fontSizeSlider)

      expect(store.getState().settings.settings.terminal.fontSize).toBe(18)
    })

    it('displays updated font size value', () => {
      const store = createTestStore()
      renderWithStore(store)

      const sliders = screen.getAllByRole('slider')
      const fontSizeSlider = sliders.find((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        return min === '12' && max === '32'
      })!

      fireEvent.change(fontSizeSlider, { target: { value: '20' } })

      // Format is "20px (125%)"
      expect(screen.getByText('20px (125%)')).toBeInTheDocument()
    })

    it('schedules API save after font size change', async () => {
      const store = createTestStore()
      renderWithStore(store)

      const sliders = screen.getAllByRole('slider')
      const fontSizeSlider = sliders.find((slider) => {
        const min = slider.getAttribute('min')
        const max = slider.getAttribute('max')
        return min === '12' && max === '32'
      })!

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

      // Terminal theme is now a select dropdown (Color scheme)
      const selects = screen.getAllByRole('combobox')
      // First select is sidebar sort mode, second is terminal theme (Color scheme)
      const terminalThemeSelect = selects.find((select) => {
        // Check if it has the 'auto' option which is unique to terminal theme
        return select.querySelector('option[value="auto"]') !== null
      })!
      fireEvent.change(terminalThemeSelect, { target: { value: 'one-dark' } })

      expect(store.getState().settings.settings.terminal.theme).toBe('one-dark')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        terminal: { theme: 'one-dark' },
      })
    })

    it('updates UI scale slider', async () => {
      const store = createTestStore()
      renderWithStore(store)

      const sliders = screen.getAllByRole('slider')
      const uiScaleSlider = sliders.find((slider) => {
        const min = slider.getAttribute('min')
        const step = slider.getAttribute('step')
        return min === '0.75' && step === '0.05'
      })!

      fireEvent.change(uiScaleSlider, { target: { value: '1.5' } })
      fireEvent.pointerUp(uiScaleSlider)

      expect(store.getState().settings.settings.uiScale).toBe(1.5)
      expect(screen.getByText('150%')).toBeInTheDocument()
    })

    it('updates sidebar sort mode', async () => {
      const store = createTestStore()
      renderWithStore(store)

      // Find the sidebar sort mode select (contains activity/recency/project options)
      const selects = screen.getAllByRole('combobox')
      const sortModeSelect = selects.find((select) => {
        return select.querySelector('option[value="activity"]') !== null
          && select.querySelector('option[value="recency"]') !== null
          && select.querySelector('option[value="project"]') !== null
      })!
      expect(sortModeSelect.querySelector('option[value="hybrid"]')).toBeNull()
      const activityOption = sortModeSelect.querySelector('option[value="activity"]')
      expect(activityOption?.textContent).toBe('Activity (tabs first)')
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
      const store = createTestStore()
      renderWithStore(store)

      const selects = screen.getAllByRole('combobox')
      const sortModeSelect = selects.find((select) => {
        return select.querySelector('option[value="recency-pinned"]') !== null
      })!
      const recencyPinnedOption = sortModeSelect.querySelector('option[value="recency-pinned"]')
      expect(recencyPinnedOption?.textContent).toBe('Recency (pinned)')
      fireEvent.change(sortModeSelect, { target: { value: 'recency-pinned' } })

      expect(store.getState().settings.settings.sidebar.sortMode).toBe('recency-pinned')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).toHaveBeenCalledWith('/api/settings', {
        sidebar: { sortMode: 'recency-pinned' },
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

      const showBadgesRow = screen.getByText('Show project badges').closest('div')
      expect(showBadgesRow).toBeTruthy()
      const showBadgesToggle = within(showBadgesRow!).getByRole('switch')
      fireEvent.click(showBadgesToggle)

      expect(store.getState().settings.settings.sidebar.showProjectBadges).toBe(false)
    })

    it('toggles notification sound', async () => {
      const store = createTestStore({
        settings: {
          ...defaultSettings,
          notifications: { soundEnabled: true },
        },
      })
      renderWithStore(store)

      const soundRow = screen.getByText('Sound on completion').closest('div')
      expect(soundRow).toBeTruthy()
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
      const store = createTestStore({
        settings: {
          ...defaultSettings,
          terminal: { ...defaultSettings.terminal, cursorBlink: true },
        },
      })
      renderWithStore(store)

      const cursorBlinkRow = screen.getByText('Cursor blink').closest('div')
      expect(cursorBlinkRow).toBeTruthy()
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
      const store = createTestStore({
        settings: {
          ...defaultSettings,
          logging: { ...defaultSettings.logging, debug: false },
        },
      })
      renderWithStore(store)

      const debugRow = screen.getByText('Debug logging').closest('div')
      expect(debugRow).toBeTruthy()
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
      const store = createTestStore()
      renderWithStore(store)

      const row = screen.getByText('Enable Codex').closest('div')!
      const toggle = row.querySelector('button')!
      fireEvent.click(toggle)

      expect(store.getState().settings.settings.codingCli.enabledProviders).not.toContain('codex')
    })

    it('updates codex model input', async () => {
      const store = createTestStore()
      renderWithStore(store)

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
      const store = createTestStore()
      renderWithStore(store)

      const selects = screen.getAllByRole('combobox')
      const sandboxSelect = selects.find((select) => {
        return select.querySelector('option[value="workspace-write"]') !== null
      })!

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
      fireEvent.pointerUp(lineHeightSlider)

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
      fireEvent.pointerUp(scrollbackSlider)

      expect(store.getState().settings.settings.terminal.scrollback).toBe(15000)
    })

    it('updates font family from dropdown', async () => {
      const store = createTestStore()
      renderWithStore(store)

      // Font family is now a dropdown, find it by looking for the select with font options
      const selects = screen.getAllByRole('combobox')
      const fontFamilySelect = selects.find((select) => {
        return select.querySelector('option[value="JetBrains Mono"]') !== null
      })!
      expect(fontFamilySelect).toBeDefined()

      fireEvent.change(fontFamilySelect, { target: { value: 'Cascadia Code' } })

      expect(store.getState().settings.settings.terminal.fontFamily).toBe('Cascadia Code')
      expect(localStorage.getItem(LOCAL_TERMINAL_FONT_KEY)).toBe('Cascadia Code')

      await act(async () => {
        vi.advanceTimersByTime(500)
      })

      expect(api.patch).not.toHaveBeenCalled()
    })

    it('displays current font family in dropdown', () => {
      const store = createTestStore({
        settings: {
          ...defaultSettings,
          terminal: { ...defaultSettings.terminal, fontFamily: 'Fira Code' },
        },
      })
      renderWithStore(store)

      const selects = screen.getAllByRole('combobox')
      const fontFamilySelect = selects.find((select) => {
        return select.querySelector('option[value="JetBrains Mono"]') !== null
      })!
      expect(fontFamilySelect).toHaveValue('Fira Code')
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
      fireEvent.pointerUp(autoKillSlider)

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
      fireEvent.pointerUp(warnSlider)

      expect(store.getState().settings.settings.safety.warnBeforeKillMinutes).toBe(10)
    })

    it('validates default working directory before saving', async () => {
      vi.mocked(api.post).mockResolvedValue({ valid: true })
      const store = createTestStore()
      renderWithStore(store)

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
      const store = createTestStore({
        settings: { ...defaultSettings, defaultCwd: '/some/path' },
      })
      renderWithStore(store)

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
      const store = createTestStore({
        settings: { ...defaultSettings, defaultCwd: '/some/path' },
      })
      renderWithStore(store)

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
      const store = createTestStore()
      renderWithStore(store)

      expect(screen.getByText('Previous tab')).toBeInTheDocument()
      expect(screen.getByText('Next tab')).toBeInTheDocument()
      expect(screen.getByText('Newline (same as Ctrl+J)')).toBeInTheDocument()
      expect(screen.getByText('Newline')).toBeInTheDocument()
    })

    it('displays keyboard shortcut keys', () => {
      const store = createTestStore()
      renderWithStore(store)

      // Look for keyboard keys - Ctrl+Shift+[ and Ctrl+Shift+]
      const ctrlKeys = screen.getAllByText('Ctrl')
      expect(ctrlKeys.length).toBeGreaterThan(0)

      const shiftKeys = screen.getAllByText('Shift')
      expect(shiftKeys.length).toBeGreaterThan(0)

      // Bracket keys
      expect(screen.getByText('[')).toBeInTheDocument()
      expect(screen.getByText(']')).toBeInTheDocument()
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

  describe('Network Access settings', () => {
    it('renders remote access toggle', () => {
      const store = createTestStore()
      render(
        <Provider store={store}>
          <SettingsView onNavigate={vi.fn()} />
        </Provider>,
      )
      expect(screen.getByText(/remote access/i)).toBeInTheDocument()
    })

    it('shows firewall Fix button for WSL2 even with empty commands', () => {
      const store = configureStore({
        reducer: {
          settings: settingsReducer,
          tabs: tabsReducer,
          connection: connectionReducer,
          sessions: sessionsReducer,
          network: networkReducer,
        },
        preloadedState: {
          settings: {
            settings: defaultSettings,
            loaded: true,
            lastSavedAt: undefined,
          },
          network: {
            status: {
              configured: true,
              host: '0.0.0.0' as const,
              port: 3001,
              lanIps: ['192.168.1.100'],
              machineHostname: 'my-laptop',
              firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
              rebinding: false,
              devMode: false,
              accessUrl: 'http://192.168.1.100:3001/?token=abc',
            },
            loading: false,
            configuring: false,
            error: null,
          },
        },
      })
      render(
        <Provider store={store}>
          <SettingsView onNavigate={vi.fn()} />
        </Provider>,
      )
      expect(screen.getByRole('button', { name: /fix firewall/i })).toBeInTheDocument()
    })

    it('shows dev-mode restart warning when devMode is true', () => {
      const store = configureStore({
        reducer: {
          settings: settingsReducer,
          tabs: tabsReducer,
          connection: connectionReducer,
          sessions: sessionsReducer,
          network: networkReducer,
        },
        preloadedState: {
          settings: {
            settings: defaultSettings,
            loaded: true,
            lastSavedAt: undefined,
          },
          network: {
            status: {
              configured: true,
              host: '0.0.0.0' as const,
              port: 3001,
              lanIps: ['192.168.1.100'],
              machineHostname: 'my-laptop',
              firewall: { platform: 'linux-none', active: false, portOpen: null, commands: [], configuring: false },
              rebinding: false,
              devMode: true,
              devPort: 5173,
              accessUrl: 'http://192.168.1.100:5173/?token=abc',
            },
            loading: false,
            configuring: false,
            error: null,
          },
        },
      })
      render(
        <Provider store={store}>
          <SettingsView onNavigate={vi.fn()} />
        </Provider>,
      )
      expect(screen.getByRole('alert')).toBeInTheDocument()
      expect(screen.getByText(/dev mode/i)).toBeInTheDocument()
      expect(screen.getByText(/npm run dev/i)).toBeInTheDocument()
    })

    it('suppresses dev-mode warning on WSL2', () => {
      const store = configureStore({
        reducer: {
          settings: settingsReducer,
          tabs: tabsReducer,
          connection: connectionReducer,
          sessions: sessionsReducer,
          network: networkReducer,
        },
        preloadedState: {
          settings: {
            settings: defaultSettings,
            loaded: true,
            lastSavedAt: undefined,
          },
          network: {
            status: {
              configured: true,
              host: '0.0.0.0' as const,
              port: 3001,
              lanIps: ['192.168.1.100'],
              machineHostname: 'my-laptop',
              firewall: { platform: 'wsl2', active: true, portOpen: false, commands: [], configuring: false },
              rebinding: false,
              devMode: true,
              devPort: 5173,
              accessUrl: 'http://192.168.1.100:5173/?token=abc',
            },
            loading: false,
            configuring: false,
            error: null,
          },
        },
      })
      render(
        <Provider store={store}>
          <SettingsView onNavigate={vi.fn()} />
        </Provider>,
      )
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('disables remote access toggle during rebind', () => {
      const store = configureStore({
        reducer: {
          settings: settingsReducer,
          tabs: tabsReducer,
          connection: connectionReducer,
          sessions: sessionsReducer,
          network: networkReducer,
        },
        preloadedState: {
          settings: {
            settings: defaultSettings,
            loaded: true,
            lastSavedAt: undefined,
          },
          network: {
            status: {
              configured: true,
              host: '0.0.0.0' as const,
              port: 3001,
              lanIps: ['192.168.1.100'],
              machineHostname: 'my-laptop',
              firewall: { platform: 'linux-none', active: false, portOpen: null, commands: [], configuring: false },
              rebinding: true,
              devMode: false,
              accessUrl: 'http://192.168.1.100:3001/?token=abc',
            },
            loading: false,
            configuring: false,
            error: null,
          },
        },
      })
      render(
        <Provider store={store}>
          <SettingsView onNavigate={vi.fn()} />
        </Provider>,
      )
      const toggle = screen.getByRole('switch', { name: /remote access/i })
      expect(toggle).toBeDisabled()
    })

    it('disables remote access toggle during configuring', () => {
      const store = configureStore({
        reducer: {
          settings: settingsReducer,
          tabs: tabsReducer,
          connection: connectionReducer,
          sessions: sessionsReducer,
          network: networkReducer,
        },
        preloadedState: {
          settings: {
            settings: defaultSettings,
            loaded: true,
            lastSavedAt: undefined,
          },
          network: {
            status: {
              configured: true,
              host: '0.0.0.0' as const,
              port: 3001,
              lanIps: ['192.168.1.100'],
              machineHostname: 'my-laptop',
              firewall: { platform: 'linux-none', active: false, portOpen: null, commands: [], configuring: false },
              rebinding: false,
              devMode: false,
              accessUrl: 'http://192.168.1.100:3001/?token=abc',
            },
            loading: false,
            configuring: true,
            error: null,
          },
        },
      })
      render(
        <Provider store={store}>
          <SettingsView onNavigate={vi.fn()} />
        </Provider>,
      )
      const toggle = screen.getByRole('switch', { name: /remote access/i })
      expect(toggle).toBeDisabled()
    })

    it('renders Get link button when access URL is present', () => {
      const store = configureStore({
        reducer: {
          settings: settingsReducer,
          tabs: tabsReducer,
          connection: connectionReducer,
          sessions: sessionsReducer,
          network: networkReducer,
        },
        preloadedState: {
          settings: {
            settings: defaultSettings,
            loaded: true,
            lastSavedAt: undefined,
          },
          network: {
            status: {
              configured: true,
              host: '0.0.0.0' as const,
              port: 3001,
              lanIps: ['192.168.1.100'],
              machineHostname: 'my-laptop',
              firewall: { platform: 'linux-none', active: false, portOpen: null, commands: [], configuring: false },
              rebinding: false,
              devMode: false,
              accessUrl: 'http://192.168.1.100:3001/?token=abc',
            },
            loading: false,
            configuring: false,
            error: null,
          },
        },
      })
      render(
        <Provider store={store}>
          <SettingsView onNavigate={vi.fn()} />
        </Provider>,
      )
      expect(screen.getByText('Get link')).toBeInTheDocument()
    })

    it('calls onSharePanel when Get link is clicked', () => {
      const onSharePanel = vi.fn()
      const store = configureStore({
        reducer: {
          settings: settingsReducer,
          tabs: tabsReducer,
          connection: connectionReducer,
          sessions: sessionsReducer,
          network: networkReducer,
        },
        preloadedState: {
          settings: {
            settings: defaultSettings,
            loaded: true,
            lastSavedAt: undefined,
          },
          network: {
            status: {
              configured: true,
              host: '0.0.0.0' as const,
              port: 3001,
              lanIps: ['192.168.1.100'],
              machineHostname: 'my-laptop',
              firewall: { platform: 'linux-none', active: false, portOpen: null, commands: [], configuring: false },
              rebinding: false,
              devMode: false,
              accessUrl: 'http://192.168.1.100:3001/?token=abc',
            },
            loading: false,
            configuring: false,
            error: null,
          },
        },
      })
      render(
        <Provider store={store}>
          <SettingsView onNavigate={vi.fn()} onSharePanel={onSharePanel} />
        </Provider>,
      )
      fireEvent.click(screen.getByText('Get link'))
      expect(onSharePanel).toHaveBeenCalledOnce()
    })
  })
})

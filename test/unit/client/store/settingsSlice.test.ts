import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import settingsReducer, {
  setSettings,
  updateSettingsLocal,
  markSaved,
  defaultSettings,
  SettingsState,
} from '../../../../src/store/settingsSlice'
import type { AppSettings } from '../../../../src/store/types'

describe('settingsSlice', () => {
  describe('initial state', () => {
    it('has correct default values', () => {
      const state = settingsReducer(undefined, { type: 'unknown' })

      expect(state.settings).toEqual(defaultSettings)
      expect(state.loaded).toBe(false)
      expect(state.lastSavedAt).toBeUndefined()
    })

    it('has default settings with expected structure', () => {
      const state = settingsReducer(undefined, { type: 'unknown' })

      expect(state.settings.theme).toBe('system')
      expect(state.settings.uiScale).toBe(1.0)
      expect(state.settings.terminal).toEqual({
        fontSize: 16,
        fontFamily: 'Consolas',
        lineHeight: 1,
        cursorBlink: true,
        scrollback: 5000,
        theme: 'auto',
      })
      expect(state.settings.defaultCwd).toBeUndefined()
      expect(state.settings.safety).toEqual({
        autoKillIdleMinutes: 180,
        warnBeforeKillMinutes: 5,
      })
      expect(state.settings.sidebar).toEqual({
        sortMode: 'activity',
        showProjectBadges: true,
        width: 288,
        collapsed: false,
      })
      expect(state.settings.notifications).toEqual({
        visualWhenWorking: true,
        visualWhenFinished: true,
        soundWhenFinished: true,
      })
      expect(state.settings.codingCli).toEqual({
        enabledProviders: ['claude', 'codex'],
        providers: {
          claude: {
            permissionMode: 'default',
          },
          codex: {},
        },
      })
    })
  })

  describe('setSettings', () => {
    it('replaces entire settings', () => {
      const initialState: SettingsState = {
        settings: defaultSettings,
        loaded: false,
      }

      const newSettings: AppSettings = {
        theme: 'dark',
        uiScale: 1.5,
        terminal: {
          fontSize: 16,
          fontFamily: 'Consolas',
          lineHeight: 1.4,
          cursorBlink: false,
          scrollback: 10000,
          theme: 'light',
        },
        defaultCwd: '/home/user',
        safety: {
          autoKillIdleMinutes: 60,
          warnBeforeKillMinutes: 10,
        },
        sidebar: {
          sortMode: 'recency',
          showProjectBadges: false,
          width: 320,
          collapsed: false,
        },
        notifications: {
          visualWhenWorking: false,
          visualWhenFinished: true,
          soundWhenFinished: false,
        },
        codingCli: {
          enabledProviders: ['codex'],
          providers: {
            codex: {
              model: 'gpt-5-codex',
              sandbox: 'read-only',
            },
          },
        },
        panes: {
          defaultNewPane: 'shell',
        },
      }

      const state = settingsReducer(initialState, setSettings(newSettings))

      expect(state.settings).toEqual({
        ...newSettings,
        codingCli: {
          ...newSettings.codingCli,
          providers: {
            ...defaultSettings.codingCli.providers,
            ...newSettings.codingCli.providers,
          },
        },
      })
    })

    it('sets loaded to true', () => {
      const initialState: SettingsState = {
        settings: defaultSettings,
        loaded: false,
      }

      const state = settingsReducer(initialState, setSettings(defaultSettings))

      expect(state.loaded).toBe(true)
    })

    it('replaces all properties including nested ones', () => {
      const initialState: SettingsState = {
        settings: {
          ...defaultSettings,
          terminal: {
            ...defaultSettings.terminal,
            fontSize: 20,
          },
        },
        loaded: true,
      }

      const newSettings: AppSettings = {
        ...defaultSettings,
        terminal: {
          ...defaultSettings.terminal,
          fontSize: 12,
        },
      }

      const state = settingsReducer(initialState, setSettings(newSettings))

      expect(state.settings.terminal.fontSize).toBe(12)
    })
  })

  describe('updateSettingsLocal', () => {
    it('merges partial updates at top level', () => {
      const initialState: SettingsState = {
        settings: defaultSettings,
        loaded: true,
      }

      const state = settingsReducer(
        initialState,
        updateSettingsLocal({ theme: 'dark', uiScale: 2 })
      )

      expect(state.settings.theme).toBe('dark')
      expect(state.settings.uiScale).toBe(2)
      // Other properties should remain unchanged
      expect(state.settings.terminal).toEqual(defaultSettings.terminal)
      expect(state.settings.safety).toEqual(defaultSettings.safety)
      expect(state.settings.sidebar).toEqual(defaultSettings.sidebar)
    })

    it('deep merges terminal settings', () => {
      const initialState: SettingsState = {
        settings: defaultSettings,
        loaded: true,
      }

      const state = settingsReducer(
        initialState,
        updateSettingsLocal({
          terminal: { fontSize: 18 },
        })
      )

      expect(state.settings.terminal.fontSize).toBe(18)
      // Other terminal properties should remain unchanged
      expect(state.settings.terminal.fontFamily).toBe(defaultSettings.terminal.fontFamily)
      expect(state.settings.terminal.lineHeight).toBe(defaultSettings.terminal.lineHeight)
      expect(state.settings.terminal.cursorBlink).toBe(defaultSettings.terminal.cursorBlink)
      expect(state.settings.terminal.scrollback).toBe(defaultSettings.terminal.scrollback)
      expect(state.settings.terminal.theme).toBe(defaultSettings.terminal.theme)
    })

    it('deep merges safety settings', () => {
      const initialState: SettingsState = {
        settings: defaultSettings,
        loaded: true,
      }

      const state = settingsReducer(
        initialState,
        updateSettingsLocal({
          safety: { autoKillIdleMinutes: 60 },
        })
      )

      expect(state.settings.safety.autoKillIdleMinutes).toBe(60)
      expect(state.settings.safety.warnBeforeKillMinutes).toBe(defaultSettings.safety.warnBeforeKillMinutes)
    })

    it('deep merges sidebar settings', () => {
      const initialState: SettingsState = {
        settings: defaultSettings,
        loaded: true,
      }

      const state = settingsReducer(
        initialState,
        updateSettingsLocal({
          sidebar: { sortMode: 'activity' },
        })
      )

      expect(state.settings.sidebar.sortMode).toBe('activity')
      expect(state.settings.sidebar.showProjectBadges).toBe(defaultSettings.sidebar.showProjectBadges)
    })

    it('deep merges coding CLI settings', () => {
      const initialState: SettingsState = {
        settings: defaultSettings,
        loaded: true,
      }

      const state = settingsReducer(
        initialState,
        updateSettingsLocal({
          codingCli: {
            enabledProviders: ['claude'],
            providers: {
              codex: {
                model: 'gpt-5-codex',
              },
            },
          },
        })
      )

      expect(state.settings.codingCli.enabledProviders).toEqual(['claude'])
      expect(state.settings.codingCli.providers.codex?.model).toBe('gpt-5-codex')
      expect(state.settings.codingCli.providers.claude?.permissionMode).toBe('default')
    })

    it('handles multiple nested updates simultaneously', () => {
      const initialState: SettingsState = {
        settings: defaultSettings,
        loaded: true,
      }

      const state = settingsReducer(
        initialState,
        updateSettingsLocal({
          theme: 'light',
          terminal: { fontSize: 16, cursorBlink: false },
          safety: { warnBeforeKillMinutes: 10 },
          sidebar: { showProjectBadges: false },
        })
      )

      expect(state.settings.theme).toBe('light')
      expect(state.settings.terminal.fontSize).toBe(16)
      expect(state.settings.terminal.cursorBlink).toBe(false)
      expect(state.settings.terminal.fontFamily).toBe(defaultSettings.terminal.fontFamily)
      expect(state.settings.safety.warnBeforeKillMinutes).toBe(10)
      expect(state.settings.safety.autoKillIdleMinutes).toBe(defaultSettings.safety.autoKillIdleMinutes)
      expect(state.settings.sidebar.showProjectBadges).toBe(false)
      expect(state.settings.sidebar.sortMode).toBe(defaultSettings.sidebar.sortMode)
    })

    it('preserves loaded state', () => {
      const initialState: SettingsState = {
        settings: defaultSettings,
        loaded: true,
      }

      const state = settingsReducer(
        initialState,
        updateSettingsLocal({ theme: 'dark' })
      )

      expect(state.loaded).toBe(true)
    })

    it('handles empty partial update', () => {
      const initialState: SettingsState = {
        settings: defaultSettings,
        loaded: true,
      }

      const state = settingsReducer(initialState, updateSettingsLocal({}))

      expect(state.settings).toEqual(defaultSettings)
    })

    it('can update defaultCwd', () => {
      const initialState: SettingsState = {
        settings: defaultSettings,
        loaded: true,
      }

      const state = settingsReducer(
        initialState,
        updateSettingsLocal({ defaultCwd: '/new/path' })
      )

      expect(state.settings.defaultCwd).toBe('/new/path')
    })
  })

  describe('markSaved', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('sets lastSavedAt to current timestamp', () => {
      const initialState: SettingsState = {
        settings: defaultSettings,
        loaded: true,
      }

      const now = Date.now()
      vi.setSystemTime(now)

      const state = settingsReducer(initialState, markSaved())

      expect(state.lastSavedAt).toBe(now)
    })

    it('updates lastSavedAt on subsequent calls', () => {
      const initialState: SettingsState = {
        settings: defaultSettings,
        loaded: true,
        lastSavedAt: 1000,
      }

      const newTime = 2000
      vi.setSystemTime(newTime)

      const state = settingsReducer(initialState, markSaved())

      expect(state.lastSavedAt).toBe(newTime)
    })

    it('preserves other state properties', () => {
      const initialState: SettingsState = {
        settings: { ...defaultSettings, theme: 'dark' },
        loaded: true,
      }

      const state = settingsReducer(initialState, markSaved())

      expect(state.settings.theme).toBe('dark')
      expect(state.loaded).toBe(true)
    })
  })

  describe('defaultSettings export', () => {
    it('exports defaultSettings constant', () => {
      expect(defaultSettings).toBeDefined()
      expect(defaultSettings.theme).toBe('system')
      expect(defaultSettings.uiScale).toBe(1.0)
    })

    it('has all required properties', () => {
      expect(defaultSettings).toHaveProperty('theme')
      expect(defaultSettings).toHaveProperty('uiScale')
      expect(defaultSettings).toHaveProperty('terminal')
      expect(defaultSettings).toHaveProperty('safety')
      expect(defaultSettings).toHaveProperty('sidebar')
      expect(defaultSettings).toHaveProperty('codingCli')
    })
  })
})

describe('settingsSlice - sortMode migration', () => {
  it('migrates hybrid to activity', async () => {
    const { migrateSortMode } = await import('@/store/settingsSlice')
    expect(migrateSortMode('hybrid')).toBe('activity')
  })

  it('preserves valid sort modes', async () => {
    const { migrateSortMode } = await import('@/store/settingsSlice')
    expect(migrateSortMode('recency')).toBe('recency')
    expect(migrateSortMode('activity')).toBe('activity')
    expect(migrateSortMode('project')).toBe('project')
  })

  it('defaults invalid values to activity', async () => {
    const { migrateSortMode } = await import('@/store/settingsSlice')
    expect(migrateSortMode('invalid' as any)).toBe('activity')
    expect(migrateSortMode(undefined as any)).toBe('activity')
  })
})

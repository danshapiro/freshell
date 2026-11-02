import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BROWSER_PREFERENCES_STORAGE_KEY } from '@/store/storage-keys'

async function importFreshSettingsSlice() {
  vi.resetModules()
  return await import('@/store/settingsSlice')
}

describe('settingsSlice', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('stores serverSettings, localSettings, and resolved settings in initial state', async () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: {
        theme: 'dark',
        terminal: {
          fontSize: 18,
        },
      },
    }))

    const { default: settingsReducer, defaultSettings } = await importFreshSettingsSlice()
    const state = settingsReducer(undefined, { type: 'unknown' })

    expect(state.serverSettings.terminal.scrollback).toBe(10000)
    expect(state.localSettings.theme).toBe('dark')
    expect(state.localSettings.terminal.fontSize).toBe(18)
    expect(state.settings).toEqual({
      ...defaultSettings,
      panes: {
        ...defaultSettings.panes,
        // jsdom boots desktop-ambient: the platform default is ON.
        floatingActionButton: true,
      },
      theme: 'dark',
      terminal: {
        ...defaultSettings.terminal,
        fontSize: 18,
      },
    })
    expect(state.loaded).toBe(false)
  })

  it('keeps defaultSettings exported as resolved settings', async () => {
    const { defaultSettings } = await importFreshSettingsSlice()

    expect(defaultSettings.theme).toBe('system')
    expect(defaultSettings.sidebar.sortMode).toBe('activity')
    expect(defaultSettings.terminal.fontFamily).toBe('monospace')
    expect(defaultSettings.terminal.scrollback).toBe(10000)
  })

  it('fresh-install server settings default includes antigravity among the enabled CLI providers', async () => {
    // The slice's initial `serverSettings` comes from
    // `createDefaultServerSettings()` → `DEFAULT_ENABLED_CLI_PROVIDERS`;
    // a fresh install takes `enabledProviders` from these defaults (the
    // append-and-enable migration only covers existing installs).
    const { default: settingsReducer } = await importFreshSettingsSlice()
    const initialState = settingsReducer(undefined, { type: 'unknown' })
    expect(initialState.serverSettings.codingCli.enabledProviders).toEqual([
      'claude', 'codex', 'opencode', 'amplifier', 'antigravity',
    ])
  })

  it('resolves the panes.floatingActionButton platform default at boot: desktop true, mobile false', async () => {
    // jsdom's matchMedia mock boots desktop-ambient (test/setup/dom.ts resets
    // __MOBILE_MATCHES__ to false), so a fresh slice import resolves the
    // desktop default: the FAB setting is ON.
    const desktop = await importFreshSettingsSlice()
    expect(desktop.default(undefined, { type: 'unknown' }).localSettings.panes.floatingActionButton).toBe(true)

    // Flip the mock to mobile BEFORE the fresh import: importFreshSettingsSlice
    // resets the module registry, so the re-imported slice re-reads matchMedia
    // and resolves the mobile default: OFF. Mobile = viewport width
    // (max-width: 767px), not device class — same rule as useMobile().
    ;(globalThis as any).setMobileForTest(true)
    try {
      const mobile = await importFreshSettingsSlice()
      expect(mobile.default(undefined, { type: 'unknown' }).localSettings.panes.floatingActionButton).toBe(false)
    } finally {
      ;(globalThis as any).setMobileForTest(false)
    }
  })

  it('keeps the boot-time platform default for the rest of the session (a later resize across the mobile breakpoint does not re-resolve)', async () => {
    const { default: settingsReducer, updateSettingsLocal } = await importFreshSettingsSlice()
    const initialState = settingsReducer(undefined, { type: 'unknown' })
    expect(initialState.localSettings.panes.floatingActionButton).toBe(true) // desktop boot

    ;(globalThis as any).setMobileForTest(true)
    try {
      const state = settingsReducer(initialState, updateSettingsLocal({ theme: 'dark' }))
      expect(state.localSettings.panes.floatingActionButton).toBe(true) // still the boot answer
      expect(state.localSettings.theme).toBe('dark')
    } finally {
      ;(globalThis as any).setMobileForTest(false)
    }
  })

  it('hydrates a saved explicit false over the desktop platform default at boot', async () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: { panes: { floatingActionButton: false } },
    }))
    try {
      const { default: settingsReducer } = await importFreshSettingsSlice()
      const state = settingsReducer(undefined, { type: 'unknown' })
      expect(state.localSettings.panes.floatingActionButton).toBe(false)
    } finally {
      localStorage.removeItem(BROWSER_PREFERENCES_STORAGE_KEY)
    }
  })

  it('setServerSettings replaces serverSettings and recomputes the resolved view', async () => {
    const settingsSlice = await importFreshSettingsSlice()
    const {
      default: settingsReducer,
      defaultSettings,
      setServerSettings,
    } = settingsSlice
    type SettingsState = settingsSlice.SettingsState

    const initialState: SettingsState = settingsReducer(undefined, { type: 'unknown' })
    const nextServerSettings = {
      ...initialState.serverSettings,
      defaultCwd: '/workspace',
      terminal: {
        scrollback: 12000,
      },
      agentChat: {
        defaultPlugins: ['fs'],
      },
    }

    const state = settingsReducer(initialState, setServerSettings(nextServerSettings as never))

    expect(state.loaded).toBe(true)
    expect(state.serverSettings.defaultCwd).toBe('/workspace')
    expect(state.serverSettings.terminal.scrollback).toBe(12000)
    expect(state.serverSettings.freshAgent.defaultPlugins).toEqual([])
    expect('agentChat' in state.serverSettings).toBe(false)
    expect(state.settings).toEqual({
      ...defaultSettings,
      panes: {
        ...defaultSettings.panes,
        // jsdom boots desktop-ambient: the platform default is ON.
        floatingActionButton: true,
      },
      defaultCwd: '/workspace',
      terminal: {
        ...defaultSettings.terminal,
        scrollback: 12000,
      },
      freshAgent: {
        ...defaultSettings.freshAgent,
        defaultPlugins: [],
      },
    })
    expect('agentChat' in state.settings).toBe(false)
  })

  it('previewServerSettingsPatch only applies server-backed fields', async () => {
    const {
      default: settingsReducer,
      previewServerSettingsPatch,
    } = await importFreshSettingsSlice()

    const initialState = settingsReducer(undefined, { type: 'unknown' })
    const state = settingsReducer(initialState, previewServerSettingsPatch({
      defaultCwd: '/workspace',
      terminal: {
        scrollback: 12000,
      },
      theme: 'dark',
      sidebar: {
        sortMode: 'project',
      },
    } as any))

    expect(state.serverSettings.defaultCwd).toBe('/workspace')
    expect(state.settings.defaultCwd).toBe('/workspace')
    expect(state.serverSettings.terminal.scrollback).toBe(12000)
    expect(state.settings.terminal.scrollback).toBe(12000)
    expect(state.settings.theme).toBe(initialState.settings.theme)
    expect(state.settings.sidebar.sortMode).toBe(initialState.settings.sidebar.sortMode)
  })

  it('preserves runtime CLI providers when hydrating and previewing server settings', async () => {
    const {
      default: settingsReducer,
      setServerSettings,
      previewServerSettingsPatch,
    } = await importFreshSettingsSlice()

    const initialState = settingsReducer(undefined, { type: 'unknown' })
    const hydrated = settingsReducer(initialState, setServerSettings({
      ...initialState.serverSettings,
      codingCli: {
        ...initialState.serverSettings.codingCli,
        enabledProviders: ['claude', 'gemini'],
        knownProviders: ['claude', 'codex', 'opencode', 'gemini'],
        providers: {
          ...initialState.serverSettings.codingCli.providers,
          gemini: {
            cwd: '/workspace/gemini',
          },
        },
      },
    }))

    expect(hydrated.serverSettings.codingCli.enabledProviders).toEqual(['claude', 'gemini'])
    expect(hydrated.serverSettings.codingCli.knownProviders).toEqual(['claude', 'codex', 'opencode', 'gemini'])
    expect(hydrated.serverSettings.codingCli.providers.gemini).toEqual({
      cwd: '/workspace/gemini',
    })

    const previewed = settingsReducer(hydrated, previewServerSettingsPatch({
      codingCli: {
        providers: {
          gemini: {
            model: 'gemini-2.5-pro',
          },
        },
      },
    }))

    expect(previewed.serverSettings.codingCli.enabledProviders).toEqual(['claude', 'gemini'])
    expect(previewed.settings.codingCli.knownProviders).toEqual(['claude', 'codex', 'opencode', 'gemini'])
    expect(previewed.serverSettings.codingCli.providers.gemini).toEqual({
      cwd: '/workspace/gemini',
      model: 'gemini-2.5-pro',
    })
  })

  it('updateSettingsLocal only applies local fields', async () => {
    const {
      default: settingsReducer,
      updateSettingsLocal,
    } = await importFreshSettingsSlice()

    const initialState = settingsReducer(undefined, { type: 'unknown' })
    const state = settingsReducer(initialState, updateSettingsLocal({
      theme: 'dark',
      terminal: {
        fontSize: 18,
        scrollback: 9000,
      },
      defaultCwd: '/workspace',
      sidebar: {
        sortMode: 'project',
      },
    } as any))

    expect(state.localSettings.theme).toBe('dark')
    expect(state.settings.theme).toBe('dark')
    expect(state.localSettings.terminal.fontSize).toBe(18)
    expect(state.settings.terminal.fontSize).toBe(18)
    expect(state.settings.terminal.scrollback).toBe(initialState.settings.terminal.scrollback)
    expect(state.settings.defaultCwd).toBe(initialState.settings.defaultCwd)
    expect(state.settings.sidebar.sortMode).toBe('project')
  })

  it('applies the showTranscriptMinimap local setting and defaults it on', async () => {
    const {
      default: settingsReducer,
      updateSettingsLocal,
    } = await importFreshSettingsSlice()

    const initialState = settingsReducer(undefined, { type: 'unknown' })
    expect(initialState.localSettings.freshAgent.showTranscriptMinimap).toBe(true)
    expect(initialState.settings.freshAgent.showTranscriptMinimap).toBe(true)

    const state = settingsReducer(initialState, updateSettingsLocal({
      freshAgent: { showTranscriptMinimap: false },
    }))
    expect(state.localSettings.freshAgent.showTranscriptMinimap).toBe(false)
    expect(state.settings.freshAgent.showTranscriptMinimap).toBe(false)
    // Local patch only: server fields untouched.
    expect(state.serverSettings).toEqual(initialState.serverSettings)
  })

  it('markSaved updates lastSavedAt without disturbing split state', async () => {
    vi.useFakeTimers()
    const now = 1_700_000_000_000
    vi.setSystemTime(now)

    const {
      default: settingsReducer,
      markSaved,
    } = await importFreshSettingsSlice()

    const initialState = settingsReducer(undefined, { type: 'unknown' })
    const state = settingsReducer(initialState, markSaved())

    expect(state.lastSavedAt).toBe(now)
    expect(state.serverSettings).toEqual(initialState.serverSettings)
    expect(state.localSettings).toEqual(initialState.localSettings)
    expect(state.settings).toEqual(initialState.settings)

    vi.useRealTimers()
  })
})

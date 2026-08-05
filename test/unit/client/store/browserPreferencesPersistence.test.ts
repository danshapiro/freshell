import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import settingsReducer, { setLocalSettings, updateSettingsLocal } from '@/store/settingsSlice'
import tabRegistryReducer, { setTabRegistryClosedTabRetentionDays } from '@/store/tabRegistrySlice'
import {
  BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS,
  browserPreferencesPersistenceMiddleware,
  resetBrowserPreferencesFlushListenersForTests,
} from '@/store/browserPreferencesPersistence'
import {
  loadBrowserPreferencesRecord,
  resolveBrowserPreferenceSettings,
  seedBrowserPreferencesSettingsIfEmpty,
} from '@/lib/browser-preferences'
import { resetPersistBroadcastForTests } from '@/store/persistBroadcast'
import { BROWSER_PREFERENCES_STORAGE_KEY } from '@/store/storage-keys'
import { resolveLocalSettings } from '@shared/settings'

function createStore() {
  return configureStore({
    reducer: {
      settings: settingsReducer,
      tabRegistry: tabRegistryReducer,
    },
    middleware: (getDefault) => getDefault().concat(browserPreferencesPersistenceMiddleware),
  })
}

describe('browserPreferencesPersistence', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    resetBrowserPreferencesFlushListenersForTests()
    resetPersistBroadcastForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('persists setLocalSettings and closed tab retention changes into the browser-preferences blob', () => {
    const store = createStore()

    store.dispatch(setLocalSettings(resolveLocalSettings({
      theme: 'dark',
      terminal: {
        fontSize: 18,
      },
    })))
    store.dispatch(setTabRegistryClosedTabRetentionDays(14))

    expect(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        theme: 'dark',
        terminal: {
          fontSize: 18,
        },
      },
      tabs: {
        closedTabRetentionDays: 14,
      },
    })
  })

  it('debounces updateSettingsLocal writes and flushes them on pagehide', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      sidebar: {
        sortMode: 'project',
      },
    }))

    expect(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)).toBeNull()

    window.dispatchEvent(new Event('pagehide'))

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        sidebar: {
          sortMode: 'project',
        },
      },
    })
  })

  it('preserves the consumed seed marker when seeded settings are reset to defaults', () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: {
        theme: 'light',
      },
      legacyLocalSettingsSeedApplied: true,
    }))

    const store = createStore()

    store.dispatch(setLocalSettings(resolveLocalSettings()))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      legacyLocalSettingsSeedApplied: true,
    })

    expect(seedBrowserPreferencesSettingsIfEmpty({
      theme: 'light',
    })).toEqual({
      legacyLocalSettingsSeedApplied: true,
    })
  })

  it('does not write browser preferences for a skipPersist local update by itself', () => {
    const store = createStore()

    store.dispatch({
      ...updateSettingsLocal({
        sidebar: {
          collapsed: true,
        },
      }),
      meta: { skipPersist: true },
    })

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)
    expect(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)).toBeNull()
  })

  it('stops automatic retry loops after a storage write failure until another local change happens', () => {
    const store = createStore()
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError', 'QuotaExceededError')
    })

    store.dispatch(updateSettingsLocal({
      theme: 'dark',
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)
    expect(setItemSpy).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS * 5)
    expect(setItemSpy).toHaveBeenCalledTimes(1)

    store.dispatch(updateSettingsLocal({
      sidebar: {
        sortMode: 'project',
      },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)
    expect(setItemSpy).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS * 5)
    expect(setItemSpy).toHaveBeenCalledTimes(2)

    setItemSpy.mockRestore()
  })

  it('persists freshAgent.showThinking/showTools/showTimecodes to browser preferences', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { showThinking: true },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings.freshAgent).toEqual({ showThinking: true })
    expect(bp.settings.freshAgent.showTools).toBeUndefined()
    expect(bp.settings.freshAgent.showTimecodes).toBeUndefined()
    expect(bp.settings.agentChat).toBeUndefined()
  })

  it('persists all three freshAgent toggles when all are enabled', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { showThinking: true, showTools: true, showTimecodes: true },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings.freshAgent).toEqual({
      showThinking: true,
      showTools: true,
      showTimecodes: true,
    })
    expect(bp.settings.agentChat).toBeUndefined()
  })

  it('round-trips freshAgent settings through localStorage', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { showThinking: true, showTools: true },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const saved = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(saved.settings.freshAgent).toEqual({ showThinking: true, showTools: true })
    expect(saved.settings.agentChat).toBeUndefined()

    const rehydrated = resolveLocalSettings(saved.settings)
    expect(rehydrated.freshAgent.showThinking).toBe(true)
    expect(rehydrated.freshAgent.showTools).toBe(true)
    expect(rehydrated.freshAgent.showTimecodes).toBe(false)
    expect('agentChat' in rehydrated).toBe(false)
  })

  it('round-trips terminal.fontSize through localStorage', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      terminal: { fontSize: 22 },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const saved = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(saved.settings.terminal).toEqual({ fontSize: 22 })

    // Rehydrate the way the settings slice does when the app boots after a restart.
    const rehydrated = resolveLocalSettings(saved.settings)
    expect(rehydrated.terminal.fontSize).toBe(22)
  })

  it('persists a 64px terminal font size and round-trips it through a reload', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      terminal: { fontSize: 64 },
    }))

    expect(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const saved = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(saved).toEqual({
      settings: {
        terminal: {
          fontSize: 64,
        },
      },
    })

    // Reload simulation: the 64px ceiling value must survive rehydration intact.
    const rehydrated = resolveLocalSettings(saved.settings)
    expect(rehydrated.terminal.fontSize).toBe(64)
  })

  it('clamps an out-of-range terminal font size before persisting it', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      terminal: { fontSize: 999 },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        terminal: {
          fontSize: 64,
        },
      },
    })
  })

  it('clamps a stale out-of-range persisted font size to the 64px ceiling on load', () => {
    // Hand-written or legacy-max blob: 999px must clamp when the next session
    // reads the browser-preferences store at boot.
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: { terminal: { fontSize: 999 } },
    }))

    const record = loadBrowserPreferencesRecord()
    expect(record.settings).toEqual({ terminal: { fontSize: 64 } })
    expect(resolveBrowserPreferenceSettings(record).terminal.fontSize).toBe(64)
  })

  it('omits terminal.fontSize from browser preferences when reset to the 16px default', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      terminal: { fontSize: 64 },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        terminal: {
          fontSize: 64,
        },
      },
    })

    store.dispatch(updateSettingsLocal({
      terminal: { fontSize: 16 },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    // Default values are dropped so a stale 64px cannot linger into a reload.
    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({})
  })

  it('does not persist freshAgent when set to defaults', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { showThinking: false, showTools: false, showTimecodes: false },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings?.freshAgent).toBeUndefined()
    expect(bp.settings?.agentChat).toBeUndefined()
  })

  it('ignores removed freshAgent.fontScale values', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { fontScale: 1.75 },
    } as never))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings?.freshAgent).toBeUndefined()
    expect(bp.settings?.agentChat).toBeUndefined()
  })

  it('drops legacy freshAgent.fontScale records when rehydrating old preferences', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      freshAgent: { showTools: true },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    const rehydrated = resolveLocalSettings({
      ...bp.settings,
      freshAgent: { ...bp.settings.freshAgent, fontScale: 1.75 },
    } as never)
    expect(rehydrated.freshAgent.showTools).toBe(true)
    expect('fontScale' in rehydrated.freshAgent).toBe(false)
    expect('agentChat' in rehydrated).toBe(false)
  })

  it('removes a seeded deprecated freshAgent.fontScale on the next settings save', () => {
    // Seed browser preferences the way a pre-removal client wrote them: supported
    // rich-agent sizing (terminal.fontSize) plus the deprecated freshAgent.fontScale.
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: {
        terminal: {
          fontSize: 20,
        },
        freshAgent: {
          showTools: true,
          fontScale: 2,
        },
      },
    }))

    const store = createStore()

    // Launch: hydrate local settings from the seeded browser preferences.
    store.dispatch(setLocalSettings(resolveBrowserPreferenceSettings(loadBrowserPreferencesRecord())))

    // The deprecated key never reaches store state; supported sizing applies.
    expect(store.getState().settings.localSettings.terminal.fontSize).toBe(20)
    expect(store.getState().settings.localSettings.freshAgent).toEqual({
      showThinking: false,
      showTools: true,
      showTimecodes: false,
    })
    expect('fontScale' in store.getState().settings.settings.freshAgent).toBe(false)

    // Perform a settings save.
    store.dispatch(updateSettingsLocal({
      freshAgent: {
        showThinking: true,
      },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    // The persisted blob is rebuilt without the stale key while supported
    // rich-agent sizing and settings survive the round-trip.
    const saved = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(saved).toEqual({
      settings: {
        terminal: {
          fontSize: 20,
        },
        freshAgent: {
          showThinking: true,
          showTools: true,
        },
      },
    })
    expect(JSON.stringify(saved)).not.toContain('fontScale')
  })

  it('persists a 400% uiScale and round-trips it through a reload', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      uiScale: 4,
    }))

    expect(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const saved = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(saved).toEqual({
      settings: {
        uiScale: 4,
      },
    })

    // Reload simulation: rehydrate fresh local settings from the saved blob.
    const rehydrated = resolveLocalSettings(saved.settings)
    expect(rehydrated.uiScale).toBe(4)
  })

  it('clamps an out-of-range uiScale before persisting it', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      uiScale: 999,
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')).toEqual({
      settings: {
        uiScale: 4,
      },
    })
  })

  it('omits uiScale from browser preferences when reset to the 100% default', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      uiScale: 1,
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings?.uiScale).toBeUndefined()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'

import settingsReducer, { setLocalSettings, updateSettingsLocal } from '@/store/settingsSlice'
import tabRegistryReducer, { setTabRegistrySearchRangeDays } from '@/store/tabRegistrySlice'
import {
  BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS,
  browserPreferencesPersistenceMiddleware,
  resetBrowserPreferencesFlushListenersForTests,
} from '@/store/browserPreferencesPersistence'
import { seedBrowserPreferencesSettingsIfEmpty } from '@/lib/browser-preferences'
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

  it('persists setLocalSettings and tab search range changes into the browser-preferences blob', () => {
    const store = createStore()

    store.dispatch(setLocalSettings(resolveLocalSettings({
      theme: 'dark',
      terminal: {
        fontSize: 18,
      },
    })))
    store.dispatch(setTabRegistrySearchRangeDays(90))

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
        searchRangeDays: 90,
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

  it('persists agentChat.showThinking/showTools/showTimecodes to browser preferences', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      agentChat: { showThinking: true },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings.agentChat).toEqual({ showThinking: true })
    expect(bp.settings.agentChat.showTools).toBeUndefined()
    expect(bp.settings.agentChat.showTimecodes).toBeUndefined()
  })

  it('persists all three agentChat toggles when all are enabled', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      agentChat: { showThinking: true, showTools: true, showTimecodes: true },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings.agentChat).toEqual({
      showThinking: true,
      showTools: true,
      showTimecodes: true,
    })
  })

  it('round-trips agentChat settings through localStorage', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      agentChat: { showThinking: true, showTools: true },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const saved = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(saved.settings.agentChat).toEqual({ showThinking: true, showTools: true })

    const rehydrated = resolveLocalSettings(saved.settings)
    expect(rehydrated.agentChat.showThinking).toBe(true)
    expect(rehydrated.agentChat.showTools).toBe(true)
    expect(rehydrated.agentChat.showTimecodes).toBe(false)
  })

  it('does not persist agentChat when set to defaults', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({
      agentChat: { showThinking: false, showTools: false, showTimecodes: false },
    }))

    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const bp = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(bp.settings?.agentChat).toBeUndefined()
  })
})

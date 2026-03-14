import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BROWSER_PREFERENCES_STORAGE_KEY,
  getSearchRangeDaysPreference,
  getToolStripExpandedPreference,
  loadBrowserPreferencesRecord,
  patchBrowserPreferencesRecord,
  seedBrowserPreferencesSettingsIfEmpty,
} from '@/lib/browser-preferences'

describe('browser preferences', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('loads a sparse record from one versioned browser-preferences blob', () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: {
        theme: 'dark',
        terminal: {
          fontSize: 18,
        },
      },
      tabs: {
        searchRangeDays: 90,
      },
    }))

    expect(loadBrowserPreferencesRecord()).toEqual({
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

  it('migrates legacy font and tool-strip keys into the new blob once', () => {
    localStorage.setItem('freshell.terminal.fontFamily.v1', 'Fira Code')
    localStorage.setItem('freshell:toolStripExpanded', 'true')

    expect(loadBrowserPreferencesRecord()).toEqual({
      settings: {
        terminal: {
          fontFamily: 'Fira Code',
        },
      },
      toolStrip: {
        expanded: true,
      },
    })
    expect(localStorage.getItem('freshell.terminal.fontFamily.v1')).toBeNull()
    expect(localStorage.getItem('freshell:toolStripExpanded')).toBeNull()
    expect(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)).toBe(JSON.stringify({
      settings: {
        terminal: {
          fontFamily: 'Fira Code',
        },
      },
      toolStrip: {
        expanded: true,
      },
    }))
  })

  it('keeps legacy keys when migrating into the new blob fails to save', () => {
    localStorage.setItem('freshell.terminal.fontFamily.v1', 'Fira Code')
    localStorage.setItem('freshell:toolStripExpanded', 'true')

    const originalSetItem = Storage.prototype.setItem
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key: string, value: string) {
      if (key === BROWSER_PREFERENCES_STORAGE_KEY) {
        throw new Error('quota exceeded')
      }
      return originalSetItem.call(this, key, value)
    })

    expect(loadBrowserPreferencesRecord()).toEqual({
      settings: {
        terminal: {
          fontFamily: 'Fira Code',
        },
      },
      toolStrip: {
        expanded: true,
      },
    })
    expect(localStorage.getItem('freshell.terminal.fontFamily.v1')).toBe('Fira Code')
    expect(localStorage.getItem('freshell:toolStripExpanded')).toBe('true')
    expect(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)).toBeNull()

    setItemSpy.mockRestore()
  })

  it('fills missing seeded values without overwriting existing local settings', () => {
    localStorage.setItem('freshell.terminal.fontFamily.v1', 'Fira Code')
    expect(loadBrowserPreferencesRecord()).toEqual({
      settings: {
        terminal: {
          fontFamily: 'Fira Code',
        },
      },
    })

    expect(seedBrowserPreferencesSettingsIfEmpty({
      theme: 'light',
      terminal: {
        fontFamily: 'JetBrains Mono',
      },
      sidebar: {
        showSubagents: true,
      },
    })).toEqual({
      settings: {
        theme: 'light',
        terminal: {
          fontFamily: 'Fira Code',
        },
        sidebar: {
          showSubagents: true,
        },
      },
      legacyLocalSettingsSeedApplied: true,
    })
  })

  it('does not reapply a legacy seed after it has already been consumed', () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      legacyLocalSettingsSeedApplied: true,
    }))

    expect(seedBrowserPreferencesSettingsIfEmpty({
      theme: 'light',
    })).toEqual({
      legacyLocalSettingsSeedApplied: true,
    })
  })

  it('reads tool-strip and search-range preferences from the new blob', () => {
    patchBrowserPreferencesRecord({
      toolStrip: {
        expanded: true,
      },
      tabs: {
        searchRangeDays: 365,
      },
    })

    expect(getToolStripExpandedPreference()).toBe(true)
    expect(getSearchRangeDaysPreference()).toBe(365)
  })
})

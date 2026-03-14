import { beforeEach, describe, expect, it } from 'vitest'

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

  it('seedBrowserPreferencesSettingsIfEmpty fills only a missing settings payload', () => {
    expect(seedBrowserPreferencesSettingsIfEmpty({
      terminal: {
        fontFamily: 'Fira Code',
      },
    })).toEqual({
      settings: {
        terminal: {
          fontFamily: 'Fira Code',
        },
      },
    })

    expect(seedBrowserPreferencesSettingsIfEmpty({
      theme: 'dark',
    })).toEqual({
      settings: {
        terminal: {
          fontFamily: 'Fira Code',
        },
      },
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

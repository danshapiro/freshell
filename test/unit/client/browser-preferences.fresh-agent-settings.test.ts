import { beforeEach, describe, expect, it } from 'vitest'

import {
  BROWSER_PREFERENCES_STORAGE_KEY,
  loadBrowserPreferencesRecord,
  patchBrowserPreferencesRecord,
  resolveBrowserPreferenceSettings,
} from '@/lib/browser-preferences'

describe('browser preferences fresh-agent settings compatibility', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('loads browser-local settings seeded with agentChat as canonical freshAgent', () => {
    localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify({
      settings: {
        agentChat: {
          showTools: true,
          showThinking: true,
          fontScale: 1.25,
        },
      },
    }))

    const record = loadBrowserPreferencesRecord()
    const resolved = resolveBrowserPreferenceSettings(record)

    expect(record.settings).toEqual({
      freshAgent: {
        showTools: true,
        showThinking: true,
      },
    })
    expect(resolved.freshAgent.showTools).toBe(true)
    expect(resolved.freshAgent.showThinking).toBe(true)
    expect('fontScale' in resolved.freshAgent).toBe(false)
    expect('agentChat' in (record.settings ?? {})).toBe(false)
    expect('agentChat' in resolved).toBe(false)
  })

  it('saves browser preferences with only freshAgent settings', () => {
    patchBrowserPreferencesRecord({
      settings: {
        agentChat: {
          showTools: true,
          fontScale: 1.25,
        },
      },
    } as never)

    const raw = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) ?? '{}')

    expect(raw.settings).toEqual({
      freshAgent: {
        showTools: true,
      },
    })
    expect(raw.settings.agentChat).toBeUndefined()
  })

  it('drops a seeded canonical freshAgent.fontScale at load while keeping supported settings', () => {
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

    const record = loadBrowserPreferencesRecord()
    const resolved = resolveBrowserPreferenceSettings(record)

    expect(record.settings).toEqual({
      terminal: {
        fontSize: 20,
      },
      freshAgent: {
        showTools: true,
      },
    })
    // Passive dropping: the raw record is not rewritten by a load alone; the
    // stale key self-heals on the next persistence write.
    expect(JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) ?? '{}').settings.freshAgent)
      .toEqual({ showTools: true, fontScale: 2 })
    // Supported rich-agent sizing comes from terminal.fontSize and survives untouched.
    expect(resolved.terminal.fontSize).toBe(20)
    expect(resolved.freshAgent).toEqual({
      showThinking: false,
      showTools: true,
      showTimecodes: false,
    })
    expect('fontScale' in resolved.freshAgent).toBe(false)
  })

  it('never writes a canonical freshAgent.fontScale back on save', () => {
    patchBrowserPreferencesRecord({
      settings: {
        freshAgent: {
          showThinking: true,
          fontScale: 1.75,
        },
      },
    } as never)

    const raw = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) ?? '{}')

    expect(raw.settings).toEqual({
      freshAgent: {
        showThinking: true,
      },
    })
    expect(JSON.stringify(raw)).not.toContain('fontScale')
  })
})

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
})

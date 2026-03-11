import { describe, it, expect } from 'vitest'
import {
  migrateLegacyDefaultEnabledProviders,
  migrateSettingsSortMode,
} from '../../../server/settings-migrate'

describe('migrateSettingsSortMode', () => {
  it('converts hybrid sortMode to activity', () => {
    const settings = { sidebar: { sortMode: 'hybrid' } }

    const migrated = migrateSettingsSortMode(settings)

    expect(migrated.sidebar.sortMode).toBe('activity')
    expect(settings.sidebar.sortMode).toBe('hybrid')
  })

  it('preserves valid sort modes', () => {
    const settings = { sidebar: { sortMode: 'recency' } }

    const migrated = migrateSettingsSortMode(settings)

    expect(migrated.sidebar.sortMode).toBe('recency')
  })

  it('preserves recency-pinned sort mode', () => {
    const settings = { sidebar: { sortMode: 'recency-pinned' } }

    const migrated = migrateSettingsSortMode(settings)

    expect(migrated.sidebar.sortMode).toBe('recency-pinned')
  })

  it('handles missing or invalid sidebar safely', () => {
    expect(migrateSettingsSortMode(undefined as any)).toBeUndefined()
    expect(migrateSettingsSortMode(null as any)).toBeNull()
    expect(migrateSettingsSortMode({})).toEqual({})
    expect(migrateSettingsSortMode({ sidebar: null })).toEqual({ sidebar: null })
  })
})

describe('migrateLegacyDefaultEnabledProviders', () => {
  it('adds opencode when the user is still on the untouched legacy defaults', () => {
    const settings = {
      codingCli: {
        enabledProviders: ['claude', 'codex'],
        knownProviders: ['claude', 'codex', 'opencode'],
      },
    }

    const migrated = migrateLegacyDefaultEnabledProviders(settings, ['claude', 'codex', 'opencode'])

    expect(migrated).toEqual({
      codingCli: {
        enabledProviders: ['claude', 'codex', 'opencode'],
        knownProviders: ['claude', 'codex', 'opencode'],
      },
    })
    expect(settings.codingCli.enabledProviders).toEqual(['claude', 'codex'])
  })

  it('preserves explicit provider customizations', () => {
    const settings = {
      codingCli: {
        enabledProviders: ['claude'],
        knownProviders: ['claude', 'codex', 'opencode'],
      },
    }

    expect(migrateLegacyDefaultEnabledProviders(settings, ['claude', 'codex', 'opencode'])).toBe(settings)
  })

  it('does nothing when opencode is not registered in the running extension set', () => {
    const settings = {
      codingCli: {
        enabledProviders: ['claude', 'codex'],
      },
    }

    expect(migrateLegacyDefaultEnabledProviders(settings, ['claude', 'codex'])).toBe(settings)
  })
})

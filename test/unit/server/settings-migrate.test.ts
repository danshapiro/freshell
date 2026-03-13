import { describe, it, expect } from 'vitest'
import {
  migrateLegacyDefaultEnabledProviders,
  migrateSettingsSortMode,
} from '../../../server/settings-migrate'

describe('migrateSettingsSortMode', () => {
  it('leaves legacy local sort modes untouched on the server migration path', () => {
    const settings = { sidebar: { sortMode: 'hybrid' } }

    const migrated = migrateSettingsSortMode(settings)

    expect(migrated).toBe(settings)
    expect(migrated.sidebar.sortMode).toBe('hybrid')
    expect(settings.sidebar.sortMode).toBe('hybrid')
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

  it('keeps migration helpers pure and does not mutate the input object', () => {
    const settings = {
      codingCli: {
        enabledProviders: ['claude', 'codex'],
        knownProviders: ['claude', 'codex', 'opencode'],
      },
    }

    void migrateLegacyDefaultEnabledProviders(settings, ['claude', 'codex', 'opencode'])

    expect(settings).toEqual({
      codingCli: {
        enabledProviders: ['claude', 'codex'],
        knownProviders: ['claude', 'codex', 'opencode'],
      },
    })
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

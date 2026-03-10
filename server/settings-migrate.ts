import {
  DEFAULT_ENABLED_CLI_PROVIDERS,
  LEGACY_DEFAULT_ENABLED_CLI_PROVIDERS,
} from '../shared/coding-cli-defaults.js'
import { normalizeTrimmedStringList } from '../shared/string-list.js'

type AnySettings = Record<string, any>

export function migrateSettingsSortMode<T extends AnySettings | null | undefined>(settings: T): T {
  if (!settings || typeof settings !== 'object') {
    return settings
  }

  const sidebar = (settings as AnySettings).sidebar
  if (!sidebar || typeof sidebar !== 'object') {
    return settings
  }

  if (sidebar.sortMode !== 'hybrid') {
    return settings
  }

  return {
    ...settings,
    sidebar: {
      ...sidebar,
      sortMode: 'activity',
    },
  } as T
}

function hasSameMembers(values: string[], expected: readonly string[]): boolean {
  return values.length === expected.length && expected.every((value) => values.includes(value))
}

export function migrateLegacyDefaultEnabledProviders<T extends AnySettings | null | undefined>(
  settings: T,
  availableCliNames: readonly string[],
): T {
  if (!settings || typeof settings !== 'object') {
    return settings
  }

  const codingCli = (settings as AnySettings).codingCli
  if (!codingCli || typeof codingCli !== 'object') {
    return settings
  }

  const enabledProviders = normalizeTrimmedStringList(codingCli.enabledProviders)
  if (!hasSameMembers(enabledProviders, LEGACY_DEFAULT_ENABLED_CLI_PROVIDERS)) {
    return settings
  }

  const additionalProviders = DEFAULT_ENABLED_CLI_PROVIDERS.filter(
    (provider) => availableCliNames.includes(provider) && !enabledProviders.includes(provider),
  )
  if (additionalProviders.length === 0) {
    return settings
  }

  return {
    ...settings,
    codingCli: {
      ...codingCli,
      enabledProviders: [...enabledProviders, ...additionalProviders],
    },
  } as T
}

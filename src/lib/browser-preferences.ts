import {
  extractLegacyLocalSettingsSeed,
  mergeLocalSettings,
  resolveLocalSettings,
  type LocalSettings,
  type LocalSettingsPatch,
} from '@shared/settings'
import { BROWSER_PREFERENCES_STORAGE_KEY as STORAGE_KEY } from '@/store/storage-keys'

export const BROWSER_PREFERENCES_STORAGE_KEY = STORAGE_KEY

const LEGACY_TERMINAL_FONT_KEY = 'freshell.terminal.fontFamily.v1'
const LEGACY_TOOL_STRIP_STORAGE_KEY = 'freshell:toolStripExpanded'
const DEFAULT_SEARCH_RANGE_DAYS = 30

export type BrowserPreferencesRecord = {
  settings?: LocalSettingsPatch
  toolStrip?: { expanded?: boolean }
  tabs?: { searchRangeDays?: number }
}

function canUseStorage(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeRecord(value: unknown): BrowserPreferencesRecord {
  if (!isRecord(value)) {
    return {}
  }

  const normalized: BrowserPreferencesRecord = {}
  const settings = isRecord(value.settings) ? extractLegacyLocalSettingsSeed(value.settings) : undefined
  if (settings) {
    normalized.settings = settings
  }

  if (isRecord(value.toolStrip) && typeof value.toolStrip.expanded === 'boolean') {
    normalized.toolStrip = { expanded: value.toolStrip.expanded }
  }

  if (
    isRecord(value.tabs)
    && typeof value.tabs.searchRangeDays === 'number'
    && Number.isFinite(value.tabs.searchRangeDays)
    && value.tabs.searchRangeDays >= 1
  ) {
    normalized.tabs = { searchRangeDays: Math.floor(value.tabs.searchRangeDays) }
  }

  return normalized
}

function saveRecord(record: BrowserPreferencesRecord): BrowserPreferencesRecord {
  if (!canUseStorage()) {
    return record
  }

  try {
    window.localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, JSON.stringify(record))
  } catch {
    // Ignore storage failures and return the in-memory value.
  }
  return record
}

function migrateLegacyKeys(record: BrowserPreferencesRecord): BrowserPreferencesRecord {
  if (!canUseStorage()) {
    return record
  }

  let next = record
  let changed = false

  try {
    const legacyFont = window.localStorage.getItem(LEGACY_TERMINAL_FONT_KEY)?.trim()
    if (legacyFont) {
      const currentFontFamily = next.settings?.terminal?.fontFamily
      if (!currentFontFamily) {
        next = {
          ...next,
          settings: mergeLocalSettings(next.settings, {
            terminal: { fontFamily: legacyFont },
          }),
        }
        changed = true
      }
      window.localStorage.removeItem(LEGACY_TERMINAL_FONT_KEY)
      changed = true
    }

    const legacyToolStrip = window.localStorage.getItem(LEGACY_TOOL_STRIP_STORAGE_KEY)
    if (legacyToolStrip === 'true' || legacyToolStrip === 'false') {
      if (next.toolStrip?.expanded === undefined) {
        next = {
          ...next,
          toolStrip: { expanded: legacyToolStrip === 'true' },
        }
        changed = true
      }
      window.localStorage.removeItem(LEGACY_TOOL_STRIP_STORAGE_KEY)
      changed = true
    }
  } catch {
    return record
  }

  return changed ? saveRecord(next) : next
}

export function parseBrowserPreferencesRaw(raw: string): BrowserPreferencesRecord | null {
  try {
    return normalizeRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

export function loadBrowserPreferencesRecord(): BrowserPreferencesRecord {
  if (!canUseStorage()) {
    return {}
  }

  let record: BrowserPreferencesRecord = {}
  try {
    const raw = window.localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)
    record = raw ? (parseBrowserPreferencesRaw(raw) ?? {}) : {}
  } catch {
    record = {}
  }

  return migrateLegacyKeys(record)
}

export function patchBrowserPreferencesRecord(patch: BrowserPreferencesRecord): BrowserPreferencesRecord {
  const current = loadBrowserPreferencesRecord()
  let next: BrowserPreferencesRecord = { ...current }

  if (isRecord(patch.settings)) {
    const normalizedSettings = extractLegacyLocalSettingsSeed(patch.settings)
    if (normalizedSettings) {
      next = {
        ...next,
        settings: mergeLocalSettings(current.settings, normalizedSettings),
      }
    }
  }

  if (isRecord(patch.toolStrip) && typeof patch.toolStrip.expanded === 'boolean') {
    next = {
      ...next,
      toolStrip: {
        ...(current.toolStrip || {}),
        expanded: patch.toolStrip.expanded,
      },
    }
  }

  if (
    isRecord(patch.tabs)
    && typeof patch.tabs.searchRangeDays === 'number'
    && Number.isFinite(patch.tabs.searchRangeDays)
    && patch.tabs.searchRangeDays >= 1
  ) {
    next = {
      ...next,
      tabs: {
        ...(current.tabs || {}),
        searchRangeDays: Math.floor(patch.tabs.searchRangeDays),
      },
    }
  }

  return saveRecord(next)
}

export function seedBrowserPreferencesSettingsIfEmpty(seed: LocalSettingsPatch): BrowserPreferencesRecord {
  const current = loadBrowserPreferencesRecord()
  if (current.settings !== undefined) {
    return current
  }

  const normalizedSeed = extractLegacyLocalSettingsSeed(seed as Record<string, unknown>)
  if (!normalizedSeed) {
    return current
  }

  return saveRecord({
    ...current,
    settings: normalizedSeed,
  })
}

export function resolveBrowserPreferenceSettings(record?: BrowserPreferencesRecord): LocalSettings {
  return resolveLocalSettings(record?.settings)
}

export function getToolStripExpandedPreference(): boolean {
  return loadBrowserPreferencesRecord().toolStrip?.expanded ?? false
}

export function setToolStripExpandedPreference(expanded: boolean): void {
  patchBrowserPreferencesRecord({
    toolStrip: { expanded },
  })

  if (!canUseStorage()) {
    return
  }

  try {
    window.dispatchEvent(new StorageEvent('storage', { key: BROWSER_PREFERENCES_STORAGE_KEY }))
  } catch {
    window.dispatchEvent(new Event('storage'))
  }
}

export function getSearchRangeDaysPreference(): number {
  return loadBrowserPreferencesRecord().tabs?.searchRangeDays ?? DEFAULT_SEARCH_RANGE_DAYS
}

export function subscribeToolStripPreference(listener: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {}
  }

  const handler = (event: Event) => {
    if (event instanceof StorageEvent && event.key && event.key !== BROWSER_PREFERENCES_STORAGE_KEY) {
      return
    }
    listener()
  }

  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

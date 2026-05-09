// ============================================================
// localStorage Migration
// ============================================================
// This module MUST be imported before any slices that load from localStorage.
// When the persisted state schema changes in breaking ways, we increment
// STORAGE_VERSION to trigger a full clear on the next load.
//
// Increment STORAGE_VERSION when:
// - Tab/Pane structure changes
// - Coding CLI event schema changes (session.init → session.start, etc.)
// - Composite key format changes (provider:sessionId)
// - Any persisted state shape changes incompatibly
// ============================================================

import { createLogger } from '@/lib/client-logger'
import { clearAuthCookie } from '@/lib/auth'
import { BROWSER_PREFERENCES_STORAGE_KEY } from './storage-keys'
import {
  LAYOUT_STORAGE_KEY,
  PANES_SCHEMA_VERSION,
  LAYOUT_SCHEMA_VERSION,
  PANES_STORAGE_KEY,
  TABS_STORAGE_KEY,
  migrateV2ToV3,
  parsePersistedLayoutRaw,
} from './persistedState'

const log = createLogger('StorageMigration')

const STORAGE_VERSION = 5
const STORAGE_VERSION_KEY = 'freshell_version'
const AUTH_STORAGE_KEY = 'freshell.auth-token'
const LEGACY_BROWSER_PREFERENCE_KEYS = [
  'freshell.terminal.fontFamily.v1',
] as const
const LEGACY_STORAGE_KEYS = [
  'freshell.tabs.v1',
  'freshell.panes.v1',
] as const

function readStorageVersion(): number {
  const stored = localStorage.getItem(STORAGE_VERSION_KEY)
  if (!stored) return 0
  const parsed = Number.parseInt(stored, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function migrateBrowserPreferencesRecord(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const legacySettings = parsed.settings
    if (!legacySettings || typeof legacySettings !== 'object' || Array.isArray(legacySettings)) {
      return undefined
    }
    const nextSettings = { ...legacySettings } as Record<string, unknown>
    if (
      !Object.prototype.hasOwnProperty.call(nextSettings, 'freshAgent')
      && Object.prototype.hasOwnProperty.call(nextSettings, 'agentChat')
    ) {
      nextSettings.freshAgent = nextSettings.agentChat
    }
    return JSON.stringify({
      ...parsed,
      settings: nextSettings,
    })
  } catch {
    return undefined
  }
}

function migrateLegacyBrowserPreferenceKeys(): string | undefined {
  const legacyFont = localStorage.getItem('freshell.terminal.fontFamily.v1')?.trim()
  if (!legacyFont) {
    return undefined
  }

  return JSON.stringify({
    settings: {
      terminal: {
        fontFamily: legacyFont,
      },
    },
  })
}

function migrateLayoutRecord(raw: string): string | undefined {
  const parsed = parsePersistedLayoutRaw(raw)
  if (!parsed) {
    return undefined
  }

  return JSON.stringify({
    version: LAYOUT_SCHEMA_VERSION,
    tabs: parsed.tabs,
    panes: {
      version: Math.max(parsed.panes.version, PANES_SCHEMA_VERSION),
      layouts: parsed.panes.layouts,
      activePane: parsed.panes.activePane,
      paneTitles: parsed.panes.paneTitles,
      paneTitleSetByUser: parsed.panes.paneTitleSetByUser,
    },
    tombstones: parsed.tombstones,
    ...(typeof parsed.persistedAt === 'number' ? { persistedAt: parsed.persistedAt } : {}),
  })
}

export function runStorageMigration(): void {
  try {
    const currentVersion = readStorageVersion()
    if (currentVersion >= STORAGE_VERSION) return

    if (!localStorage.getItem(AUTH_STORAGE_KEY)) {
      clearAuthCookie()
    }

    const existingLayout = localStorage.getItem(LAYOUT_STORAGE_KEY)
    let hasValidLayout = false
    if (existingLayout) {
      const migratedLayout = migrateLayoutRecord(existingLayout)
      if (migratedLayout) {
        localStorage.setItem(LAYOUT_STORAGE_KEY, migratedLayout)
        hasValidLayout = true
      }
    }
    if (!hasValidLayout) {
      hasValidLayout = !!migrateV2ToV3()
    } else {
      localStorage.removeItem(TABS_STORAGE_KEY)
      localStorage.removeItem(PANES_STORAGE_KEY)
    }

    const browserPreferences = localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY)
    if (browserPreferences) {
      const migratedPreferences = migrateBrowserPreferencesRecord(browserPreferences)
      if (migratedPreferences) {
        localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, migratedPreferences)
      }
    } else {
      const migratedPreferences = migrateLegacyBrowserPreferenceKeys()
      if (migratedPreferences) {
        localStorage.setItem(BROWSER_PREFERENCES_STORAGE_KEY, migratedPreferences)
      }
    }

    for (const key of LEGACY_STORAGE_KEYS) {
      localStorage.removeItem(key)
    }
    for (const key of LEGACY_BROWSER_PREFERENCE_KEYS) {
      localStorage.removeItem(key)
    }

    localStorage.setItem(STORAGE_VERSION_KEY, String(STORAGE_VERSION))
    log.info(`Migrated localStorage in place (version ${currentVersion} → ${STORAGE_VERSION}).`)
  } catch (err) {
    log.warn('Storage migration failed:', err)
  }
}

// Execute immediately when this module is imported
runStorageMigration()

export {} // Make this a module

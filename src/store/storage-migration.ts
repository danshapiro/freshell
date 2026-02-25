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

const log = createLogger('StorageMigration')

const STORAGE_VERSION = 3
const STORAGE_VERSION_KEY = 'freshell_version'
const AUTH_STORAGE_KEY = 'freshell.auth-token'

function readStorageVersion(): number {
  const stored = localStorage.getItem(STORAGE_VERSION_KEY)
  if (!stored) return 0
  const parsed = Number.parseInt(stored, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function clearFreshellKeysExcept(keep: string[]): void {
  const keepSet = new Set(keep)
  for (const key of Object.keys(localStorage)) {
    if ((key.startsWith('freshell.') || key === STORAGE_VERSION_KEY) && !keepSet.has(key)) {
      localStorage.removeItem(key)
    }
  }
}

export function runStorageMigration(): void {
  try {
    const currentVersion = readStorageVersion()
    if (currentVersion >= STORAGE_VERSION) return

    const preservedAuthToken = localStorage.getItem(AUTH_STORAGE_KEY)
    clearFreshellKeysExcept([AUTH_STORAGE_KEY])

    if (preservedAuthToken) {
      localStorage.setItem(AUTH_STORAGE_KEY, preservedAuthToken)
    } else {
      clearAuthCookie()
    }

    localStorage.setItem(STORAGE_VERSION_KEY, String(STORAGE_VERSION))
    log.info(
      `Cleared localStorage (version ${currentVersion} → ${STORAGE_VERSION}) ` +
      'while preserving auth token continuity.'
    )
  } catch (err) {
    log.warn('Storage migration failed:', err)
  }
}

// Execute immediately when this module is imported
runStorageMigration()

export {} // Make this a module

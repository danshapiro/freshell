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

const STORAGE_VERSION = 2 // Incremented for multi-CLI architecture

function runStorageMigration() {
  try {
    const stored = localStorage.getItem('freshell_version')
    const currentVersion = stored ? parseInt(stored, 10) : 0

    if (currentVersion < STORAGE_VERSION) {
      // Clear all Freshell data
      const keysToRemove = Object.keys(localStorage).filter(
        (k) => k.startsWith('freshell.') || k === 'freshell_version'
      )
      keysToRemove.forEach((k) => localStorage.removeItem(k))

      localStorage.setItem('freshell_version', String(STORAGE_VERSION))

      console.log(
        `[Storage Migration] Cleared localStorage (version ${currentVersion} → ${STORAGE_VERSION}) ` +
        'due to breaking state schema changes.'
      )
    }
  } catch (err) {
    console.warn('[Storage Migration] Failed:', err)
  }
}

// Execute immediately when this module is imported
runStorageMigration()

export {} // Make this a module

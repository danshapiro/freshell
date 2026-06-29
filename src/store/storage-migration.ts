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
import {
  LAYOUT_FRESH_AGENT_BACKUP_KEY,
  LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY,
  LAYOUT_FRESH_AGENT_MIGRATION_ID,
  LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY,
  LAYOUT_SCHEMA_VERSION,
  PANES_SCHEMA_VERSION,
  hashPersistedLayoutRaw,
  migrateV2ToV3,
  parseLayoutFreshAgentCommitMarker,
  readRecoverablePersistedLayoutRaw,
} from './persistedState'
import { BROWSER_PREFERENCES_STORAGE_KEY, LAYOUT_STORAGE_KEY } from './storage-keys'
import {
  buildRestoreError,
  migrateLegacyTerminalDurableState,
  type RestoreError,
  sanitizeSessionRef,
} from '@shared/session-contract'
import { sanitizeCodexDurabilityRef } from '@shared/codex-durability'
import { migrateLegacyFreshAgentContent, migrateLegacyFreshAgentDurableState } from '@shared/fresh-agent'
import { normalizeFreshAgentPaneModelSelection } from './paneTypes'

const log = createLogger('StorageMigration')

const STORAGE_VERSION = 5
const STORAGE_VERSION_KEY = 'freshell_version'
const AUTH_STORAGE_KEY = 'freshell.auth-token'
const LEGACY_BROWSER_PREFERENCE_KEYS = [
  'freshell.terminal.fontFamily.v1',
] as const

type PersistedLayoutMigrationResult = 'none' | 'migrated' | 'failed'

function warnStructured(event: string, details: Record<string, unknown>): void {
  log.warn(JSON.stringify({
    severity: 'warn',
    component: 'storage-migration',
    event,
    ...details,
  }))
}

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

function normalizeLayoutTab(tab: Record<string, unknown>): Record<string, unknown> {
  const mode = typeof tab.mode === 'string' ? tab.mode : undefined
  const codingCliProvider = typeof tab.codingCliProvider === 'string' ? tab.codingCliProvider : undefined
  const provider = codingCliProvider || (mode && mode !== 'shell' ? mode : undefined)
  const durableState = migrateLegacyTerminalDurableState({
    provider,
    sessionRef: tab.sessionRef,
    resumeSessionId: typeof tab.resumeSessionId === 'string' ? tab.resumeSessionId : undefined,
  })
  const codexDurability = sanitizeCodexDurabilityRef(tab.codexDurability)
  const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, ...rest } = tab
  return {
    ...rest,
    ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
    ...(codexDurability ? { codexDurability } : {}),
  }
}

function isCodexSessionRef(sessionRef: unknown): sessionRef is { provider: 'codex'; sessionId: string } {
  return !!sessionRef
    && typeof sessionRef === 'object'
    && (sessionRef as { provider?: unknown }).provider === 'codex'
    && typeof (sessionRef as { sessionId?: unknown }).sessionId === 'string'
    && (sessionRef as { sessionId: string }).sessionId.length > 0
}

function normalizeLegacyRecoveryFailedTerminal(
  content: Record<string, unknown>,
  durableState: { sessionRef?: unknown },
): Record<string, unknown> {
  if (content.kind !== 'terminal' || content.mode !== 'codex' || content.status !== 'recovery_failed') {
    return content
  }

  const {
    terminalId: _terminalId,
    status: _status,
    restoreError: _restoreError,
    ...rest
  } = content
  if (isCodexSessionRef(durableState.sessionRef)) {
    return {
      ...rest,
      status: 'creating',
    }
  }

  return {
    ...rest,
    status: 'error',
    restoreError: buildRestoreError('invalid_legacy_restore_target'),
  }
}

function readRestoreError(value: unknown): RestoreError | undefined {
  return (
    value
    && typeof value === 'object'
    && (value as any).code === 'RESTORE_UNAVAILABLE'
    && typeof (value as any).reason === 'string'
  )
    ? value as RestoreError
    : undefined
}

function hasFreshAgentLayoutMigrationMarkerForCurrentRaw(): boolean {
  const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
  if (!raw) return false
  const marker = parseLayoutFreshAgentCommitMarker(localStorage.getItem(LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY))
  return marker?.migratedHash === hashPersistedLayoutRaw(raw)
}

function normalizeLayoutNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const candidate = node as Record<string, unknown>

  if (candidate.type === 'leaf' && candidate.content && typeof candidate.content === 'object') {
    const content = migrateLegacyFreshAgentContent(candidate.content as Record<string, unknown>) as Record<string, unknown>
    if (content.kind === 'terminal') {
      const durableState = migrateLegacyTerminalDurableState({
        provider: typeof content.mode === 'string' && content.mode !== 'shell' ? content.mode : undefined,
        sessionRef: content.sessionRef,
        resumeSessionId: typeof content.resumeSessionId === 'string' ? content.resumeSessionId : undefined,
      })
      const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, restoreError: _legacyRestoreError, ...rest } = content
      const codexDurability = sanitizeCodexDurabilityRef(content.codexDurability)
      const normalizedRuntime = normalizeLegacyRecoveryFailedTerminal(rest, durableState)
      const isLegacyRecoveryFailed = (
        rest.kind === 'terminal'
        && rest.mode === 'codex'
        && rest.status === 'recovery_failed'
      )
      const normalizedSessionRef = isLegacyRecoveryFailed && !isCodexSessionRef(durableState.sessionRef)
        ? undefined
        : durableState.sessionRef
      return {
        ...candidate,
        content: {
          ...normalizedRuntime,
          ...(normalizedSessionRef ? { sessionRef: normalizedSessionRef } : {}),
          ...(codexDurability ? { codexDurability } : {}),
          ...(!isLegacyRecoveryFailed && durableState.restoreError ? { restoreError: durableState.restoreError } : {}),
        },
      }
    }

    if (content.kind === 'fresh-agent') {
      const existingRestoreError = readRestoreError(content.restoreError)
      if (existingRestoreError) {
        const {
          sessionRef: _legacySessionRef,
          restoreError: _legacyRestoreError,
          ...restWithPossibleResume
        } = content

        const rest = existingRestoreError.reason === 'invalid_legacy_restore_target'
          ? (() => {
              const {
                resumeSessionId: _legacyResumeSessionId,
                timelineSessionId: _legacyTimelineSessionId,
                cliSessionId: _legacyCliSessionId,
                ...withoutLegacyIdentity
              } = restWithPossibleResume
              return withoutLegacyIdentity
            })()
          : restWithPossibleResume

        return {
          ...candidate,
          content: {
            ...rest,
            restoreError: existingRestoreError,
          },
        }
      }

      const provider = content.provider === 'claude' || content.provider === 'codex' || content.provider === 'opencode'
        ? content.provider
        : undefined
      const durableState = migrateLegacyFreshAgentDurableState({
        provider,
        sessionRef: content.sessionRef,
        resumeSessionId: typeof content.resumeSessionId === 'string'
          ? content.resumeSessionId
          : (typeof content.timelineSessionId === 'string'
              ? content.timelineSessionId
              : (typeof content.cliSessionId === 'string' ? content.cliSessionId : undefined)),
        rejectNonCanonicalClaudeSessionRef: true,
      })
      const { sessionRef: _legacySessionRef, restoreError: _legacyRestoreError, ...rest } = content
      const restWithNormalizedModel = content.sessionType === 'freshopencode' && content.provider === 'opencode'
        ? (() => {
            const {
              model: legacyModel,
              modelSelection: legacyModelSelection,
              ...withoutModel
            } = rest
            return {
              ...withoutModel,
              modelSelection: normalizeFreshAgentPaneModelSelection({
                sessionType: content.sessionType,
                provider: content.provider,
                modelSelection: legacyModelSelection,
                legacyModel,
              }),
            }
          })()
        : rest
      return {
        ...candidate,
        content: {
          ...restWithNormalizedModel,
          ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
          ...('restoreError' in durableState && durableState.restoreError ? { restoreError: durableState.restoreError } : {}),
        },
      }
    }

    const sanitizedSessionRef = sanitizeSessionRef(content.sessionRef)
    if (!sanitizedSessionRef) return node

    const { sessionRef: _legacySessionRef, ...rest } = content
    return {
      ...candidate,
      content: {
        ...rest,
        sessionRef: sanitizedSessionRef,
      },
    }
  }

  if (candidate.type === 'split' && Array.isArray(candidate.children) && candidate.children.length === 2) {
    return {
      ...candidate,
      children: [
        normalizeLayoutNode(candidate.children[0]),
        normalizeLayoutNode(candidate.children[1]),
      ],
    }
  }

  return node
}

function writeMigratedLayoutWithRecovery(originalRaw: string, migratedRaw: string, expectedCurrentRaw: string): boolean {
  try {
    localStorage.setItem(LAYOUT_FRESH_AGENT_BACKUP_KEY, originalRaw)
  } catch (error) {
    warnStructured('fresh_agent_layout_backup_write_failed', {
      key: LAYOUT_FRESH_AGENT_BACKUP_KEY,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }

  const currentRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
  if (currentRaw !== expectedCurrentRaw) {
    try {
      localStorage.removeItem(LAYOUT_FRESH_AGENT_BACKUP_KEY)
      localStorage.removeItem(LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY)
      localStorage.removeItem(LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY)
    } catch (error) {
      warnStructured('fresh_agent_layout_interleaving_cleanup_failed', {
        backupKey: LAYOUT_FRESH_AGENT_BACKUP_KEY,
        markerKey: LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY,
        pendingMarkerKey: LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    warnStructured('fresh_agent_layout_interleaving_write_detected', {
      key: LAYOUT_STORAGE_KEY,
    })
    return false
  }

  const pendingMarkerRaw = JSON.stringify({
    version: 1,
    migration: LAYOUT_FRESH_AGENT_MIGRATION_ID,
    backupKey: LAYOUT_FRESH_AGENT_BACKUP_KEY,
    originalHash: hashPersistedLayoutRaw(originalRaw),
    migratedHash: hashPersistedLayoutRaw(migratedRaw),
    startedAt: Date.now(),
  })

  try {
    localStorage.removeItem(LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY)
    localStorage.setItem(LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY, pendingMarkerRaw)
  } catch (error) {
    warnStructured('fresh_agent_layout_pending_marker_write_failed', {
      key: LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }

  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, migratedRaw)
  } catch (error) {
    try {
      localStorage.removeItem(LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY)
    } catch {
      // keep the original write failure as the useful signal
    }
    warnStructured('fresh_agent_layout_write_failed', {
      key: LAYOUT_STORAGE_KEY,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }

  try {
    localStorage.setItem(LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY, JSON.stringify({
      version: 1,
      migration: LAYOUT_FRESH_AGENT_MIGRATION_ID,
      backupKey: LAYOUT_FRESH_AGENT_BACKUP_KEY,
      originalHash: hashPersistedLayoutRaw(originalRaw),
      migratedHash: hashPersistedLayoutRaw(migratedRaw),
      committedAt: Date.now(),
    }))
  } catch (error) {
    warnStructured('fresh_agent_layout_commit_marker_write_failed', {
      key: LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }

  try {
    localStorage.removeItem(LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY)
  } catch (error) {
    warnStructured('fresh_agent_layout_pending_marker_cleanup_failed', {
      key: LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  return true
}

function migratePersistedLayout(): PersistedLayoutMigrationResult {
  const expectedCurrentRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
  const raw = readRecoverablePersistedLayoutRaw()
  if (!raw) return 'none'

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'none'
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.tabs || !parsed.panes) {
    return 'none'
  }

  const nextTabs = Array.isArray(parsed.tabs.tabs)
    ? parsed.tabs.tabs.map((tab: Record<string, unknown>) => normalizeLayoutTab(tab))
    : []
  const nextLayouts = parsed.panes.layouts && typeof parsed.panes.layouts === 'object'
    ? Object.fromEntries(
      Object.entries(parsed.panes.layouts as Record<string, unknown>).map(([tabId, node]) => [tabId, normalizeLayoutNode(node)]),
    )
    : {}

  const migratedRaw = JSON.stringify({
    persistedAt: typeof parsed.persistedAt === 'number' ? parsed.persistedAt : Date.now(),
    version: LAYOUT_SCHEMA_VERSION,
    tabs: {
      ...parsed.tabs,
      activeTabId: parsed.tabs.activeTabId ?? null,
      tabs: nextTabs,
    },
    panes: {
      version: Math.max(typeof parsed.panes.version === 'number' ? parsed.panes.version : 1, PANES_SCHEMA_VERSION),
      layouts: nextLayouts,
      activePane: parsed.panes.activePane ?? {},
      paneTitles: parsed.panes.paneTitles ?? {},
      paneTitleSetByUser: parsed.panes.paneTitleSetByUser ?? {},
    },
    tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones : [],
  })

  return writeMigratedLayoutWithRecovery(raw, migratedRaw, expectedCurrentRaw ?? raw) ? 'migrated' : 'failed'
}

function preservePersistedLayout(): PersistedLayoutMigrationResult {
  if (hasFreshAgentLayoutMigrationMarkerForCurrentRaw()) {
    return 'none'
  }

  const migrated = migratePersistedLayout()
  if (migrated !== 'none') {
    return migrated
  }

  if (!migrateV2ToV3()) {
    return 'none'
  }

  return migratePersistedLayout()
}

export function runStorageMigration(): void {
  try {
    const currentVersion = readStorageVersion()
    if (currentVersion >= STORAGE_VERSION) {
      const migratedLayout = preservePersistedLayout()
      if (migratedLayout === 'failed') {
        warnStructured('fresh_agent_layout_migration_aborted', {
          key: LAYOUT_STORAGE_KEY,
        })
      }
      if (migratedLayout === 'migrated') {
        log.info('Migrated localStorage fresh-agent layout state without changing storage version.')
      }
      return
    }

    const preservedAuthToken = localStorage.getItem(AUTH_STORAGE_KEY)
    const migratedLayout = preservePersistedLayout()
    if (migratedLayout === 'failed') {
      warnStructured('fresh_agent_layout_migration_aborted', {
        key: LAYOUT_STORAGE_KEY,
      })
      return
    }
    clearFreshellKeysExcept([
      AUTH_STORAGE_KEY,
      BROWSER_PREFERENCES_STORAGE_KEY,
      LAYOUT_STORAGE_KEY,
      LAYOUT_FRESH_AGENT_BACKUP_KEY,
      LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY,
      ...LEGACY_BROWSER_PREFERENCE_KEYS,
    ])

    if (preservedAuthToken) {
      localStorage.setItem(AUTH_STORAGE_KEY, preservedAuthToken)
    } else {
      clearAuthCookie()
    }

    localStorage.setItem(STORAGE_VERSION_KEY, String(STORAGE_VERSION))
    log.info(
      `Migrated localStorage (version ${currentVersion} → ${STORAGE_VERSION}) ` +
      `${migratedLayout === 'migrated' ? 'while preserving restorable layout state.' : 'without preserved layout state.'}`
    )
  } catch (err) {
    log.warn('Storage migration failed:', err)
  }
}

// Execute immediately when this module is imported
runStorageMigration()

export {} // Make this a module

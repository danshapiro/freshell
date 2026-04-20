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
import { LAYOUT_SCHEMA_VERSION, PANES_SCHEMA_VERSION } from './persistedState'
import { BROWSER_PREFERENCES_STORAGE_KEY, LAYOUT_STORAGE_KEY } from './storage-keys'
import {
  migrateLegacyAgentChatDurableState,
  migrateLegacyTerminalDurableState,
  sanitizeSessionRef,
} from '@shared/session-contract'

const log = createLogger('StorageMigration')

const STORAGE_VERSION = 4
const STORAGE_VERSION_KEY = 'freshell_version'
const AUTH_STORAGE_KEY = 'freshell.auth-token'
const LEGACY_BROWSER_PREFERENCE_KEYS = [
  'freshell.terminal.fontFamily.v1',
] as const

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
  const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, ...rest } = tab
  return {
    ...rest,
    ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
  }
}

function normalizeLayoutNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node
  const candidate = node as Record<string, unknown>

  if (candidate.type === 'leaf' && candidate.content && typeof candidate.content === 'object') {
    const content = candidate.content as Record<string, unknown>
    if (content.kind === 'terminal') {
      const durableState = migrateLegacyTerminalDurableState({
        provider: typeof content.mode === 'string' && content.mode !== 'shell' ? content.mode : undefined,
        sessionRef: content.sessionRef,
        resumeSessionId: typeof content.resumeSessionId === 'string' ? content.resumeSessionId : undefined,
      })
      const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, restoreError: _legacyRestoreError, ...rest } = content
      return {
        ...candidate,
        content: {
          ...rest,
          ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
          ...(durableState.restoreError ? { restoreError: durableState.restoreError } : {}),
        },
      }
    }

    if (content.kind === 'agent-chat') {
      const durableState = migrateLegacyAgentChatDurableState({
        sessionRef: content.sessionRef,
        cliSessionId: typeof content.cliSessionId === 'string' ? content.cliSessionId : undefined,
        timelineSessionId: typeof content.timelineSessionId === 'string' ? content.timelineSessionId : undefined,
        resumeSessionId: typeof content.resumeSessionId === 'string' ? content.resumeSessionId : undefined,
      })
      const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, restoreError: _legacyRestoreError, ...rest } = content
      return {
        ...candidate,
        content: {
          ...rest,
          ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
          ...(durableState.restoreError ? { restoreError: durableState.restoreError } : {}),
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

function migratePersistedLayout(): boolean {
  const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
  if (!raw) return false

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.tabs || !parsed.panes) {
    return false
  }

  const nextTabs = Array.isArray(parsed.tabs.tabs)
    ? parsed.tabs.tabs.map((tab: Record<string, unknown>) => normalizeLayoutTab(tab))
    : []
  const nextLayouts = parsed.panes.layouts && typeof parsed.panes.layouts === 'object'
    ? Object.fromEntries(
      Object.entries(parsed.panes.layouts as Record<string, unknown>).map(([tabId, node]) => [tabId, normalizeLayoutNode(node)]),
    )
    : {}

  localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
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
  }))
  return true
}

export function runStorageMigration(): void {
  try {
    const currentVersion = readStorageVersion()
    if (currentVersion >= STORAGE_VERSION) return

    const preservedAuthToken = localStorage.getItem(AUTH_STORAGE_KEY)
    const migratedLayout = migratePersistedLayout()
    clearFreshellKeysExcept([
      AUTH_STORAGE_KEY,
      BROWSER_PREFERENCES_STORAGE_KEY,
      LAYOUT_STORAGE_KEY,
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
      `${migratedLayout ? 'while preserving restorable layout state.' : 'without preserved layout state.'}`
    )
  } catch (err) {
    log.warn('Storage migration failed:', err)
  }
}

// Execute immediately when this module is imported
runStorageMigration()

export {} // Make this a module

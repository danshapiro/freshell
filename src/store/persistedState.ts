import { z } from 'zod'
import { LAYOUT_STORAGE_KEY, TABS_STORAGE_KEY, PANES_STORAGE_KEY } from './storage-keys'
import {
  buildRestoreError,
  migrateLegacyTerminalDurableState,
  type RestoreError,
  sanitizeSessionRef,
} from '@shared/session-contract'
import { sanitizeCodexDurabilityRef } from '@shared/codex-durability'
import { migrateLegacyFreshAgentContent, migrateLegacyFreshAgentDurableState } from '@shared/fresh-agent'

export { LAYOUT_STORAGE_KEY, TABS_STORAGE_KEY, PANES_STORAGE_KEY }

export const TABS_SCHEMA_VERSION = 2
export const PANES_SCHEMA_VERSION = 7
export const LAYOUT_FRESH_AGENT_BACKUP_KEY = `${LAYOUT_STORAGE_KEY}.backup-before-fresh-agent-centralization`
export const LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY = `${LAYOUT_STORAGE_KEY}.fresh-agent-centralization-commit`
export const LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY = `${LAYOUT_STORAGE_KEY}.fresh-agent-centralization-pending`
export const LAYOUT_FRESH_AGENT_MIGRATION_ID = 'fresh-agent-centralization'

const zTabMode = z.enum(['shell', 'claude', 'codex', 'opencode', 'gemini', 'kimi'])
const zCodingCliProvider = z.enum(['claude', 'codex', 'opencode', 'gemini', 'kimi'])

const zTab = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.number().optional(),
  titleSetByUser: z.boolean().optional(),
  // Compatibility-only fields (may exist in persisted tabs before pane layout is created).
  mode: zTabMode.optional(),
  codingCliProvider: zCodingCliProvider.optional(),
  resumeSessionId: z.string().optional(),
}).passthrough()

const zPersistedTabsState = z.object({
  activeTabId: z.string().nullable().optional(),
  tabs: z.array(zTab),
}).passthrough()

const zTombstone = z.object({
  id: z.string(),
  deletedAt: z.number(),
})

const zPersistedTabsPayload = z.object({
  version: z.number().optional(),
  tabs: zPersistedTabsState,
  tombstones: z.array(zTombstone).optional(),
}).passthrough()

export type ParsedPersistedTabs = {
  version: number
  tabs: z.infer<typeof zPersistedTabsState>
  tombstones: Array<{ id: string; deletedAt: number }>
}

type PersistedTab = z.infer<typeof zTab>

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

function normalizePersistedTab(tab: Record<string, unknown>): PersistedTab {
  const mode = typeof tab.mode === 'string' ? tab.mode : undefined
  const codingCliProvider = typeof tab.codingCliProvider === 'string' ? tab.codingCliProvider : undefined
  const legacyCodingCliSessionId = typeof tab.codingCliSessionId === 'string' && tab.codingCliSessionId.length > 0
    ? tab.codingCliSessionId
    : undefined
  const legacyClaudeSessionId = typeof tab.claudeSessionId === 'string' && tab.claudeSessionId.length > 0
    ? tab.claudeSessionId
    : undefined
  const provider = codingCliProvider || (mode && mode !== 'shell' ? mode : undefined)
  const legacySessionId = legacyCodingCliSessionId || legacyClaudeSessionId
  const durableState = migrateLegacyTerminalDurableState({
    provider,
    sessionRef: tab.sessionRef,
    resumeSessionId: typeof tab.resumeSessionId === 'string'
      ? tab.resumeSessionId
      : legacySessionId,
  })
  const codexDurability = sanitizeCodexDurabilityRef(tab.codexDurability)
  const {
    resumeSessionId: _resumeSessionId,
    sessionRef: _legacySessionRef,
    codingCliSessionId: _codingCliSessionId,
    claudeSessionId: _claudeSessionId,
    ...rest
  } = tab

  return {
    ...rest,
    ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
    ...(codexDurability ? { codexDurability } : {}),
  } as PersistedTab
}

export function parsePersistedTabsRaw(raw: string): ParsedPersistedTabs | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const res = zPersistedTabsPayload.safeParse(parsed)
  if (!res.success) return null

  const version = typeof res.data.version === 'number' ? res.data.version : 0
  if (version > TABS_SCHEMA_VERSION) return null

  return {
    version,
    tabs: {
      ...res.data.tabs,
      activeTabId: res.data.tabs.activeTabId ?? null,
      tabs: res.data.tabs.tabs.map((tab) => normalizePersistedTab(tab as unknown as Record<string, unknown>)),
    },
    tombstones: res.data.tombstones || [],
  }
}

const zPaneTitles = z.record(z.string(), z.record(z.string(), z.string()))
const zPaneTitleSetByUser = z.record(z.string(), z.record(z.string(), z.boolean()))

const zPersistedPanesPayload = z.object({
  version: z.number().optional(),
  // Layout nodes can be partially corrupted; migrations and runtime code should tolerate malformed nodes.
  // We validate only that layouts is a plain object and leave deeper repairs to higher-level logic.
  layouts: z.record(z.string(), z.unknown()).optional(),
  activePane: z.record(z.string(), z.string()).optional(),
  paneTitles: zPaneTitles.optional(),
  paneTitleSetByUser: zPaneTitleSetByUser.optional(),
}).passthrough()

export type ParsedPersistedPanes = {
  version: number
  layouts: Record<string, unknown>
  activePane: Record<string, string>
  paneTitles: Record<string, Record<string, string>>
  paneTitleSetByUser: Record<string, Record<string, boolean>>
}

function normalizeTerminalContent(content: Record<string, unknown>): Record<string, unknown> {
  const durableState = migrateLegacyTerminalDurableState({
    provider: typeof content.mode === 'string' && content.mode !== 'shell' ? content.mode : undefined,
    sessionRef: content.sessionRef,
    resumeSessionId: typeof content.resumeSessionId === 'string' ? content.resumeSessionId : undefined,
  })
  const existingRestoreError = readRestoreError(content.restoreError)
  const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, restoreError: _legacyRestoreError, ...rest } = content
  const codexDurability = sanitizeCodexDurabilityRef(content.codexDurability)
  const isLegacyRecoveryFailed = (
    rest.kind === 'terminal'
    && rest.mode === 'codex'
    && rest.status === 'recovery_failed'
  )
  const normalizedRuntime = normalizeLegacyRecoveryFailedTerminal(rest, durableState)
  const normalizedRestoreError = isLegacyRecoveryFailed
    ? undefined
    : durableState.restoreError ?? existingRestoreError
  const normalizedSessionRef = isLegacyRecoveryFailed && !isCodexSessionRef(durableState.sessionRef)
    ? undefined
    : durableState.sessionRef

  return {
    ...normalizedRuntime,
    ...(normalizedSessionRef ? { sessionRef: normalizedSessionRef } : {}),
    ...(codexDurability ? { codexDurability } : {}),
    ...(normalizedRestoreError
      ? { restoreError: normalizedRestoreError }
      : {}),
  }
}

function normalizeFreshAgentContent(content: Record<string, unknown>): Record<string, unknown> {
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
      ...rest,
      restoreError: existingRestoreError,
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

  return {
    ...rest,
    ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
    ...(('restoreError' in durableState && durableState.restoreError) || existingRestoreError
      ? { restoreError: ('restoreError' in durableState && durableState.restoreError) || existingRestoreError }
      : {}),
  }
}

function normalizePersistedNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node

  const candidate = node as Record<string, unknown>
  if (candidate.type === 'leaf' && candidate.content && typeof candidate.content === 'object') {
    const content = migrateLegacyFreshAgentContent(candidate.content as Record<string, unknown>) as Record<string, unknown>
    let nextContent = content
    if (content.kind === 'terminal') {
      nextContent = normalizeTerminalContent(content)
    } else if (content.kind === 'fresh-agent') {
      nextContent = normalizeFreshAgentContent(content)
    } else if ('sessionRef' in content) {
      const sanitizedSessionRef = sanitizeSessionRef(content.sessionRef)
      const { sessionRef: _legacySessionRef, ...rest } = content
      nextContent = {
        ...rest,
        ...(sanitizedSessionRef ? { sessionRef: sanitizedSessionRef } : {}),
      }
    }
    return {
      ...candidate,
      content: nextContent,
    }
  }

  if (candidate.type === 'split' && Array.isArray(candidate.children) && candidate.children.length === 2) {
    return {
      ...candidate,
      children: [
        normalizePersistedNode(candidate.children[0]),
        normalizePersistedNode(candidate.children[1]),
      ],
    }
  }

  return node
}

function normalizePersistedLayouts(layouts: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(layouts).map(([tabId, node]) => [tabId, normalizePersistedNode(node)]),
  )
}

export function parsePersistedPanesRaw(raw: string): ParsedPersistedPanes | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const res = zPersistedPanesPayload.safeParse(parsed)
  if (!res.success) return null

  let version = typeof res.data.version === 'number' ? res.data.version : 1
  if (version < 1) version = 1
  if (version > PANES_SCHEMA_VERSION) return null

  return {
    version,
    layouts: normalizePersistedLayouts((res.data.layouts || {}) as Record<string, unknown>),
    activePane: (res.data.activePane || {}) as Record<string, string>,
    paneTitles: (res.data.paneTitles || {}) as Record<string, Record<string, string>>,
    paneTitleSetByUser: (res.data.paneTitleSetByUser || {}) as Record<string, Record<string, boolean>>,
  }
}

// --- Combined layout key (v4) ---

export const LAYOUT_SCHEMA_VERSION = 4

const zPersistedLayoutPayload = z.object({
  version: z.number(),
  tabs: zPersistedTabsState,
  panes: zPersistedPanesPayload,
  tombstones: z.array(zTombstone).optional(),
}).passthrough()

export type ParsedPersistedLayout = {
  version: number
  tabs: z.infer<typeof zPersistedTabsState>
  panes: ParsedPersistedPanes
  tombstones: Array<{ id: string; deletedAt: number }>
  persistedAt?: number
}

export type LayoutFreshAgentCommitMarker = {
  version: 1
  migration: typeof LAYOUT_FRESH_AGENT_MIGRATION_ID
  backupKey: typeof LAYOUT_FRESH_AGENT_BACKUP_KEY
  originalHash: string
  migratedHash: string
  committedAt: number
}

export type LayoutFreshAgentPendingMarker = {
  version: 1
  migration: typeof LAYOUT_FRESH_AGENT_MIGRATION_ID
  backupKey: typeof LAYOUT_FRESH_AGENT_BACKUP_KEY
  originalHash: string
  migratedHash: string
  startedAt: number
}

export function hashPersistedLayoutRaw(raw: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${raw.length}:${hash.toString(16).padStart(8, '0')}`
}

export function parseLayoutFreshAgentCommitMarker(raw: string | null): LayoutFreshAgentCommitMarker | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LayoutFreshAgentCommitMarker>
    if (
      parsed?.version !== 1
      || parsed.migration !== LAYOUT_FRESH_AGENT_MIGRATION_ID
      || parsed.backupKey !== LAYOUT_FRESH_AGENT_BACKUP_KEY
      || typeof parsed.originalHash !== 'string'
      || typeof parsed.migratedHash !== 'string'
      || typeof parsed.committedAt !== 'number'
    ) {
      return null
    }
    return parsed as LayoutFreshAgentCommitMarker
  } catch {
    return null
  }
}

export function parseLayoutFreshAgentPendingMarker(raw: string | null): LayoutFreshAgentPendingMarker | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LayoutFreshAgentPendingMarker>
    if (
      parsed?.version !== 1
      || parsed.migration !== LAYOUT_FRESH_AGENT_MIGRATION_ID
      || parsed.backupKey !== LAYOUT_FRESH_AGENT_BACKUP_KEY
      || typeof parsed.originalHash !== 'string'
      || typeof parsed.migratedHash !== 'string'
      || typeof parsed.startedAt !== 'number'
    ) {
      return null
    }
    return parsed as LayoutFreshAgentPendingMarker
  } catch {
    return null
  }
}

export function readRecoverablePersistedLayoutRaw(storage: Pick<Storage, 'getItem'> = localStorage): string | null {
  const raw = storage.getItem(LAYOUT_STORAGE_KEY)
  const backup = storage.getItem(LAYOUT_FRESH_AGENT_BACKUP_KEY)
  const markerRaw = storage.getItem(LAYOUT_FRESH_AGENT_COMMIT_MARKER_KEY)
  const pendingMarkerRaw = storage.getItem(LAYOUT_FRESH_AGENT_PENDING_MARKER_KEY)

  if (!raw) return backup
  if (!backup) return raw

  const currentHash = hashPersistedLayoutRaw(raw)
  const marker = parseLayoutFreshAgentCommitMarker(markerRaw)
  if (marker && marker.migratedHash === currentHash) {
    return raw
  }

  const pendingMarker = parseLayoutFreshAgentPendingMarker(pendingMarkerRaw)
  if (
    pendingMarker
    && pendingMarker.originalHash === hashPersistedLayoutRaw(backup)
    && pendingMarker.migratedHash === currentHash
  ) {
    return backup
  }

  return parsePersistedLayoutRaw(raw) ? raw : backup
}

export function parsePersistedLayoutRaw(raw: string): ParsedPersistedLayout | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const res = zPersistedLayoutPayload.safeParse(parsed)
  if (!res.success) return null
  if (res.data.version > LAYOUT_SCHEMA_VERSION) return null

  const panes = res.data.panes
  let panesVersion = typeof panes.version === 'number' ? panes.version : 1
  if (panesVersion < 1) panesVersion = 1

  return {
    version: Math.max(res.data.version, LAYOUT_SCHEMA_VERSION),
    tabs: {
      ...res.data.tabs,
      activeTabId: res.data.tabs.activeTabId ?? null,
      tabs: res.data.tabs.tabs.map((tab) => normalizePersistedTab(tab as unknown as Record<string, unknown>)),
    },
    panes: {
      version: Math.max(panesVersion, PANES_SCHEMA_VERSION),
      layouts: normalizePersistedLayouts((panes.layouts || {}) as Record<string, unknown>),
      activePane: (panes.activePane || {}) as Record<string, string>,
      paneTitles: (panes.paneTitles || {}) as Record<string, Record<string, string>>,
      paneTitleSetByUser: (panes.paneTitleSetByUser || {}) as Record<string, Record<string, boolean>>,
    },
    tombstones: res.data.tombstones || [],
    persistedAt: typeof (res.data as any).persistedAt === 'number' ? (res.data as any).persistedAt : undefined,
  }
}

/**
 * Migrate from separate v2 tabs+panes keys to the combined v3 layout key.
 * Returns the parsed v3 layout, or null if no v2 data existed.
 */
export function migrateV2ToV3(): ParsedPersistedLayout | null {
  const tabsKey = TABS_STORAGE_KEY
  const panesKey = PANES_STORAGE_KEY
  const layoutKey = LAYOUT_STORAGE_KEY

  const tabsRaw = localStorage.getItem(tabsKey)
  if (!tabsRaw) return null

  const tabsParsed = parsePersistedTabsRaw(tabsRaw)
  if (!tabsParsed) return null

  const panesRaw = localStorage.getItem(panesKey)
  const panesParsed = panesRaw ? parsePersistedPanesRaw(panesRaw) : null

  const emptyPanes: ParsedPersistedPanes = {
    version: PANES_SCHEMA_VERSION,
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
  }

  const layout: ParsedPersistedLayout = {
    version: LAYOUT_SCHEMA_VERSION,
    tabs: tabsParsed.tabs,
    panes: panesParsed || emptyPanes,
    tombstones: tabsParsed.tombstones,
  }

  // Write v3 key and clean up v2 keys
  const v3Payload = {
    version: LAYOUT_SCHEMA_VERSION,
    tabs: layout.tabs,
    panes: {
      version: layout.panes.version,
      layouts: layout.panes.layouts,
      activePane: layout.panes.activePane,
      paneTitles: layout.panes.paneTitles,
      paneTitleSetByUser: layout.panes.paneTitleSetByUser,
    },
    tombstones: layout.tombstones,
  }
  localStorage.setItem(layoutKey, JSON.stringify(v3Payload))
  localStorage.removeItem(tabsKey)
  localStorage.removeItem(panesKey)

  return layout
}

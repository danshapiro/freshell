import { z } from 'zod'
import { LAYOUT_STORAGE_KEY, TABS_STORAGE_KEY, PANES_STORAGE_KEY } from './storage-keys'
import {
  migrateLegacyAgentChatDurableState,
  migrateLegacyTerminalDurableState,
  sanitizeSessionRef,
} from '@shared/session-contract'

export { LAYOUT_STORAGE_KEY, TABS_STORAGE_KEY, PANES_STORAGE_KEY }

export const TABS_SCHEMA_VERSION = 2
export const PANES_SCHEMA_VERSION = 7

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

function normalizePersistedTab(tab: Record<string, unknown>): Record<string, unknown> {
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
  const existingRestoreError = (
    content.restoreError
    && typeof content.restoreError === 'object'
    && (content.restoreError as any).code === 'RESTORE_UNAVAILABLE'
    && typeof (content.restoreError as any).reason === 'string'
  )
    ? content.restoreError
    : undefined
  const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, restoreError: _legacyRestoreError, ...rest } = content

  return {
    ...rest,
    ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
    ...((durableState.restoreError ?? existingRestoreError)
      ? { restoreError: durableState.restoreError ?? existingRestoreError }
      : {}),
  }
}

function normalizeAgentChatContent(content: Record<string, unknown>): Record<string, unknown> {
  const durableState = migrateLegacyAgentChatDurableState({
    sessionRef: content.sessionRef,
    cliSessionId: typeof content.cliSessionId === 'string' ? content.cliSessionId : undefined,
    timelineSessionId: typeof content.timelineSessionId === 'string' ? content.timelineSessionId : undefined,
    resumeSessionId: typeof content.resumeSessionId === 'string' ? content.resumeSessionId : undefined,
  })
  const existingRestoreError = (
    content.restoreError
    && typeof content.restoreError === 'object'
    && (content.restoreError as any).code === 'RESTORE_UNAVAILABLE'
    && typeof (content.restoreError as any).reason === 'string'
  )
    ? content.restoreError
    : undefined
  const { resumeSessionId: _resumeSessionId, sessionRef: _legacySessionRef, restoreError: _legacyRestoreError, ...rest } = content

  return {
    ...rest,
    ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
    ...((durableState.restoreError ?? existingRestoreError)
      ? { restoreError: durableState.restoreError ?? existingRestoreError }
      : {}),
  }
}

function normalizePersistedNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node

  const candidate = node as Record<string, unknown>
  if (candidate.type === 'leaf' && candidate.content && typeof candidate.content === 'object') {
    const content = candidate.content as Record<string, unknown>
    let nextContent = content
    if (content.kind === 'terminal') {
      nextContent = normalizeTerminalContent(content)
    } else if (content.kind === 'agent-chat') {
      nextContent = normalizeAgentChatContent(content)
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

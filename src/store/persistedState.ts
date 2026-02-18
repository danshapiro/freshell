import { z } from 'zod'

export const TABS_STORAGE_KEY = 'freshell.tabs.v1'
export const PANES_STORAGE_KEY = 'freshell.panes.v1'

export const TABS_SCHEMA_VERSION = 1
export const PANES_SCHEMA_VERSION = 4

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

const zPersistedTabsPayload = z.object({
  version: z.number().optional(),
  tabs: zPersistedTabsState,
}).passthrough()

export type ParsedPersistedTabs = {
  version: number
  tabs: z.infer<typeof zPersistedTabsState>
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
    },
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
    layouts: (res.data.layouts || {}) as Record<string, unknown>,
    activePane: (res.data.activePane || {}) as Record<string, string>,
    paneTitles: (res.data.paneTitles || {}) as Record<string, Record<string, string>>,
    paneTitleSetByUser: (res.data.paneTitleSetByUser || {}) as Record<string, Record<string, boolean>>,
  }
}


import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { bucketTabRecencyAt, collectTerminalPaneIds } from '@/lib/tab-recency'
import type { PaneNode } from './paneTypes'
import { TAB_RECENCY_STORAGE_KEY } from './storage-keys'

export interface TabRecencyState {
  paneLastInputAt: Record<string, number>
}

export type PersistedTabRecencyPayload = {
  version: 1
  paneLastInputAt: Record<string, number>
}

function emptyState(): TabRecencyState {
  return {
    paneLastInputAt: {},
  }
}

export function loadPersistedTabRecency(raw: string | null | undefined): TabRecencyState {
  if (!raw) return emptyState()
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedTabRecencyPayload>
    if (parsed.version !== 1 || !parsed.paneLastInputAt || typeof parsed.paneLastInputAt !== 'object') {
      return emptyState()
    }
    const paneLastInputAt: Record<string, number> = {}
    for (const [paneId, value] of Object.entries(parsed.paneLastInputAt)) {
      const trimmed = paneId.trim()
      const bucket = bucketTabRecencyAt(value)
      if (trimmed && bucket !== undefined) paneLastInputAt[trimmed] = bucket
    }
    return { paneLastInputAt }
  } catch {
    return emptyState()
  }
}

export function loadInitialTabRecencyState(): TabRecencyState {
  try {
    return loadPersistedTabRecency(typeof localStorage !== 'undefined'
      ? localStorage.getItem(TAB_RECENCY_STORAGE_KEY)
      : null)
  } catch {
    return emptyState()
  }
}

export function mergeTabRecencyStatesByMax(
  base: TabRecencyState,
  incoming: TabRecencyState,
): TabRecencyState {
  const paneLastInputAt = { ...base.paneLastInputAt }
  for (const [paneId, value] of Object.entries(incoming.paneLastInputAt)) {
    const trimmed = paneId.trim()
    const bucket = bucketTabRecencyAt(value)
    if (!trimmed || bucket === undefined) continue
    const current = paneLastInputAt[trimmed]
    if (current === undefined || bucket > current) {
      paneLastInputAt[trimmed] = bucket
    }
  }
  return { paneLastInputAt }
}

export function serializePersistableTabRecency(
  state: TabRecencyState,
  layouts?: Record<string, PaneNode | undefined>,
  liveTabIds?: ReadonlySet<string>,
): PersistedTabRecencyPayload {
  const layoutEntries = layouts
    ? Object.entries(layouts).filter(([tabId]) => !liveTabIds || liveTabIds.has(tabId))
    : []
  const liveTerminalPaneIds = layouts
    ? new Set(layoutEntries.flatMap(([, layout]) => collectTerminalPaneIds(layout)))
    : undefined
  const paneLastInputAt: Record<string, number> = {}

  for (const [paneId, value] of Object.entries(state.paneLastInputAt)) {
    if (liveTerminalPaneIds && !liveTerminalPaneIds.has(paneId)) continue
    const bucket = bucketTabRecencyAt(value)
    if (paneId.trim() && bucket !== undefined) paneLastInputAt[paneId] = bucket
  }

  return {
    version: 1,
    paneLastInputAt,
  }
}

const tabRecencySlice = createSlice({
  name: 'tabRecency',
  initialState: loadInitialTabRecencyState(),
  reducers: {
    mergeHydratedTabRecency: (state, action: PayloadAction<TabRecencyState>) => {
      for (const [paneId, value] of Object.entries(action.payload.paneLastInputAt)) {
        const trimmed = paneId.trim()
        const bucket = bucketTabRecencyAt(value)
        if (!trimmed || bucket === undefined) continue
        const current = state.paneLastInputAt[trimmed]
        if (current === undefined || bucket > current) {
          state.paneLastInputAt[trimmed] = bucket
        }
      }
    },
    recordPaneTabActivity: (state, action: PayloadAction<{ paneId: string; at: number }>) => {
      const paneId = action.payload.paneId.trim()
      if (!paneId) return
      const bucket = bucketTabRecencyAt(action.payload.at)
      if (bucket === undefined) return
      const current = state.paneLastInputAt[paneId]
      if (current === undefined || bucket > current) {
        state.paneLastInputAt[paneId] = bucket
      }
    },
    prunePaneTabActivityToLiveTerminalPanes: (state, action: PayloadAction<{ paneIds: string[] }>) => {
      const livePaneIds = new Set(action.payload.paneIds.map((paneId) => paneId.trim()).filter(Boolean))
      for (const paneId of Object.keys(state.paneLastInputAt)) {
        if (!livePaneIds.has(paneId)) {
          delete state.paneLastInputAt[paneId]
        }
      }
    },
  },
})

export const {
  mergeHydratedTabRecency,
  prunePaneTabActivityToLiveTerminalPanes,
  recordPaneTabActivity,
} = tabRecencySlice.actions
export default tabRecencySlice.reducer

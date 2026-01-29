import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit'
import type { Tab, TerminalStatus, TabMode, ShellType } from './types'
import { nanoid } from 'nanoid'
import { removeLayout } from './panesSlice'

export interface TabsState {
  tabs: Tab[]
  activeTabId: string | null
}

const DEFAULT_CWD = import.meta.env.VITE_DEFAULT_CWD || undefined

// Load persisted tabs state directly at module initialization time
// This ensures the initial state includes persisted data BEFORE the store is created
function loadInitialTabsState(): TabsState {
  const defaultState: TabsState = {
    tabs: [],
    activeTabId: null,
  }

  try {
    const raw = localStorage.getItem('freshell.tabs.v1')
    if (!raw) return defaultState
    const parsed = JSON.parse(raw)
    // The persisted format is { tabs: TabsState }
    const tabsState = parsed?.tabs as TabsState | undefined
    if (!tabsState?.tabs) return defaultState

    console.log('[TabsSlice] Loaded initial state from localStorage:', tabsState.tabs.map(t => t.id))

    // Apply same transformations as hydrateTabs to ensure consistency
    return {
      tabs: tabsState.tabs.map((t: Tab) => ({
        ...t,
        createdAt: t.createdAt || Date.now(),
        createRequestId: (t as any).createRequestId || t.id,
        status: t.status || 'creating',
        mode: t.mode || 'shell',
        shell: t.shell || 'system',
      })),
      activeTabId: tabsState.activeTabId || (tabsState.tabs[0]?.id ?? null),
    }
  } catch (err) {
    console.error('[TabsSlice] Failed to load from localStorage:', err)
    return defaultState
  }
}

const initialState: TabsState = loadInitialTabsState()

type AddTabPayload = {
  title?: string
  description?: string
  terminalId?: string
  claudeSessionId?: string
  status?: TerminalStatus
  mode?: TabMode
  shell?: ShellType
  initialCwd?: string
  resumeSessionId?: string
}

export const tabsSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers: {
    addTab: (state, action: PayloadAction<AddTabPayload | undefined>) => {
      const payload = action.payload || {}

      // Deduplicate: if resuming a session that already has a tab, switch to it instead
      if (payload.resumeSessionId) {
        const existingTab = state.tabs.find((t) => t.resumeSessionId === payload.resumeSessionId)
        if (existingTab) {
          state.activeTabId = existingTab.id
          return
        }
      }

      const id = nanoid()
      const tab: Tab = {
        id,
        createRequestId: id,
        title: payload.title || `Terminal ${state.tabs.length + 1}`,
        description: payload.description,
        terminalId: payload.terminalId,
        claudeSessionId: payload.claudeSessionId,
        status: payload.status || 'creating',
        mode: payload.mode || 'shell',
        shell: payload.shell || 'system',
        initialCwd: payload.initialCwd ?? DEFAULT_CWD,
        resumeSessionId: payload.resumeSessionId,
        createdAt: Date.now(),
      }
      state.tabs.push(tab)
      state.activeTabId = id
    },
    setActiveTab: (state, action: PayloadAction<string>) => {
      state.activeTabId = action.payload
    },
    updateTab: (state, action: PayloadAction<{ id: string; updates: Partial<Tab> }>) => {
      const tab = state.tabs.find((t) => t.id === action.payload.id)
      if (tab) Object.assign(tab, action.payload.updates)
    },
    removeTab: (state, action: PayloadAction<string>) => {
      state.tabs = state.tabs.filter((t) => t.id !== action.payload)
      if (state.activeTabId === action.payload) {
        state.activeTabId = state.tabs.length > 0 ? state.tabs[0].id : null
      }
    },
    hydrateTabs: (state, action: PayloadAction<TabsState>) => {
      // Basic sanity: ensure dates exist, status defaults.
      state.tabs = (action.payload.tabs || []).map((t) => ({
        ...t,
        createdAt: t.createdAt || Date.now(),
        createRequestId: (t as any).createRequestId || t.id,
        status: t.status || 'creating',
        mode: t.mode || 'shell',
        shell: t.shell || 'system',
      }))
      state.activeTabId = action.payload.activeTabId || (state.tabs[0]?.id ?? null)
    },
    reorderTabs: (
      state,
      action: PayloadAction<{ fromIndex: number; toIndex: number }>
    ) => {
      const { fromIndex, toIndex } = action.payload
      if (fromIndex === toIndex) return
      const [removed] = state.tabs.splice(fromIndex, 1)
      state.tabs.splice(toIndex, 0, removed)
    },
  },
})

export const { addTab, setActiveTab, updateTab, removeTab, hydrateTabs, reorderTabs } = tabsSlice.actions

export const closeTab = createAsyncThunk(
  'tabs/closeTab',
  async (tabId: string, { dispatch }) => {
    dispatch(removeTab(tabId))
    dispatch(removeLayout({ tabId }))
  }
)

export default tabsSlice.reducer

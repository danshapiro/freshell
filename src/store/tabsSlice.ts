import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit'
import type { Tab } from './types'
import { nanoid } from 'nanoid'
import { removeLayout } from './panesSlice'

export interface TabsState {
  tabs: Tab[]
  activeTabId: string | null
  // Ephemeral UI signal: request TabBar to enter inline rename mode for a tab.
  // This must never be persisted.
  renameRequestTabId: string | null
}

// Load persisted tabs state directly at module initialization time
// This ensures the initial state includes persisted data BEFORE the store is created
function loadInitialTabsState(): TabsState {
  const defaultState: TabsState = {
    tabs: [],
    activeTabId: null,
    renameRequestTabId: null,
  }

  try {
    const raw = localStorage.getItem('freshell.tabs.v1')
    if (!raw) return defaultState
    const parsed = JSON.parse(raw)
    // The persisted format is { tabs: TabsState }
    const tabsState = parsed?.tabs as Partial<TabsState> | undefined
    if (!Array.isArray(tabsState?.tabs)) return defaultState

    if (import.meta.env.MODE === 'development') {
      console.log('[TabsSlice] Loaded initial state from localStorage:', tabsState.tabs.map((t) => t.id))
    }

    // Apply same transformations as hydrateTabs to ensure consistency
    const mappedTabs = (tabsState.tabs as Tab[]).map((t) => ({
      ...t,
      createdAt: t.createdAt || Date.now(),
    }))
    const desired = tabsState.activeTabId
    const has = desired && mappedTabs.some((t) => t.id === desired)
    return {
      tabs: mappedTabs,
      activeTabId: has ? desired! : (mappedTabs[0]?.id ?? null),
      renameRequestTabId: null,
    }
  } catch (err) {
    console.error('[TabsSlice] Failed to load from localStorage:', err)
    return defaultState
  }
}

const initialState: TabsState = loadInitialTabsState()

type AddTabPayload = {
  id?: string
  title?: string
  titleSetByUser?: boolean
}

export const tabsSlice = createSlice({
  name: 'tabs',
  initialState,
  reducers: {
    addTab: (state, action: PayloadAction<AddTabPayload | undefined>) => {
      const payload = action.payload || {}

      const id = payload.id || nanoid()
      const tab: Tab = {
        id,
        title: payload.title || `Tab ${state.tabs.length + 1}`,
        createdAt: Date.now(),
        titleSetByUser: payload.titleSetByUser,
      }
      state.tabs.push(tab)
      state.activeTabId = id
    },
    setActiveTab: (state, action: PayloadAction<string>) => {
      state.activeTabId = action.payload
    },
    requestTabRename: (state, action: PayloadAction<string>) => {
      state.renameRequestTabId = action.payload
    },
    clearTabRenameRequest: (state) => {
      state.renameRequestTabId = null
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
      // Basic sanity: ensure dates exist.
      const tabs = Array.isArray(action.payload.tabs) ? action.payload.tabs : []
      state.tabs = tabs.map((t) => {
        return {
          ...t,
          createdAt: t.createdAt || Date.now(),
        }
      })
      const desired = action.payload.activeTabId
      const has = desired && state.tabs.some((t) => t.id === desired)
      state.activeTabId = has ? desired! : (state.tabs[0]?.id ?? null)
      state.renameRequestTabId = null
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
    switchToNextTab: (state) => {
      if (state.tabs.length <= 1) return
      const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId)
      const nextIndex = (currentIndex + 1) % state.tabs.length
      state.activeTabId = state.tabs[nextIndex].id
    },
    switchToPrevTab: (state) => {
      if (state.tabs.length <= 1) return
      const currentIndex = state.tabs.findIndex((t) => t.id === state.activeTabId)
      const prevIndex = (currentIndex - 1 + state.tabs.length) % state.tabs.length
      state.activeTabId = state.tabs[prevIndex].id
    },
  },
})

export const {
  addTab,
  setActiveTab,
  requestTabRename,
  clearTabRenameRequest,
  updateTab,
  removeTab,
  hydrateTabs,
  reorderTabs,
  switchToNextTab,
  switchToPrevTab,
} = tabsSlice.actions

export const closeTab = createAsyncThunk(
  'tabs/closeTab',
  async (tabId: string, { dispatch }) => {
    dispatch(removeTab(tabId))
    dispatch(removeLayout({ tabId }))
  }
)

export default tabsSlice.reducer

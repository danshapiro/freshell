import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import type { BackgroundTerminal } from './types'

export type TerminalDirectoryItem = BackgroundTerminal & {
  description?: string
}

export type TerminalDirectoryWindow = {
  items: TerminalDirectoryItem[]
  revision?: number
  nextCursor?: string | null
  loading?: boolean
  error?: string
}

export type TerminalSearchMatch = {
  line: number
  column: number
  text: string
}

export type TerminalSearchState = {
  query: string
  matches: TerminalSearchMatch[]
  nextCursor: string | null
  loading: boolean
  error?: string
  activeIndex?: number
}

export type TerminalDirectoryState = {
  windows: Record<string, TerminalDirectoryWindow>
  searches: Record<string, TerminalSearchState>
}

const initialState: TerminalDirectoryState = {
  windows: {},
  searches: {},
}

function ensureWindow(state: TerminalDirectoryState, surface: string): TerminalDirectoryWindow {
  if (!state.windows[surface]) {
    state.windows[surface] = {
      items: [],
      nextCursor: null,
    }
  }
  return state.windows[surface]
}

function ensureSearch(state: TerminalDirectoryState, terminalId: string): TerminalSearchState {
  if (!state.searches[terminalId]) {
    state.searches[terminalId] = {
      query: '',
      matches: [],
      nextCursor: null,
      loading: false,
    }
  }
  return state.searches[terminalId]
}

function mergeDirectoryItems(
  existing: TerminalDirectoryItem[],
  incoming: TerminalDirectoryItem[],
): TerminalDirectoryItem[] {
  const merged = new Map(existing.map((item) => [item.terminalId, item]))
  for (const item of incoming) {
    merged.set(item.terminalId, item)
  }
  return Array.from(merged.values())
}

const terminalDirectorySlice = createSlice({
  name: 'terminalDirectory',
  initialState,
  reducers: {
    setTerminalDirectoryWindowLoading(
      state,
      action: PayloadAction<{ surface: string; loading: boolean }>,
    ) {
      const window = ensureWindow(state, action.payload.surface)
      window.loading = action.payload.loading
    },
    setTerminalDirectoryWindowError(
      state,
      action: PayloadAction<{ surface: string; error?: string }>,
    ) {
      const window = ensureWindow(state, action.payload.surface)
      window.error = action.payload.error
    },
    setTerminalDirectoryWindowData(
      state,
      action: PayloadAction<{
        surface: string
        items: TerminalDirectoryItem[]
        revision?: number
        nextCursor?: string | null
        append?: boolean
      }>,
    ) {
      const window = ensureWindow(state, action.payload.surface)
      window.items = action.payload.append
        ? mergeDirectoryItems(window.items, action.payload.items)
        : action.payload.items
      window.revision = action.payload.revision
      window.nextCursor = action.payload.nextCursor ?? null
      window.loading = false
      window.error = undefined
    },
    clearTerminalDirectoryWindow(state, action: PayloadAction<{ surface: string }>) {
      state.windows[action.payload.surface] = {
        items: [],
        nextCursor: null,
      }
    },
    setTerminalSearchLoading(
      state,
      action: PayloadAction<{ terminalId: string; query: string; loading: boolean }>,
    ) {
      const search = ensureSearch(state, action.payload.terminalId)
      search.query = action.payload.query
      search.loading = action.payload.loading
      if (action.payload.loading) {
        search.matches = []
        search.nextCursor = null
        search.activeIndex = undefined
        search.error = undefined
      }
    },
    setTerminalSearchResults(
      state,
      action: PayloadAction<{
        terminalId: string
        query: string
        matches: TerminalSearchMatch[]
        nextCursor?: string | null
      }>,
    ) {
      const search = ensureSearch(state, action.payload.terminalId)
      search.query = action.payload.query
      search.matches = action.payload.matches
      search.nextCursor = action.payload.nextCursor ?? null
      search.loading = false
      search.error = undefined
      search.activeIndex = action.payload.matches.length > 0 ? 0 : undefined
    },
    setTerminalSearchError(
      state,
      action: PayloadAction<{ terminalId: string; error?: string }>,
    ) {
      const search = ensureSearch(state, action.payload.terminalId)
      search.loading = false
      search.error = action.payload.error
    },
    selectNextTerminalSearchMatch(state, action: PayloadAction<{ terminalId: string }>) {
      const search = ensureSearch(state, action.payload.terminalId)
      if (search.matches.length === 0) {
        search.activeIndex = undefined
        return
      }
      const current = search.activeIndex ?? -1
      search.activeIndex = (current + 1) % search.matches.length
    },
    selectPreviousTerminalSearchMatch(state, action: PayloadAction<{ terminalId: string }>) {
      const search = ensureSearch(state, action.payload.terminalId)
      if (search.matches.length === 0) {
        search.activeIndex = undefined
        return
      }
      const current = search.activeIndex ?? 0
      search.activeIndex = (current - 1 + search.matches.length) % search.matches.length
    },
    clearTerminalSearch(state, action: PayloadAction<{ terminalId: string }>) {
      delete state.searches[action.payload.terminalId]
    },
  },
})

export const {
  setTerminalDirectoryWindowLoading,
  setTerminalDirectoryWindowError,
  setTerminalDirectoryWindowData,
  clearTerminalDirectoryWindow,
  setTerminalSearchLoading,
  setTerminalSearchResults,
  setTerminalSearchError,
  selectNextTerminalSearchMatch,
  selectPreviousTerminalSearchMatch,
  clearTerminalSearch,
} = terminalDirectorySlice.actions

export default terminalDirectorySlice.reducer

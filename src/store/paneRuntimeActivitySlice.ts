import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export type PaneRuntimeActivitySource = 'terminal' | 'browser'

export type PaneRuntimeActivityPhase =
  | 'pending'
  | 'working'
  | 'loading'
  | 'forwarding'
  | 'idle'
  | 'error'

export type PaneRuntimeActivityRecord = {
  source: PaneRuntimeActivitySource
  phase: PaneRuntimeActivityPhase
  updatedAt: number
}

export type PaneRuntimeActivityState = {
  byPaneId: Record<string, PaneRuntimeActivityRecord>
}

const initialState: PaneRuntimeActivityState = {
  byPaneId: {},
}

const paneRuntimeActivitySlice = createSlice({
  name: 'paneRuntimeActivity',
  initialState,
  reducers: {
    setPaneRuntimeActivity(state, action: PayloadAction<{
      paneId: string
      source: PaneRuntimeActivitySource
      phase: PaneRuntimeActivityPhase
      updatedAt?: number
    }>) {
      const { paneId, source, phase } = action.payload
      state.byPaneId[paneId] = {
        source,
        phase,
        updatedAt: action.payload.updatedAt ?? Date.now(),
      }
    },

    clearPaneRuntimeActivity(state, action: PayloadAction<{ paneId: string }>) {
      delete state.byPaneId[action.payload.paneId]
    },
  },
})

export const {
  setPaneRuntimeActivity,
  clearPaneRuntimeActivity,
} = paneRuntimeActivitySlice.actions

export default paneRuntimeActivitySlice.reducer

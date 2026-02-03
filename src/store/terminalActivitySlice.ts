import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export const STREAMING_THRESHOLD_MS = 2000

export interface TerminalActivityState {
  lastOutputAt: Record<string, number>
  lastInputAt: Record<string, number>
  working: Record<string, boolean>
  finished: Record<string, boolean>
}

const initialState: TerminalActivityState = {
  lastOutputAt: {},
  lastInputAt: {},
  working: {},
  finished: {},
}

const terminalActivitySlice = createSlice({
  name: 'terminalActivity',
  initialState,
  reducers: {
    recordOutput: (state, action: PayloadAction<{ paneId: string; at?: number }>) => {
      const { paneId, at } = action.payload
      const now = at ?? Date.now()
      state.lastOutputAt[paneId] = now
      state.working[paneId] = true
      state.finished[paneId] = false
    },
    recordInput: (state, action: PayloadAction<{ paneId: string; at?: number }>) => {
      const { paneId, at } = action.payload
      const now = at ?? Date.now()
      state.lastInputAt[paneId] = now

      // Clear finished state on new input - terminal is active again
      if (state.finished[paneId]) {
        state.finished[paneId] = false
      }

      const lastOutput = state.lastOutputAt[paneId]
      if (state.working[paneId] && typeof lastOutput === 'number' && now - lastOutput >= STREAMING_THRESHOLD_MS) {
        state.working[paneId] = false
        state.finished[paneId] = true
      }
    },
    /**
     * Check all working panes and mark as finished if output stopped.
     * Called periodically by useTerminalActivityMonitor.
     */
    checkActivityTimeout: (state, action: PayloadAction<{ now?: number }>) => {
      const now = action.payload.now ?? Date.now()
      for (const paneId of Object.keys(state.working)) {
        if (!state.working[paneId]) continue
        const lastOutput = state.lastOutputAt[paneId]
        if (typeof lastOutput === 'number' && now - lastOutput >= STREAMING_THRESHOLD_MS) {
          state.working[paneId] = false
          state.finished[paneId] = true
        }
      }
    },
    clearFinished: (state, action: PayloadAction<{ paneId: string }>) => {
      delete state.finished[action.payload.paneId]
    },
    resetPane: (state, action: PayloadAction<{ paneId: string }>) => {
      const { paneId } = action.payload
      delete state.lastOutputAt[paneId]
      delete state.lastInputAt[paneId]
      delete state.working[paneId]
      delete state.finished[paneId]
    },
  },
})

export const { recordOutput, recordInput, checkActivityTimeout, clearFinished, resetPane } = terminalActivitySlice.actions

// Alias for backwards compatibility
export const removePaneActivity = resetPane

export default terminalActivitySlice.reducer

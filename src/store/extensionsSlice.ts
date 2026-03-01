import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { ClientExtensionEntry } from '@shared/extension-types'

interface ExtensionsState {
  entries: ClientExtensionEntry[]
}

const initialState: ExtensionsState = {
  entries: [],
}

export const extensionsSlice = createSlice({
  name: 'extensions',
  initialState,
  reducers: {
    setRegistry: (state, action: PayloadAction<ClientExtensionEntry[]>) => {
      state.entries = action.payload
    },
    updateServerStatus: (
      state,
      action: PayloadAction<{ name: string; serverRunning: boolean; serverPort?: number }>
    ) => {
      const entry = state.entries.find((e) => e.name === action.payload.name)
      if (entry) {
        entry.serverRunning = action.payload.serverRunning
        entry.serverPort = action.payload.serverPort
      }
    },
  },
})

export const { setRegistry, updateServerStatus } = extensionsSlice.actions
export default extensionsSlice.reducer

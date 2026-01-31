import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'ready'

export interface ConnectionState {
  status: ConnectionStatus
  lastError?: string
  lastReadyAt?: number
  platform: string | null
}

const initialState: ConnectionState = {
  status: 'disconnected',
  platform: null,
}

export const connectionSlice = createSlice({
  name: 'connection',
  initialState,
  reducers: {
    setStatus: (state, action: PayloadAction<ConnectionStatus>) => {
      state.status = action.payload
      if (action.payload === 'ready') state.lastReadyAt = Date.now()
    },
    setError: (state, action: PayloadAction<string | undefined>) => {
      state.lastError = action.payload
    },
    setPlatform: (state, action: PayloadAction<string>) => {
      state.platform = action.payload
    },
  },
})

export const { setStatus, setError, setPlatform } = connectionSlice.actions
export default connectionSlice.reducer

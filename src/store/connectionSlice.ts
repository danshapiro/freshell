import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'ready'

export interface ConnectionState {
  status: ConnectionStatus
  lastError?: string
  lastReadyAt?: number
}

const initialState: ConnectionState = {
  status: 'disconnected',
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
  },
})

export const { setStatus, setError } = connectionSlice.actions
export default connectionSlice.reducer

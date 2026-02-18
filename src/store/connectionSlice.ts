import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'ready'

export interface ConnectionState {
  status: ConnectionStatus
  lastError?: string
  lastReadyAt?: number
  serverInstanceId?: string
  platform: string | null
  availableClis: Record<string, boolean>
}

const initialState: ConnectionState = {
  status: 'disconnected',
  platform: null,
  availableClis: {},
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
    setServerInstanceId: (state, action: PayloadAction<string | undefined>) => {
      state.serverInstanceId = action.payload
    },
    setPlatform: (state, action: PayloadAction<string>) => {
      state.platform = action.payload
    },
    setAvailableClis: (state, action: PayloadAction<Record<string, boolean>>) => {
      state.availableClis = action.payload
    },
  },
})

export const { setStatus, setError, setServerInstanceId, setPlatform, setAvailableClis } = connectionSlice.actions
export default connectionSlice.reducer

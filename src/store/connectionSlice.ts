import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'ready'

export interface ConnectionState {
  status: ConnectionStatus
  lastError?: string
  lastErrorCode?: number
  lastReadyAt?: number
  serverInstanceId?: string
  platform: string | null
  availableClis: Record<string, boolean>
  featureFlags: Record<string, boolean>
}

const FATAL_CONNECTION_ERROR_CODES = new Set([4001, 4003, 4010])

export function isFatalConnectionErrorCode(code?: number): boolean {
  return typeof code === 'number' && FATAL_CONNECTION_ERROR_CODES.has(code)
}

const initialState: ConnectionState = {
  status: 'disconnected',
  platform: null,
  availableClis: {},
  featureFlags: {},
}

export const connectionSlice = createSlice({
  name: 'connection',
  initialState,
  reducers: {
    setStatus: (state, action: PayloadAction<ConnectionStatus>) => {
      state.status = action.payload
      if (action.payload === 'ready') {
        state.lastReadyAt = Date.now()
        state.lastErrorCode = undefined
        state.lastError = undefined
      }
    },
    setError: (state, action: PayloadAction<string | undefined>) => {
      state.lastError = action.payload
    },
    setErrorCode: (state, action: PayloadAction<number | undefined>) => {
      state.lastErrorCode = action.payload
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
    setFeatureFlags: (state, action: PayloadAction<Record<string, boolean>>) => {
      state.featureFlags = action.payload
    },
  },
})

export const { setStatus, setError, setErrorCode, setServerInstanceId, setPlatform, setAvailableClis, setFeatureFlags } = connectionSlice.actions
export default connectionSlice.reducer

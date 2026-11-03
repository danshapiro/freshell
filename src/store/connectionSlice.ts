import { createSlice, PayloadAction } from '@reduxjs/toolkit'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'ready'

export interface ConnectionState {
  status: ConnectionStatus
  lastError?: string
  lastErrorCode?: number
  lastReadyAt?: number
  /** Monotonic id for each successful ready handshake, including same-ms reconnects. */
  readySequence?: number
  serverInstanceId?: string
  bootId?: string
  serverRestarted?: boolean
  liveTerminalIds?: string[]
  platform: string | null
  availableClis: Record<string, boolean>
  featureFlags: Record<string, boolean>
  /**
   * Session-index readiness (auto-restore-warming Task 5): is the server's
   * session index warm for THIS connection? Ephemeral per-connection state —
   * set from `ready.sessionIndexReady` at handshake time and from the
   * `sessions.index.ready` broadcast on the transition; never persisted
   * (connection-slice state is never persisted). False by default; an old
   * server or non-negotiating client never leaves false.
   */
  sessionIndexReady: boolean
}

const FATAL_CONNECTION_ERROR_CODES = new Set([4001, 4003, 4010])

export function isFatalConnectionErrorCode(code?: number): boolean {
  return typeof code === 'number' && FATAL_CONNECTION_ERROR_CODES.has(code)
}

const initialState: ConnectionState = {
  status: 'disconnected',
  readySequence: 0,
  platform: null,
  availableClis: {},
  featureFlags: {},
  sessionIndexReady: false,
}

export const connectionSlice = createSlice({
  name: 'connection',
  initialState,
  reducers: {
    setStatus: (state, action: PayloadAction<ConnectionStatus>) => {
      const becameReady = action.payload === 'ready' && state.status !== 'ready'
      state.status = action.payload
      if (action.payload === 'ready') {
        state.lastReadyAt = Date.now()
        // App's ready handler and connect() completion both report the
        // same socket. Only a transition back to ready starts a new round.
        if (becameReady) state.readySequence = (state.readySequence ?? 0) + 1
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
    setBootId: (state, action: PayloadAction<string | undefined>) => {
      state.bootId = action.payload
    },
    setServerRestarted: (state, action: PayloadAction<boolean>) => {
      state.serverRestarted = action.payload
    },
    setLiveTerminalIds: (state, action: PayloadAction<string[] | undefined>) => {
      state.liveTerminalIds = action.payload
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
    /**
     * Session-index readiness (auto-restore-warming Task 5): idempotent
     * per-connection state set. Driven by the ready frame's
     * `sessionIndexReady` state field (which also RESETS it — a server
     * restart re-folds the new boot's readiness) and by the
     * `sessions.index.ready` broadcast (which only raises it).
     */
    setSessionIndexReady: (state, action: PayloadAction<boolean>) => {
      state.sessionIndexReady = action.payload
    },
  },
})

export const { setStatus, setError, setErrorCode, setServerInstanceId, setBootId, setServerRestarted, setLiveTerminalIds, setPlatform, setAvailableClis, setFeatureFlags, setSessionIndexReady } = connectionSlice.actions
export default connectionSlice.reducer

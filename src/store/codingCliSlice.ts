import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { NormalizedEvent, CodingCliProviderName } from '@/lib/coding-cli-types'

export interface CodingCliSessionState {
  sessionId: string
  provider: CodingCliProviderName
  prompt: string
  status: 'running' | 'completed' | 'error'
  events: NormalizedEvent[]
  providerSessionId?: string
  cwd?: string
  createdAt: number
}

export interface CodingCliPendingRequest {
  requestId: string
  provider: CodingCliProviderName
  prompt: string
  cwd?: string
  canceled?: boolean
  createdAt: number
}

interface CodingCliState {
  sessions: Record<string, CodingCliSessionState>
  pendingRequests: Record<string, CodingCliPendingRequest>
}

const initialState: CodingCliState = {
  sessions: {},
  pendingRequests: {},
}

const codingCliSlice = createSlice({
  name: 'codingCli',
  initialState,
  reducers: {
    createCodingCliSession(
      state,
      action: PayloadAction<{ sessionId: string; provider: CodingCliProviderName; prompt: string; cwd?: string }>
    ) {
      state.sessions[action.payload.sessionId] = {
        sessionId: action.payload.sessionId,
        provider: action.payload.provider,
        prompt: action.payload.prompt,
        cwd: action.payload.cwd,
        status: 'running',
        events: [],
        createdAt: Date.now(),
      }
    },

    addCodingCliEvent(state, action: PayloadAction<{ sessionId: string; event: NormalizedEvent }>) {
      const session = state.sessions[action.payload.sessionId]
      if (session) {
        session.events.push(action.payload.event)
        if (action.payload.event.type === 'session.start' || action.payload.event.type === 'session.init') {
          session.providerSessionId = action.payload.event.sessionId
        }
      }
    },

    setCodingCliSessionStatus(
      state,
      action: PayloadAction<{ sessionId: string; status: CodingCliSessionState['status'] }>
    ) {
      const session = state.sessions[action.payload.sessionId]
      if (session) {
        session.status = action.payload.status
      }
    },

    clearCodingCliSession(state, action: PayloadAction<{ sessionId: string }>) {
      delete state.sessions[action.payload.sessionId]
    },
    registerCodingCliRequest(
      state,
      action: PayloadAction<{ requestId: string; provider: CodingCliProviderName; prompt: string; cwd?: string }>
    ) {
      state.pendingRequests[action.payload.requestId] = {
        requestId: action.payload.requestId,
        provider: action.payload.provider,
        prompt: action.payload.prompt,
        cwd: action.payload.cwd,
        canceled: false,
        createdAt: Date.now(),
      }
    },
    cancelCodingCliRequest(state, action: PayloadAction<{ requestId: string }>) {
      const pending = state.pendingRequests[action.payload.requestId]
      if (pending) {
        pending.canceled = true
      }
    },
    resolveCodingCliRequest(state, action: PayloadAction<{ requestId: string }>) {
      delete state.pendingRequests[action.payload.requestId]
    },
  },
})

export const {
  createCodingCliSession,
  addCodingCliEvent,
  setCodingCliSessionStatus,
  clearCodingCliSession,
  registerCodingCliRequest,
  cancelCodingCliRequest,
  resolveCodingCliRequest,
} = codingCliSlice.actions

export default codingCliSlice.reducer

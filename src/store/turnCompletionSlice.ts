import { createSlice, PayloadAction } from '@reduxjs/toolkit'

type TurnCompletePayload = {
  tabId: string
  paneId: string
  terminalId: string
  at: number
}

export type TurnCompleteEvent = TurnCompletePayload & { seq: number }

export interface TurnCompletionState {
  seq: number
  lastEvent: TurnCompleteEvent | null
  pendingEvents: TurnCompleteEvent[]
  attentionByTab: Record<string, boolean>
}

const initialState: TurnCompletionState = {
  seq: 0,
  lastEvent: null,
  pendingEvents: [],
  attentionByTab: {},
}

const turnCompletionSlice = createSlice({
  name: 'turnCompletion',
  initialState,
  reducers: {
    recordTurnComplete(state, action: PayloadAction<TurnCompletePayload>) {
      state.seq += 1
      const event = {
        ...action.payload,
        seq: state.seq,
      }
      state.lastEvent = event
      state.pendingEvents.push(event)
    },
    consumeTurnCompleteEvents(state, action: PayloadAction<{ throughSeq: number }>) {
      const { throughSeq } = action.payload
      if (throughSeq <= 0) return
      state.pendingEvents = state.pendingEvents.filter((event) => event.seq > throughSeq)
    },
    markTabAttention(state, action: PayloadAction<{ tabId: string }>) {
      state.attentionByTab[action.payload.tabId] = true
    },
    clearTabAttention(state, action: PayloadAction<{ tabId: string }>) {
      delete state.attentionByTab[action.payload.tabId]
    },
  },
})

export const {
  recordTurnComplete,
  consumeTurnCompleteEvents,
  markTabAttention,
  clearTabAttention,
} = turnCompletionSlice.actions

export default turnCompletionSlice.reducer

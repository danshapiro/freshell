import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { TURN_COMPLETION_STORAGE_KEY } from './storage-keys'

type TurnCompletePayload = {
  tabId: string
  paneId: string
  terminalId: string
  at: number
  completionSeq?: number
}

export type TurnCompleteEvent = TurnCompletePayload & { seq: number }

export interface TurnCompletionState {
  seq: number
  lastAtByTerminalId: Record<string, number>
  lastAppliedCompletionSeqByTerminalId?: Record<string, number>
  pendingEvents: TurnCompleteEvent[]
  attentionByTab: Record<string, boolean>
  attentionByPane: Record<string, boolean>
}

function readBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, boolean> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === true) out[key] = true
  }
  return out
}

function readNumberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0) {
      out[key] = entry
    }
  }
  return out
}

export function loadPersistedTurnCompletionState(): Pick<
  TurnCompletionState,
  'attentionByTab' | 'attentionByPane' | 'lastAppliedCompletionSeqByTerminalId'
> {
  const empty = {
    attentionByTab: {},
    attentionByPane: {},
    lastAppliedCompletionSeqByTerminalId: {},
  }
  if (typeof localStorage === 'undefined') return empty

  try {
    const raw = localStorage.getItem(TURN_COMPLETION_STORAGE_KEY)
    if (!raw) return empty
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return empty
    return {
      attentionByTab: readBooleanRecord(parsed.attentionByTab),
      attentionByPane: readBooleanRecord(parsed.attentionByPane),
      lastAppliedCompletionSeqByTerminalId: readNumberRecord(parsed.lastAppliedCompletionSeqByTerminalId),
    }
  } catch {
    return empty
  }
}

const persistedTurnCompletion = loadPersistedTurnCompletionState()

const initialState: TurnCompletionState = {
  seq: 0,
  lastAtByTerminalId: {},
  lastAppliedCompletionSeqByTerminalId: persistedTurnCompletion.lastAppliedCompletionSeqByTerminalId,
  pendingEvents: [],
  attentionByTab: persistedTurnCompletion.attentionByTab,
  attentionByPane: persistedTurnCompletion.attentionByPane,
}

const turnCompletionSlice = createSlice({
  name: 'turnCompletion',
  initialState,
  reducers: {
    recordTurnComplete(state, action: PayloadAction<TurnCompletePayload>) {
      const { terminalId, at, completionSeq } = action.payload
      if (completionSeq !== undefined) {
        const applied = state.lastAppliedCompletionSeqByTerminalId ??= {}
        const lastApplied = applied[terminalId]
        if (lastApplied !== undefined && completionSeq <= lastApplied) return
        applied[terminalId] = completionSeq
        state.lastAtByTerminalId[terminalId] = at
      } else {
        // Monotonic, replay-safe dedupe: only record a completion strictly newer
        // than the last seen for this terminal. A replayed/stale completion with
        // an older-or-equal `at` is ignored so scrollback replay cannot re-green.
        const last = state.lastAtByTerminalId[terminalId]
        if (last !== undefined && at <= last) return
        state.lastAtByTerminalId[terminalId] = at
      }
      state.seq += 1
      state.pendingEvents.push({
        ...action.payload,
        seq: state.seq,
      })
    },
    // Cleared on a real server restart (not a plain reconnect). The new process has no
    // buffered events to replay, and its wall clock may be behind a clamp-inflated
    // pre-restart `at`, so dropping the per-terminal `at` baseline lets the first genuine
    // post-restart completion through instead of swallowing it as a stale replay.
    resetCompletionDedupeBaselines(state) {
      state.lastAtByTerminalId = {}
    },
    consumeTurnCompleteEvents(state, action: PayloadAction<{ throughSeq: number }>) {
      const { throughSeq } = action.payload
      if (throughSeq <= 0) return
      state.pendingEvents = state.pendingEvents.filter((event) => event.seq > throughSeq)
    },
    markTabAttention(state, action: PayloadAction<{ tabId: string }>) {
      if (state.attentionByTab[action.payload.tabId]) return
      state.attentionByTab[action.payload.tabId] = true
    },
    clearTabAttention(state, action: PayloadAction<{ tabId: string }>) {
      if (!state.attentionByTab[action.payload.tabId]) return
      delete state.attentionByTab[action.payload.tabId]
    },
    markPaneAttention(state, action: PayloadAction<{ paneId: string }>) {
      if (state.attentionByPane[action.payload.paneId]) return
      state.attentionByPane[action.payload.paneId] = true
    },
    clearPaneAttention(state, action: PayloadAction<{ paneId: string }>) {
      if (!state.attentionByPane[action.payload.paneId]) return
      delete state.attentionByPane[action.payload.paneId]
    },
  },
})

export const {
  recordTurnComplete,
  resetCompletionDedupeBaselines,
  consumeTurnCompleteEvents,
  markTabAttention,
  clearTabAttention,
  markPaneAttention,
  clearPaneAttention,
} = turnCompletionSlice.actions

export default turnCompletionSlice.reducer

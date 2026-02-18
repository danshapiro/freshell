import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import type { NormalizedEvent } from '@/lib/coding-cli-types'
import type {
  ActivityPanelState,
  ActivityPanelSessionState,
  ActivityPanelEvent,
  PendingApproval,
  ActivityTask,
} from './activityPanelTypes'
import { ACTIVITY_PANEL_MAX_EVENTS } from './activityPanelTypes'

function createSessionState(): ActivityPanelSessionState {
  return {
    events: [],
    eventStart: 0,
    eventCount: 0,
    tokenTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalCost: 0,
    },
    pendingApprovals: [],
    tasks: [],
  }
}

function ensureSession(state: ActivityPanelState, sessionId: string): ActivityPanelSessionState {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = createSessionState()
  }
  return state.sessions[sessionId]
}

const initialState: ActivityPanelState = {
  sessions: {},
  visibility: {},
}

const activityPanelSlice = createSlice({
  name: 'activityPanel',
  initialState,
  reducers: {
    togglePanel(state, action: PayloadAction<{ sessionId: string }>) {
      const { sessionId } = action.payload
      state.visibility[sessionId] = !state.visibility[sessionId]
    },

    setPanel(state, action: PayloadAction<{ sessionId: string; open: boolean }>) {
      const { sessionId, open } = action.payload
      state.visibility[sessionId] = open
    },

    addActivityEvent(state, action: PayloadAction<{ sessionId: string; event: NormalizedEvent }>) {
      const { sessionId, event } = action.payload
      const session = ensureSession(state, sessionId)

      const panelEvent: ActivityPanelEvent = {
        event,
        id: `${sessionId}-${session.eventCount}`,
      }

      if (session.events.length < ACTIVITY_PANEL_MAX_EVENTS) {
        session.events.push(panelEvent)
      } else {
        session.events[session.eventStart] = panelEvent
        session.eventStart = (session.eventStart + 1) % ACTIVITY_PANEL_MAX_EVENTS
      }
      session.eventCount += 1
    },

    updateTokenUsage(
      state,
      action: PayloadAction<{
        sessionId: string
        inputTokens: number
        outputTokens: number
        cachedTokens?: number
        totalCost?: number
      }>
    ) {
      const { sessionId, inputTokens, outputTokens, cachedTokens, totalCost } = action.payload
      const session = ensureSession(state, sessionId)
      session.tokenTotals.inputTokens += inputTokens
      session.tokenTotals.outputTokens += outputTokens
      session.tokenTotals.cachedTokens += cachedTokens ?? 0
      session.tokenTotals.totalCost += totalCost ?? 0
    },

    addPendingApproval(state, action: PayloadAction<{ sessionId: string; approval: PendingApproval }>) {
      const { sessionId, approval } = action.payload
      const session = ensureSession(state, sessionId)
      // Avoid duplicates
      if (!session.pendingApprovals.some((a) => a.requestId === approval.requestId)) {
        session.pendingApprovals.push(approval)
      }
    },

    resolvePendingApproval(state, action: PayloadAction<{ sessionId: string; requestId: string }>) {
      const { sessionId, requestId } = action.payload
      const session = state.sessions[sessionId]
      if (session) {
        session.pendingApprovals = session.pendingApprovals.filter((a) => a.requestId !== requestId)
      }
    },

    updateTask(state, action: PayloadAction<{ sessionId: string; task: ActivityTask }>) {
      const { sessionId, task } = action.payload
      const session = ensureSession(state, sessionId)
      const idx = session.tasks.findIndex((t) => t.id === task.id)
      if (idx >= 0) {
        session.tasks[idx] = task
      } else {
        session.tasks.push(task)
      }
    },

    clearSession(state, action: PayloadAction<{ sessionId: string }>) {
      delete state.sessions[action.payload.sessionId]
      delete state.visibility[action.payload.sessionId]
    },
  },
})

export const {
  togglePanel,
  setPanel,
  addActivityEvent,
  updateTokenUsage,
  addPendingApproval,
  resolvePendingApproval,
  updateTask,
  clearSession,
} = activityPanelSlice.actions

// Selectors
export function getActivityPanelEvents(session: ActivityPanelSessionState): ActivityPanelEvent[] {
  if (session.events.length < ACTIVITY_PANEL_MAX_EVENTS) {
    return session.events
  }
  // Return events in chronological order from ring buffer
  const start = session.eventStart
  return [...session.events.slice(start), ...session.events.slice(0, start)]
}

export default activityPanelSlice.reducer

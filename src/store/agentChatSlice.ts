import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import type {
  AgentChatState,
  AgentTimelineItem,
  AgentTimelineTurn,
  ChatContentBlock,
  ChatMessage,
  ChatSessionState,
  PendingCreateFailure,
  QuestionDefinition,
} from './agentChatTypes'

const initialState: AgentChatState = {
  sessions: {},
  pendingCreates: {},
  pendingCreateFailures: {},
  availableModels: [],
}

/** Create a default empty session if one doesn't already exist. */
function ensureSession(state: AgentChatState, sessionId: string): ChatSessionState {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = {
      sessionId,
      status: 'starting',
      messages: [],
      timelineItems: [],
      timelineBodies: {},
      streamingText: '',
      streamingActive: false,
      pendingPermissions: {},
      pendingQuestions: {},
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    }
  }
  return state.sessions[sessionId]
}

function resetHydratedTimelineStateForRestoreRetry(session: ChatSessionState): void {
  session.latestTurnId = undefined
  session.timelineItems = []
  session.timelineBodies = {}
  session.nextTimelineCursor = undefined
  session.timelineRevision = undefined
  session.timelineLoading = false
  session.timelineError = undefined
  session.historyLoaded = false
}

const agentChatSlice = createSlice({
  name: 'agentChat',
  initialState,
  reducers: {
    registerPendingCreate(state, action: PayloadAction<{
      requestId: string
      expectsHistoryHydration: boolean
    }>) {
      const current = state.pendingCreates[action.payload.requestId]
      state.pendingCreates[action.payload.requestId] = {
        sessionId: current?.sessionId,
        expectsHistoryHydration: action.payload.expectsHistoryHydration,
      }
    },

    sessionCreated(state, action: PayloadAction<{ requestId: string; sessionId: string }>) {
      const { requestId, sessionId } = action.payload
      const pending = state.pendingCreates[requestId]
      const expectsHistoryHydration = pending?.expectsHistoryHydration ?? false
      const session = ensureSession(state, sessionId)
      // Fresh creates have no history to load, but resumed creates stay in
      // restore mode until snapshot/timeline data establishes durable history.
      session.historyLoaded = !expectsHistoryHydration
      session.awaitingDurableHistory = expectsHistoryHydration
      session.restoreRetryCount = 0
      session.restoreFailureCode = undefined
      state.pendingCreates[requestId] = {
        sessionId,
        expectsHistoryHydration,
      }
    },

    sessionInit(state, action: PayloadAction<{
      sessionId: string
      cliSessionId?: string
      model?: string
      cwd?: string
      tools?: Array<{ name: string }>
    }>) {
      const session = ensureSession(state, action.payload.sessionId)
      session.cliSessionId = action.payload.cliSessionId
      session.model = action.payload.model
      session.cwd = action.payload.cwd
      session.tools = action.payload.tools
      if (action.payload.cliSessionId) {
        session.awaitingDurableHistory = false
      }
      if (session.status === 'creating' || session.status === 'starting') {
        session.status = 'connected'
      }
    },

    sessionMetadataReceived(state, action: PayloadAction<{
      sessionId: string
      cliSessionId?: string
      model?: string
      cwd?: string
      tools?: Array<{ name: string }>
    }>) {
      const session = ensureSession(state, action.payload.sessionId)
      session.cliSessionId = action.payload.cliSessionId ?? session.cliSessionId
      if (isValidClaudeSessionId(action.payload.cliSessionId)) {
        session.timelineSessionId = action.payload.cliSessionId
        session.awaitingDurableHistory = false
      }
      session.model = action.payload.model ?? session.model
      session.cwd = action.payload.cwd ?? session.cwd
      session.tools = action.payload.tools ?? session.tools
    },

    sessionSnapshotReceived(state, action: PayloadAction<{
      sessionId: string
      latestTurnId: string | null
      status: ChatSessionState['status']
      timelineSessionId?: string
      revision?: number
      streamingActive?: boolean
      streamingText?: string
    }>) {
      const session = ensureSession(state, action.payload.sessionId)
      session.latestTurnId = action.payload.latestTurnId
      session.status = action.payload.status
      session.timelineSessionId = action.payload.timelineSessionId
      session.timelineRevision = action.payload.revision
      session.streamingActive = action.payload.streamingActive ?? false
      session.streamingText = action.payload.streamingText ?? ''
      session.restoreFailureCode = undefined
      if (action.payload.latestTurnId === null) {
        const hasDurableHistoryIdentity = isValidClaudeSessionId(session.timelineSessionId)
          || isValidClaudeSessionId(session.cliSessionId)
        if (!session.awaitingDurableHistory || hasDurableHistoryIdentity) {
          session.historyLoaded = true
          session.awaitingDurableHistory = false
        }
      } else {
        session.awaitingDurableHistory = false
      }
    },

    addUserMessage(state, action: PayloadAction<{
      sessionId: string
      text: string
    }>) {
      const session = state.sessions[action.payload.sessionId]
      if (!session) return
      session.messages.push({
        role: 'user',
        content: [{ type: 'text', text: action.payload.text }],
        timestamp: new Date().toISOString(),
      })
      session.status = 'running'
    },

    addAssistantMessage(state, action: PayloadAction<{
      sessionId: string
      content: ChatContentBlock[]
      model?: string
    }>) {
      const session = state.sessions[action.payload.sessionId]
      if (!session) return
      session.messages.push({
        role: 'assistant',
        content: action.payload.content,
        timestamp: new Date().toISOString(),
        model: action.payload.model,
      })
      session.status = 'running'
    },

    setStreaming(state, action: PayloadAction<{ sessionId: string; active: boolean }>) {
      const session = state.sessions[action.payload.sessionId]
      if (!session) return
      session.streamingActive = action.payload.active
      if (action.payload.active) {
        session.streamingText = ''
      }
    },

    appendStreamDelta(state, action: PayloadAction<{ sessionId: string; text: string }>) {
      const session = state.sessions[action.payload.sessionId]
      if (!session) return
      session.streamingText += action.payload.text
    },

    clearStreaming(state, action: PayloadAction<{ sessionId: string }>) {
      const session = state.sessions[action.payload.sessionId]
      if (!session) return
      session.streamingText = ''
      session.streamingActive = false
    },

    addPermissionRequest(state, action: PayloadAction<{
      sessionId: string
      requestId: string
      subtype: string
      tool?: { name: string; input?: Record<string, unknown> }
    }>) {
      const session = state.sessions[action.payload.sessionId]
      if (!session) return
      session.pendingPermissions[action.payload.requestId] = {
        requestId: action.payload.requestId,
        subtype: action.payload.subtype,
        tool: action.payload.tool,
      }
    },

    removePermission(state, action: PayloadAction<{ sessionId: string; requestId: string }>) {
      const session = state.sessions[action.payload.sessionId]
      if (!session) return
      delete session.pendingPermissions[action.payload.requestId]
    },

    addQuestionRequest(state, action: PayloadAction<{
      sessionId: string
      requestId: string
      questions: QuestionDefinition[]
    }>) {
      const session = state.sessions[action.payload.sessionId]
      if (!session) return
      session.pendingQuestions[action.payload.requestId] = {
        requestId: action.payload.requestId,
        questions: action.payload.questions,
      }
    },

    removeQuestion(state, action: PayloadAction<{ sessionId: string; requestId: string }>) {
      const session = state.sessions[action.payload.sessionId]
      if (!session) return
      delete session.pendingQuestions[action.payload.requestId]
    },

    setSessionStatus(state, action: PayloadAction<{
      sessionId: string
      status: ChatSessionState['status']
    }>) {
      const session = ensureSession(state, action.payload.sessionId)
      session.status = action.payload.status
    },

    turnResult(state, action: PayloadAction<{
      sessionId: string
      costUsd?: number
      durationMs?: number
      usage?: { input_tokens: number; output_tokens: number }
    }>) {
      const session = state.sessions[action.payload.sessionId]
      if (!session) return
      if (action.payload.costUsd != null) session.totalCostUsd += action.payload.costUsd
      if (action.payload.usage) {
        session.totalInputTokens += action.payload.usage.input_tokens
        session.totalOutputTokens += action.payload.usage.output_tokens
      }
      session.status = 'idle'
      session.streamingActive = false
      session.streamingText = ''
    },

    sessionExited(state, action: PayloadAction<{ sessionId: string; exitCode?: number }>) {
      const session = state.sessions[action.payload.sessionId]
      if (!session) return
      session.status = 'exited'
      session.streamingActive = false
    },

    timelineLoadStarted(state, action: PayloadAction<{ sessionId: string }>) {
      const session = state.sessions[action.payload.sessionId]
      if (!session) return
      session.timelineLoading = true
      session.timelineError = undefined
    },

    timelinePageReceived(state, action: PayloadAction<{
      sessionId: string
      items: AgentTimelineItem[]
      nextCursor: string | null
      revision: number
      replace?: boolean
      bodies?: Record<string, AgentTimelineTurn>
    }>) {
      const session = ensureSession(state, action.payload.sessionId)
      const nextBodies = Object.fromEntries(
        Object.entries(action.payload.bodies ?? {}).map(([turnId, turn]) => [turnId, turn.message]),
      )
      session.timelineItems = action.payload.replace === false
        ? [...session.timelineItems, ...action.payload.items]
        : action.payload.items
      session.timelineBodies = action.payload.replace === false
        ? { ...session.timelineBodies, ...nextBodies }
        : nextBodies
      session.timelineRevision = action.payload.revision
      session.nextTimelineCursor = action.payload.nextCursor
      session.timelineLoading = false
      session.timelineError = undefined
      session.awaitingDurableHistory = false
      session.historyLoaded = true
      session.restoreRetryCount = 0
      session.restoreFailureCode = undefined
    },

    timelineLoadFailed(state, action: PayloadAction<{ sessionId: string; message: string }>) {
      const session = ensureSession(state, action.payload.sessionId)
      session.timelineLoading = false
      session.timelineError = action.payload.message
    },

    turnBodyReceived(state, action: PayloadAction<{
      sessionId: string
      turnId: string
      message: ChatMessage
    }>) {
      const session = ensureSession(state, action.payload.sessionId)
      session.timelineBodies[action.payload.turnId] = action.payload.message
    },

    sessionError(state, action: PayloadAction<{ sessionId: string; message: string }>) {
      const session = ensureSession(state, action.payload.sessionId)
      session.lastError = action.payload.message
    },

    /** Mark a session as lost (server confirmed it no longer exists).
     *  Creates the session entry if needed (e.g. after page refresh where Redux
     *  was empty) and sets flags that enable AgentChatView to detect the loss
     *  and trigger immediate recovery. */
    markSessionLost(state, action: PayloadAction<{ sessionId: string }>) {
      const session = ensureSession(state, action.payload.sessionId)
      session.awaitingDurableHistory = false
      session.lost = true
      session.historyLoaded = true
    },

    restoreRetryRequested(state, action: PayloadAction<{ sessionId: string; code: string }>) {
      const session = ensureSession(state, action.payload.sessionId)
      resetHydratedTimelineStateForRestoreRetry(session)
      session.restoreRetryCount = (session.restoreRetryCount ?? 0) + 1
      session.restoreFailureCode = action.payload.code
    },

    createFailed(state, action: PayloadAction<{ requestId: string } & PendingCreateFailure>) {
      const { requestId, ...failure } = action.payload
      state.pendingCreateFailures[requestId] = failure
    },

    clearPendingCreateFailure(state, action: PayloadAction<{ requestId: string }>) {
      delete state.pendingCreateFailures[action.payload.requestId]
    },

    clearPendingCreate(state, action: PayloadAction<{ requestId: string }>) {
      delete state.pendingCreates[action.payload.requestId]
    },

    removeSession(state, action: PayloadAction<{ sessionId: string }>) {
      delete state.sessions[action.payload.sessionId]
    },

    setAvailableModels(state, action: PayloadAction<{
      models: Array<{ value: string; displayName: string; description: string }>
    }>) {
      state.availableModels = action.payload.models
    },
  },
})

export const {
  registerPendingCreate,
  sessionCreated,
  sessionInit,
  sessionMetadataReceived,
  sessionSnapshotReceived,
  addUserMessage,
  addAssistantMessage,
  setStreaming,
  appendStreamDelta,
  clearStreaming,
  addPermissionRequest,
  removePermission,
  addQuestionRequest,
  removeQuestion,
  setSessionStatus,
  turnResult,
  sessionExited,
  timelineLoadStarted,
  timelinePageReceived,
  timelineLoadFailed,
  turnBodyReceived,
  sessionError,
  markSessionLost,
  restoreRetryRequested,
  createFailed,
  clearPendingCreateFailure,
  clearPendingCreate,
  removeSession,
  setAvailableModels,
} = agentChatSlice.actions

export default agentChatSlice.reducer

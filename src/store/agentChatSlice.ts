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

/** Check if content blocks contain only tool_use and tool_result blocks (no text or thinking). */
function isToolOnlyContent(blocks: ChatContentBlock[]): boolean {
  return blocks.length > 0 && blocks.every(
    (b) => b.type === 'tool_use' || b.type === 'tool_result'
  )
}

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

function getRestoreQueryId(session: Pick<ChatSessionState, 'cliSessionId' | 'timelineSessionId'>): string | undefined {
  return (isValidClaudeSessionId(session.cliSessionId) ? session.cliSessionId : undefined)
    ?? (isValidClaudeSessionId(session.timelineSessionId) ? session.timelineSessionId : undefined)
}

function isRestoreFailureCode(code?: string): code is string {
  return typeof code === 'string' && code.startsWith('RESTORE_')
}

function markTerminalRestoreFailure(session: ChatSessionState, code: string, message: string): void {
  session.awaitingDurableHistory = false
  session.historyLoaded = true
  session.timelineLoading = false
  session.restoreFailureCode = code
  session.restoreFailureMessage = message
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
  session.restoreFailureMessage = undefined
}

function resetHydratedTimelineStateForDurableUpgrade(session: ChatSessionState): void {
  session.timelineItems = []
  session.timelineBodies = {}
  session.nextTimelineCursor = undefined
  session.timelineLoading = false
  session.timelineError = undefined
  session.historyLoaded = false
  session.messages = []
  session.streamingText = ''
  session.streamingActive = false
  session.restoreFailureMessage = undefined
}

function requestFreshSnapshotRefresh(session: ChatSessionState): void {
  resetHydratedTimelineStateForRestoreRetry(session)
  session.messages = []
  session.streamingText = ''
  session.streamingActive = false
  session.snapshotRefreshRequestId = (session.snapshotRefreshRequestId ?? 0) + 1
}

function requestRestoreHydrationRestart(session: ChatSessionState): void {
  session.restoreHydrationRequestId = (session.restoreHydrationRequestId ?? 0) + 1
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
      session.restoreFailureMessage = undefined
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
      if (isValidClaudeSessionId(action.payload.cliSessionId)) {
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
      const nextCliSessionId = action.payload.cliSessionId ?? session.cliSessionId
      const previousRestoreQueryId = getRestoreQueryId(session)
      const nextRestoreQueryId = getRestoreQueryId({
        cliSessionId: nextCliSessionId,
        timelineSessionId: session.timelineSessionId,
      })
      const shouldRequestFreshSnapshot = Boolean(
        session.historyLoaded
          && isValidClaudeSessionId(nextCliSessionId)
          && nextRestoreQueryId
          && previousRestoreQueryId !== nextRestoreQueryId,
      )

      if (shouldRequestFreshSnapshot) {
        requestFreshSnapshotRefresh(session)
        session.restoreRetryCount = 0
        session.restoreFailureCode = undefined
        session.restoreFailureMessage = undefined
      }

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
      const previousRestoreQueryId = getRestoreQueryId(session)
      const nextTimelineSessionId = isValidClaudeSessionId(action.payload.timelineSessionId)
        ? action.payload.timelineSessionId
        : undefined
      const nextRestoreQueryId = getRestoreQueryId({
        cliSessionId: session.cliSessionId,
        timelineSessionId: nextTimelineSessionId ?? session.timelineSessionId,
      })
      const shouldRestartHydration = Boolean(
        session.historyLoaded
          && (
            (nextRestoreQueryId && previousRestoreQueryId && nextRestoreQueryId !== previousRestoreQueryId)
            || (
              action.payload.revision != null
              && session.timelineRevision != null
              && action.payload.revision !== session.timelineRevision
            )
          ),
      )
      if (shouldRestartHydration) {
        resetHydratedTimelineStateForDurableUpgrade(session)
        requestRestoreHydrationRestart(session)
      }

      session.latestTurnId = action.payload.latestTurnId
      session.status = action.payload.status
      session.timelineSessionId = nextTimelineSessionId
      session.timelineRevision = action.payload.revision
      session.streamingActive = action.payload.streamingActive ?? false
      session.streamingText = action.payload.streamingText ?? ''
      session.restoreFailureCode = undefined
      session.restoreFailureMessage = undefined
      session.snapshotRefreshRequestId = undefined
      if (action.payload.latestTurnId === null) {
        const hasDurableHistoryIdentity = isValidClaudeSessionId(nextTimelineSessionId)
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
      session.streamingActive = false
      session.streamingText = ''

      const newContent = action.payload.content
      const prevMessage = session.messages[session.messages.length - 1]

      // Coalesce consecutive tool-only assistant messages
      if (
        prevMessage?.role === 'assistant' &&
        isToolOnlyContent(prevMessage.content) &&
        isToolOnlyContent(newContent)
      ) {
        // Append content blocks to previous message instead of creating new one
        prevMessage.content = [...prevMessage.content, ...newContent]
      } else {
        session.messages.push({
          role: 'assistant',
          content: newContent,
          timestamp: new Date().toISOString(),
          model: action.payload.model,
        })
      }
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
      timelineSessionId?: string
      items: AgentTimelineItem[]
      nextCursor: string | null
      revision: number
      replace?: boolean
      bodies?: Record<string, AgentTimelineTurn>
    }>) {
      const session = ensureSession(state, action.payload.sessionId)
      const nextBodies = action.payload.bodies ?? {}
      session.timelineItems = action.payload.replace === false
        ? [...session.timelineItems, ...action.payload.items]
        : action.payload.items
      session.timelineBodies = action.payload.replace === false
        ? { ...session.timelineBodies, ...nextBodies }
        : nextBodies
      if (action.payload.timelineSessionId) {
        session.timelineSessionId = action.payload.timelineSessionId
      }
      session.timelineRevision = action.payload.revision
      session.nextTimelineCursor = action.payload.nextCursor
      session.timelineLoading = false
      session.timelineError = undefined
      session.awaitingDurableHistory = false
      session.historyLoaded = true
      session.restoreRetryCount = 0
      session.restoreFailureCode = undefined
      session.restoreFailureMessage = undefined
    },

    timelineLoadFailed(state, action: PayloadAction<{ sessionId: string; message: string; code?: string }>) {
      const session = ensureSession(state, action.payload.sessionId)
      session.timelineLoading = false
      session.timelineError = action.payload.message
      if (isRestoreFailureCode(action.payload.code)) {
        markTerminalRestoreFailure(session, action.payload.code, action.payload.message)
      }
    },

    turnBodyReceived(state, action: PayloadAction<{
      sessionId: string
      turn: AgentTimelineTurn
    }>) {
      const session = ensureSession(state, action.payload.sessionId)
      session.timelineBodies[action.payload.turn.turnId] = action.payload.turn
    },

    sessionError(state, action: PayloadAction<{ sessionId: string; message: string; code?: string }>) {
      const session = ensureSession(state, action.payload.sessionId)
      session.lastError = action.payload.message
      if (isRestoreFailureCode(action.payload.code)) {
        markTerminalRestoreFailure(session, action.payload.code, action.payload.message)
      }
    },

    /** Mark a session as lost (server confirmed it no longer exists).
     *  Creates the session entry if needed (e.g. after page refresh where Redux
     *  was empty) and sets flags that enable AgentChatView to detect the loss
     *  and trigger recovery. If restore hydration already has a pinned snapshot
     *  but has not loaded the first timeline window yet, keep that hydration
     *  pending so the rebuilt transcript can render before the pane detaches. */
    markSessionLost(state, action: PayloadAction<{ sessionId: string }>) {
      const session = ensureSession(state, action.payload.sessionId)
      session.awaitingDurableHistory = false
      session.lost = true
      const waitingForInitialRestoreWindow = (
        session.latestTurnId !== undefined
        && session.historyLoaded !== true
      )
      session.historyLoaded = waitingForInitialRestoreWindow ? false : true
    },

    restoreRetryRequested(state, action: PayloadAction<{ sessionId: string; code: string }>) {
      const session = ensureSession(state, action.payload.sessionId)
      resetHydratedTimelineStateForRestoreRetry(session)
      session.snapshotRefreshRequestId = undefined
      session.restoreRetryCount = (session.restoreRetryCount ?? 0) + 1
      session.restoreFailureCode = action.payload.code
      session.restoreFailureMessage = undefined
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

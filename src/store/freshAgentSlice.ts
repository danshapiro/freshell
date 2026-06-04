import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import {
  makeFreshAgentSessionKey,
  type FreshAgentRuntimeProvider,
  type FreshAgentSessionType,
} from '@shared/fresh-agent'
import type { FreshAgentSnapshot } from '@shared/fresh-agent-contract'
import type {
  FreshAgentPermissionRequest,
  FreshAgentQuestionRequest,
  FreshAgentSessionState,
  FreshAgentSessionStatus,
  FreshAgentState,
  PendingCreateFailure,
} from './freshAgentTypes'

type FreshAgentSessionPayload = {
  sessionId: string
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
}

type SessionMutationPayload = {
  sessionId: string
  sessionType?: FreshAgentSessionType
  provider?: FreshAgentRuntimeProvider
}

const initialState: FreshAgentState = {
  sessions: {},
  pendingCreates: {},
  pendingCreateFailures: {},
  availableModels: [],
}

function sessionKey(locator: FreshAgentSessionPayload): string {
  return makeFreshAgentSessionKey(locator)
}

function resolveSessionKey(
  state: FreshAgentState,
  payload: SessionMutationPayload,
): string | undefined {
  if (payload.sessionType && payload.provider) {
    return sessionKey({
      sessionId: payload.sessionId,
      sessionType: payload.sessionType,
      provider: payload.provider,
    })
  }

  return Object.values(state.sessions).find((session) => session.sessionId === payload.sessionId)?.sessionKey
}

function createSession(locator: FreshAgentSessionPayload, status: FreshAgentSessionStatus): FreshAgentSessionState {
  const key = sessionKey(locator)
  return {
    ...locator,
    sessionKey: key,
    threadId: locator.sessionId,
    status,
    turns: [],
    timelineItems: [],
    timelineBodies: {},
    streamingText: '',
    streamingActive: false,
    pendingPermissions: {},
    pendingQuestions: {},
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    historyLoaded: false,
  }
}

function ensureSession(
  state: FreshAgentState,
  locator: FreshAgentSessionPayload,
  status: FreshAgentSessionStatus = 'starting',
): FreshAgentSessionState {
  const key = sessionKey(locator)
  state.sessions[key] ??= createSession(locator, status)
  return state.sessions[key]
}

function resolveOrEnsureSession(
  state: FreshAgentState,
  payload: SessionMutationPayload,
  status: FreshAgentSessionStatus = 'starting',
): FreshAgentSessionState | undefined {
  const key = resolveSessionKey(state, payload)
  if (key && state.sessions[key]) return state.sessions[key]
  if (!payload.sessionType || !payload.provider) return undefined
  return ensureSession(state, {
    sessionId: payload.sessionId,
    sessionType: payload.sessionType,
    provider: payload.provider,
  }, status)
}

function resetHydratedTimelineState(session: FreshAgentSessionState): void {
  session.latestTurnId = undefined
  session.turns = []
  session.timelineItems = []
  session.timelineBodies = {}
  session.nextTimelineCursor = undefined
  session.timelineLoading = false
  session.timelineError = undefined
  session.historyLoaded = false
  session.restoreFailureMessage = undefined
  session.streamingText = ''
  session.streamingActive = false
}

function requestRestoreHydrationRestart(session: FreshAgentSessionState): void {
  session.restoreHydrationRequestId = (session.restoreHydrationRequestId ?? 0) + 1
}

const freshAgentSlice = createSlice({
  name: 'freshAgent',
  initialState,
  reducers: {
    registerPendingCreate(state, action: PayloadAction<{
      requestId: string
      expectsHistoryHydration: boolean
      sessionType?: FreshAgentSessionType
      provider?: FreshAgentRuntimeProvider
    }>) {
      const current = state.pendingCreates[action.payload.requestId]
      state.pendingCreates[action.payload.requestId] = {
        sessionId: current?.sessionId,
        sessionKey: current?.sessionKey,
        sessionType: action.payload.sessionType ?? current?.sessionType,
        provider: action.payload.provider ?? current?.provider,
        expectsHistoryHydration: action.payload.expectsHistoryHydration,
      }
    },

    clearPendingCreate(state, action: PayloadAction<{ requestId: string }>) {
      delete state.pendingCreates[action.payload.requestId]
    },

    sessionCreated(state, action: PayloadAction<{
      requestId: string
      sessionId: string
      sessionType?: FreshAgentSessionType
      provider?: FreshAgentRuntimeProvider
    }>) {
      const pending = state.pendingCreates[action.payload.requestId]
      const sessionType = action.payload.sessionType ?? pending?.sessionType
      const provider = action.payload.provider ?? pending?.provider
      if (!sessionType || !provider) return

      const locator = { sessionId: action.payload.sessionId, sessionType, provider }
      const key = sessionKey(locator)
      const expectsHistoryHydration = pending?.expectsHistoryHydration ?? false
      const session = ensureSession(state, locator, 'connected')
      session.status = session.status === 'starting' || session.status === 'creating'
        ? 'connected'
        : session.status
      session.historyLoaded = !expectsHistoryHydration
      session.awaitingDurableHistory = expectsHistoryHydration
      session.restoreRetryCount = 0
      session.restoreFailureCode = undefined
      session.restoreFailureMessage = undefined
      session.lost = false

      state.pendingCreates[action.payload.requestId] = {
        sessionId: action.payload.sessionId,
        sessionKey: key,
        sessionType,
        provider,
        expectsHistoryHydration,
      }
    },

    sessionInit(state, action: PayloadAction<SessionMutationPayload & {
      cliSessionId?: string
      model?: string
      cwd?: string
      tools?: Array<{ name: string }>
    }>) {
      const session = resolveOrEnsureSession(state, action.payload)
      if (!session) return
      session.cliSessionId = action.payload.cliSessionId
      session.model = action.payload.model
      session.cwd = action.payload.cwd
      session.tools = action.payload.tools
      session.awaitingDurableHistory = action.payload.cliSessionId ? false : session.awaitingDurableHistory
      if (session.status === 'creating' || session.status === 'starting') {
        session.status = 'connected'
      }
    },

    sessionMetadataReceived(state, action: PayloadAction<SessionMutationPayload & {
      cliSessionId?: string
      model?: string
      cwd?: string
      tools?: Array<{ name: string }>
    }>) {
      const session = resolveOrEnsureSession(state, action.payload)
      if (!session) return
      session.cliSessionId = action.payload.cliSessionId ?? session.cliSessionId
      session.timelineSessionId = action.payload.cliSessionId ?? session.timelineSessionId
      session.model = action.payload.model ?? session.model
      session.cwd = action.payload.cwd ?? session.cwd
      session.tools = action.payload.tools ?? session.tools
      if (action.payload.cliSessionId) {
        session.awaitingDurableHistory = false
      }
    },

    sessionSnapshotReceived(state, action: PayloadAction<SessionMutationPayload & {
      latestTurnId: string | null
      status: FreshAgentSessionStatus
      timelineSessionId?: string
      revision?: number
      streamingActive?: boolean
      streamingText?: string
    }>) {
      const session = resolveOrEnsureSession(state, action.payload, action.payload.status)
      if (!session) return
      const shouldRestartHydration = Boolean(
        session.historyLoaded
          && action.payload.revision != null
          && session.timelineRevision != null
          && action.payload.revision !== session.timelineRevision,
      )
      if (shouldRestartHydration) {
        resetHydratedTimelineState(session)
        requestRestoreHydrationRestart(session)
      }

      session.latestTurnId = action.payload.latestTurnId
      session.status = action.payload.status
      session.timelineSessionId = action.payload.timelineSessionId ?? session.timelineSessionId
      session.timelineRevision = action.payload.revision ?? session.timelineRevision
      session.streamingActive = action.payload.streamingActive ?? false
      session.streamingText = action.payload.streamingText ?? ''
      session.restoreFailureCode = undefined
      session.restoreFailureMessage = undefined
      session.snapshotRefreshRequestId = undefined
      if (action.payload.latestTurnId === null && !session.awaitingDurableHistory) {
        session.historyLoaded = true
      } else if (action.payload.latestTurnId !== null) {
        session.awaitingDurableHistory = false
      }
    },

    freshAgentSnapshotReceived(state, action: PayloadAction<{ snapshot: FreshAgentSnapshot }>) {
      const snapshot = action.payload.snapshot
      const session = ensureSession(state, {
        sessionId: snapshot.threadId,
        sessionType: snapshot.sessionType,
        provider: snapshot.provider,
      }, snapshot.status as FreshAgentSessionStatus)
      session.snapshot = snapshot
      session.status = snapshot.status as FreshAgentSessionStatus
      session.latestTurnId = snapshot.latestTurnId
      session.timelineRevision = snapshot.revision
      session.turns = snapshot.turns
      session.timelineItems = snapshot.turns
      session.timelineBodies = Object.fromEntries(snapshot.turns.map((turn) => [turn.turnId, turn]))
      session.pendingPermissions = Object.fromEntries(
        snapshot.pendingApprovals.map((approval) => [String(approval.requestId), approval]),
      )
      session.pendingQuestions = Object.fromEntries(
        snapshot.pendingQuestions.map((question) => [String(question.requestId), question]),
      )
      session.totalInputTokens = snapshot.tokenUsage.inputTokens
      session.totalOutputTokens = snapshot.tokenUsage.outputTokens
      session.totalCostUsd = snapshot.tokenUsage.costUsd ?? 0
      session.historyLoaded = true
      session.awaitingDurableHistory = false
    },

    setSessionStatus(state, action: PayloadAction<SessionMutationPayload & { status: FreshAgentSessionStatus }>) {
      const session = resolveOrEnsureSession(state, action.payload, action.payload.status)
      if (!session) return
      session.status = action.payload.status
      // A terminal/idle status ends the turn: clear streaming too, else busy stays
      // true (isFreshAgentBusy = streamingActive || running) and the pane is stuck
      // blue after a natural stream-end / sdk.status:idle broadcast.
      if (action.payload.status === 'idle' || action.payload.status === 'exited') {
        session.streamingActive = false
      }
    },

    setAvailableModels(state, action: PayloadAction<Array<{ value: string; displayName: string; description: string }>>) {
      state.availableModels = action.payload
    },

    addPermissionRequest(state, action: PayloadAction<SessionMutationPayload & FreshAgentPermissionRequest>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      state.sessions[key].pendingPermissions[String(action.payload.requestId)] = action.payload
    },

    removePermission(state, action: PayloadAction<SessionMutationPayload & { requestId: string | number }>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      delete state.sessions[key].pendingPermissions[String(action.payload.requestId)]
    },

    addQuestionRequest(state, action: PayloadAction<SessionMutationPayload & FreshAgentQuestionRequest>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      state.sessions[key].pendingQuestions[String(action.payload.requestId)] = action.payload
    },

    removeQuestion(state, action: PayloadAction<SessionMutationPayload & { requestId: string | number }>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      delete state.sessions[key].pendingQuestions[String(action.payload.requestId)]
    },

    sessionError(state, action: PayloadAction<SessionMutationPayload & { code?: string; message: string }>) {
      const session = resolveOrEnsureSession(state, action.payload)
      if (!session) return
      session.lastError = action.payload.message
      if (action.payload.code?.startsWith('RESTORE_')) {
        session.awaitingDurableHistory = false
        session.historyLoaded = true
        session.timelineLoading = false
        session.restoreFailureCode = action.payload.code
        session.restoreFailureMessage = action.payload.message
      } else {
        // A hard (non-restore) error ends the turn: clear streaming + drop an
        // active 'running'/'starting' status to idle so the pane does not stay blue.
        session.streamingActive = false
        if (session.status === 'running' || session.status === 'starting') {
          session.status = 'idle'
        }
      }
    },

    markSessionLost(state, action: PayloadAction<SessionMutationPayload>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      state.sessions[key].lost = true
    },

    removeSession(state, action: PayloadAction<SessionMutationPayload>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      delete state.sessions[key]
    },

    createFailed(state, action: PayloadAction<{ requestId: string } & PendingCreateFailure>) {
      state.pendingCreateFailures[action.payload.requestId] = {
        code: action.payload.code,
        message: action.payload.message,
        retryable: action.payload.retryable,
      }
    },

    clearPendingCreateFailure(state, action: PayloadAction<{ requestId: string }>) {
      delete state.pendingCreateFailures[action.payload.requestId]
    },

    restoreRetryRequested(state, action: PayloadAction<SessionMutationPayload>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      const session = state.sessions[key]
      resetHydratedTimelineState(session)
      session.restoreRetryCount = (session.restoreRetryCount ?? 0) + 1
    },

    timelineLoadStarted(state, action: PayloadAction<SessionMutationPayload>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      state.sessions[key].timelineLoading = true
      state.sessions[key].timelineError = undefined
    },

    timelinePageReceived(state, action: PayloadAction<SessionMutationPayload & {
      turns: FreshAgentSessionState['timelineItems']
      nextCursor?: string | null
      revision?: number
    }>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      const session = state.sessions[key]
      session.timelineLoading = false
      session.historyLoaded = true
      session.timelineItems = action.payload.turns
      session.nextTimelineCursor = action.payload.nextCursor
      session.timelineRevision = action.payload.revision ?? session.timelineRevision
    },

    timelineLoadFailed(state, action: PayloadAction<SessionMutationPayload & { message: string }>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      const session = state.sessions[key]
      session.timelineLoading = false
      session.timelineError = action.payload.message
    },

    turnBodyReceived(state, action: PayloadAction<SessionMutationPayload & { turn: FreshAgentSessionState['timelineItems'][number] }>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      state.sessions[key].timelineBodies[action.payload.turn.turnId] = action.payload.turn
    },

    turnResult() {},
    addUserMessage() {},
    addAssistantMessage() {},
    setStreaming() {},
    appendStreamDelta() {},
    clearStreaming() {},
    clearPendingCreateFailureForSession() {},
    sessionExited(state, action: PayloadAction<SessionMutationPayload>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      state.sessions[key].status = 'exited'
    },
  },
})

export const {
  addAssistantMessage,
  addPermissionRequest,
  addQuestionRequest,
  addUserMessage,
  appendStreamDelta,
  clearPendingCreate,
  clearPendingCreateFailure,
  clearPendingCreateFailureForSession,
  clearStreaming,
  createFailed,
  freshAgentSnapshotReceived,
  markSessionLost,
  registerPendingCreate,
  removePermission,
  removeQuestion,
  removeSession,
  restoreRetryRequested,
  sessionCreated,
  sessionError,
  sessionExited,
  sessionInit,
  sessionMetadataReceived,
  sessionSnapshotReceived,
  setAvailableModels,
  setSessionStatus,
  setStreaming,
  timelineLoadFailed,
  timelineLoadStarted,
  timelinePageReceived,
  turnBodyReceived,
  turnResult,
} = freshAgentSlice.actions

export default freshAgentSlice.reducer

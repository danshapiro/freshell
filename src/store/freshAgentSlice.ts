import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import {
  makeFreshAgentSessionKey,
  type FreshAgentRuntimeProvider,
  type FreshAgentSessionType,
} from '@shared/fresh-agent'
import type { FreshAgentSnapshot } from '@shared/fresh-agent-contract'
import type {
  FreshAgentContentBlock,
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

type FreshAgentSessionMaterializedPayload = FreshAgentSessionPayload & {
  previousSessionId: string
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
    historyItems: [],
    historyBodies: {},
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

function resetHydratedHistoryState(session: FreshAgentSessionState): void {
  session.latestTurnId = undefined
  session.turns = []
  session.historyItems = []
  session.historyBodies = {}
  session.nextHistoryCursor = undefined
  session.historyLoading = false
  session.historyError = undefined
  session.historyLoaded = false
  session.restoreFailureMessage = undefined
  session.streamingText = ''
  session.streamingActive = false
}

function requestRestoreHydrationRestart(session: FreshAgentSessionState): void {
  session.restoreHydrationRequestId = (session.restoreHydrationRequestId ?? 0) + 1
}

function summarizeFreshAgentItems(items: FreshAgentContentBlock[]): string {
  const text = items
    .map((item) => {
      if (item.kind === 'text') return item.text
      if (item.kind === 'thinking') return item.text
      if (item.kind === 'tool_use') return item.name
      if (item.kind === 'tool_result') return typeof item.content === 'string' ? item.content : JSON.stringify(item.content)
      return item.kind
    })
    .filter(Boolean)
    .join(' ')
    .trim()
  return text || 'Agent activity'
}

function normalizeLegacyContentBlock(block: Record<string, unknown>, index: number): FreshAgentContentBlock | undefined {
  const id = typeof block.id === 'string' && block.id.length > 0
    ? block.id
    : `legacy-${index}`

  switch (block.type) {
    case 'text':
      return {
        id,
        kind: 'text',
        text: typeof block.text === 'string' ? block.text : '',
      }
    case 'thinking':
      return {
        id,
        kind: 'thinking',
        text: typeof block.thinking === 'string' ? block.thinking : String(block.text ?? ''),
      }
    case 'tool_use':
      return {
        id,
        kind: 'tool_use',
        toolUseId: typeof block.id === 'string' ? block.id : id,
        name: typeof block.name === 'string' ? block.name : 'Tool',
        input: block.input,
      }
    case 'tool_result':
      return {
        id,
        kind: 'tool_result',
        toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : id,
        content: block.content ?? '',
        isError: Boolean(block.is_error),
      }
    default:
      return undefined
  }
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
      cwd?: string
    }>) {
      const current = state.pendingCreates[action.payload.requestId]
      state.pendingCreates[action.payload.requestId] = {
        sessionId: current?.sessionId,
        sessionKey: current?.sessionKey,
        sessionType: action.payload.sessionType ?? current?.sessionType,
        provider: action.payload.provider ?? current?.provider,
        cwd: action.payload.cwd ?? current?.cwd,
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
      if (pending?.cwd) session.cwd = pending.cwd
      session.restoreRetryCount = 0
      session.restoreFailureCode = undefined
      session.restoreFailureMessage = undefined
      session.lost = false

      state.pendingCreates[action.payload.requestId] = {
        sessionId: action.payload.sessionId,
        sessionKey: key,
        sessionType,
        provider,
        cwd: pending?.cwd,
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
      const metadataCliSessionId = action.payload.cliSessionId
      const wouldDowngradeSnapshotIdentity = Boolean(
        metadataCliSessionId
          && session.historyRevision != null
          && session.historySessionId
          && session.historySessionId !== metadataCliSessionId,
      )
      if (metadataCliSessionId && !wouldDowngradeSnapshotIdentity) {
        session.cliSessionId = metadataCliSessionId
        session.historySessionId = metadataCliSessionId
      }
      session.model = action.payload.model ?? session.model
      session.cwd = action.payload.cwd ?? session.cwd
      session.tools = action.payload.tools ?? session.tools
      if (metadataCliSessionId && !wouldDowngradeSnapshotIdentity) {
        session.awaitingDurableHistory = false
      }
    },

    sessionSnapshotReceived(state, action: PayloadAction<SessionMutationPayload & {
      latestTurnId: string | null
      status: FreshAgentSessionStatus
      historySessionId?: string
      revision?: number
      streamingActive?: boolean
      streamingText?: string
    }>) {
      const session = resolveOrEnsureSession(state, action.payload, action.payload.status)
      if (!session) return
      const shouldRestartHydration = Boolean(
        session.historyLoaded
          && action.payload.revision != null
          && session.historyRevision != null
          && action.payload.revision !== session.historyRevision,
      )
      if (shouldRestartHydration) {
        resetHydratedHistoryState(session)
        requestRestoreHydrationRestart(session)
      }

      session.latestTurnId = action.payload.latestTurnId
      session.status = action.payload.status
      session.historySessionId = action.payload.historySessionId ?? session.historySessionId
      session.historyRevision = action.payload.revision ?? session.historyRevision
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

    materializeSession(state, action: PayloadAction<FreshAgentSessionMaterializedPayload>) {
      const previousLocator = {
        sessionId: action.payload.previousSessionId,
        sessionType: action.payload.sessionType,
        provider: action.payload.provider,
      }
      const nextLocator = {
        sessionId: action.payload.sessionId,
        sessionType: action.payload.sessionType,
        provider: action.payload.provider,
      }
      const previousKey = sessionKey(previousLocator)
      const nextKey = sessionKey(nextLocator)
      const previousSession = state.sessions[previousKey]
      const nextSession = state.sessions[nextKey]

      if (previousSession || nextSession) {
        state.sessions[nextKey] = {
          ...(previousSession ?? createSession(nextLocator, 'connected')),
          ...(nextSession ?? {}),
          ...nextLocator,
          sessionKey: nextKey,
          threadId: action.payload.sessionId,
          lost: false,
          restoreFailureCode: undefined,
          restoreFailureMessage: undefined,
        }
        if (previousKey !== nextKey) {
          delete state.sessions[previousKey]
        }
      } else {
        ensureSession(state, nextLocator, 'connected')
      }

      for (const pending of Object.values(state.pendingCreates)) {
        if (pending.sessionId === action.payload.previousSessionId || pending.sessionKey === previousKey) {
          pending.sessionId = action.payload.sessionId
          pending.sessionKey = nextKey
          pending.sessionType = action.payload.sessionType
          pending.provider = action.payload.provider
        }
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
      session.historyRevision = snapshot.revision
      session.turns = snapshot.turns
      session.historyItems = snapshot.turns
      session.historyBodies = Object.fromEntries(snapshot.turns.map((turn) => [turn.turnId, turn]))
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
      // blue after a natural stream-end / freshAgent.status:idle broadcast.
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
        session.historyLoading = false
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
      resetHydratedHistoryState(session)
      session.restoreRetryCount = (session.restoreRetryCount ?? 0) + 1
    },

    historyLoadStarted(state, action: PayloadAction<SessionMutationPayload>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      state.sessions[key].historyLoading = true
      state.sessions[key].historyError = undefined
    },

    historyPageReceived(state, action: PayloadAction<SessionMutationPayload & {
      turns: FreshAgentSessionState['historyItems']
      nextCursor?: string | null
      revision?: number
    }>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      const session = state.sessions[key]
      session.historyLoading = false
      session.historyLoaded = true
      session.historyItems = action.payload.turns
      session.nextHistoryCursor = action.payload.nextCursor
      session.historyRevision = action.payload.revision ?? session.historyRevision
    },

    historyLoadFailed(state, action: PayloadAction<SessionMutationPayload & { message: string }>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      const session = state.sessions[key]
      session.historyLoading = false
      session.historyError = action.payload.message
    },

    turnBodyReceived(state, action: PayloadAction<SessionMutationPayload & { turn: FreshAgentSessionState['historyItems'][number] }>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      state.sessions[key].historyBodies[action.payload.turn.turnId] = action.payload.turn
    },

    turnResult(state, action: PayloadAction<SessionMutationPayload & {
      costUsd?: number
      durationMs?: number
      usage?: { input_tokens?: number; output_tokens?: number }
    }>) {
      const session = resolveOrEnsureSession(state, action.payload, 'idle')
      if (!session) return
      session.status = 'idle'
      session.streamingActive = false
      session.totalCostUsd += action.payload.costUsd ?? 0
      session.totalInputTokens += action.payload.usage?.input_tokens ?? 0
      session.totalOutputTokens += action.payload.usage?.output_tokens ?? 0
    },
    addUserMessage(state, action: PayloadAction<SessionMutationPayload & { text: string }>) {
      const session = resolveOrEnsureSession(state, action.payload, 'running')
      if (!session) return
      const turnId = `live-user-${session.turns.length + 1}`
      session.turns.push({
        id: turnId,
        turnId,
        role: 'user',
        summary: action.payload.text,
        items: [{ id: `${turnId}-text`, kind: 'text', text: action.payload.text }],
      })
      session.historyItems = session.turns
    },
    addAssistantMessage(state, action: PayloadAction<SessionMutationPayload & {
      content: Record<string, unknown>[]
      model?: string
    }>) {
      const session = resolveOrEnsureSession(state, action.payload, 'idle')
      if (!session) return
      const items = action.payload.content
        .map((block, index) => normalizeLegacyContentBlock(block, index))
        .filter((item): item is FreshAgentContentBlock => item !== undefined)
      const turnId = `live-assistant-${session.turns.length + 1}`
      session.turns.push({
        id: turnId,
        turnId,
        role: 'assistant',
        model: action.payload.model,
        summary: summarizeFreshAgentItems(items),
        items,
      })
      session.historyItems = session.turns
      session.streamingText = ''
      session.streamingActive = false
    },
    setStreaming(state, action: PayloadAction<SessionMutationPayload & { active: boolean }>) {
      const session = resolveOrEnsureSession(state, action.payload, action.payload.active ? 'running' : 'idle')
      if (!session) return
      session.streamingActive = action.payload.active
      if (action.payload.active && session.status === 'idle') {
        session.status = 'running'
      }
    },
    appendStreamDelta(state, action: PayloadAction<SessionMutationPayload & { text: string }>) {
      const session = resolveOrEnsureSession(state, action.payload, 'running')
      if (!session) return
      session.streamingActive = true
      session.streamingText += action.payload.text
      if (session.status === 'idle') {
        session.status = 'running'
      }
    },
    clearStreaming(state, action: PayloadAction<SessionMutationPayload>) {
      const session = resolveOrEnsureSession(state, action.payload)
      if (!session) return
      session.streamingText = ''
      session.streamingActive = false
    },
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
  materializeSession,
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
  historyLoadFailed,
  historyLoadStarted,
  historyPageReceived,
  turnBodyReceived,
  turnResult,
} = freshAgentSlice.actions

export default freshAgentSlice.reducer

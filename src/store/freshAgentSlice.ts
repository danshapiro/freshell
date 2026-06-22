import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import {
  makeFreshAgentSessionKey,
  type FreshAgentRuntimeProvider,
  type FreshAgentSessionType,
} from '@shared/fresh-agent'
import { getFreshAgentTurnIdentityKeys, isTemporaryFreshAgentTurnId } from '@shared/fresh-agent-turns'
import type { FreshAgentSnapshot, FreshAgentTurn } from '@shared/fresh-agent-contract'
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
  session.historyInitialLoading = false
  session.historyOlderLoading = false
  session.historyOlderError = undefined
  session.historyBackfillComplete = false
  session.historyBackfillPaused = false
  session.historyInitialRequestKey = undefined
  session.historyOlderRequestKey = undefined
  session.historyLoaded = false
  session.restoreFailureMessage = undefined
  session.streamingText = ''
  session.streamingActive = false
}

function mergeUniqueTurnsByIdentity(
  first: FreshAgentTurn[],
  second: FreshAgentTurn[],
): FreshAgentTurn[] {
  const seen = new Set<string>()
  const merged: FreshAgentTurn[] = []
  for (const turn of [...first, ...second]) {
    const keys = getFreshAgentTurnIdentityKeys(turn)
    if (keys.length > 0 && keys.some((key) => seen.has(key))) continue
    for (const key of keys) seen.add(key)
    merged.push(turn)
  }
  return merged
}

function mergeTurnsReplacingByIdentity(
  existing: FreshAgentTurn[],
  incoming: FreshAgentTurn[],
): FreshAgentTurn[] {
  const incomingByKey = new Map<string, FreshAgentTurn>()
  const consumed = new Set<FreshAgentTurn>()
  for (const turn of incoming) {
    for (const key of getFreshAgentTurnIdentityKeys(turn)) {
      incomingByKey.set(key, turn)
    }
  }

  const merged = existing.map((turn) => {
    const replacement = getFreshAgentTurnIdentityKeys(turn)
      .map((key) => incomingByKey.get(key))
      .find((candidate): candidate is FreshAgentTurn => Boolean(candidate))
    if (replacement) {
      consumed.add(replacement)
      return replacement
    }
    return turn
  })

  for (const turn of incoming) {
    if (!consumed.has(turn)) merged.push(turn)
  }
  return mergeUniqueTurnsByIdentity([], merged)
}

function isSnapshotStatusInFlight(status: string | undefined): boolean {
  return status === 'running' || status === 'compacting'
}

function appendLiveTurn(session: FreshAgentSessionState, turn: FreshAgentTurn): void {
  session.turns = mergeUniqueTurnsByIdentity(session.turns, [turn])
  session.historyBodies[turn.turnId] = turn
}

export function selectFreshAgentTranscriptTurns(session: FreshAgentSessionState): FreshAgentTurn[] {
  if (session.historyItems.length === 0) {
    return session.turns
  }

  const loadedKeys = new Set(session.historyItems.flatMap(getFreshAgentTurnIdentityKeys))
  const loadedOrdinals = session.historyItems
    .map((turn) => turn.ordinal)
    .filter((ordinal): ordinal is number => typeof ordinal === 'number')
  const maxLoadedOrdinal = loadedOrdinals.length > 0 ? Math.max(...loadedOrdinals) : undefined
  const loadedTimestamps = session.historyItems
    .map((turn) => (turn.timestamp ? Date.parse(turn.timestamp) : Number.NaN))
    .filter(Number.isFinite)
  const maxLoadedTimestamp = loadedTimestamps.length > 0 ? Math.max(...loadedTimestamps) : undefined

  const liveOrNewTurns = session.turns.filter((turn) => {
    if (getFreshAgentTurnIdentityKeys(turn).some((key) => loadedKeys.has(key))) {
      return false
    }
    if (maxLoadedOrdinal !== undefined && typeof turn.ordinal === 'number') {
      return turn.ordinal > maxLoadedOrdinal
    }
    if (maxLoadedTimestamp !== undefined && turn.timestamp) {
      const timestamp = Date.parse(turn.timestamp)
      if (Number.isFinite(timestamp)) return timestamp > maxLoadedTimestamp
    }
    return turn.source === 'live'
      || isTemporaryFreshAgentTurnId(turn.turnId)
      || isTemporaryFreshAgentTurnId(turn.id)
  })

  return mergeUniqueTurnsByIdentity(session.historyItems, liveOrNewTurns)
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

    freshAgentSnapshotReceived(state, action: PayloadAction<{ snapshot: FreshAgentSnapshot; hydrateHistory?: boolean }>) {
      const snapshot = action.payload.snapshot
      const hydrateHistory = action.payload.hydrateHistory !== false
      const snapshotTurns = snapshot.turns ?? []
      const pendingApprovals = snapshot.pendingApprovals ?? []
      const pendingQuestions = snapshot.pendingQuestions ?? []
      const tokenUsage = snapshot.tokenUsage ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }
      const session = ensureSession(state, {
        sessionId: snapshot.threadId,
        sessionType: snapshot.sessionType,
        provider: snapshot.provider,
      }, snapshot.status as FreshAgentSessionStatus)
      session.snapshot = snapshot
      session.status = snapshot.status as FreshAgentSessionStatus
      session.latestTurnId = snapshot.latestTurnId
      session.historyRevision = snapshot.revision
      if (hydrateHistory) {
        session.turns = snapshotTurns
        session.historyItems = snapshotTurns
        session.historyBodies = Object.fromEntries(snapshotTurns.map((turn) => [turn.turnId, turn]))
      } else if (snapshotTurns.length > 0) {
        session.turns = isSnapshotStatusInFlight(snapshot.status)
          ? mergeTurnsReplacingByIdentity(session.turns, snapshotTurns)
          : snapshotTurns
        for (const turn of snapshotTurns) {
          session.historyBodies[turn.turnId] = turn
        }
      }
      session.pendingPermissions = Object.fromEntries(
        pendingApprovals.map((approval) => [String(approval.requestId), approval]),
      )
      session.pendingQuestions = Object.fromEntries(
        pendingQuestions.map((question) => [String(question.requestId), question]),
      )
      session.totalInputTokens = tokenUsage.inputTokens
      session.totalOutputTokens = tokenUsage.outputTokens
      session.totalCostUsd = tokenUsage.costUsd ?? 0
      session.historyLoaded = hydrateHistory ? true : session.historyLoaded
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

    historyLoadStarted(state, action: PayloadAction<SessionMutationPayload & {
      cursor?: string
      requestKey?: string
    }>) {
      const session = resolveOrEnsureSession(state, action.payload)
      if (!session) return
      session.historyLoading = true
      if (action.payload.cursor) {
        session.historyOlderLoading = true
        session.historyOlderError = undefined
        session.historyOlderRequestKey = action.payload.requestKey
      } else {
        session.historyInitialLoading = true
        session.historyError = undefined
        session.historyOlderError = undefined
        session.historyInitialRequestKey = action.payload.requestKey
      }
    },

    historyPageReceived(state, action: PayloadAction<SessionMutationPayload & {
      turns: FreshAgentSessionState['historyItems']
      bodies?: Record<string, FreshAgentSessionState['historyItems'][number]>
      nextCursor?: string | null
      revision?: number
      cursor?: string
      requestKey?: string
    }>) {
      const session = resolveOrEnsureSession(state, action.payload)
      if (!session) return
      const expectedRequestKey = action.payload.cursor
        ? session.historyOlderRequestKey
        : session.historyInitialRequestKey
      if (action.payload.requestKey && expectedRequestKey && action.payload.requestKey !== expectedRequestKey) return
      if (session.restoreFailureMessage) return
      const incoming = action.payload.turns
      const loadingOlderPage = Boolean(action.payload.cursor)
      const hadHistoryItems = session.historyItems.length > 0
      const previousRevision = session.historyRevision
      const nextRevision = action.payload.revision ?? previousRevision
      const revisionChanged = previousRevision !== undefined
        && nextRevision !== undefined
        && previousRevision !== nextRevision
      session.historyLoading = false
      session.historyInitialLoading = false
      session.historyOlderLoading = false
      session.historyLoaded = true
      session.historyItems = loadingOlderPage
        ? mergeUniqueTurnsByIdentity(incoming, session.historyItems)
        : hadHistoryItems
          ? mergeTurnsReplacingByIdentity(session.historyItems, incoming)
          : incoming
      for (const turn of incoming) {
        session.historyBodies[turn.turnId] = turn
      }
      for (const [turnId, body] of Object.entries(action.payload.bodies ?? {})) {
        session.historyBodies[turnId] = body
      }
      if (loadingOlderPage || !hadHistoryItems || revisionChanged) {
        session.nextHistoryCursor = action.payload.nextCursor
        session.historyBackfillComplete = action.payload.nextCursor == null
      } else if (action.payload.nextCursor == null) {
        session.nextHistoryCursor = null
        session.historyBackfillComplete = true
      }
      session.historyRevision = nextRevision
      session.historyBackfillPaused = false
    },

    historyLoadFailed(state, action: PayloadAction<SessionMutationPayload & {
      message: string
      cursor?: string
      requestKey?: string
    }>) {
      const session = resolveOrEnsureSession(state, action.payload)
      if (!session) return
      const expectedRequestKey = action.payload.cursor
        ? session.historyOlderRequestKey
        : session.historyInitialRequestKey
      if (action.payload.requestKey && expectedRequestKey && action.payload.requestKey !== expectedRequestKey) return
      session.historyLoading = false
      if (action.payload.cursor) {
        session.historyOlderLoading = false
        session.historyOlderError = action.payload.message
        session.historyBackfillPaused = true
      } else {
        session.historyInitialLoading = false
        session.historyError = action.payload.message
      }
    },

    turnBodyReceived(state, action: PayloadAction<SessionMutationPayload & {
      turn: FreshAgentSessionState['historyItems'][number]
      revision?: number
    }>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      if (action.payload.revision !== undefined && state.sessions[key].historyRevision !== undefined && action.payload.revision !== state.sessions[key].historyRevision) return
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
      appendLiveTurn(session, {
        id: turnId,
        turnId,
        role: 'user',
        summary: action.payload.text,
        items: [{ id: `${turnId}-text`, kind: 'text', text: action.payload.text }],
      })
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
      appendLiveTurn(session, {
        id: turnId,
        turnId,
        role: 'assistant',
        model: action.payload.model,
        summary: summarizeFreshAgentItems(items),
        items,
      })
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

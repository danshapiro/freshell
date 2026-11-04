import { createSlice, type PayloadAction } from '@reduxjs/toolkit'
import {
  makeFreshAgentSessionKey,
  type FreshAgentRuntimeProvider,
  type FreshAgentSessionType,
} from '@shared/fresh-agent'
import type { FreshAgentSnapshot } from '@shared/fresh-agent-contract'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import type { SessionRuntimeOwnerMessage } from '@shared/ws-protocol'
import type {
  FreshAgentPermissionRequest,
  FreshAgentRequestId,
  FreshAgentQuestionRequest,
  FreshAgentSessionState,
  FreshAgentSessionStatus,
  FreshAgentState,
  PendingCreateFailure,
  RuntimeOwnerRecord,
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

type ControlCancellation = { requestId: FreshAgentRequestId; operationAttemptId?: string; operationJournalId?: string; operationJournalSequence?: number }

// Keep replay deduplication bounded without retaining copies of provider text.
function operationReceiptFingerprint(parts: readonly unknown[]): string {
  const value = JSON.stringify(parts)
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charCodeAt(index)
    first = Math.imul(first ^ character, 0x01000193)
    second = Math.imul(second ^ character, 0x85ebca6b)
  }
  return `${value.length}:${first >>> 0}:${second >>> 0}`
}

function clearSessionErrorState(session: FreshAgentSessionState) {
  session.lastError = undefined
  session.lastErrorCode = undefined
  session.lastErrorRequestId = undefined
  session.lastErrorOperationAttemptId = undefined
  session.lastErrorWasOperationFallback = undefined
  session.lastErrorOperationUncertain = undefined
  session.lastErrorOperationUncertainty = undefined
  session.lastErrorOperationProvisional = undefined
  session.earlierControlUncertainties = undefined
  session.unattributedControlErrors = undefined
  session.pendingControlFallbacks = undefined
}

function earlierControlUncertainty(session: FreshAgentSessionState, requestId?: string): string | undefined {
  const messages = session.earlierControlUncertainties
    ?.map((entry) => `${entry.requestId === requestId ? 'Earlier attempt' : 'Another request'}: ${entry.message}`)
  return messages?.length ? messages.join(' ') : undefined
}

function rememberControlUncertainty(session: FreshAgentSessionState, requestId: string, attemptId: string | undefined, message: string) {
  const warnings = session.earlierControlUncertainties ??= []
  if (warnings.some((entry) => entry.requestId === requestId && entry.attemptId === attemptId)) return false
  warnings.push({ requestId, attemptId, message })
  if (warnings.length > 16) warnings.shift()
  return true
}

function unattributedControlError(session: FreshAgentSessionState, requestId?: string): string | undefined {
  const messages = session.unattributedControlErrors
    ?.filter((entry) => entry.requestId === requestId)
    .map((entry) => `Provider error for this request (answer attempt unknown): ${entry.message}`)
  return messages?.length ? messages.join(' ') : undefined
}

function clearProvisionalControlWarning(session: FreshAgentSessionState, requestId: string) {
  if (!session.lastErrorOperationProvisional || session.lastErrorRequestId !== requestId) return
  if (session.lastErrorCode !== 'ANSWER_IN_PROGRESS') {
    const provisional = session.lastErrorOperationUncertainty
    if (provisional) session.lastError = session.lastError?.replace(` ${provisional}`, '')
    session.lastErrorOperationUncertain = undefined
    session.lastErrorOperationUncertainty = undefined
    session.lastErrorOperationProvisional = undefined
    return
  }
  const earlier = earlierControlUncertainty(session, requestId)
  if (!earlier) {
    clearSessionErrorState(session)
    return
  }
  session.lastError = earlier
  session.lastErrorCode = undefined
  session.lastErrorRequestId = undefined
  session.lastErrorOperationAttemptId = undefined
  session.lastErrorWasOperationFallback = true
  session.lastErrorOperationUncertain = undefined
  session.lastErrorOperationUncertainty = undefined
  session.lastErrorOperationProvisional = undefined
}

function adoptControlJournal(session: FreshAgentSessionState, journalId?: string): boolean {
  if (!journalId || session.activeControlJournalId === journalId) return true
  if (session.retiredControlJournalIds?.includes(journalId)) return false
  if (session.activeControlJournalId) {
    const retired = session.retiredControlJournalIds ??= []
    retired.push(session.activeControlJournalId)
    if (retired.length > 32) retired.shift()
    session.recentControlAttempts = []
  }
  session.activeControlJournalId = journalId
  return true
}

function recordControlCancellation(session: FreshAgentSessionState, cancellation: ControlCancellation): boolean {
  const requestId = String(cancellation.requestId)
  if (!adoptControlJournal(session, cancellation.operationJournalId)) return false
  const current = session.recentControlAttempts?.find((entry) => entry.requestId === requestId)
  if (current?.journalId && current.journalId === cancellation.operationJournalId
      && current.journalSequence != null && cancellation.operationJournalSequence != null
      && cancellation.operationJournalSequence < current.journalSequence) return false
  if (current && cancellation.operationAttemptId && current.attemptId !== cancellation.operationAttemptId) return false
  const settled = session.settledControlRevisions ??= []
  settled.push({ requestId, attemptId: cancellation.operationAttemptId ?? current?.attemptId,
    journalId: cancellation.operationJournalId, journalSequence: cancellation.operationJournalSequence })
  if (settled.length > 128) settled.shift()
  return true
}

const initialState: FreshAgentState = {
  sessions: {},
  pendingCreates: {},
  pendingCreateFailures: {},
  availableModels: [],
  runtimeOwners: {},
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
    statusVersion: 0,
    turns: [],
    historyItems: [],
    historyBodies: {},
    streamingActive: false,
    pendingPermissions: {},
    pendingQuestions: {},
    pendingElicitations: {},
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    historyLoaded: false,
  }
}

function writeSessionStatus(session: FreshAgentSessionState, status: FreshAgentSessionStatus): void {
  session.status = status
  session.statusVersion = (session.statusVersion ?? 0) + 1
}

function runtimeOwnerRecord(
  frame: SessionRuntimeOwnerMessage,
  existing: RuntimeOwnerRecord | undefined,
  preserveEqualFence: boolean,
): RuntimeOwnerRecord {
  const sameFence = existing?.epoch === frame.epoch && existing.generation === frame.generation
  return {
    ...(preserveEqualFence && sameFence ? existing : undefined),
    provider: frame.provider,
    sessionId: frame.sessionId,
    epoch: frame.epoch,
    generation: frame.generation,
    ownerKind: frame.ownerKind,
    ...(frame.previousKind !== undefined ? { previousKind: frame.previousKind } : {}),
    ...(frame.terminalId !== undefined ? { terminalId: frame.terminalId } : {}),
    transition: preserveEqualFence && sameFence ? existing.transition : frame.transition,
    ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
    ...(frame.fenced !== undefined ? { fenced: frame.fenced } : {}),
    ...(frame.aliasOf !== undefined ? { aliasOf: frame.aliasOf } : {}),
    updatedAt: Date.now(),
  }
}

/** Statuses of a session that is ready and not in a turn. */
const TURN_READY_STATUSES: ReadonlySet<FreshAgentSessionStatus> = new Set<FreshAgentSessionStatus>(['idle', 'connected'])

/**
 * Evidence that a turn is in flight (a stream opened, or a request is being
 * retried): a ready session is running now. A just-created session is
 * 'connected', not 'idle', until its first turn. Any other status is left
 * alone, so a running session is not written again (transcript-live P3).
 */
function markTurnRunning(session: FreshAgentSessionState): void {
  if (TURN_READY_STATUSES.has(session.status)) writeSessionStatus(session, 'running')
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
      if (session.status === 'starting' || session.status === 'creating') {
        writeSessionStatus(session, 'connected')
      } else {
        writeSessionStatus(session, session.status)
      }
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
      model?: string | null
      effort?: string | null
      cwd?: string
      tools?: Array<{ name: string }>
    }>) {
      const session = resolveOrEnsureSession(state, action.payload)
      if (!session) return
      session.cliSessionId = action.payload.cliSessionId
      session.model = action.payload.model
      session.effort = action.payload.effort
      session.cwd = action.payload.cwd
      session.tools = action.payload.tools
      session.awaitingDurableHistory = action.payload.cliSessionId ? false : session.awaitingDurableHistory
      if (session.status === 'creating' || session.status === 'starting') {
        writeSessionStatus(session, 'connected')
      }
    },

    sessionMetadataReceived(state, action: PayloadAction<SessionMutationPayload & {
      cliSessionId?: string
      model?: string | null
      effort?: string | null
      permissionMode?: string
      sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
      collaborationMode?: 'default' | 'plan'
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
      // Live-settings convergence (`freshAgent.session.metadata`): a stated
      // model/effort (string OR explicit null — a clear) REPLACES the session
      // record; an ABSENT key is "no statement" and keeps whatever is there.
      // The server always states both keys on a metadata frame, so the chip
      // and the effort tooltip track the live session exactly.
      if (action.payload.model !== undefined) session.model = action.payload.model
      if (action.payload.effort !== undefined) session.effort = action.payload.effort
      if (action.payload.permissionMode !== undefined) session.permissionMode = action.payload.permissionMode
      if (action.payload.sandbox !== undefined) session.sandbox = action.payload.sandbox
      if (action.payload.collaborationMode !== undefined) session.collaborationMode = action.payload.collaborationMode
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
    }>) {
      const session = resolveOrEnsureSession(state, action.payload, action.payload.status)
      if (!session) return
      // Truth-bearing frame: a snapshot answer proves the session exists —
      // revoke a stale `lost` flag from a transient dead-window race
      // (reconnect unwedge).
      session.lost = false
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
      writeSessionStatus(session, action.payload.status)
      session.historySessionId = action.payload.historySessionId ?? session.historySessionId
      session.historyRevision = action.payload.revision ?? session.historyRevision
      session.streamingActive = action.payload.streamingActive ?? false
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

      // A claude re-key to a durable id (an undo or redo's replacement, core
      // design §4.5) names the session's durable id: the replacement reports
      // no init before its first prompt (T1), so the replaced session's
      // `cliSessionId` must not survive the merge and point the pane back at it.
      const durableRekey = action.payload.provider === 'claude'
        && isValidClaudeSessionId(action.payload.sessionId)
      if (previousSession || nextSession) {
        state.sessions[nextKey] = {
          ...(previousSession ?? createSession(nextLocator, 'connected')),
          ...(nextSession ?? {}),
          ...nextLocator,
          sessionKey: nextKey,
          threadId: action.payload.sessionId,
          ...(durableRekey
            ? { cliSessionId: action.payload.sessionId, historySessionId: action.payload.sessionId }
            : {}),
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
      // Truth-bearing frame: a snapshot answer proves the session exists —
      // revoke a stale `lost` flag from a transient dead-window race
      // (reconnect unwedge). This reducer is currently production-dormant (no
      // dispatch site); the line is armor for any future HTTP-snapshot fold.
      session.lost = false
      session.snapshot = snapshot
      writeSessionStatus(session, snapshot.status as FreshAgentSessionStatus)
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
      session.pendingElicitations = Object.fromEntries((snapshot.pendingElicitations ?? []).map((request) => [String(request.requestId), request]))
      session.totalInputTokens = snapshot.tokenUsage.inputTokens
      session.totalOutputTokens = snapshot.tokenUsage.outputTokens
      session.totalCostUsd = snapshot.tokenUsage.costUsd ?? 0
      session.historyLoaded = true
      session.awaitingDurableHistory = false
    },

    setSessionStatus(state, action: PayloadAction<SessionMutationPayload & { status: FreshAgentSessionStatus }>) {
      const session = resolveOrEnsureSession(state, action.payload, action.payload.status)
      if (!session) return
      writeSessionStatus(session, action.payload.status)
      // A terminal/idle status ends the turn: clear streaming too, else busy stays
      // true (isFreshAgentBusy = streamingActive || running) and the pane is stuck
      // blue after a natural stream-end / freshAgent.status:idle broadcast.
      // 'stuck' (wedged-sidecar deadman) ends the busy assertion the same way —
      // without emitting any completion edge.
      if (action.payload.status === 'idle' || action.payload.status === 'exited' || action.payload.status === 'stuck') {
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

    removePermission(state, action: PayloadAction<SessionMutationPayload & ControlCancellation>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      if (!recordControlCancellation(state.sessions[key], action.payload)) return
      delete state.sessions[key].pendingPermissions[String(action.payload.requestId)]
      clearProvisionalControlWarning(state.sessions[key], String(action.payload.requestId))
    },

    addQuestionRequest(state, action: PayloadAction<SessionMutationPayload & FreshAgentQuestionRequest>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      state.sessions[key].pendingQuestions[String(action.payload.requestId)] = action.payload
    },

    removeQuestion(state, action: PayloadAction<SessionMutationPayload & ControlCancellation>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      if (!recordControlCancellation(state.sessions[key], action.payload)) return
      delete state.sessions[key].pendingQuestions[String(action.payload.requestId)]
      clearProvisionalControlWarning(state.sessions[key], String(action.payload.requestId))
    },

    addElicitationRequest(state, action: PayloadAction<SessionMutationPayload & NonNullable<FreshAgentSessionState['pendingElicitations']>[string]>) {
      const session = resolveOrEnsureSession(state, action.payload)
      if (session) (session.pendingElicitations ??= {})[String(action.payload.requestId)] = action.payload
    },
    removeElicitation(state, action: PayloadAction<SessionMutationPayload & ControlCancellation>) {
      const key = resolveSessionKey(state, action.payload)
      if (key) {
        if (!recordControlCancellation(state.sessions[key], action.payload)) return
        delete state.sessions[key].pendingElicitations?.[String(action.payload.requestId)]
        clearProvisionalControlWarning(state.sessions[key], String(action.payload.requestId))
      }
    },

    sessionError(state, action: PayloadAction<SessionMutationPayload & {
      code?: string; message: string; requestId?: string; operationReceipt?: boolean; operationFallback?: boolean; operationOutcomeUncertain?: boolean; operationReceiptReplay?: boolean; operationAttemptId?: string
    }>) {
      const session = resolveOrEnsureSession(state, action.payload)
      if (!session) return
      const { requestId, operationAttemptId } = action.payload
      if (action.payload.operationReceipt && requestId) {
        const fingerprint = operationReceiptFingerprint([
          requestId, operationAttemptId ?? null, action.payload.code ?? null, action.payload.message,
          Boolean(action.payload.operationFallback), Boolean(action.payload.operationOutcomeUncertain),
        ])
        const recent = session.recentOperationReceiptFingerprints ??= []
        const seen = recent.includes(fingerprint)
        if (action.payload.operationReceiptReplay && seen) return
        if (!seen) {
          recent.push(fingerprint)
          if (recent.length > 128) recent.shift()
        }
      }
      const trackedAttempt = session.recentControlAttempts?.find((entry) => entry.requestId === requestId)
      if (action.payload.operationReceipt && requestId && operationAttemptId) {
        if (!trackedAttempt && action.payload.operationFallback) {
          const pending = session.pendingControlFallbacks ??= []
          if (!pending.some((entry) => entry.requestId === requestId && entry.attemptId === operationAttemptId)) {
            pending.push({ requestId, attemptId: operationAttemptId, code: action.payload.code,
              message: action.payload.message, uncertain: Boolean(action.payload.operationOutcomeUncertain) })
            if (pending.length > 32) pending.shift()
          }
        }
        // The host journal can deliver a previous answer's receipt after a
        // retry has already started. It cannot describe that newer attempt.
        if (trackedAttempt && trackedAttempt.attemptId !== operationAttemptId) {
          if (action.payload.operationFallback) {
            // The gateway can fail before the host's start event arrives. Do
            // not guess whether this is a later attempt or a delayed old one.
            const pending = session.pendingControlFallbacks ??= []
            if (!pending.some((entry) => entry.requestId === requestId && entry.attemptId === operationAttemptId)) {
              pending.push({ requestId, attemptId: operationAttemptId, code: action.payload.code,
                message: action.payload.message, uncertain: Boolean(action.payload.operationOutcomeUncertain) })
              if (pending.length > 32) pending.shift()
              const warning = `Another answer attempt: ${action.payload.message}`
              if (session.lastErrorCode === 'SESSION_RESERVED' && session.lastErrorWasOperationFallback === undefined) {
                // Attach reservations are hidden by the view. The answer
                // failure is separate and must remain visible.
                session.lastError = warning
                session.lastErrorCode = action.payload.code
                session.lastErrorWasOperationFallback = true
              } else if (!session.lastError?.includes(warning)) {
                session.lastError = [session.lastError, warning].filter(Boolean).join(' ')
              }
            }
          }
          return
        }
        // Only an observed start is authoritative. A newly attached browser
        // can receive an old journal event before the current attempt state.
      }
      // A provider receipt is more informative than the managed host's
      // body-free fallback for the same operation, in either arrival order.
      const sameOperation = Boolean(action.payload.operationReceipt && action.payload.requestId
        && session.lastErrorRequestId === action.payload.requestId
        && session.lastErrorOperationAttemptId === operationAttemptId)
      if (action.payload.operationFallback && requestId && operationAttemptId && !trackedAttempt
          && session.lastErrorRequestId === requestId && !session.lastErrorOperationAttemptId
          && session.lastErrorWasOperationFallback === false && session.lastError) {
        const errors = session.unattributedControlErrors ??= []
        if (!errors.some((entry) => entry.requestId === requestId)) {
          errors.push({ requestId, message: session.lastError })
          if (errors.length > 16) errors.shift()
        }
      }
      if (session.lastErrorRequestId && session.lastErrorOperationAttemptId && session.lastErrorOperationUncertain
          && session.lastErrorOperationUncertainty
          && (session.lastErrorRequestId !== requestId
            || (operationAttemptId && session.lastErrorOperationAttemptId
              && session.lastErrorOperationAttemptId !== operationAttemptId))) {
        rememberControlUncertainty(session, session.lastErrorRequestId, session.lastErrorOperationAttemptId,
          session.lastErrorOperationUncertainty)
      }
      const activeTaggedAttemptId = trackedAttempt?.attemptId
        ?? (session.lastErrorRequestId === requestId ? session.lastErrorOperationAttemptId : undefined)
      if (action.payload.operationReceipt && requestId && !operationAttemptId
          && !action.payload.operationFallback && activeTaggedAttemptId) {
        // An older managed host does not echo attempt IDs. Show its native
        // diagnostic without claiming it belongs to the current answer.
        const errors = session.unattributedControlErrors ??= []
        if (!errors.some((entry) => entry.requestId === requestId && entry.message === action.payload.message)) {
          errors.push({ requestId, message: action.payload.message })
          if (errors.length > 16) errors.shift()
        }
        const unknown = unattributedControlError(session, requestId)
        if (session.lastErrorRequestId === requestId && session.lastErrorOperationAttemptId === activeTaggedAttemptId) {
          if (unknown && !session.lastError?.includes(unknown)) session.lastError = `${session.lastError} ${unknown}`
        } else {
          session.lastError = [unknown, earlierControlUncertainty(session, requestId)].filter(Boolean).join(' ')
          session.lastErrorCode = undefined
          session.lastErrorRequestId = requestId
          session.lastErrorOperationAttemptId = undefined
          session.lastErrorWasOperationFallback = false
          session.lastErrorOperationUncertain = undefined
          session.lastErrorOperationUncertainty = undefined
          session.lastErrorOperationProvisional = undefined
        }
        return
      }
      if (action.payload.operationFallback && sameOperation && session.lastErrorWasOperationFallback === false) {
        if (action.payload.operationOutcomeUncertain && !session.lastErrorOperationUncertain) {
          session.lastError = `${session.lastError} ${action.payload.message}`
          session.lastErrorOperationUncertain = true
          session.lastErrorOperationUncertainty = action.payload.message
        }
        return
      }
      const priorUncertainty = !action.payload.operationFallback && sameOperation
        && !session.lastErrorOperationProvisional
        && session.lastErrorOperationUncertain
        ? session.lastErrorOperationUncertainty
          ?? (session.lastErrorWasOperationFallback ? session.lastError : undefined)
        : undefined
      const nativeUncertainty = action.payload.operationReceipt && !action.payload.operationFallback
        && action.payload.operationOutcomeUncertain && !priorUncertainty
        ? 'The outcome could not be confirmed. Check the conversation before trying again.' : undefined
      const uncertainty = priorUncertainty || nativeUncertainty
        || (action.payload.operationFallback && action.payload.operationOutcomeUncertain ? action.payload.message : undefined)
      session.lastError = [action.payload.message, priorUncertainty || nativeUncertainty,
        earlierControlUncertainty(session, requestId), unattributedControlError(session, requestId)].filter(Boolean).join(' ')
      session.lastErrorRequestId = action.payload.operationReceipt ? action.payload.requestId : undefined
      session.lastErrorOperationAttemptId = action.payload.operationReceipt ? operationAttemptId : undefined
      session.lastErrorWasOperationFallback = action.payload.operationReceipt ? Boolean(action.payload.operationFallback) : undefined
      session.lastErrorOperationUncertain = action.payload.operationReceipt
        ? Boolean(uncertainty) : undefined
      session.lastErrorOperationUncertainty = action.payload.operationReceipt ? uncertainty : undefined
      session.lastErrorOperationProvisional = undefined
      // Task 14: the view filters SESSION_RESERVED out of the pane-level
      // error banner (a transient reservation is re-driven, never surfaced).
      session.lastErrorCode = action.payload.code
      if (action.payload.code?.startsWith('RESTORE_')) {
        session.awaitingDurableHistory = false
        session.historyLoaded = true
        session.historyLoading = false
        session.restoreFailureCode = action.payload.code
        session.restoreFailureMessage = action.payload.message
      } else if (action.payload.code === 'SESSION_RESERVED' || action.payload.operationReceipt) {
        // An operation failure does not prove the current turn has ended.
        // A transient reservation likewise does NOT end the turn. The fence-less
        // mount-rebind attach for a just-materialized session answers this
        // typed refusal (FENCE_REQUIRED server-side — "re-observe the owner
        // record and retry with the pair") and the pane redrives the attach
        // with the observed pair; the turn keeps running throughout, so the
        // generic hard-error busy-clear must not fire — it would manufacture
        // a false mid-turn idle (a busy→idle edge that retires the rewind
        // epoch's in-flight capture window while the turn is genuinely
        // running). The error fields stay recorded: the pane's banner filter
        // reads lastErrorCode to keep the reservation unsurfaced (Task 14).
      } else {
        // A hard (non-restore) error ends the turn: clear streaming + drop an
        // active 'running'/'starting' status to idle so the pane does not stay blue.
        session.streamingActive = false
        if (session.status === 'running' || session.status === 'starting') {
          writeSessionStatus(session, 'idle')
        }
      }
    },

    markSessionLost(state, action: PayloadAction<SessionMutationPayload>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      const session = state.sessions[key]
      if (!session) return
      session.lost = true
    },

    /** markSessionLost's counterpart: a reconcile fold produced a working outcome --
     *  neutralize the lost flag WITHOUT destroying the session record
     *  (removeSession below deletes transcript/status state -- never use it here). */
    clearSessionLost(state, action: PayloadAction<SessionMutationPayload>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      const session = state.sessions[key]
      if (!session) return
      session.lost = false
    },

    /**
     * Dismiss the pane's "Agent error" banner: clears `lastError`/`lastErrorCode`
     * so the banner disappears — honest state-clearing, never a cosmetic hide: a
     * NEW `freshAgent.error` re-sets the fields and re-shows the banner. Never
     * ENSURE-creates a session record (a dismissal must not mint state), and
     * never touches status/streaming (the error fold already de-blued the pane).
     */
    clearSessionError(state, action: PayloadAction<SessionMutationPayload>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      const session = state.sessions[key]
      if (!session) return
      clearSessionErrorState(session)
    },

    beginOperationAttempt(state, action: PayloadAction<SessionMutationPayload & { requestId: string; operationAttemptId?: string; operationAttemptReplay?: boolean; operationJournalId?: string; operationJournalSequence?: number }>) {
      const session = action.payload.operationAttemptId
        ? resolveOrEnsureSession(state, action.payload)
        : state.sessions[resolveSessionKey(state, action.payload) ?? '']
      if (!session) return
      if (action.payload.operationAttemptId) {
        const journalId = action.payload.operationJournalId
        const journalSequence = action.payload.operationJournalSequence
        if (!adoptControlJournal(session, journalId)) return
        const attempts = session.recentControlAttempts ??= []
        const previousIndex = attempts.findIndex((entry) => entry.requestId === action.payload.requestId)
        if (previousIndex >= 0 && attempts[previousIndex].attemptId === action.payload.operationAttemptId) {
          if (journalId && journalSequence != null) {
            attempts[previousIndex].journalId = journalId
            attempts[previousIndex].journalSequence = journalSequence
          }
          if (!action.payload.operationAttemptReplay) attempts[previousIndex].replayed = false
          return
        }
        if (previousIndex >= 0 && journalId && journalSequence != null
            && attempts[previousIndex].journalId === journalId && attempts[previousIndex].journalSequence != null) {
          if (journalSequence <= attempts[previousIndex].journalSequence!) return
        } else if (action.payload.operationAttemptReplay && previousIndex >= 0 && !attempts[previousIndex].replayed) return
        if (previousIndex >= 0) attempts.splice(previousIndex, 1)
        attempts.push({ requestId: action.payload.requestId, attemptId: action.payload.operationAttemptId,
          replayed: Boolean(action.payload.operationAttemptReplay), journalId, journalSequence })
        if (attempts.length > 128) attempts.shift()
        if (session.lastErrorRequestId === action.payload.requestId
            && session.lastErrorOperationAttemptId === action.payload.operationAttemptId) {
          if (session.pendingControlFallbacks) {
            session.pendingControlFallbacks = session.pendingControlFallbacks.filter((entry) => entry.requestId !== action.payload.requestId
              || entry.attemptId !== action.payload.operationAttemptId)
          }
          return
        }
        if (session.unattributedControlErrors) {
          session.unattributedControlErrors = session.unattributedControlErrors
            .filter((entry) => entry.requestId !== action.payload.requestId)
        }
        const pendingIndex = session.pendingControlFallbacks?.findIndex((entry) => entry.requestId === action.payload.requestId
          && entry.attemptId === action.payload.operationAttemptId) ?? -1
        if (pendingIndex >= 0) {
          const [fallback] = session.pendingControlFallbacks!.splice(pendingIndex, 1)
          if (session.earlierControlUncertainties) {
            session.earlierControlUncertainties = session.earlierControlUncertainties.filter((entry) => entry.requestId !== fallback.requestId
              || entry.attemptId !== fallback.attemptId)
          }
          if (session.lastErrorRequestId && session.lastErrorOperationUncertain && session.lastErrorOperationUncertainty) {
            rememberControlUncertainty(session, session.lastErrorRequestId, session.lastErrorOperationAttemptId,
              session.lastErrorOperationUncertainty)
          }
          session.lastError = [fallback.message, earlierControlUncertainty(session, fallback.requestId)].filter(Boolean).join(' ')
          session.lastErrorCode = fallback.code
          session.lastErrorRequestId = fallback.requestId
          session.lastErrorOperationAttemptId = fallback.attemptId
          session.lastErrorWasOperationFallback = true
          session.lastErrorOperationUncertain = fallback.uncertain
          session.lastErrorOperationUncertainty = fallback.uncertain ? fallback.message : undefined
          session.lastErrorOperationProvisional = undefined
          return
        }
      }
      // Do not clear a failure belonging to another request.
      if (action.payload.requestId !== session.lastErrorRequestId) return
      if (session.lastErrorOperationUncertain) {
        // A new attempt does not resolve an earlier unconfirmed delivery.
        // Retain its warning without carrying its old provider cause forward.
        if (session.lastErrorOperationUncertainty) {
          if (action.payload.operationAttemptId
              && action.payload.operationAttemptId !== session.lastErrorOperationAttemptId) {
            rememberControlUncertainty(session, action.payload.requestId, session.lastErrorOperationAttemptId,
              session.lastErrorOperationUncertainty)
          }
          session.lastError = session.lastErrorOperationUncertainty
          session.lastErrorCode = undefined
          session.lastErrorWasOperationFallback = true
        }
        return
      }
      const earlier = earlierControlUncertainty(session, action.payload.requestId)
      if (earlier) {
        session.lastError = earlier
        session.lastErrorCode = undefined
        session.lastErrorRequestId = undefined
        session.lastErrorOperationAttemptId = undefined
        session.lastErrorWasOperationFallback = true
        session.lastErrorOperationUncertain = undefined
        session.lastErrorOperationUncertainty = undefined
        session.lastErrorOperationProvisional = undefined
        return
      }
      clearSessionErrorState(session)
    },

    markControlAttemptPending(state, action: PayloadAction<SessionMutationPayload & { requestId: string; operationAttemptId: string }>) {
      const session = resolveOrEnsureSession(state, action.payload)
      const current = session?.recentControlAttempts?.find((entry) => entry.requestId === action.payload.requestId
        && entry.attemptId === action.payload.operationAttemptId)
      if (!session || !current) return
      if (session.settledControlRevisions?.some((entry) => entry.requestId === action.payload.requestId
          && (entry.attemptId === action.payload.operationAttemptId
            || (entry.journalId && entry.journalId === current.journalId && entry.journalSequence != null
              && current.journalSequence != null && entry.journalSequence > current.journalSequence)))) return
      const message = 'The answer is still being processed. Its outcome is not yet confirmed.'
      const same = session.lastErrorRequestId === action.payload.requestId
        && session.lastErrorOperationAttemptId === action.payload.operationAttemptId
      if (same && session.lastErrorOperationUncertain) return
      if (same && session.lastErrorWasOperationFallback === false) {
        session.lastError = `${session.lastError} ${message}`
        session.lastErrorOperationUncertain = true
        session.lastErrorOperationUncertainty = message
        session.lastErrorOperationProvisional = true
        return
      }
      if (session.lastErrorRequestId && session.lastErrorOperationAttemptId && session.lastErrorOperationUncertain
          && session.lastErrorOperationUncertainty) {
        rememberControlUncertainty(session, session.lastErrorRequestId, session.lastErrorOperationAttemptId,
          session.lastErrorOperationUncertainty)
      }
      session.lastError = [message, earlierControlUncertainty(session, action.payload.requestId)].filter(Boolean).join(' ')
      session.lastErrorCode = 'ANSWER_IN_PROGRESS'
      session.lastErrorRequestId = action.payload.requestId
      session.lastErrorOperationAttemptId = action.payload.operationAttemptId
      session.lastErrorWasOperationFallback = true
      session.lastErrorOperationUncertain = true
      session.lastErrorOperationUncertainty = message
      session.lastErrorOperationProvisional = true
    },


    /**
     * Dismiss a restore-failure banner: clears the restore-failure fields
     * WITHOUT minting a session record or touching retry counters — a later
     * retry/reconcile still owns its own state.
     */
    clearRestoreFailure(state, action: PayloadAction<SessionMutationPayload>) {
      const key = resolveSessionKey(state, action.payload)
      if (!key) return
      const session = state.sessions[key]
      if (!session) return
      session.restoreFailureCode = undefined
      session.restoreFailureMessage = undefined
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
        ...(action.payload.ownerKind !== undefined ? { ownerKind: action.payload.ownerKind } : {}),
        ...(action.payload.ownerGeneration !== undefined ? { ownerGeneration: action.payload.ownerGeneration } : {}),
        ...(action.payload.ownerEpoch !== undefined ? { ownerEpoch: action.payload.ownerEpoch } : {}),
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
      /** The server still owes the session work (a send queued behind this turn). */
      sessionBusy?: boolean
    }>) {
      const status = action.payload.sessionBusy === true ? 'running' : 'idle'
      const session = resolveOrEnsureSession(state, action.payload, status)
      if (!session) return
      writeSessionStatus(session, status)
      session.streamingActive = false
      // The SDK's total_cost_usd already covers the whole session so far: it
      // is the total, never an increment. (Token usage is per turn, so it adds.)
      if (typeof action.payload.costUsd === 'number') session.totalCostUsd = action.payload.costUsd
      session.totalInputTokens += action.payload.usage?.input_tokens ?? 0
      session.totalOutputTokens += action.payload.usage?.output_tokens ?? 0
    },
    /**
     * The turn opened a streamed content block: the session is streaming
     * (busy follows `streamingActive`) until its result, an idle/exited/stuck
     * status or an error clears it. A turn opens several blocks; only the
     * first changes anything, so the sessions map is written once per turn,
     * never per block or token (transcript-live P3).
     */
    streamOpened(state, action: PayloadAction<SessionMutationPayload>) {
      const session = resolveOrEnsureSession(state, action.payload, 'running')
      if (!session) return
      if (!session.streamingActive) session.streamingActive = true
      markTurnRunning(session)
    },
    /**
     * The CLI is retrying an API request (live only, transcript-live F11):
     * a turn is in flight even though nothing has streamed yet. A new
     * session's first request can retry before its transcript exists, so no
     * snapshot says the turn is running; the retry does. Only an idle session
     * changes: a running one is not written again (transcript-live P3).
     */
    turnRequestRetried(state, action: PayloadAction<SessionMutationPayload>) {
      const session = resolveOrEnsureSession(state, action.payload, 'running')
      if (session) markTurnRunning(session)
    },
    clearPendingCreateFailureForSession() {},
    sessionExited(state, action: PayloadAction<SessionMutationPayload>) {
      const key = resolveSessionKey(state, action.payload)
      const session = key ? state.sessions[key] : undefined
      if (!session) return
      writeSessionStatus(session, 'exited')
    },

    /**
     * kata b8ke: fold one `session.runtimeOwner` broadcast (or ready-replay
     * entry) into the per-(provider, sessionId) owner record. Epoch-aware
     * monotonic fold (round-2 review): within the SAME epoch, older
     * generations are ignored — but a frame from a DIFFERENT epoch always
     * wins (a restarted server's generation 1 beats a pre-restart 10).
     * Same-epoch/same-generation frames are ALWAYS applied — the corrective
     * handoff-failed/released frames arrive at the same generation as the
     * transition they supersede, and the fold never drops them.
     */
    applyRuntimeOwner(state, action: PayloadAction<SessionRuntimeOwnerMessage>) {
      const f = action.payload
      const key = `${f.provider}:${f.sessionId}`
      const existing = state.runtimeOwners[key]
      if (existing && existing.epoch === f.epoch && f.generation < existing.generation) return
      state.runtimeOwners[key] = runtimeOwnerRecord(f, existing, false)
    },

    /**
     * Fold owner facts attached to a requester-scoped attach result. These
     * facts refresh authority, but are not a new owner transition. At an
     * equal fence keep the complete record learned from the canonical owner
     * broadcast; attach results may omit identity fields such as terminalId.
     */
    refreshRuntimeOwnerFacts(state, action: PayloadAction<SessionRuntimeOwnerMessage>) {
      const f = action.payload
      const key = `${f.provider}:${f.sessionId}`
      const existing = state.runtimeOwners[key]
      if (existing && existing.epoch === f.epoch && f.generation < existing.generation) return
      state.runtimeOwners[key] = runtimeOwnerRecord(f, existing, true)
    },

    /**
     * b8ke fence-heal (fix b): merge a typed stale-refusal's CURRENT
     * (epoch, generation) into the EXISTING runtimeOwners record —
     * ownerKind/transition/terminalId/aliasOf are preserved (the refusal
     * corrects the fence pair only; it must not fabricate or clear owner
     * identity). No record → no-op (nothing to correct; broadcasts,
     * the created-frame fold, or the ready replay repopulate records).
     * Same monotonic gate as applyRuntimeOwner: same-epoch older drops,
     * a different epoch always wins.
     */
    applyRuntimeOwnerFenceRefresh(state, action: PayloadAction<{ provider: string; sessionId: string; epoch: number; generation: number }>) {
      const { provider, sessionId, epoch, generation } = action.payload
      const key = `${provider}:${sessionId}`
      const existing = state.runtimeOwners[key]
      if (!existing) return
      if (existing.epoch === epoch && generation < existing.generation) return
      state.runtimeOwners[key] = { ...existing, epoch, generation, updatedAt: Date.now() }
    },

    /**
     * 2026-09-20 incident (Task 5): refresh the observed owner fence from a
     * typed refusal itself — the REST snapshot 409 RESTORE_UNAVAILABLE always
     * names the coordinator's CURRENT generation, which may be newer than
     * the client's record (the pane loaded while the server was restarting
     * and the record fold lagged). The refusal carries no epoch, so the
     * existing record's epoch is PRESERVED (the record's epoch comes from
     * the server's own runtime-owner broadcasts); only the generation
     * advances. The fold is ADVANCE-ONLY (Task 5 review M1), matching the
     * applyRuntimeOwner invariant: a newer broadcast (e.g. gen 3) may fold
     * between the server minting the refusal (gen 2) and the client
     * processing it — regressing to the refusal's older generation would
     * send a stale fence the wired server refuses with FENCE_REQUIRED. An
     * absent record is left absent: minting one would fabricate an epoch
     * the client never observed — the recovery attach then goes out
     * unfenced, the wired server refuses it typed, and the pane surfaces
     * that honestly instead of the store lying about the boot epoch.
     */
    applyRefusalFence(state, action: PayloadAction<{
      provider: string
      sessionId: string
      ownerKind: 'terminal' | 'fresh-agent'
      ownerGeneration: number
    }>) {
      const refusal = action.payload
      const key = `${refusal.provider}:${refusal.sessionId}`
      const existing = state.runtimeOwners[key]
      if (!existing) return
      if (refusal.ownerGeneration < existing.generation) return
      existing.generation = refusal.ownerGeneration
      existing.updatedAt = Date.now()
    },

    /**
     * kata b8ke (round-2 review): the ready handler dispatches this BEFORE
     * folding the ready.runtimeOwners replay — the client resets its
     * owner/generation state on every (re)connect so a restarted server's
     * newer generations are never ignored in favor of stale pre-reconnect
     * records.
     */
    resetRuntimeOwners(state) {
      state.runtimeOwners = {}
      // Reconnect replay must be able to advance past the last start that was
      // observed on the old connection.
      for (const session of Object.values(state.sessions)) {
        for (const attempt of session.recentControlAttempts ?? []) attempt.replayed = true
      }
    },
  },
})

export const {
  addPermissionRequest,
  addQuestionRequest,
  addElicitationRequest,
  removeElicitation,
  applyRuntimeOwner,
  refreshRuntimeOwnerFacts,
  applyRuntimeOwnerFenceRefresh,
  applyRefusalFence,
  beginOperationAttempt,
  markControlAttemptPending,
  clearPendingCreate,
  clearPendingCreateFailure,
  clearPendingCreateFailureForSession,
  clearRestoreFailure,
  clearSessionError,
  clearSessionLost,
  createFailed,
  freshAgentSnapshotReceived,
  materializeSession,
  markSessionLost,
  registerPendingCreate,
  removePermission,
  removeQuestion,
  removeSession,
  resetRuntimeOwners,
  restoreRetryRequested,
  sessionCreated,
  sessionError,
  sessionExited,
  sessionInit,
  sessionMetadataReceived,
  sessionSnapshotReceived,
  setAvailableModels,
  setSessionStatus,
  streamOpened,
  turnRequestRetried,
  historyLoadFailed,
  historyLoadStarted,
  historyPageReceived,
  turnBodyReceived,
  turnResult,
} = freshAgentSlice.actions

export type { RuntimeOwnerRecord } from './freshAgentTypes'

export default freshAgentSlice.reducer

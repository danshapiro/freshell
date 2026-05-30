import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import PermissionBanner from '@/components/agent-chat/PermissionBanner'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { getWsClient } from '@/lib/ws-client'
import { getFreshAgentThreadSnapshot } from '@/lib/api'
import { consumePaneRefreshRequest, mergePaneContent, updatePaneContent, updatePaneTitle } from '@/store/panesSlice'
import { updateTab } from '@/store/tabsSlice'
import { clearPendingCreateFailure } from '@/store/freshAgentSlice'
import { handleFreshAgentTransportEvent, registerFreshAgentCreate } from '@/lib/fresh-agent-ws'
import {
  normalizeFreshAgentEffort,
  normalizeFreshAgentModel,
  resolveFreshAgentType,
} from '@/lib/fresh-agent-registry'
import { paneRefreshTargetMatchesContent } from '@/lib/pane-utils'
import { getCanonicalDurableSessionId, getPreferredResumeSessionId } from '@/store/persistControl'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { FreshAgentSnapshot } from '@shared/fresh-agent-contract'
import { getFreshAgentSlashCommands, type FreshAgentSlashCommand } from '@shared/fresh-agent-slash-commands'
import { buildRestoreError, type RestoreErrorReason } from '@shared/session-contract'
import { extractTitleFromMessage } from '@shared/title-utils'
import { FreshAgentApprovalBanner } from './FreshAgentApprovalBanner'
import FreshAgentQuestionBanner from './FreshAgentQuestionBanner'
import { FreshAgentTranscript } from './FreshAgentTranscript'
import { FreshAgentComposer, type FreshAgentComposerHandle } from './FreshAgentComposer'
import { FreshAgentDiffPanel } from './FreshAgentDiffPanel'
import { FreshAgentSidebar } from './FreshAgentSidebar'

const EARLY_STATES = new Set(['creating', 'starting'])

function getEffectiveFreshAgentModel(content: FreshAgentPaneContent): string | undefined {
  return normalizeFreshAgentModel(content.sessionType, content.provider, content.model)
}

function getEffectiveFreshAgentEffort(content: FreshAgentPaneContent): string | undefined {
  return normalizeFreshAgentEffort(content.sessionType, content.provider, getEffectiveFreshAgentModel(content), content.effort)
}

function getEffectiveFreshAgentPermissionMode(content: FreshAgentPaneContent): string | undefined {
  return content.provider === 'opencode' ? undefined : content.permissionMode
}

function isStatusRegression(current: string, next: string): boolean {
  return !EARLY_STATES.has(current) && EARLY_STATES.has(next)
}

function getCanonicalPaneResumeSessionId(pane: FreshAgentPaneContent): string | undefined {
  if (pane.sessionRef?.provider === 'claude' && isValidClaudeSessionId(pane.sessionRef.sessionId)) {
    return pane.sessionRef.sessionId
  }
  if (isValidClaudeSessionId(pane.resumeSessionId)) {
    return pane.resumeSessionId
  }
  if (pane.provider === 'claude' && isValidClaudeSessionId(pane.sessionId)) {
    return pane.sessionId
  }
  return undefined
}

function getFreshAgentSnapshotThreadId(
  pane: FreshAgentPaneContent,
  claudeSession: Parameters<typeof getCanonicalDurableSessionId>[0],
): string | undefined {
  if (pane.provider === 'claude') {
    return getCanonicalDurableSessionId(claudeSession) ?? getCanonicalPaneResumeSessionId(pane)
  }
  if (EARLY_STATES.has(pane.status)) {
    // While a new session is still being created, avoid reading an older durable ref.
    return pane.sessionId
  }
  return pane.sessionId
    ?? (pane.sessionRef?.provider === pane.provider ? pane.sessionRef.sessionId : undefined)
}

function getCreatedResumeSessionId(
  current: FreshAgentPaneContent,
  message: { sessionId: string; sessionRef?: { provider: string; sessionId: string } },
): string | undefined {
  if (current.resumeSessionId) return current.resumeSessionId
  if (message.sessionRef?.provider === current.provider) return message.sessionRef.sessionId
  if (current.provider === 'claude' && !isValidClaudeSessionId(message.sessionId)) return undefined
  return message.sessionId
}

function getQuestionAgentLabel(paneContent: FreshAgentPaneContent, descriptorLabel?: string): string {
  if (paneContent.sessionType === 'kilroy') return 'Kilroy'
  switch (paneContent.provider) {
    case 'claude':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'opencode':
      return 'Opencode'
    default:
      return descriptorLabel ?? 'Fresh Agent'
  }
}

function isUnmaterializedCodexThreadError(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string'
    && (error as { message: string }).message.includes('no rollout found for thread id')
}

function getRestoreErrorMessage(reason: RestoreErrorReason): string {
  switch (reason) {
    case 'invalid_legacy_restore_target':
      return 'This session cannot be resumed because Freshell only has a legacy name, not a canonical Claude session id.'
    case 'dead_live_handle':
      return 'This session cannot be resumed because the live session handle is gone and no durable session id was saved.'
    case 'missing_canonical_identity':
      return 'This session cannot be resumed because no canonical session id was saved.'
    case 'durable_artifact_missing':
      return 'This session cannot be resumed because the saved session artifact is no longer available.'
    case 'provider_runtime_failed':
      return 'This session cannot be resumed because the provider runtime rejected the restore request.'
    default:
      return 'This session cannot be resumed.'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readCodexReview(value: unknown): { id?: string; status?: string } | undefined {
  if (!isRecord(value)) return undefined
  return {
    id: typeof value.id === 'string' ? value.id : undefined,
    status: typeof value.status === 'string' ? value.status : undefined,
  }
}

function readCodexFork(value: unknown): { parentThreadId?: string } | undefined {
  if (!isRecord(value)) return undefined
  return {
    parentThreadId: typeof value.parentThreadId === 'string' ? value.parentThreadId : undefined,
  }
}

export function FreshAgentView({
  tabId,
  paneId,
  paneContent,
  hidden,
}: {
  tabId: string
  paneId: string
  paneContent: FreshAgentPaneContent
  hidden?: boolean
}) {
  const dispatch = useAppDispatch()
  const ws = getWsClient()
  const pendingCreateFailure = useAppSelector(
    (state) => state.freshAgent?.pendingCreateFailures?.[paneContent.createRequestId],
  )
  const currentTab = useAppSelector((state) => state.tabs?.tabs?.find((tab) => tab.id === tabId))
  const tabTitleSetByUser = currentTab?.titleSetByUser ?? false
  const claudeSession = useAppSelector((state) => {
    if (paneContent.provider !== 'claude' || !paneContent.sessionId) return undefined
    const sessionKey = makeFreshAgentSessionKey({
      sessionId: paneContent.sessionId,
      sessionType: paneContent.sessionType,
      provider: paneContent.provider,
    })
    return state.freshAgent.sessions[sessionKey] ?? state.agentChat.sessions[paneContent.sessionId]
  })
  const refreshRequest = useAppSelector((state) => state.panes.refreshRequestsByPane?.[tabId]?.[paneId] ?? null)
  const [snapshot, setSnapshot] = useState<FreshAgentSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [snapshotRefreshNonce, setSnapshotRefreshNonce] = useState(0)
  const descriptor = resolveFreshAgentType(paneContent.sessionType)
  const slashCommands = useMemo(() => getFreshAgentSlashCommands(paneContent.sessionType), [paneContent.sessionType])
  const paneContentRef = useRef(paneContent)
  const composerRef = useRef<FreshAgentComposerHandle | null>(null)
  paneContentRef.current = paneContent
  const restoreTimeoutRef = useRef<number | null>(null)
  const createSentRef = useRef(false)
  // Auto-title state tracks four things:
  // 1. whether this mounted pane has already consumed first-message auto-title,
  // 2. whether we observed a fresh conversation boundary in this mount,
  // 3. the last create boundary we saw, and
  // 4. the last stable/effective conversation identity so retries, restores, and materialization
  //    can preserve latch state for the same conversation instead of reopening it.
  const autoTitleSentRef = useRef(false)
  const autoTitleFreshBoundaryRef = useRef(false)
  const autoTitleCreateRequestIdRef = useRef(paneContent.createRequestId)
  const autoTitleDurableIdentityRef = useRef<string | null>(null)
  const autoTitleIdentityRef = useRef<string | null>(null)
  const handledRefreshRequestIdRef = useRef<string | null>(null)
  const preferredResumeSessionId = getPreferredResumeSessionId(claudeSession) ?? paneContent.resumeSessionId
  const snapshotThreadId = getFreshAgentSnapshotThreadId(paneContent, claudeSession)
  const hasRestoreFailure = Boolean(
    paneContent.provider === 'claude'
      && paneContent.sessionId
      && claudeSession?.historyLoaded
      && claudeSession?.restoreFailureCode
      && claudeSession?.restoreFailureMessage,
  )
  const isRestoring = Boolean(
    paneContent.provider === 'claude'
      && paneContent.sessionId
      && !snapshot
      && Boolean(claudeSession?.latestTurnId !== undefined || claudeSession?.lost)
      && claudeSession?.historyLoaded !== true
      && !hasRestoreFailure,
  )
  const hasUserTurns = useMemo(() => snapshot?.turns.some((turn) => turn.role === 'user') ?? false, [snapshot?.turns])
  const autoTitleDurableIdentity = useMemo(() => {
    const paneSessionRefId = paneContent.sessionRef?.provider === paneContent.provider
      ? paneContent.sessionRef.sessionId
      : undefined
    const stableSnapshotThreadId = snapshotThreadId
      && (
        snapshotThreadId !== paneContent.sessionId
        || (!paneSessionRefId && !preferredResumeSessionId && !paneContent.resumeSessionId)
      )
        ? snapshotThreadId
        : undefined
    return paneSessionRefId
      ?? preferredResumeSessionId
      ?? paneContent.resumeSessionId
      ?? stableSnapshotThreadId
      ?? null
  }, [
    paneContent.provider,
    paneContent.resumeSessionId,
    paneContent.sessionId,
    paneContent.sessionRef,
    preferredResumeSessionId,
    snapshotThreadId,
  ])
  const autoTitleIdentity = useMemo(() => {
    const stableIdentity = autoTitleDurableIdentity
      ?? paneContent.sessionId
      ?? paneContent.createRequestId
    return `${paneContent.sessionType}:${paneContent.provider}:${stableIdentity}`
  }, [
    autoTitleDurableIdentity,
    paneContent.createRequestId,
    paneContent.provider,
    paneContent.sessionId,
    paneContent.sessionType,
  ])
  const [snapshotAutoTitleIdentity, setSnapshotAutoTitleIdentity] = useState<string | null>(null)
  const hasCurrentSnapshot = snapshot !== null && snapshotAutoTitleIdentity === autoTitleIdentity
  const snapshotConfirmsNoUserTurns = hasCurrentSnapshot && !hasUserTurns
  const snapshotConfirmsUserTurns = hasCurrentSnapshot && hasUserTurns
  const currentAutoTitleIdentityRef = useRef(autoTitleIdentity)
  currentAutoTitleIdentityRef.current = autoTitleIdentity

  const sendFreshAgentMessage = useCallback((message: Record<string, unknown>) => {
    const suppressed = typeof window !== 'undefined'
      && window.__FRESHELL_TEST_HARNESS__?.isAgentChatNetworkEffectsSuppressed?.(paneId) === true
    if (suppressed) {
      window.__FRESHELL_TEST_HARNESS__?.recordSentWsMessage?.(message)
      return
    }
    ws.send(message as never)
  }, [paneId, ws])

  const prevCreateRequestIdRef = useRef(paneContent.createRequestId)
  if (prevCreateRequestIdRef.current !== paneContent.createRequestId) {
    prevCreateRequestIdRef.current = paneContent.createRequestId
    createSentRef.current = false
  }

  useEffect(() => {
    if (autoTitleCreateRequestIdRef.current !== paneContent.createRequestId) {
      const previousAutoTitleIdentity = autoTitleIdentityRef.current
      const previousDurableIdentity = autoTitleDurableIdentityRef.current
      autoTitleCreateRequestIdRef.current = paneContent.createRequestId
      autoTitleDurableIdentityRef.current = autoTitleDurableIdentity
      autoTitleIdentityRef.current = autoTitleIdentity
      if (
        previousAutoTitleIdentity === autoTitleIdentity
        || (autoTitleDurableIdentity && previousDurableIdentity === autoTitleDurableIdentity)
      ) {
        autoTitleFreshBoundaryRef.current = autoTitleFreshBoundaryRef.current || snapshotConfirmsNoUserTurns
        autoTitleSentRef.current = autoTitleSentRef.current || snapshotConfirmsUserTurns
      } else {
        autoTitleFreshBoundaryRef.current = true
        autoTitleSentRef.current = false
        setSnapshotAutoTitleIdentity(null)
      }
      return
    }
    if (autoTitleIdentityRef.current === null) {
      autoTitleDurableIdentityRef.current = autoTitleDurableIdentity
      autoTitleIdentityRef.current = autoTitleIdentity
      autoTitleFreshBoundaryRef.current = !paneContent.sessionId
        && (paneContent.status === 'creating' || paneContent.status === 'starting')
      autoTitleSentRef.current = snapshotConfirmsUserTurns
      return
    }
    if (autoTitleIdentityRef.current !== autoTitleIdentity) {
      autoTitleDurableIdentityRef.current = autoTitleDurableIdentity
      autoTitleIdentityRef.current = autoTitleIdentity
      autoTitleFreshBoundaryRef.current = autoTitleFreshBoundaryRef.current || snapshotConfirmsNoUserTurns
      autoTitleSentRef.current = autoTitleSentRef.current || snapshotConfirmsUserTurns
      return
    }
    if (snapshotConfirmsNoUserTurns && !autoTitleSentRef.current) {
      autoTitleFreshBoundaryRef.current = true
    }
    if (snapshotConfirmsUserTurns) {
      autoTitleFreshBoundaryRef.current = false
      autoTitleSentRef.current = true
    }
  }, [
    autoTitleDurableIdentity,
    autoTitleIdentity,
    paneContent.createRequestId,
    paneContent.sessionId,
    paneContent.status,
    snapshotConfirmsNoUserTurns,
    snapshotConfirmsUserTurns,
  ])

  const buildCreateMessage = useCallback((content: FreshAgentPaneContent) => ({
    type: 'freshAgent.create',
    requestId: content.createRequestId,
    sessionType: content.sessionType,
    provider: content.provider,
    cwd: content.initialCwd,
    resumeSessionId: content.resumeSessionId
      ?? (content.sessionRef?.provider === content.provider ? content.sessionRef.sessionId : undefined),
    sessionRef: content.sessionRef,
    modelSelection: content.modelSelection,
    model: getEffectiveFreshAgentModel(content),
    ...(getEffectiveFreshAgentPermissionMode(content) ? { permissionMode: getEffectiveFreshAgentPermissionMode(content) } : {}),
    sandbox: content.sandbox,
    effort: getEffectiveFreshAgentEffort(content),
    plugins: content.plugins,
  } as const), [])

  const startNewConversation = useCallback(() => {
    const current = paneContentRef.current
    if (current.sessionId) {
      sendFreshAgentMessage({
        type: 'freshAgent.kill',
        sessionId: current.sessionId,
        sessionType: current.sessionType,
        provider: current.provider,
      })
    }
    setSnapshot(null)
    setLoadError(null)
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: {
        ...current,
        createRequestId: nanoid(),
        sessionId: undefined,
        sessionRef: undefined,
        resumeSessionId: undefined,
        restoreError: undefined,
        createError: undefined,
        status: 'creating',
      },
    }))
  }, [dispatch, paneId, sendFreshAgentMessage, tabId])

  const runSlashCommand = useCallback((command: FreshAgentSlashCommand, args: string) => {
    const current = paneContentRef.current
    if (command.action === 'new') {
      startNewConversation()
      return
    }
    if (command.action === 'compact') {
      if (!current.sessionId) return
      sendFreshAgentMessage({
        type: 'freshAgent.compact',
        sessionId: current.sessionId,
        sessionType: current.sessionType,
        provider: current.provider,
        ...(args ? { instructions: args } : {}),
      })
    }
  }, [sendFreshAgentMessage, startNewConversation])

  useEffect(() => {
    if (!refreshRequest) return
    if (handledRefreshRequestIdRef.current === refreshRequest.requestId) return
    const current = paneContentRef.current
    if (!paneRefreshTargetMatchesContent(refreshRequest.target, current)) return

    handledRefreshRequestIdRef.current = refreshRequest.requestId
    setSnapshot(null)
    setLoadError(null)

    if (current.sessionId) {
      sendFreshAgentMessage({
        type: 'freshAgent.attach',
        sessionId: current.sessionId,
        sessionType: current.sessionType,
        provider: current.provider,
        resumeSessionId: current.resumeSessionId,
      })
      setSnapshotRefreshNonce((value) => value + 1)
    } else if (!hidden && (current.status === 'creating' || current.status === 'starting')) {
      createSentRef.current = true
      registerFreshAgentCreate(dispatch, current.createRequestId, {
        sessionType: current.sessionType,
        provider: current.provider,
        resumeSessionId: current.resumeSessionId,
        sessionRef: current.sessionRef,
      })
      sendFreshAgentMessage(buildCreateMessage(current))
    }

    dispatch(consumePaneRefreshRequest({ tabId, paneId, requestId: refreshRequest.requestId }))
  }, [buildCreateMessage, dispatch, hidden, paneId, refreshRequest, sendFreshAgentMessage, tabId])

  const triggerRecovery = useCallback(() => {
    if (restoreTimeoutRef.current !== null) {
      clearTimeout(restoreTimeoutRef.current)
      restoreTimeoutRef.current = null
    }
    const nextRequestId = nanoid()
    const canonicalResumeSessionId = getCanonicalDurableSessionId(claudeSession)
      ?? getCanonicalPaneResumeSessionId(paneContentRef.current)
    if (!canonicalResumeSessionId) {
      const hadLegacyRestoreTarget = Boolean(getPreferredResumeSessionId(claudeSession) || paneContentRef.current.resumeSessionId)
      dispatch(updatePaneContent({
        tabId,
        paneId,
        content: {
          ...paneContentRef.current,
          sessionId: undefined,
          resumeSessionId: undefined,
          sessionRef: undefined,
          restoreError: buildRestoreError(hadLegacyRestoreTarget ? 'invalid_legacy_restore_target' : 'dead_live_handle'),
          createRequestId: nextRequestId,
          status: 'idle',
          createError: undefined,
        },
      }))
      return
    }

    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: {
        ...paneContentRef.current,
        sessionId: undefined,
        resumeSessionId: canonicalResumeSessionId,
        sessionRef: { provider: 'claude', sessionId: canonicalResumeSessionId },
        restoreError: undefined,
        createRequestId: nextRequestId,
        status: 'creating',
        createError: undefined,
      },
    }))
  }, [claudeSession, dispatch, paneId, tabId])

  useEffect(() => {
    if (paneContent.sessionId || hidden) return
    if (paneContent.restoreError) return
    if (
      paneContent.status !== 'creating'
      && paneContent.status !== 'starting'
      && !paneContent.sessionRef
    ) return
    if (createSentRef.current) return
    createSentRef.current = true
    registerFreshAgentCreate(dispatch, paneContent.createRequestId, {
      sessionType: paneContent.sessionType,
      provider: paneContent.provider,
      resumeSessionId: paneContent.resumeSessionId,
      sessionRef: paneContent.sessionRef,
    })
    sendFreshAgentMessage(buildCreateMessage(paneContent))
  }, [
    buildCreateMessage,
    dispatch,
    hidden,
    paneContent,
    sendFreshAgentMessage,
  ])

  useEffect(() => {
    if (hidden) return
    if (paneContent.sessionId || !createSentRef.current) return
    if (paneContent.status !== 'creating' && paneContent.status !== 'starting') return
    if (typeof ws.onReconnect !== 'function') return
    return ws.onReconnect(() => {
      const current = paneContentRef.current
      if (current.sessionId) return
      if (current.status !== 'creating' && current.status !== 'starting') return
      sendFreshAgentMessage(buildCreateMessage(current))
    })
  }, [
    buildCreateMessage,
    hidden,
    paneContent.sessionId,
    paneContent.status,
    sendFreshAgentMessage,
    ws,
  ])

  useEffect(() => {
    if (!paneContent.sessionId || hidden) return
    sendFreshAgentMessage({
      type: 'freshAgent.attach',
      sessionId: paneContent.sessionId,
      sessionType: paneContent.sessionType,
      provider: paneContent.provider,
      resumeSessionId: paneContent.resumeSessionId,
    })
  }, [hidden, paneContent.provider, paneContent.resumeSessionId, paneContent.sessionId, paneContent.sessionType])

  useEffect(() => {
    if (typeof ws.onMessage !== 'function') return
    const unsubscribe = ws.onMessage((message) => {
      if (message.type === 'freshAgent.created' && message.requestId === paneContentRef.current.createRequestId) {
        const current = paneContentRef.current
        dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            ...current,
            sessionId: message.sessionId,
            sessionRef: message.sessionRef ?? current.sessionRef,
            resumeSessionId: getCreatedResumeSessionId(current, {
              sessionId: message.sessionId,
              sessionRef: message.sessionRef,
            }),
            status: 'connected',
            createError: undefined,
            restoreError: undefined,
          },
        }))
      }
      if (message.type === 'freshAgent.create.failed' && message.requestId === paneContentRef.current.createRequestId) {
        dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            ...paneContentRef.current,
            status: 'create-failed',
            createError: {
              code: message.code,
              message: message.message,
              retryable: message.retryable,
            },
          },
        }))
      }
      if (
        message.type === 'freshAgent.event'
        && message.sessionId === paneContent.sessionId
        && message.sessionType === paneContent.sessionType
        && message.provider === paneContent.provider
      ) {
        handleFreshAgentTransportEvent(dispatch, {
          type: 'freshAgent.event',
          sessionId: message.sessionId,
          sessionType: message.sessionType,
          provider: message.provider,
          event: (message.event ?? {}) as Record<string, unknown>,
        })
        setSnapshotRefreshNonce((value) => value + 1)
      }
      if (
        message.type === 'freshAgent.forked'
        && message.requestId === paneContent.createRequestId
        && message.parentSessionId === paneContent.sessionId
        && message.sessionType === paneContent.sessionType
        && message.provider === paneContent.provider
        && typeof message.sessionId === 'string'
      ) {
        if (message.sessionId !== paneContent.sessionId) {
          sendFreshAgentMessage({
            type: 'freshAgent.kill',
            sessionId: paneContent.sessionId,
            sessionType: paneContent.sessionType,
            provider: paneContent.provider,
          })
        }
        setSnapshot(null)
        dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            ...paneContentRef.current,
            createRequestId: nanoid(),
            sessionId: message.sessionId,
            sessionRef: {
              provider: paneContent.provider,
              sessionId: message.sessionId,
            },
            resumeSessionId: message.sessionId,
            status: 'connected',
            createError: undefined,
            restoreError: undefined,
          },
        }))
      }
    })
    return unsubscribe
  }, [dispatch, paneContent, paneContent.createRequestId, paneId, sendFreshAgentMessage, tabId, ws])

  useEffect(() => {
    if (!snapshotThreadId) return
    if (paneContent.provider === 'claude' && claudeSession?.lost) return
    const controller = new AbortController()
    setLoadError(null)
    const sessionId = snapshotThreadId
    const provider = paneContent.provider
    const requestCreateRequestId = paneContent.createRequestId
    const requestAutoTitleIdentity = autoTitleIdentity
    const isStaleSnapshotRequest = () => (
      paneContentRef.current.createRequestId !== requestCreateRequestId
      || currentAutoTitleIdentityRef.current !== requestAutoTitleIdentity
    )
    void getFreshAgentThreadSnapshot(paneContent.sessionType, provider, sessionId, { signal: controller.signal })
      .then((next) => {
        if (isStaleSnapshotRequest()) return
        const resolved = next as FreshAgentSnapshot
        const resolvedHasUserTurns = resolved.turns.some((turn) => turn.role === 'user')
        if (!resolvedHasUserTurns && !autoTitleSentRef.current) {
          autoTitleFreshBoundaryRef.current = true
        }
        if (resolvedHasUserTurns) {
          autoTitleFreshBoundaryRef.current = false
          autoTitleSentRef.current = true
        }
        setSnapshot(resolved)
        setSnapshotAutoTitleIdentity(requestAutoTitleIdentity)
        const fresh = paneContentRef.current
        const nextStatus = (resolved.status as FreshAgentPaneContent['status']) ?? fresh.status
        const snapshotSessionRef = provider === 'opencode' && resolved.sessionId && resolved.sessionId !== sessionId
          ? { provider, sessionId: resolved.sessionId }
          : undefined
        const nextSessionId = snapshotSessionRef?.sessionId ?? fresh.sessionId
        const nextSessionRef = snapshotSessionRef ?? fresh.sessionRef
        const nextResumeSessionId = snapshotSessionRef?.sessionId ?? fresh.resumeSessionId ?? sessionId
        if (
          nextStatus === fresh.status
          && nextSessionId === fresh.sessionId
          && nextResumeSessionId === fresh.resumeSessionId
          && nextSessionRef?.provider === fresh.sessionRef?.provider
          && nextSessionRef?.sessionId === fresh.sessionRef?.sessionId
        ) {
          return
        }
        dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            ...fresh,
            sessionId: nextSessionId,
            sessionRef: nextSessionRef,
            status: nextStatus,
            resumeSessionId: nextResumeSessionId,
          },
        }))
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return
        if (isStaleSnapshotRequest()) return
        if (paneContent.provider === 'claude' && claudeSession) {
          setLoadError(null)
          return
        }
        if (paneContent.provider === 'codex' && isUnmaterializedCodexThreadError(error)) {
          const fresh = paneContentRef.current
          setLoadError(null)
          setSnapshot(null)
          dispatch(updatePaneContent({
            tabId,
            paneId,
            content: {
              ...fresh,
              sessionId: undefined,
              sessionRef: undefined,
              createRequestId: nanoid(),
              status: 'idle',
              createError: undefined,
              restoreError: buildRestoreError('durable_artifact_missing'),
            },
          }))
          return
        }
        setLoadError(error instanceof Error ? error.message : 'Failed to load session')
      })
    return () => controller.abort()
  }, [
    claudeSession?.lost,
    dispatch,
    paneContent,
    paneContent.provider,
    paneContent.resumeSessionId,
    paneContent.sessionId,
    paneContent.status,
    paneContent.sessionType,
    paneId,
    autoTitleIdentity,
    snapshotThreadId,
    snapshotRefreshNonce,
    tabId,
  ])

  const claudeSessionStatus = claudeSession?.status
  useEffect(() => {
    if (paneContent.provider !== 'claude') return
    if (!claudeSessionStatus || claudeSessionStatus === paneContent.status) return
    if (claudeSession?.lost) return
    if (isStatusRegression(paneContent.status, claudeSessionStatus)) return
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: { status: claudeSessionStatus },
    }))
  }, [claudeSession?.lost, claudeSessionStatus, dispatch, paneContent.provider, paneContent.status, paneId, tabId])

  useEffect(() => {
    if (paneContent.provider !== 'claude') return
    if (!paneContent.sessionId) return
    const canonicalResumeSessionId = getCanonicalDurableSessionId(claudeSession)
    const shouldUpdateResumeSessionId = Boolean(
      preferredResumeSessionId && preferredResumeSessionId !== paneContent.resumeSessionId,
    )
    const shouldClearRestoreError = Boolean(canonicalResumeSessionId && paneContent.restoreError)
    if (!shouldUpdateResumeSessionId && !shouldClearRestoreError) return
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: {
        ...(shouldUpdateResumeSessionId ? { resumeSessionId: preferredResumeSessionId } : {}),
        ...(canonicalResumeSessionId
          ? {
              sessionRef: { provider: 'claude', sessionId: canonicalResumeSessionId },
              restoreError: undefined,
            }
          : {}),
      },
    }))
  }, [
    claudeSession,
    dispatch,
    paneContent.provider,
    paneContent.resumeSessionId,
    paneContent.restoreError,
    paneContent.sessionId,
    paneId,
    preferredResumeSessionId,
    tabId,
  ])

  useEffect(() => {
    if (paneContent.provider !== 'claude') return
    if (!paneContent.sessionId || !claudeSession?.lost) return
    const shouldDeferUntilVisibleRestore = Boolean(
      claudeSession.latestTurnId !== undefined && claudeSession.historyLoaded === true
    )
    if (shouldDeferUntilVisibleRestore) {
      const sessionIdForRecovery = paneContent.sessionId
      restoreTimeoutRef.current = window.setTimeout(() => {
        restoreTimeoutRef.current = null
        if (paneContentRef.current.sessionId !== sessionIdForRecovery) return
        if (!claudeSession?.lost) return
        triggerRecovery()
      }, 0)
      return () => {
        if (restoreTimeoutRef.current !== null) {
          clearTimeout(restoreTimeoutRef.current)
          restoreTimeoutRef.current = null
        }
      }
    }
    triggerRecovery()
  }, [
    claudeSession?.historyLoaded,
    claudeSession?.latestTurnId,
    claudeSession?.lost,
    paneContent.provider,
    paneContent.sessionId,
    triggerRecovery,
  ])

  const content = useMemo(() => {
    const turns = snapshot?.turns ?? []
    const pendingApprovals = snapshot?.pendingApprovals ?? []
    const pendingQuestions = snapshot?.pendingQuestions ?? []
    const worktrees = snapshot?.worktrees ?? []
    const childThreads = snapshot?.childThreads ?? []
    const diffs = snapshot?.diffs ?? []
    const codexReview = readCodexReview(snapshot?.extensions?.codex?.review)
    const codexFork = readCodexFork(snapshot?.extensions?.codex?.fork)
    const effectiveStatus = paneContent.provider === 'claude'
      ? (claudeSessionStatus ?? paneContent.status)
      : paneContent.status
    const canSend = snapshot?.capabilities?.send === true || (
      paneContent.provider === 'claude'
      && Boolean(paneContent.sessionId)
      && !isRestoring
      && !hasRestoreFailure
      && !['creating', 'starting', 'create-failed', 'exited'].includes(effectiveStatus)
    )
    const canInterrupt = snapshot?.capabilities?.interrupt === true || (
      paneContent.provider === 'claude'
      && Boolean(paneContent.sessionId)
      && ['connected', 'running', 'idle', 'compacting'].includes(effectiveStatus)
    )
    const questionAgentLabel = getQuestionAgentLabel(paneContent, descriptor?.label)
    const visibleRestoreFailure = paneContent.provider === 'claude'
      ? claudeSession?.restoreFailureMessage
      : null
    const visiblePaneRestoreFailure = visibleRestoreFailure
      ? null
      : (paneContent.restoreError ? getRestoreErrorMessage(paneContent.restoreError.reason) : null)
    const visibleLoadError = visibleRestoreFailure || visiblePaneRestoreFailure || isRestoring ? null : loadError
    const sendInterrupt = () => {
      if (!paneContent.sessionId || !canInterrupt) return
      sendFreshAgentMessage({
        type: 'freshAgent.interrupt',
        sessionId: paneContent.sessionId,
        sessionType: paneContent.sessionType,
        provider: paneContent.provider,
      })
    }

    return (
      <div className="flex h-full min-h-0 flex-col" data-context="fresh-agent" data-session-id={paneContent.sessionId}>
        <div className="flex min-h-0 flex-1">
          <div
            className="flex min-h-0 flex-1 flex-col"
            onClick={(event) => {
              if (event.target !== event.currentTarget) return
              composerRef.current?.focus()
            }}
          >
            <div className="space-y-2 px-3 pt-3">
              {isRestoring ? (
                <FreshAgentApprovalBanner text="Restoring session..." />
              ) : null}
              {snapshot?.summary ? (
                <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  {snapshot.summary}
                </div>
              ) : null}
              {pendingCreateFailure || paneContent.createError ? (
                <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
                  <FreshAgentApprovalBanner text={(pendingCreateFailure ?? paneContent.createError)?.message ?? 'Create failed'} />
                  {(pendingCreateFailure ?? paneContent.createError)?.retryable ? (
                    <button
                      type="button"
                      className="rounded border border-border/70 px-2 py-1"
                      onClick={() => {
                        const nextRequestId = nanoid()
                        dispatch(updatePaneContent({
                          tabId,
                          paneId,
                          content: {
                            ...paneContentRef.current,
                            sessionId: undefined,
                            createRequestId: nextRequestId,
                            status: 'creating',
                            createError: undefined,
                          },
                        }))
                      }}
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
              ) : null}
              {visibleRestoreFailure ? <FreshAgentApprovalBanner text={visibleRestoreFailure} /> : null}
              {visiblePaneRestoreFailure ? <FreshAgentApprovalBanner text={visiblePaneRestoreFailure} /> : null}
              {visibleLoadError ? <FreshAgentApprovalBanner text={visibleLoadError} /> : null}
              {pendingApprovals.map((approval) => (
                <PermissionBanner
                  key={String(approval.requestId)}
                  permission={{
                    requestId: String(approval.requestId),
                    subtype: 'can_use_tool',
                    tool: approval.toolName
                      ? { name: approval.toolName, input: approval.input }
                      : undefined,
                  }}
                  onAllow={() => {
                    if (!paneContent.sessionId) return
                    sendFreshAgentMessage({
                      type: 'freshAgent.approval.respond',
                      sessionId: paneContent.sessionId,
                      sessionType: paneContent.sessionType,
                      provider: paneContent.provider,
                      requestId: approval.requestId,
                      decision: { behavior: 'allow', updatedInput: {} },
                    })
                  }}
                  onDeny={() => {
                    if (!paneContent.sessionId) return
                    sendFreshAgentMessage({
                      type: 'freshAgent.approval.respond',
                      sessionId: paneContent.sessionId,
                      sessionType: paneContent.sessionType,
                      provider: paneContent.provider,
                      requestId: approval.requestId,
                      decision: { behavior: 'deny', message: 'Denied by user', interrupt: false },
                    })
                  }}
                  disabled={!paneContent.sessionId}
                />
              ))}
              {pendingQuestions.map((question) => (
                <FreshAgentQuestionBanner
                  key={String(question.requestId)}
                  question={{
                    requestId: String(question.requestId),
                    questions: (question.questions ?? []).map((entry) => ({
                      question: entry.question,
                      header: entry.header ?? 'Question',
                      options: entry.options ?? [],
                      multiSelect: entry.multiSelect === true,
                    })),
                  }}
                  providerLabel={questionAgentLabel}
                  onAnswer={(answers) => {
                    if (!paneContent.sessionId) return
                    sendFreshAgentMessage({
                      type: 'freshAgent.question.respond',
                      sessionId: paneContent.sessionId,
                      sessionType: paneContent.sessionType,
                      provider: paneContent.provider,
                      requestId: question.requestId,
                      answers,
                    })
                  }}
                  disabled={!paneContent.sessionId}
                />
              ))}
              <FreshAgentDiffPanel diffs={diffs} />
            </div>
            <FreshAgentTranscript turns={turns} />
            <FreshAgentComposer
              ref={composerRef}
              disabled={!canSend || !paneContent.sessionId}
              storageKey={`fresh-agent-draft:${paneContent.sessionType}:${paneContent.sessionId ?? paneContent.createRequestId}`}
              canInterrupt={canInterrupt && Boolean(paneContent.sessionId)}
              onInterrupt={sendInterrupt}
              commands={slashCommands}
              onCommand={runSlashCommand}
              onSend={(text) => {
                if (!paneContent.sessionId || !canSend) return
                const isFirstMessage = !autoTitleSentRef.current
                  && (autoTitleFreshBoundaryRef.current || snapshotConfirmsNoUserTurns)
                if (isFirstMessage) {
                  autoTitleFreshBoundaryRef.current = false
                  autoTitleSentRef.current = true
                  const title = extractTitleFromMessage(text)
                  if (title) {
                    dispatch(updatePaneTitle({ tabId, paneId, title, setByUser: false }))
                    if (!tabTitleSetByUser) {
                      dispatch(updateTab({ id: tabId, updates: { title } }))
                    }
                  }
                }
                sendFreshAgentMessage({
                  type: 'freshAgent.send',
                  sessionId: paneContent.sessionId,
                  sessionType: paneContent.sessionType,
                  provider: paneContent.provider,
                  text,
                  settings: {
                    ...(paneContent.initialCwd ? { cwd: paneContent.initialCwd } : {}),
                    ...(getEffectiveFreshAgentModel(paneContent) ? { model: getEffectiveFreshAgentModel(paneContent) } : {}),
                    ...(getEffectiveFreshAgentPermissionMode(paneContent) ? { permissionMode: getEffectiveFreshAgentPermissionMode(paneContent) } : {}),
                    ...(paneContent.sandbox ? { sandbox: paneContent.sandbox } : {}),
                    ...(getEffectiveFreshAgentEffort(paneContent) ? { effort: getEffectiveFreshAgentEffort(paneContent) } : {}),
                  },
                })
              }}
            />
          </div>
          <FreshAgentSidebar
            worktrees={worktrees}
            childThreads={childThreads}
            codexReview={codexReview}
            codexFork={codexFork}
          />
        </div>
      </div>
    )
  }, [
    claudeSession?.restoreFailureMessage,
    claudeSessionStatus,
    descriptor?.label,
    hasRestoreFailure,
    isRestoring,
    loadError,
    paneContent,
    pendingCreateFailure,
    runSlashCommand,
    snapshotConfirmsNoUserTurns,
    snapshot,
    slashCommands,
    dispatch,
    paneId,
    tabId,
    tabTitleSetByUser,
  ])

  useEffect(() => {
    if (!pendingCreateFailure) return
    return () => {
      dispatch(clearPendingCreateFailure({ requestId: paneContent.createRequestId }))
    }
  }, [dispatch, paneContent.createRequestId, pendingCreateFailure])

  return content
}

export default FreshAgentView

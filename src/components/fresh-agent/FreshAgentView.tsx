import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import PermissionBanner from '@/components/agent-chat/PermissionBanner'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { getWsClient } from '@/lib/ws-client'
import { getFreshAgentThreadSnapshot } from '@/lib/api'
import { mergePaneContent, updatePaneContent } from '@/store/panesSlice'
import { clearPendingCreateFailure } from '@/store/freshAgentSlice'
import { handleFreshAgentTransportEvent, registerFreshAgentCreate } from '@/lib/fresh-agent-ws'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'
import { getPreferredResumeSessionId } from '@/store/persistControl'
import { FreshAgentApprovalBanner } from './FreshAgentApprovalBanner'
import FreshAgentQuestionBanner from './FreshAgentQuestionBanner'
import { FreshAgentTranscript } from './FreshAgentTranscript'
import { FreshAgentComposer } from './FreshAgentComposer'
import { FreshAgentDiffPanel } from './FreshAgentDiffPanel'
import { FreshAgentSidebar } from './FreshAgentSidebar'

const EARLY_STATES = new Set(['creating', 'starting'])

function isStatusRegression(current: string, next: string): boolean {
  return !EARLY_STATES.has(current) && EARLY_STATES.has(next)
}

function getStatusLabel(status: FreshAgentPaneContent['status'], restoring: boolean): string {
  if (restoring) return 'Restoring'
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'idle':
      return 'Ready'
    case 'running':
      return 'Running'
    case 'compacting':
      return 'Compacting'
    case 'creating':
    case 'starting':
      return 'Starting session'
    case 'exited':
      return 'Exited'
    case 'create-failed':
      return 'Create failed'
    default:
      return 'Starting session'
  }
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

type FreshAgentSnapshot = {
  revision: number
  status?: string
  summary?: string
  capabilities?: Record<string, boolean>
  tokenUsage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number }
  worktrees?: Array<{ id: string; path: string; branch?: string }>
  diffs?: Array<{ id: string; path?: string; title?: string }>
  childThreads?: Array<{ id: string; threadId: string; origin?: string; title?: string }>
  pendingApprovals?: Array<{
    requestId: string
    toolName?: string
    toolUseID?: string
    blockedPath?: string
    decisionReason?: string
    input?: Record<string, unknown>
  }>
  pendingQuestions?: Array<{
    requestId: string
    questions?: Array<{
      question: string
      header?: string
      options?: Array<{ label: string; description: string }>
      multiSelect?: boolean
    }>
  }>
  turns?: Array<{
    id: string
    role: 'user' | 'assistant'
    summary?: string
    items?: Array<{
      id: string
      kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'
      text?: string
      name?: string
      input?: Record<string, unknown>
      content?: unknown
      isError?: boolean
    }>
  }>
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
  const claudeSession = useAppSelector((state) => (
    paneContent.provider === 'claude' && paneContent.sessionId
      ? state.agentChat.sessions[paneContent.sessionId]
      : undefined
  ))
  const [snapshot, setSnapshot] = useState<FreshAgentSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [snapshotRefreshNonce, setSnapshotRefreshNonce] = useState(0)
  const descriptor = resolveFreshAgentType(paneContent.sessionType)
  const paneContentRef = useRef(paneContent)
  paneContentRef.current = paneContent
  const restoreTimeoutRef = useRef<number | null>(null)
  const preferredResumeSessionId = getPreferredResumeSessionId(claudeSession) ?? paneContent.resumeSessionId
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

  function sendFreshAgentMessage(message: Record<string, unknown>) {
    const suppressed = typeof window !== 'undefined'
      && window.__FRESHELL_TEST_HARNESS__?.isAgentChatNetworkEffectsSuppressed?.(paneId) === true
    if (suppressed) {
      window.__FRESHELL_TEST_HARNESS__?.recordSentWsMessage?.(message)
      return
    }
    ws.send(message as never)
  }

  const triggerRecovery = useCallback(() => {
    if (restoreTimeoutRef.current !== null) {
      clearTimeout(restoreTimeoutRef.current)
      restoreTimeoutRef.current = null
    }
    const nextRequestId = nanoid()
    dispatch(updatePaneContent({
      tabId,
      paneId,
      content: {
        ...paneContentRef.current,
        sessionId: undefined,
        resumeSessionId: getPreferredResumeSessionId(claudeSession) ?? paneContentRef.current.resumeSessionId,
        createRequestId: nextRequestId,
        status: 'creating',
        createError: undefined,
      },
    }))
  }, [claudeSession, dispatch, paneId, tabId])

  useEffect(() => {
    if (paneContent.sessionId || hidden) return
    const createMessage = {
      type: 'freshAgent.create',
      requestId: paneContent.createRequestId,
      sessionType: paneContent.sessionType,
      cwd: paneContent.initialCwd,
      resumeSessionId: paneContent.resumeSessionId,
      model: paneContent.model,
      permissionMode: paneContent.permissionMode,
      effort: paneContent.effort,
      plugins: paneContent.plugins,
    } as const
    registerFreshAgentCreate(dispatch, paneContent.createRequestId, {
      resumeSessionId: paneContent.resumeSessionId,
    })
    sendFreshAgentMessage(createMessage)
  }, [
    dispatch,
    hidden,
    paneContent.createRequestId,
    paneContent.effort,
    paneContent.initialCwd,
    paneContent.model,
    paneContent.permissionMode,
    paneContent.plugins,
    paneContent.resumeSessionId,
    paneContent.sessionId,
    paneContent.sessionType,
  ])

  useEffect(() => {
    if (!paneContent.sessionId || hidden) return
    sendFreshAgentMessage({
      type: 'freshAgent.attach',
      sessionId: paneContent.sessionId,
      sessionType: paneContent.sessionType,
      resumeSessionId: paneContent.resumeSessionId,
    })
  }, [hidden, paneContent.resumeSessionId, paneContent.sessionId, paneContent.sessionType])

  useEffect(() => {
    if (typeof ws.onMessage !== 'function') return
    const unsubscribe = ws.onMessage((message) => {
      if (message.type === 'freshAgent.created' && message.requestId === paneContent.createRequestId) {
        dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            ...paneContent,
            sessionId: message.sessionId,
            resumeSessionId: paneContent.resumeSessionId ?? message.sessionId,
            status: 'connected',
            createError: undefined,
          },
        }))
      }
      if (message.type === 'freshAgent.create.failed' && message.requestId === paneContent.createRequestId) {
        dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            ...paneContent,
            status: 'create-failed',
            createError: {
              code: message.code,
              message: message.message,
              retryable: message.retryable,
            },
          },
        }))
      }
      if (message.type === 'freshAgent.event' && message.sessionId === paneContent.sessionId) {
        handleFreshAgentTransportEvent(dispatch, {
          type: 'freshAgent.event',
          sessionId: message.sessionId,
          event: (message.event ?? {}) as Record<string, unknown>,
        })
        setSnapshotRefreshNonce((value) => value + 1)
      }
    })
    return unsubscribe
  }, [dispatch, paneContent, paneContent.createRequestId, paneId, tabId, ws])

  useEffect(() => {
    if (!paneContent.sessionId) return
    if (paneContent.provider === 'claude' && claudeSession?.lost) return
    const controller = new AbortController()
    setLoadError(null)
    const sessionId = paneContent.sessionId
    const provider = paneContent.provider
    const resumeSessionId = paneContent.resumeSessionId
    const currentStatus = paneContent.status
    void getFreshAgentThreadSnapshot(provider, sessionId, { signal: controller.signal })
      .then((next) => {
        const resolved = next as FreshAgentSnapshot
        setSnapshot(resolved)
        const nextStatus = (resolved.status as FreshAgentPaneContent['status']) ?? currentStatus
        const nextResumeSessionId = resumeSessionId ?? sessionId
        if (nextStatus === currentStatus && nextResumeSessionId === resumeSessionId) {
          return
        }
        dispatch(updatePaneContent({
          tabId,
          paneId,
          content: {
            ...paneContent,
            status: nextStatus,
            resumeSessionId: nextResumeSessionId,
          },
        }))
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return
        if (paneContent.provider === 'claude' && claudeSession) {
          setLoadError(null)
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
    paneId,
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
    if (!preferredResumeSessionId || preferredResumeSessionId === paneContent.resumeSessionId) return
    dispatch(mergePaneContent({
      tabId,
      paneId,
      updates: { resumeSessionId: preferredResumeSessionId },
    }))
  }, [
    dispatch,
    paneContent.provider,
    paneContent.resumeSessionId,
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
    const canFork = snapshot?.capabilities?.fork === true
    const totalTokens = snapshot?.tokenUsage?.totalTokens
    const statusLabel = getStatusLabel(effectiveStatus, isRestoring)
    const questionAgentLabel = getQuestionAgentLabel(paneContent, descriptor?.label)
    const summaryText = isRestoring
      ? 'Restoring session'
      : snapshot?.summary || paneContent.sessionId || statusLabel
    const visibleRestoreFailure = paneContent.provider === 'claude'
      ? claudeSession?.restoreFailureMessage
      : null
    const visibleLoadError = visibleRestoreFailure ? null : loadError

    return (
      <div className="flex h-full min-h-0 flex-col" data-context="fresh-agent" data-session-id={paneContent.sessionId}>
        <div className="border-b border-border/60 px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">{descriptor?.label ?? 'Fresh Agent'}</div>
              <div className="text-xs text-muted-foreground">{summaryText}</div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{statusLabel}</span>
              {typeof totalTokens === 'number' ? <span>{totalTokens} tokens</span> : null}
              <button
                type="button"
                className="rounded border border-border/70 px-2 py-1 disabled:opacity-50"
                disabled={!canInterrupt || !paneContent.sessionId}
                onClick={() => {
                  if (!paneContent.sessionId || !canInterrupt) return
                  sendFreshAgentMessage({
                    type: 'freshAgent.interrupt',
                    sessionId: paneContent.sessionId,
                  })
                }}
              >
                Interrupt
              </button>
              <button
                type="button"
                className="rounded border border-border/70 px-2 py-1 disabled:opacity-50"
                disabled={!canFork || !paneContent.sessionId}
                onClick={() => {
                  if (!paneContent.sessionId || !canFork) return
                  sendFreshAgentMessage({
                    type: 'freshAgent.fork',
                    sessionId: paneContent.sessionId,
                  })
                }}
              >
                Fork
              </button>
            </div>
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="space-y-2 px-3 pt-3">
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
                            status: 'starting',
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
              {visibleLoadError ? <FreshAgentApprovalBanner text={visibleLoadError} /> : null}
              {pendingApprovals.map((approval) => (
                <PermissionBanner
                  key={approval.requestId}
                  permission={{
                    requestId: approval.requestId,
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
                      requestId: approval.requestId,
                      decision: { behavior: 'allow', updatedInput: {} },
                    })
                  }}
                  onDeny={() => {
                    if (!paneContent.sessionId) return
                    sendFreshAgentMessage({
                      type: 'freshAgent.approval.respond',
                      sessionId: paneContent.sessionId,
                      requestId: approval.requestId,
                      decision: { behavior: 'deny', message: 'Denied by user', interrupt: false },
                    })
                  }}
                  disabled={!paneContent.sessionId}
                />
              ))}
              {pendingQuestions.map((question) => (
                <FreshAgentQuestionBanner
                  key={question.requestId}
                  question={{
                    requestId: question.requestId,
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
              disabled={!canSend || !paneContent.sessionId}
              onSend={(text) => {
                if (!paneContent.sessionId || !canSend) return
                sendFreshAgentMessage({
                  type: 'freshAgent.send',
                  sessionId: paneContent.sessionId,
                  text,
                })
              }}
            />
          </div>
          <FreshAgentSidebar worktrees={worktrees} childThreads={childThreads} />
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
    snapshot,
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

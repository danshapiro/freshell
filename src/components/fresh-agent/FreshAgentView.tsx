import { useEffect, useMemo, useState } from 'react'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { getWsClient } from '@/lib/ws-client'
import { getFreshAgentThreadSnapshot } from '@/lib/api'
import { updatePaneContent } from '@/store/panesSlice'
import { clearPendingCreateFailure } from '@/store/freshAgentSlice'
import { registerFreshAgentCreate } from '@/lib/fresh-agent-ws'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'
import { FreshAgentApprovalBanner } from './FreshAgentApprovalBanner'
import { FreshAgentQuestionBanner } from './FreshAgentQuestionBanner'
import { FreshAgentTranscript } from './FreshAgentTranscript'
import { FreshAgentComposer } from './FreshAgentComposer'
import { FreshAgentDiffPanel } from './FreshAgentDiffPanel'
import { FreshAgentSidebar } from './FreshAgentSidebar'

type FreshAgentSnapshot = {
  revision: number
  status?: string
  summary?: string
  capabilities?: Record<string, boolean>
  tokenUsage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number }
  worktrees?: Array<{ id: string; path: string; branch?: string }>
  diffs?: Array<{ id: string; path?: string; title?: string }>
  childThreads?: Array<{ id: string; threadId: string; origin?: string; title?: string }>
  pendingApprovals?: Array<{ requestId: string; toolName?: string }>
  pendingQuestions?: Array<{ requestId: string; questions?: Array<{ question: string }> }>
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
  const [snapshot, setSnapshot] = useState<FreshAgentSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const descriptor = resolveFreshAgentType(paneContent.sessionType)
  const usesClaudeCompatibility = paneContent.provider === 'claude'

  useEffect(() => {
    if (usesClaudeCompatibility || paneContent.sessionId || hidden) return
    const suppressed = typeof window !== 'undefined'
      && window.__FRESHELL_TEST_HARNESS__?.isAgentChatNetworkEffectsSuppressed?.(paneId) === true
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
    registerFreshAgentCreate(dispatch, paneContent.createRequestId)
    if (suppressed) {
      window.__FRESHELL_TEST_HARNESS__?.recordSentWsMessage?.(createMessage)
      return
    }
    ws.send(createMessage)
  }, [
    dispatch,
    hidden,
    paneContent.createRequestId,
    paneContent.effort,
    paneContent.initialCwd,
    paneContent.model,
    paneContent.permissionMode,
    paneContent.plugins,
    paneContent.provider,
    paneContent.resumeSessionId,
    paneContent.sessionId,
    paneContent.sessionType,
    paneId,
    usesClaudeCompatibility,
    ws,
  ])

  useEffect(() => {
    if (usesClaudeCompatibility) return
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
    })
    return unsubscribe
  }, [
    dispatch,
    paneContent,
    paneId,
    paneContent.createRequestId,
    tabId,
    usesClaudeCompatibility,
    ws,
  ])

  useEffect(() => {
    if (usesClaudeCompatibility || !paneContent.sessionId) return
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
        setLoadError(error instanceof Error ? error.message : 'Failed to load session')
      })
    return () => controller.abort()
  }, [
    dispatch,
    paneContent,
    paneContent.provider,
    paneContent.resumeSessionId,
    paneContent.sessionId,
    paneContent.status,
    paneId,
    tabId,
    usesClaudeCompatibility,
  ])

  const content = useMemo(() => {
    if (usesClaudeCompatibility) {
      return (
        <AgentChatView
          tabId={tabId}
          paneId={paneId}
          paneContent={{
            ...paneContent,
            kind: 'agent-chat',
            provider: paneContent.sessionType === 'kilroy' ? 'kilroy' : 'freshclaude',
          }}
          hidden={hidden}
        />
      )
    }

    const turns = snapshot?.turns ?? []
    const pendingApprovals = snapshot?.pendingApprovals ?? []
    const pendingQuestions = snapshot?.pendingQuestions ?? []
    const worktrees = snapshot?.worktrees ?? []
    const childThreads = snapshot?.childThreads ?? []
    const diffs = snapshot?.diffs ?? []
    const canSend = snapshot?.capabilities?.send === true
    const canInterrupt = snapshot?.capabilities?.interrupt === true
    const canFork = snapshot?.capabilities?.fork === true
    const totalTokens = snapshot?.tokenUsage?.totalTokens

    return (
      <div className="flex h-full min-h-0 flex-col" data-context="fresh-agent" data-session-id={paneContent.sessionId}>
        <div className="border-b border-border/60 px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">{descriptor?.label ?? 'Fresh Agent'}</div>
              <div className="text-xs text-muted-foreground">{snapshot?.summary || paneContent.sessionId || 'Starting session'}</div>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {typeof totalTokens === 'number' ? <span>{totalTokens} tokens</span> : null}
              <button
                type="button"
                className="rounded border border-border/70 px-2 py-1 disabled:opacity-50"
                disabled={!canInterrupt || !paneContent.sessionId}
                onClick={() => {
                  if (!paneContent.sessionId || !canInterrupt) return
                  const message = {
                    type: 'freshAgent.interrupt',
                    sessionId: paneContent.sessionId,
                  } as const
                  if (typeof window !== 'undefined'
                    && window.__FRESHELL_TEST_HARNESS__?.isAgentChatNetworkEffectsSuppressed?.(paneId) === true) {
                    window.__FRESHELL_TEST_HARNESS__?.recordSentWsMessage?.(message)
                    return
                  }
                  ws.send(message)
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
                  const message = {
                    type: 'freshAgent.fork',
                    sessionId: paneContent.sessionId,
                  } as const
                  if (typeof window !== 'undefined'
                    && window.__FRESHELL_TEST_HARNESS__?.isAgentChatNetworkEffectsSuppressed?.(paneId) === true) {
                    window.__FRESHELL_TEST_HARNESS__?.recordSentWsMessage?.(message)
                    return
                  }
                  ws.send(message)
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
                <FreshAgentApprovalBanner text={(pendingCreateFailure ?? paneContent.createError)?.message ?? 'Create failed'} />
              ) : null}
              {loadError ? <FreshAgentApprovalBanner text={loadError} /> : null}
              {pendingApprovals.map((approval) => (
                <FreshAgentApprovalBanner key={approval.requestId} text={`Approval required: ${approval.toolName ?? approval.requestId}`} />
              ))}
              {pendingQuestions.map((question) => (
                <FreshAgentQuestionBanner key={question.requestId} text={question.questions?.[0]?.question ?? 'Question'} />
              ))}
              <FreshAgentDiffPanel diffs={diffs} />
            </div>
            <FreshAgentTranscript turns={turns} />
            <FreshAgentComposer
              disabled={!canSend || !paneContent.sessionId}
              onSend={(text) => {
                if (!paneContent.sessionId || !canSend) return
                const message = {
                  type: 'freshAgent.send',
                  sessionId: paneContent.sessionId,
                  text,
                } as const
                if (typeof window !== 'undefined'
                  && window.__FRESHELL_TEST_HARNESS__?.isAgentChatNetworkEffectsSuppressed?.(paneId) === true) {
                  window.__FRESHELL_TEST_HARNESS__?.recordSentWsMessage?.(message)
                  return
                }
                ws.send(message)
              }}
            />
          </div>
          <FreshAgentSidebar worktrees={worktrees} childThreads={childThreads} />
        </div>
      </div>
    )
  }, [descriptor?.label, hidden, loadError, paneContent, pendingCreateFailure, snapshot, tabId, paneId, usesClaudeCompatibility])

  useEffect(() => {
    if (!pendingCreateFailure) return
    return () => {
      dispatch(clearPendingCreateFailure({ requestId: paneContent.createRequestId }))
    }
  }, [dispatch, paneContent.createRequestId, pendingCreateFailure])

  return content
}

export default FreshAgentView

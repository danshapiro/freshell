import {
  ClaudeFreshAgentHistoryResolutionError,
  createClaudeFreshAgentHistoryService,
  type ClaudeFreshAgentHistoryService,
} from '../../history/claude/history-service.js'
import type { ClaudeFreshAgentHistorySource } from '../../history/claude/history-source.js'
import { synthesizeClaudeFreshAgentLiveMessageId, type ClaudeFreshAgentHistoryRestoreResolution } from '../../history/claude/history-ledger.js'
import type { SdkBridge } from '../../../sdk-bridge.js'
import type { SdkSessionState } from '../../../sdk-bridge-types.js'
import { logger } from '../../../logger.js'
import { FreshAgentStaleThreadRevisionError } from '../../runtime-manager.js'
import type { FreshAgentCreateRequest, FreshAgentRuntimeAdapter, FreshAgentThreadLocator } from '../../runtime-adapter.js'
import {
  normalizeClaudeThreadSnapshot,
  normalizeClaudeTurnBody,
  normalizeClaudeTurnPage,
} from './normalize.js'
import { normalizeFreshAgentEffort, normalizeFreshAgentModel } from '../../../../shared/fresh-agent-models.js'

const log = logger.child({ component: 'fresh-agent-claude-adapter' })

type ClaudeBridgePort = Pick<
  SdkBridge,
  | 'createSession'
  | 'subscribe'
  | 'sendUserMessage'
  | 'interrupt'
  | 'killSession'
  | 'respondQuestion'
  | 'respondPermission'
  | 'getSession'
  | 'findSessionByCliSessionId'
>

export type ClaudeFreshAgentAdapterDeps = {
  sdkBridge: ClaudeBridgePort
  agentHistorySource?: ClaudeFreshAgentHistorySource
  historyService?: ClaudeFreshAgentHistoryService
}

function toClaudeEffort(value: FreshAgentCreateRequest['effort']) {
  if (value === undefined || value === 'low' || value === 'medium' || value === 'high' || value === 'max') {
    return value
  }
  throw new Error(`Freshclaude does not support reasoning effort "${value}".`)
}

function normalizeClaudeInput(input: FreshAgentCreateRequest): FreshAgentCreateRequest {
  const model = normalizeFreshAgentModel(input.sessionType, 'claude', input.model)
  return {
    ...input,
    model,
    effort: normalizeFreshAgentEffort(input.sessionType, 'claude', model, input.effort),
  }
}

function mapMissingResult(ok: boolean, message: string): void {
  if (!ok) {
    throw new Error(message)
  }
}

function buildLiveOnlyResolution(threadId: string, liveSession: SdkSessionState): Extract<ClaudeFreshAgentHistoryRestoreResolution, { kind: 'resolved' }> {
  const turns = liveSession.messages.map((message, index) => {
    const messageId = typeof message.messageId === 'string' && message.messageId.trim().length > 0
      ? message.messageId
      : synthesizeClaudeFreshAgentLiveMessageId(liveSession.sessionId, index)
    return {
      turnId: `turn:${messageId}`,
      messageId,
      ordinal: index,
      source: 'live' as const,
      message: {
        ...message,
        messageId,
      },
    }
  })

  return {
    kind: 'resolved',
    queryId: liveSession.sessionId,
    liveSessionId: liveSession.sessionId,
    timelineSessionId: liveSession.cliSessionId ?? liveSession.resumeSessionId ?? threadId,
    readiness: 'live_only',
    revision: 1,
    latestTurnId: turns.at(-1)?.turnId ?? null,
    turns,
  }
}

function assertFreshAgentRevision(currentRevision: number, requestedRevision?: number): void {
  if (requestedRevision != null && requestedRevision !== currentRevision) {
    throw new FreshAgentStaleThreadRevisionError(currentRevision)
  }
}

export function createClaudeFreshAgentAdapter(deps: ClaudeFreshAgentAdapterDeps): FreshAgentRuntimeAdapter {
  const historyService = deps.historyService ?? (
    deps.agentHistorySource
      ? createClaudeFreshAgentHistoryService({ agentHistorySource: deps.agentHistorySource })
      : null
  )

  function resolveLiveSession(threadId: string): SdkSessionState | undefined {
    return deps.sdkBridge.getSession(threadId) ?? deps.sdkBridge.findSessionByCliSessionId(threadId)
  }

  async function loadResolved(threadId: string, revision?: number) {
    if (!historyService) {
      throw new Error('Claude history service is not configured')
    }
    return await historyService.getSnapshot({ sessionId: threadId, revision })
  }

  return {
    runtimeProvider: 'claude',

    async create(input: FreshAgentCreateRequest) {
      const normalizedInput = normalizeClaudeInput(input)
      const session = await deps.sdkBridge.createSession({
        cwd: normalizedInput.cwd,
        resumeSessionId: normalizedInput.resumeSessionId,
        model: normalizedInput.model,
        permissionMode: normalizedInput.permissionMode,
        effort: toClaudeEffort(normalizedInput.effort),
        plugins: normalizedInput.plugins,
      })
      return { sessionId: session.sessionId }
    },

    async resume(input: FreshAgentCreateRequest) {
      const normalizedInput = normalizeClaudeInput(input)
      const session = await deps.sdkBridge.createSession({
        cwd: normalizedInput.cwd,
        resumeSessionId: normalizedInput.resumeSessionId,
        model: normalizedInput.model,
        permissionMode: normalizedInput.permissionMode,
        effort: toClaudeEffort(normalizedInput.effort),
        plugins: normalizedInput.plugins,
      })
      return { sessionId: session.sessionId }
    },

    subscribe(sessionId, listener) {
      const subscription = deps.sdkBridge.subscribe(sessionId, listener as never)
      if (!subscription) {
        throw new Error(`Claude session ${sessionId} is not available`)
      }
      return subscription.off
    },

    send(sessionId, input) {
      const images = input.images?.flatMap((image) => image.kind === 'data'
        ? [{ mediaType: image.mediaType, data: image.data }]
        : [])
      mapMissingResult(
        deps.sdkBridge.sendUserMessage(sessionId, input.text, images),
        `Claude session ${sessionId} is not available`,
      )
    },

    interrupt(sessionId) {
      mapMissingResult(
        deps.sdkBridge.interrupt(sessionId),
        `Claude session ${sessionId} is not available`,
      )
    },

    compact(sessionId, input) {
      const suffix = input?.instructions ? ` ${input.instructions.trim()}` : ''
      mapMissingResult(
        deps.sdkBridge.sendUserMessage(sessionId, `/compact${suffix}`),
        `Claude session ${sessionId} is not available`,
      )
    },

    kill(sessionId) {
      return deps.sdkBridge.killSession(sessionId)
    },

    answerQuestion(sessionId, requestId, answers) {
      mapMissingResult(
        deps.sdkBridge.respondQuestion(sessionId, String(requestId), answers),
        `Claude question ${requestId} is not available`,
      )
    },

    resolveApproval(sessionId, requestId, decision) {
      mapMissingResult(
        deps.sdkBridge.respondPermission(sessionId, String(requestId), decision as never),
        `Claude approval ${requestId} is not available`,
      )
    },

    async getSnapshot(thread: FreshAgentThreadLocator, revision?: number) {
      const liveSession = resolveLiveSession(thread.threadId)
      if (liveSession) {
        const resolved = await deps.agentHistorySource?.resolve(
          thread.threadId,
          { liveSessionOverride: liveSession },
        )
        if (resolved?.kind === 'resolved') {
          assertFreshAgentRevision(resolved.revision, revision)
          return normalizeClaudeThreadSnapshot({
            threadId: thread.threadId,
            resolved,
            liveSession,
            status: liveSession.status,
          })
        }

        log.warn({
          threadId: thread.threadId,
          liveSessionId: liveSession.sessionId,
          code: resolved?.code ?? 'RESTORE_NOT_FOUND',
          message: resolved?.kind === 'fatal' ? resolved.message : undefined,
        }, 'Falling back to live-only Claude fresh-agent snapshot')

        const liveOnly = buildLiveOnlyResolution(thread.threadId, liveSession)
        assertFreshAgentRevision(liveOnly.revision, revision)
        return normalizeClaudeThreadSnapshot({
          threadId: thread.threadId,
          resolved: liveOnly,
          liveSession,
          status: liveSession.status,
        })
      }

      const resolvedSnapshot = await loadResolved(thread.threadId, revision)
      const resolved = await deps.agentHistorySource?.resolve(thread.threadId)
      if (!resolved || resolved.kind !== 'resolved') {
        throw new ClaudeFreshAgentHistoryResolutionError('RESTORE_NOT_FOUND', 'Restore session not found')
      }
      return normalizeClaudeThreadSnapshot({
        threadId: thread.threadId,
        resolved: {
          ...resolved,
          revision: resolvedSnapshot.revision,
          latestTurnId: resolvedSnapshot.latestTurnId,
          turns: resolvedSnapshot.turns,
        },
        liveSession,
        status: 'idle',
      })
    },

    async getTurnPage(thread, query) {
      if (!historyService) {
        throw new Error('Claude history service is not configured')
      }
      const page = await historyService.getThreadTurnPage({
        sessionId: thread.threadId,
        cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
        priority: typeof query.priority === 'string' ? query.priority as 'visible' | 'background' : undefined,
        revision: typeof query.revision === 'number' ? query.revision : undefined,
        limit: typeof query.limit === 'number' ? query.limit : undefined,
        includeBodies: query.includeBodies === true,
      })
      return normalizeClaudeTurnPage({ threadId: thread.threadId, page })
    },

    async getTurnBody(thread, revision) {
      if (!historyService) {
        throw new Error('Claude history service is not configured')
      }
      const turn = await historyService.getTurnBody({
        sessionId: thread.threadId,
        turnId: thread.turnId,
        revision,
      })
      if (!turn) return null
      return normalizeClaudeTurnBody({
        turn,
        revision,
        threadId: thread.threadId,
      })
    },
  }
}

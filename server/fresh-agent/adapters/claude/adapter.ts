import {
  RestoreResolutionError,
  RestoreStaleRevisionError,
  createAgentTimelineService,
  type AgentTimelineService,
} from '../../../agent-timeline/service.js'
import type { AgentHistorySource } from '../../../agent-timeline/history-source.js'
import type { SdkBridge } from '../../../sdk-bridge.js'
import type { SdkSessionState } from '../../../sdk-bridge-types.js'
import { FreshAgentStaleThreadRevisionError } from '../../runtime-manager.js'
import type { FreshAgentCreateRequest, FreshAgentRuntimeAdapter, FreshAgentThreadLocator } from '../../runtime-adapter.js'
import {
  normalizeClaudeThreadSnapshot,
  normalizeClaudeTurnBody,
  normalizeClaudeTurnPage,
} from './normalize.js'
import { normalizeFreshAgentEffort, normalizeFreshAgentModel } from '../../../../shared/fresh-agent-models.js'

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
  agentHistorySource?: AgentHistorySource
  timelineService?: AgentTimelineService
}

function mapTimelineError(error: unknown): never {
  if (error instanceof RestoreStaleRevisionError) {
    throw new FreshAgentStaleThreadRevisionError(error.actualRevision)
  }
  throw error
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

export function createClaudeFreshAgentAdapter(deps: ClaudeFreshAgentAdapterDeps): FreshAgentRuntimeAdapter {
  const timelineService = deps.timelineService ?? (
    deps.agentHistorySource
      ? createAgentTimelineService({ agentHistorySource: deps.agentHistorySource })
      : null
  )

  function resolveLiveSession(threadId: string): SdkSessionState | undefined {
    return deps.sdkBridge.getSession(threadId) ?? deps.sdkBridge.findSessionByCliSessionId(threadId)
  }

  async function loadResolved(threadId: string, revision?: number) {
    if (!timelineService) {
      throw new Error('Claude timeline service is not configured')
    }
    try {
      return await timelineService.getSnapshot({ sessionId: threadId, revision })
    } catch (error) {
      mapTimelineError(error)
    }
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
      const resolvedSnapshot = await loadResolved(thread.threadId, revision)
      const liveSession = resolveLiveSession(thread.threadId)
      const resolved = await deps.agentHistorySource?.resolve(
        thread.threadId,
        liveSession ? { liveSessionOverride: liveSession } : undefined,
      )
      if (!resolved || resolved.kind !== 'resolved') {
        throw new RestoreResolutionError('RESTORE_NOT_FOUND', 'Restore session not found')
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
        status: liveSession?.status ?? 'idle',
      })
    },

    async getTurnPage(thread, query) {
      if (!timelineService) {
        throw new Error('Claude timeline service is not configured')
      }
      try {
        const page = await timelineService.getTimelinePage({
          sessionId: thread.threadId,
          cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
          priority: typeof query.priority === 'string' ? query.priority as 'visible' | 'background' : undefined,
          revision: Number(query.revision),
          limit: typeof query.limit === 'number' ? query.limit : undefined,
          includeBodies: query.includeBodies === true,
        })
        return normalizeClaudeTurnPage({ threadId: thread.threadId, page })
      } catch (error) {
        mapTimelineError(error)
      }
    },

    async getTurnBody(thread, revision) {
      if (!timelineService) {
        throw new Error('Claude timeline service is not configured')
      }
      try {
        const turn = await timelineService.getTurnBody({
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
      } catch (error) {
        mapTimelineError(error)
      }
    },
  }
}

import type { FreshAgentCreateRequest, FreshAgentRuntimeAdapter } from '../../runtime-adapter.js'
import { normalizeCodexThreadSnapshot } from './normalize.js'

type CodexRuntimePort = {
  startThread: (input: {
    cwd?: string
    model?: string
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
    approvalPolicy?: string
    richClient?: boolean
  }) => Promise<{ threadId: string; wsUrl: string }>
  resumeThread: (input: {
    threadId: string
    cwd?: string
    model?: string
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
    approvalPolicy?: string
    richClient?: boolean
  }) => Promise<{ threadId: string; wsUrl: string }>
  readThread: (input: { threadId: string; revision?: number }) => Promise<Record<string, any>>
  listThreadTurns: (input: {
    threadId: string
    revision?: number
    cursor?: string
    limit?: number
    includeBodies?: boolean
  }) => Promise<Record<string, any>>
  readThreadTurn: (input: { threadId: string; turnId: string; revision?: number }) => Promise<Record<string, any>>
}

export function createCodexFreshAgentAdapter(deps: {
  runtime: CodexRuntimePort
}): FreshAgentRuntimeAdapter {
  return {
    runtimeProvider: 'codex',

    async create(input: FreshAgentCreateRequest) {
      const started = await deps.runtime.startThread({
        cwd: input.cwd,
        model: input.model,
        approvalPolicy: input.permissionMode,
        richClient: true,
      })
      return { sessionId: started.threadId }
    },

    async resume(input: FreshAgentCreateRequest) {
      if (!input.resumeSessionId) {
        throw new Error('Codex rich resume requires resumeSessionId')
      }
      const resumed = await deps.runtime.resumeThread({
        threadId: input.resumeSessionId,
        cwd: input.cwd,
        model: input.model,
        approvalPolicy: input.permissionMode,
        richClient: true,
      })
      return { sessionId: resumed.threadId }
    },

    async getSnapshot(thread, revision) {
      const rawSnapshot = await deps.runtime.readThread({ threadId: thread.threadId, revision })
      return normalizeCodexThreadSnapshot({
        threadId: thread.threadId,
        revision: Number(rawSnapshot.revision ?? revision ?? 0),
        status: typeof rawSnapshot.status === 'string' ? rawSnapshot.status : 'idle',
        transcript: {
          turns: Array.isArray(rawSnapshot.turns) ? rawSnapshot.turns : [],
        },
        rawSnapshot,
      })
    },

    async getTurnPage(thread, query) {
      return await deps.runtime.listThreadTurns({
        threadId: thread.threadId,
        revision: typeof query.revision === 'number' ? query.revision : Number(query.revision),
        cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
        limit: typeof query.limit === 'number' ? query.limit : undefined,
        includeBodies: query.includeBodies === true,
      })
    },

    async getTurnBody(thread, revision) {
      return await deps.runtime.readThreadTurn({
        threadId: thread.threadId,
        turnId: thread.turnId,
        revision,
      })
    },
  }
}

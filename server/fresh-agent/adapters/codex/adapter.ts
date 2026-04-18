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
}

type CodexReadStore = {
  getSnapshot: (threadId: string, revision?: number) => Promise<Record<string, any>>
  getTurnPage: (threadId: string, query: Record<string, unknown>) => Promise<unknown>
  getTurnBody: (threadId: string, turnId: string, revision: number) => Promise<unknown>
}

export function createCodexFreshAgentAdapter(deps: {
  runtime: CodexRuntimePort
  readStore: CodexReadStore
}): FreshAgentRuntimeAdapter {
  return {
    runtimeProvider: 'codex',

    async create(input: FreshAgentCreateRequest) {
      const started = await deps.runtime.startThread({
        cwd: input.cwd,
        model: input.model,
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
        richClient: true,
      })
      return { sessionId: resumed.threadId }
    },

    async getSnapshot(thread, revision) {
      const rawSnapshot = await deps.readStore.getSnapshot(thread.threadId, revision)
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
      return await deps.readStore.getTurnPage(thread.threadId, query)
    },

    async getTurnBody(thread, revision) {
      return await deps.readStore.getTurnBody(thread.threadId, thread.turnId, revision)
    },
  }
}

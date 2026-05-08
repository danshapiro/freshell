import type { FreshAgentCreateRequest, FreshAgentRuntimeAdapter } from '../../runtime-adapter.js'
import {
  normalizeCodexThreadSnapshot,
  normalizeCodexTurnBody,
  normalizeCodexTurnPage,
} from './normalize.js'

type CodexRuntimePort = {
  startThread: (input: {
    cwd?: string
    model?: string
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
  }) => Promise<{ threadId: string; wsUrl: string }>
  resumeThread: (input: {
    threadId: string
    cwd?: string
    model?: string
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
  }) => Promise<{ threadId: string; wsUrl: string }>
  readThread: (input: { threadId: string; includeTurns?: boolean }) => Promise<Record<string, any>>
  listThreadTurns: (input: {
    threadId: string
    cursor?: string
    limit?: number
  }) => Promise<Record<string, any>>
  readThreadTurn: (input: { threadId: string; turnId: string; revision?: number }) => Promise<Record<string, any>>
}

function toCodexApprovalPolicy(value: string | undefined) {
  if (value === undefined) return undefined
  if (value === 'untrusted' || value === 'on-failure' || value === 'on-request' || value === 'never') {
    return value
  }
  throw new Error(`Freshcodex does not support approval policy "${value}". Choose untrusted, on-failure, on-request, or never.`)
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
        approvalPolicy: toCodexApprovalPolicy(input.permissionMode),
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
        approvalPolicy: toCodexApprovalPolicy(input.permissionMode),
      })
      return { sessionId: resumed.threadId }
    },

    async getSnapshot(thread, revision) {
      const rawSnapshot = await deps.runtime.readThread({ threadId: thread.threadId, includeTurns: false })
      return normalizeCodexThreadSnapshot({
        threadId: thread.threadId,
        revision: Number(rawSnapshot.thread?.updatedAt ?? revision ?? 0),
        status: typeof rawSnapshot.thread?.status?.type === 'string' ? rawSnapshot.thread.status.type : 'idle',
        transcript: {
          turns: [],
        },
        rawSnapshot,
      })
    },

    async getTurnPage(thread, query) {
      const rawPage = await deps.runtime.listThreadTurns({
        threadId: thread.threadId,
        cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
        limit: typeof query.limit === 'number' ? query.limit : undefined,
      })
      return normalizeCodexTurnPage({
        threadId: thread.threadId,
        revision: Number(rawPage.revision ?? query.revision ?? 0),
        rawPage,
      })
    },

    async getTurnBody(thread, revision) {
      const rawTurn = await deps.runtime.readThreadTurn({
        threadId: thread.threadId,
        turnId: thread.turnId,
        revision,
      })
      return normalizeCodexTurnBody({
        threadId: thread.threadId,
        revision,
        rawTurn,
      })
    },
  }
}

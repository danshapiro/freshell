import type { FreshAgentCreateRequest, FreshAgentInputImage, FreshAgentRuntimeAdapter } from '../../runtime-adapter.js'
import type {
  CodexThreadForkParams,
  CodexTurnInterruptParams,
  CodexTurnStartParams,
} from '../../../coding-cli/codex-app-server/protocol.js'
import {
  normalizeCodexThreadSnapshot,
  normalizeCodexTurn,
  normalizeCodexTurnBody,
  normalizeCodexTurnPage,
} from './normalize.js'

type CodexThreadLifecycleEvent =
  | {
    kind: 'thread_started'
    thread: {
      id: string
      updatedAt?: number
      status?: unknown
    }
  }
  | {
    kind: 'thread_closed'
    threadId: string
  }
  | {
    kind: 'thread_status_changed'
    threadId: string
    status: unknown
  }

type CodexRuntimePort = {
  startThread: (input: {
    cwd?: string
    model?: string
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
    excludeTurns?: boolean
  }) => Promise<{ threadId: string; wsUrl: string }>
  resumeThread: (input: {
    threadId: string
    cwd?: string
    model?: string
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
  }) => Promise<{ threadId: string; wsUrl: string }>
  forkThread?: (input: CodexThreadForkParams) => Promise<{ threadId: string; wsUrl: string }>
  startTurn?: (input: CodexTurnStartParams) => Promise<{ turnId: string }>
  interruptTurn?: (input: CodexTurnInterruptParams) => Promise<void>
  onThreadLifecycle?: (handler: (event: CodexThreadLifecycleEvent) => void) => () => void
  readThread: (input: { threadId: string; includeTurns?: boolean }) => Promise<Record<string, any>>
  listThreadTurns: (input: {
    threadId: string
    cursor?: string
    limit?: number
    itemsView?: 'notLoaded' | 'summary' | 'full'
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

function toCodexReasoningEffort(value: FreshAgentCreateRequest['effort'] | undefined) {
  if (value === undefined) return undefined
  if (value === 'none' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value
  }
  throw new Error(`Freshcodex does not support reasoning effort "${value}". Choose none, minimal, low, medium, high, or xhigh.`)
}

function toCodexSandboxPolicy(value: FreshAgentCreateRequest['sandbox'] | undefined): CodexTurnStartParams['sandboxPolicy'] {
  switch (value) {
    case undefined:
      return undefined
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
    case 'read-only':
      return { type: 'readOnly' }
    case 'workspace-write':
      return { type: 'workspaceWrite' }
    default:
      throw new Error(`Freshcodex does not support sandbox "${String(value)}".`)
  }
}

function toCodexUserInput(text: string, images: FreshAgentInputImage[] | undefined): CodexTurnStartParams['input'] {
  const input: CodexTurnStartParams['input'] = [{
    type: 'text',
    text,
    text_elements: [],
  }]
  for (const image of images ?? []) {
    if (image.kind === 'url') {
      input.push({ type: 'image', url: image.url })
    } else if (image.kind === 'local') {
      input.push({ type: 'localImage', path: image.path })
    } else {
      input.push({ type: 'image', url: `data:${image.mediaType};base64,${image.data}` })
    }
  }
  return input
}

function normalizeCodexThreadStatus(status: unknown): string {
  if (!status || typeof status !== 'object') return 'idle'
  const type = (status as { type?: unknown }).type
  if (type === 'active') return 'running'
  if (type === 'notLoaded') return 'starting'
  if (type === 'systemError') return 'exited'
  if (type === 'idle') return 'idle'
  return 'idle'
}

function makeCodexStatusEvent(sessionId: string, status: unknown, revision?: number) {
  return {
    type: 'sdk.session.snapshot',
    sessionId,
    latestTurnId: null,
    status: normalizeCodexThreadStatus(status),
    timelineSessionId: sessionId,
    revision,
  }
}

export function createCodexFreshAgentAdapter(deps: {
  runtime: CodexRuntimePort
}): FreshAgentRuntimeAdapter {
  const activeTurnByThread = new Map<string, string>()
  const settingsByThread = new Map<string, FreshAgentCreateRequest>()

  return {
    runtimeProvider: 'codex',

    async create(input: FreshAgentCreateRequest) {
      toCodexReasoningEffort(input.effort)
      const started = await deps.runtime.startThread({
        cwd: input.cwd,
        model: input.model,
        sandbox: input.sandbox,
        approvalPolicy: toCodexApprovalPolicy(input.permissionMode),
        excludeTurns: true,
      })
      settingsByThread.set(started.threadId, input)
      return { sessionId: started.threadId, sessionRef: { provider: 'codex', sessionId: started.threadId } }
    },

    async resume(input: FreshAgentCreateRequest) {
      if (!input.resumeSessionId) {
        throw new Error('Codex rich resume requires resumeSessionId')
      }
      toCodexReasoningEffort(input.effort)
      const resumed = await deps.runtime.resumeThread({
        threadId: input.resumeSessionId,
        cwd: input.cwd,
        model: input.model,
        sandbox: input.sandbox,
        approvalPolicy: toCodexApprovalPolicy(input.permissionMode),
      })
      settingsByThread.set(resumed.threadId, input)
      return { sessionId: resumed.threadId, sessionRef: { provider: 'codex', sessionId: resumed.threadId } }
    },

    subscribe(sessionId, listener) {
      if (!deps.runtime.onThreadLifecycle) {
        throw new Error('Codex app-server runtime does not support thread lifecycle subscriptions.')
      }
      return deps.runtime.onThreadLifecycle((event) => {
        if (event.kind === 'thread_started') {
          if (event.thread.id !== sessionId) return
          listener(makeCodexStatusEvent(sessionId, event.thread.status, event.thread.updatedAt))
          return
        }
        if (event.kind === 'thread_closed') {
          if (event.threadId !== sessionId) return
          activeTurnByThread.delete(sessionId)
          listener({
            type: 'sdk.status',
            sessionId,
            status: 'exited',
          })
          return
        }
        if (event.threadId !== sessionId) return
        const status = normalizeCodexThreadStatus(event.status)
        if (status !== 'running' && status !== 'starting') {
          activeTurnByThread.delete(sessionId)
        }
        listener(makeCodexStatusEvent(sessionId, event.status))
      })
    },

    async send(sessionId, input) {
      if (!deps.runtime.startTurn) {
        throw new Error('Codex app-server runtime does not support turn/start.')
      }
      const settings = {
        ...settingsByThread.get(sessionId),
        ...input.settings,
      }
      const turn = await deps.runtime.startTurn({
        threadId: sessionId,
        input: toCodexUserInput(input.text, input.images),
        cwd: settings.cwd,
        approvalPolicy: toCodexApprovalPolicy(settings.permissionMode),
        sandboxPolicy: toCodexSandboxPolicy(settings.sandbox),
        model: settings.model,
        effort: toCodexReasoningEffort(settings.effort),
      })
      activeTurnByThread.set(sessionId, turn.turnId)
    },

    async interrupt(sessionId) {
      if (!deps.runtime.interruptTurn) {
        throw new Error('Codex app-server runtime does not support turn/interrupt.')
      }
      const turnId = activeTurnByThread.get(sessionId)
      if (!turnId) {
        throw new Error(`No active Codex turn is tracked for ${sessionId}.`)
      }
      await deps.runtime.interruptTurn({ threadId: sessionId, turnId })
      activeTurnByThread.delete(sessionId)
    },

    async fork(sessionId, input) {
      if (!deps.runtime.forkThread) {
        throw new Error('Codex app-server runtime does not support thread/fork.')
      }
      const settings = settingsByThread.get(sessionId)
      return await deps.runtime.forkThread({
        threadId: sessionId,
        cwd: typeof input?.cwd === 'string' ? input.cwd : settings?.cwd,
        model: typeof input?.model === 'string' ? input.model : settings?.model,
        sandbox: typeof input?.sandbox === 'string' ? input.sandbox as FreshAgentCreateRequest['sandbox'] : settings?.sandbox,
        approvalPolicy: toCodexApprovalPolicy(
          typeof input?.permissionMode === 'string' ? input.permissionMode : settings?.permissionMode,
        ),
        excludeTurns: true,
      })
    },

    async getSnapshot(thread, revision) {
      const rawSnapshot = await deps.runtime.readThread({ threadId: thread.threadId, includeTurns: true })
      const rawThreadTurns: unknown[] = Array.isArray(rawSnapshot.thread?.turns)
        ? rawSnapshot.thread.turns
        : []
      const rawTurns = rawThreadTurns
        .filter((turn): turn is Record<string, unknown> => !!turn && typeof turn === 'object' && !Array.isArray(turn))
        .map((turn, index) => normalizeCodexTurn(turn, index))
      return normalizeCodexThreadSnapshot({
        threadId: thread.threadId,
        revision: Number(rawSnapshot.thread?.updatedAt ?? revision ?? 0),
        status: normalizeCodexThreadStatus(rawSnapshot.thread?.status),
        transcript: {
          turns: rawTurns,
        },
        rawSnapshot,
      })
    },

    async getTurnPage(thread, query) {
      const rawPage = await deps.runtime.listThreadTurns({
        threadId: thread.threadId,
        cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
        limit: typeof query.limit === 'number' ? query.limit : undefined,
        itemsView: 'full',
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

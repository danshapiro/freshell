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
import { normalizeFreshAgentEffort, normalizeFreshAgentModel } from '../../../../shared/fresh-agent-models.js'

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
  compactThread?: (input: { threadId: string; instructions?: string }) => Promise<void>
  interruptTurn?: (input: CodexTurnInterruptParams) => Promise<void>
  shutdown?: () => Promise<void>
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

function toCodexResumeInput(
  threadId: string,
  settings?: Partial<FreshAgentCreateRequest>,
): Parameters<CodexRuntimePort['resumeThread']>[0] {
  return {
    threadId,
    ...(settings?.cwd !== undefined ? { cwd: settings.cwd } : {}),
    ...(settings?.model !== undefined ? { model: settings.model } : {}),
    ...(settings?.sandbox !== undefined ? { sandbox: settings.sandbox } : {}),
    ...(settings?.permissionMode !== undefined ? { approvalPolicy: toCodexApprovalPolicy(settings.permissionMode) } : {}),
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

function normalizeCodexInput(input: FreshAgentCreateRequest): FreshAgentCreateRequest {
  const model = normalizeFreshAgentModel(input.sessionType, 'codex', input.model)
  return {
    ...input,
    model,
    effort: normalizeFreshAgentEffort(input.sessionType, 'codex', model, input.effort),
  }
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

function isCodexIncludeTurnsUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('includeTurns is unavailable before first user message')
    || error.message.includes('not materialized yet')
}

function findActiveTurnId(rawSnapshot: Record<string, any>): string | undefined {
  const turns = Array.isArray(rawSnapshot.thread?.turns) ? rawSnapshot.thread.turns : []
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (!turn || typeof turn !== 'object' || Array.isArray(turn)) continue
    const record = turn as Record<string, unknown>
    if (record.status === 'inProgress' && typeof record.id === 'string' && record.id.length > 0) {
      return record.id
    }
  }
  return undefined
}

export function createCodexFreshAgentAdapter(deps: {
  runtime?: CodexRuntimePort
  runtimeFactory?: () => CodexRuntimePort
}): FreshAgentRuntimeAdapter {
  const activeTurnByThread = new Map<string, string>()
  const settingsByThread = new Map<string, Partial<FreshAgentCreateRequest>>()
  const runtimeByThread = new Map<string, CodexRuntimePort>()
  const threadIdsByRuntime = new Map<CodexRuntimePort, Set<string>>()
  const ownedRuntimes = new Set<CodexRuntimePort>()
  const runtimeResumeByThread = new Map<string, Promise<CodexRuntimePort>>()
  const runtimeResumeGenerationByThread = new Map<string, number>()
  const modelByTurnByThread = new Map<string, Map<string, string>>()

  const rememberRuntimeThread = (threadId: string, runtime: CodexRuntimePort) => {
    runtimeByThread.set(threadId, runtime)
    const threadIds = threadIdsByRuntime.get(runtime) ?? new Set<string>()
    threadIds.add(threadId)
    threadIdsByRuntime.set(runtime, threadIds)
  }

  const forgetRuntimeThread = (threadId: string): CodexRuntimePort | undefined => {
    const runtime = runtimeByThread.get(threadId)
    runtimeByThread.delete(threadId)
    if (!runtime) return undefined
    const threadIds = threadIdsByRuntime.get(runtime)
    threadIds?.delete(threadId)
    if (threadIds && threadIds.size === 0) {
      threadIdsByRuntime.delete(runtime)
    }
    return runtime
  }

  const allocateRuntime = () => {
    if (deps.runtimeFactory) {
      const runtime = deps.runtimeFactory()
      ownedRuntimes.add(runtime)
      return { runtime, owned: true }
    }
    if (deps.runtime) return { runtime: deps.runtime, owned: false }
    throw new Error('Codex fresh-agent adapter requires a runtime or runtimeFactory.')
  }

  const getExistingRuntime = (sessionId: string): CodexRuntimePort | undefined => {
    return runtimeByThread.get(sessionId) ?? deps.runtime
  }

  const requireRuntime = (sessionId: string): CodexRuntimePort => {
    const runtime = runtimeByThread.get(sessionId) ?? deps.runtime
    if (!runtime) {
      throw new Error(`Codex app-server runtime is not available for freshcodex session ${sessionId}.`)
    }
    return runtime
  }

  const ensureRuntime = async (sessionId: string, settings?: Partial<FreshAgentCreateRequest>): Promise<CodexRuntimePort> => {
    const existing = getExistingRuntime(sessionId)
    if (existing) return existing
    const inflight = runtimeResumeByThread.get(sessionId)
    if (inflight) return inflight

    const { runtime, owned } = allocateRuntime()
    const resumeGeneration = runtimeResumeGenerationByThread.get(sessionId) ?? 0
    let resumePromise: Promise<CodexRuntimePort> | undefined
    let runtimeDiscarded = false
    const discardOwnedRuntime = async () => {
      if (!owned || runtimeDiscarded) return
      runtimeDiscarded = true
      ownedRuntimes.delete(runtime)
      await runtime.shutdown?.().catch(() => undefined)
    }
    resumePromise = (async () => {
      try {
        const resumed = await runtime.resumeThread(toCodexResumeInput(sessionId, settings))
        if ((runtimeResumeGenerationByThread.get(sessionId) ?? 0) !== resumeGeneration) {
          await discardOwnedRuntime()
          throw new Error(`Codex app-server runtime resume was cancelled for freshcodex session ${sessionId}.`)
        }
        rememberRuntimeThread(resumed.threadId, runtime)
        if (settings) {
          settingsByThread.set(resumed.threadId, settings)
        }
        return runtime
      } catch (error) {
        await discardOwnedRuntime()
        throw error
      } finally {
        if (resumePromise && runtimeResumeByThread.get(sessionId) === resumePromise) {
          runtimeResumeByThread.delete(sessionId)
        }
      }
    })()
    runtimeResumeByThread.set(sessionId, resumePromise)
    return resumePromise
  }

  const releaseRuntime = async (sessionId: string) => {
    const runtime = runtimeByThread.get(sessionId)
    runtimeByThread.delete(sessionId)
    const threadIds = runtime ? threadIdsByRuntime.get(runtime) : undefined
    threadIds?.delete(sessionId)
    if (!runtime || !ownedRuntimes.has(runtime)) return
    if ((threadIds?.size ?? 0) > 0) return
    await runtime.shutdown?.()
    ownedRuntimes.delete(runtime)
    threadIdsByRuntime.delete(runtime)
  }

  return {
    runtimeProvider: 'codex',

    async create(input: FreshAgentCreateRequest) {
      const normalizedInput = normalizeCodexInput(input)
      toCodexReasoningEffort(normalizedInput.effort)
      const { runtime, owned } = allocateRuntime()
      let started: { threadId: string; wsUrl: string }
      try {
        started = await runtime.startThread({
          cwd: normalizedInput.cwd,
          model: normalizedInput.model,
          sandbox: normalizedInput.sandbox,
          approvalPolicy: toCodexApprovalPolicy(normalizedInput.permissionMode),
        })
      } catch (error) {
        if (owned) {
          ownedRuntimes.delete(runtime)
          await runtime.shutdown?.().catch(() => undefined)
        }
        throw error
      }
      rememberRuntimeThread(started.threadId, runtime)
      settingsByThread.set(started.threadId, normalizedInput)
      return { sessionId: started.threadId, sessionRef: { provider: 'codex', sessionId: started.threadId } }
    },

    async resume(input: FreshAgentCreateRequest) {
      if (!input.resumeSessionId) {
        throw new Error('Codex rich resume requires resumeSessionId')
      }
      const normalizedInput = normalizeCodexInput(input)
      toCodexReasoningEffort(normalizedInput.effort)
      const { runtime, owned } = allocateRuntime()
      let resumed: { threadId: string; wsUrl: string }
      try {
        resumed = await runtime.resumeThread({
          threadId: input.resumeSessionId,
          cwd: normalizedInput.cwd,
          model: normalizedInput.model,
          sandbox: normalizedInput.sandbox,
          approvalPolicy: toCodexApprovalPolicy(normalizedInput.permissionMode),
        })
      } catch (error) {
        if (owned) {
          ownedRuntimes.delete(runtime)
          await runtime.shutdown?.().catch(() => undefined)
        }
        throw error
      }
      rememberRuntimeThread(resumed.threadId, runtime)
      settingsByThread.set(resumed.threadId, normalizedInput)
      return { sessionId: resumed.threadId, sessionRef: { provider: 'codex', sessionId: resumed.threadId } }
    },

    async subscribe(sessionId, listener) {
      const runtime = await ensureRuntime(sessionId)
      if (!runtime.onThreadLifecycle) {
        throw new Error('Codex app-server runtime does not support thread lifecycle subscriptions.')
      }
      return runtime.onThreadLifecycle((event) => {
        if (event.kind === 'thread_started') {
          if (event.thread.id !== sessionId) return
          listener(makeCodexStatusEvent(sessionId, event.thread.status, event.thread.updatedAt))
          return
        }
        if (event.kind === 'thread_closed') {
          if (event.threadId !== sessionId) return
          activeTurnByThread.delete(sessionId)
          void releaseRuntime(sessionId).catch(() => undefined)
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
      const settings: Partial<FreshAgentCreateRequest> = {
        ...settingsByThread.get(sessionId),
        ...input.settings,
      }
      const model = normalizeFreshAgentModel(settings.sessionType ?? 'freshcodex', 'codex', settings.model)
      settings.model = model
      settings.effort = normalizeFreshAgentEffort(settings.sessionType ?? 'freshcodex', 'codex', model, settings.effort)
      const runtime = await ensureRuntime(sessionId, Object.keys(settings).length > 0 ? settings : undefined)
      if (Object.keys(settings).length > 0) {
        settingsByThread.set(sessionId, settings)
      }
      if (!runtime.startTurn) {
        throw new Error('Codex app-server runtime does not support turn/start.')
      }
      const turn = await runtime.startTurn({
        threadId: sessionId,
        input: toCodexUserInput(input.text, input.images),
        cwd: settings.cwd,
        approvalPolicy: toCodexApprovalPolicy(settings.permissionMode),
        sandboxPolicy: toCodexSandboxPolicy(settings.sandbox),
        model: settings.model,
        effort: toCodexReasoningEffort(settings.effort),
      })
      activeTurnByThread.set(sessionId, turn.turnId)
      if (settings.model) {
        const modelByTurn = modelByTurnByThread.get(sessionId) ?? new Map<string, string>()
        modelByTurn.set(turn.turnId, settings.model)
        modelByTurnByThread.set(sessionId, modelByTurn)
      }
    },

    async interrupt(sessionId) {
      const runtime = await ensureRuntime(sessionId, settingsByThread.get(sessionId))
      if (!runtime.interruptTurn) {
        throw new Error('Codex app-server runtime does not support turn/interrupt.')
      }
      let turnId = activeTurnByThread.get(sessionId)
      if (!turnId) {
        try {
          const rawSnapshot = await runtime.readThread({ threadId: sessionId, includeTurns: true })
          turnId = findActiveTurnId(rawSnapshot)
          if (turnId) {
            activeTurnByThread.set(sessionId, turnId)
          }
        } catch (error) {
          if (!isCodexIncludeTurnsUnavailable(error)) {
            throw error
          }
        }
      }
      if (!turnId) {
        throw new Error(`No active Codex turn is tracked for ${sessionId}.`)
      }
      await runtime.interruptTurn({ threadId: sessionId, turnId })
      activeTurnByThread.delete(sessionId)
    },

    async compact(sessionId, input) {
      const settings = settingsByThread.get(sessionId)
      const runtime = await ensureRuntime(sessionId, settings)
      if (runtime.compactThread) {
        await runtime.compactThread({ threadId: sessionId, instructions: input?.instructions })
        return
      }
      if (!runtime.startTurn) {
        throw new Error('Codex app-server runtime does not support thread compaction.')
      }
      const text = input?.instructions ? `/compact ${input.instructions}` : '/compact'
      const turn = await runtime.startTurn({
        threadId: sessionId,
        input: toCodexUserInput(text, undefined),
        cwd: settings?.cwd,
        approvalPolicy: toCodexApprovalPolicy(settings?.permissionMode),
        sandboxPolicy: toCodexSandboxPolicy(settings?.sandbox),
        model: settings?.model,
        effort: toCodexReasoningEffort(settings?.effort),
      })
      activeTurnByThread.set(sessionId, turn.turnId)
    },

    async fork(sessionId, input) {
      const settings = settingsByThread.get(sessionId)
      const runtime = await ensureRuntime(sessionId, settings)
      if (!runtime.forkThread) {
        throw new Error('Codex app-server runtime does not support thread/fork.')
      }
      const forked = await runtime.forkThread({
        threadId: sessionId,
        cwd: typeof input?.cwd === 'string' ? input.cwd : settings?.cwd,
        model: typeof input?.model === 'string' ? input.model : settings?.model,
        sandbox: typeof input?.sandbox === 'string' ? input.sandbox as FreshAgentCreateRequest['sandbox'] : settings?.sandbox,
        approvalPolicy: toCodexApprovalPolicy(
          typeof input?.permissionMode === 'string' ? input.permissionMode : settings?.permissionMode,
        ),
        excludeTurns: true,
      })
      if (forked && typeof forked.threadId === 'string') {
        rememberRuntimeThread(forked.threadId, runtime)
        settingsByThread.set(forked.threadId, {
          ...(settings ?? { requestId: '', sessionType: 'freshcodex' }),
          ...(typeof input?.cwd === 'string' ? { cwd: input.cwd } : {}),
          ...(typeof input?.model === 'string' ? { model: input.model } : {}),
          ...(typeof input?.sandbox === 'string' ? { sandbox: input.sandbox as FreshAgentCreateRequest['sandbox'] } : {}),
          ...(typeof input?.permissionMode === 'string' ? { permissionMode: input.permissionMode } : {}),
        })
      }
      return forked
    },

    async getSnapshot(thread, revision) {
      const runtime = await ensureRuntime(thread.threadId)
      let rawSnapshot: Record<string, any>
      try {
        rawSnapshot = await runtime.readThread({ threadId: thread.threadId, includeTurns: true })
      } catch (error) {
        if (!isCodexIncludeTurnsUnavailable(error)) {
          throw error
        }
        rawSnapshot = await runtime.readThread({ threadId: thread.threadId, includeTurns: false })
      }
      const rawThreadTurns: unknown[] = Array.isArray(rawSnapshot.thread?.turns)
        ? rawSnapshot.thread.turns
        : []
      const activeTurnId = findActiveTurnId(rawSnapshot)
      if (activeTurnId) {
        activeTurnByThread.set(thread.threadId, activeTurnId)
      } else if (normalizeCodexThreadStatus(rawSnapshot.thread?.status) !== 'running') {
        activeTurnByThread.delete(thread.threadId)
      }
      const rawTurns = rawThreadTurns
        .filter((turn): turn is Record<string, unknown> => !!turn && typeof turn === 'object' && !Array.isArray(turn))
        .map((turn, index) => normalizeCodexTurn(turn, index, {
          model: typeof turn.id === 'string'
            ? modelByTurnByThread.get(thread.threadId)?.get(turn.id)
            : undefined,
        }))
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
      const runtime = await ensureRuntime(thread.threadId)
      const rawPage = await runtime.listThreadTurns({
        threadId: thread.threadId,
        cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
        limit: typeof query.limit === 'number' ? query.limit : undefined,
        itemsView: 'full',
      })
      return normalizeCodexTurnPage({
        threadId: thread.threadId,
        revision: Number(rawPage.revision ?? query.revision ?? 0),
        rawPage,
        modelByTurn: modelByTurnByThread.get(thread.threadId),
      })
    },

    async getTurnBody(thread, revision) {
      const runtime = await ensureRuntime(thread.threadId)
      const rawTurn = await runtime.readThreadTurn({
        threadId: thread.threadId,
        turnId: thread.turnId,
        revision,
      })
      return normalizeCodexTurnBody({
        threadId: thread.threadId,
        revision,
        rawTurn,
        model: typeof rawTurn.id === 'string'
          ? modelByTurnByThread.get(thread.threadId)?.get(rawTurn.id)
          : undefined,
      })
    },

    async kill(sessionId) {
      activeTurnByThread.delete(sessionId)
      settingsByThread.delete(sessionId)
      runtimeResumeGenerationByThread.set(sessionId, (runtimeResumeGenerationByThread.get(sessionId) ?? 0) + 1)
      runtimeResumeByThread.delete(sessionId)
      modelByTurnByThread.delete(sessionId)
      await releaseRuntime(sessionId)
      return true
    },

    async shutdown() {
      const runtimes = [...ownedRuntimes]
      ownedRuntimes.clear()
      runtimeByThread.clear()
      threadIdsByRuntime.clear()
      runtimeResumeByThread.clear()
      runtimeResumeGenerationByThread.clear()
      activeTurnByThread.clear()
      settingsByThread.clear()
      modelByTurnByThread.clear()
      await Promise.all(runtimes.map((runtime) => runtime.shutdown?.()))
    },
  }
}

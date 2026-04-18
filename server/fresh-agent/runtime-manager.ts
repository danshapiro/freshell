import type { FreshAgentRuntimeProvider, FreshAgentSessionType } from '../../shared/fresh-agent.js'
import type { FreshAgentProviderRegistry } from './provider-registry.js'
import type { FreshAgentCreateRequest, FreshAgentCreateResult, FreshAgentRuntimeAdapter } from './runtime-adapter.js'

export class FreshAgentRuntimeUnavailableError extends Error {
  readonly code = 'FRESH_AGENT_RUNTIME_UNAVAILABLE' as const
}

export class FreshAgentStaleThreadRevisionError extends Error {
  readonly code = 'STALE_THREAD_REVISION' as const

  constructor(readonly currentRevision: number) {
    super('Fresh-agent thread revision is stale')
  }
}

export class FreshAgentUnsupportedCapabilityError extends Error {
  readonly code = 'FRESH_AGENT_UNSUPPORTED_CAPABILITY' as const
}

export class FreshAgentLostSessionError extends Error {
  readonly code = 'FRESH_AGENT_LOST_SESSION' as const
}

type FreshAgentRuntimeManagerOptions = {
  registry: FreshAgentProviderRegistry
}

type SessionRecord = {
  sessionType: FreshAgentSessionType
  runtimeProvider: FreshAgentRuntimeProvider
  adapter: FreshAgentRuntimeAdapter
}

export class FreshAgentRuntimeManager {
  private readonly sessions = new Map<string, SessionRecord>()

  constructor(private readonly options: FreshAgentRuntimeManagerOptions) {}

  async create(input: FreshAgentCreateRequest): Promise<FreshAgentCreateResult> {
    const registration = this.options.registry.resolveBySessionType(input.sessionType)
    if (!registration) {
      throw new FreshAgentRuntimeUnavailableError(`No fresh-agent adapter registered for ${input.sessionType}`)
    }

    const created = input.resumeSessionId && registration.adapter.resume
      ? await registration.adapter.resume(input)
      : await registration.adapter.create(input)
    this.sessions.set(created.sessionId, {
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
      adapter: registration.adapter,
    })
    return {
      sessionId: created.sessionId,
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
    }
  }

  attach(input: { sessionId: string; sessionType: FreshAgentSessionType }): FreshAgentCreateResult {
    const registration = this.options.registry.resolveBySessionType(input.sessionType)
    if (!registration) {
      throw new FreshAgentRuntimeUnavailableError(`No fresh-agent adapter registered for ${input.sessionType}`)
    }

    this.sessions.set(input.sessionId, {
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
      adapter: registration.adapter,
    })

    return {
      sessionId: input.sessionId,
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
    }
  }

  async resume(input: FreshAgentCreateRequest): Promise<FreshAgentCreateResult> {
    const registration = this.options.registry.resolveBySessionType(input.sessionType)
    if (!registration) {
      throw new FreshAgentRuntimeUnavailableError(`No fresh-agent adapter registered for ${input.sessionType}`)
    }
    if (!registration.adapter.resume) {
      throw new FreshAgentUnsupportedCapabilityError(`Resume is not supported for ${input.sessionType}`)
    }
    const resumed = await registration.adapter.resume(input)
    this.sessions.set(resumed.sessionId, {
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
      adapter: registration.adapter,
    })
    return {
      sessionId: resumed.sessionId,
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
    }
  }

  async subscribe(sessionId: string, listener: (message: unknown) => void) {
    const record = this.requireSession(sessionId)
    if (!record.adapter.subscribe) {
      throw new FreshAgentUnsupportedCapabilityError(`Subscribe is not supported for ${record.sessionType}`)
    }
    return await record.adapter.subscribe(sessionId, listener)
  }

  async send(sessionId: string, input: { text: string; images?: Array<{ mediaType: string; data: string }> }) {
    const record = this.requireSession(sessionId)
    if (!record.adapter.send) {
      throw new FreshAgentUnsupportedCapabilityError(`Send is not supported for ${record.sessionType}`)
    }
    await record.adapter.send(sessionId, input)
  }

  async interrupt(sessionId: string) {
    const record = this.requireSession(sessionId)
    if (!record.adapter.interrupt) {
      throw new FreshAgentUnsupportedCapabilityError(`Interrupt is not supported for ${record.sessionType}`)
    }
    await record.adapter.interrupt(sessionId)
  }

  async kill(sessionId: string): Promise<boolean> {
    const record = this.requireSession(sessionId)
    try {
      if (record.adapter.kill) {
        return await record.adapter.kill(sessionId)
      }
      return true
    } finally {
      this.sessions.delete(sessionId)
    }
  }

  async fork(sessionId: string, input?: Record<string, unknown>) {
    const record = this.requireSession(sessionId)
    if (!record.adapter.fork) {
      throw new FreshAgentUnsupportedCapabilityError(`Fork is not supported for ${record.sessionType}`)
    }
    return await record.adapter.fork(sessionId, input)
  }

  async answerQuestion(sessionId: string, requestId: string, answers: Record<string, string>) {
    const record = this.requireSession(sessionId)
    if (!record.adapter.answerQuestion) {
      throw new FreshAgentUnsupportedCapabilityError(`Questions are not supported for ${record.sessionType}`)
    }
    await record.adapter.answerQuestion(sessionId, requestId, answers)
  }

  async resolveApproval(sessionId: string, requestId: string, decision: Record<string, unknown>) {
    const record = this.requireSession(sessionId)
    if (!record.adapter.resolveApproval) {
      throw new FreshAgentUnsupportedCapabilityError(`Approvals are not supported for ${record.sessionType}`)
    }
    await record.adapter.resolveApproval(sessionId, requestId, decision)
  }

  async getSnapshot(input: { provider: FreshAgentRuntimeProvider; threadId: string; revision?: number }) {
    const registration = this.options.registry.resolveByRuntimeProvider(input.provider)
    if (!registration?.adapter.getSnapshot) {
      throw new FreshAgentRuntimeUnavailableError(`No fresh-agent snapshot adapter registered for ${input.provider}`)
    }
    return await registration.adapter.getSnapshot({ provider: input.provider, threadId: input.threadId }, input.revision)
  }

  async getTurnPage(input: {
    provider: FreshAgentRuntimeProvider
    threadId: string
    cursor?: string
    priority?: string
    revision: number
    limit?: number
    includeBodies?: boolean
  }) {
    const registration = this.options.registry.resolveByRuntimeProvider(input.provider)
    if (!registration?.adapter.getTurnPage) {
      throw new FreshAgentRuntimeUnavailableError(`No fresh-agent turn-page adapter registered for ${input.provider}`)
    }
    return await registration.adapter.getTurnPage(
      { provider: input.provider, threadId: input.threadId },
      input,
    )
  }

  async getTurnBody(input: {
    provider: FreshAgentRuntimeProvider
    threadId: string
    turnId: string
    revision: number
  }) {
    const registration = this.options.registry.resolveByRuntimeProvider(input.provider)
    if (!registration?.adapter.getTurnBody) {
      throw new FreshAgentRuntimeUnavailableError(`No fresh-agent turn-body adapter registered for ${input.provider}`)
    }
    return await registration.adapter.getTurnBody(
      { provider: input.provider, threadId: input.threadId, turnId: input.turnId },
      input.revision,
    )
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessions.get(sessionId)
    if (!record) {
      throw new FreshAgentLostSessionError(`Fresh-agent session ${sessionId} is not tracked`)
    }
    return record
  }
}

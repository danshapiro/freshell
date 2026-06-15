import {
  makeFreshAgentSessionKey,
  type FreshAgentRuntimeProvider,
  type FreshAgentSessionType,
} from '../../shared/fresh-agent.js'
import {
  FreshAgentSnapshotSchema,
  FreshAgentTurnBodySchema,
  FreshAgentTurnPageSchema,
  type FreshAgentRequestId,
} from '../../shared/fresh-agent-contract.js'
import type { FreshAgentProviderRegistry } from './provider-registry.js'
import type {
  FreshAgentCreateRequest,
  FreshAgentCreateResult,
  FreshAgentInputImage,
  FreshAgentRuntimeAdapter,
  FreshAgentSendResult,
  FreshAgentSessionLocator,
} from './runtime-adapter.js'

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

export class FreshAgentSessionLocatorMismatchError extends Error {
  readonly code = 'FRESH_AGENT_SESSION_LOCATOR_MISMATCH' as const
}

export class FreshAgentContractValidationError extends Error {
  readonly code = 'FRESH_AGENT_CONTRACT_INVALID' as const

  constructor(readonly surface: 'snapshot' | 'turn-page' | 'turn-body', readonly details: unknown) {
    super(`Fresh-agent ${surface} did not match the shared contract`)
  }
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
    const registration = this.requireRegistration(input.sessionType, input.provider)
    const resumeSessionId = input.resumeSessionId
      ?? (input.sessionRef?.provider === registration.runtimeProvider ? input.sessionRef.sessionId : undefined)
    const createInput = resumeSessionId ? { ...input, resumeSessionId } : input

    const created = resumeSessionId && registration.adapter.resume
      ? await registration.adapter.resume(createInput)
      : await registration.adapter.create(createInput)
    this.sessions.set(this.key({
      sessionType: input.sessionType,
      provider: registration.runtimeProvider,
      sessionId: created.sessionId,
    }), {
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
      adapter: registration.adapter,
    })
    return {
      sessionId: created.sessionId,
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
      sessionRef: created.sessionRef,
    }
  }

  async attach(input: FreshAgentSessionLocator): Promise<FreshAgentCreateResult> {
    const registration = this.requireRegistration(input.sessionType, input.provider)
    const attached = registration.adapter.attach
      ? await registration.adapter.attach(input)
      : { sessionId: input.sessionId }
    const sessionId = attached.sessionId

    this.sessions.set(this.key({ ...input, sessionId }), {
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
      adapter: registration.adapter,
    })

    return {
      sessionId,
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
      sessionRef: attached.sessionRef,
    }
  }

  async resume(input: FreshAgentCreateRequest): Promise<FreshAgentCreateResult> {
    const registration = this.requireRegistration(input.sessionType, input.provider)
    if (!registration.adapter.resume) {
      throw new FreshAgentUnsupportedCapabilityError(`Resume is not supported for ${input.sessionType}`)
    }
    const resumed = await registration.adapter.resume(input)
    this.sessions.set(this.key({
      sessionType: input.sessionType,
      provider: registration.runtimeProvider,
      sessionId: resumed.sessionId,
    }), {
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
      adapter: registration.adapter,
    })
    return {
      sessionId: resumed.sessionId,
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
      sessionRef: resumed.sessionRef,
    }
  }

  async subscribe(locator: FreshAgentSessionLocator, listener: (message: unknown) => void) {
    const record = this.requireSession(locator)
    if (!record.adapter.subscribe) {
      throw new FreshAgentUnsupportedCapabilityError(`Subscribe is not supported for ${record.sessionType}`)
    }
    return await record.adapter.subscribe(locator.sessionId, listener)
  }

  async send(
    locator: FreshAgentSessionLocator,
    input: { text: string; images?: FreshAgentInputImage[]; settings?: FreshAgentCreateRequest },
  ): Promise<FreshAgentSendResult> {
    const record = this.requireSession(locator)
    if (!record.adapter.send) {
      throw new FreshAgentUnsupportedCapabilityError(`Send is not supported for ${record.sessionType}`)
    }
    const result = await record.adapter.send(locator.sessionId, input)
    if (result?.sessionId && result.sessionId !== locator.sessionId) {
      this.sessions.set(this.key({
        sessionType: locator.sessionType,
        provider: record.runtimeProvider,
        sessionId: result.sessionId,
      }), record)
    }
    return result
  }

  async interrupt(locator: FreshAgentSessionLocator) {
    const record = this.requireSession(locator)
    if (!record.adapter.interrupt) {
      throw new FreshAgentUnsupportedCapabilityError(`Interrupt is not supported for ${record.sessionType}`)
    }
    await record.adapter.interrupt(locator.sessionId)
  }

  async compact(locator: FreshAgentSessionLocator, input?: { instructions?: string }) {
    const record = this.requireSession(locator)
    if (!record.adapter.compact) {
      throw new FreshAgentUnsupportedCapabilityError(`Compact is not supported for ${record.sessionType}`)
    }
    await record.adapter.compact(locator.sessionId, input)
  }

  async kill(locator: FreshAgentSessionLocator): Promise<boolean> {
    const record = this.requireSession(locator)
    try {
      if (record.adapter.kill) {
        return await record.adapter.kill(locator.sessionId)
      }
      return true
    } finally {
      this.sessions.delete(this.key(locator))
    }
  }

  async fork(locator: FreshAgentSessionLocator, input?: Record<string, unknown>) {
    const record = this.requireSession(locator)
    if (!record.adapter.fork) {
      throw new FreshAgentUnsupportedCapabilityError(`Fork is not supported for ${record.sessionType}`)
    }
    const forked = await record.adapter.fork(locator.sessionId, input)
    const forkedRecord = forked && typeof forked === 'object' && !Array.isArray(forked)
      ? forked as { sessionId?: unknown; threadId?: unknown }
      : undefined
    const childSessionId = typeof forkedRecord?.sessionId === 'string'
      ? forkedRecord.sessionId
      : typeof forkedRecord?.threadId === 'string'
        ? forkedRecord.threadId
        : undefined
    if (childSessionId) {
      this.sessions.set(this.key({
        sessionType: locator.sessionType,
        provider: record.runtimeProvider,
        sessionId: childSessionId,
      }), record)
    }
    return forked
  }

  async answerQuestion(locator: FreshAgentSessionLocator, requestId: FreshAgentRequestId, answers: Record<string, string>) {
    const record = this.requireSession(locator)
    if (!record.adapter.answerQuestion) {
      throw new FreshAgentUnsupportedCapabilityError(`Questions are not supported for ${record.sessionType}`)
    }
    await record.adapter.answerQuestion(locator.sessionId, requestId, answers)
  }

  async resolveApproval(locator: FreshAgentSessionLocator, requestId: FreshAgentRequestId, decision: Record<string, unknown>) {
    const record = this.requireSession(locator)
    if (!record.adapter.resolveApproval) {
      throw new FreshAgentUnsupportedCapabilityError(`Approvals are not supported for ${record.sessionType}`)
    }
    await record.adapter.resolveApproval(locator.sessionId, requestId, decision)
  }

  async getSnapshot(input: {
    sessionType: FreshAgentSessionType
    provider: FreshAgentRuntimeProvider
    threadId: string
    revision?: number
  }) {
    const registration = this.requireRegistration(input.sessionType, input.provider)
    if (!registration?.adapter.getSnapshot) {
      throw new FreshAgentRuntimeUnavailableError(`No fresh-agent snapshot adapter registered for ${input.sessionType}`)
    }
    const snapshot = await registration.adapter.getSnapshot({
      sessionType: input.sessionType,
      provider: input.provider,
      threadId: input.threadId,
    }, input.revision)
    const parsed = FreshAgentSnapshotSchema.safeParse(snapshot)
    if (!parsed.success) {
      throw new FreshAgentContractValidationError('snapshot', parsed.error.issues)
    }
    return parsed.data
  }

  async getTurnPage(input: {
    sessionType: FreshAgentSessionType
    provider: FreshAgentRuntimeProvider
    threadId: string
    cursor?: string
    priority?: string
    revision: number
    limit?: number
    includeBodies?: boolean
  }) {
    const registration = this.requireRegistration(input.sessionType, input.provider)
    if (!registration?.adapter.getTurnPage) {
      throw new FreshAgentRuntimeUnavailableError(`No fresh-agent turn-page adapter registered for ${input.sessionType}`)
    }
    const page = await registration.adapter.getTurnPage(
      { sessionType: input.sessionType, provider: input.provider, threadId: input.threadId },
      input,
    )
    const parsed = FreshAgentTurnPageSchema.safeParse(page)
    if (!parsed.success) {
      throw new FreshAgentContractValidationError('turn-page', parsed.error.issues)
    }
    return parsed.data
  }

  async getTurnBody(input: {
    sessionType: FreshAgentSessionType
    provider: FreshAgentRuntimeProvider
    threadId: string
    turnId: string
    revision: number
  }) {
    const registration = this.requireRegistration(input.sessionType, input.provider)
    if (!registration?.adapter.getTurnBody) {
      throw new FreshAgentRuntimeUnavailableError(`No fresh-agent turn-body adapter registered for ${input.sessionType}`)
    }
    const body = await registration.adapter.getTurnBody(
      {
        sessionType: input.sessionType,
        provider: input.provider,
        threadId: input.threadId,
        turnId: input.turnId,
      },
      input.revision,
    )
    if (body == null) {
      return null
    }
    const parsed = FreshAgentTurnBodySchema.safeParse(body)
    if (!parsed.success) {
      throw new FreshAgentContractValidationError('turn-body', parsed.error.issues)
    }
    return parsed.data
  }

  private requireRegistration(sessionType: FreshAgentSessionType, provider?: FreshAgentRuntimeProvider) {
    const registration = this.options.registry.resolveBySessionType(sessionType)
    if (!registration) {
      throw new FreshAgentRuntimeUnavailableError(`No fresh-agent adapter registered for ${sessionType}`)
    }
    if (provider && registration.runtimeProvider !== provider) {
      throw new FreshAgentSessionLocatorMismatchError(
        `Fresh-agent session type ${sessionType} uses ${registration.runtimeProvider}, not ${provider}`,
      )
    }
    return registration
  }

  private key(locator: FreshAgentSessionLocator): string {
    return makeFreshAgentSessionKey(locator)
  }

  private requireSession(locator: FreshAgentSessionLocator): SessionRecord {
    const record = this.sessions.get(this.key(locator))
    if (!record) {
      throw new FreshAgentLostSessionError(
        `Fresh-agent session ${locator.sessionType}/${locator.provider}/${locator.sessionId} is not tracked`,
      )
    }
    if (record.sessionType !== locator.sessionType || record.runtimeProvider !== locator.provider) {
      throw new FreshAgentSessionLocatorMismatchError(
        `Fresh-agent session ${locator.sessionId} is tracked as ${record.sessionType}/${record.runtimeProvider}, not ${locator.sessionType}/${locator.provider}`,
      )
    }
    return record
  }
}

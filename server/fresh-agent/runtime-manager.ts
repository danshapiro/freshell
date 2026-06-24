import {
  randomUUID,
} from 'node:crypto'
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

export class FreshAgentUnprovableThreadRevisionError extends Error {
  readonly code = 'UNPROVABLE_THREAD_REVISION' as const

  constructor(readonly requestedRevision: number) {
    super('Fresh-agent thread revision could not be proven from the current provider body')
  }
}

export class FreshAgentUnsupportedCapabilityError extends Error {
  readonly code = 'FRESH_AGENT_UNSUPPORTED_CAPABILITY' as const
}

export class FreshAgentInvalidDisplayIdError extends Error {
  readonly code = 'INVALID_DISPLAY_ID' as const
}

export class FreshAgentInvalidTurnCursorError extends Error {
  readonly code = 'INVALID_TURN_CURSOR' as const
}

export class FreshAgentTurnNotFoundError extends Error {
  readonly code = 'TURN_NOT_FOUND' as const
}

export class FreshAgentAmbiguousTurnBodyError extends FreshAgentUnsupportedCapabilityError {
  readonly ambiguousCode = 'AMBIGUOUS_NATIVE_TURN_ID' as const
}

export class FreshAgentLostSessionError extends Error {
  readonly code = 'FRESH_AGENT_LOST_SESSION' as const
  constructor(message?: string) {
    super(message)
    this.name = 'FreshAgentLostSessionError'
  }
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
  freshOpenCodeRouteCwd?: string
  freshOpenCodeProviderOwnedNoRoute?: boolean
}

export class FreshAgentRuntimeManager {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly freshOpencodeRecoveries = new Map<string, { cwd: string; promise: Promise<SessionRecord> }>()

  constructor(private readonly options: FreshAgentRuntimeManagerOptions) {}

  async create(input: FreshAgentCreateRequest): Promise<FreshAgentCreateResult> {
    const registration = this.requireRegistration(input.sessionType, input.provider)
    const resumeSessionId = input.resumeSessionId
      ?? (input.sessionRef?.provider === registration.runtimeProvider ? input.sessionRef.sessionId : undefined)
    const createInput = resumeSessionId ? { ...input, resumeSessionId } : input

    const usedResume = Boolean(resumeSessionId && registration.adapter.resume)
    const created = usedResume
      ? await registration.adapter.resume!(createInput)
      : await registration.adapter.create(createInput)
    this.sessions.set(this.key({
      sessionType: input.sessionType,
      provider: registration.runtimeProvider,
      sessionId: created.sessionId,
    }), this.recordForSession({
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
      adapter: registration.adapter,
      sessionId: created.sessionId,
      cwd: input.cwd,
      providerOwned: !usedResume,
    }))
    return {
      sessionId: created.sessionId,
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
      sessionRef: created.sessionRef,
    }
  }

  async attach(input: FreshAgentSessionLocator): Promise<FreshAgentCreateResult> {
    const registration = this.requireRegistration(input.sessionType, input.provider)
    const key = this.key(input)
    const existing = this.sessions.get(key)
    if (existing) {
      if (existing.sessionType !== input.sessionType || existing.runtimeProvider !== registration.runtimeProvider) {
        throw new FreshAgentSessionLocatorMismatchError(
          `Fresh-agent session ${input.sessionId} is tracked as ${existing.sessionType}/${existing.runtimeProvider}, not ${input.sessionType}/${registration.runtimeProvider}`,
        )
      }
      const cwd = this.routeCwd(input)
      if (this.isDurableFreshOpenCode({
        sessionType: input.sessionType,
        provider: registration.runtimeProvider,
        sessionId: input.sessionId,
      }) && cwd && existing.freshOpenCodeRouteCwd && existing.freshOpenCodeRouteCwd !== cwd) {
        throw new FreshAgentSessionLocatorMismatchError(
          `Fresh-agent session ${input.sessionId} is tracked for ${existing.freshOpenCodeRouteCwd}, not ${cwd}`,
        )
      }
    }
    const attached = registration.adapter.attach
      ? await registration.adapter.attach(input)
      : { sessionId: input.sessionId }
    const sessionId = attached.sessionId
    const attachedKey = this.key({ ...input, sessionId })

    if (existing && attachedKey === key && !this.routeCwd(input)) {
      this.sessions.set(attachedKey, existing)
    } else {
      this.sessions.set(attachedKey, this.recordForSession({
        sessionType: input.sessionType,
        runtimeProvider: registration.runtimeProvider,
        adapter: registration.adapter,
        sessionId,
        cwd: input.cwd,
        providerOwned: false,
      }))
    }

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
    }), this.recordForSession({
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
      adapter: registration.adapter,
      sessionId: resumed.sessionId,
      cwd: input.cwd,
      providerOwned: false,
    }))
    return {
      sessionId: resumed.sessionId,
      sessionType: input.sessionType,
      runtimeProvider: registration.runtimeProvider,
      sessionRef: resumed.sessionRef,
    }
  }

  async subscribe(locator: FreshAgentSessionLocator, listener: (message: unknown) => void) {
    const record = await this.requireOrRecoverSession(locator)
    if (!record.adapter.subscribe) {
      throw new FreshAgentUnsupportedCapabilityError(`Subscribe is not supported for ${record.sessionType}`)
    }
    return await record.adapter.subscribe(locator.sessionId, listener)
  }

  async send(
    locator: FreshAgentSessionLocator,
    input: { requestId?: string; text: string; images?: FreshAgentInputImage[]; settings?: FreshAgentCreateRequest },
  ): Promise<FreshAgentSendResult> {
    const record = await this.requireOrRecoverSession(locator)
    if (!record.adapter.send) {
      throw new FreshAgentUnsupportedCapabilityError(`Send is not supported for ${record.sessionType}`)
    }
    const requestId = input.requestId ?? randomUUID()
    const { requestId: _requestId, ...adapterInput } = input
    Object.defineProperty(adapterInput, 'requestId', {
      value: requestId,
      enumerable: false,
      configurable: true,
    })
    const result = await record.adapter.send(locator.sessionId, adapterInput)
    if (result?.sessionId && result.sessionId !== locator.sessionId) {
      this.sessions.set(this.key({
        sessionType: locator.sessionType,
        provider: record.runtimeProvider,
        sessionId: result.sessionId,
      }), this.recordForSession({
        sessionType: record.sessionType,
        runtimeProvider: record.runtimeProvider,
        adapter: record.adapter,
        sessionId: result.sessionId,
        cwd: this.routeCwd(locator) ?? this.routeCwd(input.settings) ?? record.freshOpenCodeRouteCwd,
        providerOwned: true,
      }))
    }
    if (result?.requestId) {
      return result
    }
    const wrappedResult = { ...(result ?? {}) } as Exclude<FreshAgentSendResult, void>
    Object.defineProperty(wrappedResult, 'requestId', {
      value: requestId,
      enumerable: result == null,
      configurable: true,
    })
    return wrappedResult
  }

  async interrupt(locator: FreshAgentSessionLocator) {
    const record = await this.requireOrRecoverSession(locator)
    if (!record.adapter.interrupt) {
      throw new FreshAgentUnsupportedCapabilityError(`Interrupt is not supported for ${record.sessionType}`)
    }
    await record.adapter.interrupt(locator.sessionId)
  }

  async compact(locator: FreshAgentSessionLocator, input?: { instructions?: string }) {
    const record = await this.requireOrRecoverSession(locator)
    if (!record.adapter.compact) {
      throw new FreshAgentUnsupportedCapabilityError(`Compact is not supported for ${record.sessionType}`)
    }
    await record.adapter.compact(locator.sessionId, input)
  }

  async kill(locator: FreshAgentSessionLocator): Promise<boolean> {
    const record = await this.requireOrRecoverSession(locator)
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
    const record = await this.requireOrRecoverSession(locator)
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
      }), this.recordForSession({
        sessionType: record.sessionType,
        runtimeProvider: record.runtimeProvider,
        adapter: record.adapter,
        sessionId: childSessionId,
        providerOwned: true,
      }))
    }
    return forked
  }

  async answerQuestion(locator: FreshAgentSessionLocator, requestId: FreshAgentRequestId, answers: Record<string, string>) {
    const record = await this.requireOrRecoverSession(locator)
    if (!record.adapter.answerQuestion) {
      throw new FreshAgentUnsupportedCapabilityError(`Questions are not supported for ${record.sessionType}`)
    }
    await record.adapter.answerQuestion(locator.sessionId, requestId, answers)
  }

  async resolveApproval(locator: FreshAgentSessionLocator, requestId: FreshAgentRequestId, decision: Record<string, unknown>) {
    const record = await this.requireOrRecoverSession(locator)
    if (!record.adapter.resolveApproval) {
      throw new FreshAgentUnsupportedCapabilityError(`Approvals are not supported for ${record.sessionType}`)
    }
    await record.adapter.resolveApproval(locator.sessionId, requestId, decision)
  }

  async getSnapshot(input: {
    sessionType: FreshAgentSessionType
    provider: FreshAgentRuntimeProvider
    threadId: string
    cwd?: string
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
      cwd: input.cwd,
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
    cwd?: string
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
      { sessionType: input.sessionType, provider: input.provider, threadId: input.threadId, cwd: input.cwd },
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
    cwd?: string
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
        cwd: input.cwd,
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

  private canRecoverFreshOpenCode(
    locator: FreshAgentSessionLocator,
  ): locator is FreshAgentSessionLocator & { cwd: string } {
    return locator.sessionType === 'freshopencode'
      && locator.provider === 'opencode'
      && locator.sessionId.startsWith('ses_')
      && this.routeCwd(locator) !== undefined
  }

  private isDurableFreshOpenCode(locator: Pick<FreshAgentSessionLocator, 'sessionId' | 'sessionType' | 'provider'>): boolean {
    return locator.sessionType === 'freshopencode'
      && locator.provider === 'opencode'
      && locator.sessionId.startsWith('ses_')
  }

  private routeCwd(input?: { cwd?: string }): string | undefined {
    return typeof input?.cwd === 'string' && input.cwd.trim().length > 0 ? input.cwd : undefined
  }

  private recordForSession(input: {
    sessionType: FreshAgentSessionType
    runtimeProvider: FreshAgentRuntimeProvider
    adapter: FreshAgentRuntimeAdapter
    sessionId: string
    cwd?: string
    providerOwned: boolean
  }): SessionRecord {
    const base: SessionRecord = {
      sessionType: input.sessionType,
      runtimeProvider: input.runtimeProvider,
      adapter: input.adapter,
    }
    const provider = input.runtimeProvider
    const locator = { sessionType: input.sessionType, provider, sessionId: input.sessionId }
    if (!this.isDurableFreshOpenCode(locator)) return base
    const cwd = this.routeCwd(input)
    if (cwd) return { ...base, freshOpenCodeRouteCwd: cwd }
    return input.providerOwned ? { ...base, freshOpenCodeProviderOwnedNoRoute: true } : base
  }

  private async requireOrRecoverSession(locator: FreshAgentSessionLocator): Promise<SessionRecord> {
    const key = this.key(locator)
    const existing = this.sessions.get(key)
    if (existing) {
      if (existing.sessionType !== locator.sessionType || existing.runtimeProvider !== locator.provider) {
        throw new FreshAgentSessionLocatorMismatchError(
          `Fresh-agent session ${locator.sessionId} is tracked as ${existing.sessionType}/${existing.runtimeProvider}, not ${locator.sessionType}/${locator.provider}`,
        )
      }
      if (this.canRecoverFreshOpenCode(locator)) {
        if (existing.freshOpenCodeRouteCwd && existing.freshOpenCodeRouteCwd !== locator.cwd) {
          throw new FreshAgentSessionLocatorMismatchError(
            `Fresh-agent session ${locator.sessionId} is tracked for ${existing.freshOpenCodeRouteCwd}, not ${locator.cwd}`,
          )
        }
        if (!existing.freshOpenCodeRouteCwd) {
          if (!existing.adapter.attach) {
            return existing
          }
          return await this.singleflightFreshOpenCodeAttach(locator, existing)
        }
      } else if (this.isDurableFreshOpenCode(locator)
        && !existing.freshOpenCodeProviderOwnedNoRoute) {
        throw new FreshAgentLostSessionError(
          `Fresh-agent session ${locator.sessionType}/${locator.provider}/${locator.sessionId} requires a cwd before mutation`,
        )
      }
      return existing
    }
    if (!this.canRecoverFreshOpenCode(locator)) {
      return this.requireSession(locator)
    }
    const registration = this.requireRegistration(locator.sessionType, locator.provider)
    if (!registration.adapter.attach) {
      return this.requireSession(locator)
    }
    return await this.singleflightFreshOpenCodeAttach(locator)
  }

  private async singleflightFreshOpenCodeAttach(
    locator: FreshAgentSessionLocator & { cwd: string },
    existingRecord?: SessionRecord,
  ): Promise<SessionRecord> {
    const key = this.key(locator)
    const pending = this.freshOpencodeRecoveries.get(key)
    if (pending) {
      if (pending.cwd !== locator.cwd) {
        throw new FreshAgentSessionLocatorMismatchError(
          `Fresh-agent session ${locator.sessionId} is already being recovered for ${pending.cwd}, not ${locator.cwd}`,
        )
      }
      return await pending.promise
    }

    const record: SessionRecord = existingRecord ?? (() => {
      const registration = this.requireRegistration(locator.sessionType, locator.provider)
      return {
        sessionType: locator.sessionType,
        runtimeProvider: registration.runtimeProvider,
        adapter: registration.adapter,
      }
    })()
    if (!record.adapter.attach) {
      return record
    }

    const promise = Promise.resolve(record.adapter.attach(locator)).then(() => {
      record.freshOpenCodeRouteCwd = locator.cwd
      record.freshOpenCodeProviderOwnedNoRoute = false
      this.sessions.set(key, record)
      return record
    })
    this.freshOpencodeRecoveries.set(key, { cwd: locator.cwd, promise })
    try {
      return await promise
    } finally {
      if (this.freshOpencodeRecoveries.get(key)?.promise === promise) {
        this.freshOpencodeRecoveries.delete(key)
      }
    }
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

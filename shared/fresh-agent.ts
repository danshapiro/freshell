import {
  buildRestoreError,
  isCanonicalClaudeSessionId,
  sanitizeSessionRef,
  type RestoreError,
  type SessionRef,
} from './session-contract.js'

export type FreshAgentSessionType = 'freshclaude' | 'freshcodex' | 'kilroy' | 'freshopencode'

export type FreshAgentRuntimeProvider = 'claude' | 'codex' | 'opencode'

export type FreshAgentThreadIdentity = {
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  threadId: string
}

export type FreshAgentSessionIdentity = Omit<FreshAgentThreadIdentity, 'threadId'> & {
  sessionId: string
}

export type FreshAgentCompatibilityShape = {
  kind?: unknown
  provider?: unknown
  sessionType?: unknown
  sessionId?: unknown
  createRequestId?: unknown
  status?: unknown
  resumeSessionId?: unknown
  timelineSessionId?: unknown
  cliSessionId?: unknown
  sessionRef?: unknown
  serverInstanceId?: unknown
  restoreError?: unknown
  initialCwd?: unknown
  createError?: unknown
  modelSelection?: unknown
  model?: unknown
  permissionMode?: unknown
  sandbox?: unknown
  effort?: unknown
  plugins?: unknown
  style?: unknown
  settingsDismissed?: unknown
  showThinking?: unknown
  showTools?: unknown
  showTimecodes?: unknown
}

export type FreshAgentDescriptor = {
  sessionType: FreshAgentSessionType
  runtimeProvider: FreshAgentRuntimeProvider
  label: string
  hidden?: boolean
  disabled?: boolean
}

type MigratedFreshAgentContent<T extends FreshAgentCompatibilityShape> =
  Omit<T, 'kind' | 'provider' | 'sessionRef' | 'resumeSessionId' | 'timelineSessionId' | 'cliSessionId' | 'restoreError'> & {
    kind: 'fresh-agent'
    provider: FreshAgentRuntimeProvider
    sessionType: FreshAgentSessionType
    resumeSessionId?: string
    sessionRef?: SessionRef
    restoreError?: RestoreError
  }

const RESTORE_ERROR_REASONS = new Set<RestoreError['reason']>([
  'missing_canonical_identity',
  'invalid_legacy_restore_target',
  'dead_live_handle',
  'provider_runtime_failed',
  'durable_artifact_missing',
])

export const FRESH_AGENT_DESCRIPTORS: readonly FreshAgentDescriptor[] = [
  {
    sessionType: 'freshclaude',
    runtimeProvider: 'claude',
    label: 'Freshclaude',
  },
  {
    sessionType: 'freshcodex',
    runtimeProvider: 'codex',
    label: 'Freshcodex',
  },
  {
    sessionType: 'kilroy',
    runtimeProvider: 'claude',
    label: 'Kilroy',
    hidden: true,
  },
  {
    sessionType: 'freshopencode',
    runtimeProvider: 'opencode',
    label: 'Freshopencode',
  },
] as const

const FRESH_AGENT_DESCRIPTOR_BY_SESSION_TYPE = new Map(
  FRESH_AGENT_DESCRIPTORS.map((descriptor) => [descriptor.sessionType, descriptor]),
)

export function isFreshAgentSessionType(value: unknown): value is FreshAgentSessionType {
  return typeof value === 'string' && FRESH_AGENT_DESCRIPTOR_BY_SESSION_TYPE.has(value as FreshAgentSessionType)
}

export function getFreshAgentDescriptor(
  sessionType: string | undefined,
): FreshAgentDescriptor | undefined {
  if (!sessionType) return undefined
  return FRESH_AGENT_DESCRIPTOR_BY_SESSION_TYPE.get(sessionType as FreshAgentSessionType)
}

export function resolveFreshAgentRuntimeProvider(
  sessionType: string | undefined,
): FreshAgentRuntimeProvider | undefined {
  return getFreshAgentDescriptor(sessionType)?.runtimeProvider
}

export function makeFreshAgentThreadKey(identity: FreshAgentThreadIdentity): string {
  return `${identity.sessionType}:${identity.provider}:${identity.threadId}`
}

export function makeFreshAgentSessionKey(identity: FreshAgentSessionIdentity): string {
  return makeFreshAgentThreadKey({
    sessionType: identity.sessionType,
    provider: identity.provider,
    threadId: identity.sessionId,
  })
}

export function normalizeFreshAgentSessionType(
  value: unknown,
): FreshAgentSessionType | undefined {
  return isFreshAgentSessionType(value) ? value : undefined
}

export function migrateLegacyFreshAgentDurableState({
  provider,
  sessionRef,
  resumeSessionId,
  rejectNonCanonicalClaudeSessionRef = false,
}: {
  provider?: FreshAgentRuntimeProvider
  sessionRef?: unknown
  resumeSessionId?: string
  rejectNonCanonicalClaudeSessionRef?: boolean
}): {
  sessionRef?: SessionRef
  restoreError?: RestoreError
} {
  const explicitSessionRef = sanitizeSessionRef(sessionRef)
  if (explicitSessionRef) {
    if (
      rejectNonCanonicalClaudeSessionRef
      && explicitSessionRef.provider === 'claude'
      && !isCanonicalClaudeSessionId(explicitSessionRef.sessionId)
    ) {
      return { restoreError: buildRestoreError('invalid_legacy_restore_target') }
    }
    return { sessionRef: explicitSessionRef }
  }

  if (!provider || !resumeSessionId) {
    return {}
  }

  if (provider === 'claude') {
    if (isCanonicalClaudeSessionId(resumeSessionId)) {
      return {
        sessionRef: {
          provider,
          sessionId: resumeSessionId,
        },
      }
    }
    return { restoreError: buildRestoreError('invalid_legacy_restore_target') }
  }

  return {
    sessionRef: {
      provider,
      sessionId: resumeSessionId,
    },
  }
}

function readRestoreError(value: unknown): RestoreError | undefined {
  if (!isRecord(value)) return undefined
  return value.code === 'RESTORE_UNAVAILABLE'
    && typeof value.reason === 'string'
    && RESTORE_ERROR_REASONS.has(value.reason as RestoreError['reason'])
    ? buildRestoreError(value.reason as RestoreError['reason'])
    : undefined
}

export function migrateLegacyFreshAgentContent<T extends FreshAgentCompatibilityShape>(
  input: T,
): T | MigratedFreshAgentContent<T> {
  if (!input || typeof input !== 'object') {
    return input
  }

  if (input.kind === 'fresh-agent') {
    const sessionType = normalizeFreshAgentSessionType(input.sessionType)
      ?? normalizeFreshAgentSessionType(input.provider)
    const provider = (typeof input.provider === 'string'
      && (input.provider === 'claude' || input.provider === 'codex' || input.provider === 'opencode'))
      ? input.provider
      : resolveFreshAgentRuntimeProvider(sessionType)

    if (!sessionType || !provider) {
      return input
    }

    const existingRestoreError = readRestoreError(input.restoreError)
    if (existingRestoreError) {
      const {
        kind: _legacyKind,
        provider: _legacyProvider,
        sessionRef: _legacySessionRef,
        resumeSessionId: _legacyResumeSessionId,
        timelineSessionId: _legacyTimelineSessionId,
        cliSessionId: _legacyCliSessionId,
        restoreError: _legacyRestoreError,
        ...rest
      } = input

      return {
        ...rest,
        kind: 'fresh-agent',
        provider,
        sessionType,
        ...(existingRestoreError.reason === 'invalid_legacy_restore_target'
          ? {}
          : (typeof input.resumeSessionId === 'string' ? { resumeSessionId: input.resumeSessionId } : {})),
        restoreError: existingRestoreError,
      }
    }

    const resumeSessionId = typeof input.resumeSessionId === 'string'
      ? input.resumeSessionId
      : (typeof input.timelineSessionId === 'string'
          ? input.timelineSessionId
          : (typeof input.cliSessionId === 'string' ? input.cliSessionId : undefined))
    const durableState = migrateLegacyFreshAgentDurableState({
      provider,
      sessionRef: input.sessionRef,
      resumeSessionId,
      rejectNonCanonicalClaudeSessionRef: true,
    })
    const {
      kind: _legacyKind,
      provider: _legacyProvider,
      sessionRef: _legacySessionRef,
      resumeSessionId: _legacyResumeSessionId,
      timelineSessionId: _legacyTimelineSessionId,
      cliSessionId: _legacyCliSessionId,
      restoreError: _legacyRestoreError,
      ...rest
    } = input

    return {
      ...rest,
      kind: 'fresh-agent',
      provider,
      sessionType,
      ...(durableState.restoreError
        ? { restoreError: durableState.restoreError }
        : {
            ...(typeof input.resumeSessionId === 'string' ? { resumeSessionId: input.resumeSessionId } : {}),
            ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
          }),
    }
  }

  if (input.kind !== 'agent-chat') {
    return input
  }

  const sessionType = normalizeFreshAgentSessionType(input.provider)
    ?? (input.provider === 'claude' ? 'freshclaude' : undefined)
  const provider = resolveFreshAgentRuntimeProvider(sessionType)
    ?? (input.provider === 'claude' ? 'claude' : undefined)
  const resumeSessionId = typeof input.resumeSessionId === 'string'
    ? input.resumeSessionId
    : (typeof input.timelineSessionId === 'string'
        ? input.timelineSessionId
        : (typeof input.cliSessionId === 'string' ? input.cliSessionId : undefined))
  const durableState = migrateLegacyFreshAgentDurableState({
    provider,
    sessionRef: input.sessionRef,
    resumeSessionId,
    rejectNonCanonicalClaudeSessionRef: true,
  })
  const hasUsableIdentity = !!durableState.sessionRef
    || (typeof input.sessionId === 'string' && input.sessionId.length > 0)
  const existingRestoreError = readRestoreError(input.restoreError)
  const restoreError = existingRestoreError
    ?? durableState.restoreError
    ?? (!sessionType || !provider || !hasUsableIdentity
      ? buildRestoreError('invalid_legacy_restore_target')
      : undefined)
  const {
    kind: _legacyKind,
    provider: _legacyProvider,
    sessionRef: _legacySessionRef,
    resumeSessionId: _legacyResumeSessionId,
    timelineSessionId: _legacyTimelineSessionId,
    cliSessionId: _legacyCliSessionId,
    restoreError: _legacyRestoreError,
    ...rest
  } = input

  return {
    ...rest,
    kind: 'fresh-agent',
    sessionType: sessionType ?? 'freshclaude',
    provider: provider ?? 'claude',
    ...(restoreError
      ? {
          ...(restoreError.reason === 'invalid_legacy_restore_target'
            ? {}
            : (typeof input.resumeSessionId === 'string' ? { resumeSessionId: input.resumeSessionId } : {})),
          restoreError,
        }
      : {
          ...(typeof input.resumeSessionId === 'string' ? { resumeSessionId: input.resumeSessionId } : {}),
          ...(durableState.sessionRef ? { sessionRef: durableState.sessionRef } : {}),
        }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function migrateLegacyFreshAgentNode(node: unknown): unknown {
  if (!isRecord(node)) {
    return node
  }

  if (node.type === 'leaf' && isRecord(node.content)) {
    return {
      ...node,
      content: migrateLegacyFreshAgentContent(node.content),
    }
  }

  if (node.type === 'split' && Array.isArray(node.children)) {
    return {
      ...node,
      children: node.children.map(migrateLegacyFreshAgentNode),
    }
  }

  return node
}

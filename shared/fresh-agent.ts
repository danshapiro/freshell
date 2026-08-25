import {
  buildRestoreError,
  isCanonicalClaudeSessionId,
  sanitizeSessionRef,
  type RestoreError,
  type SessionRef,
} from './session-contract.js'
import {
  isDurableProviderSessionId,
  isPlaceholderProviderSessionId,
} from './session-flavor.js'

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

/**
 * The identity-relevant fields of a fresh-agent pane content fold — the shape
 * `preservedDurableFreshAgentIdentity` reasons over. `sessionRef` is declared
 * as the SessionRef OBJECT; a string-typed payload is invalid input and is
 * discarded by `sanitizeSessionRef` (never matched).
 */
export type FreshAgentIdentityFold = {
  provider?: FreshAgentRuntimeProvider
  createRequestId?: string
  sessionRef?: SessionRef
  sessionId?: string
  resumeSessionId?: string
}

/**
 * Identity guard for the persist/tabs.sync/updatePaneContent fold paths
 * (kata item 1): when a pane already holds a DURABLE provider session
 * identity, an incoming payload that re-derived a PLACEHOLDER identity for
 * the same provider+createRequestId must not clobber it. Both createRequestIds
 * must be defined and equal, so deliberate resets (new createRequestId / fork)
 * are naturally exempt; the providers must agree, so a provider switch is
 * naturally exempt; and both sessionRef locators' providers must agree with
 * the pane provider, so a structurally-inconsistent pane is never mutated.
 *
 * Incoming staleness classification:
 * - Locator present: the locator alone classifies — it must sanitize, agree
 *   with the pane provider, and classify placeholder (a DURABLE locator means
 *   the fold carries a real identity — never stale, so a restoreError on a
 *   genuinely broken durable pane is left alone).
 * - Locator absent (the restoreError migration strips it — the incident's
 *   normalized shape): ANY present scalar identity field (sessionId or
 *   resumeSessionId) classifying placeholder marks the fold stale.
 *
 * Returns the previous durable identity tuple — the sessionRef OBJECT
 * preserved verbatim (never coerced to a string, which downstream
 * `sanitizeSessionRef` would discard), plus sessionId and resumeSessionId —
 * for the caller to spread over the incoming content. Undefined otherwise.
 */
export function preservedDurableFreshAgentIdentity(
  previous: FreshAgentIdentityFold | undefined,
  incoming: FreshAgentIdentityFold,
): Pick<FreshAgentIdentityFold, 'sessionRef' | 'sessionId' | 'resumeSessionId'> | undefined {
  if (!previous) return undefined
  const provider = incoming.provider
  if (!provider || previous.provider !== provider) return undefined
  if (!previous.createRequestId || previous.createRequestId !== incoming.createRequestId) {
    return undefined
  }
  const previousSessionRef = sanitizeSessionRef(previous.sessionRef)
  if (!previousSessionRef || previousSessionRef.provider !== provider) return undefined
  if (!isDurableProviderSessionId(previousSessionRef.provider, previousSessionRef.sessionId)) {
    return undefined
  }
  const incomingSessionRef = sanitizeSessionRef(incoming.sessionRef)
  if (incomingSessionRef) {
    if (incomingSessionRef.provider !== provider) return undefined
    if (!isPlaceholderProviderSessionId(incomingSessionRef.provider, incomingSessionRef.sessionId)) {
      return undefined
    }
  } else if (
    !isPlaceholderProviderSessionId(provider, incoming.sessionId)
    && !isPlaceholderProviderSessionId(provider, incoming.resumeSessionId)
  ) {
    return undefined
  }
  return {
    sessionRef: previousSessionRef,
    sessionId: typeof previous.sessionId === 'string' && previous.sessionId.length > 0
      ? previous.sessionId
      : previousSessionRef.sessionId,
    resumeSessionId: typeof previous.resumeSessionId === 'string' && previous.resumeSessionId.length > 0
      ? previous.resumeSessionId
      : previousSessionRef.sessionId,
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

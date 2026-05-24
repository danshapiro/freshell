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
  sessionRef?: unknown
  initialCwd?: unknown
  createError?: unknown
  model?: unknown
  permissionMode?: unknown
  effort?: unknown
  plugins?: unknown
  settingsDismissed?: unknown
}

export type FreshAgentDescriptor = {
  sessionType: FreshAgentSessionType
  runtimeProvider: FreshAgentRuntimeProvider
  label: string
  hidden?: boolean
  disabled?: boolean
}

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

export function migrateLegacyFreshAgentContent<T extends FreshAgentCompatibilityShape>(
  input: T,
): T | (Omit<T, 'kind' | 'provider'> & {
  kind: 'fresh-agent'
  provider: FreshAgentRuntimeProvider
  sessionType: FreshAgentSessionType
}) {
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

    return {
      ...input,
      kind: 'fresh-agent',
      provider,
      sessionType,
    }
  }

  if (input.kind !== 'agent-chat') {
    return input
  }

  const sessionType = normalizeFreshAgentSessionType(input.provider)
  const provider = resolveFreshAgentRuntimeProvider(sessionType)
  if (!sessionType || !provider) {
    return input
  }

  return {
    ...input,
    kind: 'fresh-agent',
    provider,
    sessionType,
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

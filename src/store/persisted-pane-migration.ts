import { isNonShellMode } from '@/lib/coding-cli-utils'
import { buildExactSessionRef, sanitizeExactSessionRef } from '@/lib/exact-session-ref'

type MigrationOptions = {
  localServerInstanceId?: string
}

function normalizeResumeSessionId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizeTerminalContent(content: Record<string, unknown>, options: MigrationOptions): Record<string, unknown> {
  const { sessionRef: _sessionRef, resumeSessionId: _resumeSessionId, ...rest } = content
  const mode = typeof content.mode === 'string' ? content.mode : 'shell'
  const mirroredResumeSessionId = normalizeResumeSessionId(content.resumeSessionId)
  const explicitSessionRef = sanitizeExactSessionRef(content.sessionRef as any)
  const sessionRef = explicitSessionRef
    ?? (
      mirroredResumeSessionId
      && isNonShellMode(mode)
      && options.localServerInstanceId
        ? buildExactSessionRef({
            provider: mode,
            sessionId: mirroredResumeSessionId,
            serverInstanceId: options.localServerInstanceId,
          })
        : undefined
    )
  const resumeSessionId = sessionRef?.sessionId ?? mirroredResumeSessionId

  return {
    ...rest,
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(sessionRef ? { sessionRef } : {}),
  }
}

function normalizeAgentChatContent(content: Record<string, unknown>, options: MigrationOptions): Record<string, unknown> {
  const { sessionRef: _sessionRef, resumeSessionId: _resumeSessionId, ...rest } = content
  const mirroredResumeSessionId = normalizeResumeSessionId(content.resumeSessionId)
  const explicitSessionRef = sanitizeExactSessionRef(content.sessionRef as any)
  const sessionRef = explicitSessionRef
    ?? (
      mirroredResumeSessionId && options.localServerInstanceId
        ? buildExactSessionRef({
            provider: 'claude',
            sessionId: mirroredResumeSessionId,
            serverInstanceId: options.localServerInstanceId,
          })
        : undefined
    )
  const resumeSessionId = sessionRef?.sessionId ?? mirroredResumeSessionId

  return {
    ...rest,
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(sessionRef ? { sessionRef } : {}),
  }
}

export function migratePersistedPaneContent(content: unknown, options: MigrationOptions = {}): unknown {
  if (!content || typeof content !== 'object') return content
  const record = content as Record<string, unknown>
  if (record.kind === 'terminal') return normalizeTerminalContent(record, options)
  if (record.kind === 'agent-chat') return normalizeAgentChatContent(record, options)
  return content
}

export function migratePersistedPaneNode(node: unknown, options: MigrationOptions = {}): unknown {
  if (!node || typeof node !== 'object') return node
  const record = node as Record<string, unknown>
  if (record.type === 'leaf') {
    return {
      ...record,
      content: migratePersistedPaneContent(record.content, options),
    }
  }
  if (record.type === 'split' && Array.isArray(record.children) && record.children.length >= 2) {
    return {
      ...record,
      children: [
        migratePersistedPaneNode(record.children[0], options),
        migratePersistedPaneNode(record.children[1], options),
      ],
    }
  }
  return node
}

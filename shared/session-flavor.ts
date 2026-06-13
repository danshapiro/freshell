import { z } from 'zod'
import { isCanonicalClaudeSessionId } from './session-contract.js'

export const CLI_SESSION_TYPES = ['claude', 'codex', 'opencode'] as const
export const PUBLIC_FRESH_AGENT_SESSION_TYPES = ['freshclaude', 'freshcodex', 'freshopencode'] as const
export const HIDDEN_SESSION_METADATA_TYPES = ['kilroy'] as const
export const PUBLIC_SESSION_TYPES = [
  ...CLI_SESSION_TYPES,
  ...PUBLIC_FRESH_AGENT_SESSION_TYPES,
] as const
export const KNOWN_SESSION_METADATA_TYPES = [
  ...PUBLIC_SESSION_TYPES,
  ...HIDDEN_SESSION_METADATA_TYPES,
] as const
export const SESSION_TYPE_METADATA_SOURCES = ['explicit', 'materialized'] as const

export type CliSessionType = typeof CLI_SESSION_TYPES[number]
export type PublicFreshAgentSessionType = typeof PUBLIC_FRESH_AGENT_SESSION_TYPES[number]
export type PublicSessionType = typeof PUBLIC_SESSION_TYPES[number]
export type KnownSessionMetadataType = typeof KNOWN_SESSION_METADATA_TYPES[number]
export type SessionTypeMetadataSource = typeof SESSION_TYPE_METADATA_SOURCES[number]

export const PublicSessionTypeSchema = z.enum(PUBLIC_SESSION_TYPES)
export const KnownSessionMetadataTypeSchema = z.enum(KNOWN_SESSION_METADATA_TYPES)
export const SessionTypeMetadataSourceSchema = z.enum(SESSION_TYPE_METADATA_SOURCES)

const PUBLIC_SESSION_TYPE_SET = new Set<string>(PUBLIC_SESSION_TYPES)
const KNOWN_SESSION_METADATA_TYPE_SET = new Set<string>(KNOWN_SESSION_METADATA_TYPES)
const CLI_TO_FRESH: Record<CliSessionType, PublicFreshAgentSessionType> = {
  claude: 'freshclaude',
  codex: 'freshcodex',
  opencode: 'freshopencode',
}
const FRESH_TO_CLI: Record<PublicFreshAgentSessionType, CliSessionType> = {
  freshclaude: 'claude',
  freshcodex: 'codex',
  freshopencode: 'opencode',
}

export type SessionFlavorMetadata = {
  sessionType?: string
  sessionTypeSource?: SessionTypeMetadataSource
}

export function isPublicSessionType(value: unknown): value is PublicSessionType {
  return typeof value === 'string' && PUBLIC_SESSION_TYPE_SET.has(value)
}

export function isKnownSessionMetadataType(value: unknown): value is KnownSessionMetadataType {
  return typeof value === 'string' && KNOWN_SESSION_METADATA_TYPE_SET.has(value)
}

export function getPairedPublicSessionType(sessionType: string | undefined): PublicSessionType | undefined {
  if (!sessionType || !isPublicSessionType(sessionType)) return undefined
  if (sessionType in CLI_TO_FRESH) return CLI_TO_FRESH[sessionType as CliSessionType]
  return FRESH_TO_CLI[sessionType as PublicFreshAgentSessionType]
}

export function resolveSessionTypeRuntimeProvider(sessionType: string | undefined): CliSessionType | undefined {
  if (!sessionType || !isPublicSessionType(sessionType)) return undefined
  if (sessionType in CLI_TO_FRESH) return sessionType as CliSessionType
  return FRESH_TO_CLI[sessionType as PublicFreshAgentSessionType]
}

export function isDurableProviderSessionId(provider: string | undefined, sessionId: string | undefined): boolean {
  if (!provider || !sessionId) return false
  if (provider === 'claude') {
    return isCanonicalClaudeSessionId(sessionId)
  }
  if (provider === 'opencode') {
    return /^ses_/.test(sessionId)
  }
  if (provider === 'codex') {
    return sessionId.trim().length > 0 && !sessionId.startsWith('freshcodex-')
  }
  return false
}

export function shouldApplySessionTypeMetadata(
  existing: SessionFlavorMetadata | undefined,
  incoming: Required<Pick<SessionFlavorMetadata, 'sessionType' | 'sessionTypeSource'>>,
): boolean {
  if (!existing?.sessionType) return true
  if (existing.sessionType === incoming.sessionType) {
    return existing.sessionTypeSource !== 'explicit' && incoming.sessionTypeSource === 'explicit'
  }
  if (existing.sessionTypeSource !== 'materialized' && incoming.sessionTypeSource === 'materialized') {
    return false
  }
  return true
}

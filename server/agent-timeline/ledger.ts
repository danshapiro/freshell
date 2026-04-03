import { createHash } from 'crypto'
import { isValidClaudeSessionId } from '../claude-session-id.js'
import type { SdkSessionState } from '../sdk-bridge-types.js'
import type { ChatMessage } from '../session-history-loader.js'

export type CanonicalTurnSource = 'durable' | 'live'
export type LedgerReadiness = 'durable_only' | 'live_only' | 'merged'

export type CanonicalTurn = {
  turnId: string
  messageId: string
  ordinal: number
  source: CanonicalTurnSource
  message: ChatMessage
}

export type RestoreResolution =
  | { kind: 'missing'; queryId: string }
  | {
    kind: 'resolved'
    queryId: string
    liveSessionId?: string
    timelineSessionId?: string
    readiness: LedgerReadiness
    revision: number
    latestTurnId: string | null
    turns: CanonicalTurn[]
  }

export type RestoreLedgerManagerDeps = {
  loadSessionHistory: (sessionId: string) => Promise<ChatMessage[] | null>
  getLiveSessionBySdkSessionId: (sdkSessionId: string) => SdkSessionState | undefined
  getLiveSessionByCliSessionId: (timelineSessionId: string) => SdkSessionState | undefined
}

type LedgerRecord = {
  ledgerId: string
  revision: number
  signature: string
  resolution: Extract<RestoreResolution, { kind: 'resolved' }>
  aliases: Set<string>
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizeText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/g, '')
}

function normalizeStructuredContent(value: unknown): unknown {
  if (typeof value === 'string') {
    return normalizeText(value)
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeStructuredContent(entry))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, normalizeStructuredContent((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

function fingerprintBlock(block: ChatMessage['content'][number]): unknown {
  switch (block.type) {
    case 'text':
      return { type: block.type, text: normalizeText(block.text) }
    case 'thinking':
      return { type: block.type, thinking: normalizeText(block.thinking) }
    case 'tool_use':
      return {
        type: block.type,
        id: block.id,
        name: block.name,
        input: normalizeStructuredContent(block.input ?? {}),
      }
    case 'tool_result':
      return {
        type: block.type,
        tool_use_id: block.tool_use_id,
        is_error: block.is_error,
        content: normalizeStructuredContent(block.content),
      }
    default:
      return block
  }
}

export function createDurableMessageFingerprint(message: Pick<ChatMessage, 'role' | 'content' | 'model'>): string {
  return stableStringify({
    role: message.role,
    content: message.content.map(fingerprintBlock),
    ...(message.model ? { model: message.model } : {}),
  })
}

export function synthesizeDeterministicMessageId(message: Pick<ChatMessage, 'role' | 'content' | 'model'>, occurrenceIndex: number): string {
  const fingerprint = createDurableMessageFingerprint(message)
  const digest = createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)
  return `durable:${digest}:${occurrenceIndex}`
}

function resolveTimelineSessionId(queryId: string, liveSession?: SdkSessionState): string | undefined {
  if (isValidClaudeSessionId(liveSession?.cliSessionId)) return liveSession.cliSessionId
  if (typeof liveSession?.resumeSessionId === 'string' && liveSession.resumeSessionId.trim().length > 0) {
    return liveSession.resumeSessionId
  }
  if (isValidClaudeSessionId(queryId)) return queryId
  return undefined
}

function buildCanonicalTurns(
  messages: ChatMessage[],
  source: CanonicalTurnSource,
  liveSessionId?: string,
): CanonicalTurn[] {
  return messages.map((message, index) => {
    const messageId = message.messageId ?? `live:${liveSessionId ?? 'session'}:${index}`
    return {
      turnId: `turn:${messageId}`,
      messageId,
      ordinal: index,
      source,
      message,
    }
  })
}

function mergeTurns(durableTurns: CanonicalTurn[], liveTurns: CanonicalTurn[]): CanonicalTurn[] {
  if (durableTurns.length === 0) return liveTurns
  if (liveTurns.length === 0) return durableTurns
  const merged = [...durableTurns]
  const seen = new Set(durableTurns.map((turn) => turn.messageId))
  for (const turn of liveTurns) {
    if (seen.has(turn.messageId)) continue
    merged.push(turn)
    seen.add(turn.messageId)
  }
  return merged.map((turn, index) => ({ ...turn, ordinal: index }))
}

function buildSignature(resolution: Extract<RestoreResolution, { kind: 'resolved' }>): string {
  return stableStringify({
    timelineSessionId: resolution.timelineSessionId,
    liveSessionId: resolution.liveSessionId,
    readiness: resolution.readiness,
    turns: resolution.turns.map((turn) => ({
      turnId: turn.turnId,
      messageId: turn.messageId,
      source: turn.source,
    })),
  })
}

export function createRestoreLedgerManager(deps: RestoreLedgerManagerDeps) {
  const ledgers = new Map<string, LedgerRecord>()
  const ledgerIdByAlias = new Map<string, string>()
  const tombstonedLiveAliases = new Set<string>()

  function bindAliases(ledger: LedgerRecord, aliases: Iterable<string | undefined>): void {
    for (const alias of aliases) {
      if (!alias) continue
      ledger.aliases.add(alias)
      ledgerIdByAlias.set(alias, ledger.ledgerId)
    }
  }

  function findLedgerRecord(aliases: Array<string | undefined>): LedgerRecord | undefined {
    for (const alias of aliases) {
      if (!alias) continue
      const ledgerId = ledgerIdByAlias.get(alias)
      if (!ledgerId) continue
      const ledger = ledgers.get(ledgerId)
      if (ledger) return ledger
    }
    return undefined
  }

  return {
    async resolve(queryId: string): Promise<RestoreResolution> {
      const liveSession = tombstonedLiveAliases.has(queryId)
        ? undefined
        : deps.getLiveSessionBySdkSessionId(queryId) ?? deps.getLiveSessionByCliSessionId(queryId)
      const timelineSessionId = resolveTimelineSessionId(queryId, liveSession)
      const durableMessages = timelineSessionId ? (await deps.loadSessionHistory(timelineSessionId)) ?? [] : []

      if (!liveSession && durableMessages.length === 0) {
        return { kind: 'missing', queryId }
      }

      const durableTurns = buildCanonicalTurns(durableMessages, 'durable')
      const liveTurns = buildCanonicalTurns(liveSession?.messages ?? [], 'live', liveSession?.sessionId)
      const turns = mergeTurns(durableTurns, liveTurns)
      const readiness: LedgerReadiness = durableTurns.length > 0 && liveTurns.length > 0
        ? 'merged'
        : durableTurns.length > 0
          ? 'durable_only'
          : 'live_only'

      const nextResolution: Extract<RestoreResolution, { kind: 'resolved' }> = {
        kind: 'resolved',
        queryId,
        liveSessionId: liveSession?.sessionId,
        timelineSessionId,
        readiness,
        revision: 1,
        latestTurnId: turns.at(-1)?.turnId ?? null,
        turns,
      }

      const aliases = [queryId, liveSession?.sessionId, liveSession?.resumeSessionId, liveSession?.cliSessionId, timelineSessionId]
      const existing = findLedgerRecord(aliases)
      const signature = buildSignature(nextResolution)

      if (existing) {
        const revision = existing.signature === signature ? existing.revision : existing.revision + 1
        const resolved = { ...nextResolution, revision }
        existing.revision = revision
        existing.signature = signature
        existing.resolution = resolved
        bindAliases(existing, aliases)
        return resolved
      }

      const ledgerId = liveSession?.sessionId ?? timelineSessionId ?? queryId
      const record: LedgerRecord = {
        ledgerId,
        revision: 1,
        signature,
        resolution: nextResolution,
        aliases: new Set<string>(),
      }
      ledgers.set(record.ledgerId, record)
      bindAliases(record, aliases)
      return nextResolution
    },

    teardownLiveSession(sessionId: string, _options: { recoverable: boolean }): void {
      const ledgerId = ledgerIdByAlias.get(sessionId)
      tombstonedLiveAliases.add(sessionId)
      if (!ledgerId) return
      const record = ledgers.get(ledgerId)
      if (!record) return
      for (const alias of record.aliases) {
        tombstonedLiveAliases.add(alias)
        ledgerIdByAlias.delete(alias)
      }
      ledgers.delete(ledgerId)
    },
  }
}

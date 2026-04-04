import { createHash } from 'crypto'
import { isValidClaudeSessionId } from '../claude-session-id.js'
import type { SdkSessionState } from '../sdk-bridge-types.js'
import type { ChatMessage } from '../session-history-loader.js'
import type { AgentHistoryResolveOptions } from './history-source.js'

export type CanonicalTurnSource = 'durable' | 'live'
export type LedgerReadiness = 'durable_only' | 'live_only' | 'merged'
export type RestoreFatalCode = 'RESTORE_UNAVAILABLE' | 'RESTORE_INTERNAL' | 'RESTORE_DIVERGED'

export type CanonicalTurn = {
  turnId: string
  messageId: string
  ordinal: number
  source: CanonicalTurnSource
  message: ChatMessage
}

export type RestoreResolution =
  | { kind: 'missing'; code: 'RESTORE_NOT_FOUND' }
  | { kind: 'fatal'; code: RestoreFatalCode; message: string }
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
  logDivergence?: (details: { queryId: string; reason: string; liveSessionId?: string; timelineSessionId?: string }) => void
}

type InternalTurn = CanonicalTurn & {
  compatibilityKey: string
  syntheticMessageId: boolean
}

type ResolvedRestore = Extract<RestoreResolution, { kind: 'resolved' }>

type LedgerRecord = {
  ledgerId: string
  revision: number
  signature: string
  resolution?: ResolvedRestore
  compatibilityCandidateIds: Set<string>
  aliases: Set<string>
  liveAliases: Set<string>
  durableAliases: Set<string>
  durableMessages: ChatMessage[]
  durableTimelineSessionId?: string
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

export function synthesizeLiveMessageId(sessionId: string, ordinal: number): string {
  const normalizedSessionId = sessionId.trim().length > 0 ? sessionId : 'session'
  return `live:${normalizedSessionId}:${ordinal}`
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
  options?: { liveSessionId?: string },
): InternalTurn[] {
  const occurrences = new Map<string, number>()
  return messages.map((message, index) => {
    const fingerprint = createDurableMessageFingerprint(message)
    const occurrenceIndex = occurrences.get(fingerprint) ?? 0
    occurrences.set(fingerprint, occurrenceIndex + 1)
    const messageId = message.messageId ?? (
      source === 'live'
        ? synthesizeLiveMessageId(options?.liveSessionId ?? 'session', index)
        : synthesizeDeterministicMessageId(message, occurrenceIndex)
    )
    return {
      turnId: `turn:${messageId}`,
      messageId,
      ordinal: 0,
      source,
      compatibilityKey: `${fingerprint}:${occurrenceIndex}`,
      syntheticMessageId: message.messageId == null,
      message: {
        ...message,
        messageId,
      },
    }
  })
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
      fingerprint: createDurableMessageFingerprint(turn.message),
    })),
  })
}

function mapFatalError(error: unknown): Extract<RestoreResolution, { kind: 'fatal' }> {
  const candidate = error as { code?: unknown; message?: unknown }
  const code = candidate?.code
  if (code === 'RESTORE_UNAVAILABLE' || code === 'RESTORE_INTERNAL' || code === 'RESTORE_DIVERGED') {
    return {
      kind: 'fatal',
      code,
      message: typeof candidate.message === 'string' && candidate.message.trim().length > 0
        ? candidate.message
        : 'Failed to resolve restore history',
    }
  }
  return {
    kind: 'fatal',
    code: 'RESTORE_INTERNAL',
    message: error instanceof Error && error.message.trim().length > 0
      ? error.message
      : 'Failed to resolve restore history',
  }
}

function normalizeOrdinals(turns: InternalTurn[]): CanonicalTurn[] {
  return turns.map((turn, index) => ({
    turnId: turn.turnId,
    messageId: turn.messageId,
    ordinal: index,
    source: turn.source,
    message: turn.message,
  }))
}

function mergeTurns(
  durableTurns: InternalTurn[],
  liveTurns: InternalTurn[],
  compatibilityCandidateIds?: ReadonlySet<string>,
): { kind: 'ok'; turns: CanonicalTurn[] } | { kind: 'diverged' } {
  if (durableTurns.length === 0) return { kind: 'ok', turns: normalizeOrdinals(liveTurns) }
  if (liveTurns.length === 0) return { kind: 'ok', turns: normalizeOrdinals(durableTurns) }

  const durableById = new Map<string, number>()
  const durableByCompatibilityKey = new Map<string, number>()
  for (const [index, turn] of durableTurns.entries()) {
    durableById.set(turn.messageId, index)
    durableByCompatibilityKey.set(turn.compatibilityKey, index)
  }

  const matchedDurableIndices: number[] = []
  const matchedLiveIndices: number[] = []
  const unmatchedLiveIndices: number[] = []
  const unmatchedLiveTurns: InternalTurn[] = []
  const potentialCompatibilityMatches: Array<{ liveIndex: number; durableIndex: number; turn: InternalTurn }> = []
  let compatibilityUsed = false

  for (const [index, liveTurn] of liveTurns.entries()) {
    const exactMatch = durableById.get(liveTurn.messageId)
    if (exactMatch != null) {
      matchedDurableIndices.push(exactMatch)
      matchedLiveIndices.push(index)
      continue
    }

    const compatibilityMatch = durableByCompatibilityKey.get(liveTurn.compatibilityKey)
    if (compatibilityMatch != null) {
      if (compatibilityCandidateIds?.has(liveTurn.messageId)) {
        matchedDurableIndices.push(compatibilityMatch)
        matchedLiveIndices.push(index)
        compatibilityUsed = true
        continue
      }
      potentialCompatibilityMatches.push({
        liveIndex: index,
        durableIndex: compatibilityMatch,
        turn: liveTurn,
      })
      continue
    }

    unmatchedLiveIndices.push(index)
    unmatchedLiveTurns.push(liveTurn)
  }

  const canPromoteImplicitCompatibility = (!compatibilityCandidateIds || compatibilityCandidateIds.size === 0)
    && (
      potentialCompatibilityMatches.length > 1
      || (
        potentialCompatibilityMatches.length === 1
        && potentialCompatibilityMatches[0]?.turn.syntheticMessageId === true
      )
    )
  if (canPromoteImplicitCompatibility) {
    for (const match of potentialCompatibilityMatches) {
      matchedDurableIndices.push(match.durableIndex)
      matchedLiveIndices.push(match.liveIndex)
      compatibilityUsed = true
    }
  } else {
    for (const match of potentialCompatibilityMatches) {
      unmatchedLiveIndices.push(match.liveIndex)
      unmatchedLiveTurns.push(match.turn)
    }
  }

  if (compatibilityUsed && matchedDurableIndices.length > 0) {
    const orderedDurableMatches = [...matchedDurableIndices].sort((left, right) => left - right)
    const expectedDurableStart = durableTurns.length - orderedDurableMatches.length
    const matchesDurableSuffix = orderedDurableMatches.every((value, index) => value === expectedDurableStart + index)
    const lastMatchedLiveIndex = Math.max(...matchedLiveIndices)
    const hasInterleavedLiveDelta = unmatchedLiveIndices.some((index) => index < lastMatchedLiveIndex)
    if (!matchesDurableSuffix || hasInterleavedLiveDelta) {
      return { kind: 'diverged' }
    }
  }

  return { kind: 'ok', turns: normalizeOrdinals([...durableTurns, ...unmatchedLiveTurns]) }
}

function deriveCompatibilityCandidateIds(resolution: Extract<RestoreResolution, { kind: 'resolved' }>): Set<string> {
  if (resolution.readiness !== 'live_only') {
    return new Set<string>()
  }
  return new Set(
    resolution.turns
      .filter((turn) => turn.source === 'live')
      .map((turn) => turn.messageId),
  )
}

function isCanonicalDurableSessionId(sessionId: string | undefined): sessionId is string {
  return typeof sessionId === 'string' && isValidClaudeSessionId(sessionId)
}

export function createRestoreLedgerManager(deps: RestoreLedgerManagerDeps) {
  const ledgers = new Map<string, LedgerRecord>()
  const ledgerIdByAlias = new Map<string, string>()
  const tombstonedLiveAliases = new Set<string>()

  function createLedgerRecord(ledgerId: string): LedgerRecord {
    const record: LedgerRecord = {
      ledgerId,
      revision: 0,
      signature: '',
      compatibilityCandidateIds: new Set<string>(),
      aliases: new Set<string>(),
      liveAliases: new Set<string>(),
      durableAliases: new Set<string>(),
      durableMessages: [],
    }
    ledgers.set(ledgerId, record)
    return record
  }

  function bindAliases(
    ledger: LedgerRecord,
    aliases: { liveAliases: Iterable<string | undefined>; durableAliases: Iterable<string | undefined> },
  ): void {
    for (const alias of aliases.liveAliases) {
      if (!alias) continue
      tombstonedLiveAliases.delete(alias)
      ledger.aliases.add(alias)
      ledger.liveAliases.add(alias)
      ledgerIdByAlias.set(alias, ledger.ledgerId)
    }
    for (const alias of aliases.durableAliases) {
      if (!alias) continue
      ledger.aliases.add(alias)
      ledger.durableAliases.add(alias)
      ledgerIdByAlias.set(alias, ledger.ledgerId)
    }
  }

  function clearLedgerAliases(ledger: LedgerRecord): void {
    for (const alias of ledger.aliases) {
      ledgerIdByAlias.delete(alias)
    }
    ledger.aliases.clear()
    ledger.liveAliases.clear()
    ledger.durableAliases.clear()
  }

  function dropLedger(ledger: LedgerRecord): void {
    clearLedgerAliases(ledger)
    ledgers.delete(ledger.ledgerId)
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

  async function hydrateDurableHistory(
    ledger: LedgerRecord,
    timelineSessionId: string | undefined,
  ): Promise<void> {
    if (!isCanonicalDurableSessionId(timelineSessionId)) return
    const durableMessages = (await deps.loadSessionHistory(timelineSessionId)) ?? []
    ledger.durableMessages = durableMessages
    ledger.durableTimelineSessionId = timelineSessionId
  }

  function updateResolution(
    ledger: LedgerRecord,
    params: {
      liveSession?: SdkSessionState
      timelineSessionId?: string
      queryId: string
    },
  ): void {
    const durableTurns = buildCanonicalTurns(ledger.durableMessages, 'durable')
    const liveTurns = buildCanonicalTurns(params.liveSession?.messages ?? [], 'live', {
      liveSessionId: params.liveSession?.sessionId,
    })
    const mergedTurns = mergeTurns(durableTurns, liveTurns, ledger.compatibilityCandidateIds)
    if (mergedTurns.kind === 'diverged') {
      deps.logDivergence?.({
        queryId: params.queryId,
        reason: 'ambiguous-live-overlap',
        liveSessionId: params.liveSession?.sessionId,
        timelineSessionId: params.timelineSessionId,
      })
      throw {
        code: 'RESTORE_DIVERGED',
        message: 'Live restore state diverged from durable history',
      }
    }

    const readiness: LedgerReadiness = durableTurns.length > 0 && liveTurns.length > 0
      ? 'merged'
      : durableTurns.length > 0
        ? 'durable_only'
        : 'live_only'

    const stableQueryId = ledger.resolution?.queryId
      ?? params.liveSession?.sessionId
      ?? params.timelineSessionId
      ?? params.queryId

    const nextResolution: ResolvedRestore = {
      kind: 'resolved',
      queryId: stableQueryId,
      liveSessionId: params.liveSession?.sessionId,
      timelineSessionId: params.timelineSessionId,
      readiness,
      revision: 1,
      latestTurnId: mergedTurns.turns.at(-1)?.turnId ?? null,
      turns: mergedTurns.turns,
    }

    const signature = buildSignature(nextResolution)
    const revision = ledger.signature === signature ? ledger.revision : ledger.revision + 1
    const resolved = { ...nextResolution, revision }

    ledger.revision = revision
    ledger.signature = signature
    ledger.resolution = resolved
    ledger.compatibilityCandidateIds = resolved.readiness === 'live_only'
      ? deriveCompatibilityCandidateIds(resolved)
      : new Set(ledger.compatibilityCandidateIds)
  }

  async function buildDurableOnlyResolution(queryId: string, timelineSessionId: string): Promise<RestoreResolution> {
    const existing = findLedgerRecord([timelineSessionId])
    const ledger = existing ?? createLedgerRecord(timelineSessionId)
    await hydrateDurableHistory(ledger, timelineSessionId)
    if (ledger.durableMessages.length === 0) {
      dropLedger(ledger)
      return { kind: 'missing', code: 'RESTORE_NOT_FOUND' }
    }
    updateResolution(ledger, {
      queryId,
      timelineSessionId,
    })
    bindAliases(ledger, {
      liveAliases: [],
      durableAliases: [timelineSessionId],
    })
    return ledger.resolution ?? { kind: 'missing', code: 'RESTORE_NOT_FOUND' }
  }

  function findBoundLiveSession(ledger: LedgerRecord): SdkSessionState | undefined {
    const liveSessionId = ledger.resolution?.liveSessionId
    if (!liveSessionId || tombstonedLiveAliases.has(liveSessionId)) return undefined
    const liveSession = deps.getLiveSessionBySdkSessionId(liveSessionId)
    if (!liveSession || tombstonedLiveAliases.has(liveSession.sessionId)) return undefined
    return liveSession
  }

  async function syncLiveSession(liveSession: SdkSessionState): Promise<LedgerRecord> {
    const timelineSessionId = resolveTimelineSessionId(liveSession.sessionId, liveSession)
    const existing = findLedgerRecord([
      liveSession.sessionId,
      liveSession.resumeSessionId,
      timelineSessionId,
    ])
    const ledger = existing ?? createLedgerRecord(liveSession.sessionId)

    if (isCanonicalDurableSessionId(timelineSessionId)) {
      await hydrateDurableHistory(ledger, timelineSessionId)
    }

    updateResolution(ledger, {
      liveSession,
      timelineSessionId,
      queryId: liveSession.sessionId,
    })

    bindAliases(ledger, {
      liveAliases: [liveSession.sessionId, liveSession.resumeSessionId],
      durableAliases: [isCanonicalDurableSessionId(timelineSessionId) ? timelineSessionId : undefined],
    })
    return ledger
  }

  return {
    async syncLiveSession(liveSession: SdkSessionState): Promise<void> {
      tombstonedLiveAliases.delete(liveSession.sessionId)
      if (liveSession.resumeSessionId) tombstonedLiveAliases.delete(liveSession.resumeSessionId)
      await syncLiveSession(liveSession)
    },

    async resolve(queryId: string, options?: AgentHistoryResolveOptions): Promise<RestoreResolution> {
      try {
        const existing = findLedgerRecord([queryId])
        const liveSessionCandidate = options?.liveSessionOverride ?? (
          tombstonedLiveAliases.has(queryId)
            ? undefined
            : deps.getLiveSessionBySdkSessionId(queryId)
              ?? deps.getLiveSessionByCliSessionId(queryId)
              ?? (existing ? findBoundLiveSession(existing) : undefined)
        )
        const liveSession = liveSessionCandidate && tombstonedLiveAliases.has(liveSessionCandidate.sessionId)
          ? undefined
          : liveSessionCandidate
        if (liveSession) {
          const ledger = await syncLiveSession(liveSession)
          return ledger.resolution ?? { kind: 'missing', code: 'RESTORE_NOT_FOUND' }
        }

        if (existing) {
          if (existing.liveAliases.size > 0) {
            return existing.resolution ?? { kind: 'missing', code: 'RESTORE_NOT_FOUND' }
          }
          const durableSessionId = isCanonicalDurableSessionId(queryId)
            ? queryId
            : Array.from(existing.durableAliases).find((alias) => isCanonicalDurableSessionId(alias))
          if (!durableSessionId) {
            return existing.resolution ?? { kind: 'missing', code: 'RESTORE_NOT_FOUND' }
          }
          return buildDurableOnlyResolution(queryId, durableSessionId)
        }
        if (!isCanonicalDurableSessionId(queryId)) {
          return { kind: 'missing', code: 'RESTORE_NOT_FOUND' }
        }
        return buildDurableOnlyResolution(queryId, queryId)
      } catch (error) {
        return mapFatalError(error)
      }
    },

    teardownLiveSession(sessionId: string, options: { recoverable: boolean }): void {
      if (options.recoverable) return
      const ledgerId = ledgerIdByAlias.get(sessionId)
      tombstonedLiveAliases.add(sessionId)
      if (!ledgerId) return
      const record = ledgers.get(ledgerId)
      if (!record) return
      for (const alias of record.liveAliases) {
        tombstonedLiveAliases.add(alias)
      }
      dropLedger(record)
    },
  }
}

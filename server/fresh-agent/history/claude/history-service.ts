import { MAX_AGENT_TIMELINE_ITEMS } from '../../../../shared/read-models.js'
import type { ChatMessage } from '../../../session-history-loader.js'
import type { ClaudeFreshAgentHistorySource } from './history-source.js'
import type { ClaudeFreshAgentHistoryCanonicalTurn, ClaudeFreshAgentHistoryRestoreResolution } from './history-ledger.js'
import type {
  ClaudeFreshAgentHistoryItem,
  ClaudeFreshAgentHistoryPage,
  ClaudeFreshAgentHistoryPageQuery,
  ClaudeFreshAgentHistoryTurnBodyQuery,
  ClaudeFreshAgentHistoryTurn,
} from './history-types.js'

const DEFAULT_TIMELINE_LIMIT = 20
const MAX_TIMELINE_LIMIT = MAX_AGENT_TIMELINE_ITEMS

type TimelineCursorPayload = {
  offset: number
  revision: number
}

type TimelineMessageRecord = ClaudeFreshAgentHistoryCanonicalTurn & { sessionId: string }

export type ClaudeFreshAgentHistorySnapshot = {
  sessionId: string
  latestTurnId: string | null
  revision: number
  turns: ClaudeFreshAgentHistoryCanonicalTurn[]
}

export type ClaudeFreshAgentHistoryService = {
  getSnapshot: (query: { sessionId: string; revision?: number; signal?: AbortSignal }) => Promise<ClaudeFreshAgentHistorySnapshot>
  getTimelinePage: (query: ClaudeFreshAgentHistoryPageQuery & { sessionId: string; signal?: AbortSignal }) => Promise<ClaudeFreshAgentHistoryPage>
  getTurnBody: (query: ClaudeFreshAgentHistoryTurnBodyQuery & { sessionId: string; turnId: string; signal?: AbortSignal }) => Promise<ClaudeFreshAgentHistoryTurn | null>
}

export type ClaudeFreshAgentHistoryServiceDeps = {
  agentHistorySource: ClaudeFreshAgentHistorySource
}

export class ClaudeFreshAgentHistoryInvalidCursorError extends Error {
  constructor() {
    super('Invalid Claude fresh-agent history cursor')
  }
}

export class ClaudeFreshAgentHistoryStaleRevisionError extends Error {
  code = 'RESTORE_STALE_REVISION' as const

  constructor(public readonly requestedRevision: number, public readonly actualRevision: number) {
    super('Restore revision is stale')
  }
}

export class ClaudeFreshAgentHistoryResolutionError extends Error {
  constructor(
    public readonly code: 'RESTORE_NOT_FOUND' | 'RESTORE_UNAVAILABLE' | 'RESTORE_INTERNAL' | 'RESTORE_DIVERGED',
    message: string,
  ) {
    super(message)
  }
}

function encodeCursor(payload: TimelineCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): TimelineCursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<TimelineCursorPayload>
    if (
      typeof parsed.offset !== 'number'
      || !Number.isInteger(parsed.offset)
      || parsed.offset < 0
      || typeof parsed.revision !== 'number'
      || !Number.isInteger(parsed.revision)
      || parsed.revision < 0
    ) {
      throw new Error('invalid')
    }
    return { offset: parsed.offset, revision: parsed.revision }
  } catch {
    throw new ClaudeFreshAgentHistoryInvalidCursorError()
  }
}

function summarizeMessage(message: ChatMessage): string {
  const textBlock = message.content.find((block) => block.type === 'text')
  if (textBlock && typeof textBlock.text === 'string' && textBlock.text.trim().length > 0) {
    return textBlock.text.trim().slice(0, 140)
  }

  const firstBlock = message.content[0]
  if (!firstBlock) return ''
  if (firstBlock.type === 'thinking') return firstBlock.thinking.slice(0, 140)
  if (firstBlock.type === 'tool_use') return `${firstBlock.name}`.slice(0, 140)
  if (firstBlock.type === 'tool_result') return 'Tool result'
  return ''
}

function buildTimeline(turns: ClaudeFreshAgentHistoryCanonicalTurn[], sessionId: string): TimelineMessageRecord[] {
  return turns
    .map((turn) => ({
      ...turn,
      sessionId,
    }))
    .reverse()
}

function toTimelineItem(record: TimelineMessageRecord): ClaudeFreshAgentHistoryItem {
  return {
    turnId: record.turnId,
    messageId: record.messageId,
    ordinal: record.ordinal,
    source: record.source,
    sessionId: record.sessionId,
    role: record.message.role,
    summary: summarizeMessage(record.message),
    ...(record.message.timestamp ? { timestamp: record.message.timestamp } : {}),
  }
}

export function createClaudeFreshAgentHistoryService(
  deps: ClaudeFreshAgentHistoryServiceDeps,
): ClaudeFreshAgentHistoryService {
  function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Claude fresh-agent history request aborted')
    }
  }

  async function loadTimeline(queryId: string): Promise<{ sessionId: string, latestTurnId: string | null, revision: number, records: TimelineMessageRecord[] }> {
    const resolved = await deps.agentHistorySource.resolve(queryId)
    return buildResolvedTimeline(queryId, resolved)
  }

  function buildResolvedTimeline(queryId: string, resolved: ClaudeFreshAgentHistoryRestoreResolution): { sessionId: string, latestTurnId: string | null, revision: number, records: TimelineMessageRecord[] } {
    if (resolved.kind === 'missing') {
      throw new ClaudeFreshAgentHistoryResolutionError(resolved.code, 'Restore session not found')
    }
    if (resolved.kind === 'fatal') {
      throw new ClaudeFreshAgentHistoryResolutionError(resolved.code, resolved.message)
    }
    const sessionId = resolved.timelineSessionId ?? queryId
    return {
      sessionId,
      latestTurnId: resolved.latestTurnId,
      revision: resolved.revision,
      records: buildTimeline(resolved.turns, sessionId),
    }
  }

  return {
    async getSnapshot({ sessionId, revision, signal }) {
      throwIfAborted(signal)
      const timeline = await loadTimeline(sessionId)
      throwIfAborted(signal)
      if (revision != null && revision !== timeline.revision) {
        throw new ClaudeFreshAgentHistoryStaleRevisionError(revision, timeline.revision)
      }
      return {
        sessionId: timeline.sessionId,
        latestTurnId: timeline.latestTurnId,
        revision: timeline.revision,
        turns: timeline.records
          .slice()
          .reverse()
          .map((record) => ({
            turnId: record.turnId,
            messageId: record.messageId,
            ordinal: record.ordinal,
            source: record.source,
            message: record.message,
          })),
      }
    },

    async getTimelinePage(query) {
      throwIfAborted(query.signal)
      if (query.revision == null) {
        throw new Error('Restore revision is required')
      }
      const limit = Math.min(query.limit ?? DEFAULT_TIMELINE_LIMIT, MAX_TIMELINE_LIMIT)
      const cursor = query.cursor ? decodeCursor(query.cursor) : null
      const offset = cursor?.offset ?? 0
      const timeline = await loadTimeline(query.sessionId)
      throwIfAborted(query.signal)
      if (query.revision !== timeline.revision) {
        throw new ClaudeFreshAgentHistoryStaleRevisionError(query.revision, timeline.revision)
      }
      if (cursor && cursor.revision !== timeline.revision) {
        throw new ClaudeFreshAgentHistoryStaleRevisionError(cursor.revision, timeline.revision)
      }
      const pageItems = timeline.records.slice(offset, offset + limit)
      const nextOffset = offset + pageItems.length

      const result: ClaudeFreshAgentHistoryPage = {
        sessionId: timeline.sessionId,
        latestTurnId: timeline.latestTurnId,
        items: pageItems.map(toTimelineItem),
        nextCursor: nextOffset < timeline.records.length ? encodeCursor({ offset: nextOffset, revision: timeline.revision }) : null,
        revision: timeline.revision,
      }

      if (query.includeBodies) {
        const bodies: Record<string, ClaudeFreshAgentHistoryTurn> = {}
        for (const record of pageItems) {
          bodies[record.turnId] = {
            sessionId: timeline.sessionId,
            turnId: record.turnId,
            messageId: record.messageId,
            ordinal: record.ordinal,
            source: record.source,
            message: record.message,
          }
        }
        result.bodies = bodies
      }

      return result
    },

    async getTurnBody({ sessionId, turnId, revision }) {
      if (revision == null) {
        throw new Error('Restore revision is required')
      }
      const timeline = await loadTimeline(sessionId)
      if (revision !== timeline.revision) {
        throw new ClaudeFreshAgentHistoryStaleRevisionError(revision, timeline.revision)
      }
      const match = timeline.records.find((record) => record.turnId === turnId)
      if (!match) return null

      return {
        sessionId: timeline.sessionId,
        turnId,
        messageId: match.messageId,
        ordinal: match.ordinal,
        source: match.source,
        message: match.message,
      }
    },
  }
}

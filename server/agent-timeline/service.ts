import { MAX_AGENT_TIMELINE_ITEMS } from '../../shared/read-models.js'
import type { ChatMessage } from '../session-history-loader.js'
import type { AgentHistorySource, ResolvedAgentHistory } from './history-source.js'
import type {
  AgentTimelineItem,
  AgentTimelinePage,
  AgentTimelinePageQuery,
  AgentTimelineTurn,
} from './types.js'

const DEFAULT_TIMELINE_LIMIT = 20
const MAX_TIMELINE_LIMIT = MAX_AGENT_TIMELINE_ITEMS

type TimelineCursorPayload = {
  offset: number
}

type TimelineMessageRecord = {
  turnId: string
  sessionId: string
  message: ChatMessage
}

export type AgentTimelineService = {
  getTimelinePage: (query: AgentTimelinePageQuery & { sessionId: string; signal?: AbortSignal }) => Promise<AgentTimelinePage>
  getTurnBody: (query: { sessionId: string; turnId: string; signal?: AbortSignal }) => Promise<AgentTimelineTurn | null>
}

export type AgentTimelineServiceDeps = {
  agentHistorySource: AgentHistorySource
}

function encodeCursor(payload: TimelineCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): TimelineCursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<TimelineCursorPayload>
    if (typeof parsed.offset !== 'number' || !Number.isInteger(parsed.offset) || parsed.offset < 0) {
      throw new Error('invalid')
    }
    return { offset: parsed.offset }
  } catch {
    throw new Error('Invalid agent-timeline cursor')
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

function buildTimeline(messages: ChatMessage[], sessionId: string): TimelineMessageRecord[] {
  return messages
    .map((message, index) => ({
      turnId: `turn-${index}`,
      sessionId,
      message,
    }))
    .reverse()
}

function toTimelineItem(record: TimelineMessageRecord): AgentTimelineItem {
  return {
    turnId: record.turnId,
    sessionId: record.sessionId,
    role: record.message.role,
    summary: summarizeMessage(record.message),
    ...(record.message.timestamp ? { timestamp: record.message.timestamp } : {}),
  }
}

export function createAgentTimelineService(deps: AgentTimelineServiceDeps): AgentTimelineService {
  function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error('Agent timeline request aborted')
    }
  }

  async function loadTimeline(queryId: string): Promise<{ sessionId: string, revision: number, records: TimelineMessageRecord[] }> {
    const resolved = await deps.agentHistorySource.resolve(queryId)
    return buildResolvedTimeline(queryId, resolved)
  }

  function buildResolvedTimeline(queryId: string, resolved: ResolvedAgentHistory | null): { sessionId: string, revision: number, records: TimelineMessageRecord[] } {
    const sessionId = resolved?.timelineSessionId ?? queryId
    return {
      sessionId,
      revision: resolved?.revision ?? 0,
      records: buildTimeline(resolved?.messages ?? [], sessionId),
    }
  }

  return {
    async getTimelinePage(query) {
      throwIfAborted(query.signal)
      const limit = Math.min(query.limit ?? DEFAULT_TIMELINE_LIMIT, MAX_TIMELINE_LIMIT)
      const offset = query.cursor ? decodeCursor(query.cursor).offset : 0
      const timeline = await loadTimeline(query.sessionId)
      throwIfAborted(query.signal)
      const pageItems = timeline.records.slice(offset, offset + limit)
      const nextOffset = offset + pageItems.length

      const result: AgentTimelinePage = {
        sessionId: timeline.sessionId,
        items: pageItems.map(toTimelineItem),
        nextCursor: nextOffset < timeline.records.length ? encodeCursor({ offset: nextOffset }) : null,
        revision: timeline.revision,
      }

      if (query.includeBodies) {
        const bodies: Record<string, AgentTimelineTurn> = {}
        for (const record of pageItems) {
          bodies[record.turnId] = {
            sessionId: timeline.sessionId,
            turnId: record.turnId,
            message: record.message,
          }
        }
        result.bodies = bodies
      }

      return result
    },

    async getTurnBody({ sessionId, turnId }) {
      const timeline = await loadTimeline(sessionId)
      const match = timeline.records.find((record) => record.turnId === turnId)
      if (!match) return null

      return {
        sessionId: timeline.sessionId,
        turnId,
        message: match.message,
      }
    },
  }
}

import { isValidClaudeSessionId } from '../claude-session-id.js'
import { logger } from '../logger.js'
import type { SdkSessionState } from '../sdk-bridge-types.js'
import type { ChatMessage } from '../session-history-loader.js'
import type { ContentBlock } from '../../shared/ws-protocol.js'

export type ResolvedAgentHistory = {
  liveSessionId?: string
  timelineSessionId?: string
  messages: ChatMessage[]
  revision: number
}

export type AgentHistoryDivergenceDetails = {
  queryId: string
  sdkSessionId?: string
  timelineSessionId?: string
  liveMode: 'full' | 'delta'
  reason: 'conflict' | 'ambiguous_overlap'
  liveCount: number
  durableCount: number
}

export type AgentHistorySource = {
  resolve: (queryId: string) => Promise<ResolvedAgentHistory | null>
}

export type AgentHistorySourceDeps = {
  loadSessionHistory: (sessionId: string) => Promise<ChatMessage[] | null>
  getLiveSessionBySdkSessionId: (sdkSessionId: string) => SdkSessionState | undefined
  getLiveSessionByCliSessionId: (timelineSessionId: string) => SdkSessionState | undefined
  logDivergence?: (details: AgentHistoryDivergenceDetails) => void
}

const log = logger.child({ component: 'agent-timeline-history-source' })

function toRevision(messages: ChatMessage[]): number {
  return messages.reduce((maxRevision, message, index) => {
    if (!message.timestamp) return Math.max(maxRevision, index + 1)
    const timestamp = Date.parse(message.timestamp)
    if (!Number.isFinite(timestamp)) return Math.max(maxRevision, index + 1)
    return Math.max(maxRevision, timestamp)
  }, 0)
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

function normalizeContentBlock(block: ContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return { type: block.type, text: block.text }
    case 'thinking':
      return { type: block.type, thinking: block.thinking }
    case 'tool_use':
      return { type: block.type, id: block.id, name: block.name, input: block.input }
    case 'tool_result':
      return {
        type: block.type,
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      }
    default:
      return block
  }
}

function sameMessageCore(left: ChatMessage, right: ChatMessage): boolean {
  if (left.role !== right.role) return false
  if ((left.model ?? undefined) !== (right.model ?? undefined)) return false
  if (left.content.length !== right.content.length) return false

  return left.content.every((block, index) => {
    const otherBlock = right.content[index]
    if (!otherBlock) return false
    return stableStringify(normalizeContentBlock(block)) === stableStringify(normalizeContentBlock(otherBlock))
  })
}

function parseTimestamp(value?: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function timestampsPlausiblySame(left?: string, right?: string): boolean {
  const leftParsed = parseTimestamp(left)
  const rightParsed = parseTimestamp(right)
  if (leftParsed != null && rightParsed != null) {
    return leftParsed === rightParsed
  }
  if (left != null && right != null) return left === right
  return false
}

function timestampsMateriallyDifferent(left?: string, right?: string): boolean {
  return !timestampsPlausiblySame(left, right) && (left != null || right != null)
}

function messagesMatch(left: ChatMessage, right: ChatMessage): boolean {
  return sameMessageCore(left, right) && timestampsPlausiblySame(left.timestamp, right.timestamp)
}

function messagesCompatibleForSharedHistory(left: ChatMessage, right: ChatMessage): boolean {
  return sameMessageCore(left, right) && !timestampsMateriallyDifferent(left.timestamp, right.timestamp)
}

function isResumedDeltaSession(session: SdkSessionState): boolean {
  return typeof session.resumeSessionId === 'string' && session.resumeSessionId.length > 0
}

function resolveTimelineSessionId(queryId: string, liveSession?: SdkSessionState): string | undefined {
  if (isValidClaudeSessionId(liveSession?.cliSessionId)) return liveSession.cliSessionId
  if (isValidClaudeSessionId(liveSession?.resumeSessionId)) return liveSession.resumeSessionId
  if (isValidClaudeSessionId(queryId)) return queryId
  return undefined
}

function isPrefix(prefix: ChatMessage[], full: ChatMessage[]): boolean {
  if (prefix.length > full.length) return false
  return prefix.every((message, index) => messagesCompatibleForSharedHistory(message, full[index]!))
}

function mergeResumedDeltaHistory(
  durableMessages: ChatMessage[],
  liveMessages: ChatMessage[],
  details: Omit<AgentHistoryDivergenceDetails, 'reason'>,
  logDivergence?: (details: AgentHistoryDivergenceDetails) => void,
): ChatMessage[] {
  const maxOverlap = Math.min(durableMessages.length, liveMessages.length)
  for (let overlap = maxOverlap; overlap >= 1; overlap -= 1) {
    const durableTail = durableMessages.slice(durableMessages.length - overlap)
    const liveHead = liveMessages.slice(0, overlap)
    const overlapMatches = durableTail.every((message, index) => {
      const other = liveHead[index]!
      return overlap === 1
        ? messagesMatch(message, other)
        : messagesCompatibleForSharedHistory(message, other)
    })
    if (overlapMatches) {
      return [...durableMessages, ...liveMessages.slice(overlap)]
    }
  }

  const durableTail = durableMessages.at(-1)
  const liveHead = liveMessages[0]
  if (
    durableTail
    && liveHead
    && sameMessageCore(durableTail, liveHead)
  ) {
    logDivergence?.({
      ...details,
      reason: 'ambiguous_overlap',
    })
    return [...durableMessages, ...liveMessages]
  }

  if (durableMessages.length > 0 && liveMessages.length > 0) {
    logDivergence?.({
      ...details,
      reason: 'conflict',
    })
  }

  return [...durableMessages, ...liveMessages]
}

function mergeFreshHistory(
  durableMessages: ChatMessage[],
  liveMessages: ChatMessage[],
  details: Omit<AgentHistoryDivergenceDetails, 'reason'>,
  logDivergence?: (details: AgentHistoryDivergenceDetails) => void,
): ChatMessage[] {
  if (liveMessages.length === 0) return durableMessages
  if (durableMessages.length === 0) return liveMessages
  if (isPrefix(durableMessages, liveMessages)) return liveMessages
  if (isPrefix(liveMessages, durableMessages)) return durableMessages

  logDivergence?.({
    ...details,
    reason: 'conflict',
  })
  return liveMessages
}

export function createAgentHistorySource(deps: AgentHistorySourceDeps): AgentHistorySource {
  return {
    async resolve(queryId: string): Promise<ResolvedAgentHistory | null> {
      const liveSession = deps.getLiveSessionBySdkSessionId(queryId)
        ?? (isValidClaudeSessionId(queryId) ? deps.getLiveSessionByCliSessionId(queryId) : undefined)
      const timelineSessionId = resolveTimelineSessionId(queryId, liveSession)
      let durableMessages: ChatMessage[] = []
      if (timelineSessionId) {
        try {
          durableMessages = (await deps.loadSessionHistory(timelineSessionId)) ?? []
        } catch (error) {
          if (!liveSession) throw error
          log.warn({
            err: error instanceof Error ? error : new Error(String(error)),
            queryId,
            sdkSessionId: liveSession.sessionId,
            timelineSessionId,
          }, 'Failed to load durable agent history; falling back to live session history')
        }
      }
      const liveMessages = liveSession?.messages ?? []

      if (!liveSession && durableMessages.length === 0) {
        return null
      }

      const details = {
        queryId,
        sdkSessionId: liveSession?.sessionId,
        timelineSessionId,
        liveCount: liveMessages.length,
        durableCount: durableMessages.length,
      }
      const messages = liveSession
        ? isResumedDeltaSession(liveSession)
          ? mergeResumedDeltaHistory(durableMessages, liveMessages, { ...details, liveMode: 'delta' }, deps.logDivergence)
          : mergeFreshHistory(durableMessages, liveMessages, { ...details, liveMode: 'full' }, deps.logDivergence)
        : durableMessages

      return {
        liveSessionId: liveSession?.sessionId,
        timelineSessionId,
        messages,
        revision: toRevision(messages),
      }
    },
  }
}

import type { ChatMessage } from '../../../session-history-loader.js'
import type { CanonicalTurn } from './history-ledger.js'
import type {
  AgentTimelinePageQuery as SharedAgentTimelinePageQuery,
  AgentTimelineTurnBodyQuery as SharedAgentTimelineTurnBodyQuery,
} from '../../../../shared/read-models.js'

export type ClaudeFreshAgentHistoryPageQuery = SharedAgentTimelinePageQuery
export type ClaudeFreshAgentHistoryTurnBodyQuery = SharedAgentTimelineTurnBodyQuery

export type ClaudeFreshAgentHistoryItem = {
  turnId: string
  messageId: string
  ordinal: number
  source: CanonicalTurn['source']
  sessionId: string
  role: ChatMessage['role']
  summary: string
  timestamp?: string
}

export type ClaudeFreshAgentHistoryPage = {
  sessionId: string
  latestTurnId: string | null
  items: ClaudeFreshAgentHistoryItem[]
  nextCursor: string | null
  revision: number
  /** When includeBodies is requested, maps turnId to full turn body. */
  bodies?: Record<string, ClaudeFreshAgentHistoryTurn>
}

export type ClaudeFreshAgentHistoryTurn = {
  sessionId: string
  turnId: string
  messageId: string
  ordinal: number
  source: CanonicalTurn['source']
  message: ChatMessage
}

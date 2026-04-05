import type { ChatMessage } from '../session-history-loader.js'
import type { CanonicalTurn } from './ledger.js'
import type {
  AgentTimelinePageQuery as SharedAgentTimelinePageQuery,
  AgentTimelineTurnBodyQuery as SharedAgentTimelineTurnBodyQuery,
} from '../../shared/read-models.js'

export type AgentTimelinePageQuery = SharedAgentTimelinePageQuery
export type AgentTimelineTurnBodyQuery = SharedAgentTimelineTurnBodyQuery

export type AgentTimelineItem = {
  turnId: string
  messageId: string
  ordinal: number
  source: CanonicalTurn['source']
  sessionId: string
  role: ChatMessage['role']
  summary: string
  timestamp?: string
}

export type AgentTimelinePage = {
  sessionId: string
  latestTurnId: string | null
  items: AgentTimelineItem[]
  nextCursor: string | null
  revision: number
  /** When includeBodies is requested, maps turnId to full turn body. */
  bodies?: Record<string, AgentTimelineTurn>
}

export type AgentTimelineTurn = {
  sessionId: string
  turnId: string
  messageId: string
  ordinal: number
  source: CanonicalTurn['source']
  message: ChatMessage
}

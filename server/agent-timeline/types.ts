import type { ChatMessage } from '../session-history-loader.js'
import type {
  AgentTimelinePageQuery as SharedAgentTimelinePageQuery,
} from '../../shared/read-models.js'

export type AgentTimelinePageQuery = SharedAgentTimelinePageQuery

export type AgentTimelineItem = {
  turnId: string
  sessionId: string
  role: ChatMessage['role']
  summary: string
  timestamp?: string
}

export type AgentTimelinePage = {
  sessionId: string
  items: AgentTimelineItem[]
  nextCursor: string | null
  revision: number
  /** When includeBodies is requested, maps turnId to full turn body. */
  bodies?: Record<string, AgentTimelineTurn>
}

export type AgentTimelineTurn = {
  sessionId: string
  turnId: string
  message: ChatMessage
}

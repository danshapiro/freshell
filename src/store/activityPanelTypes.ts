import type { NormalizedEvent, ApprovalPayload } from '@/lib/coding-cli-types'

export const ACTIVITY_PANEL_MAX_EVENTS = 50

export interface ActivityPanelEvent {
  event: NormalizedEvent
  id: string // unique display ID (sequenceNumber or generated)
}

export interface TokenTotals {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalCost: number
}

export interface PendingApproval {
  requestId: string
  toolName: string
  description: string
  timestamp: string
}

export interface ActivityTask {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export interface ActivityPanelSessionState {
  events: ActivityPanelEvent[]
  eventStart: number
  eventCount: number
  tokenTotals: TokenTotals
  pendingApprovals: PendingApproval[]
  tasks: ActivityTask[]
}

export interface ActivityPanelState {
  sessions: Record<string, ActivityPanelSessionState>
  visibility: Record<string, boolean>
}

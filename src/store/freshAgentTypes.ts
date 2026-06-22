import type {
  FreshAgentRuntimeProvider,
  FreshAgentSessionType,
} from '@shared/fresh-agent'
import type {
  FreshAgentPendingApproval,
  FreshAgentPendingQuestion,
  FreshAgentRequestId,
  FreshAgentSnapshot,
  FreshAgentTurn,
} from '@shared/fresh-agent-contract'

export type { FreshAgentRequestId }
export type FreshAgentPermissionRequest = FreshAgentPendingApproval
export type FreshAgentQuestionRequest = FreshAgentPendingQuestion
export type FreshAgentThreadItem = FreshAgentTurn
export type FreshAgentThreadTurn = FreshAgentTurn
export type FreshAgentContentBlock = FreshAgentTurn['items'][number]
export type FreshAgentMessage = FreshAgentTurn

export type FreshAgentSessionStatus =
  | 'creating'
  | 'starting'
  | 'connected'
  | 'running'
  | 'idle'
  | 'compacting'
  | 'exited'

export type FreshAgentSessionLocator = {
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  sessionId: string
}

export type PendingCreateFailure = {
  code: string
  message: string
  retryable?: boolean
}

export type FreshAgentPendingCreate = {
  sessionId?: string
  sessionKey?: string
  sessionType?: FreshAgentSessionType
  provider?: FreshAgentRuntimeProvider
  cwd?: string
  expectsHistoryHydration: boolean
}

export type FreshAgentSessionState = FreshAgentSessionLocator & {
  sessionKey: string
  threadId: string
  status: FreshAgentSessionStatus
  snapshot?: FreshAgentSnapshot
  latestTurnId?: string | null
  historySessionId?: string
  historyRevision?: number
  cliSessionId?: string
  cwd?: string
  model?: string
  tools?: Array<{ name: string }>
  turns: FreshAgentTurn[]
  historyItems: FreshAgentTurn[]
  historyBodies: Record<string, FreshAgentTurn>
  nextHistoryCursor?: string | null
  historyLoading?: boolean
  historyError?: string
  streamingText: string
  streamingActive: boolean
  pendingPermissions: Record<string, FreshAgentPermissionRequest>
  pendingQuestions: Record<string, FreshAgentQuestionRequest>
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  lastError?: string
  historyLoaded?: boolean
  awaitingDurableHistory?: boolean
  lost?: boolean
  restoreRetryCount?: number
  restoreFailureCode?: string
  restoreFailureMessage?: string
  snapshotRefreshRequestId?: number
  restoreHydrationRequestId?: number
}

export type FreshAgentState = {
  sessions: Record<string, FreshAgentSessionState>
  pendingCreates: Record<string, FreshAgentPendingCreate>
  pendingCreateFailures: Record<string, PendingCreateFailure>
  availableModels: Array<{ value: string; displayName: string; description: string }>
}

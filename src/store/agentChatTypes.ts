export interface ChatContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result'
  // text block
  text?: string
  // thinking block
  thinking?: string
  // tool_use block
  id?: string
  name?: string
  input?: Record<string, unknown>
  // tool_result block
  tool_use_id?: string
  content?: string | unknown[]
  is_error?: boolean
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: ChatContentBlock[]
  timestamp: string
  model?: string
  messageId?: string
}

export interface AgentTimelineItem {
  turnId: string
  messageId: string
  ordinal: number
  source: 'durable' | 'live'
  sessionId: string
  role: ChatMessage['role']
  summary: string
  timestamp?: string
}

export interface AgentTimelineTurn {
  sessionId: string
  turnId: string
  messageId: string
  ordinal: number
  source: 'durable' | 'live'
  message: ChatMessage
}

export interface PermissionRequest {
  requestId: string
  subtype: string
  tool?: {
    name: string
    input?: Record<string, unknown>
  }
}

export interface QuestionOption {
  label: string
  description: string
}

export interface QuestionDefinition {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface QuestionRequest {
  requestId: string
  questions: QuestionDefinition[]
}

export interface PendingCreateFailure {
  code: string
  message: string
  retryable?: boolean
}

export interface ChatSessionState {
  sessionId: string
  cliSessionId?: string
  timelineSessionId?: string
  timelineRevision?: number
  cwd?: string
  model?: string
  latestTurnId?: string | null
  status: 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited'
  messages: ChatMessage[]
  timelineItems: AgentTimelineItem[]
  timelineBodies: Record<string, AgentTimelineTurn>
  nextTimelineCursor?: string | null
  timelineLoading?: boolean
  timelineError?: string
  streamingText: string
  streamingActive: boolean
  pendingPermissions: Record<string, PermissionRequest>
  pendingQuestions: Record<string, QuestionRequest>
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  tools?: Array<{ name: string }>
  lastError?: string
  /** True after a fresh create or the first timeline window establishes restore state. */
  historyLoaded?: boolean
  /** True while a resumed create must wait for the durable Claude id before hydrating backlog. */
  awaitingDurableHistory?: boolean
  /** True when server reports session is gone (INVALID_SESSION_ID). Triggers immediate recovery. */
  lost?: boolean
  /** Number of restore restarts already requested for stale-revision handling. */
  restoreRetryCount?: number
  /** Last restore-specific failure code surfaced during hydration. */
  restoreFailureCode?: string
  /** Monotonic key for requesting one fresh sdk.attach snapshot refresh before hydration resumes. */
  snapshotRefreshRequestId?: number
  /** Monotonic key for restarting visible restore hydration from a newer snapshot. */
  restoreHydrationRequestId?: number
}

export interface PendingAgentCreate {
  sessionId?: string
  expectsHistoryHydration: boolean
}

export interface AgentChatState {
  sessions: Record<string, ChatSessionState>
  /** Maps createRequestId -> sessionId for correlating sdk.created responses */
  pendingCreates: Record<string, PendingAgentCreate>
  /** Request-scoped pre-session failures keyed by createRequestId. */
  pendingCreateFailures: Record<string, PendingCreateFailure>
  /** Available models from SDK supportedModels() */
  availableModels: Array<{ value: string; displayName: string; description: string }>
}

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
  sessionId: string
  role: ChatMessage['role']
  summary: string
  timestamp?: string
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

export interface ChatSessionState {
  sessionId: string
  cliSessionId?: string
  cwd?: string
  model?: string
  latestTurnId?: string | null
  status: 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited'
  messages: ChatMessage[]
  timelineItems: AgentTimelineItem[]
  timelineBodies: Record<string, ChatMessage>
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
  /** True when server reports session is gone (INVALID_SESSION_ID). Triggers immediate recovery. */
  lost?: boolean
}

export interface AgentChatState {
  sessions: Record<string, ChatSessionState>
  /** Maps createRequestId -> sessionId for correlating sdk.created responses */
  pendingCreates: Record<string, string>
  /** Available models from SDK supportedModels() */
  availableModels: Array<{ value: string; displayName: string; description: string }>
}

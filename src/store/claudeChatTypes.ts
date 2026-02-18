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

export interface PermissionRequest {
  requestId: string
  subtype: string
  tool?: {
    name: string
    input?: Record<string, unknown>
  }
}

export interface ChatSessionState {
  sessionId: string
  cliSessionId?: string
  cwd?: string
  model?: string
  status: 'creating' | 'starting' | 'connected' | 'running' | 'idle' | 'compacting' | 'exited'
  messages: ChatMessage[]
  streamingText: string
  streamingActive: boolean
  pendingPermissions: Record<string, PermissionRequest>
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  tools?: Array<{ name: string }>
  lastError?: string
}

export interface ClaudeChatState {
  sessions: Record<string, ChatSessionState>
  /** Maps createRequestId -> sessionId for correlating sdk.created responses */
  pendingCreates: Record<string, string>
  /** Available models from SDK supportedModels() */
  availableModels: Array<{ value: string; displayName: string; description: string }>
}

export type CodingCliProviderName = 'claude' | 'codex' | 'opencode' | 'gemini' | 'kimi'

export type NormalizedEventType =
  | 'session.start'       // Session initialized (was session.init)
  | 'session.init'        // Alias for session.start
  | 'session.end'         // Session completed/terminated
  | 'message.user'        // User message
  | 'message.assistant'   // Assistant text response
  | 'message.delta'       // Streaming text delta
  | 'reasoning'           // Reasoning/chain-of-thought
  | 'thinking'            // Legacy alias for reasoning
  | 'tool.call'           // Tool invocation request
  | 'tool.result'         // Tool execution result
  | 'token.usage'         // Token/cost tracking
  | 'error'               // Error occurred
  | 'approval.request'    // Permission request (interactive)
  | 'approval.response'   // Permission response

export interface SessionPayload {
  cwd?: string
  model?: string
  version?: string
  tools?: string[]
  gitBranch?: string
  provider: CodingCliProviderName
}

export interface MessagePayload {
  role: 'user' | 'assistant'
  content: string
  isDelta?: boolean
  messageId?: string
}

export interface ToolPayload {
  callId: string
  name: string
  arguments?: unknown
  output?: string
  isError?: boolean
  exitCode?: number
}

export interface TokenPayload {
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  totalCost?: number
}

export interface ErrorPayload {
  message: string
  code?: string
  recoverable: boolean
}

export interface ApprovalPayload {
  requestId: string
  toolName: string
  description: string
  approved?: boolean
}

export interface NormalizedEvent {
  type: NormalizedEventType
  timestamp: string
  sessionId: string
  provider: CodingCliProviderName
  sequenceNumber?: number
  raw: unknown

  // Type-specific payloads (only one populated per event)
  session?: SessionPayload
  message?: MessagePayload
  tool?: ToolPayload
  tokens?: TokenPayload
  error?: ErrorPayload
  approval?: ApprovalPayload
  reasoning?: string
  thinking?: string

  // Legacy aliases (for backward compatibility)
  sessionInfo?: SessionPayload
  toolCall?: { id: string; name: string; arguments: unknown }
  toolResult?: { id: string; output: string; isError: boolean }
  tokenUsage?: { input: number; output: number; total: number }
}

export interface CodingCliWsEvent {
  type: 'codingcli.event'
  sessionId: string
  provider: CodingCliProviderName
  event: NormalizedEvent
}

export interface CodingCliWsCreated {
  type: 'codingcli.created'
  requestId: string
  sessionId: string
  provider: CodingCliProviderName
}

export interface CodingCliWsExit {
  type: 'codingcli.exit'
  sessionId: string
  provider: CodingCliProviderName
  exitCode: number
}

export interface CodingCliWsStderr {
  type: 'codingcli.stderr'
  sessionId: string
  provider: CodingCliProviderName
  text: string
}

export type CodingCliWsMessage = CodingCliWsEvent | CodingCliWsCreated | CodingCliWsExit | CodingCliWsStderr

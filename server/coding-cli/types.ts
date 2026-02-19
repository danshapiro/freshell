import type { CodingCliProviderName } from '../../shared/ws-protocol.js'
export type { CodingCliProviderName }

/**
 * Sessions are uniquely identified by provider + sessionId.
 * This prevents collisions across providers (e.g., both Claude and Codex
 * could theoretically have the same UUID).
 */
export type SessionCompositeKey = `${CodingCliProviderName}:${string}`

export function makeSessionKey(provider: CodingCliProviderName, sessionId: string): SessionCompositeKey {
  return `${provider}:${sessionId}`
}

export function parseSessionKey(key: SessionCompositeKey): { provider: CodingCliProviderName; sessionId: string } {
  const colonIdx = key.indexOf(':')
  if (colonIdx === -1) {
    // Fallback for legacy keys without provider prefix
    return { provider: 'claude', sessionId: key }
  }
  const provider = key.slice(0, colonIdx) as CodingCliProviderName
  const sessionId = key.slice(colonIdx + 1)
  return { provider, sessionId }
}

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

export interface NormalizedEvent {
  type: NormalizedEventType
  timestamp: string
  sessionId: string
  provider: CodingCliProviderName
  sequenceNumber?: number        // Monotonic, for ordering

  // Type-specific payloads (only one populated per event)
  session?: SessionPayload       // session.start
  message?: MessagePayload       // message.user, message.assistant, message.delta
  tool?: ToolPayload             // tool.call, tool.result
  tokens?: TokenPayload          // token.usage
  error?: ErrorPayload           // error
  approval?: ApprovalPayload     // approval.request, approval.response
  reasoning?: string             // reasoning
  thinking?: string              // legacy alias for reasoning

  // Legacy aliases (for backward compatibility during migration)
  sessionInfo?: SessionPayload   // Alias for session
  toolCall?: { id: string; name: string; arguments: unknown }   // Deprecated, use tool
  toolResult?: { id: string; output: string; isError: boolean } // Deprecated, use tool
  tokenUsage?: { input: number; output: number; total: number } // Deprecated, use tokens
}

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
  isDelta?: boolean              // True for streaming deltas
  messageId?: string             // For correlating deltas
}

export interface ToolPayload {
  callId: string
  name: string
  // For tool.call:
  arguments?: unknown
  // For tool.result:
  output?: string
  isError?: boolean
  exitCode?: number              // For shell commands
}

export interface TokenPayload {
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  totalCost?: number             // USD
}

/**
 * Session-level token aggregate used for runtime metadata.
 * `TokenPayload` above remains the live event payload shape.
 */
export interface TokenSummary {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalTokens: number
  contextTokens?: number
  modelContextWindow?: number
  compactThresholdTokens?: number
  compactPercent?: number
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
  approved?: boolean             // For response
}

export interface ParsedSessionMeta {
  sessionId?: string
  cwd?: string
  title?: string
  summary?: string
  messageCount?: number
  projectPath?: string
  isNonInteractive?: boolean
  gitBranch?: string
  isDirty?: boolean
  tokenUsage?: TokenSummary
}

export interface CodingCliSessionInfo {
  id: string
  provider: CodingCliProviderName
  providerSessionId?: string
  status: 'running' | 'completed' | 'error'
  createdAt: number
  completedAt?: number
  prompt: string
  cwd?: string
  events: NormalizedEvent[]
  eventCount: number
}

export interface CodingCliSession {
  provider: CodingCliProviderName
  sessionId: string
  projectPath: string
  updatedAt: number
  createdAt?: number
  archived?: boolean
  messageCount?: number
  title?: string
  summary?: string
  cwd?: string
  gitBranch?: string
  isDirty?: boolean
  tokenUsage?: TokenSummary
  sourceFile?: string
  isSubagent?: boolean
  isNonInteractive?: boolean
}

export interface ProjectGroup {
  projectPath: string
  sessions: CodingCliSession[]
  color?: string
}

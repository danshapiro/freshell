// Event types from Claude Code stream-json output
export type ClaudeEventType = 'system' | 'assistant' | 'user' | 'result'

// Content block types
export interface TextContent {
  type: 'text'
  text: string
}

export interface ToolUseContent {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultContent {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type ContentBlock = TextContent | ToolUseContent | ToolResultContent

// Message structure
export interface ClaudeMessage {
  id?: string
  role: 'assistant' | 'user'
  content: ContentBlock[]
  model?: string
  stop_reason?: string | null
  usage?: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

// System events
export interface SystemInitEvent {
  type: 'system'
  subtype: 'init'
  session_id: string
  cwd: string
  model: string
  tools: string[]
  claude_code_version: string
  uuid: string
}

export interface SystemHookEvent {
  type: 'system'
  subtype: 'hook_started' | 'hook_response'
  hook_id: string
  hook_name: string
  session_id: string
  uuid: string
  outcome?: 'success' | 'error'
  exit_code?: number
  stdout?: string
  stderr?: string
}

export type SystemEvent = SystemInitEvent | SystemHookEvent

// Assistant/User message events
export interface MessageEvent {
  type: 'assistant' | 'user'
  message: ClaudeMessage
  session_id: string
  uuid: string
  parent_tool_use_id?: string | null
  tool_use_result?: {
    stdout?: string
    stderr?: string
    interrupted?: boolean
    isImage?: boolean
  }
}

// Result event
export interface ResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  is_error: boolean
  duration_ms: number
  duration_api_ms?: number
  num_turns: number
  result?: string
  session_id: string
  total_cost_usd?: number
  usage?: ClaudeMessage['usage']
  uuid: string
}

export type ClaudeEvent = SystemEvent | MessageEvent | ResultEvent

// Type guards
export function isTextContent(block: ContentBlock): block is TextContent {
  return block.type === 'text'
}

export function isToolUseContent(block: ContentBlock): block is ToolUseContent {
  return block.type === 'tool_use'
}

export function isToolResultContent(block: ContentBlock): block is ToolResultContent {
  return block.type === 'tool_result'
}

export function isSystemEvent(event: ClaudeEvent): event is SystemEvent {
  return event.type === 'system'
}

export function isMessageEvent(event: ClaudeEvent): event is MessageEvent {
  return event.type === 'assistant' || event.type === 'user'
}

export function isResultEvent(event: ClaudeEvent): event is ResultEvent {
  return event.type === 'result'
}

// Parser
export function parseClaudeEvent(line: string): ClaudeEvent {
  const parsed = JSON.parse(line)
  return parsed as ClaudeEvent
}

import type { ContentBlock, Usage } from '../../shared/ws-protocol.js'
import type { SdkSessionStatus } from '../sdk-bridge-types.js'

export type FreshAgentProviderEvent =
  | {
    type: 'freshAgent.session.snapshot'
    sessionId: string
    latestTurnId?: string | null
    status: SdkSessionStatus
    timelineSessionId?: string
    revision?: number
    streamingActive?: boolean
    streamingText?: string
  }
  | {
    type: 'freshAgent.session.changed'
    sessionId: string
    reason?: string
  }
  | { type: 'freshAgent.session.init'; sessionId: string; cliSessionId?: string; model?: string; cwd?: string; tools?: Array<{ name: string }> }
  | { type: 'freshAgent.session.metadata'; sessionId: string; cliSessionId?: string; model?: string; cwd?: string; tools?: Array<{ name: string }> }
  | { type: 'freshAgent.assistant'; sessionId: string; content: ContentBlock[]; model?: string; usage?: Usage }
  | { type: 'freshAgent.stream'; sessionId: string; event: unknown; parentToolUseId?: string | null }
  | { type: 'freshAgent.result'; sessionId: string; result?: string; durationMs?: number; costUsd?: number; usage?: Usage }
  | { type: 'freshAgent.permission.request'; sessionId: string; requestId: string; subtype: string; tool?: { name: string; input?: Record<string, unknown> }; toolUseID?: string; suggestions?: unknown[]; blockedPath?: string; decisionReason?: string }
  | { type: 'freshAgent.permission.cancelled'; sessionId: string; requestId: string }
  | { type: 'freshAgent.question.request'; sessionId: string; requestId: string; questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }> }
  | { type: 'freshAgent.status'; sessionId: string; status: SdkSessionStatus }
  | { type: 'freshAgent.error'; sessionId: string; message: string; code?: string }
  | { type: 'freshAgent.exit'; sessionId: string; exitCode?: number }
  | { type: 'freshAgent.killed'; sessionId: string; success?: boolean }

export function normalizeFreshAgentProviderEvent(event: unknown): unknown {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event
  const typed = event as { type?: unknown }
  if (typeof typed.type !== 'string') return event
  if (typed.type.startsWith('freshAgent.')) return event
  const providerEvent = event as Record<string, unknown>

  switch (typed.type) {
    case 'sdk.session.snapshot':
      return { ...providerEvent, type: 'freshAgent.session.snapshot' } as FreshAgentProviderEvent
    case 'sdk.session.changed':
      return { ...providerEvent, type: 'freshAgent.session.changed' } as FreshAgentProviderEvent
    case 'sdk.session.init':
      return { ...providerEvent, type: 'freshAgent.session.init' } as FreshAgentProviderEvent
    case 'sdk.session.metadata':
      return { ...providerEvent, type: 'freshAgent.session.metadata' } as FreshAgentProviderEvent
    case 'sdk.assistant':
      return { ...providerEvent, type: 'freshAgent.assistant' } as FreshAgentProviderEvent
    case 'sdk.stream':
      return { ...providerEvent, type: 'freshAgent.stream' } as FreshAgentProviderEvent
    case 'sdk.result':
      return { ...providerEvent, type: 'freshAgent.result' } as FreshAgentProviderEvent
    case 'sdk.permission.request':
      return { ...providerEvent, type: 'freshAgent.permission.request' } as FreshAgentProviderEvent
    case 'sdk.permission.cancelled':
      return { ...providerEvent, type: 'freshAgent.permission.cancelled' } as FreshAgentProviderEvent
    case 'sdk.question.request':
      return { ...providerEvent, type: 'freshAgent.question.request' } as FreshAgentProviderEvent
    case 'sdk.status':
      return { ...providerEvent, type: 'freshAgent.status' } as FreshAgentProviderEvent
    case 'sdk.error':
      return { ...providerEvent, type: 'freshAgent.error' } as FreshAgentProviderEvent
    case 'sdk.exit':
      return { ...providerEvent, type: 'freshAgent.exit' } as FreshAgentProviderEvent
    case 'sdk.killed':
      return { ...providerEvent, type: 'freshAgent.killed' } as FreshAgentProviderEvent
    default:
      return event
  }
}

export function makeFreshAgentProviderErrorEvent(
  sessionId: string,
  input: { code?: string; message: string },
): FreshAgentProviderEvent {
  return {
    type: 'freshAgent.error',
    sessionId,
    code: input.code,
    message: input.message,
  }
}

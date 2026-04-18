import type { FreshAgentRuntimeProvider, FreshAgentSessionType } from '../../shared/fresh-agent.js'

export type FreshAgentCreateRequest = {
  requestId: string
  sessionType: FreshAgentSessionType
  cwd?: string
  resumeSessionId?: string
  model?: string
  permissionMode?: string
  effort?: 'low' | 'medium' | 'high' | 'max'
  plugins?: string[]
}

export type FreshAgentCreateResult = {
  sessionId: string
  sessionType: FreshAgentSessionType
  runtimeProvider: FreshAgentRuntimeProvider
}

export type FreshAgentThreadLocator = {
  provider: FreshAgentRuntimeProvider
  threadId: string
}

export interface FreshAgentRuntimeAdapter {
  readonly runtimeProvider: FreshAgentRuntimeProvider
  create(input: FreshAgentCreateRequest): Promise<{ sessionId: string }>
  resume?(input: FreshAgentCreateRequest): Promise<{ sessionId: string }>
  subscribe?(sessionId: string, listener: (message: unknown) => void): Promise<() => void> | (() => void)
  send?(sessionId: string, input: { text: string; images?: Array<{ mediaType: string; data: string }> }): Promise<void> | void
  interrupt?(sessionId: string): Promise<void> | void
  fork?(sessionId: string, input?: Record<string, unknown>): Promise<unknown> | unknown
  answerQuestion?(sessionId: string, requestId: string, answers: Record<string, string>): Promise<void> | void
  resolveApproval?(sessionId: string, requestId: string, decision: Record<string, unknown>): Promise<void> | void
  getSnapshot?(thread: FreshAgentThreadLocator, revision?: number): Promise<unknown>
  getTurnPage?(thread: FreshAgentThreadLocator, query: Record<string, unknown>): Promise<unknown>
  getTurnBody?(thread: FreshAgentThreadLocator & { turnId: string }, revision: number): Promise<unknown>
}

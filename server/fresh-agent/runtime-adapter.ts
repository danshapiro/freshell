import type { FreshAgentRuntimeProvider, FreshAgentSessionType } from '../../shared/fresh-agent.js'
import type { FreshAgentRequestId } from '../../shared/fresh-agent-contract.js'

export type FreshAgentCreateRequest = {
  requestId: string
  sessionType: FreshAgentSessionType
  provider?: FreshAgentRuntimeProvider
  cwd?: string
  resumeSessionId?: string
  sessionRef?: { provider: string; sessionId: string }
  model?: string
  modelSelection?: { kind: string; modelId: string }
  permissionMode?: string
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  effort?: string
  plugins?: string[]
}

export type FreshAgentCreateResult = {
  sessionId: string
  sessionType: FreshAgentSessionType
  runtimeProvider: FreshAgentRuntimeProvider
  sessionRef?: { provider: string; sessionId: string }
}

export type FreshAgentThreadLocator = {
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  threadId: string
}

export type FreshAgentSessionLocator = {
  sessionType: FreshAgentSessionType
  provider: FreshAgentRuntimeProvider
  sessionId: string
}

export type FreshAgentInputImage =
  | { kind: 'url'; url: string; mediaType?: string }
  | { kind: 'local'; path: string; mediaType?: string }
  | { kind: 'data'; mediaType: string; data: string }

export interface FreshAgentRuntimeAdapter {
  readonly runtimeProvider: FreshAgentRuntimeProvider
  create(input: FreshAgentCreateRequest): Promise<{ sessionId: string; sessionRef?: { provider: string; sessionId: string } }>
  resume?(input: FreshAgentCreateRequest): Promise<{ sessionId: string; sessionRef?: { provider: string; sessionId: string } }>
  subscribe?(sessionId: string, listener: (message: unknown) => void): Promise<() => void> | (() => void)
  send?(sessionId: string, input: { text: string; images?: FreshAgentInputImage[]; settings?: FreshAgentCreateRequest }): Promise<void> | void
  interrupt?(sessionId: string): Promise<void> | void
  kill?(sessionId: string): Promise<boolean> | boolean
  fork?(sessionId: string, input?: Record<string, unknown>): Promise<unknown> | unknown
  answerQuestion?(sessionId: string, requestId: FreshAgentRequestId, answers: Record<string, string>): Promise<void> | void
  resolveApproval?(sessionId: string, requestId: FreshAgentRequestId, decision: Record<string, unknown>): Promise<void> | void
  getSnapshot?(thread: FreshAgentThreadLocator, revision?: number): Promise<unknown>
  getTurnPage?(thread: FreshAgentThreadLocator, query: Record<string, unknown>): Promise<unknown>
  getTurnBody?(thread: FreshAgentThreadLocator & { turnId: string }, revision: number): Promise<unknown>
  shutdown?(): Promise<void> | void
}

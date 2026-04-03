import type { SdkSessionState } from '../sdk-bridge-types.js'
import type { ChatMessage } from '../session-history-loader.js'
import { createRestoreLedgerManager, type RestoreResolution } from './ledger.js'

export type AgentHistorySource = {
  resolve: (queryId: string) => Promise<RestoreResolution>
  teardownLiveSession: (sessionId: string, options: { recoverable: boolean }) => void
}

export type AgentHistorySourceDeps = {
  loadSessionHistory: (sessionId: string) => Promise<ChatMessage[] | null>
  getLiveSessionBySdkSessionId: (sdkSessionId: string) => SdkSessionState | undefined
  getLiveSessionByCliSessionId: (timelineSessionId: string) => SdkSessionState | undefined
}

export function createAgentHistorySource(deps: AgentHistorySourceDeps): AgentHistorySource {
  return createRestoreLedgerManager(deps)
}

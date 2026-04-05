import type { SdkSessionState } from '../sdk-bridge-types.js'
import type { ChatMessage } from '../session-history-loader.js'
import { createRestoreLedgerManager, type RestoreResolution } from './ledger.js'

export type AgentHistoryResolveOptions = {
  liveSessionOverride?: SdkSessionState
}

export type AgentHistorySource = {
  resolve: (queryId: string, options?: AgentHistoryResolveOptions) => Promise<RestoreResolution>
  teardownLiveSession: (sessionId: string, options: { recoverable: boolean }) => void
  syncLiveSession?: (liveSession: SdkSessionState) => Promise<void>
}

export type AgentHistorySourceDeps = {
  loadSessionHistory: (sessionId: string) => Promise<ChatMessage[] | null>
  getLiveSessionBySdkSessionId: (sdkSessionId: string) => SdkSessionState | undefined
  getLiveSessionByCliSessionId: (timelineSessionId: string) => SdkSessionState | undefined
  logDivergence?: (details: { queryId: string; reason: string; liveSessionId?: string; timelineSessionId?: string }) => void
}

export function createAgentHistorySource(deps: AgentHistorySourceDeps): AgentHistorySource {
  return createRestoreLedgerManager(deps)
}

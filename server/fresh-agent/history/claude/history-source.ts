import type { SdkSessionState } from '../../../sdk-bridge-types.js'
import type { ChatMessage } from '../../../session-history-loader.js'
import { createRestoreLedgerManager, type RestoreResolution } from './history-ledger.js'

export type ClaudeFreshAgentHistoryResolveOptions = {
  liveSessionOverride?: SdkSessionState
}

export type ClaudeFreshAgentHistorySource = {
  resolve: (queryId: string, options?: ClaudeFreshAgentHistoryResolveOptions) => Promise<RestoreResolution>
  teardownLiveSession: (sessionId: string, options: { recoverable: boolean }) => void
  syncLiveSession?: (liveSession: SdkSessionState) => Promise<void>
}

export type ClaudeFreshAgentHistorySourceDeps = {
  loadSessionHistory: (sessionId: string) => Promise<ChatMessage[] | null>
  getLiveSessionBySdkSessionId: (sdkSessionId: string) => SdkSessionState | undefined
  getLiveSessionByCliSessionId: (timelineSessionId: string) => SdkSessionState | undefined
  logDivergence?: (details: { queryId: string; reason: string; liveSessionId?: string; timelineSessionId?: string }) => void
}

export function createClaudeFreshAgentHistorySource(
  deps: ClaudeFreshAgentHistorySourceDeps,
): ClaudeFreshAgentHistorySource {
  return createRestoreLedgerManager(deps)
}

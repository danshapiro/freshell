import { wireOpencodeActivityTracker } from './opencode-activity-wiring.js'
import type { OpencodeRootResolution } from './providers/opencode.js'

type WireOpencodeActivityInput = Parameters<typeof wireOpencodeActivityTracker>[0]

export type OpencodeRootResolverProvider = {
  resolveOpencodeSessionRoots: (sessionIds: readonly string[]) => Promise<OpencodeRootResolution>
}

export type OpencodeActivityIntegrationInput =
  & Omit<WireOpencodeActivityInput, 'resolveOpencodeSessionRoots'>
  & {
    opencodeProvider: OpencodeRootResolverProvider
  }

export function createOpencodeActivityIntegration(input: OpencodeActivityIntegrationInput) {
  const { opencodeProvider, ...wireInput } = input
  return wireOpencodeActivityTracker({
    ...wireInput,
    resolveOpencodeSessionRoots: (sessionIds) => opencodeProvider.resolveOpencodeSessionRoots(sessionIds),
  })
}

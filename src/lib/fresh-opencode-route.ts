import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { FreshAgentSessionState } from '@/store/freshAgentTypes'
import type { FreshAgentPaneContent, PaneContent } from '@/store/paneTypes'

export function getFreshOpenCodeRouteCwd(
  content: PaneContent | FreshAgentPaneContent,
  options: {
    sessionCwd?: string
    freshAgentSessions?: Record<string, FreshAgentSessionState>
    sessionId?: string
    fallbackCwd?: string
  } = {},
): string | undefined {
  if (
    content.kind !== 'fresh-agent'
    || content.provider !== 'opencode'
    || content.sessionType !== 'freshopencode'
  ) {
    return undefined
  }

  const paneCwd = content.initialCwd?.trim()
  if (paneCwd) return paneCwd

  const directSessionCwd = options.sessionCwd?.trim()
  if (directSessionCwd) return directSessionCwd

  const freshAgentSessions = options.freshAgentSessions
  if (freshAgentSessions) {
    const candidateSessionIds = [
      options.sessionId,
      content.sessionId,
      content.sessionRef?.provider === content.provider ? content.sessionRef.sessionId : undefined,
      content.resumeSessionId,
    ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
    for (const candidateSessionId of candidateSessionIds) {
      const session = freshAgentSessions[makeFreshAgentSessionKey({
        sessionType: content.sessionType,
        provider: content.provider,
        sessionId: candidateSessionId,
      })]
      const sessionCwd = session?.cwd?.trim()
      if (sessionCwd) return sessionCwd
    }
  }

  const fallbackCwd = options.fallbackCwd?.trim()
  return fallbackCwd || undefined
}

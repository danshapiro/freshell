import type { CodingCliProviderName } from '@/lib/coding-cli-types'
import type { FreshAgentPaneContent, PaneContent } from '@/store/paneTypes'
import type { FreshAgentSessionState } from '@/store/freshAgentTypes'
import { getPreferredResumeSessionId } from '@/store/persistControl'
import type { CodingCliSession, ProjectGroup } from '@/store/types'
import type { TokenSummary } from '@shared/ws-protocol'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import { collectPaneEntries } from '@/lib/pane-utils'
import type { PaneNode } from '@/store/paneTypes'

export type FreshAgentContextUsage = {
  percent: number
  contextTokens: number
  thresholdTokens: number
}

export type CodexLatestUsage = { observed: boolean; latestTokens?: number; totalTokens?: number; modelContextWindow?: number }

/** Native last is a measured sample, not demonstrated current context occupancy. */
export function latestCodexUsage(raw: unknown): CodexLatestUsage {
  if (!raw || typeof raw !== 'object') return { observed: false }
  const usage = raw as { last?: { totalTokens?: unknown }; total?: { totalTokens?: unknown }; modelContextWindow?: unknown }
  const latestTokens = usage.last?.totalTokens
  const totalTokens = usage.total?.totalTokens
  if (typeof latestTokens !== 'number' || !Number.isSafeInteger(latestTokens) || latestTokens < 0 || typeof totalTokens !== 'number' || !Number.isSafeInteger(totalTokens) || totalTokens < 0) return { observed: false }
  const window = usage.modelContextWindow
  return { observed: true, latestTokens, totalTokens,
    ...(typeof window === 'number' && Number.isSafeInteger(window) && window >= 0 ? { modelContextWindow: window } : {}),
  }
}

export function findIndexedSessionById(
  projects: ProjectGroup[],
  provider: CodingCliProviderName,
  sessionId: string,
): CodingCliSession | undefined {
  for (const project of projects) {
    const match = project.sessions.find((session) => (
      session.provider === provider && session.sessionId === sessionId
    ))
    if (match) return match
  }
  return undefined
}

/** Durable session id chain: preferred resume id → resumeSessionId → sessionRef
 * tail. sessionRef is the canonical durable identity — normalization flows can
 * strip resumeSessionId while retaining sessionRef, so a restored pane may
 * present sessionRef-only. The sessionRef tail only applies when its provider
 * matches the pane's provider. Exported for the view's last-known-usage cache
 * key so both read the exact same identity chain. */
export function freshAgentContextSessionId(
  content: FreshAgentPaneContent,
  session: FreshAgentSessionState | undefined,
): string | undefined {
  return getPreferredResumeSessionId(session)
    ?? content.resumeSessionId
    ?? (content.sessionRef?.provider === content.provider ? content.sessionRef.sessionId : undefined)
}

/**
 * Resolve the live context-window usage for a fresh-agent pane from the
 * session indexer. Returns null (unknown) unless compactPercent AND
 * contextTokens AND compactThresholdTokens are all finite numbers — a partial
 * record must never render a meter with a token-less tooltip.
 */
export function resolveFreshAgentContextUsage(
  content: FreshAgentPaneContent,
  session: FreshAgentSessionState | undefined,
  projects: ProjectGroup[],
): FreshAgentContextUsage | null {
  const sessionId = freshAgentContextSessionId(content, session)
  if (!sessionId) return null
  const indexed = findIndexedSessionById(projects, content.provider, sessionId)
  return guardContextUsageTokenSummary(indexed?.tokenUsage)
}

/**
 * Same finite-number guard as resolveFreshAgentContextUsage, applied directly
 * to a TokenSummary from any source (window row or out-of-band extras).
 */
export function guardContextUsageTokenSummary(usage: TokenSummary | undefined): FreshAgentContextUsage | null {
  if (!usage) return null
  const raw = usage.compactPercent
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const contextTokens = usage.contextTokens
  if (typeof contextTokens !== 'number' || !Number.isFinite(contextTokens)) return null
  const thresholdTokens = usage.compactThresholdTokens
  if (typeof thresholdTokens !== 'number' || !Number.isFinite(thresholdTokens)) return null
  return {
    percent: Math.max(0, Math.min(100, Math.round(raw))),
    contextTokens: Math.round(contextTokens),
    thresholdTokens: Math.round(thresholdTokens),
  }
}

/**
 * STATUS-STRIP: the composite `provider:sessionId` keys of every fresh-agent
 * pane's durable context session. Passed as `includeKeys` on sidebar window /
 * search fetches so the server returns their usage out-of-band
 * (`contextUsageExtras`) even when the active search or pagination window
 * excludes the row — the meter must stay live regardless of the sidebar.
 */
export function collectFreshAgentContextUsageKeys(args: {
  layouts: Record<string, PaneNode | null> | undefined
  freshAgentSessions: Record<string, FreshAgentSessionState> | undefined
}): string[] {
  const keys = new Set<string>()
  for (const layout of Object.values(args.layouts ?? {})) {
    if (!layout) continue
    for (const { content } of collectPaneEntries(layout)) {
      if ((content as PaneContent).kind !== 'fresh-agent') continue
      const fresh = content as FreshAgentPaneContent
      const session = fresh.sessionId
        ? args.freshAgentSessions?.[makeFreshAgentSessionKey({
            sessionId: fresh.sessionId,
            sessionType: fresh.sessionType,
            provider: fresh.provider,
          })]
        : undefined
      const sessionId = freshAgentContextSessionId(fresh, session)
      if (!sessionId) continue
      keys.add(`${fresh.provider}:${sessionId}`)
    }
  }
  // Client-side cap mirrors the wire schema (SessionDirectoryQuerySchema
  // includeKeys max 200): never let a large workspace make its own
  // sidebar/search fetches unparseable.
  return [...keys].slice(0, 200)
}

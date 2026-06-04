// Reverse lookup: map a turn-completion sessionKey (`provider:sessionId`) to the
// tab/pane that owns the SDK session (fresh-agent or legacy agent-chat).
//
// This is the SDK-pane analogue of selectTabPaneByTerminalId (which only matches
// terminal-kind panes). The sessionKey here is the `provider:sessionId` form
// produced by resolveFreshAgentSessionKey/resolveAgentChatSessionKey — NOT the
// fresh-agent slice-lookup key (makeFreshAgentSessionKey). See the plan's
// "TWO KEY NAMESPACES" note.

import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import { collectPaneEntries } from '@/lib/pane-utils'
import { resolveAgentChatSessionKey, resolveFreshAgentSessionKey } from '@/lib/pane-activity'
import type { RootState } from './store'

export function selectPaneBySessionKey(
  state: RootState,
  sessionKey: string,
): { tabId: string; paneId: string } | null {
  const layouts = state.panes?.layouts
  if (!layouts) return null

  for (const [tabId, layout] of Object.entries(layouts)) {
    if (!layout) continue
    for (const entry of collectPaneEntries(layout)) {
      const content = entry.content
      if (content.kind === 'fresh-agent') {
        const session = content.sessionId
          ? state.freshAgent?.sessions?.[makeFreshAgentSessionKey({
            sessionType: content.sessionType,
            provider: content.provider,
            sessionId: content.sessionId,
          })]
          : undefined
        if (resolveFreshAgentSessionKey(content, session) === sessionKey) {
          return { tabId, paneId: entry.paneId }
        }
      } else if (content.kind === 'agent-chat') {
        const session = content.sessionId
          ? state.agentChat?.sessions?.[content.sessionId]
          : undefined
        if (resolveAgentChatSessionKey(content, session) === sessionKey) {
          return { tabId, paneId: entry.paneId }
        }
      }
    }
  }

  return null
}

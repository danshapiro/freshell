import type { Middleware } from '@reduxjs/toolkit'
import { getWsClient } from '@/lib/ws-client'
import { isValidClaudeSessionId } from '@/lib/claude-session-id'

const INITIAL_LAYOUT_SYNC_DEBOUNCE_MS = 1000
const LAYOUT_SYNC_DEBOUNCE_MS = 200

function buildTabFallbackSessionRef(tab: {
  mode?: string
  codingCliProvider?: string
  resumeSessionId?: string
}): { provider: string; sessionId: string } | undefined {
  const provider = tab.codingCliProvider || (tab.mode !== 'shell' ? tab.mode : undefined)
  const sessionId = tab.resumeSessionId
  if (!provider || !sessionId) return undefined
  if (provider === 'claude' && !isValidClaudeSessionId(sessionId)) return undefined
  return { provider, sessionId }
}

export const layoutMirrorMiddleware: Middleware = (store) => {
  let lastPayload = ''
  let timer: number | undefined
  let hasSentInitialPayload = false

  return (next) => (action) => {
    const result = next(action)
    const state = store.getState() as any
    const payload = {
      type: 'ui.layout.sync',
      tabs: state.tabs.tabs.map((t: any) => {
        const fallbackSessionRef = buildTabFallbackSessionRef(t)
        return {
          id: t.id,
          title: t.title,
          ...(fallbackSessionRef ? { fallbackSessionRef } : {}),
        }
      }),
      activeTabId: state.tabs.activeTabId,
      layouts: state.panes.layouts,
      activePane: state.panes.activePane,
      paneTitles: state.panes.paneTitles || {},
      paneTitleSetByUser: state.panes.paneTitleSetByUser || {},
    }
    const serialized = JSON.stringify(payload)
    if (serialized === lastPayload) return result
    lastPayload = serialized

    if (timer) window.clearTimeout(timer)
    const debounceMs = hasSentInitialPayload
      ? LAYOUT_SYNC_DEBOUNCE_MS
      : INITIAL_LAYOUT_SYNC_DEBOUNCE_MS
    timer = window.setTimeout(() => {
      hasSentInitialPayload = true
      getWsClient().send({ ...payload, timestamp: Date.now() })
    }, debounceMs)

    return result
  }
}

import { api } from '@/lib/api'
import { extractTitleFromMessage } from '@shared/title-utils'
import { updatePaneTitle } from './panesSlice'
import { updateTab } from './tabsSlice'
import type { AppDispatch, RootState } from './store'

/**
 * Finalize the name of a coding-agent SDK session (fresh-agent / agent-chat)
 * from its first user message.
 *
 * The server is the single writer of the session title override (which drives
 * the sidebar). On the first message we:
 *
 *  1. If no Gemini key is configured, apply the first-message name immediately
 *     so there is no round-trip latency (matches decision: dir -> first-message).
 *  2. Always POST generate-title so the server persists the canonical override
 *     and, when a Gemini key IS configured, returns the AI name which replaces
 *     the working-directory placeholder once ready (decision: dir -> Gemini).
 *
 * The resolved title is mirrored into the pane (and the tab, for single-pane
 * tabs) as an automatic (non-user) title so tab, pane and sidebar align. SDK
 * panes are not PTY terminals, so the server's terminal title promotion does
 * not reach them — this mirror is how they pick up the canonical name. The
 * local first-message title uses the same default length as the server's
 * first-message override so the two never disagree.
 */
export function finalizeCodingAgentSessionName(input: {
  tabId: string
  paneId: string
  provider: string
  sessionId: string
  firstMessage: string
}) {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const { tabId, paneId, provider, sessionId, firstMessage } = input
    if (!firstMessage.trim()) return

    const applyTitle = (title: string) => {
      dispatch(updatePaneTitle({ tabId, paneId, title, setByUser: false }))
      const state = getState()
      // Mirror to the tab unless this is a genuine multi-pane (split) tab,
      // whose name should not follow a single pane.
      if (state.panes.layouts[tabId]?.type === 'split') return
      const tab = state.tabs.tabs.find((t) => t.id === tabId)
      if (tab && !tab.titleSetByUser) {
        dispatch(updateTab({ id: tabId, updates: { title } }))
      }
    }

    const aiEnabled = getState().connection?.featureFlags?.aiEnabled === true

    // No Gemini key: show the first-message name immediately (no latency).
    if (!aiEnabled) {
      const local = extractTitleFromMessage(firstMessage)
      if (local) applyTitle(local)
    }

    // Persist via the server (single writer of the override). With a Gemini key
    // this returns the AI name and replaces the working-directory placeholder.
    const compositeKey = `${provider}:${sessionId}`
    try {
      const resp = (await api.post(
        `/api/sessions/${encodeURIComponent(compositeKey)}/generate-title`,
        { firstMessage },
      )) as { title?: string | null } | undefined
      if (resp?.title) applyTitle(resp.title)
    } catch {
      // Server unavailable — any local first-message title is already applied.
    }
  }
}

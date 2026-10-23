import { api } from '@/lib/api'
import { extractTitleFromMessage } from '@shared/title-utils'
import { isUnifiedAgentMode } from '@shared/session-names'
import { canWriteLegacyTabTitle } from '@/lib/tab-title-ownership'
import { updatePaneTitle } from './panesSlice'
import { updateTab } from './tabsSlice'
import type { AppDispatch, RootState } from './store'

/**
 * Finalize the name of a coding-agent SDK session (fresh-agent)
 * from its first user message.
 *
 * Unified agent names (Task 5): scoped fresh types (freshclaude, freshcodex,
 * freshopencode) no longer run ANY client-side generation — the server's
 * input-activity pipeline owns their fallback and AI naming, and the accepted
 * name arrives through the canonical `session.name.updated` push. This thunk
 * remains ONLY for the out-of-scope fresh types (kilroy), whose legacy
 * naming behavior is preserved unchanged.
 */
export function finalizeCodingAgentSessionName(input: {
  tabId: string
  paneId: string
  provider: string
  sessionType?: string
  sessionId: string
  firstMessage: string
}) {
  return async (dispatch: AppDispatch, getState: () => RootState) => {
    const { tabId, paneId, provider, sessionType, sessionId, firstMessage } = input
    if (!firstMessage.trim()) return
    // Scoped modes: the server's session-activity pipeline owns naming.
    if (isUnifiedAgentMode(provider, sessionType)) return

    const applyTitle = (title: string) => {
      dispatch(updatePaneTitle({ tabId, paneId, title, setByUser: false }))
      const state = getState()
      // Mirror to the tab unless this is a genuine multi-pane (split) tab,
      // whose name should not follow a single pane, or a session-owned tab,
      // whose title mirrors its saved name (name reliability, Task 7).
      if (state.panes.layouts[tabId]?.type === 'split') return
      const tab = state.tabs.tabs.find((t) => t.id === tabId)
      if (tab && !tab.titleSetByUser && canWriteLegacyTabTitle(state, tabId)) {
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

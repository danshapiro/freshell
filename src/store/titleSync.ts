/**
 * Rename scope contract (docs/development/rename-scope-contract.md):
 * pane and tab renames are LOCAL organization. They never write terminal or
 * session overrides — the only durable session rename flows through an
 * explicit session-scope action (`PATCH /api/sessions/:key` via the sidebar /
 * history rename, or Task 7's reset). `applySessionRenameCascade` is the one
 * sanctioned cross-scope mirror: session -> open panes.
 */
import type { AppDispatch, RootState } from './store'
import { updatePaneTitle, updatePaneTitleByTerminalId, updatePaneTitleBySessionRef } from './panesSlice'
import { updateTab } from './tabsSlice'
import { api } from '@/lib/api'

type TitleSyncThunk = (dispatch: AppDispatch, getState: () => RootState) => void

function getSinglePaneId(state: RootState, tabId: string): string | null {
  const layout = state.panes.layouts[tabId]
  if (!layout || layout.type !== 'leaf') return null
  return layout.id
}

/**
 * Mirror a server-side session rename into any open pane bound to that
 * session. The terminal cascade (cascadedTerminalId, returned by the sessions
 * PATCH) covers live coding-CLI terminal panes; the sessionRef pass covers
 * SDK/fresh-agent panes that can never cascade server-side (D4) plus terminal
 * panes matched by sessionRef (D3). These are user renames, so
 * setByUser: true — they land even on previously user-renamed panes and stay
 * sticky (Scope Decision 3).
 */
export function applySessionRenameCascade(input: {
  dispatch: AppDispatch
  provider: string
  sessionId: string
  title: string
  cascadedTerminalId?: string | null
}): void {
  const { dispatch, provider, sessionId, title, cascadedTerminalId } = input
  if (cascadedTerminalId) {
    dispatch(updatePaneTitleByTerminalId({ terminalId: cascadedTerminalId, title, setByUser: true }))
  }
  dispatch(updatePaneTitleBySessionRef({ provider, sessionId, title, setByUser: true }))
}

export function applyPaneRename(input: {
  tabId: string
  paneId: string
  title: string
}): TitleSyncThunk {
  return (dispatch, getState) => {
    dispatch(updatePaneTitle(input))

    const singlePaneId = getSinglePaneId(getState(), input.tabId)
    if (singlePaneId !== input.paneId) return

    dispatch(updateTab({
      id: input.tabId,
      updates: {
        title: input.title,
        titleSetByUser: true,
      },
    }))
  }
}

export function applyTabRename(input: {
  tabId: string
  title: string
}): TitleSyncThunk {
  return (dispatch, getState) => {
    dispatch(updateTab({
      id: input.tabId,
      updates: {
        title: input.title,
        titleSetByUser: true,
      },
    }))

    const singlePaneId = getSinglePaneId(getState(), input.tabId)
    if (!singlePaneId) return

    dispatch(updatePaneTitle({
      tabId: input.tabId,
      paneId: singlePaneId,
      title: input.title,
    }))
  }
}

/**
 * Reviewed reset: clear the durable session title override AND its source so
 * the provider-native title is revealed and the title-source ladder unblocks.
 * Session-scoped by definition — called only from an explicit per-session
 * "Reset to provider title" action. (`PATCH /api/sessions/:key` with
 * `{titleOverride: null}`; servers now clear titleSource too.)
 */
export async function clearSessionTitleOverride(provider: string, sessionId: string): Promise<void> {
  const compositeKey = `${provider}:${sessionId}`
  await api.patch(`/api/sessions/${encodeURIComponent(compositeKey)}`, { titleOverride: null })
}

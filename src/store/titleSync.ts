import type { AppDispatch, RootState } from './store'
import { updatePaneTitle, updatePaneTitleByTerminalId, updatePaneTitleBySessionRef } from './panesSlice'
import { updateTab } from './tabsSlice'
import { api } from '@/lib/api'
import { isCodingAgentContent } from '@/lib/coding-agent-detection'
import type { PaneContent, PaneNode } from './paneTypes'

type TitleSyncThunk = (dispatch: AppDispatch, getState: () => RootState) => void

function getSinglePaneId(state: RootState, tabId: string): string | null {
  const layout = state.panes.layouts[tabId]
  if (!layout || layout.type !== 'leaf') return null
  return layout.id
}

function findPaneContent(node: PaneNode | undefined, paneId: string): PaneContent | null {
  if (!node) return null
  if (node.type === 'leaf') return node.id === paneId ? node.content : null
  return findPaneContent(node.children[0], paneId) || findPaneContent(node.children[1], paneId)
}

/**
 * A user rename must reach the server-authoritative session override so the
 * left sidebar (which renders the server session title) stays aligned with the
 * tab/pane. Coding-CLI terminal panes cascade via the terminals API; SDK panes
 * (fresh-agent) write the session override directly. Shell panes
 * and browser panes stay Redux-only. Fire-and-forget: the Redux rename already
 * applied, so server failures must not block the UI.
 */
function syncRenameToServer(content: PaneContent | null, title: string): void {
  if (!content || !isCodingAgentContent(content)) return
  if (content.kind === 'terminal') {
    // Any non-shell (coding-agent) terminal, including user-installed extension
    // CLIs, cascades via the terminals API to its session override.
    if (content.terminalId) {
      void api.patch(`/api/terminals/${encodeURIComponent(content.terminalId)}`, { titleOverride: title }).catch(() => {})
      return
    }
    // Exited coding-CLI terminals have no live terminalId (TerminalView clears
    // it on exit), so the terminals-API cascade is unavailable and the server
    // sweep only sees live terminals. Fall back to the pane's durable
    // sessionRef so the user's rename intent still persists on the session
    // override (D8).
    const ref = content.sessionRef
    if (ref?.provider && ref.sessionId) {
      const compositeKey = `${ref.provider}:${ref.sessionId}`
      void api.patch(`/api/sessions/${encodeURIComponent(compositeKey)}`, { titleOverride: title }).catch(() => {})
    }
    return
  }
  if (content.kind === 'fresh-agent') {
    if (content.sessionId) {
      const compositeKey = `${content.provider}:${content.sessionId}`
      void api.patch(`/api/sessions/${encodeURIComponent(compositeKey)}`, { titleOverride: title }).catch(() => {})
    }
  }
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

    const state = getState()
    syncRenameToServer(findPaneContent(state.panes.layouts[input.tabId], input.paneId), input.title)

    const singlePaneId = getSinglePaneId(state, input.tabId)
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

    const state = getState()
    const singlePaneId = getSinglePaneId(state, input.tabId)
    if (!singlePaneId) return

    dispatch(updatePaneTitle({
      tabId: input.tabId,
      paneId: singlePaneId,
      title: input.title,
    }))
    syncRenameToServer(findPaneContent(state.panes.layouts[input.tabId], singlePaneId), input.title)
  }
}

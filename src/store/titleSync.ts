import type { AppDispatch, RootState } from './store'
import { updatePaneTitle } from './panesSlice'
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
 * (fresh-agent / agent-chat) write the session override directly. Shell panes
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
    }
    return
  }
  if (content.kind === 'fresh-agent' || content.kind === 'agent-chat') {
    if (content.sessionId) {
      const compositeKey = `${content.provider}:${content.sessionId}`
      void api.patch(`/api/sessions/${encodeURIComponent(compositeKey)}`, { titleOverride: title }).catch(() => {})
    }
  }
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

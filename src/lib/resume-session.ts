import { findPaneForSession } from '@/lib/session-utils'
import { findPaneContent } from '@/lib/pane-utils'
import { openSessionTab, setActiveTab } from '@/store/tabsSlice'
import { setActivePane } from '@/store/panesSlice'
import type { FreshAgentCheckpointWorkspace } from '@/store/types'
import type { AppDispatch, RootState } from '@/store/store'
import type { CodingCliProviderName } from '@/store/types'

export interface ResumeTarget {
  provider: string
  sessionId: string
  cwd?: string
  sessionType?: string
  title?: string
  firstUserMessage?: string
  checkpointWorkspace?: FreshAgentCheckpointWorkspace
}

/** Preserve a session's rewind scope when a resume flow must rebuild its pane. */
export function findCheckpointWorkspaceForSession(
  state: RootState,
  target: Pick<ResumeTarget, 'provider' | 'sessionId'>,
): FreshAgentCheckpointWorkspace | undefined {
  const existing = findPaneForSession(
    state,
    { provider: target.provider as CodingCliProviderName, sessionId: target.sessionId },
    state.connection?.serverInstanceId,
  )
  if (!existing) return undefined
  const tab = state.tabs?.tabs?.find((candidate) => candidate.id === existing.tabId)
  const layout = state.panes?.layouts?.[existing.tabId]
  const content = existing.paneId && layout ? findPaneContent(layout, existing.paneId) : null
  if (content?.kind === 'fresh-agent' && content.checkpointWorkspace) {
    return content.checkpointWorkspace
  }
  // A tab can contain several sessions after splitting, so its single
  // workspace is a safe fallback only while the matching tab has no layout
  // and is waiting for TabContent hydration. A terminal pane in a split tab
  // must never inherit another pane's checkpoint scope.
  return existing.paneId ? undefined : tab?.checkpointWorkspace
}

/**
 * Resume a session in a tab following the sidebar's dedup convention:
 * if a pane already holds the session, focus it; otherwise open a new
 * focused tab running the correct agent with the FULL session id.
 */
export function resumeSessionInTab(
  state: RootState,
  dispatch: AppDispatch,
  target: ResumeTarget,
  onNavigate?: (view: 'terminal') => void,
): { deduped: boolean } {
  const existing = findPaneForSession(
    state,
    { provider: target.provider, sessionId: target.sessionId },
    state.connection.serverInstanceId,
  )
  if (existing) {
    dispatch(setActiveTab(existing.tabId))
    if (existing.paneId) {
      dispatch(setActivePane({ tabId: existing.tabId, paneId: existing.paneId }))
    }
    onNavigate?.('terminal')
    return { deduped: true }
  }
  const checkpointWorkspace = target.checkpointWorkspace
    ?? findCheckpointWorkspaceForSession(state, target)
  dispatch(
    openSessionTab({
      sessionId: target.sessionId,
      provider: target.provider,
      sessionType: target.sessionType ?? target.provider,
      cwd: target.cwd,
      title: target.title,
      firstUserMessage: target.firstUserMessage,
      ...(checkpointWorkspace ? { checkpointWorkspace } : {}),
    }),
  )
  onNavigate?.('terminal')
  return { deduped: false }
}

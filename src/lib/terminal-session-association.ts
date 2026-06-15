import { updateTab } from '@/store/tabsSlice'
import { reconcileTerminalSessionRefByTerminalId } from '@/store/panesSlice'
import {
  buildTerminalDurableSessionRefUpdate,
  flushPersistedLayoutNow,
} from '@/store/persistControl'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import type { RootState } from '@/store/store'
import type { CodingCliProviderName } from '@/store/types'
import { sanitizeSessionRef, type SessionRef } from '@shared/session-contract'

type Dispatch = (action: any) => unknown
type SessionAssociationState = Pick<RootState, 'panes' | 'tabs'>

function collectMatchingTerminalPanes(
  node: PaneNode | undefined,
  terminalId: string,
  out: Array<{ paneId: string; content: TerminalPaneContent }>,
): void {
  if (!node) return
  if (node.type === 'leaf') {
    if (node.content.kind === 'terminal' && node.content.terminalId === terminalId) {
      out.push({ paneId: node.id, content: node.content })
    }
    return
  }
  collectMatchingTerminalPanes(node.children[0], terminalId, out)
  collectMatchingTerminalPanes(node.children[1], terminalId, out)
}

function isSinglePaneTerminalMatch(
  layout: PaneNode | undefined,
  terminalId: string,
): layout is Extract<PaneNode, { type: 'leaf' }> {
  return Boolean(
    layout
      && layout.type === 'leaf'
      && layout.content.kind === 'terminal'
      && layout.content.terminalId === terminalId,
  )
}

function sessionRefsEqual(left?: SessionRef, right?: SessionRef): boolean {
  return left?.provider === right?.provider && left?.sessionId === right?.sessionId
}

function terminalPaneNeedsDurableIdentityUpdate(content: TerminalPaneContent, sessionRef: SessionRef): boolean {
  if (!sessionRefsEqual(content.sessionRef, sessionRef)) return true
  if (typeof content.resumeSessionId === 'string') return true
  if (!(
    sessionRef.provider === 'codex'
    && content.codexDurability?.state === 'durable'
    && content.codexDurability.durableThreadId === sessionRef.sessionId
  )) {
    return content.codexDurability !== undefined
  }
  return false
}

export type TerminalSessionAssociationReconcileStatus = 'ignored' | 'reconciled' | 'conflict'

export function reconcileTerminalSessionAssociation({
  dispatch,
  getState,
  terminalId,
  sessionRef: rawSessionRef,
}: {
  dispatch: Dispatch
  getState: () => SessionAssociationState
  terminalId?: string
  sessionRef?: unknown
}): TerminalSessionAssociationReconcileStatus {
  if (!terminalId) return 'ignored'
  const sessionRef = sanitizeSessionRef(rawSessionRef)
  if (!sessionRef) return 'ignored'

  const state = getState()
  let matchedAnyPane = false
  let conflictingPane = false
  let shouldFlush = false
  const matchedSinglePaneTabs: Array<{ tabId: string; content: TerminalPaneContent }> = []
  for (const [tabId, layout] of Object.entries(state.panes.layouts)) {
    const matches: Array<{ paneId: string; content: TerminalPaneContent }> = []
    collectMatchingTerminalPanes(layout, terminalId, matches)
    if (matches.length === 0) continue

    matchedAnyPane = true
    if (matches.some(({ content }) => content.sessionRef && !sessionRefsEqual(content.sessionRef, sessionRef))) {
      conflictingPane = true
      continue
    }
    if (matches.some(({ content }) => terminalPaneNeedsDurableIdentityUpdate(content, sessionRef))) {
      shouldFlush = true
    }
    if (isSinglePaneTerminalMatch(layout, terminalId)) {
      matchedSinglePaneTabs.push({ tabId, content: matches[0].content })
    }
  }

  if (conflictingPane) return 'conflict'
  if (!matchedAnyPane) return 'ignored'

  dispatch(reconcileTerminalSessionRefByTerminalId({ terminalId, sessionRef }))

  for (const { tabId, content } of matchedSinglePaneTabs) {
    const tab = state.tabs.tabs.find((candidate) => candidate.id === tabId)
    if (!tab) continue

    const durableIdentityUpdate = buildTerminalDurableSessionRefUpdate({
      provider: sessionRef.provider as CodingCliProviderName,
      sessionId: sessionRef.sessionId,
      paneSessionRef: content.sessionRef,
      tabSessionRef: tab.sessionRef,
      paneResumeSessionId: content.resumeSessionId,
      tabResumeSessionId: tab.resumeSessionId,
    })
    const nextTabCodexDurability = sessionRef.provider === 'codex'
      && tab.codexDurability?.state === 'durable'
      && tab.codexDurability.durableThreadId === sessionRef.sessionId
      ? tab.codexDurability
      : undefined
    const tabUpdates = {
      ...(durableIdentityUpdate?.tabUpdates ?? {}),
      ...(tab.codexDurability !== nextTabCodexDurability
        ? { codexDurability: nextTabCodexDurability }
        : {}),
    }
    if (Object.keys(tabUpdates).length > 0) {
      shouldFlush = true
      dispatch(updateTab({
        id: tab.id,
        updates: tabUpdates,
      }))
    }
  }

  if (shouldFlush) {
    dispatch(flushPersistedLayoutNow())
  }
  return 'reconciled'
}

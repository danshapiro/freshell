import { updateTab } from '@/store/tabsSlice'
import { reconcileTerminalSessionRefByTerminalId } from '@/store/panesSlice'
import { updateSessionActivity } from '@/store/sessionActivitySlice'
import {
  buildTerminalDurableSessionRefUpdate,
  flushPersistedLayoutNow,
} from '@/store/persistControl'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import type { RootState } from '@/store/store'
import type { CodingCliProviderName } from '@/store/types'
import { sanitizeSessionRef, type SessionRef } from '@shared/session-contract'

type Dispatch = (action: any) => unknown
type SessionAssociationState = Pick<RootState, 'panes' | 'tabs' | 'sessionActivity'>

/**
 * Shared ratchet-only migration core: copy the activity stored under one
 * sidebar row key onto a canonical session key. updateSessionActivity is
 * ratchet-only (max wins), so folding is safe even when the canonical key
 * already holds a newer value. The source entry may remain stored — old keys
 * are pruned by the slice's existing retention.
 */
function foldSessionActivityFromKey({
  dispatch,
  state,
  fromKey,
  provider,
  sessionId,
}: {
  dispatch: Dispatch
  state: Pick<RootState, 'sessionActivity'>
  fromKey: string
  provider: string
  sessionId: string
}): void {
  const fromAt = state.sessionActivity?.sessions?.[fromKey]
  if (typeof fromAt !== 'number') return
  dispatch(updateSessionActivity({ sessionId, provider, lastInputAt: fromAt }))
}

/**
 * Migration fold for the close-tab ratchet alias: a terminal identity-less
 * at close time had its touch recorded under
 * `<provider>:terminal:<terminalId>` (liveTerminalRowIdentity in
 * lib/session-utils.ts — the sidebar's identity-less live-terminal row key).
 * When the terminal later acquires canonical identity, the sidebar rekeys
 * the row to `<provider>:<sessionId>` and reads activity only from there,
 * so the alias timestamp must be folded across at each binding point:
 * sessionRef association here, and every applied directory page in
 * fetchTerminalDirectoryWindow (store/terminalDirectoryThunks.ts) — the
 * store-level directory-apply choke point, reached by every
 * terminals.changed refresh whether or not any pane is mounted — folding
 * ANY provider's alias, not only codex durability (a binding whose
 * association frame passed before the ratchet wrote the alias has no
 * other fold opportunity).
 */
export function foldTerminalAliasActivity({
  dispatch,
  state,
  terminalId,
  provider,
  sessionId,
}: {
  dispatch: Dispatch
  state: Pick<RootState, 'sessionActivity'>
  terminalId: string
  provider: string
  sessionId: string
}): void {
  foldSessionActivityFromKey({
    dispatch,
    state,
    fromKey: `${provider}:terminal:${terminalId}`,
    provider,
    sessionId,
  })
}

/**
 * Migration fold for a canonical-to-canonical rebind (codex fork handoff):
 * a terminal closed while carrying the PARENT identity had its touch
 * recorded under `<provider>:<previousSessionId>` — liveTerminalRowIdentity
 * deliberately yields no terminal alias for identity-bearing content. When
 * the rebind is accepted and the sidebar rekeys the row to
 * `<provider>:<sessionId>`, the superseded key's timestamp must be folded
 * across the same way the terminal alias is, or the child row loses the
 * close-touch float. previousSessionId equal to sessionId folds nothing
 * (source and target would be the same key).
 */
export function foldCanonicalSessionActivity({
  dispatch,
  state,
  provider,
  previousSessionId,
  sessionId,
}: {
  dispatch: Dispatch
  state: Pick<RootState, 'sessionActivity'>
  provider: string
  previousSessionId: string
  sessionId: string
}): void {
  if (previousSessionId.length === 0 || previousSessionId === sessionId) return
  foldSessionActivityFromKey({
    dispatch,
    state,
    fromKey: `${provider}:${previousSessionId}`,
    provider,
    sessionId,
  })
}

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
  previousSessionId,
}: {
  dispatch: Dispatch
  getState: () => SessionAssociationState
  terminalId?: string
  sessionRef?: unknown
  previousSessionId?: string
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
    // A server-authoritative rebind (previousSessionId names the ref being
    // superseded) is NOT a conflict: the deterministic supersession handshake
    // -- accept only when the pane's current ref is exactly the superseded one.
    const isAuthorizedRebind = (content: TerminalPaneContent): boolean =>
      typeof previousSessionId === 'string'
      && previousSessionId.length > 0
      && content.sessionRef?.provider === sessionRef.provider
      && content.sessionRef?.sessionId === previousSessionId
    if (matches.some(({ content }) =>
      content.sessionRef
      && !sessionRefsEqual(content.sessionRef, sessionRef)
      && !isAuthorizedRebind(content),
    )) {
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

  // Close-tab activity migration runs only once the association is known NOT
  // to conflict: folding a rejected frame's alias onto the pane's canonical
  // session would stamp recent activity onto a session that never bound,
  // visibly misordering the sidebar. It must NOT depend on the pane-match
  // outcome — the orphan case is precisely a post-close association, where
  // the tab is gone and no pane is left to match.
  foldTerminalAliasActivity({
    dispatch,
    state,
    terminalId,
    provider: sessionRef.provider,
    sessionId: sessionRef.sessionId,
  })

  // Canonical-to-canonical migration on a server-authoritative rebind:
  // previousSessionId names the superseded session, whose stored activity
  // (e.g. the close-tab touch recorded under the parent key — identity-
  // bearing closes never write a terminal alias) folds onto the new key.
  // Same conflict-gate and pane-match independence rules as the alias fold.
  if (typeof previousSessionId === 'string') {
    foldCanonicalSessionActivity({
      dispatch,
      state,
      provider: sessionRef.provider,
      previousSessionId,
      sessionId: sessionRef.sessionId,
    })
  }

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
      tabSessionMetadataByKey: tab.sessionMetadataByKey,
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

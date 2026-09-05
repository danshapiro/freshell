import { createLogger } from '@/lib/client-logger'

const log = createLogger('terminal-interest')

/** Presentation-only interest for one WebSocket connection. No attach, detach,
 * resize, input or execution state is changed by this module. */
export type TerminalInterestSnapshot = {
  focusedTerminalId: string | null
  visibleTerminalIds: string[]
}
export type InterestPane = {
  type: string
  id: string
  content?: { kind: string; terminalId?: string }
  children?: readonly InterestPane[]
}
export type InterestState = {
  tabs: { activeTabId: string | null | undefined }
  panes: {
    layouts: Record<string, InterestPane | undefined>
    activePane: Record<string, string | null | undefined>
    zoomedPane?: Record<string, string | null | undefined>
  }
}
export const MAX_VISIBLE_TERMINALS = 1024

export function selectTerminalInterest(state: InterestState, hidden: boolean): TerminalInterestSnapshot | null {
  if (hidden || !state.tabs.activeTabId) return { focusedTerminalId: null, visibleTerminalIds: [] }
  const tab = state.tabs.activeTabId
  const root = state.panes.layouts[tab]
  if (!root) return { focusedTerminalId: null, visibleTerminalIds: [] }
  const leaves: InterestPane[] = []
  const stack = [root]
  const visited = new Set<InterestPane>()
  while (stack.length) {
    const node = stack.pop()!
    if (visited.has(node)) return null
    visited.add(node)
    if (visited.size > 8192) return null
    if (node.type === 'leaf') leaves.push(node)
    else if (node.children) stack.push(...node.children)
  }
  const zoom = state.panes.zoomedPane?.[tab]
  const zoomedLeaf = zoom ? leaves.find((leaf) => leaf.id === zoom) : undefined
  // Match PaneLayout: an invalid zoom identifier falls back to the full layout.
  const visibleLeaves = zoomedLeaf ? [zoomedLeaf] : leaves
  const ids = new Set<string>()
  let focusedTerminalId: string | null = null
  for (const leaf of visibleLeaves) {
    const content = leaf.content
    if (content?.kind !== 'terminal' || !content.terminalId) continue
    const terminalId = content.terminalId
    if (terminalId.length > 512) return null
    ids.add(terminalId)
    if (zoomedLeaf || leaf.id === state.panes.activePane[tab]) focusedTerminalId = terminalId
  }
  // Never silently truncate visible terminals and misclassify them as hidden.
  if (ids.size > MAX_VISIBLE_TERMINALS) return null
  return { focusedTerminalId, visibleTerminalIds: [...ids].sort() }
}

export type InterestPublisher = {
  schedule: () => void
  flushNow: (force?: boolean) => void
  invalidate: () => void
  dispose: () => void
}

/** Coalesce presentation churn to a task, not an animation frame. Reading at
 * flush time prevents stale layouts from being queued across rapid tab changes.
 * The sender must refuse to buffer while disconnected or not negotiated.
 * Revisions belong to the WsClient, so remounting this publisher cannot rewind
 * the revision counter on a surviving connection. */
export function createInterestPublisher(options: {
  read: () => TerminalInterestSnapshot | null
  send: (snapshot: TerminalInterestSnapshot) => boolean
  scheduleTask: (task: () => void) => (() => void)
}): InterestPublisher {
  let lastKey: string | null = null
  let cancel: (() => void) | null = null
  let disposed = false
  const flushNow = (force = false) => {
    cancel?.(); cancel = null
    if (disposed) return
    const snapshot = options.read()
    // A refused read (selector cardinality/cycle guards) must not move the
    // server off the last accepted snapshot — but it must also not be
    // silent: that state is a client-side classification problem.
    if (snapshot === null) {
      if (lastKey !== null) log.debug('selector refused snapshot; keeping last accepted state')
      return
    }
    const key = JSON.stringify(snapshot)
    if (!force && key === lastKey) return
    if (options.send(snapshot)) lastKey = key
  }
  return {
    schedule() {
      if (disposed || cancel) return
      cancel = options.scheduleTask(() => { cancel = null; flushNow() })
    },
    flushNow,
    invalidate() { lastKey = null; cancel?.(); cancel = null },
    dispose() { disposed = true; cancel?.(); cancel = null },
  }
}

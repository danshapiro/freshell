import type { PaneNode, PaneContent, TerminalPaneContent, SessionPaneContent } from '@/store/paneTypes'
import type { TerminalStatus } from '@/store/types'

export type PaneLeaf = Extract<PaneNode, { type: 'leaf' }>

/**
 * Get the cwd of the first terminal in the pane tree (depth-first traversal).
 * Returns null if no terminal with a known cwd is found.
 */
export function getFirstTerminalCwd(
  node: PaneNode,
  cwdMap: Record<string, string>
): string | null {
  if (node.type === 'leaf') {
    if (node.content.kind === 'terminal' && node.content.terminalId) {
      return cwdMap[node.content.terminalId] || null
    }
    return null
  }

  // Split node - check children depth-first
  const leftResult = getFirstTerminalCwd(node.children[0], cwdMap)
  if (leftResult) return leftResult

  return getFirstTerminalCwd(node.children[1], cwdMap)
}

export function collectTerminalIds(node: PaneNode): string[] {
  if (node.type === 'leaf') {
    if (node.content.kind === 'terminal' && node.content.terminalId) {
      return [node.content.terminalId]
    }
    return []
  }

  return [
    ...collectTerminalIds(node.children[0]),
    ...collectTerminalIds(node.children[1]),
  ]
}

export function collectPaneIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.id]
  return [
    ...collectPaneIds(node.children[0]),
    ...collectPaneIds(node.children[1]),
  ]
}

export function collectTerminalPanes(node: PaneNode): Array<{ paneId: string; content: TerminalPaneContent }> {
  if (node.type === 'leaf') {
    if (node.content.kind === 'terminal') {
      return [{ paneId: node.id, content: node.content }]
    }
    return []
  }
  return [
    ...collectTerminalPanes(node.children[0]),
    ...collectTerminalPanes(node.children[1]),
  ]
}

export function collectSessionPanes(node: PaneNode): Array<{ paneId: string; content: SessionPaneContent }> {
  if (node.type === 'leaf') {
    if (node.content.kind === 'session') {
      return [{ paneId: node.id, content: node.content }]
    }
    return []
  }
  return [
    ...collectSessionPanes(node.children[0]),
    ...collectSessionPanes(node.children[1]),
  ]
}

export function findPaneByTerminalId(
  layouts: Record<string, PaneNode>,
  terminalId: string
): { tabId: string; paneId: string } | null {
  for (const [tabId, layout] of Object.entries(layouts)) {
    const terminals = collectTerminalPanes(layout)
    for (const terminal of terminals) {
      if (terminal.content.terminalId === terminalId) {
        return { tabId, paneId: terminal.paneId }
      }
    }
  }
  return null
}

export function findPaneBySessionId(
  layouts: Record<string, PaneNode>,
  sessionId: string
): { tabId: string; paneId: string } | null {
  for (const [tabId, layout] of Object.entries(layouts)) {
    const sessions = collectSessionPanes(layout)
    for (const session of sessions) {
      if (session.content.sessionId === sessionId) {
        return { tabId, paneId: session.paneId }
      }
    }
  }
  return null
}

export function findPaneContent(node: PaneNode, paneId: string): PaneContent | null {
  if (node.type === 'leaf') {
    return node.id === paneId ? node.content : null
  }
  return findPaneContent(node.children[0], paneId) || findPaneContent(node.children[1], paneId)
}

export function findPaneIdByContent(
  node: PaneNode,
  predicate: (content: PaneContent) => boolean
): string | null {
  if (node.type === 'leaf') {
    return predicate(node.content) ? node.id : null
  }
  return findPaneIdByContent(node.children[0], predicate) || findPaneIdByContent(node.children[1], predicate)
}

export function deriveTabStatus(layout?: PaneNode): TerminalStatus {
  if (!layout) return 'creating'

  const terminals = collectTerminalPanes(layout)
  if (terminals.length === 0) return 'running'

  let hasRunning = false
  let hasCreating = false
  let hasError = false
  let hasExited = false

  for (const terminal of terminals) {
    const status = terminal.content.status
    if (status === 'running') hasRunning = true
    else if (status === 'creating') hasCreating = true
    else if (status === 'error') hasError = true
    else if (status === 'exited') hasExited = true
  }

  if (hasRunning) return 'running'
  if (hasCreating) return 'creating'
  if (hasError) return 'error'
  if (hasExited) return 'exited'
  return 'creating'
}

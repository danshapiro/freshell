import type { PaneContent, PaneNode } from '@/store/paneTypes'

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

export function findPaneContent(node: PaneNode, paneId: string): PaneContent | null {
  if (node.type === 'leaf') {
    return node.id === paneId ? node.content : null
  }
  return findPaneContent(node.children[0], paneId) || findPaneContent(node.children[1], paneId)
}
